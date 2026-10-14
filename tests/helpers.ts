import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDeps } from "../src/agent";
import { createBot } from "../src/bot";
import { loadConfig, secretValues, type Config } from "../src/config";
import type { LLM, LLMRequest, LLMResponse, Part } from "../src/llm/types";
import { Store } from "../src/memory/store";
import { makeRedactor } from "../src/security";
import { buildTools } from "../src/tools";
import type { Level, ToolContext } from "../src/types";

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sol-up-"));
export const OWNER = 1000, ADMIN = 2000, PUBLIC = 3000, TRUSTED = 4000;

export const baseEnv: Record<string, string> = {
  BOT_TOKEN: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ANTHROPIC_API_KEY: "sk-ant-test-key-123456", GEMINI_API_KEY: "gem-test-key-12345678",
  EMBED_PROVIDER: "local", TTS_PROVIDER: "auto", OWNER_ID: String(OWNER), OWNER_NAME: "Ali", ADMIN_IDS: String(ADMIN), TRUSTED_IDS: String(TRUSTED), DATA_DIR: tmp, SANDBOX_MODE: "local",
};
export const cfg = (extra: Record<string, string> = {}): Config => loadConfig({ ...baseEnv, ...extra });
export const config = cfg();
export const systemTemplate = fs.readFileSync(path.join(import.meta.dir, "..", "prompts", "system.md"), "utf8");

export class ScriptedLLM implements LLM {
  name = "scripted";
  calls: LLMRequest[] = [];
  constructor(private script: ((req: LLMRequest, n: number) => Part[] | LLMResponse)[]) {}
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push({ ...JSON.parse(JSON.stringify({ ...req, onText: undefined, onReset: undefined })) });
    const fn = this.script[Math.min(this.calls.length - 1, this.script.length - 1)]!;
    const r = fn(req, this.calls.length - 1);
    return Array.isArray(r) ? { parts: r } : r;
  }
}
export const say = (t: string) => () => [{ type: "text", text: t } as Part];
export const callTool = (name: string, args: Record<string, unknown> = {}, id = "t") => () => [{ type: "tool_call", id, name, args } as Part];

export const mkDeps = (llm: LLM, store: Store, c: Config = config): AgentDeps => ({ config: c, store, llm, tools: buildTools(c), redact: makeRedactor(secretValues(c)), systemTemplate });

export function ctxFor(store: Store, userId: number, level: Level, c: Config = config, extra: Partial<ToolContext> = {}): ToolContext & { files: string[]; voices: number } {
  const workdir = path.join(tmp, "ws", String(userId));
  fs.mkdirSync(workdir, { recursive: true });
  const ctx: any = {
    config: c, store, userId, chatId: userId, chatType: "private", displayName: "T", level, isOwner: userId === OWNER,
    levelOf: (id: number) => (id === OWNER || id === ADMIN ? "admin" : id === TRUSTED ? "trusted" : "public") as any,
    workdir, api: {}, files: [] as string[], voices: 0,
    sendText: async () => {},
    sendFile: async (f: { filename: string }) => void ctx.files.push(f.filename),
    sendVoice: async () => { ctx.voices++; },
    vision: async () => "",
  };
  return Object.assign(ctx, extra);
}

export const botInfo = { id: 777, is_bot: true as const, first_name: "SOL", username: "sol_test_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };

export function harness(llm: LLM, c: Config = config, shared?: Store, overrides: Record<string, (payload: any) => any> = {}) {
  const store = shared ?? new Store(":memory:");
  const deps = mkDeps(llm, store, c);
  const b = createBot(deps, { botInfo, live: { delayMs: 5, editIntervalMs: 5 } });
  const calls: { method: string; payload: any }[] = [];
  b.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const o = overrides[method];
    const result: any = o ? o(payload) : method === "getFile" ? { file_id: "f", file_path: "voice/f.oga", file_size: 10 } : { message_id: 1, date: 0, chat: { id: 1, type: "private" } };
    return { ok: true, result } as any;
  });
  let id = 0;
  const msg = (chatType: "private" | "supergroup", from: number, text: string | undefined, extra: Record<string, unknown> = {}) => ({
    update_id: ++id,
    message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chatType === "private" ? from : -100123, type: chatType, ...(chatType === "supergroup" ? { title: "G" } : {}) }, from: { id: from, is_bot: false, first_name: `U${from}` }, ...(text !== undefined ? { text } : {}), ...extra },
  });
  const sent = () => calls.filter((x) => x.method === "sendMessage").map((x) => String(x.payload.text));
  return { ...b, deps, store, calls, msg, sent, send: async (u: any) => { await b.bot.handleUpdate(u); await b.drain(); }, method: (m: string) => calls.filter((x) => x.method === m) };
}

export const sse = (events: { event?: string; data: unknown }[]) =>
  new Response(new ReadableStream({ start(ctl) { for (const e of events) ctl.enqueue(new TextEncoder().encode(`${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`)); ctl.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });

export async function withFetch<T>(handler: (url: string, init: any) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any) => handler(String(u), init)) as any;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
