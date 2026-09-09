// dsh.js — DeepSeek Harness Web API 客户端 (dsh web 已在运行)。
// 自 DSH 0.1.1-rc.2 起 /api/* 强制浏览器 Cookie 认证, 桥接改走 DSH 插件
// dsh-qq-bridge 提供的进程内适配层 /qqbapi/* (与 /api 同语义, 免认证):
//   一元调用:  POST {base}/qqbapi/rpc
//     body  { type:'client-request', rpcId:<uuid>, method, payload }
//     响应  { type:'server-response', rpcId, result:{ ok, value } | { ok:false, error } }
//   下行事件:  GET {base}/qqbapi/follow/stream  (SSE)
//     事件 session-event → { sessionId, frame }  frame 即 session/follow 流帧
//        ({type:'event', event:{type,data,...}} | {type:'snapshot', records:[...], cursor})
//     事件 question      → { clientId, eventId, agentId, request }  (DSH 提问)
//   会话订阅:  GET {base}/qqbapi/follow/add?sid=<sessionId>  (先订阅后 prompt)
//   回答问题:  POST {base}/qqbapi/answer, body { clientId, eventId, answers }
// 每个 QQ 聊天对象 (peer) 映射一个 DSH 会话, 映射持久化在 sessions.json。

import { EventEmitter } from "node:events";
import { fetchRetry, sleep, makeLogger, readJsonFile, writeJsonFile } from "./util.js";

export function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export class DSHClient extends EventEmitter {
  /**
   * @param {object} cfg - { baseUrl, workspaceCwd, sessionsFile }
   * @param {object} log
   */
  constructor(cfg, log) {
    super();
    this.cfg = cfg;
    this.log = log ?? makeLogger();
    this.base = cfg.baseUrl.replace(/\/$/, "");
    this.map = new Map(); // peerKey -> sessionId
    this.subscribed = new Set(); // 已确保订阅 follow 流的 sessionId
    this.muxWs = null;
    this.stopped = false;
    this.reconnectAttempts = 0;
  }

  async loadMapping() {
    const data = await readJsonFile(this.cfg.sessionsFile);
    if (data && typeof data === "object" && data.sessions) {
      this.map = new Map(Object.entries(data.sessions));
      this.log.info(`加载会话映射 ${this.map.size} 条 (${this.cfg.sessionsFile})`);
    }
  }

  /** 对已有映射的所有会话应用配置的模型 (best-effort, 失败只记日志不阻断)。 */
  async applyModelToExisting() {
    const m = this.cfg.model;
    if (!m?.provider || !m?.model) return;
    let applied = 0;
    for (const sessionId of this.map.values()) {
      try {
        await this.selectModel(sessionId);
        applied++;
      } catch (err) {
        this.log.warn(`[${sessionId}] 应用模型失败: ${err.message}`);
      }
    }
    if (applied) this.log.info(`已对 ${applied} 个已有会话应用模型 ${m.provider}/${m.model}`);
  }

  /** 为单个会话调用 session.selectModel; 未配置模型时直接返回。 */
  async selectModel(sessionId) {
    const m = this.cfg.model;
    if (!m?.provider || !m?.model) return;
    const payload = { sessionId, provider: m.provider, model: m.model };
    if (m.reasoningEffort) payload.reasoningEffort = m.reasoningEffort;
    await this.unary("session.selectModel", payload);
    this.log.info(
      `[${sessionId}] 已选择模型 ${m.provider}/${m.model}` + (m.reasoningEffort ? ` 推理=${m.reasoningEffort}` : ""),
    );
  }

  async saveMapping() {
    const obj = Object.fromEntries(this.map);
    await writeJsonFile(this.cfg.sessionsFile, { sessions: obj });
  }

  /** 一元 RPC 调用; 业务失败抛 Error, 返回 result.value。 */
  async unary(method, payload, timeoutMs = 30000) {
    const rpcId = crypto.randomUUID();
    const body = { type: "client-request", rpcId, method, payload };
    const resp = await fetchRetry(`${this.base}/qqbapi/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, 1, timeoutMs);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      throw new Error(`DSH ${method}: HTTP ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    if (data.rpcId !== rpcId) {
      throw new Error(`DSH ${method}: rpcId 不匹配 (sent ${rpcId}, got ${data.rpcId})`);
    }
    if (!data.result?.ok) {
      const err = data.result?.error ?? { code: "internal", message: "unknown error" };
      throw new Error(`DSH ${method} 业务错误 [${err.code}]: ${err.message}`);
    }
    return data.result.value;
  }

  /** 为该 peer 取得(必要时创建)一个 DSH 会话。peerKey 形如 c2c:<openid> / group:<group_openid>:<member_openid>。 */
  async ensureSession(peerKey) {
    let sessionId = this.map.get(peerKey);
    if (sessionId) return sessionId;
    this.log.info(`为新聊天对象创建 DSH 会话: ${peerKey}`);
    const createPayload = { cwd: this.cfg.workspaceCwd ?? undefined };
    if (this.cfg.agentPreset) createPayload.agentPreset = this.cfg.agentPreset;
    const value = await this.unary("session.create", createPayload);
    sessionId = value.sessionId;
    this.map.set(peerKey, sessionId);
    await this.saveMapping();
    this.log.info(`会话已创建: ${peerKey} -> ${sessionId} (模式 ${this.cfg.agentPreset || "默认"})`);
    // 应用配置的模型 (best-effort)
    try {
      await this.selectModel(sessionId);
    } catch (err) {
      this.log.warn(`[${sessionId}] 应用模型失败: ${err.message}`);
    }
    return sessionId;
  }

  /** 确保某会话已订阅 follow 事件流 (幂等; prompt 前调用)。 */
  async ensureFollow(sessionId) {
    if (this.subscribed.has(sessionId)) return;
    const resp = await fetchRetry(`${this.base}/qqbapi/follow/add?sid=${encodeURIComponent(sessionId)}`, {
      method: "GET",
    }, 1, 30000);
    if (!resp.ok) throw new Error(`DSH follow/add: HTTP ${resp.status}`);
    this.subscribed.add(sessionId);
    this.log.debug(`[${sessionId}] 已订阅 follow 流`);
  }

  /** 向会话发一条用户消息 (mode=queue: DSH 原生排队, 上一轮未结束时自动排队)。 */
  async prompt(peerKey, text) {
    const sessionId = await this.ensureSession(peerKey);
    await this.ensureFollow(sessionId);
    await this.unary("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    });
    return sessionId;
  }

  /** 向**已有**会话派发一条斜杠命令(如 /compact), 返回完整结果值 (含 command 槽: {kind:'success',text})。
   *  不创建新会话; 会话不存在时抛错由调用方处理。 */
  async promptExisting(sessionId, text) {
    await this.ensureFollow(sessionId);
    return this.unary("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    });
  }

  /** 手动压缩会话历史 — 走网页端同款 remote `commands/execute` (命令 `/compact`)。
   *  返回 { commandId, result: { kind:'success'|'error', text } }。 */
  async compact(sessionId) {
    return this.unary(
      "commands/execute",
      { args: { agentId: sessionId, line: "/compact" } },
      120000,
    );
  }

  async cancel(sessionId) {
    return this.unary("session.cancel", { sessionId });
  }

  /** 回答 DSH 的问题 (question 帧 → POST /qqbapi/answer)。 */
  async answerQuestion(question, sessionId, answers) {
    const body = {
      clientId: question.clientId,
      eventId: question.eventId,
      answers,
    };
    const resp = await fetchRetry(`${this.base}/qqbapi/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, 1, 30000);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.ok) {
      throw new Error(`DSH answer: HTTP ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    this.log.debug(`问题应答已提交 eventId=${question.eventId}`);
    return data;
  }

  // ---------- 下行事件流 (SSE: /qqbapi/follow/stream) ----------

  /** 常驻重连循环: 连接成功则阻塞到断开, 失败/断开后指数退避重试。 */
  async openMux() {
    let retry = 0;
    while (!this.stopped) {
      try {
        await this.connectMux(); // 连接成功时阻塞, 断开时 resolve
        retry = 0;
      } catch (err) {
        this.log.error(`events 流连接失败: ${err.message}`);
      }
      if (this.stopped) break;
      retry++;
      await sleep(Math.min(30000, 2000 * 2 ** Math.min(retry, 5)));
    }
  }

  connectMux() {
    return new Promise((resolve, reject) => {
      const sseUrl = `${this.base}/qqbapi/follow/stream`;
      // AbortController 兼容 Node 18+; bridge 要求 Node >= 22
      const ac = new AbortController();
      this.muxAbort = ac;
      let settled = false;
      const ok = () => {
        if (!settled) {
          settled = true;
          this.reconnectAttempts = 0;
          resolve();
        }
      };
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      fetch(sseUrl, { signal: ac.signal, headers: { accept: "text/event-stream" } })
        .then((resp) => {
          if (!resp.ok || !resp.body) {
            fail(new Error(`SSE HTTP ${resp.status}`));
            return;
          }
          this.log.info("已连接 DSH 事件流 (/qqbapi/follow/stream SSE)");
          this.emit("open");
          // 手写 SSE 解析 (Web Streams API): 按 "event:"/"data:" 行组成帧
          let eventName = "message";
          let dataLines = [];
          const decoder = new TextDecoder();
          let buf = "";
          const handleChunk = (chunk) => {
            buf += decoder.decode(chunk, { stream: true });
            for (;;) {
              const idx = buf.indexOf("\n");
              if (idx === -1) break;
              const line = buf.slice(0, idx).replace(/\r$/, "");
              buf = buf.slice(idx + 1);
              if (line === "") {
                if (dataLines.length) {
                  this.dispatchSse(eventName, dataLines.join("\n"));
                }
                eventName = "message";
                dataLines = [];
                continue;
              }
              if (line.startsWith(":")) continue;
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
          };
          const reader = resp.body.getReader();
          void (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                handleChunk(value);
              }
              // 连接真正断开才 resolve, 让 openMux 循环安排重连
              this.log.warn("DSH 事件流断开, 将重连");
              ok();
            } catch (err) {
              if (ac.signal.aborted) { ok(); return; }
              this.log.warn(`DSH 事件流错误: ${err?.message ?? err}`);
              fail(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        })
        .catch((err) => {
          if (ac.signal.aborted) { ok(); return; }
          fail(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  dispatchSse(eventName, dataText) {
    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      return;
    }
    if (eventName === "session-event") {
      // payload: { sessionId, frame } — frame: {type:'event', event:{type,data,...}}
      const frame = payload?.frame;
      const event = frame?.type === "event" ? frame.event : null;
      if (event) {
        this.emit("frame", { type: "session/event", sessionId: payload.sessionId, event }, payload);
      }
    } else if (eventName === "question") {
      // payload: { clientId, eventId, agentId, request }
      const questions = payload?.request?.questions;
      this.emit("frame", {
        type: "question/requested",
        sessionId: payload?.agentId,
        questions,
        clientId: payload?.clientId,
        eventId: payload?.eventId,
      }, payload);
    } else if (eventName === "follow-error") {
      this.log.warn(`follow 流错误 [${payload?.sessionId}]: ${payload?.message}`);
    }
  }

  async stop() {
    this.stopped = true;
    if (this.muxAbort) {
      try { this.muxAbort.abort(); } catch { /* ignore */ }
    }
  }
}
