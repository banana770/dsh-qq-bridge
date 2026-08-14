// dsh-qq-bridge — 静态插件 CLIENT 半区 (lib/client.js)
//
// 手写 client bundle (无构建工具链), 由 dsh-client-modules 以
// /plugins/dsh-qq-bridge/client.js 提供, 页面以 classic script 加载并执行;
// 通过 window.__ModuleLoader__.load 注册工厂, require("react") 取自页面种子
// 模块表 (与 shell 共享同一 React 实例)。
//
// 与旧动态插件 (plugin/qqb-client.js) 的差异:
//   ❌ 无 host.call/harness.handle —— 改为 fetch('/qqb/...') 同源调用 host 的
//      webServer 路由 (GET state/list-models, POST save/start/stop)。
//   ❌ 无 styles.insert —— 改为手动向 document.head 插入 <style> 标签。
//   ❌ 无沙箱 —— 直接使用原生 setInterval / fetch / document。
//   ✅ slots: 声明 inject=['slots'] 后直接 ctx.slots 使用, 注册
//      settings.section (id='qq-bridge', order=30, label='QQ 机器人')。
window.__ModuleLoader__.load({
	id: "dsh-qq-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// ---------- HTTP (同源调用 host 的 /qqb/* 路由) ----------
		function api(path, body) {
			const opts = body === undefined ? {} : {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			};
			return fetch(path, opts).then((r) => r.json());
		}

		// ---------- 样式 (静态无 styles.insert, 手动插 <style>) ----------
		let styleInjected = false;
		function ensureStyles() {
			if (styleInjected) return;
			styleInjected = true;
			const el = document.createElement("style");
			el.setAttribute("data-plugin", "qqb");
			el.textContent = [
				".qqb-wrap { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px; max-width: 860px; }",
				".qqb-card { border: 1px solid var(--theme-border-color, rgba(128,128,128,.25)); border-radius: 10px; padding: 14px 16px; background: var(--theme-bg-secondary, transparent); }",
				".qqb-h { margin: 0 0 10px; font-size: 14px; font-weight: 600; }",
				".qqb-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }",
				".qqb-label { width: 96px; flex: 0 0 auto; font-size: 13px; color: var(--theme-text-secondary, inherit); }",
				".qqb-input { flex: 1; min-width: 200px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--theme-border-color, rgba(128,128,128,.4)); background: var(--theme-bg-input, #fff); color: inherit; }",
				".qqb-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }",
				".qqb-dim { color: var(--theme-text-dim, #888); font-size: 12px; }",
				".qqb-link { color: var(--theme-accent, #2563eb); font-size: 13px; text-decoration: underline; cursor: pointer; }",
				".qqb-warn { color: #d97706; }",
				".qqb-ok { color: #16a34a; font-size: 13px; margin-top: 6px; }",
				".qqb-err { color: #dc2626; font-size: 13px; margin-top: 6px; }",
				".qqb-actions { margin-top: 10px; gap: 10px; }",
				".qqb-btn { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--theme-border-color, rgba(128,128,128,.4)); background: var(--theme-bg-input, #fff); color: inherit; cursor: pointer; }",
				".qqb-btn:disabled { opacity: .5; cursor: default; }",
				".qqb-primary { background: var(--theme-accent, #2563eb); color: #fff; border-color: transparent; }",
				".qqb-logs { margin: 0; max-height: 260px; overflow: auto; font: 12px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; background: var(--theme-bg-code, rgba(0,0,0,.05)); border-radius: 6px; padding: 10px; }"
			].join("\n");
			document.head.appendChild(el);
		}

		// ---------- 设置页面板 ----------
		function QQBridgePanel() {
			const [st, setSt] = React.useState(null);
			const [models, setModels] = React.useState(null);
			const [reasoning, setReasoning] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [msg, setMsg] = React.useState(null);
			const [appId, setAppId] = React.useState("");
			const [appSecret, setAppSecret] = React.useState("");
			const [sandbox, setSandbox] = React.useState(true);
			const [autoStart, setAutoStart] = React.useState(false);
			const [bootAutoStart, setBootAutoStart] = React.useState(false);
			const [keepAliveAfterClose, setKeepAliveAfterClose] = React.useState(false);
			const [agentPreset, setAgentPreset] = React.useState("");
			const [modelKey, setModelKey] = React.useState("");
			const [reasoningEffort, setReasoningEffort] = React.useState("");
			const [workspaceCwd, setWorkspaceCwd] = React.useState("");

			const loadReasoning = React.useCallback((provider, model) => {
				if (!provider || !model) { setReasoning({ efforts: [], defaultEffort: null, currentEffort: "" }); return; }
				return api("/qqb/model-reasoning?provider=" + encodeURIComponent(provider) + "&model=" + encodeURIComponent(model))
					.then((r) => { setReasoning(r); return r; })
					.catch(() => setReasoning({ efforts: [], defaultEffort: null, currentEffort: "" }));
			}, []);

			const loadOnce = React.useCallback(() => {
				return api("/qqb/state").then((s) => {
					setSt(s);
					setAppId(s.config.appId || "");
					setAppSecret("");
					setSandbox(!!s.config.sandbox);
					setAutoStart(!!s.config.autoStart);
					setBootAutoStart(!!(s.config.system && s.config.system.bootAutoStart));
					setKeepAliveAfterClose(!!(s.config.system && s.config.system.keepAliveAfterClose));
					setAgentPreset(s.config.agentPreset || "");
					setWorkspaceCwd(s.config.workspaceCwd || "");
					setModelKey(s.config.model ? s.config.model.provider + "::" + s.config.model.model : "");
					setReasoningEffort((s.config.model && s.config.model.reasoningEffort) || "");
					loadReasoning(s.config.model ? s.config.model.provider : "", s.config.model ? s.config.model.model : "");
					return s;
				}).catch((e) => { setMsg({ kind: "err", text: "读取状态失败: " + (e && e.message) }); return null; });
			}, []);

			React.useEffect(() => {
				let alive = true;
				loadOnce();
				api("/qqb/list-models").then((m) => { if (alive) setModels(m); }).catch(() => {});
				const id = setInterval(() => {
					api("/qqb/state").then((s) => { if (alive) setSt(s); }).catch(() => {});
				}, 2000);
				return () => { alive = false; clearInterval(id); };
			}, []);

			const onModelChange = (value) => {
				setModelKey(value);
				setReasoningEffort("");
				if (!value) { setReasoning({ efforts: [], defaultEffort: null, currentEffort: "" }); return; }
				const provider = value.split("::")[0];
				const model = value.slice(value.indexOf("::") + 2);
				loadReasoning(provider, model);
			};

			const onSave = async () => {
				setBusy(true); setMsg(null);
				try {
					const res = await api("/qqb/save", {
						appId: appId.trim(),
						appSecret: appSecret ? appSecret.trim() : "__KEEP__",
						sandbox: sandbox,
						autoStart: autoStart,
						bootAutoStart: bootAutoStart,
						keepAliveAfterClose: keepAliveAfterClose,
						agentPreset: agentPreset,
						workspaceCwd: workspaceCwd.trim(),
						model: modelKey ? { provider: modelKey.split("::")[0], model: modelKey.slice(modelKey.indexOf("::") + 2) } : null,
						reasoningEffort: reasoningEffort
					});
					if (res && res.ok) setMsg({ kind: "ok", text: res.restarting ? "已保存, 桥接正在重启以应用新配置…" : "已保存。" });
					else setMsg({ kind: "err", text: (res && res.error) || "保存失败" });
					setAppSecret("");
					await loadOnce();
				} catch (e) {
					setMsg({ kind: "err", text: "保存失败: " + (e && e.message) });
				}
				setBusy(false);
			};

			const onStart = async () => {
				setBusy(true); setMsg(null);
				try {
					const res = await api("/qqb/start");
					if (res && res.ok) setMsg({ kind: "ok", text: res.already ? "桥接已在运行。" : "桥接已启动。" });
					else setMsg({ kind: "err", text: (res && res.error) || "启动失败" });
					await loadOnce();
				} catch (e) { setMsg({ kind: "err", text: "启动失败: " + (e && e.message) }); }
				setBusy(false);
			};

			const onStop = async () => {
				setBusy(true); setMsg(null);
				try {
					const res = await api("/qqb/stop");
					if (res && res.ok) setMsg({ kind: "ok", text: res.already ? "桥接本就未运行。" : "已停止桥接。" });
					else setMsg({ kind: "err", text: (res && res.error) || "停止失败" });
					await loadOnce();
				} catch (e) { setMsg({ kind: "err", text: "停止失败: " + (e && e.message) }); }
				setBusy(false);
			};

			const status = st ? st.status : null;
			const cfg = st ? st.config : null;
			const logs = st ? st.logTail : [];

			// 模型下拉选项
			const modelOptions = [];
			if (models && models.groups) {
				for (const g of models.groups) {
					modelOptions.push(
						React.createElement("optgroup", { key: g.provider, label: g.displayName + " (" + g.provider + ")" },
							g.models.map((m) => React.createElement("option", { key: g.provider + "::" + m.id, value: g.provider + "::" + m.id }, m.name + " — " + m.id))
						)
					);
				}
			}

			const dot = status && status.running ? { background: "#22c55e" } : { background: "#ef4444" };

			return React.createElement("div", { className: "qqb-wrap" },
				// 状态卡
				React.createElement("div", { className: "qqb-card" },
					React.createElement("div", { className: "qqb-row" },
						React.createElement("span", { className: "qqb-dot", style: dot }),
						React.createElement("strong", null, status && status.running ? "桥接运行中" : "桥接已停止"),
						status && status.running
							? React.createElement("span", { className: "qqb-dim" }, " pid=" + status.pid + "  已运行 " + status.uptimeSec + "s")
							: (status && status.exitInfo ? React.createElement("span", { className: "qqb-dim" }, "  上次退出 code=" + status.exitInfo.code + " signal=" + status.exitInfo.signal) : null),
						React.createElement("span", { className: "qqb-dim" }, "  重启次数: " + (status ? status.restartCount : 0))
					),
					React.createElement("div", { className: "qqb-row qqb-dim" }, "桥接目录: " + (st ? st.bridgeDir : "…")),
					status && status.nodePath ? React.createElement("div", { className: "qqb-row qqb-dim" }, "node: " + status.nodePath) : null,
					React.createElement("div", { className: "qqb-row qqb-actions" },
						React.createElement("button", { className: "qqb-btn", disabled: busy, onClick: onStart }, "启动桥接"),
						React.createElement("button", { className: "qqb-btn", disabled: busy, onClick: onStop }, "停止桥接")
					)
				),

				// 模式与模型
				React.createElement("div", { className: "qqb-card" },
					React.createElement("h4", { className: "qqb-h" }, "QQ 机器人模式与模型"),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "聊天模式"),
						React.createElement("select", { className: "qqb-input", value: agentPreset, onChange: (e) => setAgentPreset(e.target.value) },
							React.createElement("option", { value: "" }, "(跟随 Harness 默认)"),
							React.createElement("option", { value: "standard" }, "标准模式 (standard)"),
							React.createElement("option", { value: "code" }, "PTC 模式 (code)"),
							React.createElement("option", { value: "minimal" }, "极简模式 (minimal)"),
							React.createElement("option", { value: "cordis" }, "创造模式 (cordis)")
						)
					),
					React.createElement("div", { className: "qqb-dim" }, "  决定 QQ 机器人每次新建会话采用 DSH 的哪种 Agent 预设 (标准/PTC/极简/创造)"),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "模型"),
						React.createElement("select", { className: "qqb-input", value: modelKey, onChange: (e) => onModelChange(e.target.value) },
							React.createElement("option", { value: "" }, "(不指定 — 使用 Harness 默认模型)"),
							modelOptions
						)
					),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "推理等级"),
						React.createElement("select", { className: "qqb-input", value: reasoningEffort, onChange: (e) => setReasoningEffort(e.target.value), disabled: !(reasoning && reasoning.efforts && reasoning.efforts.length) },
							React.createElement("option", { value: "" }, "(模型默认)"),
							(reasoning && reasoning.efforts ? reasoning.efforts : []).map((e) => React.createElement("option", { key: e.id, value: e.id }, e.name + " (" + e.id + ")" + (reasoning.defaultEffort === e.id ? " — 默认" : "")))
						)
					),
					reasoning && reasoning.error
						? React.createElement("div", { className: "qqb-dim qqb-warn" }, "推理等级查询失败: " + reasoning.error)
						: null,
					models && models.current
						? React.createElement("div", { className: "qqb-dim" }, "Harness 当前默认: " + models.current.provider + " / " + models.current.model)
						: null,
					models && models.failures && models.failures.length
						? React.createElement("div", { className: "qqb-dim qqb-warn" }, "部分 provider 查询失败: " + models.failures.map((f) => f.provider).join(", "))
						: null,
					(!models || !models.groups || !models.groups.length) && !(models && models.failures && models.failures.length)
						? React.createElement("div", { className: "qqb-dim" }, "模型列表加载中…")
						: null
				),

				// 连接配置
				React.createElement("div", { className: "qqb-card" },
					React.createElement("h4", { className: "qqb-h" }, "QQ 开放平台连接"),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "开放平台"),
						React.createElement("a", { className: "qqb-link", href: "https://q.qq.com/qqbot/openclaw/index.html", target: "_blank", rel: "noreferrer" }, "打开 q.qq.com 机器人控制台 ↗")
					),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "AppID"),
						React.createElement("input", { className: "qqb-input", value: appId, onChange: (e) => setAppId(e.target.value), placeholder: "在 q.qq.com 机器人设置页复制" })
					),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "AppSecret"),
						React.createElement("input", { className: "qqb-input", type: "password", value: appSecret, onChange: (e) => setAppSecret(e.target.value), placeholder: cfg && cfg.secretMasked ? "已保存: " + cfg.secretMasked + " (留空保持不变)" : "在 q.qq.com 复制" })
					),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "沙箱模式"),
						React.createElement("input", { type: "checkbox", checked: sandbox, onChange: (e) => setSandbox(e.target.checked) }),
						React.createElement("span", { className: "qqb-dim" }, "  新机器人默认沙箱; 上架后取消勾选")
					),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "工作目录"),
						React.createElement("input", { className: "qqb-input", value: workspaceCwd, onChange: (e) => setWorkspaceCwd(e.target.value), placeholder: "新建 DSH 会话的工作目录" })
					),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "随 DSH 自动启动"),
						React.createElement("input", { type: "checkbox", checked: autoStart, onChange: (e) => setAutoStart(e.target.checked) }),
						React.createElement("span", { className: "qqb-dim" }, "  插件加载时自动拉起桥接; 桥接异常退出会自动重启")
					),
					React.createElement("div", { className: "qqb-row qqb-actions" },
						React.createElement("button", { className: "qqb-btn qqb-primary", disabled: busy, onClick: onSave }, "保存配置")
					),
					msg ? React.createElement("div", { className: msg.kind === "ok" ? "qqb-ok" : "qqb-err" }, msg.text) : null
				),

				// 系统 (开机自启 / 关窗保活)
				React.createElement("div", { className: "qqb-card" },
					React.createElement("h4", { className: "qqb-h" }, "系统 (开机自启 / 后台保活)"),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "开机自启"),
						React.createElement("input", { type: "checkbox", checked: bootAutoStart, onChange: (e) => setBootAutoStart(e.target.checked) }),
						React.createElement("span", { className: "qqb-dim" }, "  登录 Windows 后后台自动启动 DSH 与桥接 (隐藏窗口, 不弹界面)")
					),
					React.createElement("div", { className: "qqb-row" },
						React.createElement("label", { className: "qqb-label" }, "关窗保活"),
						React.createElement("input", { type: "checkbox", checked: keepAliveAfterClose, onChange: (e) => setKeepAliveAfterClose(e.target.checked) }),
						React.createElement("span", { className: "qqb-dim" }, "  关闭 DSH 桌面窗口后, 后端与桥接仍在后台运行")
					),
					React.createElement("div", { className: "qqb-dim" }, "  两个开关都开启: 开机即可用 QQ 机器人聊天, 无需打开任何窗口。"),
					React.createElement("div", { className: "qqb-dim" }, "  注: 更改「关窗保活」后需重启一次 DSH 桌面版窗口才完全生效; 浏览器标签页关闭本就不影响桥接。")
				),

				// 日志
				React.createElement("div", { className: "qqb-card" },
					React.createElement("h4", { className: "qqb-h" }, "桥接日志 (最近 " + logs.length + " 条)"),
					React.createElement("pre", { className: "qqb-logs" },
						logs.length ? logs.map((l) => l.stream === "stderr" ? "! " + l.text : l.text).join("\n") : "(暂无日志 — 启动桥接后显示)"
					)
				)
			);
		}

		// ---------- 客户端插件主体 ----------
		const inject = ["slots"];

		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "qq-bridge", order: 30, label: "QQ 机器人" },
				() => React.createElement(QQBridgePanel, {})
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
