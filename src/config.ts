import { z } from "zod";
import path from "node:path";

const csvIds = z
  .string()
  .optional()
  .transform((s) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  );

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : d))
    .pipe(z.number().int().positive());

const int0 = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : d))
    .pipe(z.number().int().min(0));

const str = (d?: string) => z.string().optional().transform((v) => (v && v.trim() !== "" ? v.trim() : d));

const schema = z.object({
  BOT_TOKEN: z.string().min(20, "BOT_TOKEN is required"),
  LLM_PROVIDER: z.enum(["anthropic", "gemini", "openai", "opencode"]).optional().transform((v) => v ?? "opencode"),
  LLM_MODEL: str(),
  ANTHROPIC_API_KEY: str(),
  GEMINI_API_KEY: str(),
  // --- OpenAI-compatible providers (OpenAI, DeepSeek, Groq, OpenRouter, Mistral, Together, xAI, Cloudflare Workers AI, Ollama, LM Studio...) ---
  // Base URL of the /v1 API, e.g. https://api.deepseek.com/v1
  OPENAI_BASE_URL: str("https://api.openai.com/v1"),
  ADMIN_IDS: csvIds,
  TRUSTED_IDS: csvIds,
  PUBLIC_ACCESS: bool(true),
  RATE_LIMIT_PER_MIN: int(12),
  BOT_NAME: str("SOL"),
  BOT_NAMES: str("sol,سول"),
  OWNER_ID: z.string().optional().transform((v) => (v && v.trim() ? Number(v) : undefined)).pipe(z.number().int().positive().optional()),
  OWNER_NAME: str(),
  GROUP_FOLLOWUP_SECONDS: int0(60),
  WEBHOOK_URL: str(),
  WEBHOOK_SECRET: str(),
  PORT: int(8080),
  OPENAI_API_KEY: str(),
  OPENCODE_API_KEY: str(), // optional: personal key lifts Zen free-tier rate limits
  STT_PROVIDER: z.enum(["auto", "gemini", "openai"]).optional().transform((v) => v ?? "auto"),
  STT_MODEL: str(),
  MAX_GIFTS_PER_DAY: int0(3),

  // --- model routing, fallback, cost ---
  LLM_MODEL_FAST: str(),
  ROUTER: bool(true),
  FALLBACK_PROVIDER: z.enum(["anthropic", "gemini", "openai", "opencode"]).optional(),
  FALLBACK_MODEL: str(),
  MODEL_PRICES: str(),
  DAILY_BUDGET_USD: z.string().optional().transform((v) => (v ? Number(v) : 0)).pipe(z.number().min(0)),

  // --- memory ---
  EMBED_PROVIDER: z.enum(["auto", "gemini", "openai", "local"]).optional().transform((v) => v ?? "auto"),
  EMBED_MODEL: str(),
  SUMMARY_TRIGGER: int(40),

  // --- UX ---
  STREAMING: bool(true),
  TTS_PROVIDER: z.enum(["auto", "gemini", "openai", "off"]).optional().transform((v) => v ?? "auto"),
  TTS_MODEL: str(),
  TTS_VOICE: str(),
  VOICE_REPLY: bool(true),

  // --- groups ---
  GROUP_LOG_DEFAULT: bool(false),
  MOD_LLM: bool(true),

  // --- background work ---
  BG_MAX_STEPS: int(20),
  ALERT_INTERVAL_MIN: int(5),
  MAX_JOBS_PER_USER: int(30),

  // --- MCP ---
  MCP_CONFIG: str(),

  // --- panel (Telegram Mini App) ---
  PANEL_URL: str(),

  // --- ops ---
  NOTIFY_OWNER: bool(true),
  LOG_LEVEL: str(),
  LOG_FILE: str(),
  BACKUP_ENABLED: bool(true),
  BACKUP_HOUR: int0(4),
  BACKUP_TO_OWNER: bool(true),
  BACKUP_KEEP_DAYS: int(14),
  BACKUP_PASSPHRASE: str(),
  BACKUP_S3_ENDPOINT: str(),
  BACKUP_S3_BUCKET: str(),
  BACKUP_S3_ACCESS_KEY: str(),
  BACKUP_S3_SECRET_KEY: str(),
  BACKUP_S3_REGION: str("auto"),
  BACKUP_S3_PREFIX: str("sol-agent/"),
  TIMEZONE: str("Asia/Tehran"),
  DATA_DIR: str("./data"),
  MAX_TOOL_STEPS: int(8),
  HISTORY_LIMIT: int(20),
  TOOL_TIMEOUT_MS: int(120000),
  SANDBOX_MODE: z.enum(["docker", "local", "off"]).optional().transform((v) => v ?? "docker"),
  SANDBOX_IMAGE: str("sol-sandbox:latest"),
  SANDBOX_NETWORK: bool(false),
  EXEC_TIMEOUT_MS: int(30000),
  BRAVE_API_KEY: str(),
  GITHUB_TOKEN: str(),
  VIRUSTOTAL_API_KEY: str(),
  IMAGE_MODEL: str("gemini-2.5-flash-image"),
  IRAN_RATES_URL: str("https://call2.tgju.org/ajax.json"),
  YTDLP_COOKIES: str(),
  FONT_PATH: str("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
});

export type Config = z.infer<typeof schema> & { LLM_MODEL_RESOLVED: string; LLM_MODEL_FAST_RESOLVED: string; DATA_DIR_ABS: string; BOT_NAME_LIST: string[]; MCP_CONFIG_PATH: string };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  if (c.LLM_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
  if (c.LLM_PROVIDER === "gemini" && !c.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
  if (c.LLM_PROVIDER === "openai" && !c.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  if (c.FALLBACK_PROVIDER === "openai" && !c.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when FALLBACK_PROVIDER=openai");
  // opencode (OpenCode Zen) works without a key
  if (c.WEBHOOK_URL && !/^https:\/\//i.test(c.WEBHOOK_URL)) throw new Error("WEBHOOK_URL must start with https://");
  const names = [...new Set([c.BOT_NAME!, ...(c.BOT_NAMES ?? "").split(",")].map((x) => x.trim()).filter(Boolean))];
  const defaultModel = c.LLM_PROVIDER === "anthropic" ? "claude-sonnet-5-5" : c.LLM_PROVIDER === "gemini" ? "gemini-2.5-flash" : c.LLM_PROVIDER === "opencode" ? "kimi-k2.5" : "gpt-5-mini";
  const defaultFast = c.LLM_PROVIDER === "anthropic" ? "claude-haiku-5-5" : c.LLM_PROVIDER === "gemini" ? "gemini-2.5-flash-lite" : c.LLM_PROVIDER === "opencode" ? "kimi-k2.5" : "gpt-5-nano";
  const model = c.LLM_MODEL ?? defaultModel;
  const fast = c.LLM_MODEL_FAST ?? defaultFast;
  const dataDir = path.resolve(c.DATA_DIR!);
  return { ...c, LLM_MODEL_RESOLVED: model, LLM_MODEL_FAST_RESOLVED: fast, DATA_DIR_ABS: dataDir, BOT_NAME_LIST: names, MCP_CONFIG_PATH: c.MCP_CONFIG ? path.resolve(c.MCP_CONFIG) : path.join(dataDir, "mcp.json") };
}

/** Values that must never appear in any output sent to users. */
export function secretValues(c: Config): string[] {
  return [c.BOT_TOKEN, c.ANTHROPIC_API_KEY, c.GEMINI_API_KEY, c.BRAVE_API_KEY, c.GITHUB_TOKEN, c.VIRUSTOTAL_API_KEY, c.OPENAI_API_KEY, c.OPENCODE_API_KEY, c.WEBHOOK_SECRET, c.BACKUP_PASSPHRASE, c.BACKUP_S3_ACCESS_KEY, c.BACKUP_S3_SECRET_KEY].filter(
    (x): x is string => !!x && x.length >= 8,
  );
}
