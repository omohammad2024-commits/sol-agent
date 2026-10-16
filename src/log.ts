import fs from "node:fs";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let min = ORDER[process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info")] ?? 20;
let file: string | null = null;
let scrub: (s: string) => string = (s) => s;
const sinks: ((line: string, level: Level, event: string, fields: Record<string, unknown>) => void)[] = [];

export function configureLogger(o: { level?: string; file?: string | null; redact?: (s: string) => string }) {
  if (o.level && ORDER[o.level] !== undefined) min = ORDER[o.level]!;
  if (o.file !== undefined) file = o.file;
  if (o.redact) scrub = o.redact;
}
/** Extra consumers (e.g. owner notifications on errors). */
export function addLogSink(fn: (line: string, level: Level, event: string, fields: Record<string, unknown>) => void) { sinks.push(fn); }

function normalize(v: unknown): unknown {
  if (v instanceof Error) return { message: v.message, stack: v.stack?.split("\n").slice(0, 6).join("\n") };
  return v;
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const print = ORDER[level]! >= min;
  if (!print && ORDER[level]! < ORDER.warn!) return;
  const out: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
  for (const [k, v] of Object.entries(fields)) out[k] = normalize(v);
  let line: string;
  try { line = scrub(JSON.stringify(out)); } catch { line = JSON.stringify({ ts: out.ts, level, event, note: "unserializable fields" }); }
  if (print) (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  if (print && file) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 10 * 1024 * 1024) fs.renameSync(file, file + ".1");
      fs.appendFileSync(file, line + "\n");
    } catch {}
  }
  for (const s of sinks) { try { s(line, level, event, fields); } catch {} }
}

export const log = {
  debug: (e: string, f?: Record<string, unknown>) => emit("debug", e, f),
  info: (e: string, f?: Record<string, unknown>) => emit("info", e, f),
  warn: (e: string, f?: Record<string, unknown>) => emit("warn", e, f),
  error: (e: string, f?: Record<string, unknown>) => emit("error", e, f),
};
