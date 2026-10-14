import type { Config } from "./config";
import { httpJson } from "./util";

export type EmbedProvider = "gemini" | "openai" | "local";

export function embedProvider(c: Config): EmbedProvider {
  const p = c.EMBED_PROVIDER;
  if (p === "gemini") return c.GEMINI_API_KEY ? "gemini" : "local";
  if (p === "openai") return c.OPENAI_API_KEY ? "openai" : "local";
  if (p === "local") return "local";
  return c.GEMINI_API_KEY ? "gemini" : c.OPENAI_API_KEY ? "openai" : "local";
}

// ---------- local (offline) embedding: feature hashing over words, word-bigrams and char-trigrams ----------
const DIM = 512;
const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Normalise Persian/Arabic variants so "كتاب" == "کتاب", strip diacritics, unify digits, treat ZWNJ as a space. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/ۀ/g, "ه").replace(/[أإآ]/g, "ا")
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u200c/g, " ");
}
export const tokenize = (s: string): string[] => normalizeText(s).match(/[\p{L}\p{N}]+/gu) ?? [];

export function localEmbed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const toks = tokenize(text);
  const add = (feat: string, w: number) => {
    const h = fnv(feat);
    v[h % DIM]! += (h & 0x80000000 ? -1 : 1) * w;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    add("w:" + t, 1);
    if (i > 0) add("b:" + toks[i - 1] + " " + t, 0.7);
    if (t.length > 3) { const p = `^${t}$`; for (let j = 0; j + 3 <= p.length; j++) add("c:" + p.slice(j, j + 3), 0.35); }
  }
  return normalize(v);
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

export function cosine(a: Float32Array | null, b: Float32Array | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
  return d;
}

/** Embed texts. Remote failures fall back to the local embedder (so memory never breaks). */
export async function embed(c: Config, texts: string[], kind: "doc" | "query" = "doc"): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const p = embedProvider(c);
  try {
    if (p === "gemini") {
      const model = c.EMBED_MODEL ?? "gemini-embedding-001";
      const d = await httpJson<any>(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": c.GEMINI_API_KEY! },
        body: JSON.stringify({
          requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t.slice(0, 6000) }] }, taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT", outputDimensionality: 768 })),
        }),
      }, { retries: 1, timeoutMs: 30_000 });
      const out = (d.embeddings ?? []).map((e: any) => normalize(Float32Array.from(e.values)));
      if (out.length === texts.length) return out;
    } else if (p === "openai") {
      const d = await httpJson<any>("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${c.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: c.EMBED_MODEL ?? "text-embedding-3-small", input: texts.map((t) => t.slice(0, 6000)) }),
      }, { retries: 1, timeoutMs: 30_000 });
      const out = (d.data ?? []).map((e: any) => normalize(Float32Array.from(e.embedding)));
      if (out.length === texts.length) return out;
    }
  } catch { /* fall through to local */ }
  return texts.map(localEmbed);
}

export async function embedOne(c: Config, text: string, kind: "doc" | "query" = "doc"): Promise<Float32Array> {
  return (await embed(c, [text], kind))[0]!;
}

/** Lexical overlap score 0..1 (fraction of query tokens present in the text). */
export function lexicalScore(query: string, text: string): number {
  const q = tokenize(query);
  if (!q.length) return 0;
  const hay = new Set(tokenize(text));
  return q.filter((t) => hay.has(t)).length / q.length;
}
