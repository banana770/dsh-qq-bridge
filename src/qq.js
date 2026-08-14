// qq.js — QQ 官方机器人开放平台 (q.qq.com) 客户端。
// 协议要点(依据官方文档 bot.q.qq.com, 2026-07 版):
//   1. 先 POST {authBase} 换 access_token (有效期 7200s)
//   2. REST 调用带 Authorization: QQBot {access_token} + X-Union-Appid: {appId}
//   3. GET {apiBase}/gateway/bot 拿 WS 网关地址
//   4. WS: Hello(op10) → Identify(op2, token="QQBot {access_token}", intents) → Dispatch(op0)
//      心跳 op1 (d=最新 s), 心跳回执 op11; 断线短重连用 Resume(op6)
//   5. 事件: C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE (intent 1<<25)
//   6. 发消息: POST {apiBase}/v2/users/{openid}/messages   (C2C 私聊)
//             POST {apiBase}/v2/groups/{group_openid}/messages (群聊)
// 零依赖, Node >= 22 (全局 WebSocket / fetch)。

import { EventEmitter } from "node:events";
import { fetchRetry, sleep, makeLogger } from "./util.js";

// GROUP_AND_C2C_EVENT = 1 << 25 (C2C 私聊 + 群聊@机器人)
export const INTENTS_C2C_GROUP = 1 << 25;

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// 网关"假死"检测阈值: 超过该时长收不到任何业务事件(DISPATCH)即强制重连。
const QQ_IDLE_RECONNECT_MS = 15 * 60 * 1000;

export class QQClient extends EventEmitter {
  /**
   * @param {object} cfg - { appId, appSecret, sandbox, apiBase, sandboxApiBase, authBase }
   * @param {object} log
   */
  constructor(cfg, log) {
    super();
    this.cfg = cfg;
    this.log = log ?? makeLogger();
    this.apiBase = cfg.sandbox ? cfg.sandboxApiBase : cfg.apiBase;

    this.accessToken = null;
    this.tokenExpiresAt = 0;

    this.ws = null;
    this.sessionId = null; // READY 后由网关分配
    this.lastSeq = null; // 最近一次 Dispatch 的 s
    this.heartbeatTimer = null;
    this.lastAckAt = 0;
    this.lastDispatchAt = Date.now(); // 业务事件最后时间 (网关假死检测)
    this.identifySucceeded = false;
    this.botUsername = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
    this.resumeMode = false;
  }

  // ---------- 鉴权 ----------

  async refreshToken() {
    const body = { appId: this.cfg.appId, clientSecret: this.cfg.appSecret };
    this.log.info(`换取 access_token (appId=${this.cfg.appId}) ...`);
    const resp = await fetchRetry(this.cfg.authBase, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
      throw new Error(
        `换取 access_token 失败: HTTP ${resp.status} ${JSON.stringify(data).slice(0, 300)}` +
          ` — 请检查 appId/appSecret 是否正确、机器人是否已启用`,
      );
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (Number(data.expires_in ?? 7200) - 60) * 1000;
    this.log.debug("access_token 获取成功, 有效期 " + data.expires_in + "s");
  }

  async ensureToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    await this.refreshToken();
    return this.accessToken;
  }

  async authHeaders() {
    const token = await this.ensureToken();
    return {
      Authorization: `QQBot ${token}`,
      "X-Union-Appid": this.cfg.appId,
      "content-type": "application/json",
    };
  }

  // ---------- REST ----------

  async rest(path, { method = "GET", json } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = await this.authHeaders();
      const resp = await fetchRetry(`${this.apiBase}${path}`, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      if (resp.status === 401 && attempt === 0) {
        this.log.warn("REST 401, 刷新 access_token 后重试");
        this.accessToken = null;
        continue;
      }
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        throw new Error(`QQ API ${method} ${path} 失败: HTTP ${resp.status} ${JSON.stringify(data ?? {}).slice(0, 300)}`);
      }
      return data;
    }
    throw new Error(`QQ API ${path}: 401 重试后仍失败`);
  }

  async getGatewayUrl() {
    const data = await this.rest("/gateway/bot");
    if (!data?.url) throw new Error(`/gateway/bot 未返回 url: ${JSON.stringify(data).slice(0, 200)}`);
    return data.url;
  }

  // ---------- 发消息 ----------

  /** 私聊 (C2C)。openid = 事件里的 author.user_openid。 */
  async sendC2C(openid, content) {
    const data = await this.rest(`/v2/users/${encodeURIComponent(openid)}/messages`, {
      method: "POST",
      json: { msg_type: 0, content },
    });
    this.log.debug(`C2C -> ${openid}: ${content.slice(0, 80)}`);
    return data;
  }

  /** 群聊。groupOpenid = 事件里的 group_openid。 */
  async sendGroup(groupOpenid, content) {
    const data = await this.rest(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
      method: "POST",
      json: { msg_type: 0, content },
    });
    this.log.debug(`GROUP -> ${groupOpenid}: ${content.slice(0, 80)}`);
    return data;
  }

  // ---------- WebSocket 网关 ----------

  async start() {
    await this.ensureToken();
    const url = await this.getGatewayUrl();
    this.log.info(`连接 QQ 网关: ${url}`);
    await this.connectWS(url);
  }

  connectWS(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      const settleOk = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleErr = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      ws.onopen = () => {
        this.log.info("QQ 网关 TCP/TLS 已连接, 等待 Hello");
        // 10s 内收不到 Hello 视为异常, 主动断开交给重连循环
        this.armHelloGuard(ws);
        settleOk();
      };
      ws.onerror = (ev) => {
        const msg = ev?.message ?? "websocket error";
        this.log.error(`QQ 网关错误: ${msg}`);
        settleErr(new Error(msg));
      };
      ws.onclose = (ev) => {
        this.log.warn(`QQ 网关关闭 code=${ev.code} reason=${ev.reason ?? ""}`);
        this.clearHelloGuard();
        this.stopHeartbeat();
        if (!this.stopped) {
          settleOk();
          void this.reconnectLoop();
        }
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          this.log.warn("忽略无法解析的网关帧");
          return;
        }
        void this.handlePayload(msg);
      };
    });
  }

  /** Hello 守卫: 连接打开后 10s 未收到 Hello 则主动断开, 触发重连。 */
  armHelloGuard(ws) {
    this.clearHelloGuard();
    this._helloTimer = setTimeout(() => {
      this.log.error("10s 内未收到 Hello, 主动断开重连");
      if (ws.readyState === WebSocket.OPEN) ws.close(4000, "no hello");
    }, 10000);
    this._helloTimer.unref?.();
  }

  clearHelloGuard() {
    if (this._helloTimer) {
      clearTimeout(this._helloTimer);
      this._helloTimer = null;
    }
  }

  handlePayload(msg) {
    switch (msg.op) {
      case OP.HELLO:
        this.clearHelloGuard();
        this.log.info(`收到 Hello, 心跳间隔 ${msg.d.heartbeat_interval}ms`);
        this.lastAckAt = Date.now();
        this.startHeartbeat(msg.d.heartbeat_interval);
        if (this.resumeMode && this.sessionId) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        return;
      case OP.DISPATCH:
        this.lastSeq = msg.s ?? this.lastSeq;
        this.handleDispatch(msg.t, msg.d);
        return;
      case OP.HEARTBEAT_ACK:
        this.lastAckAt = Date.now();
        return;
      case OP.RECONNECT:
        this.log.warn("网关要求重连 (op7)");
        this.ws?.close(4000, "reconnect");
        return;
      case OP.INVALID_SESSION:
        this.log.error("Identify/Resume 被拒 (op9), 重置并全新连接");
        this.sessionId = null;
        this.lastSeq = null;
        this.resumeMode = false;
        this.ws?.close(4000, "invalid session");
        return;
      default:
        this.log.debug(`未处理 opcode: ${msg.op}`);
    }
  }

  handleDispatch(type, data) {
    this.lastDispatchAt = Date.now();
    switch (type) {
      case "READY":
        this.sessionId = data.session_id;
        this.identifySucceeded = true;
        this.botUsername = data.user?.username ?? null;
        this.reconnectAttempts = 0;
        this.log.info(`网关就绪 READY: session=${data.session_id} bot=${this.botUsername} shard=${JSON.stringify(data.shard)}`);
        this.emit("ready", data);
        return;
      case "RESUMED":
        this.identifySucceeded = true;
        this.reconnectAttempts = 0;
        this.log.info("网关恢复连接 RESUMED");
        return;
      default:
        // 业务事件 (C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE / ...)
        if (!this.identifySucceeded && type !== "READY") return;
        this.emit("event", { type, data, seq: this.lastSeq });
    }
  }

  sendIdentify() {
    this.resumeMode = false;
    void (async () => {
      const token = await this.ensureToken().catch(() => null);
      if (!token) return;
      const payload = {
        op: OP.IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: INTENTS_C2C_GROUP,
          shard: [0, 1],
          properties: { $os: "win32", $browser: "dsh-qq-bridge", $device: "dsh-qq-bridge" },
        },
      };
      this.log.info("发送 Identify (intents=" + INTENTS_C2C_GROUP + ")");
      this.ws?.send(JSON.stringify(payload));
    })();
  }

  sendResume() {
    void (async () => {
      const token = await this.ensureToken().catch(() => null);
      if (!token) return;
      const payload = {
        op: OP.RESUME,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
      };
      this.log.info(`发送 Resume (session=${this.sessionId} seq=${this.lastSeq})`);
      this.ws?.send(JSON.stringify(payload));
    })();
  }

  startHeartbeat(intervalMs) {
    this.stopHeartbeat();
    const tick = () => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // 心跳超时(3 个周期无 ACK)强制重连
      if (this.lastAckAt && Date.now() - this.lastAckAt > intervalMs * 3) {
        this.log.error("心跳 ACK 超时, 强制重连");
        this.ws.close(4000, "heartbeat timeout");
        return;
      }
      // 网关"假死"检测: 长时间收不到任何业务事件(DISPATCH)也强制重连。
      // 平台侧偶发"连接还在、心跳正常, 但不再推送消息"的僵尸连接。
      if (this.lastDispatchAt && Date.now() - this.lastDispatchAt > QQ_IDLE_RECONNECT_MS) {
        this.log.error("长时间无业务事件, 疑似网关假死, 强制重连");
        this.lastDispatchAt = Date.now(); // 防止重连循环里立刻再触发
        this.ws.close(4000, "idle reconnect");
        return;
      }
      this.ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.lastSeq }));
    };
    this.heartbeatTimer = setInterval(tick, intervalMs);
    // 第一次心跳立即发
    tick();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 掉线后重连: 短时间用 Resume 补发, 失败则全新 Identify。指数退避。 */
  async reconnectLoop() {
    if (this.stopped) return;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts++;
    this.log.info(`${delay / 1000}s 后重连 (第 ${this.reconnectAttempts} 次)`);
    await sleep(delay);
    if (this.stopped) return;
    try {
      await this.ensureToken();
      const url = await this.getGatewayUrl();
      this.resumeMode = Boolean(this.sessionId);
      this.log.info(`重新连接网关: ${url} (${this.resumeMode ? "resume" : "fresh"})`);
      await this.connectWS(url);
    } catch (err) {
      this.log.error(`重连失败: ${err.message}`);
      void this.reconnectLoop();
    }
  }

  async stop() {
    this.stopped = true;
    this.stopHeartbeat();
    this.ws?.close(1000, "bye");
  }
}
