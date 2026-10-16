import { create, all } from "mathjs";
import type { Config } from "../config";
import type { Tool } from "../types";
import { httpJson } from "../util";

// ---- calculate (hardened mathjs) ----
const math = create(all);
const limitedEvaluate = math.evaluate;
const disabled = () => {
  throw new Error("Function is disabled");
};
math.import({ import: disabled, createUnit: disabled, evaluate: disabled, parse: disabled, simplify: disabled, derivative: disabled, resolve: disabled }, { override: true });
const BLOCKED = /\b(zeros|ones|identity|diag|range|resize|reshape|sparse|random\w*|setCartesian|permutations|combinations\w*|kron|matrix|map|forEach|filter|apply)\b|:/i;

export const calculate: Tool = {
  name: "calculate",
  description: "Evaluate a math expression (arithmetic, trig, logs, units like '5 km to miles', percentages). Use instead of doing arithmetic yourself.",
  level: "public",
  parameters: { type: "object", properties: { expression: { type: "string", description: "e.g. '(12.5 * 3) / 7', 'sqrt(144)', '100 USD' is NOT supported (use get_rates)" } }, required: ["expression"] },
  async run({ expression }) {
    if (expression.length > 300) throw new Error("Expression too long");
    if (BLOCKED.test(expression)) throw new Error("Expression uses a disabled feature");
    const r = limitedEvaluate(expression);
    return { expression, result: math.format(r, { precision: 14 }) };
  },
};

// ---- get_time ----
const ALIASES: Record<string, string> = {
  tehran: "Asia/Tehran", iran: "Asia/Tehran", tabriz: "Asia/Tehran", mashhad: "Asia/Tehran", isfahan: "Asia/Tehran",
  utc: "UTC", gmt: "UTC", london: "Europe/London", paris: "Europe/Paris", berlin: "Europe/Berlin", istanbul: "Europe/Istanbul",
  dubai: "Asia/Dubai", moscow: "Europe/Moscow", delhi: "Asia/Kolkata", mumbai: "Asia/Kolkata", tokyo: "Asia/Tokyo",
  seoul: "Asia/Seoul", beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai", singapore: "Asia/Singapore", sydney: "Australia/Sydney",
  "new york": "America/New_York", nyc: "America/New_York", chicago: "America/Chicago", "los angeles": "America/Los_Angeles",
  la: "America/Los_Angeles", toronto: "America/Toronto", vancouver: "America/Vancouver", "sao paulo": "America/Sao_Paulo", cairo: "Africa/Cairo",
};
function resolveZone(z: string): string {
  const k = z.trim().toLowerCase();
  const tz = ALIASES[k] ?? z.trim();
  new Intl.DateTimeFormat("en", { timeZone: tz }); // throws RangeError if invalid
  return tz;
}
export const getTime: Tool = {
  name: "get_time",
  description: "Current date/time (including the Persian/Jalali date) in one or more time zones or cities.",
  level: "public",
  parameters: { type: "object", properties: { timezones: { type: "array", items: { type: "string" }, description: "IANA zones or common city names, e.g. ['Tehran','New York','Asia/Tokyo']. Defaults to the bot's zone + UTC." } } },
  async run({ timezones }, ctx) {
    const zones: string[] = timezones?.length ? timezones : [ctx.config.TIMEZONE!, "UTC"];
    const now = new Date();
    return zones.slice(0, 10).map((z) => {
      try {
        const tz = resolveZone(z);
        const fmt = (o: Intl.DateTimeFormatOptions, loc = "en-GB") => new Intl.DateTimeFormat(loc, { timeZone: tz, ...o }).format(now);
        return {
          input: z, zone: tz,
          local: fmt({ dateStyle: "full", timeStyle: "medium", hour12: false }),
          offset: fmt({ timeZoneName: "longOffset" }).split(", ").pop(),
          jalali: fmt({ dateStyle: "full" }, "fa-IR-u-ca-persian"),
        };
      } catch {
        return { input: z, error: "unknown time zone" };
      }
    });
  },
};

// ---- get_rates ----
const CRYPTO: Record<string, string> = {
  btc: "bitcoin", eth: "ethereum", usdt: "tether", ton: "the-open-network", trx: "tron", sol: "solana", doge: "dogecoin",
  xrp: "ripple", bnb: "binancecoin", ltc: "litecoin", ada: "cardano", not: "notcoin", usdc: "usd-coin", dot: "polkadot", shib: "shiba-inu",
};
const IRAN_KEYS: Record<string, string> = {
  usd: "price_dollar_rl", dollar: "price_dollar_rl", eur: "price_eur", euro: "price_eur", gbp: "price_gbp", aed: "price_aed", try: "price_try",
  gold18: "geram18", gold24: "geram24", mesghal: "mesghal", coin: "sekee", coin_emami: "sekee", coin_bahar: "sekeb", coin_half: "nim", coin_quarter: "rob", coin_gram: "gerami",
};
const num = (s: unknown) => Number(String(s ?? "").replace(/[^\d.]/g, ""));

async function iranRate(asset: string, url: string) {
  const key = IRAN_KEYS[asset];
  const data = await httpJson<any>(url, { headers: { "user-agent": "Mozilla/5.0 sol-agent" } }, { retries: 1, timeoutMs: 15000 });
  const cur = data?.current ?? data;
  const entry = key ? cur?.[key] : undefined;
  if (!entry) return { market: "iran", asset, error: "asset not found in the Iran feed", supported: Object.keys(IRAN_KEYS), feed_keys_sample: Object.keys(cur ?? {}).slice(0, 40) };
  const rial = num(entry.p ?? entry.price);
  return {
    market: "iran", asset, price_rial: rial, price_toman: Math.round(rial / 10),
    change: entry.d ?? null, change_percent: entry.dp ?? null, updated: entry.t ?? entry.ts ?? null,
    note: "Feed values assumed to be in Rial (converted to Toman by /10). Verify against the source on first use.",
  };
}

async function globalRate(asset: string) {
  if (CRYPTO[asset]) {
    const d = await httpJson<any>(`https://api.coingecko.com/api/v3/simple/price?ids=${CRYPTO[asset]}&vs_currencies=usd&include_24hr_change=true`);
    const e = d[CRYPTO[asset]!];
    if (!e) throw new Error("CoinGecko returned no data");
    return { market: "global", asset, usd: e.usd, change_24h_percent: e.usd_24h_change ?? null, source: "coingecko" };
  }
  if (asset === "gold" || asset === "xau" || asset === "ons") {
    const d = await httpJson<any>("https://api.gold-api.com/price/XAU");
    return { market: "global", asset: "XAU (troy ounce)", usd: d.price, source: "gold-api.com" };
  }
  if (!/^[a-z]{3}$/.test(asset)) throw new Error(`Unknown asset "${asset}"`);
  const d = await httpJson<any>("https://open.er-api.com/v6/latest/USD");
  const r = d?.rates?.[asset.toUpperCase()];
  if (!r) throw new Error(`Unknown currency "${asset}"`);
  return { market: "global", asset: asset.toUpperCase(), usd_per_unit: 1 / r, units_per_usd: r, source: "open.er-api.com" };
}

export const getRates: Tool = {
  name: "get_rates",
  description: "Live exchange rates. market='iran': free-market prices in Toman (usd, eur, gbp, aed, try, gold18, gold24, mesghal, coin, coin_bahar, coin_half, coin_quarter, coin_gram). market='global': fiat (3-letter codes), crypto (btc, eth, usdt, ton, trx, sol, doge, xrp, bnb...), gold/xau in USD.",
  level: "public",
  parameters: {
    type: "object",
    properties: {
      asset: { type: "string", description: "e.g. usd, eur, gold18, coin, btc, xau" },
      market: { type: "string", enum: ["iran", "global"], description: "Default: iran for usd/eur/gold18/coin..., global otherwise" },
    },
    required: ["asset"],
  },
  async run({ asset, market }, ctx) {
    const a = String(asset).trim().toLowerCase();
    const m = market ?? (IRAN_KEYS[a] ? "iran" : "global");
    return m === "iran" ? iranRate(a, ctx.config.IRAN_RATES_URL!) : globalRate(a);
  },
};

/** A single comparable number for alerts: Toman for the Iran market, USD otherwise. */
export async function rateValue(asset: string, market: string | undefined, config: Config): Promise<{ value: number; unit: string; market: "iran" | "global"; asset: string }> {
  const a = asset.trim().toLowerCase();
  const m: "iran" | "global" = market === "iran" || market === "global" ? market : IRAN_KEYS[a] ? "iran" : "global";
  const r: any = m === "iran" ? await iranRate(a, config.IRAN_RATES_URL!) : await globalRate(a);
  if (r.error) throw new Error(`${r.error}`);
  const value = m === "iran" ? r.price_toman : (r.usd ?? r.usd_per_unit);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("No numeric price available for this asset");
  return { value, unit: m === "iran" ? "تومان" : "USD", market: m, asset: a };
}

export const infoTools: Tool[] = [calculate, getTime, getRates];
