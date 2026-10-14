import type { Api } from "grammy";
import type { Progress } from "./agent";
import { log } from "./log";
import { chunkText, mdToHtml, truncate } from "./util";

const LABELS: Record<string, string> = {
  web_search: "🔎 دارم تو وب جستجو می‌کنم…", web_fetch: "🌐 دارم صفحه رو می‌خونم…", browse: "🌐 دارم صفحه رو باز می‌کنم…", wikipedia: "📚 دارم ویکی‌پدیا رو می‌گردم…",
  get_rates: "💱 دارم قیمت‌ها رو می‌گیرم…", digikala_search: "🛒 دارم دیجی‌کالا رو می‌گردم…", download_media: "⬇️ دارم دانلود می‌کنم…", edit_gif: "🎞 دارم گیف رو ادیت می‌کنم…",
  generate_image: "🎨 دارم تصویر می‌سازم…", run_python: "🐍 دارم کد رو اجرا می‌کنم…", run_shell: "💻 دارم دستور رو اجرا می‌کنم…", read_document: "📄 دارم سند رو می‌خونم…",
  ocr_image: "👁 دارم عکس رو می‌خونم…", create_document: "📝 دارم سند می‌سازم…", create_spreadsheet: "📊 دارم جدول می‌سازم…", speak: "🎙 دارم صدا می‌سازم…",
  github: "🐙 دارم با گیت‌هاب کار می‌کنم…", virustotal_scan: "🛡 دارم اسکن می‌کنم…", recall: "🧠 دارم یادآوری می‌کنم…", summarize_group: "📋 دارم گروه رو مرور می‌کنم…",
  background_task: "🗂 دارم کار پس‌زمینه رو ثبت می‌کنم…", schedule_task: "⏰ دارم زمان‌بندی می‌کنم…", set_price_alert: "🔔 دارم هشدار قیمت می‌ذارم…",
};
export const toolLabel = (name: string) => LABELS[name] ?? "🛠 دارم کار می‌کنم…";

export interface LiveOptions {
  replyTo?: number;
  enabled: boolean;
  /** Show the model's text as it arrives (private chats). Otherwise only a status line is shown. */
  streamText: boolean;
  redact: (s: string) => string;
  /** First placeholder appears only after this delay, so quick answers never flicker. */
  delayMs?: number;
  /** Minimum gap between edits (Telegram rate limits). */
  editIntervalMs?: number;
}

/** One reply message that is created lazily, updated while the agent works, and replaced by the final answer. */
export class LiveReply {
  private msgId?: number;
  private pending: string | null = null;
  private lastText = "";
  private lastEdit = 0;
  private firstSeen = 0;
  private running = false;
  private closed = false;
  private ops: Promise<void> = Promise.resolve();
  private wake?: () => void;
  constructor(private api: Api, private chatId: number, private o: LiveOptions) {}

  progress(e: Progress) {
    if (!this.o.enabled || this.closed) return;
    if (e.type === "tool") this.show(toolLabel(e.name));
    else if (this.o.streamText && e.text.trim()) this.show(truncate(e.text, 3800) + " ▍");
  }

  private show(text: string) {
    if (!this.firstSeen) this.firstSeen = Date.now();
    this.pending = text;
    this.kick();
  }

  private kick() {
    if (this.running) return;
    this.running = true;
    this.ops = this.ops.then(async () => {
      try {
        while (!this.closed && this.pending !== null) {
          const wait = this.msgId ? this.lastEdit + (this.o.editIntervalMs ?? 1100) - Date.now() : this.firstSeen + (this.o.delayMs ?? 800) - Date.now();
          if (wait > 0) await this.nap(wait);
          if (this.closed) break;
          const text = this.pending;
          this.pending = null;
          if (text === null || text === this.lastText) continue;
          await this.push(text);
        }
      } finally {
        this.running = false;
      }
    });
  }

  /** Sleep that finish()/abort() can interrupt, so a fast answer never waits for the throttle timer. */
  private nap(ms: number) {
    return new Promise<void>((res) => {
      const t = setTimeout(() => { this.wake = undefined; res(); }, ms);
      this.wake = () => { clearTimeout(t); this.wake = undefined; res(); };
    });
  }

  private async push(text: string) {
    try {
      if (!this.msgId) {
        const m = await this.api.sendMessage(this.chatId, text, { link_preview_options: { is_disabled: true }, ...(this.o.replyTo ? { reply_parameters: { message_id: this.o.replyTo, allow_sending_without_reply: true } } : {}) });
        this.msgId = m.message_id;
      } else {
        await this.api.editMessageText(this.chatId, this.msgId, text, { link_preview_options: { is_disabled: true } });
      }
      this.lastText = text;
      this.lastEdit = Date.now();
    } catch (e) {
      log.debug("live_edit_failed", { error: e });
      this.lastEdit = Date.now();
    }
  }

  /** Replace the placeholder with the final answer (or send it fresh). */
  async finish(finalText: string, io: { sendText: (chatId: number, text: string, replyTo?: number) => Promise<void> }) {
    this.closed = true;
    this.wake?.();
    await this.ops;
    const text = this.o.redact(finalText);
    const chunks = chunkText(text);
    if (!chunks.length) { await this.abort(); return; }
    let rest = chunks;
    if (this.msgId) {
      const first = chunks[0]!;
      let ok = false;
      try { await this.api.editMessageText(this.chatId, this.msgId, mdToHtml(first), { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); ok = true; }
      catch (e) {
        if (String((e as any)?.description ?? e).includes("not modified")) ok = true;
        else { try { await this.api.editMessageText(this.chatId, this.msgId, first, { link_preview_options: { is_disabled: true } }); ok = true; } catch (e2) { ok = String((e2 as any)?.description ?? e2).includes("not modified"); } }
      }
      if (ok) rest = chunks.slice(1);
      else { await this.abort(); rest = chunks; }
      for (const c of rest) await io.sendText(this.chatId, c);
      return;
    }
    await io.sendText(this.chatId, text, this.o.replyTo);
  }

  /** Remove the placeholder (errors). */
  async abort() {
    this.closed = true;
    this.wake?.();
    await this.ops;
    if (this.msgId) { await this.api.deleteMessage(this.chatId, this.msgId).catch(() => {}); this.msgId = undefined; }
  }
}
