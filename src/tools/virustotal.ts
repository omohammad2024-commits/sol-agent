import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Config } from "../config";
import type { Tool } from "../types";
import { resolveSafe } from "../security";
import { HttpError, sleep } from "../util";

const API = "https://www.virustotal.com/api/v3";

async function vt(key: string, method: string, path: string, body?: BodyInit): Promise<any> {
  const res = await fetch(`${API}${path}`, { method, headers: { "x-apikey": key, accept: "application/json" }, body, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text.slice(0, 300));
  return JSON.parse(text);
}

function summarize(kind: string, target: string, attrs: any, link: string) {
  const s = attrs.last_analysis_stats ?? attrs.stats ?? {};
  const malicious = s.malicious ?? 0, suspicious = s.suspicious ?? 0;
  const results = attrs.last_analysis_results ?? attrs.results ?? {};
  const flagged = Object.entries<any>(results).filter(([, v]) => v.category === "malicious" || v.category === "suspicious").slice(0, 10).map(([engine, v]) => `${engine}: ${v.result ?? v.category}`);
  return {
    kind, target, verdict: malicious > 0 ? "MALICIOUS" : suspicious > 0 ? "SUSPICIOUS" : "no detections", stats: s, reputation: attrs.reputation,
    categories: attrs.categories ? Object.values(attrs.categories).slice(0, 5) : undefined, flagged_by: flagged,
    last_analysis: attrs.last_analysis_date ? new Date(attrs.last_analysis_date * 1000).toISOString() : undefined, report: link,
  };
}

async function pollAnalysis(key: string, id: string) {
  for (let i = 0; i < 12; i++) {
    const a = await vt(key, "GET", `/analyses/${id}`);
    if (a.data?.attributes?.status === "completed") return a.data.attributes;
    await sleep(3000);
  }
  return null;
}

export const virustotalScan: Tool = {
  name: "virustotal_scan",
  description: "Check a URL, domain, IP address, file hash, or a workspace file (<=32 MB) for malware using VirusTotal.",
  level: "trusted",
  untrusted: true,
  enabled: (c: Config) => !!c.VIRUSTOTAL_API_KEY,
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "URL, domain, IP, md5/sha1/sha256 hash, or relative workspace file path" },
      kind: { type: "string", enum: ["auto", "url", "domain", "ip", "hash", "file"], description: "default auto-detect" },
    },
    required: ["target"],
  },
  async run({ target, kind }, ctx) {
    const key = ctx.config.VIRUSTOTAL_API_KEY!;
    const t = String(target).trim();
    let k: string = kind ?? "auto";
    if (k === "auto") {
      if (/^https?:\/\//i.test(t)) k = "url";
      else if (net.isIP(t)) k = "ip";
      else if (/^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(t)) k = "hash";
      else if (/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(t)) k = "domain";
      else k = "file";
    }
    if (k === "ip") {
      const d = await vt(key, "GET", `/ip_addresses/${encodeURIComponent(t)}`);
      return summarize("ip", t, d.data.attributes, `https://www.virustotal.com/gui/ip-address/${t}`);
    }
    if (k === "domain") {
      const d = await vt(key, "GET", `/domains/${encodeURIComponent(t.toLowerCase())}`);
      return summarize("domain", t, d.data.attributes, `https://www.virustotal.com/gui/domain/${t}`);
    }
    if (k === "hash") {
      const d = await vt(key, "GET", `/files/${t.toLowerCase()}`);
      return { ...summarize("file", t, d.data.attributes, `https://www.virustotal.com/gui/file/${t}`), names: (d.data.attributes.names ?? []).slice(0, 3) };
    }
    if (k === "url") {
      const id = Buffer.from(t).toString("base64url");
      try {
        const d = await vt(key, "GET", `/urls/${id}`);
        return summarize("url", t, d.data.attributes, `https://www.virustotal.com/gui/url/${id}`);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
      const sub = await vt(key, "POST", "/urls", new URLSearchParams({ url: t }));
      const attrs = await pollAnalysis(key, sub.data.id);
      if (!attrs) return { kind: "url", target: t, verdict: "analysis still running - ask again in a minute" };
      return summarize("url", t, attrs, `https://www.virustotal.com/gui/url/${id}`);
    }
    // file in workspace
    const full = resolveSafe(ctx.workdir, t);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error("Not a file");
    if (st.size > 32 * 1024 * 1024) throw new Error("File larger than 32 MB (VirusTotal direct-upload limit)");
    const data = fs.readFileSync(full);
    const sha = crypto.createHash("sha256").update(data).digest("hex");
    try {
      const d = await vt(key, "GET", `/files/${sha}`);
      return { ...summarize("file", t, d.data.attributes, `https://www.virustotal.com/gui/file/${sha}`), sha256: sha, source: "existing report" };
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    }
    const form = new FormData();
    form.append("file", new Blob([data]), path.basename(full));
    const sub = await vt(key, "POST", "/files", form);
    const attrs = await pollAnalysis(key, sub.data.id);
    if (!attrs) return { kind: "file", target: t, sha256: sha, verdict: "uploaded; analysis still running - ask again in a minute", report: `https://www.virustotal.com/gui/file/${sha}` };
    return { ...summarize("file", t, attrs, `https://www.virustotal.com/gui/file/${sha}`), sha256: sha, source: "fresh scan" };
  },
};
