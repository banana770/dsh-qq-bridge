# Changelog / 更新记录

## 1.0.3 — 2026-10-22

### 修复 / Fixes

- **适配 DSH 0.2.x 网关的新调用约定**(桌面端 0.2.1-rc.2 已实测):0.2.x 移除了网关内置的
  operator Peer,`dispatchRpc` / `openWireStream` 现在必须显式传入真实 Peer,传 `undefined`
  会在 `assertPeerLive` 抛 `Cannot read properties of undefined (reading 'signal')`,
  表现为"QQ 侧连上了、DSH 也在跑,但每条消息都转发失败"。
  `/qqbapi/*` 适配层改用 `ctx.connection.browserPeer`(principal=owner,
  interactions=answer),一元 RPC、`session/follow`、`session/prompt` 与提问回填全部恢复。
- **桌面端随机端口不再需要手改配置**:DSH 桌面端的 Web 端口每次启动都可能变化,
  `config.json` 里写死的 `dsh.baseUrl` 很容易过期 —— 桥接日志每 30 秒刷一条
  `events 流连接失败: fetch failed`,QQ 侧只会收到「DSH (DeepSeek Harness) 似乎没有在运行」。
  现在插件拉起桥接时注入 `DSH_QQB_DSH_URL=<当前真实 origin>`,子进程优先采用;
  `config.json` 的 `dsh.baseUrl` 仅在手动 `node src/main.js` 时作为回落值。
- **设置页保存配置不再被沙箱拒绝**:桥接项目目录通常在用户工作区之外,host 的 `ctx.fs`
  受 `workspace-write` 限制会拒绝读写并报
  `file access denied under workspace-write mode`。`config.json` 改为用 `node:fs` 直读直写。
- **修复保存配置后的无限重启**:`stopBridge()` + `spawnBridge()` 之后,旧子进程迟到的
  `exit` 事件会把 `running` 置为 false 并再次调度自动重启,把刚拉起的新进程杀掉,
  形成重启风暴(日志里每隔几秒出现一次「桥接已就绪」)。`exit` 回调现在只处理当前子进程。

### 兼容性 / Compatibility

- **DSH 桌面端 0.2.1-rc.2**:已实测。桌面端 Web 端口由系统随机分配(本机为 60861),
  由插件通过 `DSH_QQB_DSH_URL` 自动跟随,无需在 `config.json` 里写死端口。
- DSH Web 与旧版桌面端:行为不变,仍按 `openWireStream` 的函数 arity 自动嗅探新旧签名。
- 升级方式:更新 `plugin-pkg` 后重启 DSH(桌面端或 `dsh web`),让插件 host 代码生效。

## 1.0.2 — 2026-09-25

### 适配范围 / Compatibility

- **DSH 桌面端 0.1.7-rc.2**:已实测。桌面端 profile 加载 `plugin-pkg`,`dsh.baseUrl` 指向 `http://127.0.0.1:19387`。
- **DSH Web 0.1.7-alpha.2**:已实测。Web profile 加载 `plugin-pkg`,`dsh.baseUrl` 默认 `http://127.0.0.1:3080`。
- **DSH ≥ 0.1.1-rc.2**:使用 `plugin-pkg` 的 `/qqbapi/*` 进程内适配层。
- **DSH ≤ 0.1.1-rc.1**:无需插件,直接使用旧版回环 `/api/*`。

### 变更 / Changes

- 明确桌面端与 `dsh web` 共用同一套桥接核心和插件适配层。
- 文档同时说明桌面端与 Web 的启动、配置、端口和验证方式。
- 桌面端连接失败提示不再只写“启动 dsh web”,改为提示启动 DSH 桌面端或 `dsh web`。
- 桌面端本地 API 端口可能因安装/配置而异;19387 是本版验证环境地址,实际使用请以本机监听为准。

## 1.0.1

- 适配 DSH `0.1.7-alpha.2` 的 `openWireStream` 新签名。
- 转发网关 `cancel` 帧,修复提问过期后下一条 QQ 消息被静默吞掉的问题。
