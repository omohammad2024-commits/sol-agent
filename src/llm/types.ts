export type Part =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string } // base64
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; meta?: any }
  | { type: "tool_result"; id: string; name: string; content: string; isError?: boolean };

export interface Msg {
  role: "user" | "assistant";
  parts: Part[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export type Tier = "fast" | "strong";

export interface LLMRequest {
  /** Full system prompt (used as-is when systemStatic is absent). */
  system: string;
  /** Optional split for prompt caching: the stable part first, the per-message part second. */
  systemStatic?: string;
  systemDynamic?: string;
  messages: Msg[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** Which model class to use (RoutedLLM). */
  tier?: Tier;
  /** If given, the adapter streams and calls this with every text delta. */
  onText?: (delta: string) => void;
  /** Called when a failed attempt is abandoned (fallback) so the caller can discard streamed text. */
  onReset?: () => void;
}

export interface LLMResponse {
  parts: Part[];
  usage?: Usage;
  model?: string;
}

export interface LLM {
  name: string;
  chat(req: LLMRequest): Promise<LLMResponse>;
}

/** Merge adjacent same-role messages and make sure the first message is from the user. */
export function normalize(messages: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const m of messages) {
    if (!m.parts.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.parts = [...last.parts, ...m.parts];
    else out.push({ role: m.role, parts: [...m.parts] });
  }
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}
