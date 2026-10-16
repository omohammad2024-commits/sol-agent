import { execFile } from "node:child_process";
import crypto from "node:crypto";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const rid = (n = 6) => crypto.randomBytes(n).toString("hex");

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `… [truncated ${s.length - n} chars]`;
}

/** Split text into chunks <= max, preferring paragraph / line / space boundaries. */
export function chunkText(text: string, max = 3800): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Small, safe Markdown → Telegram-HTML converter. */
export function mdToHtml(src: string): string {
  const stash: string[] = [];
  const hold = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = src.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_m, code: string) => hold(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => hold(`<code>${esc(c)}</code>`));
  s = esc(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, "<i>$1</i>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)]!);
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

/** execFile wrapper (no shell). Never throws on non-zero exit. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 60000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") + (e && e.code === "ENOENT" ? `\ncommand not found: ${cmd}` : ""),
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          timedOut: !!e?.killed,
        });
      },
    );
    child.on("error", () => {});
  });
}

/** fetch + JSON with retries on 429/5xx. */
export async function httpJson<T = any>(url: string, init: RequestInit = {}, opts: { retries?: number; timeoutMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 60000) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        await sleep(800 * 2 ** i);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text.slice(0, 500));
      return JSON.parse(text) as T;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body}`);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** fetch with retries on network errors / 429 / 5xx. Returns an OK Response (body unread) or throws HttpError. */
export async function fetchRetry(url: string, init: RequestInit = {}, opts: { retries?: number; timeoutMs?: number } = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 60000) });
      if (res.status === 429 || res.status >= 500) {
        const body = (await res.text()).slice(0, 300);
        lastErr = new HttpError(res.status, body);
        await sleep(800 * 2 ** i);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, (await res.text()).slice(0, 500));
      return res;
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Minimal Server-Sent-Events reader. */
export async function* parseSSE(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
  if (buf.trim()) {
    const data = buf.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    if (data.length) yield { data: data.join("\n") };
  }
}
