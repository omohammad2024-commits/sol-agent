import { fetchRetry, parseSSE, rid } from "../util";
import { normalize, zeroUsage, type LLM, type LLMRequest, type LLMResponse, type Msg, type Part, type Usage } from "./types";

/** Gemini's schema dialect is an OpenAPI subset: drop keys it rejects. */
export function cleanSchema(s: any): any {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (s && typeof s === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "additionalProperties" || k === "default" || k === "$schema" || k === "$id" || k === "examples") continue;
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return s;
}

export function toGeminiContents(messages: Msg[]) {
  return normalize(messages).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.parts
      .map((p) => {
        switch (p.type) {
          case "text":
            return p.text.trim() ? { text: p.text } : null;
          case "image":
            return { inlineData: { mimeType: p.mime, data: p.data } };
          case "tool_call":
            return { functionCall: { name: p.name, args: p.args }, ...(p.meta?.thoughtSignature ? { thoughtSignature: p.meta.thoughtSignature } : {}) };
          case "tool_result":
            return { functionResponse: { name: p.name, response: p.isError ? { error: p.content } : { result: p.content } } };
        }
      })
      .filter(Boolean),
  }));
}

function usageOf(u: any): Usage {
  if (!u) return zeroUsage();
  const cached = u.cachedContentTokenCount ?? 0;
  return { input: Math.max((u.promptTokenCount ?? 0) - cached, 0), output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cacheRead: cached, cacheWrite: 0 };
}

function collect(chunks: any[]): { parts: Part[]; usage: Usage } {
  const parts: Part[] = [];
  let usage = zeroUsage();
  for (const c of chunks) {
    if (c.usageMetadata) usage = usageOf(c.usageMetadata);
    for (const p of c.candidates?.[0]?.content?.parts ?? []) {
      if (p.functionCall) parts.push({ type: "tool_call", id: `g_${rid(4)}`, name: p.functionCall.name, args: p.functionCall.args ?? {}, meta: p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : undefined });
      else if (typeof p.text === "string" && p.text && !p.thought) {
        const last = parts[parts.length - 1];
        if (last?.type === "text") last.text += p.text; else parts.push({ type: "text", text: p.text });
      }
    }
  }
  return { parts, usage };
}

export class GeminiLLM implements LLM {
  name = "gemini";
  constructor(private apiKey: string, public model: string, private baseUrl = "https://generativelanguage.googleapis.com") {}

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      generationConfig: { maxOutputTokens: req.maxTokens ?? 4096 },
    };
    if (req.tools.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: cleanSchema(t.parameters) })) }];
    const stream = !!req.onText;
    const url = `${this.baseUrl}/v1beta/models/${this.model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const res = await fetchRetry(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
    }, { timeoutMs: stream ? 180_000 : 120_000 });
    const chunks: any[] = [];
    if (!stream) chunks.push(JSON.parse(await res.text()));
    else {
      for await (const ev of parseSSE(res)) {
        let j: any;
        try { j = JSON.parse(ev.data); } catch { continue; }
        chunks.push(j);
        for (const p of j.candidates?.[0]?.content?.parts ?? []) if (typeof p.text === "string" && p.text && !p.thought) req.onText!(p.text);
      }
    }
    if (!chunks.some((c) => c.candidates?.[0])) {
      const fb = chunks.find((c) => c.promptFeedback)?.promptFeedback;
      throw new Error(`Gemini returned no candidates${fb ? `: ${JSON.stringify(fb)}` : ""}`);
    }
    const { parts, usage } = collect(chunks);
    return { parts, usage, model: this.model };
  }
}
