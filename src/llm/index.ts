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

/**
 * Hot-swappable LLM: delegates every chat() to the current inner LLM.
 * The admin panel rebuilds the inner instance when settings change — no restart needed.
 */
export class SwappableLLM implements LLM {
  name = "swappable";
  private current: LLM;
  constructor(initial: LLM) { this.current = initial; }
  swap(next: LLM) { this.current = next; this.name = (next as any).name ?? "swappable"; }
  get inner(): LLM { return this.current; }
  chat(req: LLMRequest): Promise<LLMResponse> { return this.current.chat(req); }
}

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

const STRONG_DEFAULT_MODEL: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-2.5-flash",
  openai: "gpt-5-mini",
};

const FAST_DEFAULT_MODEL: Record<LLMProvider, string> = {
  anthropic: "claude-haiku-5-5",
  gemini: "gemini-2.5-flash-lite",
  openai: "gpt-5-nano",
};

export interface ResolvedLlm {
  provider: LLMProvider;
  model: string;
  modelFast: string;
  baseUrl?: string;
  apiKey?: string;
  fallbackProvider?: LLMProvider;
  fallbackModel?: string;
}

/** Merge DB overrides (from the admin panel) over env config. */
export function resolveLlm(c: Config, s: { provider?: LLMProvider; model?: string; modelFast?: string; baseUrl?: string; apiKey?: string; fallbackProvider?: LLMProvider; fallbackModel?: string }): ResolvedLlm {
  const provider = s.provider ?? c.LLM_PROVIDER;
  const model = s.model || (s.provider && s.provider !== c.LLM_PROVIDER ? STRONG_DEFAULT_MODEL[provider] : c.LLM_MODEL_RESOLVED);
  const modelFast = s.modelFast || (s.provider && s.provider !== c.LLM_PROVIDER ? FAST_DEFAULT_MODEL[provider] : c.LLM_MODEL_FAST_RESOLVED);
  return {
    provider,
    model,
    modelFast,
    baseUrl: provider === "openai" ? s.baseUrl || c.OPENAI_BASE_URL : undefined,
    apiKey: provider === "openai" ? s.apiKey || c.OPENAI_API_KEY : undefined,
    fallbackProvider: s.fallbackProvider ?? c.FALLBACK_PROVIDER ?? undefined,
    fallbackModel: s.fallbackModel || c.FALLBACK_MODEL || undefined,
  };
}

function makeFromResolved(r: ResolvedLlm, c: Config): LLM {
  if (r.provider === "gemini") return new GeminiLLM(c.GEMINI_API_KEY!, r.model);
  if (r.provider === "openai") {
    if (!r.apiKey) throw new Error("OPENAI_API_KEY (or panel API key) is required for the openai provider");
    return new OpenAICompatibleLLM(r.apiKey, r.model, r.baseUrl!);
  }
  return new AnthropicLLM(c.ANTHROPIC_API_KEY!, r.model);
}

/** Build the full routed LLM from resolved settings (used at startup and on panel save). */
export function buildRoutedLlm(r: ResolvedLlm, c: Config, onFallback?: ConstructorParameters<typeof RoutedLLM>[1]): RoutedLLM {
  const strong = makeFromResolved(r, c);
  const fast = c.ROUTER && r.modelFast !== r.model
    ? makeFromResolved({ ...r, model: r.modelFast }, c)
    : undefined;
  const fallbacks: LLM[] = [];
  if (r.fallbackProvider) {
    const fm = r.fallbackModel || FALLBACK_DEFAULT_MODEL[r.fallbackProvider];
    try {
      fallbacks.push(makeFromResolved({
        provider: r.fallbackProvider, model: fm, modelFast: fm,
        baseUrl: r.fallbackProvider === "openai" ? r.baseUrl : undefined,
        apiKey: r.fallbackProvider === "openai" ? r.apiKey : undefined,
      }, c));
    } catch { /* missing key -> skip fallback */ }
  }
  return new RoutedLLM({ strong, fast, fallbacks }, onFallback);
}

export function createLLM(c: Config, onFallback?: ConstructorParameters<typeof RoutedLLM>[1]): RoutedLLM {
  return buildRoutedLlm(resolveLlm(c, {}), c, onFallback);
}
