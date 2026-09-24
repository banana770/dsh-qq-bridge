# Changelog / 更新记录

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
