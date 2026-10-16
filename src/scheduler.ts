import type { Api } from "grammy";
import { runAgent, type AgentDeps } from "./agent";
import { nextCron, parseCron } from "./cron";
import { buildContext, type IO } from "./io";
import { log } from "./log";
import type { JobRow } from "./memory/store";
import { rateValue } from "./tools/info";
import type { LevelOf } from "./types";
import { esc, truncate } from "./util";

export interface SchedulerDeps {
  agent: AgentDeps;
  api: Api;
  io: IO;
  levelOf: LevelOf;
  notifyOwner?: (key: string, text: string) => void;
  /** Override for tests. */
  now?: () => number;
  rate?: typeof rateValue;
}

const MAX_CONCURRENT = 3;

function nextRun(job: JobRow, from: number, defaultTz: string): number | null {
  if (!job.cron) return null;
  try { return nextCron(parseCron(job.cron), from, job.tz ?? defaultTz); } catch { return null; }
}

/** Runs due jobs: reminders, recurring prompts, background tasks and price alerts. Survives restarts (state is in SQLite). */
export function startScheduler(d: SchedulerDeps): { stop: () => void; tick: () => Promise<void> } {
  const { store, config } = d.agent;
  const running = new Set<number>();
  const now = d.now ?? Date.now;
  const rate = d.rate ?? rateValue;
  const priceCache = new Map<string, { t: number; v: { value: number; unit: string } | null }>();

  async function price(asset: string, market: string): Promise<{ value: number; unit: string } | null> {
    const key = `${market}:${asset}`;
    const hit = priceCache.get(key);
    if (hit && now() - hit.t < 60_000) return hit.v;
    let v: { value: number; unit: string } | null = null;
    try { v = await rate(asset, market, config); } catch (e) { log.warn("alert_price_failed", { asset, error: e }); }
    priceCache.set(key, { t: now(), v });
    return v;
  }

  const initFor = (job: JobRow, unattended: boolean) => {
    const u = store.getUser(job.user_id);
    return { userId: job.user_id, chatId: job.chat_id, chatType: job.chat_type, username: u?.username ?? undefined, displayName: u?.first_name ?? "user", level: d.levelOf(job.user_id) as any, levelOf: d.levelOf, unattended };
  };

  async function runJob(job: JobRow) {
    const next = nextRun(job, now(), config.TIMEZONE!);
    const level = d.levelOf(job.user_id);
    try {
      if (level === "banned") { store.finishJob(job.id); return; }
      if (job.kind === "reminder") {
        await d.api.sendMessage(job.chat_id, `⏰ <a href="tg://user?id=${job.user_id}">یادآوری</a>: ${esc(job.text)}`, { parse_mode: "HTML" });
        store.markRun(job.id, next);
      } else if (job.kind === "prompt") {
        const ctx = buildContext(d.agent, d.io, d.api, initFor(job, true));
        const answer = await runAgent(d.agent, ctx, { text: `[scheduled task #${job.id}] ${job.text}`, maxSteps: config.BG_MAX_STEPS });
        store.addMessage(job.chat_id, "assistant", truncate(answer, 4000));
        await d.io.sendText(job.chat_id, answer);
        store.markRun(job.id, next);
      } else if (job.kind === "alert") {
        const p = JSON.parse(job.payload ?? "{}") as { asset: string; market: string; op: "above" | "below"; value: number; repeat?: boolean; unit?: string };
        if (job.expires_at && now() > job.expires_at) { store.finishJob(job.id); return; }
        const cur = await price(p.asset, p.market);
        const hit = cur && (p.op === "above" ? cur.value >= p.value : cur.value <= p.value);
        if (cur && hit) {
          await d.api.sendMessage(job.chat_id, `🔔 ${esc(p.asset)} الان <b>${cur.value.toLocaleString("en-US")}</b> ${esc(cur.unit)} است (${p.op === "above" ? "بالاتر از" : "پایین‌تر از"} ${p.value.toLocaleString("en-US")})`, { parse_mode: "HTML" });
          if (p.repeat) { store.markRun(job.id, now() + 3600_000); } else { store.markRun(job.id, null); }
        } else {
          store.snoozeJob(job.id, now() + config.ALERT_INTERVAL_MIN * 60_000);
        }
      }
    } catch (e) {
      const attempts = store.failJob(job.id, next ?? (job.kind === "alert" ? now() + config.ALERT_INTERVAL_MIN * 60_000 : null));
      log.warn("job_failed", { id: job.id, kind: job.kind, attempts, error: e });
      if (attempts >= 3 && job.kind !== "alert") {
        d.notifyOwner?.(`job:${job.id}`, `⚠️ job #${job.id} (${job.kind}) failed repeatedly: ${e instanceof Error ? e.message : e}`);
        d.api.sendMessage(job.chat_id, `⚠️ نتونستم کار زمان‌بندی‌شده #${job.id} رو انجام بدم: ${truncate(e instanceof Error ? e.message : String(e), 200)}`).catch(() => {});
      }
    }
  }

  async function tick() {
    for (const job of store.dueJobs(now())) {
      if (running.has(job.id) || running.size >= MAX_CONCURRENT) continue;
      running.add(job.id);
      void runJob(job).finally(() => running.delete(job.id));
    }
    while (running.size) await new Promise((r) => setTimeout(r, 5)); // let callers (tests) await completion
  }

  let busy = false;
  const timer = setInterval(() => { if (!busy) { busy = true; void tick().finally(() => (busy = false)); } }, 10_000);
  void tick();
  return { stop: () => clearInterval(timer), tick };
}
