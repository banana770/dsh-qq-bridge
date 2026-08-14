# dsh-qq-bridge

把 **DeepSeek Harness**(`dsh web`,本机 3080 端口的 Web API)桥接到 **QQ 官方机器人开放平台**(q.qq.com)的轻量桥接服务,让 QQ 机器人直接用 Harness 里的智能体与用户对话。

- 零依赖,仅需 Node.js ≥ 22(内置 `fetch` / `WebSocket`)
- 不修改 DSH 任何代码,复用正在运行的 `dsh web` 实例
- 每个聊天对象(私聊用户 / 群成员)自动映射一个独立的 DSH 会话,历史互不串扰
- 支持 DSH 的「提问」(ask_user)交互:问题转发到 QQ,回复自动回填
- 群聊需 @机器人 才触发;私聊(C2C)直接对话
- 可选:安装为 DSH 设置页里的「QQ 机器人」管理插件(状态/日志/模型/开关可视化)

## 架构

```
QQ 用户/群成员
     │  ① 私聊消息 / 群@消息
     ▼
QQ 官方开放平台网关 (wss://…/gateway/bot, 官方 WebSocket)
     │
     ▼
dsh-qq-bridge (本服务, Node.js)
     │  ② POST /api/session.prompt (HTTP RPC)
     │  ③ ws://127.0.0.1:3080/api/events.mux (下行流, 收回复)
     ▼
DeepSeek Harness (dsh web, 已在运行, 127.0.0.1:3080)
     │  ④ 回复文本经 QQ 开放接口 POST /v2/users|groups/…/messages
     ▼
QQ 用户/群成员
```

## 快速开始

### 1. 准备

- 已运行 `dsh web`(Web GUI,默认 `http://127.0.0.1:3080`)
- Node.js ≥ 22:`node --version`
- 在 [q.qq.com](https://q.qq.com/qqbot/openclaw/index.html) 创建好的机器人,拿到 **AppID** 和 **AppSecret**
  - 新机器人在**沙箱模式**,仅开发者本人 QQ 及测试成员可对话;上架/发布后才对全体用户开放

### 2. 配置

```bash
# 复制配置并填入你的 AppID / AppSecret
cp config.example.json config.json   # Windows: copy config.example.json config.json
```

`config.json` 关键字段:

| 字段 | 说明 |
|---|---|
| `qq.appId` / `qq.appSecret` | q.qq.com 机器人设置页复制 |
| `qq.sandbox` | `true` = 沙箱环境(新机器人默认),`false` = 正式环境 |
| `dsh.baseUrl` | DSH Web 地址,默认 `http://127.0.0.1:3080` |
| `dsh.workspaceCwd` | 新建 DSH 会话的工作目录(建议指向你的常用项目目录) |
| `dsh.agentPreset` | 可选,聊天模式 = DSH 的 Agent 预设:`standard`(标准)/ `code`(PTC)/ `minimal`(极简)/ `cordis`(创造),留空 = 跟随 Harness 默认 |
| `dsh.model` | 可选,指定模型 `provider` / `model`,以及 `reasoningEffort`(推理等级,如 `off`/`high`/`max`,视模型而定) |
| `dsh.sessionsFile` | 聊天对象 ↔ DSH 会话 的映射文件,自动生成 |
| `bridge.autoStart` | 由插件托管时,插件加载自动拉起桥接(独立运行时无用) |

> ⚠️ `appSecret` 只在创建时显示一次。**`config.json` 已被 .gitignore 忽略,绝不提交到任何公开仓库**;
> 若担心泄露,去 q.qq.com 控制台重置密钥后更新配置。

### 3. 运行

```bash
node src/main.js        # 或 npm start
```

启动后应看到:

```
[INFO] 换取 access_token (appId=…) ...
[INFO] 连接 QQ 网关: wss://…
[INFO] 网关就绪 READY: session=… bot=…
[INFO] 已连接 DSH events.mux 下行流
[INFO] ========== 桥接已就绪: QQ <-> DSH ==========
```

### 4. 使用

- **私聊**:直接用任意 QQ 号给机器人发消息(测试成员需先在开放平台配置)
- **群聊**:把机器人拉进群,发消息时 @机器人(仅收到 @ 机器人的消息)

可用命令:

| 命令 | 作用 |
|---|---|
| `/help` | 命令列表 |
| `/status` | 桥接与会话状态 |
| `/cancel` | 中止当前轮次 |
| `/reset` | 清空本聊天上下文,开启全新 DSH 会话 |
| `/compact` | 手动压缩当前对话历史(上下文满时 DSH 会自动压缩,一般无需手动) |

## 可选集成 A:安装为 DSH 设置页插件(`plugin-pkg`)

`plugin-pkg/` 是 **DeepSeek Harness 静态插件**:设置页出现「QQ 机器人」卡片,可查看桥接状态/日志、改 AppID/Secret/沙箱/模型/聊天模式/推理等级、配置**开机自启**与**关窗保活**,启停与自动重启桥接。

1. 修改你的 dsh profile(`~/.dsh/profiles/web/package.json`),添加:

   ```jsonc
   {
     "dependencies": { "dsh-qq-bridge": "link:C:/path/to/dsh-qq-bridge-open/plugin-pkg" },
     "dsh": { "profile": { "bundles": [ "dsh-qq-bridge" ] } }
   }
   ```

2. 重启 `dsh web`,进入「设置 → QQ 机器人」。

> 插件需要能找到桥接项目目录:`plugin-pkg` 默认从自身位置推导(link 安装时即项目根)。
> 若你的目录结构不同,给运行 dsh web 的进程设置环境变量 `DSH_QQB_BRIDGE_DIR=<桥接项目绝对路径>` 覆盖。

## 可选集成 B:系统级开机自启 / 关窗保活(仅 Windows)

设置页「系统」卡里有两个开关(也可以在 `config.json` 的 `system` 段配置):

- **开机自启**(`system.bootAutoStart`):登录 Windows 后后台自动启动 dsh web 与桥接(隐藏窗口,不弹界面)。
  实现:生成 VBS 启动器 + 写 `HKCU\...\CurrentVersion\Run` 注册表项。
- **关窗保活**(`system.keepAliveAfterClose`):关闭 DSH 桌面版窗口后,后端与桥接仍在后台运行。
  实现:桥接项目目录下创建 `keep-backend.flag`,配合桌面封装的 main.js 检测该文件决定是否杀掉子进程。

两个开关都开 → 开机即可用 QQ 机器人聊天,无需打开任何窗口。
非 Windows 系统:注册表/VBS 操作会失败并被捕获(仅记日志),其余功能不受影响。

## 平台规则须知(重要)

1. **沙箱模式**:新机器人在审核上架前处于沙箱,只有开发者(创建者)与「测试成员」能对话。在 q.qq.com 控制台的「沙箱配置」里把测试 QQ 号加入白名单。
2. **私聊 / 群聊权限**:在控制台「开发设置 → 功能配置」里申请「私聊消息」「群聊消息」能力。未开通时对应类型的消息不会推送给机器人。
3. **被动回复窗口**:官方限制机器人只能对**最近 5 分钟内有交互**的用户主动发消息。DSH 轮次若超过窗口,回复会失败(日志出现 4xx),此时让用户再发一条即可。
4. **消息频率限制**:群聊机器人单条文本上限约 2000 字(本桥默认按 1800 切分),并受平台频控约束;多轮对话请勿高频刷消息。
5. **@ 触发**:群聊必须 @机器人,私聊无此限制。

## 常见问题

**Q: 启动报「换取 access_token 失败」**
A: 检查 appId / appSecret 是否正确;机器人是否已创建并启用。

**Q: 连接网关后没有 READY**
A: 观察是否收到 `op9`(Identify 被拒)。可尝试把 `qq.sandbox` 切换后再试;确认网络能访问 `api.bot.qq.com` / `sandbox.api.sgroup.qq.com`。

**Q: 私聊/群聊发消息没反应**
A: 依次检查:① 沙箱白名单是否包含你的测试号;② 对应消息能力是否已申请开通;③ 桥接日志里是否出现事件(`C2C 消息 …` / `群@消息 …`);④ DSH 是否在运行。

**Q: DSH 侧回复出现「问题」(ask_user)**
A: 桥会把问题和选项转发到 QQ,直接回复选项编号(如 `2`)或自由文本即可;回答会通过 `/api/respond` 回填给 DSH 智能体。

**Q: 消息发出去了但很久没回复**
A: 打开 DSH Web GUI 能看到对应会话的运行过程(工具调用、提问等)。模型推理可能较长;若长时间无输出,可用 `/cancel` 中止。

## 文件结构

```
dsh-qq-bridge/
├── config.example.json   # 配置模板 (config.json 由你复制生成, 已被 .gitignore 忽略)
├── src/
│   ├── main.js           # 桥接主逻辑(事件接线、命令、提问转发)
│   ├── qq.js             # QQ 官方 API 客户端(token/网关/WS/发消息)
│   ├── dsh.js            # DSH Web API 客户端(RPC + events.mux + 会话映射)
│   ├── selftest.js       # 自检脚本
│   └── util.js           # 日志、重试、小工具
├── plugin-pkg/           # 可选: DSH 设置页静态插件
│   ├── package.json
│   ├── cordis.patch.yml
│   └── lib/{index.js, client.js}
└── package.json
```

## 安全须知

- `config.json`(含 AppSecret)与 `sessions.json`(含聊天对象标识)都在 `.gitignore` 中,**不要 force-add**。
- 桥接仅监听本地回环(127.0.0.1)调用 dsh web;dsh web 的 `/api` 在回环免认证,请勿把 3080 端口暴露到公网。

## 许可

MIT License,详见 [LICENSE](LICENSE)。
