import dns from "node:dns/promises";
import type { Tool } from "../types";
import { httpJson, truncate } from "../util";
import { safeFetch } from "../security";

const UA = "Mozilla/5.0 (compatible; sol-agent/1.0; +https://github.com)";

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)));
}
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  let t = html.replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
  t = decodeEntities(t).replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text: t };
}

async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ---- web_search ----
export const webSearch: Tool = {
  name: "web_search",
  description: "Search the web for current information. Returns titles, URLs and snippets. Follow up with web_fetch to read a page.",
  level: "public",
  untrusted: true,
  taints: true,
  parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", description: "1-10, default 6" } }, required: ["query"] },
  async run({ query, count }, ctx) {
    const n = Math.min(Math.max(count ?? 6, 1), 10);
    if (ctx.config.BRAVE_API_KEY) {
      const d = await httpJson<any>(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, {
        headers: { "x-subscription-token": ctx.config.BRAVE_API_KEY, accept: "application/json" },
      });
      return (d.web?.results ?? []).slice(0, n).map((r: any) => ({ title: stripTags(r.title ?? ""), url: r.url, snippet: stripTags(r.description ?? "") }));
    }
    // Fallback: DuckDuckGo HTML endpoint (best-effort; may rate-limit).
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    const out: { title: string; url: string; snippet: string }[] = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < n) {
      let url = decodeEntities(m[1]!);
      try {
        const u = new URL(url.startsWith("//") ? "https:" + url : url);
        url = u.searchParams.get("uddg") ?? u.toString();
      } catch {}
      out.push({ title: stripTags(m[2]!), url, snippet: stripTags(m[3]!) });
    }
    if (!out.length) throw new Error("Search returned no results (set BRAVE_API_KEY for reliable search)");
    return out;
  },
};

// ---- web_fetch ----
export const webFetch: Tool = {
  name: "web_fetch",
  description: "Download a web page (http/https, public hosts only) and return its readable text. JSON and plain text are returned as-is.",
  level: "public",
  untrusted: true,
  taints: true,
  parameters: { type: "object", properties: { url: { type: "string" }, max_chars: { type: "integer", description: "default 8000, max 20000" } }, required: ["url"] },
  async run({ url, max_chars }) {
    const max = Math.min(max_chars ?? 8000, 20000);
    const res = await safeFetch(url, { headers: { "user-agent": UA, accept: "text/html,application/json,text/plain,*/*" } });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/text\/|json|xml/i.test(type)) return { url, content_type: type, note: "Not a text document; use download/virustotal tools if needed." };
    const body = await readLimited(res, 2_000_000);
    if (/html/i.test(type)) {
      const { title, text } = htmlToText(body);
      return { url, title, text: truncate(text, max) };
    }
    return { url, content_type: type, text: truncate(body, max) };
  },
};

// ---- browse (Chromium via Playwright, optional) ----
export const browse: Tool = {
  name: "browse",
  description: "Open a page in a real headless Chromium (renders JavaScript) and return its text, optionally sending a screenshot. Use only when web_fetch is not enough (JS-heavy sites).",
  level: "trusted",
  untrusted: true,
  taints: true,
  parameters: { type: "object", properties: { url: { type: "string" }, screenshot: { type: "boolean", description: "also send a screenshot to the chat" }, max_chars: { type: "integer" } }, required: ["url"] },
  async run({ url, screenshot, max_chars }, ctx) {
    const { assertPublicUrl } = await import("../security");
    await assertPublicUrl(url);
    let pw: any;
    try {
      pw = await import(/* @vite-ignore */ "playwright" as string);
    } catch {
      throw new Error("Chromium is not installed on this server (bun add playwright && bunx playwright install --with-deps chromium). Use web_fetch instead.");
    }
    const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      // Block requests to private networks made by the page itself.
      await page.route("**/*", async (route: any) => {
        try {
          await assertPublicUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort();
        }
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1500);
      const title = await page.title();
      const text: string = await page.evaluate("document.body ? document.body.innerText : ''");
      if (screenshot) await ctx.sendFile({ data: await page.screenshot({ type: "png" }), filename: "screenshot.png" }, "photo");
      return { url: page.url(), title, text: truncate(text.replace(/\n{3,}/g, "\n\n"), Math.min(max_chars ?? 8000, 20000)) };
    } finally {
      await browser.close();
    }
  },
};

// ---- wikipedia ----
export const wikipedia: Tool = {
  name: "wikipedia",
  description: "Look up a topic on Wikipedia and return the summary of the best match plus other candidate titles. lang: 'en', 'fa', 'ar', 'de', ...",
  level: "public",
  untrusted: true,
  taints: true,
  parameters: { type: "object", properties: { query: { type: "string" }, lang: { type: "string", description: "default 'en'; use 'fa' for Persian" } }, required: ["query"] },
  async run({ query, lang }) {
    const l = /^[a-z]{2,3}(-[a-z]+)?$/i.test(lang ?? "") ? lang.toLowerCase() : "en";
    const headers = { "user-agent": "sol-agent/1.0 (telegram bot)", accept: "application/json" };
    const s = await httpJson<any>(`https://${l}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json`, { headers });
    const hits: { title: string }[] = s?.query?.search ?? [];
    if (!hits.length) return { found: false, query };
    const top = hits[0]!.title;
    const sum = await httpJson<any>(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(top)}`, { headers });
    return { title: sum.title, description: sum.description, summary: truncate(sum.extract ?? "", 2500), url: sum.content_urls?.desktop?.page, other_matches: hits.slice(1).map((h) => h.title) };
  },
};

// ---- digikala_search ----
export const digikalaSearch: Tool = {
  name: "digikala_search",
  description: "Search products on Digikala (Iranian online shop). Returns title, price in Toman, rating and link. Query in Persian works best.",
  level: "public",
  untrusted: true,
  taints: true,
  parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", description: "1-10, default 6" }, sort: { type: "string", enum: ["relevance", "cheapest", "most_expensive", "best_selling"] } }, required: ["query"] },
  async run({ query, count, sort }) {
    const n = Math.min(Math.max(count ?? 6, 1), 10);
    const sortMap: Record<string, number> = { relevance: 22, cheapest: 7, most_expensive: 8, best_selling: 4 };
    const url = `https://api.digikala.com/v1/search/?q=${encodeURIComponent(query)}&sort=${sortMap[sort ?? "relevance"]}`;
    const d = await httpJson<any>(url, { headers: { "user-agent": UA, accept: "application/json" } }, { retries: 1, timeoutMs: 20000 });
    const products: any[] = d?.data?.products ?? [];
    return products.slice(0, n).map((p) => {
      const price = p.default_variant?.price?.selling_price;
      return {
        title: p.title_fa,
        price_toman: typeof price === "number" ? Math.round(price / 10) : null,
        rating: p.rating?.rate ? p.rating.rate / 20 : null,
        in_stock: p.status === "marketable",
        url: `https://www.digikala.com/product/dkp-${p.id}/`,
      };
    });
  },
};

// ---- dns_lookup ----
export const dnsLookup: Tool = {
  name: "dns_lookup",
  description: "Query DNS records for a domain (A, AAAA, MX, NS, TXT, CNAME, SOA, CAA).",
  level: "public",
  parameters: {
    type: "object",
    properties: { domain: { type: "string" }, types: { type: "array", items: { type: "string" }, description: "default: A, AAAA, MX, NS, TXT, CNAME" } },
    required: ["domain"],
  },
  async run({ domain, types }) {
    let host: string;
    try {
      host = new URL(`http://${String(domain).trim()}`).hostname;
    } catch {
      throw new Error("Invalid domain");
    }
    if (!/^(?=.{1,253}$)([a-z0-9_-]{1,63}\.)+[a-z0-9-]{2,63}$/i.test(host)) throw new Error("Invalid domain");
    const wanted: string[] = (types?.length ? types : ["A", "AAAA", "MX", "NS", "TXT", "CNAME"]).map((t: string) => t.toUpperCase());
    const allowed = ["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "CAA"];
    const out: Record<string, unknown> = { domain: host };
    const r = new dns.Resolver({ timeout: 4000, tries: 2 });
    await Promise.all(
      wanted.filter((t) => allowed.includes(t)).map(async (t) => {
        try {
          const v = await r.resolve(host, t as any);
          out[t] = t === "TXT" ? (v as unknown as string[][]).map((x) => x.join("")) : v;
        } catch (e: any) {
          out[t] = e.code === "ENODATA" || e.code === "ENOTFOUND" ? [] : `error: ${e.code ?? e.message}`;
        }
      }),
    );
    return out;
  },
};

export const webTools: Tool[] = [webSearch, webFetch, browse, wikipedia, digikalaSearch, dnsLookup];
