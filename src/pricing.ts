import type { Usage } from "./llm/types";

export interface Price { in: number; out: number; cacheRead?: number; cacheWrite?: number } // USD per 1M tokens

/** Estimates only. Verify on the providers' pricing pages and override with MODEL_PRICES. */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, // <=100K-token prompts
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4, cacheRead: 0.01 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5, cacheRead: 0.03 },
  "gemini-2.5-pro": { in: 1.25, out: 10, cacheRead: 0.125 },
};

export function parsePrices(json: string | undefined): Record<string, Price> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, Price>;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v && typeof v.in === "number" && typeof v.out === "number"));
  } catch { return {}; }
}

export function priceFor(model: string, overrides: Record<string, Price> = {}): Price | null {
  const table = { ...DEFAULT_PRICES, ...overrides };
  const key = Object.keys(table).filter((k) => model === k || model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key]! : null;
}

/** Cost in USD, or null when the model has no known price. */
export function costUsd(model: string, u: Usage, overrides: Record<string, Price> = {}): number | null {
  const p = priceFor(model, overrides);
  if (!p) return null;
  return (u.input * p.in + u.output * p.out + u.cacheRead * (p.cacheRead ?? p.in) + u.cacheWrite * (p.cacheWrite ?? p.in)) / 1e6;
}

/** Calendar day (YYYY-MM-DD) in the given IANA zone. */
export function dayKey(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}
