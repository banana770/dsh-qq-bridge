// dsh-qq-bridge — 静态插件 HOST 半区 (lib/index.js)
//
// 静态化的「QQ 机器人桥接」管理插件。与旧动态插件 (plugin/qqb-host.js) 业务逻辑
// 一致, 仅把动态 runner 私有的 harness.handle('qqb/*') RPC 换成静态插件可用的
// ctx.webServer.register() HTTP 路由 (node:http 风格, 同源 /qqb/* 前缀):
//   GET  /qqb/state       → 状态快照 (status + config 掩码 + 日志尾部)
//   GET  /qqb/list-models → 模型目录 (llm 服务, 可选)
//   POST /qqb/save        → 写 config.json 并按需重启桥接
//   POST /qqb/start       → 拉起桥接进程
//   POST /qqb/stop        → 停止桥接进程
//
// 依赖服务 (host 侧均已挂载): fs, subprocess, timer, webServer;
// llm / agentDefaultModel 为可选 (ctx.get), 失败只降级不阻断。
// 系统级操作 (注册表 Run 键 / 桌面保活 flag) 用 node:child_process (静态插件
// 运行在真实 dsh node 进程内, 非动态沙箱)。
// 注意: BRIDGE_DIR 是硬编码绝对路径, 移动目录需同步修改。

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const name = 'dsh-qq-bridge';
const inject = ['fs', 'timer', 'webServer'];

// ===================== /qqbapi/* — DSH 新版网关适配层 =====================
//
// DSH 0.1.1-rc.2 起 /api/* 全部强制浏览器 Cookie 认证 (client-connection
// requestRejection), 桥接进程的裸 HTTP 调用会收到 401。本适配层在插件路由上
// (无认证, 与 /qqb/* 同级) 提供旧协议兼容面, 进程内直达 typertGateway:
//   POST /qqbapi/rpc                → 一元 RPC: {rpcId, method, payload} 旧壳,
//                                     内部翻译为 dispatchRpc(method, {args}, signal)
//   GET  /qqbapi/follow/add?sid=    → 为指定会话打开 session/follow 流 (SSE 保持)
//   GET  /qqbapi/follow/drop?sid=   → 关闭对应 follow 流
//   GET  /qqbapi/follow/stream      → SSE: 汇聚所有 follow 流的事件帧 + user-questions 帧
//   POST /qqbapi/answer             → {clientId, eventId, value} 回填 user-questions waterfall
//
// 协议要点 (dsh-api-gateway 0.1.5-alpha.1):
//   · 一元调用 args 必须恰含描述符声明的 wire 字段:
//       session.*      → args.request = 旧 payload (session/prompt 额外要求 requestId)
//       commands/execute → args = {agentId, line, submittedAttachments}
//   · $events 流: open 后首帧 {type:"ready", clientId}; 之后每帧
//       {type:"emit", event, args} | {type:"waterfall", event, eventId, agentId, request}
//     waterfall 结果经 dispatchRpc("$events/result", {args:{clientId,eventId,outcome}})
//     回填, outcome: {kind:"result", value} | {kind:"rejected", error} | {kind:"next"}
//   · user-questions/request 的 value: {answers:[{id, selected:[], custom?}]}
//     ($events/result 的 value 走到 forwardWaterfall.resolve → userQuestions.ask 返回值)

function applyQqbApi(ctx) {
  const gateway = ctx.get('typertGateway');
  if (!gateway) {
    console.error('[qqb] typertGateway 服务不可用, /qqbapi/* 未启用 (桥接将无法调用 DSH)');
    return () => {};
  }

  const follows = new Map(); // sessionId -> { controller, done }
  const sseClients = new Set(); // res 集合
  let eventsClientId = null; // $events 流的 clientId
  let eventsAbort = null;
  let eventsRunning = false;

  function sseWrite(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
  }
  function broadcastSse(event, data) {
    for (const res of sseClients) sseWrite(res, event, data);
  }
  function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(body);
    } catch { /* ignore */ }
  }

  // ---------- $events 流: 问询 waterfall 的进程内消费端 ----------
  function startEvents() {
    if (eventsRunning) return;
    eventsRunning = true;
    void (async () => {
      const abort = new AbortController();
      eventsAbort = abort;
      try {
        const iterator = await gateway.openWireStream('$events', { args: {} }, abort.signal);
        for await (const frame of iterator) {
          if (frame && frame.type === 'ready') { eventsClientId = frame.clientId; continue; }
          if (frame && frame.type === 'waterfall' && frame.event === 'user-questions/request') {
            broadcastSse('question', { clientId: eventsClientId, eventId: frame.eventId, agentId: frame.agentId, request: frame.request });
            continue;
          }
          // 其余帧 (emit/waterfall 非问询) 一律回 kind:"next" 放行给浏览器 UI
          if (frame && frame.type === 'waterfall') {
            void gateway.dispatchRpc('$events/result', { args: { clientId: eventsClientId, eventId: frame.eventId, outcome: { kind: 'next' } } }, undefined).catch(() => {});
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) console.error('[qqb] $events 流异常: ' + (err && err.message));
      } finally {
        eventsRunning = false;
        eventsClientId = null;
        eventsAbort = null;
        // 断线重连
        if (ctx && !disposedQqbApi) setTimeout(() => { try { startEvents(); } catch { /* ignore */ } }, 3000);
      }
    })();
  }

  // ---------- session/follow 流 ----------
  function startFollow(sessionId) {
    let f = follows.get(sessionId);
    if (f && !f.done) return;
    const controller = new AbortController();
    f = { controller, done: false };
    follows.set(sessionId, f);
    void (async () => {
      try {
        const iterator = await gateway.openWireStream('session/follow', { args: { request: { address: { kind: 'session', sessionId } } } }, controller.signal);
        for await (const frame of iterator) {
          broadcastSse('session-event', { sessionId, frame });
        }
      } catch (err) {
        if (!controller.signal.aborted) broadcastSse('follow-error', { sessionId, message: (err && err.message) || String(err) });
      } finally {
        f.done = true;
        if (follows.get(sessionId) === f) follows.delete(sessionId);
      }
    })();
  }

  // ---------- HTTP 处理器 ----------
  async function handleRpc(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
    const method = typeof body.method === 'string' ? body.method : '';
    // 旧桥接用点号端点 (session.prompt), 新网关要求 namespace/method 斜杠形式
    const endpoint = method.includes('/') ? method : method.replace(/\./g, '/');
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const rpcId = typeof body.rpcId === 'string' ? body.rpcId : randomUUID();
    try {
      let args;
      if (endpoint === 'commands/execute') {
        args = { agentId: payload.agentId, line: payload.line, submittedAttachments: payload.submittedAttachments ?? [] };
      } else if (endpoint.startsWith('session/')) {
        args = { request: payload };
        if (endpoint === 'session/prompt' && !payload.requestId) args.request = { ...payload, requestId: randomUUID() };
      } else {
        args = { request: payload };
      }
      const value = await gateway.dispatchRpc(endpoint, { args }, undefined);
      sendJson(res, 200, { type: 'server-response', rpcId, result: value });
    } catch (err) {
      sendJson(res, 200, {
        type: 'server-response', rpcId,
        result: { ok: false, error: { code: (err && err.code) || 'internal', message: (err && err.message) || String(err), details: {} } },
      });
    }
  }

  async function handleAnswer(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
    const clientId = body.clientId || eventsClientId;
    const eventId = body.eventId;
    const answers = body.answers;
    if (!clientId || !eventId || !Array.isArray(answers)) {
      return sendJson(res, 200, { ok: false, error: '需要 clientId / eventId / answers' });
    }
    try {
      await gateway.dispatchRpc('$events/result', {
        args: { clientId, eventId, outcome: { kind: 'result', value: { answers } } },
      }, undefined);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
    }
  }

  async function handleFollowAdd(req, res, url) {
    const sid = url.searchParams.get('sid');
    if (!sid) return sendJson(res, 400, { ok: false, error: '缺少 sid' });
    startEvents();
    startFollow(sid);
    sendJson(res, 200, { ok: true });
  }
  async function handleFollowDrop(req, res, url) {
    const sid = url.searchParams.get('sid');
    if (sid && follows.has(sid)) {
      follows.get(sid).controller.abort();
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 200, { ok: true, already: true });
    }
  }
  function handleFollowStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
  }

  startEvents();
  const routeDisposers = [
    ctx.webServer.register({ kind: 'exact', path: '/qqbapi/rpc', handler: handleRpc }),
    ctx.webServer.register({ kind: 'exact', path: '/qqbapi/answer', handler: handleAnswer }),
    ctx.webServer.register({ kind: 'exact', path: '/qqbapi/follow/add', handler: (req, res) => handleFollowAdd(req, res, new URL(req.url || '/qqbapi/follow/add', 'http://x')) }),
    ctx.webServer.register({ kind: 'exact', path: '/qqbapi/follow/drop', handler: (req, res) => handleFollowDrop(req, res, new URL(req.url || '/qqbapi/follow/drop', 'http://x')) }),
    ctx.webServer.register({ kind: 'exact', path: '/qqbapi/follow/stream', handler: (req, res) => handleFollowStream(req, res) }),
  ];
  return () => {
    disposedQqbApi = true;
    for (const d of routeDisposers) { try { d(); } catch { /* ignore */ } }
    if (eventsAbort) { try { eventsAbort.abort(); } catch { /* ignore */ } }
    for (const f of follows.values()) { try { f.controller.abort(); } catch { /* ignore */ } }
  };
}

let disposedQqbApi = false;

// ===================== 原有管理半区 =====================

/** 从插件包自身位置推导项目根: <proj>/plugin-pkg/lib/index.js → <proj>。 */
function deriveBridgeDir() {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  } catch {
    return undefined;
  }
}

function apply(ctx) {
  // 桥接项目目录 (dsh-qq-bridge): 优先环境变量 DSH_QQB_BRIDGE_DIR,
  // 否则从插件包位置推导 (适用于 link: 安装与普通 npm 安装的项目内使用)。
  const BRIDGE_DIR = process.env.DSH_QQB_BRIDGE_DIR || deriveBridgeDir();
  const LOG_CAP = 300;

  const state = {
    config: null,
    proc: null,
    running: false,
    pid: -1,
    startedAt: 0,
    exitInfo: null,
    restartCount: 0,
    userStopped: false,
    nodePath: null,
    logLines: [],
    saving: false,
  };
  let disposed = false;
  let restartTimer = null;

  const log = (...a) => console.log('[qqb]', ...a);
  const logErr = (...a) => console.error('[qqb]', ...a);

  // ---------- 配置 (fs 服务) ----------

  async function configTarget() {
    return ctx.fs.resolve(BRIDGE_DIR + '\\config.json');
  }
  async function readConfig() {
    try {
      const raw = await ctx.fs.readText(await configTarget());
      return JSON.parse(raw);
    } catch (err) {
      logErr('读取 config.json 失败: ' + (err && err.message));
      return null;
    }
  }
  async function writeConfig(cfg) {
    await ctx.fs.writeText(await configTarget(), JSON.stringify(cfg, null, 2));
  }

  // ---------- 日志收集 ----------

  function pushLog(stream, text) {
    if (!text) return;
    for (const line of String(text).split(/\r?\n/)) {
      if (!line) continue;
      state.logLines.push({ t: Date.now(), stream, text: line });
    }
    if (state.logLines.length > LOG_CAP) state.logLines.splice(0, state.logLines.length - LOG_CAP);
  }

  // ---------- 桥接进程 ----------
  //
  // 用 node:child_process 直接 spawn (而非 ctx.subprocess):
  //   · windowsHide: true —— 不弹控制台窗口 (dsh web 若 detached 无控制台,
  //     其子进程默认会各自创建可见控制台, 表现为"一堆终端");
  //   · 防并发: 已在运行则直接返回; 有残留句柄先杀; 自动重启定时器单一管理,
  //     避免多个 exit 回调/保存操作叠加出多个桥接进程 (曾导致 QQ 平台频控)。

  async function spawnBridge() {
    if (disposed) return;
    if (state.running && state.proc) return; // 已在运行, 防并发
    if (state.proc) {
      try { state.proc.kill(); } catch (err) { /* ignore */ }
      state.proc = null;
    }
    const nodePath = process.execPath || 'node';
    state.nodePath = nodePath;
    const child = spawn(nodePath, ['src/main.js'], {
      cwd: BRIDGE_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => pushLog('stdout', d.toString()));
    child.stderr.on('data', (d) => pushLog('stderr', d.toString()));
    state.proc = child;
    state.running = true;
    state.userStopped = false;
    state.pid = child.pid;
    state.startedAt = Date.now();
    state.exitInfo = null;
    log('桥接进程已启动 pid=' + child.pid);
    child.on('error', (err) => {
      logErr('桥接 spawn 错误: ' + (err && err.message));
      state.running = false;
      if (state.proc === child) state.proc = null;
    });
    child.on('exit', (code, signal) => {
      state.running = false;
      state.exitInfo = { code, signal, at: Date.now() };
      log('桥接进程退出 code=' + code + ' signal=' + signal);
      if (state.proc === child) state.proc = null;
      const auto = !disposed && !state.userStopped && state.config && state.config.bridge && state.config.bridge.autoStart;
      if (auto) {
        state.restartCount++;
        const delay = Math.min(15000, 2000 * 2 ** Math.min(state.restartCount, 4));
        log(state.restartCount + ' 次退出, ' + delay + 'ms 后自动重启');
        clearRestartTimer();
        restartTimer = ctx.timer.timeout(() => {
          restartTimer = null;
          void spawnBridge().catch((e) => logErr('自动重启失败: ' + (e && e.message)));
        }, delay);
      }
    });
  }

  function clearRestartTimer() {
    if (restartTimer) {
      try { ctx.timer.clearTimeout(restartTimer); } catch (err) { /* ignore */ }
      restartTimer = null;
    }
  }

  function stopBridge() {
    state.userStopped = true;
    clearRestartTimer();
    if (state.proc) {
      try { state.proc.kill(); } catch (err) { logErr('终止桥接失败: ' + (err && err.message)); }
      state.proc = null;
    }
    state.running = false;
  }

  // ---------- 快照 ----------

  function maskSecret(s) {
    if (!s) return '';
    if (s.length <= 8) return s.slice(0, 2) + '••••';
    return s.slice(0, 4) + '••••' + s.slice(-2);
  }
  function configSnapshot() {
    const c = state.config || {};
    return {
      appId: c.qq ? c.qq.appId : '',
      secretMasked: maskSecret(c.qq ? c.qq.appSecret : ''),
      sandbox: c.qq ? !!c.qq.sandbox : true,
      autoStart: !!(c.bridge && c.bridge.autoStart),
      workspaceCwd: c.dsh ? c.dsh.workspaceCwd : '',
      agentPreset: c.dsh && c.dsh.agentPreset ? c.dsh.agentPreset : '',
      model: c.dsh && c.dsh.model && c.dsh.model.provider
        ? { provider: c.dsh.model.provider, model: c.dsh.model.model, reasoningEffort: c.dsh.model.reasoningEffort || '' }
        : null,
      system: {
        bootAutoStart: !!(c.system && c.system.bootAutoStart),
        keepAliveAfterClose: !!(c.system && c.system.keepAliveAfterClose),
      },
    };
  }
  function stateSnapshot() {
    return {
      bridgeDir: BRIDGE_DIR,
      config: configSnapshot(),
      status: {
        running: state.running,
        pid: state.pid,
        startedAt: state.startedAt,
        uptimeSec: state.running ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
        exitInfo: state.exitInfo,
        restartCount: state.restartCount,
        nodePath: state.nodePath,
      },
      logTail: state.logLines.slice(-40),
    };
  }

  // ---------- HTTP 路由 (webServer, 替代动态 harness.handle) ----------

  function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(body);
  }
  async function readBodyJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch (err) { return {}; }
  }
  async function handleState(req, res) {
    sendJson(res, 200, stateSnapshot());
  }
  async function handleListModels(req, res) {
    const llm = ctx.get('llm');
    const groups = [];
    const failures = [];
    if (llm) {
      const seen = new Set();
      let configurable = [];
      try { configurable = llm.listConfigurableProviders() || []; } catch (err) { failures.push({ provider: '?', displayName: '?', message: (err && err.message) || String(err) }); }
      for (const p of configurable) {
        seen.add(p.provider);
        try {
          const models = (await llm.listModels(p.provider)) || [];
          groups.push({ provider: p.provider, displayName: p.displayName || p.provider, models: models.map((m) => ({ id: m.id, name: m.name || m.id })) });
        } catch (err) {
          failures.push({ provider: p.provider, displayName: p.displayName || p.provider, message: (err && err.message) || String(err) });
        }
      }
      let live = [];
      try { live = llm.listProviders() || []; } catch (err) { /* ignore */ }
      for (const lp of live) {
        if (seen.has(lp.id)) continue;
        seen.add(lp.id);
        try {
          const models = (await llm.listModels(lp.id)) || [];
          groups.push({ provider: lp.id, displayName: lp.name || lp.id, models: models.map((m) => ({ id: m.id, name: m.name || m.id })) });
        } catch (err) {
          failures.push({ provider: lp.id, displayName: lp.name || lp.id, message: (err && err.message) || String(err) });
        }
      }
    }
    let current = null;
    try {
      const adm = ctx.get('agentDefaultModel');
      if (adm) {
        const sel = adm.currentSelection();
        if (sel && sel.provider && sel.model) current = { provider: sel.provider, model: sel.model };
      }
    } catch (err) { /* ignore */ }
    sendJson(res, 200, { current, groups, failures });
  }
  async function handleSave(req, res) {
    if (state.saving) return sendJson(res, 200, { ok: false, error: '正在保存中, 请稍候' });
    state.saving = true;
    try {
      const args = await readBodyJson(req);
      const cfg = state.config || {};
      const qq = Object.assign({}, cfg.qq || {});
      if (args && typeof args.appId === 'string' && args.appId.trim()) qq.appId = args.appId.trim();
      if (args && typeof args.appSecret === 'string' && args.appSecret && args.appSecret !== '__KEEP__') qq.appSecret = args.appSecret.trim();
      if (!qq.appId || !qq.appSecret) return sendJson(res, 200, { ok: false, error: 'appId 与 appSecret 不能为空' });
      if (args && typeof args.sandbox === 'boolean') qq.sandbox = args.sandbox;

      const dsh = Object.assign({}, cfg.dsh || {});
      if (args && typeof args.workspaceCwd === 'string' && args.workspaceCwd.trim()) dsh.workspaceCwd = args.workspaceCwd.trim();
      if (args && typeof args.agentPreset === 'string') {
        if (args.agentPreset) dsh.agentPreset = args.agentPreset;
        else delete dsh.agentPreset;
      }
      if (args && 'model' in args) {
        if (args.model && args.model.provider && args.model.model) dsh.model = { provider: args.model.provider, model: args.model.model };
        else delete dsh.model;
      }
      if (args && 'reasoningEffort' in args) {
        if (dsh.model && args.reasoningEffort) dsh.model.reasoningEffort = args.reasoningEffort;
        else if (dsh.model) delete dsh.model.reasoningEffort;
      }

      const bridge = Object.assign({}, cfg.bridge || {});
      if (args && typeof args.autoStart === 'boolean') bridge.autoStart = args.autoStart;

      const system = Object.assign({}, cfg.system || {});
      if (args && typeof args.bootAutoStart === 'boolean') system.bootAutoStart = args.bootAutoStart;
      if (args && typeof args.keepAliveAfterClose === 'boolean') system.keepAliveAfterClose = args.keepAliveAfterClose;

      const next = Object.assign({}, cfg, { qq, dsh, bridge, system });
      await writeConfig(next);
      state.config = next;
      log('配置已保存: appId=' + qq.appId + ' sandbox=' + qq.sandbox + ' autoStart=' + bridge.autoStart
        + ' 模式=' + (dsh.agentPreset || '默认')
        + ' model=' + (dsh.model ? dsh.model.provider + '/' + dsh.model.model + (dsh.model.reasoningEffort ? ' 推理=' + dsh.model.reasoningEffort : '') : '(默认)')
        + ' 开机自启=' + system.bootAutoStart + ' 关窗保活=' + system.keepAliveAfterClose);
      // 系统开关 (失败只记录, 不阻断保存)
      try { await applyBootAutoStart(system.bootAutoStart); } catch (err) { logErr('设置开机自启失败: ' + (err && err.message)); }
      try { await applyKeepAlive(system.keepAliveAfterClose); } catch (err) { logErr('设置关窗保活失败: ' + (err && err.message)); }
      let restarting = false;
      if (state.running) {
        stopBridge();
        await spawnBridge();
        restarting = true;
      }
      return sendJson(res, 200, { ok: true, restarting });
    } catch (err) {
      logErr('保存配置失败: ' + (err && err.message));
      return sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
    } finally {
      state.saving = false;
    }
  }
  async function handleStart(req, res) {
    if (state.running) return sendJson(res, 200, { ok: true, already: true });
    try {
      await spawnBridge();
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
    }
  }
  async function handleStop(req, res) {
    if (!state.running) return sendJson(res, 200, { ok: true, already: true });
    stopBridge();
    return sendJson(res, 200, { ok: true });
  }
  async function handleModelReasoning(req, res) {
    const llm = ctx.get('llm');
    const cfgModel = state.config && state.config.dsh && state.config.dsh.model;
    let provider = '';
    let model = '';
    try {
      const url = new URL(req.url || '/qqb/model-reasoning', 'http://x');
      provider = url.searchParams.get('provider') || (cfgModel && cfgModel.provider) || '';
      model = url.searchParams.get('model') || (cfgModel && cfgModel.model) || '';
    } catch (err) { /* ignore */ }
    const currentEffort = cfgModel && cfgModel.reasoningEffort ? cfgModel.reasoningEffort : null;
    if (!llm || !provider || !model) return sendJson(res, 200, { efforts: [], defaultEffort: null, currentEffort });
    try {
      const info = await llm.resolveModelInfo(provider, model);
      const reasoning = info && info.reasoning;
      const efforts = reasoning && reasoning.efforts
        ? reasoning.efforts.map((e) => ({ id: e.id, name: e.name, description: e.description || '' }))
        : [];
      return sendJson(res, 200, {
        efforts,
        defaultEffort: reasoning && reasoning.defaultEffort ? reasoning.defaultEffort : null,
        currentEffort,
      });
    } catch (err) {
      return sendJson(res, 200, { efforts: [], defaultEffort: null, currentEffort, error: (err && err.message) || String(err) });
    }
  }

  // ---------- 系统开关 (开机自启 / 关窗保活) ----------

  function execFileP(file, args) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { windowsHide: true }, (err, stdout) => {
        if (err) reject(new Error((err && err.message) || String(err)));
        else resolve(stdout || '');
      });
    });
  }
  function vbsQuote(p) {
    return '"' + String(p).replace(/"/g, '""') + '"';
  }
  function regExe() {
    return (process.env.SystemRoot ? process.env.SystemRoot + '\\System32\\reg.exe' : 'reg.exe');
  }
  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const RUN_VALUE = 'DSH Web (qq-bridge)';
  // 保活 flag 必须放在工作区内: host 的 ctx.fs 受 workspace-write 沙箱限制,
  // 写 D:\ 会被拒绝。桌面版 main.js 从同一路径读取 (KEEP_BACKEND_FLAG)。
  const KEEP_FLAG = BRIDGE_DIR + '\\keep-backend.flag';

  /** 用当前 dsh web 进程自身的启动参数生成「开机隐藏启动」VBS 启动器。 */
  async function writeBootLauncher() {
    const nodePath = process.execPath || 'node';
    const binPath = process.argv && process.argv[1] ? process.argv[1] : null;
    const cwd = process.cwd();
    if (!binPath) throw new Error('无法确定 dsh web 启动脚本路径 (process.argv[1])');
    const runCmd = vbsQuote(nodePath) + ' ' + vbsQuote(binPath) + ' web';
    // 注意: VBS 内容必须保持纯 ASCII —— wscript 按系统 ANSI 代码页解析脚本,
    // 中文(UTF-8)注释在部分开机早期环境下会让解析异常, 导致自启静默失败。
    const vbs = [
      "' dsh-qq-bridge boot autostart for dsh web (hidden window). Generated by settings page.",
      'Set sh = CreateObject("WScript.Shell")',
      'sh.CurrentDirectory = ' + vbsQuote(cwd),
      'sh.Run ' + vbsQuote(runCmd) + ', 0, False',
    ].join('\r\n');
    const vbsPath = BRIDGE_DIR + '\\scripts\\start-dsh-web-hidden.vbs';
    await ctx.fs.writeText(await ctx.fs.resolve(vbsPath), vbs);
    return vbsPath;
  }
  async function applyBootAutoStart(enabled) {
    if (!enabled) {
      try { await execFileP(regExe(), ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']); } catch (err) { /* 键不存在也视为已关闭 */ }
      log('开机自启已关闭');
      return;
    }
    const vbsPath = await writeBootLauncher();
    await execFileP(regExe(), ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', 'wscript.exe ' + vbsQuote(vbsPath), '/f']);
    log('开机自启已启用: ' + RUN_KEY + '\\' + RUN_VALUE + ' = wscript.exe ' + vbsPath);
  }
  async function applyKeepAlive(enabled) {
    if (enabled) {
      await ctx.fs.writeText(await ctx.fs.resolve(KEEP_FLAG), '1');
      log('关窗保活已启用 (flag: ' + KEEP_FLAG + ')');
    } else {
      try {
        await execFileP(process.env.ComSpec || 'cmd.exe', ['/c', 'del', '/f', '/q', KEEP_FLAG]);
      } catch (err) { /* flag 不存在也视为已关闭 */ }
      log('关窗保活已关闭');
    }
  }

  // ---------- 生命周期 ----------

  ctx.effect(() => {
    const routeDisposers = [
      ctx.webServer.register({ kind: 'exact', path: '/qqb/state', handler: handleState }),
      ctx.webServer.register({ kind: 'exact', path: '/qqb/list-models', handler: handleListModels }),
      ctx.webServer.register({ kind: 'exact', path: '/qqb/model-reasoning', handler: handleModelReasoning }),
      ctx.webServer.register({ kind: 'exact', path: '/qqb/save', handler: handleSave }),
      ctx.webServer.register({ kind: 'exact', path: '/qqb/start', handler: handleStart }),
      ctx.webServer.register({ kind: 'exact', path: '/qqb/stop', handler: handleStop }),
    ];
    // 新版 DSH /api/* 强制浏览器认证 → 桥接改走进程内适配层。
    // typertGateway 可能晚于本插件就绪, 用 inject 等待服务可用再挂载。
    let apiDisposer = null;
    ctx.inject(['typertGateway'], (gctx) => {
      try { apiDisposer = applyQqbApi(gctx); } catch (err) { logErr('挂载 /qqbapi 适配层失败: ' + (err && err.message)); }
    });
    void (async () => {
      state.config = await readConfig();
      if (!state.config) {
        state.config = { qq: { appId: '', appSecret: '', sandbox: true }, dsh: {}, bridge: { maxReplyChars: 1800, logLevel: 'info', autoStart: false } };
      }
      const auto = !!(state.config.bridge && state.config.bridge.autoStart);
      log('QQ 桥接插件已加载, bridgeDir=' + BRIDGE_DIR + ' autoStart=' + auto);
      if (auto) {
        try { await spawnBridge(); } catch (err) { logErr('自动启动桥接失败: ' + (err && err.message)); }
      }
    })();
    return () => {
      disposed = true;
      for (const d of routeDisposers) { try { d(); } catch (err) { /* ignore */ } }
      try { if (apiDisposer) apiDisposer(); } catch (err) { /* ignore */ }
      clearRestartTimer();
      stopBridge();
    };
  });
}

export { name, inject, apply };
