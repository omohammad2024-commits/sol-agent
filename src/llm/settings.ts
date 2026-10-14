import type { Config } from "../config";
import type { Store } from "../memory/store";
import type { LLMProvider } from "./index";
import { PRESET_BASE_URLS } from "./openai";

/** Runtime-overridable LLM settings, stored in the DB (env vars are the defaults). */
export interface LlmSettings {
  provider?: LLMProvider;
  /** Strong model (default depends on provider). */
  model?: string;
  /** Fast model for simple turns (empty = same as strong / router off). */
  modelFast?: string;
  /** Only for provider=openai: base URL of the /v1 API. */
  baseUrl?: string;
  /** Only for provider=openai: API key (stored in DB, masked on read). */
  apiKey?: string;
  fallbackProvider?: LLMProvider;
  fallbackModel?: string;
}

const KEY = "llm_settings";

export function getLlmSettings(store: Store): LlmSettings {
  return store.jsonSetting<LlmSettings>(KEY, {});
}

export function setLlmSettings(store: Store, s: LlmSettings): void {
  store.setJsonSetting(KEY, s);
}

/** Provider options for the admin panel UI. */
export const PROVIDER_OPTIONS: { value: LLMProvider; label: string }[] = [
  { value: "opencode", label: "OpenCode Zen (free) 🆓" },
  { value: "anthropic", label: "Claude (Anthropic)" },
  { value: "gemini", label: "Gemini (Google)" },
  { value: "openai", label: "OpenAI-compatible" },
];

export interface PresetOption { name: string; label: string; baseUrl: string; free?: boolean }

export const OPENAI_PRESETS: PresetOption[] = [
  { name: "openai", label: "OpenAI", baseUrl: PRESET_BASE_URLS.openai! },
  { name: "deepseek", label: "DeepSeek", baseUrl: PRESET_BASE_URLS.deepseek! },
  { name: "groq", label: "Groq", baseUrl: PRESET_BASE_URLS.groq! },
  { name: "openrouter", label: "OpenRouter", baseUrl: PRESET_BASE_URLS.openrouter! },
  { name: "mistral", label: "Mistral", baseUrl: PRESET_BASE_URLS.mistral! },
  { name: "together", label: "Together", baseUrl: PRESET_BASE_URLS.together! },
  { name: "xai", label: "xAI (Grok)", baseUrl: PRESET_BASE_URLS.xai! },
  { name: "opencode", label: "OpenCode Zen (free)", baseUrl: PRESET_BASE_URLS.opencode!, free: true },
  { name: "kimi", label: "Kimi Code", baseUrl: PRESET_BASE_URLS.kimi! },
  { name: "kilo", label: "Kilo", baseUrl: PRESET_BASE_URLS.kilo! },
  { name: "cloudflare", label: "Cloudflare Workers AI", baseUrl: PRESET_BASE_URLS.cloudflare! },
  { name: "custom", label: "Custom…", baseUrl: "" },
];

/** Effective settings: DB overrides merged over env config. Never exposes the raw key. */
export function effectiveLlmView(config: Config, s: LlmSettings) {
  const provider = s.provider ?? config.LLM_PROVIDER;
  const isOpenAI = provider === "openai" || provider === "opencode";
  return {
    provider,
    model: s.model ?? config.LLM_MODEL_RESOLVED,
    modelFast: s.modelFast ?? config.LLM_MODEL_FAST_RESOLVED,
    router: config.ROUTER,
    baseUrl: provider === "openai" ? (s.baseUrl ?? config.OPENAI_BASE_URL) : provider === "opencode" ? "https://opencode.ai/zen/v1" : null,
    hasApiKey: isOpenAI ? !!(s.apiKey ?? config.OPENAI_API_KEY ?? config.OPENCODE_API_KEY) : true,
    apiKeyMasked: isOpenAI ? mask(s.apiKey ?? config.OPENAI_API_KEY ?? config.OPENCODE_API_KEY) : null,
    fallbackProvider: s.fallbackProvider ?? config.FALLBACK_PROVIDER ?? null,
    fallbackModel: s.fallbackModel ?? config.FALLBACK_MODEL ?? null,
    isOverridden: Object.keys(s).length > 0,
  };
}

function mask(k?: string): string | null {
  if (!k) return null;
  return k.length <= 8 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Validate settings from the panel before saving. Returns an error string or null. */
export function validateLlmSettings(s: LlmSettings): string | null {
  if (s.provider && !["anthropic", "gemini", "openai", "opencode"].includes(s.provider)) return "unknown provider";
  if (s.provider === "openai") {
    if (s.baseUrl !== undefined && s.baseUrl !== "" && !/^https?:\/\//i.test(s.baseUrl)) return "base URL must start with http(s)://";
    if (s.apiKey !== undefined && s.apiKey !== "" && s.apiKey.length < 8) return "API key looks too short";
  }
  if (s.fallbackProvider && !["anthropic", "gemini", "openai", "opencode"].includes(s.fallbackProvider)) return "unknown fallback provider";
  for (const f of ["model", "modelFast", "fallbackModel"] as const) {
    const v = s[f];
    if (v !== undefined && (typeof v !== "string" || v.length > 120)) return `bad ${f}`;
  }
  return null;
}
