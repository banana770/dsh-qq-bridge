// main.js — dsh-qq-bridge 入口: 把 QQ 官方机器人的消息桥接到 DeepSeek Harness (dsh web)。
// 每个聊天对象 (私聊用户 / 群成员) 对应一个 DSH 会话, 回复经 events.mux 流式收集后发回 QQ。

import { readFileSync } from "node:fs";
import { QQClient } from "./qq.js";
import { DSHClient, extractText } from "./dsh.js";
import { makeLogger, makeRecentSet, sleep } from "./util.js";

// ---------- 配置 ----------

function loadConfig() {
  const raw = readFileSync(new URL("../config.json", import.meta.url), "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg.qq?.appId || !cfg.qq?.appSecret || cfg.qq.appSecret.startsWith("在 q.qq.com")) {
    throw new Error("config.json 缺少 qq.appId / qq.appSecret, 请先在 q.qq.com 机器人设置页复制并填入");
  }
  if (!cfg.dsh?.baseUrl) throw new Error("config.json 缺少 dsh.baseUrl");
  return cfg;
}

// ---------- 工具 ----------

/** 按 QQ 单条消息长度限制切分长文本 (优先在换行/空格处断开)。 */
function chunkLong(text, max) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** 群消息去掉 @机器人 前缀 (QQ 官方内容里 mention 可能带 @ 或直接是机器人名)。 */
function stripMention(content, botUsername) {
  let text = (content ?? "").trim();
  // 去掉形如 <@!123456> 的内联 mention token
  text = text.replace(/<@!?\d+>/g, "").trim();
  if (text.startsWith("@")) {
    text = text.replace(/^@\S+\s*/, "").trim();
  } else if (botUsername && text.startsWith(botUsername)) {
    text = text.slice(botUsername.length).trim();
  }
  return text;
}

// ---------- 主逻辑 ----------

async function main() {
  const cfg = loadConfig();
  const log = makeLogger(cfg.bridge?.logLevel ?? "info");
  const startedAt = Date.now();

  log.info("========== dsh-qq-bridge 启动 ==========");
  log.info(
    `DSH 目标: ${cfg.dsh.baseUrl}  |  QQ appId: ${cfg.qq.appId}  |  sandbox: ${cfg.qq.sandbox}`,
  );
  log.info(
    `聊天模式: ${cfg.dsh?.agentPreset || "(默认)"}  |  模型: ${cfg.dsh?.model?.provider ?? "-"}/${cfg.dsh?.model?.model ?? "-"}` +
      (cfg.dsh?.model?.reasoningEffort ? `  |  推理等级: ${cfg.dsh.model.reasoningEffort}` : ""),
  );

  const dsh = new DSHClient(cfg.dsh, log);
  const qq = new QQClient(cfg.qq, log);

  await dsh.loadMapping();
  await dsh.applyModelToExisting();

  // 会话ID -> 反查聊天对象 (每个 peer 独占一个会话, 1:1)
  const sessionToPeer = new Map();
  for (const [peerKey, sessionId] of dsh.map) sessionToPeer.set(sessionId, peerKey);

  // 进行中的轮次: sessionId -> { targets:[{kind,id}], texts:[], turn }
  const activeTurns = new Map();
  // 待回答的问题: sessionId -> { rpcId, questions }
  const pendingQuestions = new Map();
  const seenMsgIds = makeRecentSet(800);

  // ---------- 发回复到 QQ ----------

  async function replyToTargets(targets, text) {
    const chunks = chunkLong(text, cfg.bridge?.maxReplyChars ?? 1800);
    for (const target of targets) {
      try {
        for (const chunk of chunks) {
          if (target.kind === "c2c") await qq.sendC2C(target.id, chunk);
          else if (target.kind === "group") await qq.sendGroup(target.id, chunk);
          await sleep(200);
        }
      } catch (err) {
        log.error(`回复 ${target.kind}:${target.id} 失败: ${err.message}`);
      }
    }
  }

  function targetLabel(target) {
    return target.kind === "c2c" ? `私聊 ${target.id.slice(0, 10)}…` : `群 ${target.id.slice(0, 10)}…`;
  }

  // ---------- DSH 下行流 (mux) ----------

  dsh.on("frame", (frame, envelope) => {
    switch (frame?.type) {
      case "session/event": {
        const { sessionId, event } = frame;
        const turn = activeTurns.get(sessionId);
        if (!turn) return;
        switch (event?.type) {
          case "assistant/message": {
            const text = extractText(event.data?.message?.content);
            if (text) {
              turn.texts.push(text);
              log.debug(`[${sessionId}] assistant/message (+${text.length} 字符)`);
            }
            break;
          }
          case "turn/end": {
            activeTurns.delete(sessionId);
            const reason = event.data?.reason;
            const body = turn.texts.join("\n").trim();
            log.info(
              `[${sessionId}] 轮次结束 (${reason?.kind}) 文本 ${body.length} 字符 -> ${turn.targets.map(targetLabel).join(", ")}`,
            );
            if (body) {
              void replyToTargets(turn.targets, body);
            } else if (reason?.kind === "error") {
              void replyToTargets(turn.targets, `⚠️ 本轮出错: ${reason.error?.message ?? "未知错误"}`);
            }
            break;
          }
        }
        break;
      }
      case "question/requested": {
        const { sessionId, questions } = frame;
        const turn = activeTurns.get(sessionId);
        const peerKey = sessionToPeer.get(sessionId);
        if (!turn && !peerKey) return; // 与本桥无关的会话
        const targets = turn?.targets ?? (peerKey ? [targetFromPeerKey(peerKey)] : []);
        if (!targets.length) return;
        pendingQuestions.set(sessionId, { rpcId: envelope?.rpcId, questions });
        log.info(`[${sessionId}] DSH 提问 -> ${targets.map(targetLabel).join(", ")}`);
        void forwardQuestion(targets, questions);
        break;
      }
      case "stream/error": {
        log.error(`DSH 流错误: ${frame.error?.code} ${frame.error?.message}`);
        break;
      }
      default:
        log.debug(`mux 帧: ${frame?.type}`);
    }
  });

  async function forwardQuestion(targets, questions) {
    if (!Array.isArray(questions) || questions.length === 0) return;
    const lines = questions.map((q, i) => {
      let s = `${i + 1}. ${q.question}`;
      if (q.detail) s += `\n   ${q.detail}`;
      if (Array.isArray(q.options) && q.options.length) {
        s += "\n   " + q.options.map((o, j) => `${j + 1}) ${o.label}`).join("  ");
      }
      return s;
    });
    const tip =
      questions.length === 1 && questions[0]?.options?.length
        ? "\n(直接回复选项编号即可)"
        : "\n(直接回复你的答案即可)";
    await replyToTargets(targets, "❓ " + lines.join("\n") + tip);
  }

  function targetFromPeerKey(peerKey) {
    if (peerKey.startsWith("c2c:")) return { kind: "c2c", id: peerKey.slice(4) };
    if (peerKey.startsWith("group:")) {
      const [, groupOpenid] = peerKey.split(":");
      return { kind: "group", id: groupOpenid };
    }
    return null;
  }

  // ---------- 命令 ----------

  async function handleCommand(peerKey, text, targets) {
    const sessionId = dsh.map.get(peerKey);
    const cmd = text.split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case "/help":
        await replyToTargets(
          targets,
          [
            "🤖 dsh-qq-bridge 命令:",
            "/help — 本帮助",
            "/status — 会话状态",
            "/cancel — 中止当前轮次",
            "/reset — 开启全新会话(清空本聊天上下文)",
            "/compact — 手动压缩当前对话 (上下文满时 DSH 会自动压缩, 一般无需手动)",
            "其他消息直接发给 DSH 智能体, 群聊需 @机器人",
          ].join("\n"),
        );
        return true;
      case "/status": {
        const up = Math.round((Date.now() - startedAt) / 1000);
        const lines = [
          `已运行 ${up}s, 会话数 ${dsh.map.size}`,
          `peer: ${peerKey}`,
          sessionId ? `DSH 会话: ${sessionId}` : "DSH 会话: (尚未创建)",
          `QQ 网关: ${qq.identifySucceeded ? "已连接" : "未连接"}`,
        ];
        await replyToTargets(targets, lines.join("\n"));
        return true;
      }
      case "/cancel":
        if (sessionId) {
          await dsh.cancel(sessionId);
          activeTurns.delete(sessionId);
          pendingQuestions.delete(sessionId);
          await replyToTargets(targets, "已发送取消请求。");
        } else {
          await replyToTargets(targets, "当前没有活动会话。");
        }
        return true;
      case "/compact": {
        const sid = dsh.map.get(peerKey);
        if (!sid) {
          await replyToTargets(targets, "当前还没有对话, 先发一条消息再压缩。");
          return true;
        }
        try {
          const value = await dsh.compact(sid);
          const outcome = value && value.result;
          if (outcome && outcome.kind === "success") {
            await replyToTargets(targets, `✅ ${outcome.text || "压缩完成。"}`);
          } else {
            await replyToTargets(targets, `⚠️ ${(outcome && outcome.text) || "压缩命令未能执行成功。"}`);
          }
        } catch (err) {
          log.error(`[${peerKey}] 手动压缩失败: ${err.message}`);
          await replyToTargets(targets, `⚠️ 压缩失败: ${err.message}`);
        }
        return true;
      }
      case "/reset": {
        if (sessionId) sessionToPeer.delete(sessionId);
        dsh.map.delete(peerKey);
        await dsh.saveMapping();
        activeTurns.delete(sessionId);
        pendingQuestions.delete(sessionId);
        log.info(`[${peerKey}] 重置会话`);
        await replyToTargets(targets, "已重置, 下一次消息将创建全新 DSH 会话。");
        return true;
      }
      default:
        await replyToTargets(targets, "未知命令, 输入 /help 查看可用命令。");
        return true;
    }
  }

  // ---------- QQ 事件 ----------

  qq.on("event", ({ type, data }) => {
    try {
      if (type === "C2C_MESSAGE_CREATE") {
        const openid = data?.author?.user_openid;
        const content = data?.content ?? "";
        if (!openid || !content.trim()) return;
        if (seenMsgIds.has(data.msg_id)) return;
        seenMsgIds.add(data.msg_id);
        const peerKey = `c2c:${openid}`;
        const targets = [{ kind: "c2c", id: openid }];
        log.info(`C2C 消息 ${data.msg_id} 来自 ${openid}: ${content.slice(0, 60)}`);
        void onIncoming(peerKey, content.trim(), targets, sessionToPeer);
      } else if (type === "GROUP_AT_MESSAGE_CREATE") {
        const groupOpenid = data?.group_openid;
        const memberOpenid = data?.author?.member_openid;
        const raw = data?.content ?? "";
        if (!groupOpenid || !memberOpenid) return;
        if (seenMsgIds.has(data.msg_id)) return;
        seenMsgIds.add(data.msg_id);
        const content = stripMention(raw, qq.botUsername);
        if (!content) return; // 只 @ 了机器人没说话
        const peerKey = `group:${groupOpenid}:${memberOpenid}`;
        const targets = [{ kind: "group", id: groupOpenid }];
        log.info(`群@消息 ${data.msg_id} 群=${groupOpenid.slice(0, 10)}… 成员=${memberOpenid.slice(0, 10)}… : ${content.slice(0, 60)}`);
        void onIncoming(peerKey, content, targets, sessionToPeer);
      } else {
        log.debug(`其他 QQ 事件: ${type}`);
      }
    } catch (err) {
      log.error(`处理 QQ 事件 ${type} 出错: ${err.message}`);
    }
  });

  async function onIncoming(peerKey, text, targets, sessionToPeerRef) {
    // 命令优先
    if (text.startsWith("/")) {
      await handleCommand(peerKey, text, targets);
      return;
    }
    try {
      const sessionId = dsh.map.get(peerKey) ?? (await dsh.ensureSession(peerKey));
      sessionToPeerRef.set(sessionId, peerKey);

      // 有待回答的问题 → 先作答
      const pending = pendingQuestions.get(sessionId);
      if (pending) {
        pendingQuestions.delete(sessionId);
        const answers = parseQuestionAnswer(text, pending.questions);
        try {
          await dsh.answerQuestion(pending.rpcId, sessionId, answers);
          await replyToTargets(targets, "✅ 已收到你的回答, 智能体继续处理中…");
        } catch (err) {
          log.error(`回答问题失败: ${err.message}`);
          await replyToTargets(targets, "⚠️ 提交回答失败, 请稍后重试或发送 /cancel。");
        }
        return;
      }

      // 普通消息 → 入队给 DSH
      await dsh.prompt(peerKey, text);
      if (!activeTurns.has(sessionId)) {
        activeTurns.set(sessionId, { targets, texts: [], turn: 0 });
      } else {
        // 上一轮还在跑: DSH 已排队, 这里补记回复目标
        activeTurns.get(sessionId).targets = targets;
      }
      log.info(`[${peerKey}] 已入队给 DSH 会话 ${sessionId}`);
    } catch (err) {
      log.error(`[${peerKey}] 转发失败: ${err.message}`);
      const hint = err.message.includes("fetch") || err.message.includes("ECONN")
        ? "DSH (DeepSeek Harness) 似乎没有在运行, 请先启动 dsh web。"
        : `DSH 调用失败: ${err.message}`;
      await replyToTargets(targets, "⚠️ " + hint);
    }
  }

  // ---------- 问题应答解析 ----------

  function parseQuestionAnswer(text, questions) {
    return questions.map((q, i) => {
      const options = q.options ?? [];
      // 整段回复是数字/逗号分隔数字 → 选对应选项
      if (options.length && /^[\d,\s，]+$/.test(text)) {
        const nums = text.split(/[,，\s]+/).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= options.length);
        if (nums.length) {
          return { id: q.id, selected: [...new Set(nums.map((n) => options[n - 1].label))] };
        }
      }
      // 其他情况: 全文本作为自定义回答 (单选项时若文本等于某选项 label 也算选中)
      const exact = options.find((o) => o.label === text.trim());
      if (exact) return { id: q.id, selected: [exact.label] };
      return { id: q.id, selected: [], custom: text.trim() };
    });
  }

  // ---------- 启动 ----------

  // 启动下行流 + QQ 网关
  void dsh.openMux();
  await qq.start();
  log.info("========== 桥接已就绪: QQ <-> DSH ==========");

  // 优雅退出
  const shutdown = async () => {
    log.info("收到退出信号, 正在关闭…");
    await qq.stop();
    await dsh.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
