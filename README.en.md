# dsh-qq-bridge

[English](README.en.md) | [中文](README.md)

A lightweight bridge that connects **DeepSeek Harness** (DSH Desktop or `dsh web`, via its
local API) to the **QQ Bot Open Platform** (q.qq.com), so a QQ bot can talk to users
through the agents running inside Harness.

- Zero dependencies — only Node.js >= 22 (built-in `fetch` / `WebSocket`)
- Does not patch DSH: it reuses the running DSH instance (Desktop or `dsh web`)
- Every chat peer (private user / group member) maps to its own DSH session, so histories never mix
- Supports DSH "ask user" (`ask_user`) prompts: the question is forwarded to QQ and the answer is fed back automatically
- Group chats trigger only when the bot is @-mentioned; private chats (C2C) work directly
- Optional: install as a "QQ Bot" management plugin inside the DSH settings page (status / logs / model / toggles)

## Compatibility at a glance (1.0.2)

| Runtime | Verified version | Connection |
|---|---|---|
| DSH Desktop | **0.1.7-rc.2** | Load `plugin-pkg` in the desktop profile and point `dsh.baseUrl` at the desktop local API (tested here: `http://127.0.0.1:19387`) |
| DSH Web | **0.1.7-alpha.2** | Load `plugin-pkg` in the Web profile; default `dsh.baseUrl` is `http://127.0.0.1:3080` |
| Legacy DSH | <= 0.1.1-rc.1 | No plugin: direct `/api/*` access (loopback-unauthenticated era) |

> Release 1.0.2 uses the same core link for DSH Desktop and `dsh web`. The desktop local API port can vary by install/configuration; use the address that is actually listening.

## Architecture

```
QQ user / group member
     |  1. private message / group @-message
     v
QQ Bot Open Platform gateway (wss://.../gateway/bot, official WebSocket)
     |
     v
dsh-qq-bridge (this service, Node.js)
     |  2. POST /qqbapi/rpc           (HTTP RPC, legacy client-request protocol)
     |  3. GET  /qqbapi/follow/stream (SSE downlink, receives replies)
     |  4. POST /qqbapi/answer        (feeds answers back into DSH questions)
     v
dsh-qq-bridge plugin /qqbapi/* adapter (inside the DSH process, runs with DSH Desktop or dsh web)
     |  5. in-process calls to typertGateway (dispatchRpc / openWireStream)
     v
DeepSeek Harness (DSH Desktop or dsh web, already running; Web default 127.0.0.1:3080, Desktop uses its actual local port)
     |  6. reply text via QQ Open API POST /v2/users|groups/.../messages
     v
QQ user / group member
```

> **Why the adapter layer is needed.** Starting with DSH `0.1.1-rc.2`, every `/api/*`
> route requires browser Cookie authentication (`requestRejection` in
> `dsh-client-connection`) — loopback included — so the bridge's raw HTTP calls get
> `HTTP 401`. The `plugin-pkg` plugin in this repo registers unauthenticated
> `/qqbapi/*` routes inside the DSH process and translates the legacy protocol into
> in-process gateway calls (`typertGateway`). **After upgrading DSH, restart DSH Desktop or
> `dsh web` once so the plugin code takes effect.** Running `node src/main.js` without the
> plugin only works on old DSH versions.

## Quick start

### 1. Prerequisites

> The DSH local API address is configured by `dsh.baseUrl`: `dsh web` defaults to
> `http://127.0.0.1:3080`, while DSH Desktop uses its actual local port (tested here:
> `http://127.0.0.1:19387`). The bridge and DSH must run on the **same computer**
> because they talk over localhost.

- A running DSH Desktop or `dsh web` (Web default `http://127.0.0.1:3080`; Desktop tested here at `http://127.0.0.1:19387`)
- Node.js >= 22: check with `node --version`
- A bot created at [q.qq.com](https://q.qq.com/qqbot/openclaw/index.html), together with its **AppID** and **AppSecret**
  - New bots start in **sandbox mode**: only the developer's own QQ account and whitelisted test members can talk to them. Open access requires review and publishing.

### 2. Configure

```bash
# copy the template and fill in your own AppID / AppSecret
cp config.example.json config.json   # Windows: copy config.example.json config.json
```

Key fields in `config.json`:

| Field | Meaning |
|---|---|
| `qq.appId` / `qq.appSecret` | copied from the bot settings page on q.qq.com |
| `qq.sandbox` | `true` = sandbox (default for new bots), `false` = production |
| `dsh.baseUrl` | DSH local API address: `dsh web` default `http://127.0.0.1:3080`; DSH Desktop uses its actual port (tested here: `http://127.0.0.1:19387`) |
| `dsh.workspaceCwd` | working directory for newly created DSH sessions (point it at your usual project folder) |
| `dsh.agentPreset` | optional; chat mode = DSH agent preset: `standard` / `code` (PTC) / `minimal` / `cordis`; leave empty to follow the Harness default |
| `dsh.model` | optional; pin `provider` / `model` plus `reasoningEffort` (for example `off` / `high` / `max`, model-dependent) |
| `dsh.sessionsFile` | peer <-> DSH session map, generated automatically |
| `bridge.autoStart` | when the bridge is managed by the plugin, start it automatically on plugin load (irrelevant for standalone runs) |

> `appSecret` is shown only once, at creation time. **`config.json` is covered by
> `.gitignore` — never commit it to a public repository.** If you suspect a leak, reset
> the secret in the q.qq.com console and update the config.

### 3. Run

```bash
node src/main.js        # or: npm start
```

You should see (log messages are in Chinese):

```
[INFO] 换取 access_token (appId=...) ...
[INFO] 连接 QQ 网关: wss://...
[INFO] 网关就绪 READY: session=... bot=...
[INFO] 已连接 DSH 事件流 (/qqbapi/follow/stream SSE)
[INFO] ========== 桥接已就绪: QQ <-> DSH ==========
```

### 4. Usage

- **Private chat**: message the bot from any QQ account (test members must be configured in the console first)
- **Group chat**: invite the bot into a group and @-mention it (only @-messages are received)

Built-in commands:

| Command | Effect |
|---|---|
| `/help` | command list |
| `/status` | bridge and session status |
| `/cancel` | abort the current turn |
| `/reset` | clear this chat's context and start a brand-new DSH session |
| `/compact` | manually compact the conversation history (DSH also compacts automatically when the context fills up, so this is rarely needed) |

## Optional integration A: install as a DSH settings-page plugin (`plugin-pkg`)

`plugin-pkg/` is a **DeepSeek Harness static plugin**. It adds a "QQ Bot" card to the
settings page where you can view bridge status and logs, edit
AppID/Secret/sandbox/model/chat mode/reasoning effort, configure **autostart on boot**
and **keep-alive after closing the window**, and start / stop / restart the bridge.
DSH Desktop and Web use the same plugin package; the desktop profile is
`~/.dsh/profiles/desktop/package.json`.

1. Edit the matching DSH profile `package.json` (Web: `~/.dsh/profiles/web/package.json`; Desktop: `~/.dsh/profiles/desktop/package.json`) and add:

   ```jsonc
   {
     "dependencies": { "dsh-qq-bridge": "link:C:/path/to/dsh-qq-bridge/plugin-pkg" },
     "dsh": { "profile": { "bundles": [ "dsh-qq-bridge" ] } }
   }
   ```

2. Restart DSH Desktop or `dsh web`, then open **Settings -> QQ Bot**.

> The plugin has to locate the bridge project directory. By default it derives it from
> its own location (with a `link:` install that is the project root). If your layout
> differs, set `DSH_QQB_BRIDGE_DIR=<absolute path to dsh-qq-bridge>` in the environment
> of the DSH process (Desktop or `dsh web`).
>
> Desktop setup: point `dsh.baseUrl` at the desktop local API (tested here:
> `http://127.0.0.1:19387`). After restarting the desktop app, `/qqb/state` should show
> `running=true` and an established DSH event stream.

## Optional integration B: system autostart / keep-alive (Windows only)

The "System" card on the settings page has two toggles (they can also be set in the
`system` section of `config.json`):

- **Autostart on boot** (`system.bootAutoStart`): after Windows login, start `dsh web`
  and the bridge in the background (hidden windows, no UI). The generated launcher
  currently targets `dsh web`; DSH Desktop users should prefer the desktop app's own
  startup setting. Implemented with a VBS launcher plus an
  `HKCU\...\CurrentVersion\Run` registry entry.
- **Keep-alive after close** (`system.keepAliveAfterClose`): after closing the DSH desktop
  window, keep the backend and the bridge running. Implemented with a `keep-backend.flag`
  file in the bridge project directory, which the desktop wrapper's `main.js` checks
  before killing child processes.

With both toggles on, the QQ bot is ready right after boot with no window open. On
non-Windows systems the registry / VBS operations fail safely (they are only logged);
everything else keeps working.

## Platform rules (important)

1. **Sandbox mode**: before review/publishing, a new bot is sandboxed — only the
   developer and whitelisted "test members" can talk to it. Add test QQ numbers under
   the "Sandbox configuration" section of the q.qq.com console.
2. **Private / group permissions**: request the "private message" and "group message"
   capabilities under "Developer settings -> Feature configuration". Without them,
   messages of that type are never delivered to the bot.
3. **Passive-reply window**: the platform only lets a bot message a user who interacted
   within the **last 5 minutes**. If a DSH turn exceeds that window the reply fails
   (4xx in the log); have the user send another message to reopen it.
4. **Rate limits**: a single group text message is capped at roughly 2000 characters
   (this bridge splits at 1800 by default) and is subject to platform rate limiting;
   avoid spamming.
5. **@-mention**: group messages must @-mention the bot; private chat has no such
   requirement.

## FAQ

**Q: Startup fails with "换取 access_token 失败" (failed to exchange access token)**
A: Check `appId` / `appSecret`, and make sure the bot has been created and enabled.

**Q: Connected to the gateway but no READY**
A: Look for `op9` (Identify rejected). Try flipping `qq.sandbox`, and make sure the host
can reach `api.bot.qq.com` / `sandbox.api.sgroup.qq.com`.

**Q: No response to private or group messages**
A: Check, in order: (1) is your test account in the sandbox whitelist; (2) is the
matching message capability enabled; (3) do bridge logs show the event (`C2C 消息 ...` /
`群@消息 ...`); (4) is DSH running.

**Q: DSH asks a question (ask_user)**
A: The bridge forwards the question and its options to QQ — reply with the option number
(for example `2`) or with free text. Answers are fed back through the plugin adapter's
`/qqbapi/answer` route (in-process `$events/result`).

**Q: The message was sent but there is no reply for a long time**
A: Open DSH Desktop or the Web GUI to watch the session (tool calls, questions, ...). Model reasoning
can take a while; if it stalls, use `/cancel`.

**Q: I answered a question on the DSH web page, and now my next QQ message disappears**
A: Fixed in v1.0.1. The gateway emits a `{ type: "cancel", eventId }` frame when a question
is consumed elsewhere (answered in the browser, turn ended, or aborted). The bridge used to
ignore that frame, so it still believed a question was pending and treated the next QQ
message as an "answer" — which the gateway then silently dropped. The bridge now clears the
pending question on `cancel`, and pushes back an explicit "this question has expired" reply
so the user's message is never swallowed.

## Repository layout

```
dsh-qq-bridge/
  config.example.json   # template (copy to config.json, which is gitignored)
  src/
    main.js             # bridge core (event wiring, commands, question relay)
    qq.js               # QQ Open API client (token / gateway / WS / send message)
    dsh.js              # DSH client (RPC + SSE event stream + session mapping)
    selftest.js         # self-test script
    util.js             # logging, retry, small helpers
  plugin-pkg/           # optional: DSH settings-page static plugin + /qqbapi/* adapter
    package.json
    cordis.patch.yml
    lib/{index.js, client.js}
  package.json
```

## Security notes

- `config.json` (holds the AppSecret) and `sessions.json` (holds chat peer identifiers)
  are both gitignored — **never force-add them**.
- The bridge and the plugin adapter only talk to `dsh web` over loopback (127.0.0.1). The
  `/qqbapi/*` adapter is an **unauthenticated** local interface designed for the local
  bridge process (matching the loopback `/api` behaviour of older DSH). Do not expose the
  DSH local port (`dsh web` default 3080; Desktop tested here at 19387) to the public
  internet or to untrusted LANs.

## Version compatibility

| Repo version | DSH version | Notes |
|---|---|---|
| <= 0.1.0 | <= 0.1.1-rc.1 | direct `/api/*` access (loopback-unauthenticated era) |
| 1.0.0 | >= 0.1.1-rc.2 (incl. 0.1.2-rc.x, 0.1.5-alpha.x) | via the `/qqbapi/*` in-process adapter in `plugin-pkg` |
| 1.0.1 | >= 0.1.1-rc.2, incl. **0.1.7-alpha.2** | auto-detects both `openWireStream` signatures; forwards gateway `cancel` frames so an expired question no longer swallows the next QQ message |
| 1.0.2 (current) | **DSH Desktop 0.1.7-rc.2**; DSH Web >= 0.1.1-rc.2 (incl. **0.1.7-alpha.2**) | Desktop and Web share the same `plugin-pkg` adapter; point `dsh.baseUrl` at the actual local API (desktop tested here at `19387`); clearer desktop wording and docs |

> **Tested on DSH Desktop 0.1.7-rc.2.** Load `plugin-pkg` in the desktop profile, set
> `dsh.baseUrl` to `http://127.0.0.1:19387`, then restart the desktop app. The management
> API, QQ gateway, and DSH event stream all work; `/qqb/state` reports `running=true` and
> an established DSH event stream.

> **DSH 0.1.7-alpha.2 note.** `dsh-api-gateway` changed the wire-stream entry point:
> `openWireStream(endpoint, payload, signal)` became
> `openWireStream(endpoint, payload, uplink, peer, signal, control)`. Passing the old third
> argument made the gateway reject the signal (`signals[0] is not of type AbortSignal`), so
> the `$events` stream could never be established and no replies ever reached QQ. The plugin
> now sniffs the function arity and adapts to both signatures.

## License

MIT License — see [LICENSE](LICENSE).