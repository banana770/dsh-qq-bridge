// selftest.js — 不依赖 QQ, 单独验证 DSH 侧完整链路:
//   session.create -> session.prompt -> events.mux 流式收到 assistant/message -> turn/end
// 用法: node src/selftest.js
// 退出码: 0 = 成功, 1 = 失败/超时

import { readFileSync } from "node:fs";
import { DSHClient, extractText } from "./dsh.js";
import { makeLogger } from "./util.js";

const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const log = makeLogger("info");

const peerKey = `selftest:${Date.now()}`;
const dsh = new DSHClient(cfg.dsh, log);

log.info("=== DSH 自检开始 ===");

try {
  await dsh.loadMapping();
  const sessionId = await dsh.ensureSession(peerKey);
  log.info(`自检会话: ${sessionId}`);

  const received = [];
  // 先挂监听与超时, 再连 mux, 再发 prompt (避免竞态)
  const done = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, reason: "超时(120s)" }), 120000);
    t.unref?.();

    dsh.on("frame", (frame) => {
      if (frame?.type !== "session/event" || frame.sessionId !== sessionId) return;
      const ev = frame.event;
      if (ev?.type === "assistant/message") {
        const text = extractText(ev.data?.message?.content);
        if (text) received.push(text);
      } else if (ev?.type === "turn/end") {
        clearTimeout(t);
        resolve({ ok: true, reason: ev.data?.reason });
      } else if (ev?.type === "turn/start") {
        log.info("轮次开始, 等待模型回复…");
      }
    });
  });

  // openMux 是常驻重连循环: 连接成功时阻塞, 断开才 resolve —— 不能 await, 等 'open' 事件即可
  const opened = new Promise((resolve) => dsh.once("open", resolve));
  void dsh.openMux();
  await opened;
  log.info("mux 已连接, 发送 prompt…");

  await dsh.prompt(peerKey, "请只回复两个字符: OK");

  const result = await done;
  const body = received.join("\n").trim();
  if (result.ok && body.includes("OK")) {
    log.info(`✅ 自检通过: 收到模型回复 "${body}" (轮次结束: ${result.reason?.kind})`);
    // 清理自检会话映射
    dsh.map.delete(peerKey);
    await dsh.saveMapping();
    log.info("已清理自检会话映射");
    process.exit(0);
  } else {
    log.error(`❌ 自检失败: ok=${result.ok} reason=${JSON.stringify(result.reason)} 文本=${JSON.stringify(body)}`);
    process.exit(1);
  }
} catch (err) {
  log.error(`❌ 自检异常: ${err.message}`);
  process.exit(1);
}
