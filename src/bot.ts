import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import { runAgent, spentToday, type AgentDeps } from "./agent";
import { getGroupCfg, isChatAdmin, moderate, welcomeText } from "./groups";
import { buildContext, createIO } from "./io";
import { LiveReply } from "./live";
import { friendlyLlmError } from "./llm/errors";
import { log } from "./log";
import { sttAvailable, transcribe } from "./stt";
import { maybeSummarize } from "./summarizer";
import { buildNameRegex, shouldRespond } from "./triggers";
import { synthesize, ttsProvider } from "./tts";
import { levelRank, type Level, type LevelOf } from "./types";
import { mdToHtml, rid, truncate } from "./util";

const IMG_MAX = 5 * 1024 * 1024;
const DL_MAX = 20 * 1024 * 1024; // Bot API getFile limit
const VOICE_MAX_SECONDS = 300;
const VOICE_REPLY_MAX_CHARS = 1200;
/** Tools that are safe inside inline-mode answers (no files, no chat side effects). */
const INLINE_TOOLS = new Set(["calculate", "get_time", "get_rates", "web_search", "web_fetch", "wikipedia", "digikala_search", "dns_lookup"]);

interface Attachment { file_id: string; kind: string; name: string; size?: number; mime?: string; duration?: number }

function pickAttachment(m: Message): Attachment | null {
  if (m.animation) return { file_id: m.animation.file_id, kind: "animation", name: m.animation.file_name ?? "animation.mp4", size: m.animation.file_size, mime: m.animation.mime_type };
  if (m.video) return { file_id: m.video.file_id, kind: "video", name: m.video.file_name ?? "video.mp4", size: m.video.file_size, mime: m.video.mime_type };
  if (m.photo?.length) { const p = m.photo[m.photo.length - 1]!; return { file_id: p.file_id, kind: "photo", name: "photo.jpg", size: p.file_size, mime: "image/jpeg" }; }
  if (m.document) return { file_id: m.document.file_id, kind: "document", name: m.document.file_name ?? "file", size: m.document.file_size, mime: m.document.mime_type };
  if (m.audio) return { file_id: m.audio.file_id, kind: "audio", name: m.audio.file_name ?? "audio.mp3", size: m.audio.file_size, mime: m.audio.mime_type, duration: m.audio.duration };
  if (m.voice) return { file_id: m.voice.file_id, kind: "voice", name: "voice.ogg", size: m.voice.file_size, mime: m.voice.mime_type, duration: m.voice.duration };
  if (m.video_note) return { file_id: m.video_note.file_id, kind: "video_note", name: "video_note.mp4", size: m.video_note.file_size };
  return null;
}

const safeName = (s: string) => s.replace(/[^\w.\-]+/g, "_").slice(-80) || "file";

export interface CreateBotOptions {
  /** Provide to skip the getMe call (tests / webhook cold starts). */
  botInfo?: UserFromGetMe;
  startedAt?: number;
  mode?: () => string;
  /** Lets the live-reply timing be shortened in tests. */
  live?: { delayMs?: number; editIntervalMs?: number };
}

export function createBot(deps: AgentDeps, opts: CreateBotOptions = {}) {
  const { config, store, redact } = deps;
  const bot = new Bot(config.BOT_TOKEN, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  const io = createIO(bot.api, redact);
  const queues = new Map<number, Promise<void>>();
  const buckets = new Map<number, { count: number; reset: number }>();
  const lastReply = new Map<string, number>(); // `${chat}:${user}` -> ts of our last answer (group follow-ups)
  const pendingInline = new Map<string, { query: string; userId: number; t: number }>();
  const nameRe = buildNameRegex(config.BOT_NAME_LIST);

  // Hierarchy: the creator is always admin and can never be banned. Below that a runtime ban beats every list
  // (so the creator can silence anyone, even an env-configured admin); then admins, trusted, public.
  const levelOf: LevelOf = (id) => {
    if (config.OWNER_ID && id === config.OWNER_ID) return "admin";
    const acl = store.getAcl(id);
    if (acl === "banned") return "banned";
    if (config.ADMIN_IDS.includes(id) || acl === "admin") return "admin";
    if (config.TRUSTED_IDS.includes(id) || acl === "trusted") return "trusted";
    return "public";
  };

  const rateLimited = (id: number): boolean => {
    if (levelOf(id) === "admin") return false;
    const now = Date.now();
    const b = buckets.get(id);
    if (!b || now > b.reset) { buckets.set(id, { count: 1, reset: now + 60_000 }); return false; }
    return ++b.count > config.RATE_LIMIT_PER_MIN;
  };

  const overBudget = (userId: number, level: Level | "banned"): boolean => config.DAILY_BUDGET_USD > 0 && level !== "admin" && spentToday(deps, userId) >= config.DAILY_BUDGET_USD;

  async function downloadAttachment(att: Attachment, workdir: string): Promise<string | null> {
    if (att.size && att.size > DL_MAX) return null;
    const f = await bot.api.getFile(att.file_id);
    if (!f.file_path || (f.file_size && f.file_size > DL_MAX)) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const dir = path.join(workdir, "incoming");
    fs.mkdirSync(dir, { recursive: true });
    const base = safeName(att.name);
    const ext = path.extname(base) || path.extname(f.file_path);
    const rel = path.join("incoming", `${Date.now()}-${path.basename(base, path.extname(base))}${ext}`);
    fs.writeFileSync(path.join(workdir, rel), Buffer.from(await res.arrayBuffer()));
    return rel;
  }

  const ctxFor = (m: Message, level: Level) =>
    buildContext(deps, io, bot.api, {
      userId: m.from!.id, chatId: m.chat.id, chatType: m.chat.type, username: m.from!.username,
      displayName: [m.from!.first_name, m.from!.last_name].filter(Boolean).join(" "), level, levelOf,
      replyTo: m.chat.type === "private" ? undefined : m.message_id,
    });

  // -----------------------------------------------------------------------------------------
  // one conversation turn
  // -----------------------------------------------------------------------------------------
  async function handle(m: Message) {
    const from = m.from!;
    const chatId = m.chat.id;
    const level = levelOf(from.id);
    if (level === "banned") return;
    const me = bot.botInfo;
    const isPrivate = m.chat.type === "private";
    let text = (m.text ?? m.caption ?? "").trim();
    if (me.username) text = text.replace(new RegExp(`@${me.username}`, "ig"), "").trim();

    if (overBudget(from.id, level)) {
      await bot.api.sendMessage(chatId, "سقف مصرف امروزت تموم شده؛ فردا دوباره برمی‌گرده. 🙏", { ...(isPrivate ? {} : { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } }) }).catch(() => {});
      return;
    }

    const ctx = ctxFor(m, level);
    const meta: string[] = [`msg_id:${m.message_id}`, `from:${ctx.displayName}${from.username ? ` @${from.username}` : ""}`, `id:${from.id}`];
    const images: { mime: string; data: string }[] = [];
    const notes: string[] = [];

    const handleMsgMedia = async (src: Message, label: string): Promise<string | null> => {
      const att = pickAttachment(src);
      if (!att) return null;
      try {
        const rel = await downloadAttachment(att, ctx.workdir);
        if (!rel) { notes.push(`[${label} ${att.kind} "${att.name}" was too large to download (>20 MB)]`); return null; }
        notes.push(`[${label} ${att.kind} saved at: ${rel}${att.mime ? ` (${att.mime})` : ""}]`);
        if (att.kind === "photo") {
          const buf = fs.readFileSync(path.join(ctx.workdir, rel));
          if (buf.length <= IMG_MAX) images.push({ mime: att.mime ?? "image/jpeg", data: buf.toString("base64") });
        }
        return rel;
      } catch (e) {
        notes.push(`[${label} ${att.kind} could not be downloaded]`);
        log.warn("attachment_failed", { error: e });
        return null;
      }
    };

    // ---- voice -> text ----
    let voiceIn = false;
    const voice = m.voice ?? m.audio;
    if (voice && !text) {
      if (!sttAvailable(config)) {
        if (isPrivate) await bot.api.sendMessage(chatId, "تبدیل صدا به متن تنظیم نشده (GEMINI_API_KEY یا OPENAI_API_KEY لازمه).").catch(() => {});
        return;
      }
      if ((voice.duration ?? 0) > VOICE_MAX_SECONDS) {
        await bot.api.sendMessage(chatId, "پیام صوتی خیلی طولانیه (حداکثر ۵ دقیقه).", { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } }).catch(() => {});
        return;
      }
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
      const rel = await handleMsgMedia(m, "attachment");
      if (!rel) return;
      try {
        const transcript = await transcribe(config, path.join(ctx.workdir, rel));
        if (!transcript) { await bot.api.sendMessage(chatId, "چیزی از صدا نفهمیدم 🤷").catch(() => {}); return; }
        text = transcript;
        voiceIn = !!m.voice;
        notes.push("[this message was a voice message, transcribed automatically; the transcript above is what the user said]");
      } catch (e) {
        log.warn("stt_failed", { error: e });
        await bot.api.sendMessage(chatId, "نتونستم صدا رو به متن تبدیل کنم. دوباره امتحان کن.").catch(() => {});
        return;
      }
    } else {
      await handleMsgMedia(m, "attachment");
    }

    const r = m.reply_to_message;
    if (r) {
      const rname = r.from ? [r.from.first_name, r.from.last_name].filter(Boolean).join(" ") : "someone";
      meta.push(`reply_to_msg_id:${r.message_id}`);
      if (r.from) meta.push(`reply_to_user:${r.from.id}`);
      const rtext = r.text ?? r.caption;
      if (rtext) notes.push(`[replying to ${rname}: "${truncate(rtext, 600)}"]`);
      await handleMsgMedia(r as Message, "replied-to");
    }
    if (!text && !images.length && !notes.length) return;

    const full = `[${meta.join(" ")}]\n${text || "(no text)"}${notes.length ? "\n" + notes.join("\n") : ""}`;
    const typing = setInterval(() => bot.api.sendChatAction(chatId, "typing").catch(() => {}), 4000);
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
    const live = new LiveReply(bot.api, chatId, {
      enabled: config.STREAMING, streamText: isPrivate, redact, replyTo: isPrivate ? undefined : m.message_id,
      delayMs: opts.live?.delayMs, editIntervalMs: opts.live?.editIntervalMs,
    });
    try {
      const named = isPrivate ? full : `${ctx.displayName}: ${full}`;
      const answer = await runAgent(deps, ctx, { text: named, images, onProgress: (e) => live.progress(e) });
      store.addMessage(chatId, "user", truncate(named, 4000), from.id);
      store.addMessage(chatId, "assistant", truncate(answer, 4000));
      await live.finish(answer, io);
      if (!isPrivate) {
        lastReply.set(`${chatId}:${from.id}`, Date.now());
        if (lastReply.size > 2000) for (const [k, t] of lastReply) if (Date.now() - t > 3600_000) lastReply.delete(k);
        if (getGroupCfg(store, config, chatId).log) store.logGroupMessage(chatId, null, null, config.BOT_NAME!, truncate(answer, 800));
      }
      // spoken answer for spoken questions
      if (voiceIn && config.VOICE_REPLY && ttsProvider(config) && answer.length <= VOICE_REPLY_MAX_CHARS && !answer.includes("```")) {
        try { await io.sendVoice(chatId, await synthesize(config, answer), isPrivate ? undefined : m.message_id); } catch (e) { log.warn("tts_failed", { error: e }); }
      }
      void maybeSummarize(deps, chatId);
    } catch (e) {
      await live.abort();
      log.error("agent_error", { chat: chatId, user: from.id, error: e });
      await bot.api.sendMessage(chatId, `⚠️ ${friendlyLlmError(e)}`).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  const enqueue = (m: Message) => {
    const prev = queues.get(m.chat.id) ?? Promise.resolve();
    const next = prev.then(() => handle(m)).catch((e) => log.error("handler_error", { error: e }));
    queues.set(m.chat.id, next);
    void next.finally(() => { if (queues.get(m.chat.id) === next) queues.delete(m.chat.id); });
  };
  /** Resolves when all queued conversations are finished (tests, graceful shutdown). */
  const background = new Set<Promise<unknown>>();
  const drain = async () => {
    while (queues.size || background.size) await Promise.all([...queues.values(), ...background]);
  };
  const track = (p: Promise<unknown>) => { const q = p.catch((e) => log.error("task_error", { error: e })).finally(() => background.delete(q)); background.add(q); };

  // -----------------------------------------------------------------------------------------
  // entry points
  // -----------------------------------------------------------------------------------------
  // Telegram always sends /start when someone opens the bot; everything else is plain conversation.
  bot.command("start", (c) =>
    c.reply(`سلام! من ${config.BOT_NAME} هستم 👋\nهرچی می‌خوای ساده بگو: قیمت، جستجو، دانلود، ویس، گیف، سند، یادآوری، کد... خودم می‌فهمم چیکار کنم.\nتوی گروه هم کافیه اسمم رو صدا بزنی. هر جا هم می‌تونی با @${bot.botInfo?.username ?? "اسم_من"} سوال بپرسی.`),
  );

  bot.on("message:new_chat_members", async (c) => {
    const cfg = getGroupCfg(store, config, c.chat.id);
    if (!cfg.welcome) return;
    for (const u of c.message.new_chat_members.filter((x) => !x.is_bot).slice(0, 5)) {
      await c.api.sendMessage(c.chat.id, truncate(welcomeText(cfg.welcome, u.first_name, c.chat.title ?? ""), 1000)).catch(() => {});
    }
  });

  async function onMessage(m: Message) {
    if (!m.from || m.from.is_bot) return;
    const isGroup = m.chat.type !== "private";
    const text = m.text ?? m.caption ?? "";
    const level = levelOf(m.from.id);
    if (level === "banned") return;

    if (isGroup && text) {
      const cfg = getGroupCfg(store, config, m.chat.id);
      const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ");
      if (cfg.log) store.logGroupMessage(m.chat.id, m.message_id, m.from.id, name, text);
      if (cfg.mod.enabled) {
        const exempt = level === "admin" || (await isChatAdmin(bot.api, m.chat.id, m.from.id));
        if (await moderate(deps, bot.api, cfg, { chatId: m.chat.id, userId: m.from.id, name, text, msgId: m.message_id, exempt })) return;
      }
    }

    const fu = config.GROUP_FOLLOWUP_SECONDS;
    const followUp = fu > 0 && Date.now() - (lastReply.get(`${m.chat.id}:${m.from.id}`) ?? 0) < fu * 1000;
    const respond = shouldRespond({
      chatType: m.chat.type, text, botUsername: bot.botInfo.username, nameRe,
      replyToBot: m.reply_to_message?.from?.id === bot.botInfo.id, followUp: followUp && !!text,
    });
    if (!respond) return;
    if (!config.PUBLIC_ACCESS && levelRank[level] === 0) {
      if (!isGroup) await bot.api.sendMessage(m.chat.id, "این بات خصوصیه و دسترسی نداری.").catch(() => {});
      return;
    }
    if (rateLimited(m.from.id)) {
      await bot.api.sendMessage(m.chat.id, "آروم‌تر! چند لحظه صبر کن و دوباره بفرست. ⏳").catch(() => {});
      return;
    }
    store.touchUser({ id: m.from.id, username: m.from.username, first_name: m.from.first_name });
    enqueue(m);
  }

  // not awaited on purpose: moderation / long agent runs must not block Telegram update processing
  bot.on("message", (c) => { track(onMessage(c.message as Message)); });

  // ---- inline mode: "@bot question" in any chat ----
  bot.on("inline_query", async (c) => {
    const q = c.inlineQuery.query.trim();
    const level = levelOf(c.from.id);
    if (level === "banned" || (!config.PUBLIC_ACCESS && levelRank[level] === 0)) return c.answerInlineQuery([], { cache_time: 0, is_personal: true });
    if (q.length < 3) {
      return c.answerInlineQuery([{ type: "article", id: "hint", title: `${config.BOT_NAME}: سوالت رو بنویس…`, description: "مثلاً: قیمت دلار؟", input_message_content: { message_text: `من ${config.BOT_NAME} هستم — بعد از اسمم سوالت رو بنویس.` } }], { cache_time: 0, is_personal: true });
    }
    const id = `q${rid(6)}`;
    pendingInline.set(id, { query: q.slice(0, 500), userId: c.from.id, t: Date.now() });
    for (const [k, v] of pendingInline) if (Date.now() - v.t > 10 * 60_000) pendingInline.delete(k);
    return c.answerInlineQuery(
      [{
        type: "article", id, title: `❓ بپرس از ${config.BOT_NAME}`, description: q.slice(0, 100),
        input_message_content: { message_text: `❓ ${q.slice(0, 500)}\n\n⏳ دارم جواب می‌دم…` },
        reply_markup: new InlineKeyboard().text("⏳", "noop"), // a keyboard is required so the message can be edited later
      }],
      { cache_time: 0, is_personal: true },
    );
  });

  bot.on("chosen_inline_result", (c) => {
    const p = pendingInline.get(c.chosenInlineResult.result_id);
    const inlineId = c.chosenInlineResult.inline_message_id;
    if (!p || !inlineId || p.userId !== c.from.id) return;
    pendingInline.delete(c.chosenInlineResult.result_id);
    track((async () => {
      const level = levelOf(c.from.id);
      const edit = async (body: string) => {
        try { await bot.api.editMessageTextInline(inlineId, mdToHtml(truncate(body, 3900)), { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); }
        catch { await bot.api.editMessageTextInline(inlineId, truncate(body, 3900)).catch(() => {}); }
      };
      if (rateLimited(c.from.id)) return edit(`❓ ${p.query}\n\n⏳ زیاد پرسیدی؛ چند لحظه صبر کن.`);
      if (overBudget(c.from.id, level)) return edit(`❓ ${p.query}\n\nسقف مصرف امروزت تموم شده.`);
      const synthetic = -9_000_000_000 - c.from.id; // no shared history with real chats
      const ctx = buildContext(deps, io, bot.api, {
        userId: c.from.id, chatId: synthetic, chatType: "inline", username: c.from.username,
        displayName: [c.from.first_name, c.from.last_name].filter(Boolean).join(" "), level: level === "banned" ? "public" : level, levelOf, unattended: true,
      });
      store.touchUser({ id: c.from.id, username: c.from.username, first_name: c.from.first_name });
      try {
        const answer = await runAgent({ ...deps, tools: deps.tools.filter((t) => INLINE_TOOLS.has(t.name)) }, ctx, { text: `[inline query, answer briefly]\n${p.query}`, maxSteps: 4 });
        await edit(`❓ ${p.query}\n\n${redact(answer)}`);
      } catch (e) {
        log.error("inline_error", { error: e });
        await edit(`❓ ${p.query}\n\n⚠️ نتونستم جواب بدم.`);
      }
    })());
  });

  bot.on("callback_query:data", (c) => c.answerCallbackQuery());
  bot.catch((e) => log.error("bot_error", { error: e.error }));

  /** The bot is conversational: remove any slash-command menu left over from earlier versions. */
  const clearCommandMenus = async () => {
    await bot.api.deleteMyCommands();
    const admins = new Set([...config.ADMIN_IDS, ...(config.OWNER_ID ? [config.OWNER_ID] : [])]);
    for (const id of admins) await bot.api.deleteMyCommands({ scope: { type: "chat", chat_id: id } }).catch(() => {});
  };

  return { bot, drain, levelOf, clearCommandMenus, io, ctxFor, track };
}
