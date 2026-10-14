import type { Api } from "grammy";
import type { Config } from "./config";
import { ownerErrorSummary } from "./llm/errors";
import { addLogSink } from "./log";
import { truncate } from "./util";

/** DM the creator about problems. Deduplicated per key (5 min) and capped per hour so it never becomes spam. */
export function createNotifier(api: Api, config: Config, redact: (s: string) => string) {
  const last = new Map<string, number>();
  const hour: number[] = [];
  return function notifyOwner(key: string, text: string) {
    if (!config.NOTIFY_OWNER || !config.OWNER_ID) return;
    const now = Date.now();
    if (now - (last.get(key) ?? 0) < 5 * 60_000) return;
    while (hour.length && now - hour[0]! > 3600_000) hour.shift();
    if (hour.length >= 12) return;
    last.set(key, now);
    hour.push(now);
    api.sendMessage(config.OWNER_ID, truncate(redact(text), 3500)).catch(() => {});
  };
}

/** Forward every error-level log event to the creator (rate-limited by the notifier). */
export function notifyOnErrors(notify: (key: string, text: string) => void) {
  addLogSink((_line, level, event, fields) => {
    if (level !== "error") return;
    notify(`err:${event}`, truncate(ownerErrorSummary(event, fields.error), 3500));
  });
}
