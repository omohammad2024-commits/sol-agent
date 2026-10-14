import { fetchRetry, parseSSE } from "../util";
import { normalize, zeroUsage, type LLM, type LLMRequest, type LLMResponse, type Msg, type Part, type Usage } from "./types";

export function toAnthropicMessages(messages: Msg[]) {
  return normalize(messages).map((m) => ({
    role: m.role,
    content: m.parts
      .map((p) => {
        switch (p.type) {
          case "text":
            return p.text.trim() ? { type: "text", text: p.text } : null;
          case "image":
            return { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } };
          case "tool_call":
            return { type: "tool_use", id: p.id, name: p.name, input: p.args };
          case "tool_result":
            return { type: "tool_result", tool_use_id: p.id, content: p.content || "(empty)", ...(p.isError ? { is_error: true } : {}) };
        }
      })
      .filter(Boolean) as any[],
  }));
}

function usageOf(u: any): Usage {
  return { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0 };
}

export function buildAnthropicBody(model: string, req: LLMRequest, stream: boolean) {
  const messages = toAnthropicMessages(req.messages);
  // Prompt caching: tools -> system(static) -> history prefix. Up to 3 breakpoints.
  const last = messages.at(-1)?.content.at(-1);
  if (last) last.cache_control = { type: "ephemeral" };
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 4096,
    system: req.systemStatic
      ? [{ type: "text", text: req.systemStatic, cache_control: { type: "ephemeral" } }, ...(req.systemDynamic ? [{ type: "text", text: req.systemDynamic }] : [])]
      : req.system,
    messages,
  };
  if (req.tools.length) {
    const tools: any[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    tools[tools.length - 1].cache_control = { type: "ephemeral" };
    body.tools = tools;
  }
  if (stream) body.stream = true;
  return body;
}

export class AnthropicLLM implements LLM {
  name = "anthropic";
  constructor(private apiKey: string, public model: string, private baseUrl = "https://api.anthropic.com") {}

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const stream = !!req.onText;
    const res = await fetchRetry(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(buildAnthropicBody(this.model, req, stream)),
    }, { timeoutMs: stream ? 180_000 : 120_000 });
    if (!stream) {
      const data: any = JSON.parse(await res.text());
      const parts: Part[] = [];
      for (const b of data.content ?? []) {
        if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") parts.push({ type: "tool_call", id: b.id, name: b.name, args: b.input ?? {} });
      }
      return { parts, usage: usageOf(data.usage), model: this.model };
    }
    // ---- streaming ----
    const blocks: any[] = [];
    const usage = zeroUsage();
    for await (const ev of parseSSE(res)) {
      let j: any;
      try { j = JSON.parse(ev.data); } catch { continue; }
      switch (j.type) {
        case "message_start": Object.assign(usage, usageOf(j.message?.usage)); break;
        case "content_block_start": blocks[j.index] = { ...j.content_block, _json: "" }; break;
        case "content_block_delta": {
          const b = blocks[j.index];
          if (!b) break;
          if (j.delta?.type === "text_delta") { b.text = (b.text ?? "") + j.delta.text; req.onText!(j.delta.text); }
          else if (j.delta?.type === "input_json_delta") b._json += j.delta.partial_json ?? "";
          break;
        }
        case "message_delta": if (j.usage?.output_tokens !== undefined) usage.output = j.usage.output_tokens; break;
        case "error": throw new Error(`Anthropic stream error: ${j.error?.message ?? ev.data}`);
      }
    }
    const parts: Part[] = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") {
        let args: Record<string, unknown> = {};
        try { args = b._json ? JSON.parse(b._json) : (b.input ?? {}); } catch { args = {}; }
        parts.push({ type: "tool_call", id: b.id, name: b.name, args });
      }
    }
    return { parts, usage, model: this.model };
  }
}
