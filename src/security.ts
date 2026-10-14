import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";

/** Build a function that scrubs secrets (known values + common token shapes) from text. */
export function makeRedactor(secrets: string[]): (text: string) => string {
  const known = secrets.filter((s) => s && s.length >= 8);
  const patterns: RegExp[] = [
    /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // telegram bot token
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
  ];
  return (text: string) => {
    let out = text;
    for (const s of known) out = out.split(s).join("[REDACTED]");
    for (const p of patterns) out = out.replace(p, "[REDACTED]");
    return out;
  };
}

export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224
    );
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === "::" || l === "::1") return true;
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith("ff");
  }
  return true; // unknown format → treat as unsafe
}

/** Throws unless the URL is http(s) and resolves only to public IPs. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http/https URLs are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new Error("Blocked host");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Blocked: private/internal address");
    return u;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Blocked: host resolves to a private/internal address");
  return u;
}

/** fetch that validates every hop (SSRF-safe redirects). */
export async function safeFetch(raw: string, init: RequestInit = {}, opts: { maxRedirects?: number; timeoutMs?: number } = {}): Promise<Response> {
  let url = raw;
  for (let i = 0; i <= (opts.maxRedirects ?? 5); i++) {
    const u = await assertPublicUrl(url);
    const res = await fetch(u, { ...init, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 20000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

/** Resolve a user-supplied relative path inside base; throws on traversal. */
export function resolveSafe(base: string, p: string): string {
  const root = path.resolve(base);
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Path escapes the workspace");
  return full;
}
