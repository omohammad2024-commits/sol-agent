import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chooseTier, buildPrompt, recordUsage, runAgent } from "../src/agent";
import { decryptBuffer, encryptBuffer, makeBackup, pruneBackups, runBackup } from "../src/backup";
import { nextCron, parseCron } from "../src/cron";
import { cosine, localEmbed, normalizeText } from "../src/embed";
import { AnthropicLLM, buildAnthropicBody } from "../src/llm/anthropic";
import { GeminiLLM } from "../src/llm/gemini";
import { OpenAICompatibleLLM, buildOpenAIBody } from "../src/llm/openai";
import { RoutedLLM } from "../src/llm";
import type { LLM, Part } from "../src/llm/types";
import { addLogSink, configureLogger, log } from "../src/log";
import { SCHEMA_VERSION, Store } from "../src/memory/store";
import { createNotifier, notifyOnErrors } from "../src/notify";
import { costUsd, dayKey, priceFor } from "../src/pricing";
import { rankMemories, selectForPrompt } from "../src/recall";
import { createIO } from "../src/io";
import { startScheduler } from "../src/scheduler";
import { maybeSummarize } from "../src/summarizer";
import { buildTools } from "../src/tools";
import { recall } from "../src/tools/memory";
import { OWNER, PUBLIC, ScriptedLLM, TRUSTED, ADMIN, callTool, cfg, config, ctxFor, mkDeps, say, sse, tmp, withFetch } from "./helpers";

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("migrations", () => {
  test("fresh DB reaches the latest schema version", () => {
    const s = new Store(":memory:");
    expect(s.schemaVersion()).toBe(SCHEMA_VERSION);
  });
  test("an old v1 database is upgraded and old reminders become jobs", () => {
    fs.mkdirSync(tmp, { recursive: true }); // tmp is shared across test files; another file's afterAll may have removed it
    const file = path.join(tmp, "old.db");
    const raw = new Database(file, { create: true });
    raw.exec("CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, owner TEXT, key TEXT, value TEXT, updated_at INTEGER);");
    raw.exec("CREATE TABLE reminders(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, user_id INTEGER, text TEXT, due_at INTEGER, done INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0);");
    raw.exec("INSERT INTO reminders(chat_id,user_id,text,due_at) VALUES (5,5,'pay rent',123456);");
    raw.exec("INSERT INTO reminders(chat_id,user_id,text,due_at,done) VALUES (5,5,'old done',1,1);");
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    const s = new Store(file);
    expect(s.schemaVersion()).toBe(SCHEMA_VERSION);
    const jobs = s.listJobs(5);
    expect(jobs.map((j) => j.text)).toEqual(["pay rent"]);
    expect(jobs[0]).toMatchObject({ kind: "reminder", max_runs: 1, due_at: 123456 });
    s.close();
  });
});

describe("cron", () => {
  const T = (s: string) => Date.parse(s);
  test("daily time in a time zone (Tehran = UTC+3:30)", () => {
    expect(new Date(nextCron(parseCron("0 8 * * *"), T("2026-10-12T00:00:00Z"), "Asia/Tehran")).toISOString()).toBe("2026-10-12T04:30:00.000Z");
    expect(new Date(nextCron(parseCron("0 8 * * *"), T("2026-10-12T05:00:00Z"), "Asia/Tehran")).toISOString()).toBe("2026-10-13T04:30:00.000Z");
  });
  test("steps, weekdays, month day, lists", () => {
    expect(new Date(nextCron(parseCron("*/15 * * * *"), T("2026-10-13T10:07:00Z"), "UTC")).toISOString()).toBe("2026-10-13T10:15:00.000Z");
    expect(new Date(nextCron(parseCron("30 9 * * 1-5"), T("2026-10-17T10:00:00Z"), "UTC")).toISOString()).toBe("2026-10-19T09:30:00.000Z"); // Sat -> Mon
    expect(new Date(nextCron(parseCron("0 0 1 * *"), T("2026-10-13T00:00:00Z"), "UTC")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(new Date(nextCron(parseCron("0 9,18 * * *"), T("2026-10-13T10:00:00Z"), "UTC")).toISOString()).toBe("2026-10-13T18:00:00.000Z");
    expect(new Date(nextCron(parseCron("0 12 * * sun"), T("2026-10-13T00:00:00Z"), "UTC")).toISOString()).toBe("2026-10-18T12:00:00.000Z");
  });
  test("validation", () => {
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow();
    expect(() => parseCron("*/0 * * * *")).toThrow();
    expect(() => nextCron(parseCron("0 0 31 2 *"), Date.now(), "UTC")).toThrow(/never/);
  });
});

describe("pricing", () => {
  test("cost and unknown models", () => {
    expect(costUsd("claude-sonnet-5-5", { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.007, 6);
    expect(costUsd("claude-sonnet-5-5-20261001", { input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(2.1, 6);
    expect(costUsd("some-new-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(priceFor("x", { x: { in: 1, out: 2 } })).toEqual({ in: 1, out: 2 });
    expect(dayKey(Date.parse("2026-10-12T22:00:00Z"), "Asia/Tehran")).toBe("2026-10-13"); // already past midnight in Tehran
  });
  test("agent turns are metered into usage_log", async () => {
    const store = new Store(":memory:");
    const llm = new ScriptedLLM([() => ({ parts: [{ type: "text", text: "hi" }], usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }, model: "claude-sonnet-5-5" })]);
    await runAgent(mkDeps(llm, store), ctxFor(store, PUBLIC, "public"), { text: "hello there" });
    const s = store.usageSummary("2000-01-01");
    expect(s.calls).toBe(1);
    expect(s.cost).toBeCloseTo(0.007, 6);
    recordUsage({ config, store }, { userId: PUBLIC }, { parts: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "mystery" });
    expect(store.usageSummary("2000-01-01").unpriced).toBe(1);
  });
});

describe("LLM adapters: caching, streaming, usage", () => {
  const msgs = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }];
  const tools = [{ name: "a", description: "d", parameters: { type: "object", properties: {} } }, { name: "b", description: "d", parameters: { type: "object", properties: {} } }];
  test("anthropic request uses prompt-caching breakpoints", () => {
    const body: any = buildAnthropicBody("m", { system: "S", systemStatic: "STATIC", systemDynamic: "DYN", messages: msgs, tools }, true);
    expect(body.stream).toBe(true);
    expect(body.system[0]).toEqual({ type: "text", text: "STATIC", cache_control: { type: "ephemeral" } });
    expect(body.system[1]).toEqual({ type: "text", text: "DYN" });
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect((buildAnthropicBody("m", { system: "S", messages: msgs, tools: [] }, false) as any).system).toBe("S");
  });
  test("anthropic streaming: text deltas, tool JSON assembly, usage", async () => {
    const deltas: string[] = [];
    const r = await withFetch(() => sse([
      { data: { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 } } } },
      { data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } },
      { data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
      { data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "calculate", input: {} } } },
      { data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"expr' } } },
      { data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ession":"1+1"}' } } },
      { data: { type: "message_delta", usage: { output_tokens: 42 } } },
    ]), () => new AnthropicLLM("k", "claude-x").chat({ system: "S", messages: msgs, tools, onText: (d) => deltas.push(d) }));
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r.parts).toEqual([{ type: "text", text: "Hello" }, { type: "tool_call", id: "t1", name: "calculate", args: { expression: "1+1" } }]);
    expect(r.usage).toEqual({ input: 100, output: 42, cacheRead: 50, cacheWrite: 10 });
    expect(r.model).toBe("claude-x");
  });
  test("gemini streaming + usage mapping (cached tokens are not double-counted)", async () => {
    const deltas: string[] = [];
    let url = "";
    const r = await withFetch((u) => { url = u; return sse([
      { data: { candidates: [{ content: { parts: [{ text: "Hel" }] } }] } },
      { data: { candidates: [{ content: { parts: [{ text: "lo" }, { functionCall: { name: "get_time", args: {} }, thoughtSignature: "s" }] } }], usageMetadata: { promptTokenCount: 200, cachedContentTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 5 } } },
    ]); }, () => new GeminiLLM("k", "gemini-x").chat({ system: "S", messages: msgs, tools, onText: (d) => deltas.push(d) }));
    expect(url).toContain("streamGenerateContent?alt=sse");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r.parts[0]).toEqual({ type: "text", text: "Hello" });
    expect((r.parts[1] as any).meta.thoughtSignature).toBe("s");
    expect(r.usage).toEqual({ input: 150, output: 25, cacheRead: 50, cacheWrite: 0 });
  });
  test("openai-compatible: body format, tool messages, usage", async () => {
    const body: any = buildOpenAIBody("gpt-x", {
      system: "S",
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "t1", name: "calculate", args: { expression: "1+1" } }] },
        { role: "user", parts: [{ type: "tool_result", id: "t1", name: "calculate", content: "2" }] },
      ],
      tools,
    }, false);
    expect(body.model).toBe("gpt-x");
    expect(body.messages[0]).toEqual({ role: "system", content: "S" });
    expect(body.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(body.messages[2].tool_calls[0]).toMatchObject({ id: "t1", type: "function", function: { name: "calculate" } });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "2" });
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "a" } });
    expect(body.tool_choice).toBe("auto");
    expect(body.stream).toBeUndefined();
  });
  test("openai-compatible: non-streaming tool call + usage", async () => {
    let url = "";
    const r = await withFetch((u) => { url = u; return new Response(JSON.stringify({
      model: "gpt-x-1",
      choices: [{ message: { role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "get_time", arguments: "{\"tz\":\"UTC\"}" } }] } }],
      usage: { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } },
    })); }, () => new OpenAICompatibleLLM("k", "gpt-x", "https://example.com/v1").chat({ system: "S", messages: msgs, tools }));
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(r.parts).toEqual([{ type: "text", text: "ok" }, { type: "tool_call", id: "c1", name: "get_time", args: { tz: "UTC" } }]);
    expect(r.usage).toEqual({ input: 50, output: 10, cacheRead: 20, cacheWrite: 0 });
    expect(r.model).toBe("gpt-x-1");
  });
  test("openai-compatible: streaming text deltas + fragmented tool args", async () => {
    const deltas: string[] = [];
    const r = await withFetch(() => sse([
      { data: { choices: [{ delta: { content: "He" } }] } },
      { data: { choices: [{ delta: { content: "llo" } }] } },
      { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "t9", function: { name: "calc", arguments: "{\"ex" } }] } }] } },
      { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "pression\":\"2*3\"}" } }] } }] } },
      { data: "[DONE]" },
    ]), () => new OpenAICompatibleLLM("k", "gpt-x", "https://example.com/v1").chat({ system: "S", messages: msgs, tools, onText: (d) => deltas.push(d) }));
    expect(deltas).toEqual(["He", "llo"]);
    expect(r.parts).toEqual([{ type: "text", text: "Hello" }, { type: "tool_call", id: "t9", name: "calc", args: { expression: "2*3" } }]);
  });
  test("openai-compatible: API error surfaces", async () => {
    await expect(withFetch(() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
      () => new OpenAICompatibleLLM("k", "gpt-x", "https://example.com/v1").chat({ system: "S", messages: msgs, tools: [] }))).rejects.toThrow("bad key");
  });
  test("config: openai provider requires key + base url, resolves defaults", () => {
    expect(() => cfg({ LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", OPENAI_API_KEY: "" })).toThrow("OPENAI_API_KEY is required");
    const c = cfg({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://api.deepseek.com/v1" });
    expect(c.LLM_MODEL_RESOLVED).toBe("gpt-5-mini");
    expect(c.LLM_MODEL_FAST_RESOLVED).toBe("gpt-5-nano");
    expect(c.OPENAI_BASE_URL).toBe("https://api.deepseek.com/v1");
  });
  test("RoutedLLM: tier order, fallback, onReset, error when all fail", async () => {
    const mk = (name: string, fail: boolean): LLM & { model: string; n: number } => ({ name, model: name, n: 0, async chat() { this.n++; if (fail) throw new Error(`${name} down`); return { parts: [{ type: "text", text: name }], model: name }; } });
    const fast = mk("fast", false), strong = mk("strong", false), fb = mk("fb", false);
    const r1 = new RoutedLLM({ strong, fast, fallbacks: [fb] });
    expect((await r1.chat({ system: "", messages: [], tools: [], tier: "fast" })).parts[0]).toEqual({ type: "text", text: "fast" });
    expect((await r1.chat({ system: "", messages: [], tools: [] })).parts[0]).toEqual({ type: "text", text: "strong" });
    const events: string[] = []; let resets = 0;
    const r2 = new RoutedLLM({ strong: mk("strong", true), fast: mk("fast", true), fallbacks: [fb] }, (f) => events.push(`${f.from}->${f.to}`));
    const out = await r2.chat({ system: "", messages: [], tools: [], onReset: () => resets++ });
    expect(out.parts[0]).toEqual({ type: "text", text: "fb" });
    expect(events[0]).toContain("strong");
    expect(resets).toBe(1);
    const r3 = new RoutedLLM({ strong: mk("a", true), fallbacks: [mk("b", true)] });
    await expect(r3.chat({ system: "", messages: [], tools: [] })).rejects.toThrow("a down");
  });
});

describe("model routing", () => {
  const ctx = (store: Store) => ctxFor(store, PUBLIC, "public");
  test("chooseTier heuristics", () => {
    const s = new Store(":memory:");
    expect(chooseTier(config, ctx(s), { text: "سلام" }, 0)).toBe("fast");
    expect(chooseTier(config, ctx(s), { text: "قیمت دلار؟" }, 0)).toBe("fast");
    expect(chooseTier(config, ctx(s), { text: "یه اسکریپت پایتون بنویس که فایل‌ها رو مرتب کنه" }, 0)).toBe("strong");
    expect(chooseTier(config, ctx(s), { text: "x".repeat(400) }, 0)).toBe("strong");
    expect(chooseTier(config, ctx(s), { text: "what is this", images: [{ mime: "image/png", data: "x" }] }, 0)).toBe("strong");
    expect(chooseTier(config, ctx(s), { text: "hi" }, 2)).toBe("strong");
    expect(chooseTier(cfg({ ROUTER: "false" }), ctx(s), { text: "hi" }, 0)).toBe("strong");
  });
  test("a failing tool escalates the next step to the strong model", async () => {
    const store = new Store(":memory:");
    const llm = new ScriptedLLM([callTool("calculate", { expression: "zeros(9999,9999)" }), say("sorry")]);
    await runAgent(mkDeps(llm, store), ctxFor(store, PUBLIC, "public"), { text: "hi" });
    expect(llm.calls[0]!.tier).toBe("fast");
    expect(llm.calls[1]!.tier).toBe("strong");
  });
  test("system prompt is split into a cacheable static part and a dynamic part", async () => {
    const store = new Store(":memory:");
    const p = await buildPrompt(mkDeps(new ScriptedLLM([say("x")]), store), ctxFor(store, OWNER, "admin"), "hello");
    expect(p.static).toContain("Hierarchy");
    expect(p.static).not.toContain("Speaker:");
    expect(p.dynamic).toMatch(/Speaker: .*creator: yes\)/);
    expect(p.dynamic).toContain("Now:");
    expect(p.full).toContain(p.static);
  });
});

describe("semantic memory", () => {
  test("normalisation and local embeddings", () => {
    expect(normalizeText("كتاب ۱۲۳ ي")).toBe("کتاب 123 ی");
    const a = localEmbed("I love drinking green tea in the morning");
    expect(cosine(a, localEmbed("what tea do I drink in the morning"))).toBeGreaterThan(cosine(a, localEmbed("the stock market crashed yesterday")) + 0.1);
    const fa = localEmbed("من هر صبح چای سبز می‌خورم");
    expect(cosine(fa, localEmbed("چای سبز صبح"))).toBeGreaterThan(cosine(fa, localEmbed("بورس امروز ریزش کرد")) + 0.1);
  });
  test("relevant memories are picked when there are too many to inject", () => {
    const store = new Store(":memory:");
    store.memSet("user", "1", "pet_dog", "his name is Rex", localEmbed("pet dog: his name is Rex"));
    for (let i = 0; i < 40; i++) store.memSet("user", "1", `item_${i}`, `random filler number ${i} about nothing`, localEmbed(`item ${i}: random filler number ${i} about nothing`));
    const picked = selectForPrompt(store, "user", "1", "what is my dog's name", localEmbed("what is my dog's name"), { all: 25, relevant: 12, recent: 6 });
    expect(picked.some((p) => p.key === "pet_dog")).toBe(true);
    expect(picked.length).toBeLessThanOrEqual(18);
    const ranked = rankMemories(store.memListWithEmbeddings("user", "1"), "dog name", localEmbed("dog name"), 3);
    expect(ranked[0]!.key).toBe("pet_dog");
  });
  test("memory_set stores an embedding and memory_search finds by meaning", async () => {
    const store = new Store(":memory:");
    const t = Object.fromEntries(buildTools(config).map((x) => [x.name, x]));
    const ctx = ctxFor(store, PUBLIC, "public");
    await t.memory_set!.run({ key: "favorite_drink", value: "green tea with honey" }, ctx);
    await t.memory_set!.run({ key: "city", value: "Shiraz" }, ctx);
    expect(store.memListWithEmbeddings("user", String(PUBLIC))[0]!.embedding).not.toBeNull();
    const r = (await t.memory_search!.run({ query: "what is my favorite drink" }, ctx)) as { key: string }[];
    expect(r[0]!.key).toBe("favorite_drink");
  });
});

describe("conversation summaries (episodes)", () => {
  test("old messages are summarized, injected into the prompt and recallable", async () => {
    const store = new Store(":memory:");
    const c = cfg({ SUMMARY_TRIGGER: "40", HISTORY_LIMIT: "20" });
    for (let i = 0; i < 60; i++) store.addMessage(PUBLIC, i % 2 ? "assistant" : "user", i % 2 ? `answer ${i}` : `[msg_id:${i} from:A id:1]\nquestion ${i} about the Shiraz trip budget`, PUBLIC);
    const llm = new ScriptedLLM([say("کاربر درباره بودجه سفر شیراز پرسید و قرار شد هتل ارزان بگیرد.")]);
    const deps = mkDeps(llm, store, c);
    expect(await maybeSummarize(deps, PUBLIC)).toBe(true);
    expect(llm.calls[0]!.tier).toBe("fast");
    expect(llm.calls[0]!.messages[0]!.parts[0]).toMatchObject({ type: "text" });
    expect((llm.calls[0]!.messages[0]!.parts[0] as any).text).not.toContain("msg_id"); // metadata stripped
    expect(store.episodeCount(PUBLIC)).toBe(1);
    expect(store.getSummarizedUpTo(PUBLIC)).toBe(store.summarizeCutoff(PUBLIC, 20));
    expect(await maybeSummarize(deps, PUBLIC)).toBe(false); // nothing new to summarize
    const p = await buildPrompt(deps, ctxFor(store, PUBLIC, "public", c), "hello");
    expect(p.dynamic).toContain("Earlier conversations");
    expect(p.dynamic).toContain("بودجه سفر شیراز");
    const fa = (await recall.run({ query: "بودجه سفر شیراز" }, ctxFor(store, PUBLIC, "public", c))) as any;
    expect(fa.episodes.length).toBe(1);
    const en = (await recall.run({ query: "Shiraz trip budget" }, ctxFor(store, PUBLIC, "public", c))) as any;
    expect(en.messages.length).toBeGreaterThan(0);
  });
});

describe("jobs: scheduler", () => {
  function setup(opts: { level?: any; rate?: any; failSend?: boolean; llm?: LLM; now?: number } = {}) {
    const store = new Store(":memory:");
    const sent: { chatId: number; text: string }[] = [];
    const api: any = { sendMessage: async (chatId: number, text: string) => { if (opts.failSend) throw new Error("telegram down"); sent.push({ chatId, text }); return { message_id: 1 }; } };
    const llm = opts.llm ?? new ScriptedLLM([say("گزارش آماده است")]);
    const deps = mkDeps(llm, store, cfg({ ALERT_INTERVAL_MIN: "5" }));
    const t = { now: opts.now ?? Date.parse("2026-10-12T05:00:00Z") };
    const owner: string[] = [];
    const sched = startScheduler({ agent: deps, api, io: createIO(api, deps.redact), levelOf: () => opts.level ?? "trusted", notifyOwner: (_k, m) => owner.push(m), now: () => t.now, rate: opts.rate });
    return { store, sent, sched, llm: llm as ScriptedLLM, t, owner };
  }
  test("one-shot reminder is sent once", async () => {
    const s = setup();
    const id = s.store.addJob({ chatId: 5, userId: 5, kind: "reminder", text: "<b>pay</b> rent", dueAt: s.t.now - 1000, maxRuns: 1 });
    await s.sched.tick(); await s.sched.tick();
    s.sched.stop();
    expect(s.sent.length).toBe(1);
    expect(s.sent[0]!.text).toContain("&lt;b&gt;pay&lt;/b&gt; rent"); // HTML-escaped
    expect(s.store.getJob(id)!.active).toBe(0);
  });
  test("recurring reminder is rescheduled by its cron in its time zone", async () => {
    const s = setup();
    const id = s.store.addJob({ chatId: 5, userId: 5, kind: "reminder", text: "morning", cron: "0 8 * * *", tz: "Asia/Tehran", dueAt: s.t.now - 1000 });
    await s.sched.tick();
    s.sched.stop();
    const j = s.store.getJob(id)!;
    expect(j).toMatchObject({ active: 1, runs: 1 });
    expect(new Date(j.due_at).toISOString()).toBe("2026-10-13T04:30:00.000Z");
  });
  test("prompt jobs run the agent unattended (no powerful tools) and send the result", async () => {
    const s = setup();
    const id = s.store.addJob({ chatId: 5, userId: 5, kind: "prompt", text: "گزارش قیمت‌ها رو بده", dueAt: s.t.now - 1, maxRuns: 1 });
    await s.sched.tick();
    s.sched.stop();
    expect(s.sent.map((x) => x.text)).toEqual(["گزارش آماده است"]);
    const names = s.llm.calls[0]!.tools.map((t) => t.name);
    expect(names).toContain("web_search");
    for (const n of ["run_shell", "run_python", "send_gift", "github", "group_moderate", "admin_mcp"]) expect(names).not.toContain(n);
    expect(s.llm.calls[0]!.system).toContain("UNATTENDED");
    expect(s.store.history(5, 5).map((h) => h.text)).toContain("گزارش آماده است");
    expect(s.store.getJob(id)!.active).toBe(0);
  });
  test("price alerts fire when crossed (once) and otherwise wait", async () => {
    const s = setup({ rate: async () => ({ value: 60000, unit: "تومان", market: "iran", asset: "usd" }) });
    const hit = s.store.addJob({ chatId: 5, userId: 5, kind: "alert", text: "usd above", payload: { asset: "usd", market: "iran", op: "above", value: 59000 }, dueAt: s.t.now - 1 });
    const wait = s.store.addJob({ chatId: 5, userId: 5, kind: "alert", text: "usd below", payload: { asset: "usd", market: "iran", op: "below", value: 1000 }, dueAt: s.t.now - 1 });
    await s.sched.tick();
    s.sched.stop();
    expect(s.sent.length).toBe(1);
    expect(s.sent[0]!.text).toContain("60,000");
    expect(s.store.getJob(hit)!.active).toBe(0);
    expect(s.store.getJob(wait)).toMatchObject({ active: 1, due_at: s.t.now + 5 * 60_000 });
  });
  test("banned users' jobs are dropped; failing jobs are retried then abandoned with a notice", async () => {
    const b = setup({ level: "banned" });
    const j = b.store.addJob({ chatId: 5, userId: 5, kind: "reminder", text: "x", dueAt: b.t.now - 1 });
    await b.sched.tick(); b.sched.stop();
    expect(b.store.getJob(j)!.active).toBe(0);
    expect(b.sent.length).toBe(0);
    const f = setup({ failSend: true });
    const id = f.store.addJob({ chatId: 5, userId: 5, kind: "reminder", text: "x", dueAt: f.t.now - 1, maxRuns: 1 });
    for (let i = 0; i < 3; i++) await f.sched.tick();
    f.sched.stop();
    expect(f.store.getJob(id)!.active).toBe(0);
    expect(f.owner.length).toBe(1);
  });
});

describe("jobs: tools", () => {
  const tools = () => Object.fromEntries(buildTools(config).map((t) => [t.name, t]));
  test("set_reminder / schedule_task validation, limits and cancel", async () => {
    const store = new Store(":memory:");
    const t = tools();
    const pub = ctxFor(store, PUBLIC, "public");
    const r = (await t.set_reminder!.run({ text: "tea", in_seconds: 60 }, pub)) as any;
    expect(r.id).toBeGreaterThan(0);
    const rec = (await t.set_reminder!.run({ text: "water", cron: "0 */2 * * *" }, pub)) as any;
    expect(rec.recurring).toBe(true);
    await expect(t.set_reminder!.run({ text: "x", at: "2020-01-01T00:00:00Z" }, pub)).rejects.toThrow(/past/);
    await expect(t.set_reminder!.run({ text: "x" }, pub)).rejects.toThrow(/Provide/);
    await expect(t.set_reminder!.run({ text: "x", cron: "nope" }, pub)).rejects.toThrow();
    await expect(t.set_reminder!.run({ text: "x", cron: "0 8 * * *", timezone: "Mars/Base" }, pub)).rejects.toThrow(/time zone/);
    expect((t.schedule_task!.level)).toBe("trusted");
    const tr = ctxFor(store, TRUSTED, "trusted");
    await expect(t.schedule_task!.run({ text: "report", kind: "prompt", cron: "*/5 * * * *" }, tr)).rejects.toThrow(/10 minutes/);
    const ok = (await t.schedule_task!.run({ text: "report", kind: "prompt", cron: "0 8 * * *" }, tr)) as any;
    expect(ok.recurring).toBe(true);
    await expect(t.schedule_task!.run({ text: "report", kind: "prompt", cron: "*/5 * * * *" }, ctxFor(store, ADMIN, "admin"))).resolves.toBeDefined();
    expect((await t.list_tasks!.run({}, pub) as any[]).length).toBe(2);
    expect(((await t.cancel_task!.run({ id: r.id }, pub)) as any).cancelled).toBe(true);
    expect(((await t.cancel_task!.run({ id: ok.id }, pub)) as any).cancelled).toBe(false); // not theirs
  });
  test("per-user quota and background_task rules", async () => {
    const store = new Store(":memory:");
    const c = cfg({ MAX_JOBS_PER_USER: "2" });
    const t = Object.fromEntries(buildTools(c).map((x) => [x.name, x]));
    const ctx = ctxFor(store, TRUSTED, "trusted", c);
    await t.set_reminder!.run({ text: "a", in_seconds: 60 }, ctx);
    await t.background_task!.run({ task: "research X", delay_minutes: 1 }, ctx);
    await expect(t.set_reminder!.run({ text: "c", in_seconds: 60 }, ctx)).rejects.toThrow(/cancel one/);
    await expect(t.background_task!.run({ task: "y" }, { ...ctx, unattended: true })).rejects.toThrow(/cannot start/);
  });
  test("set_price_alert validates the asset against the live feed", async () => {
    const store = new Store(":memory:");
    const t = tools();
    const ctx = ctxFor(store, PUBLIC, "public");
    const feed = () => new Response(JSON.stringify({ current: { price_dollar_rl: { p: "600,000" } } }), { status: 200 });
    const r = (await withFetch(feed, () => t.set_price_alert!.run({ asset: "usd", direction: "above", value: 65000 }, ctx))) as any;
    expect(r).toMatchObject({ current_price: 60000, unit: "تومان" });
    expect(store.listJobs(PUBLIC, ["alert"]).length).toBe(1);
    await expect(withFetch(feed, () => t.set_price_alert!.run({ asset: "unobtainium", market: "iran", direction: "above", value: 1 }, ctx))).rejects.toThrow();
  });
});

describe("backup", () => {
  const dbCfg = (extra: Record<string, string> = {}) => cfg({ DATA_DIR: path.join(tmp, "bk"), ...extra });
  test("encryption round trip, wrong passphrase, tamper detection", () => {
    const data = Buffer.from("hello secret world");
    const enc = encryptBuffer(data, "pw");
    expect(enc.includes(data)).toBe(false);
    expect(decryptBuffer(enc, "pw").toString()).toBe("hello secret world");
    expect(() => decryptBuffer(enc, "bad")).toThrow(/passphrase/);
    enc[enc.length - 1] = enc[enc.length - 1]! ^ 1;
    expect(() => decryptBuffer(enc, "pw")).toThrow();
  });
  test("snapshot -> gzip -> encrypt -> restore yields the same data", () => {
    const c = dbCfg({ BACKUP_PASSPHRASE: "s3cret" });
    fs.mkdirSync(c.DATA_DIR_ABS, { recursive: true });
    const store = new Store(path.join(c.DATA_DIR_ABS, "sol.db"));
    store.memSet("global", "*", "motto", "ship it");
    const r = makeBackup(store, c);
    expect(r.encrypted).toBe(true);
    expect(r.file.endsWith(".db.gz.enc")).toBe(true);
    const db = Buffer.from(Bun.gunzipSync(new Uint8Array(decryptBuffer(fs.readFileSync(r.file), "s3cret"))));
    expect(db.subarray(0, 15).toString()).toBe("SQLite format 3");
    const out = path.join(tmp, "restored.db");
    fs.writeFileSync(out, db);
    expect(new Store(out).memGet("global", "*", "motto")).toBe("ship it");
    store.close();
  });
  test("runBackup sends only encrypted backups to the owner; prune removes old files", async () => {
    const sentDocs: any[] = [];
    const api: any = { sendDocument: async (...a: any[]) => { sentDocs.push(a); return {}; } };
    const c1 = dbCfg({ BACKUP_PASSPHRASE: "pw" });
    const store = new Store(path.join(c1.DATA_DIR_ABS, "sol2.db"));
    const a = await runBackup(store, c1, api);
    expect(a.sentToOwner).toBe(true);
    expect(sentDocs[0]![0]).toBe(OWNER);
    const c2 = dbCfg();
    const b = await runBackup(store, c2, api);
    expect(b.sentToOwner).toBe(false);
    expect(b.errors.join()).toContain("BACKUP_PASSPHRASE");
    expect(sentDocs.length).toBe(1);
    const old = path.join(c1.DATA_DIR_ABS, "backups", "sol-20200101-00.db.gz");
    fs.writeFileSync(old, "x");
    const past = new Date(Date.now() - 30 * 86400_000);
    fs.utimesSync(old, past, past);
    expect(pruneBackups(c1)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    store.close();
  });
});

describe("owner notifications", () => {
  test("dedupe per key, hourly cap, error log sink", async () => {
    const got: string[] = [];
    const api: any = { sendMessage: async (id: number, text: string) => { got.push(`${id}:${text}`); return {}; } };
    const n = createNotifier(api, config, (s) => s.replaceAll("SECRET", "[x]"));
    n("a", "first SECRET"); n("a", "dupe"); n("b", "second");
    await Promise.resolve();
    expect(got).toEqual([`${OWNER}:first [x]`, `${OWNER}:second`]);
    for (let i = 0; i < 30; i++) n(`k${i}`, "spam");
    await Promise.resolve();
    expect(got.length).toBeLessThanOrEqual(12);
    const seen: string[] = [];
    configureLogger({ level: "silent" });
    notifyOnErrors((k, t) => seen.push(`${k}|${t}`));
    log.error("boom_event", { error: new Error("kaput") });
    log.info("fine");
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("err:boom_event|🚨 boom_event");
    expect(seen[0]).toContain("یه خطا پیش اومد"); // Persian-friendly, not the raw "kaput" dump
    void addLogSink;
  });
});

describe("LLM settings (admin panel)", () => {
  test("validateLlmSettings rejects bad input", async () => {
    const { validateLlmSettings } = await import("../src/llm/settings");
    expect(validateLlmSettings({ provider: "nope" as any })).toBe("unknown provider");
    expect(validateLlmSettings({ provider: "openai", baseUrl: "ftp://x" })).toContain("base URL");
    expect(validateLlmSettings({ provider: "openai", apiKey: "short" })).toContain("too short");
    expect(validateLlmSettings({ provider: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-valid-key-123" })).toBeNull();
    expect(validateLlmSettings({ provider: "gemini", model: "gemini-2.5-flash" })).toBeNull();
  });
  test("resolveLlm merges DB overrides over env", async () => {
    const { resolveLlm, SwappableLLM, buildRoutedLlm } = await import("../src/llm/index");
    const c = cfg({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" });
    // no overrides -> env
    let r = resolveLlm(c, {});
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe(c.LLM_MODEL_RESOLVED);
    // provider override -> new provider defaults
    r = resolveLlm(c, { provider: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-12345678" });
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-5-mini");
    expect(r.baseUrl).toBe("https://api.deepseek.com/v1");
    // explicit model wins
    r = resolveLlm(c, { provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-12345678" });
    expect(r.model).toBe("deepseek-chat");
    // SwappableLLM delegates and swaps
    const mk = (name: string): any => ({ name, chat: async () => ({ parts: [{ type: "text", text: name }] }) });
    const sw = new SwappableLLM(mk("a"));
    expect((await sw.chat({ system: "", messages: [], tools: [] } as any)).parts[0]).toEqual({ type: "text", text: "a" });
    sw.swap(mk("b"));
    expect((await sw.chat({ system: "", messages: [], tools: [] } as any)).parts[0]).toEqual({ type: "text", text: "b" });
    // buildRoutedLlm validates settings (missing openai key throws)
    expect(() => buildRoutedLlm({ provider: "openai", model: "x", modelFast: "x", baseUrl: "https://x/v1" }, c)).toThrow("API key");
    void buildRoutedLlm;
  });
  test("get/setLlmSettings round-trips in the store", async () => {
    const { getLlmSettings, setLlmSettings, effectiveLlmView } = await import("../src/llm/settings");
    const { Store } = await import("../src/memory/store");
    const s = new Store(":memory:");
    expect(getLlmSettings(s)).toEqual({});
    setLlmSettings(s, { provider: "openai", model: "deepseek-chat" });
    expect(getLlmSettings(s)).toEqual({ provider: "openai", model: "deepseek-chat" });
    const c = cfg({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" });
    const view = effectiveLlmView(c, getLlmSettings(s));
    expect(view.provider).toBe("openai");
    expect(view.model).toBe("deepseek-chat");
    expect(view.isOverridden).toBe(true);
    s.close();
  });
});

describe("LLM error translation", () => {
  test("friendlyLlmError maps known errors to Persian", async () => {
    const { friendlyLlmError, ownerErrorSummary } = await import("../src/llm/errors");
    expect(friendlyLlmError(new Error('HTTP 403: {"type":"FreeTierError"}'))).toContain("OpenCode");
    expect(friendlyLlmError(new Error("401 Unauthorized"))).toContain("کلید API");
    expect(friendlyLlmError(new Error("429 rate limit exceeded"))).toContain("محدودیت");
    expect(friendlyLlmError(new Error("model_not_found"))).toContain("مدل");
    expect(friendlyLlmError(new Error("fetch failed"))).toContain("اتصال");
    const generic = friendlyLlmError(new Error("some weird thing happened"));
    expect(generic).toContain("یه خطا پیش اومد");
    expect(generic.length).toBeLessThan(250);
    const summary = ownerErrorSummary("agent_error", new Error("401 bad key"));
    expect(summary).toContain("🚨");
    expect(summary).toContain("کلید API");
  });
});
