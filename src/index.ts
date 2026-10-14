import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { webhookCallback } from "grammy";
import { loadSystemTemplate } from "./agent";
import { startBackupScheduler } from "./backup";
import { createBot } from "./bot";
import { loadConfig, secretValues } from "./config";
import { buildRoutedLlm, createLLM, resolveLlm, SwappableLLM } from "./llm";
import { getLlmSettings } from "./llm/settings";
import { addLogSink, configureLogger, log } from "./log";
import { startMaintenance } from "./maintenance";
import { McpManager } from "./mcp";
import { Store } from "./memory/store";
import { createNotifier, notifyOnErrors } from "./notify";
import { createPanelHandler } from "./panel";
import { startScheduler } from "./scheduler";
import { makeRedactor } from "./security";
import { buildTools } from "./tools";

void addLogSink;
const startedAt = Date.now();
const config = loadConfig();
const redact = makeRedactor(secretValues(config));
configureLogger({ level: config.LOG_LEVEL, file: config.LOG_FILE ?? null, redact });
process.on("unhandledRejection", (e) => log.error("unhandled_rejection", { error: e }));
process.on("uncaughtException", (e) => {
  if (e instanceof Error && e.message === "Aborted delay") return; // grammY retry sleep cancelled by bot.stop()
  log.error("uncaught_exception", { error: e });
});

fs.mkdirSync(path.join(config.DATA_DIR_ABS, "workspaces"), { recursive: true });
const store = new Store(path.join(config.DATA_DIR_ABS, "sol.db"));
let notify: (key: string, text: string) => void = () => {};
const onFallback = (f: { from: string; to: string; error: string }) => {
  notify("llm_fallback", `⚠️ مدل اصلی خطا داد، رفتم سراغ جایگزین:\n${f.from} → ${f.to}\n${f.error}`);
};
// Hot-swappable LLM: the admin panel rebuilds it when provider/model settings change.
const llm = new SwappableLLM(buildRoutedLlm(resolveLlm(config, getLlmSettings(store)), config, onFallback));
/** Rebuild the LLM from current DB settings (called by the admin panel after save). */
export function reloadLlm() {
  llm.swap(buildRoutedLlm(resolveLlm(config, getLlmSettings(store)), config, onFallback));
  log.info("llm_reloaded", {});
}
let mcp: McpManager | null = null;
const tools = buildTools(config, { getMcp: () => mcp });
mcp = new McpManager(config, store, tools);
const systemTemplate = loadSystemTemplate(path.join(import.meta.dir, "..", "prompts", "system.md"));
const webhookMode = !!config.WEBHOOK_URL;
const publicBase = (config.WEBHOOK_URL ?? config.PANEL_URL)?.replace(/\/+$/, "");
const deps = { config, store, llm, tools, redact, systemTemplate };

const { bot, drain, levelOf, clearCommandMenus, io } = createBot(deps, { startedAt, mode: () => (webhookMode ? "webhook" : "polling") });
notify = createNotifier(bot.api, config, redact);
notifyOnErrors(notify);
const scheduler = startScheduler({ agent: deps, api: bot.api, io, levelOf, notifyOwner: notify });
const stopMaintenance = startMaintenance(config.DATA_DIR_ABS);
const stopBackup = startBackupScheduler(store, config, bot.api, notify);
await mcp.connectAll();

const panel = publicBase ? createPanelHandler({ deps, levelOf, getMcp: () => mcp, api: bot.api, reloadLlm }) : null;
const hash = (salt: string) => crypto.createHash("sha256").update(`${config.BOT_TOKEN}:${salt}`).digest("hex");
const webhook = webhookMode ? { secret: config.WEBHOOK_SECRET ?? hash("webhook-secret").slice(0, 48), route: `/telegram/${hash("webhook-path").slice(0, 24)}` } : null;

let server: ReturnType<typeof Bun.serve> | null = null;
if (webhook || panel) {
  const handleUpdate = webhook ? webhookCallback(bot, "std/http", { secretToken: webhook.secret }) : null;
  server = Bun.serve({
    port: config.PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok");
      if (webhook && handleUpdate && req.method === "POST" && url.pathname === webhook.route) return handleUpdate(req);
      const r = panel ? await panel(req) : null;
      return r ?? new Response("not found", { status: 404 });
    },
  });
}

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log.info("shutdown", { sig });
  scheduler.stop();
  stopMaintenance();
  stopBackup();
  server?.stop();
  if (!webhookMode) await bot.stop().catch(() => {});
  await Promise.race([drain(), new Promise((r) => setTimeout(r, 10_000))]);
  await mcp?.closeAll().catch(() => {});
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const ALLOWED = ["message", "inline_query", "chosen_inline_result", "callback_query"] as const;
const onStart = async (username: string) => {
  log.info("started", {
    bot: `@${username}`, mode: webhookMode ? "webhook" : "polling", llm: `${llm.name}/${config.LLM_MODEL_RESOLVED}`, fast: config.ROUTER ? config.LLM_MODEL_FAST_RESOLVED : null,
    fallback: config.FALLBACK_PROVIDER ?? null, tools: tools.length, owner: config.OWNER_ID ?? null, admins: config.ADMIN_IDS.length, names: config.BOT_NAME_LIST, panel: !!panel, schema: store.schemaVersion(),
  });
  if (!config.OWNER_ID) log.warn("no_owner", { hint: "OWNER_ID is not set: the bot cannot recognize its creator. Ask the bot 'what is my id?' to get your numeric id." });
  if (panel && publicBase) {
    for (const id of new Set([...config.ADMIN_IDS, ...(config.OWNER_ID ? [config.OWNER_ID] : [])])) {
      await bot.api.setChatMenuButton({ chat_id: id, menu_button: { type: "web_app", text: "پنل", web_app: { url: `${publicBase}/panel` } } }).catch(() => {});
    }
  }
};

if (webhook) {
  await bot.init();
  await bot.api.setWebhook(`${config.WEBHOOK_URL!.replace(/\/+$/, "")}${webhook.route}`, { secret_token: webhook.secret, allowed_updates: [...ALLOWED], drop_pending_updates: true });
  await clearCommandMenus().catch((e) => log.warn("delete_commands_failed", { error: e }));
  await onStart(bot.botInfo.username);
} else {
  await bot.api.deleteWebhook().catch(() => {}); // long polling and a webhook cannot coexist
  await clearCommandMenus().catch((e) => log.warn("delete_commands_failed", { error: e }));
  await bot.start({ onStart: (me) => void onStart(me.username), allowed_updates: [...ALLOWED], drop_pending_updates: true });
}
