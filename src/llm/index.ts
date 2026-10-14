import type { Config } from "../config";
import { log } from "../log";
import { AnthropicLLM } from "./anthropic";
import { GeminiLLM } from "./gemini";
import { OpenAICompatibleLLM } from "./openai";
import type { LLM, LLMRequest, LLMResponse } from "./types";

export type { LLM } from "./types";

/**
 * Tier routing + automatic fallback.
 *  - tier "fast": cheap model first (falls back to strong, then to the fallback provider)
 *  - tier "strong" (default): strong model first (then fallback provider, then fast)
 */
export class RoutedLLM implements LLM {
  name: string;
  constructor(
    private slots: { strong: LLM; fast?: LLM; fallbacks: LLM[] },
    private onFallback?: (info: { from: string; to: string; error: string }) => void,
  ) {
    this.name = (slots.strong as any).name;
  }

  private label(l: LLM) { return `${l.name}/${(l as any).model ?? "?"}`; }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const { strong, fast, fallbacks } = this.slots;
    const chain: LLM[] =
      req.tier === "fast" && fast ? [fast, strong, ...fallbacks] : [strong, ...fallbacks, ...(fast ? [fast] : [])];
    let firstErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      const llm = chain[i]!;
      try {
        return await llm.chat(req);
      } catch (e) {
        firstErr ??= e;
        const next = chain[i + 1];
        const msg = e instanceof Error ? e.message : String(e);
        log.warn("llm_failed", { model: this.label(llm), error: msg.slice(0, 300), next: next ? this.label(next) : null });
        if (next) {
          req.onReset?.();
          this.onFallback?.({ from: this.label(llm), to: this.label(next), error: msg.slice(0, 200) });
        }
        // a stream that already emitted text cannot be transparently retried by the caller; deltas simply restart
      }
    }
    throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
  }
}

export type LLMProvider = "anthropic" | "gemini" | "openai";

function make(provider: LLMProvider, model: string, c: Config): LLM {
  if (provider === "gemini") return new GeminiLLM(c.GEMINI_API_KEY!, model);
  if (provider === "openai") return new OpenAICompatibleLLM(c.OPENAI_API_KEY!, model, c.OPENAI_BASE_URL!);
  return new AnthropicLLM(c.ANTHROPIC_API_KEY!, model);
}

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-2.5-flash",
  openai: "gpt-5-mini",
};

export function createLLM(c: Config, onFallback?: ConstructorParameters<typeof RoutedLLM>[1]): RoutedLLM {
  const strong = make(c.LLM_PROVIDER, c.LLM_MODEL_RESOLVED, c);
  const fast = c.ROUTER && c.LLM_MODEL_FAST_RESOLVED !== c.LLM_MODEL_RESOLVED ? make(c.LLM_PROVIDER, c.LLM_MODEL_FAST_RESOLVED, c) : undefined;
  const fallbacks: LLM[] = [];
  if (c.FALLBACK_PROVIDER) {
    const key = c.FALLBACK_PROVIDER === "gemini" ? c.GEMINI_API_KEY : c.FALLBACK_PROVIDER === "openai" ? c.OPENAI_API_KEY : c.ANTHROPIC_API_KEY;
    if (key) fallbacks.push(make(c.FALLBACK_PROVIDER, c.FALLBACK_MODEL ?? FALLBACK_DEFAULT_MODEL[c.FALLBACK_PROVIDER], c));
  }
  return new RoutedLLM({ strong, fast, fallbacks }, onFallback);
}
