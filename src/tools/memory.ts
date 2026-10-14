import { embedOne } from "../embed";
import type { Scope } from "../memory/store";
import { rankEpisodes, searchMemories } from "../recall";
import { levelRank, type Tool, type ToolContext } from "../types";

const scopeProp = { type: "string", enum: ["user", "group", "global"], description: "user = this person (default), group = this group chat, global = shared by everyone (admin write)" };

function ownerFor(scope: Scope, ctx: ToolContext, write: boolean): string {
  if (scope === "user") return String(ctx.userId);
  if (scope === "group") {
    if (ctx.chatType === "private") throw new Error("There is no group in a private chat; use scope=user");
    if (write && levelRank[ctx.level] < levelRank.trusted) throw new Error("Writing group memory requires trusted access");
    return String(ctx.chatId);
  }
  if (write && ctx.level !== "admin") throw new Error("Writing global memory requires admin access");
  return "*";
}

const cleanKey = (k: string) => k.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 80);
const SECRET_LIKE = /(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|\b\d{8,10}:[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY)/i;

export const memorySet: Tool = {
  name: "memory_set",
  description: "Save or update a durable fact. Use short snake_case keys (e.g. 'preferred_language', 'city'). Never store secrets.",
  level: "public",
  parameters: { type: "object", properties: { scope: scopeProp, key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
  async run({ scope, key, value }, ctx) {
    const s = (scope ?? "user") as Scope;
    if (SECRET_LIKE.test(value)) throw new Error("Refusing to store something that looks like a secret");
    if (value.length > 1000) throw new Error("Value too long (max 1000 chars)");
    const owner = ownerFor(s, ctx, true);
    if (ctx.store.memCount(s, owner) >= 200 && ctx.store.memGet(s, owner, cleanKey(key)) === null) throw new Error("Memory is full (200 entries) - delete something first");
    const emb = await embedOne(ctx.config, `${cleanKey(key).replace(/_/g, " ")}: ${value}`, "doc").catch(() => null);
    ctx.store.memSet(s, owner, cleanKey(key), value, emb);
    return { saved: true, scope: s, key: cleanKey(key) };
  },
};

export const memoryGet: Tool = {
  name: "memory_get",
  description: "Read one saved fact by key.",
  level: "public",
  parameters: { type: "object", properties: { scope: scopeProp, key: { type: "string" } }, required: ["key"] },
  async run({ scope, key }, ctx) {
    const s = (scope ?? "user") as Scope;
    const v = ctx.store.memGet(s, ownerFor(s, ctx, false), cleanKey(key));
    return v === null ? { found: false } : { found: true, key: cleanKey(key), value: v };
  },
};

export const memorySearch: Tool = {
  name: "memory_search",
  description: "Search saved facts by meaning (semantic + keyword). Empty query lists the most recent entries.",
  level: "public",
  parameters: { type: "object", properties: { scope: scopeProp, query: { type: "string" } } },
  async run({ scope, query }, ctx) {
    const s = (scope ?? "user") as Scope;
    const owner = ownerFor(s, ctx, false);
    if (!query) return ctx.store.memList(s, owner, 30).map((r) => ({ key: r.key, value: r.value }));
    const ranked = await searchMemories(ctx.config, ctx.store, s, owner, query, 10);
    const rows = ranked.length ? ranked : ctx.store.memSearch(s, owner, query, 10);
    return rows.map((r) => ({ key: r.key, value: r.value }));
  },
};

export const memoryDelete: Tool = {
  name: "memory_delete",
  description: "Delete a saved fact by key.",
  level: "public",
  parameters: { type: "object", properties: { scope: scopeProp, key: { type: "string" } }, required: ["key"] },
  async run({ scope, key }, ctx) {
    const s = (scope ?? "user") as Scope;
    return { deleted: ctx.store.memDelete(s, ownerFor(s, ctx, true), cleanKey(key)) };
  },
};

export const recall: Tool = {
  name: "recall",
  description: "Search the OLD part of this chat's history: summaries of past conversations (by meaning) plus keyword matches in recent messages. Use for 'what did we talk about / what did I say about X / remind me what we decided'.",
  level: "public",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  async run({ query }, ctx) {
    const qEmb = await embedOne(ctx.config, query, "query");
    const episodes = rankEpisodes(ctx.store.episodesWithEmbeddings(ctx.chatId, 300), query, qEmb, 4, 0.12).map((e) => ({ date: new Date(e.ts).toISOString().slice(0, 10), summary: e.summary }));
    const messages = ctx.store.searchMessages(ctx.chatId, query, 6).map((m) => ({ date: new Date(m.ts).toISOString().slice(0, 10), who: m.role === "user" ? "user" : "SOL", text: m.text.replace(/^\[msg_id:[^\]]*\]\n?/, "").slice(0, 300) }));
    return { episodes, messages };
  },
};

export const memoryTools: Tool[] = [memorySet, memoryGet, memorySearch, memoryDelete, recall];
