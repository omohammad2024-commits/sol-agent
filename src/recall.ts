import type { Config } from "./config";
import { cosine, embedOne, lexicalScore } from "./embed";
import type { EpisodeRow, MemEmbRow, Scope, Store } from "./memory/store";

export interface ScoredMem { key: string; value: string; score: number }

/** Rank a scope's memories against a query: semantic cosine, boosted by lexical overlap. */
export function rankMemories(rows: MemEmbRow[], query: string, qEmb: Float32Array | null, k: number, minScore = 0.18): ScoredMem[] {
  return rows
    .map((r) => ({ key: r.key, value: r.value, score: Math.max(cosine(qEmb, r.embedding), 0.6 * lexicalScore(query, `${r.key} ${r.value}`)) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function searchMemories(c: Config, store: Store, scope: Scope, owner: string, query: string, k = 8): Promise<ScoredMem[]> {
  const rows = store.memListWithEmbeddings(scope, owner, 500);
  if (!rows.length) return [];
  return rankMemories(rows, query, await embedOne(c, query, "query"), k);
}

export interface ScoredEpisode { summary: string; ts: number; score: number }
export function rankEpisodes(rows: EpisodeRow[], query: string, qEmb: Float32Array | null, k: number, minScore = 0.2): ScoredEpisode[] {
  return rows
    .map((r) => ({ summary: r.summary, ts: r.ts, score: Math.max(cosine(qEmb, r.embedding), 0.6 * lexicalScore(query, r.summary)) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * What to put in the prompt for one scope: everything when small, otherwise the most relevant to the
 * current message plus the most recent few.
 */
export function selectForPrompt(store: Store, scope: Scope, owner: string, query: string, qEmb: Float32Array | null, limits: { all: number; relevant: number; recent: number }): { key: string; value: string }[] {
  const total = store.memCount(scope, owner);
  if (total === 0) return [];
  if (total <= limits.all) return store.memList(scope, owner, limits.all);
  const rows = store.memListWithEmbeddings(scope, owner, 500);
  const picked = new Map<string, { key: string; value: string }>();
  for (const r of rankMemories(rows, query, qEmb, limits.relevant, 0.15)) picked.set(r.key, r);
  for (const r of rows.slice(0, limits.recent)) picked.set(r.key, r);
  return [...picked.values()];
}
