// dsh.js — DeepSeek Harness Web API 客户端 (dsh --profile web 已在运行)。
// 协议依据 dsh-host-apiproxy / dsh-client-connection:
//   一元调用:  POST {base}/api/{method}
//     body  { type:'client-request', rpcId:<uuid>, method, payload }
//     响应  { type:'server-response', rpcId, result:{ ok, value } | { ok:false, error } }
//   下行流:   ws://{base}/api/events.mux → 帧 { type:'server-request', rpcId, method, payload }
//     payload.type = 'session/event' | 'question/requested' | 'session/subscribed' | ...
//   回答问题: POST {base}/api/respond, body { type:'client-response', rpcId, result:{ ok:true, value } }
// 回环 (127.0.0.1) 免认证, 直接可用。
// 每个聊天对象 (peer) 映射一个 DSH 会话, 映射持久化在 sessions.json。

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
    const resp = await fetchRetry(`${this.base}/api/${method}`, {
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

  /** 向会话发一条用户消息 (mode=queue: DSH 原生排队, 上一轮未结束时自动排队)。 */
  async prompt(peerKey, text) {
    const sessionId = await this.ensureSession(peerKey);
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

  /** 回答 DSH 的问题 (question/requested 帧, rpcId 即问题 id)。 */
  async answerQuestion(rpcId, sessionId, answers) {
    const body = {
      type: "client-response",
      rpcId,
      result: { ok: true, value: { sessionId, answer: { answers } } },
    };
    const resp = await fetchRetry(`${this.base}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, 1, 30000);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error(`DSH /api/respond: HTTP ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    this.log.debug(`问题应答已提交 rpcId=${rpcId} -> ${JSON.stringify(data)}`);
    return data;
  }

  // ---------- 下行流 (events.mux) ----------

  /** 常驻重连循环: 连接成功则阻塞到断开, 失败/断开后指数退避重试。 */
  async openMux() {
    let retry = 0;
    while (!this.stopped) {
      try {
        await this.connectMux(); // 连接成功时阻塞, 断开时 resolve
        retry = 0;
      } catch (err) {
        this.log.error(`events.mux 连接失败: ${err.message}`);
      }
      if (this.stopped) break;
      retry++;
      await sleep(Math.min(30000, 2000 * 2 ** Math.min(retry, 5)));
    }
  }

  connectMux() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.base.replace(/^http/, "ws") + "/api/events.mux";
      const ws = new WebSocket(wsUrl);
      this.muxWs = ws;
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

      ws.onopen = () => {
        this.log.info("已连接 DSH events.mux 下行流");
        this.emit("open");
      };
      ws.onerror = (ev) => {
        this.log.error(`events.mux 错误: ${ev?.message ?? "websocket error"}`);
        fail(new Error(ev?.message ?? "mux websocket error"));
      };
      ws.onclose = (ev) => {
        this.log.warn(`DSH events.mux 断开 code=${ev.code}`);
        ok();
      };
      ws.onmessage = (ev) => {
        let frame;
        try {
          frame = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        // frame: { type:'server-request', rpcId, method, payload }
        if (frame?.type === "server-request") {
          this.emit("frame", frame.payload, frame);
        }
      };
    });
  }

  async stop() {
    this.stopped = true;
    this.muxWs?.close(1000, "bye");
  }
}
