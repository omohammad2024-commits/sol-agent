import { fetchRetry, parseSSE } from "../util";
import { normalize, zeroUsage, type LLM, type LLMRequest, type LLMResponse, type Msg, type Part, type Usage } from "./types";

/** Well-known OpenAI-compatible endpoints. Users pick one via OPENAI_BASE_URL. */
export const PRESET_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  xai: "https://api.x.ai/v1",
  opencode: "https://opencode.ai/zen/v1", // OpenCode Zen: free models (Kimi, GLM, MiniMax...), tool calling supported
  kimi: "https://api.kimi.com/coding/v1", // Moonshot Kimi Code gateway
  kilo: "https://api.kilo.ai/api/gateway", // Kilo Code gateway (vendor/model)
  cloudflare: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1",
  // "custom": set OPENAI_BASE_URL to any other OpenAI-compatible endpoint
};

function toOpenAIMessages(system: string, messages: Msg[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of normalize(messages)) {
    if (m.role === "assistant") {
      const toolCalls: any[] = [];
      const texts: string[] = [];
      for (const p of m.parts) {
        if (p.type === "text" && p.text) texts.push(p.text);
        else if (p.type === "tool_call")
          toolCalls.push({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) } });
      }
      const msg: any = { role: "assistant", content: texts.join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // user role: text/images become a user message; tool_results become "tool" messages
      const content: any[] = [];
      const tools: any[] = [];
      for (const p of m.parts) {
        if (p.type === "text") { if (p.text.trim()) content.push({ type: "text", text: p.text }); }
        else if (p.type === "image") content.push({ type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } });
        else if (p.type === "tool_result") tools.push({ role: "tool", tool_call_id: p.id, content: p.content || "(empty)" });
      }
      if (content.length) out.push({ role: "user", content });
      out.push(...tools);
    }
  }
  return out;
}

export function buildOpenAIBody(model: string, req: LLMRequest, stream: boolean) {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(req.system, req.messages),
    max_tokens: req.maxTokens ?? 4096,
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = "auto";
  }
  if (stream) body.stream = true;
  return body;
}

function usageOf(u: any): Usage {
  return {
    input: u?.prompt_tokens ?? 0,
    output: u?.completion_tokens ?? 0,
    cacheRead: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
  };
}

function parseToolCalls(raw: any[]): Part[] {
  const parts: Part[] = [];
  for (const tc of raw ?? []) {
    if (tc?.type !== "function") continue;
    let args: Record<string, unknown> = {};
    try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
    parts.push({ type: "tool_call", id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`, name: tc.function?.name ?? "unknown", args });
  }
  return parts;
}

/**
 * Generic OpenAI-compatible chat completions adapter (OpenAI, DeepSeek, Groq,
 * OpenRouter, Mistral, Together, xAI, Cloudflare Workers AI, Ollama, LM Studio...).
 * Function calling + streaming are supported; providers that lack tool support
 * will simply return text (their API error surfaces to the caller).
 */
export class OpenAICompatibleLLM implements LLM {
  name = "openai";
  constructor(private apiKey: string, public model: string, private baseUrl: string, private extraHeaders: Record<string, string> = {}) {}

  private url() { return `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`; }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const stream = !!req.onText;
    const res = await fetchRetry(this.url(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
      body: JSON.stringify(buildOpenAIBody(this.model, req, stream)),
    }, { timeoutMs: stream ? 180_000 : 120_000 });

    if (!stream) {
      const data: any = JSON.parse(await res.text());
      if (data.error) throw new Error(`OpenAI-compatible API error: ${data.error.message ?? JSON.stringify(data.error)}`);
      const msg = data.choices?.[0]?.message ?? {};
      const parts: Part[] = [];
      if (msg.content) parts.push({ type: "text", text: msg.content });
      parts.push(...parseToolCalls(msg.tool_calls));
      return { parts, usage: usageOf(data.usage), model: data.model ?? this.model };
    }

    // ---- streaming ----
    let text = "";
    const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
    const usage = zeroUsage();
    for await (const ev of parseSSE(res)) {
      if (ev.data.trim() === "[DONE]") break;
      let j: any;
      try { j = JSON.parse(ev.data); } catch { continue; }
      if (j.error) throw new Error(`OpenAI-compatible stream error: ${j.error.message ?? ev.data}`);
      const choice = j.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.content === "string" && delta.content) { text += delta.content; req.onText!(delta.content); }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = (toolCalls[i] ??= { id: "", name: "", args: "" });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
      }
      if (j.usage) Object.assign(usage, usageOf(j.usage));
    }
    const parts: Part[] = [];
    if (text) parts.push({ type: "text", text });
    for (const tc of Object.values(toolCalls)) {
      let args: Record<string, unknown> = {};
      try { args = tc.args ? JSON.parse(tc.args) : {}; } catch { args = {}; }
      if (tc.name) parts.push({ type: "tool_call", id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.name, args });
    }
    return { parts, usage, model: this.model };
  }
}
