export interface CronSpec { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean; expr: string }

const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function field(src: string, lo: number, hi: number, label: string): { set: Set<number>; star: boolean } {
  const out = new Set<number>();
  const num = (s: string): number => {
    const v = NAMES[s.toLowerCase()] ?? Number(s);
    if (!Number.isInteger(v)) throw new Error(`Invalid cron ${label}: "${s}"`);
    return v;
  };
  for (const part of src.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step in ${label}`);
    let a: number, b: number;
    if (rangePart === "*") { a = lo; b = hi; }
    else if (rangePart!.includes("-")) { const [x, y] = rangePart!.split("-"); a = num(x!); b = num(y!); }
    else { a = num(rangePart!); b = stepPart === undefined ? a : hi; }
    if (a < lo || b > hi || a > b) throw new Error(`Cron ${label} out of range (${lo}-${hi})`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return { set: out, star: src === "*" || src.startsWith("*/") };
}

/** 5-field cron: minute hour day-of-month month day-of-week (0 or 7 = Sunday). Supports *, lists, ranges, steps, names. */
export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("Cron needs 5 fields: minute hour day-of-month month day-of-week");
  const min = field(f[0]!, 0, 59, "minute"), hour = field(f[1]!, 0, 23, "hour"), dom = field(f[2]!, 1, 31, "day-of-month"), mon = field(f[3]!, 1, 12, "month"), dow = field(f[4]!, 0, 7, "day-of-week");
  if (dow.set.has(7)) { dow.set.delete(7); dow.set.add(0); }
  return { min: min.set, hour: hour.set, dom: dom.set, mon: mon.set, dow: dow.set, domStar: dom.star, dowStar: dow.star, expr: expr.trim() };
}

const fmts = new Map<string, Intl.DateTimeFormat>();
function parts(t: number, tz: string) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmts.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(t)) o[p.type] = p.value;
  return { mon: Number(o.month), day: Number(o.day), hour: Number(o.hour) % 24, minute: Number(o.minute), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday!) };
}

/** First matching minute strictly after `afterMs`, interpreted in IANA zone `tz`. */
export function nextCron(spec: CronSpec, afterMs: number, tz: string): number {
  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  for (let i = 0; i < 30000; i++) {
    const p = parts(t, tz);
    const dayOk = spec.domStar && spec.dowStar ? true : spec.domStar ? spec.dow.has(p.dow) : spec.dowStar ? spec.dom.has(p.day) : spec.dom.has(p.day) || spec.dow.has(p.dow);
    if (!spec.mon.has(p.mon) || !dayOk) { t += ((24 - p.hour) * 60 - p.minute) * 60000; continue; }
    if (!spec.hour.has(p.hour)) { t += (60 - p.minute) * 60000; continue; }
    if (!spec.min.has(p.minute)) { t += 60000; continue; }
    return t;
  }
  throw new Error("This cron expression never matches");
}

export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}
