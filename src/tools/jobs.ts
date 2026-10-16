import { nextCron, parseCron, validTimezone } from "../cron";
import type { JobRow } from "../memory/store";
import type { Tool, ToolContext } from "../types";
import { truncate } from "../util";
import { rateValue } from "./info";

const DAY = 86_400_000;

const fmtLocal = (t: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(t);

function checkQuota(ctx: ToolContext) {
  if (ctx.store.countActiveJobs(ctx.userId) >= ctx.config.MAX_JOBS_PER_USER && ctx.level !== "admin") throw new Error(`You already have ${ctx.config.MAX_JOBS_PER_USER} active scheduled items; cancel one first`);
}

/** Resolve "when" from in_seconds / at / cron. Returns first due time and the cron (if recurring). */
function resolveWhen(a: { in_seconds?: number; at?: string; cron?: string; timezone?: string }, ctx: ToolContext): { dueAt: number; cron: string | null; tz: string } {
  const tz = a.timezone ?? ctx.config.TIMEZONE!;
  if (!validTimezone(tz)) throw new Error(`Unknown time zone "${tz}"`);
  if (a.cron) {
    const spec = parseCron(a.cron);
    return { dueAt: nextCron(spec, Date.now(), tz), cron: spec.expr, tz };
  }
  let due: number;
  if (typeof a.in_seconds === "number") due = Date.now() + a.in_seconds * 1000;
  else if (a.at) {
    due = Date.parse(a.at);
    if (!Number.isFinite(due)) throw new Error("Invalid 'at' time; use ISO 8601 with a UTC offset, e.g. 2026-10-13T09:00:00+03:30");
  } else throw new Error("Provide in_seconds, at, or cron");
  if (due < Date.now() - 5000) throw new Error("That time is in the past");
  if (due > Date.now() + 366 * DAY) throw new Error("At most 1 year ahead");
  return { dueAt: due, cron: null, tz };
}

const whenProps = {
  in_seconds: { type: "integer", description: "run once after N seconds" },
  at: { type: "string", description: "run once at an absolute time: ISO 8601 WITH offset (compute from the current time in the context)" },
  cron: { type: "string", description: "recurring: 5-field cron 'min hour day-of-month month day-of-week' in the given time zone, e.g. '0 8 * * *' = every day 08:00, '30 9 * * 1-5' = weekdays 09:30" },
  timezone: { type: "string", description: "IANA zone for cron (default: the bot's zone)" },
};

export const setReminder: Tool = {
  name: "set_reminder",
  description: "Send the user a reminder message in this chat. One-off (in_seconds / at) or recurring (cron).",
  level: "public",
  parameters: { type: "object", properties: { text: { type: "string", description: "what to remind about" }, ...whenProps }, required: ["text"] },
  async run(a, ctx) {
    checkQuota(ctx);
    const w = resolveWhen(a, ctx);
    const id = ctx.store.addJob({ chatId: ctx.chatId, userId: ctx.userId, chatType: ctx.chatType, kind: "reminder", text: truncate(a.text, 500), cron: w.cron, tz: w.tz, dueAt: w.dueAt, maxRuns: w.cron ? null : 1 });
    return { id, recurring: !!w.cron, next_run_iso: new Date(w.dueAt).toISOString(), next_run_local: fmtLocal(w.dueAt, w.tz) };
  },
};

export const scheduleTask: Tool = {
  name: "schedule_task",
  description:
    "Schedule work for later. kind='prompt': at the time SOL itself runs the instruction (searches, price lookups, summaries...) and sends the result to this chat - e.g. a daily 08:00 report 'قیمت دلار و طلا و بیت‌کوین رو بفرست'. kind='reminder': just sends the text. Use cron for recurring.",
  level: "trusted",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "for prompt: the full self-contained instruction to execute; for reminder: the message" },
      kind: { type: "string", enum: ["prompt", "reminder"] },
      max_runs: { type: "integer", description: "stop after N runs (optional)" },
      ...whenProps,
    },
    required: ["text", "kind"],
  },
  async run(a, ctx) {
    checkQuota(ctx);
    const w = resolveWhen(a, ctx);
    if (w.cron && a.kind === "prompt" && ctx.level !== "admin") {
      const spec = parseCron(w.cron);
      const second = nextCron(spec, w.dueAt, w.tz);
      if (second - w.dueAt < 10 * 60_000) throw new Error("Scheduled prompts may run at most once every 10 minutes");
    }
    const id = ctx.store.addJob({
      chatId: ctx.chatId, userId: ctx.userId, chatType: ctx.chatType, kind: a.kind, text: truncate(a.text, 2000), cron: w.cron, tz: w.tz, dueAt: w.dueAt,
      maxRuns: a.max_runs ?? (w.cron ? null : 1),
    });
    return { id, kind: a.kind, recurring: !!w.cron, next_run_iso: new Date(w.dueAt).toISOString(), next_run_local: fmtLocal(w.dueAt, w.tz) };
  },
};

export const backgroundTask: Tool = {
  name: "background_task",
  description: "Do a long job in the background (deep research, many searches, analysis) and send the result to this chat when finished. Use when the user says 'go research X and report back' or it would take many steps. Optional delay.",
  level: "trusted",
  parameters: {
    type: "object",
    properties: { task: { type: "string", description: "complete, self-contained instruction (include all details from the conversation that are needed)" }, delay_minutes: { type: "integer", description: "start after N minutes (default: now)" } },
    required: ["task"],
  },
  async run({ task, delay_minutes }, ctx) {
    if (ctx.unattended) throw new Error("A background task cannot start another background task");
    const running = ctx.store.listJobs(ctx.userId, ["prompt"]).filter((j) => j.max_runs === 1 && !j.cron).length;
    if (running >= 3 && ctx.level !== "admin") throw new Error("You already have 3 pending background tasks");
    checkQuota(ctx);
    const due = Date.now() + Math.min(Math.max(delay_minutes ?? 0, 0), 7 * 24 * 60) * 60_000;
    const id = ctx.store.addJob({ chatId: ctx.chatId, userId: ctx.userId, chatType: ctx.chatType, kind: "prompt", text: truncate(task, 3000), dueAt: due, maxRuns: 1, tz: ctx.config.TIMEZONE });
    return { id, starts: new Date(due).toISOString(), note: "I will send the result here when it is ready." };
  },
};

export const setPriceAlert: Tool = {
  name: "set_price_alert",
  description:
    "Notify the user in this chat when a price crosses a level. Iran market (usd, eur, gold18, coin...) is in Toman; global (btc, eth, xau, fiat codes) in USD. Checked every few minutes.",
  level: "public",
  parameters: {
    type: "object",
    properties: {
      asset: { type: "string", description: "e.g. usd, gold18, coin, btc, xau" },
      market: { type: "string", enum: ["iran", "global"] },
      direction: { type: "string", enum: ["above", "below"] },
      value: { type: "number", description: "threshold in the market's unit (Toman for iran, USD for global)" },
      repeat: { type: "boolean", description: "keep alerting (at most once per hour) instead of stopping after the first alert" },
      days: { type: "integer", description: "expire after N days (default 30, max 90)" },
    },
    required: ["asset", "direction", "value"],
  },
  async run(a, ctx) {
    const active = ctx.store.listJobs(ctx.userId, ["alert"]).length;
    if (active >= 10 && ctx.level !== "admin") throw new Error("You already have 10 active price alerts");
    checkQuota(ctx);
    const cur = await rateValue(a.asset, a.market, ctx.config); // validates the asset and gives the current price
    const days = Math.min(Math.max(a.days ?? 30, 1), 90);
    const id = ctx.store.addJob({
      chatId: ctx.chatId, userId: ctx.userId, chatType: ctx.chatType, kind: "alert", text: `${cur.asset} ${a.direction} ${a.value}`,
      payload: { asset: cur.asset, market: cur.market, op: a.direction, value: a.value, repeat: !!a.repeat, unit: cur.unit },
      dueAt: Date.now() + ctx.config.ALERT_INTERVAL_MIN * 60_000, expiresAt: Date.now() + days * DAY,
    });
    return { id, current_price: cur.value, unit: cur.unit, alert: `${a.direction} ${a.value}`, expires_in_days: days };
  },
};

const describe = (j: JobRow) => ({
  id: j.id, kind: j.kind, text: truncate(j.text, 160), recurring: j.cron ?? undefined,
  next_run: j.kind === "alert" ? "checked periodically" : new Date(j.due_at).toISOString(), runs: j.runs,
});

export const listTasks: Tool = {
  name: "list_tasks",
  description: "List the user's active reminders, scheduled tasks, background tasks and price alerts.",
  level: "public",
  parameters: { type: "object", properties: {} },
  async run(_a, ctx) { return ctx.store.listJobs(ctx.userId).map(describe); },
};

export const cancelTask: Tool = {
  name: "cancel_task",
  description: "Cancel a reminder / scheduled task / price alert by id.",
  level: "public",
  parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  async run({ id }, ctx) { return { cancelled: ctx.store.cancelJob(id, ctx.userId, ctx.level === "admin") }; },
};

export const jobTools: Tool[] = [setReminder, scheduleTask, backgroundTask, setPriceAlert, listTasks, cancelTask];
