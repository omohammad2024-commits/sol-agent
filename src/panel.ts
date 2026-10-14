import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyAccess, type AccessAction } from "./access";
import type { AgentDeps } from "./agent";
import { runBackup } from "./backup";
import { buildRoutedLlm, resolveLlm } from "./llm";
import { effectiveLlmView, getLlmSettings, OPENAI_PRESETS, PROVIDER_OPTIONS, setLlmSettings, validateLlmSettings, type LlmSettings } from "./llm/settings";
import { log } from "./log";
import type { McpManager } from "./mcp";
import { dayKey } from "./pricing";
import type { Level, LevelOf } from "./types";

export interface InitUser { id: number; first_name?: string; username?: string }

/** Validate Telegram Mini App `initData` (HMAC-SHA256 with a key derived from the bot token). */
export function validateInitData(initData: string, botToken: string, maxAgeSec = 3600, now = Date.now()): { ok: true; user: InitUser } | { ok: false; reason: string } {
  if (!initData || initData.length > 4096) return { ok: false, reason: "missing" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "bad hash" };
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest();
  const given = Buffer.from(hash, "hex");
  if (calc.length !== given.length || !crypto.timingSafeEqual(calc, given)) return { ok: false, reason: "signature mismatch" };
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec || authDate - now / 1000 > 300) return { ok: false, reason: "expired" };
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    if (!user || !Number.isInteger(user.id)) return { ok: false, reason: "no user" };
    return { ok: true, user };
  } catch { return { ok: false, reason: "bad user" }; }
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS } });

export interface PanelDeps { deps: AgentDeps; levelOf: LevelOf; getMcp: () => McpManager | null; api: any; htmlFile?: string; reloadLlm?: () => void }

/** Telegram Mini App admin panel. Returns null for paths that are not the panel's. */
export function createPanelHandler(p: PanelDeps): (req: Request) => Promise<Response | null> {
  const { deps } = p;
  const { config, store } = deps;
  const html = () => fs.readFileSync(p.htmlFile ?? path.join(import.meta.dir, "panel.html"), "utf8");
  const hits = new Map<number, { n: number; reset: number }>();

  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/panel" || url.pathname === "/panel/") {
      return new Response(html(), { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
    }
    if (!url.pathname.startsWith("/panel/api/")) return null;

    const auth = validateInitData(req.headers.get("x-tg-init-data") ?? "", config.BOT_TOKEN);
    if (!auth.ok) return json({ error: "unauthorized" }, 401);
    const uid = auth.user.id;
    if (p.levelOf(uid) !== "admin") return json({ error: "forbidden" }, 403);
    const now = Date.now(), h = hits.get(uid);
    if (!h || now > h.reset) hits.set(uid, { n: 1, reset: now + 60_000 }); else if (++h.n > 90) return json({ error: "rate limited" }, 429);
    const isOwner = !!config.OWNER_ID && uid === config.OWNER_ID;
    const route = url.pathname.slice("/panel/api/".length);
    const body = async (): Promise<any> => {
      const t = await req.text();
      if (t.length > 20_000) throw new Error("body too large");
      return t ? JSON.parse(t) : {};
    };

    try {
      if (req.method === "GET") {
        switch (route) {
          case "overview": {
            const today = dayKey(now, config.TIMEZONE!);
            const u = store.usageSummary(today);
            return json({
              me: { id: uid, owner: isOwner }, model: `${config.LLM_PROVIDER}/${config.LLM_MODEL_RESOLVED}`, fast_model: config.ROUTER ? config.LLM_MODEL_FAST_RESOLVED : null,
              uptime_min: Math.round(process.uptime() / 60), ...store.overview(), tools: deps.tools.length, cost_today_usd: +u.cost.toFixed(4), calls_today: u.calls,
              mcp: p.getMcp()?.list() ?? [], schema_version: store.schemaVersion(),
            });
          }
          case "users":
            return json(store.recentUsers(50).map((x) => ({ id: x.user_id, name: x.first_name, username: x.username, level: p.levelOf(x.user_id), messages: x.msg_count, last_seen: x.last_seen })));
          case "rules":
            return json(store.getRules());
          case "tools": {
            const off = new Set(store.getDisabledTools());
            return json(deps.tools.map((t) => ({ name: t.name, level: t.level, powerful: !!t.risky, on: !off.has(t.name) })));
          }
          case "log":
            return json(store.recentToolLog(40));
          case "costs": {
            const days = url.searchParams.get("period") === "30d" ? 30 : url.searchParams.get("period") === "7d" ? 7 : 1;
            const since = dayKey(now - (days - 1) * 86_400_000, config.TIMEZONE!);
            return json({ since, summary: store.usageSummary(since), by_model: store.usageByModel(since), by_day: store.usageByDay(since), top_users: store.topSpenders(since, 8) });
          }
          case "llm":
            return json({ current: effectiveLlmView(config, getLlmSettings(store)), providers: PROVIDER_OPTIONS, presets: OPENAI_PRESETS });
        }
      } else if (req.method === "POST") {
        const b = await body();
        switch (route) {
          case "rules/add":
            if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 500) return json({ error: "bad text" }, 400);
            if (store.getRules().length >= 30) return json({ error: "max 30 rules" }, 400);
            return json({ number: store.addRule(b.text.trim()) });
          case "rules/remove":
            return json({ removed: store.delRule(Number(b.number)) });
          case "tools/toggle": {
            const name = String(b.name ?? "");
            if (!deps.tools.some((t) => t.name === name)) return json({ error: "unknown tool" }, 400);
            if (name.startsWith("admin_") || name === "whoami") return json({ error: "core tool" }, 400);
            store.setToolDisabled(name, !b.on);
            return json({ name, on: !!b.on });
          }
          case "access":
            return json(applyAccess({ store, config, levelOf: p.levelOf, actorIsOwner: isOwner, action: b.action as AccessAction, userId: Number(b.user_id) }));
          case "backup": {
            const r = await runBackup(store, config, p.api);
            return json({ file: path.basename(r.result.file), bytes: r.result.bytes, encrypted: r.result.encrypted, sent_to_owner: r.sentToOwner, problems: r.errors });
          }
          case "llm/save": {
            const s: LlmSettings = {};
            for (const k of ["provider", "model", "modelFast", "baseUrl", "apiKey", "fallbackProvider", "fallbackModel"] as const) {
              const v = typeof b[k] === "string" ? b[k].trim() : "";
              if (v) (s as any)[k] = v;
            }
            const err = validateLlmSettings(s);
            if (err) return json({ error: err }, 400);
            // Empty fields mean "keep env default". To clear an override, use llm/reset.
            setLlmSettings(store, { ...getLlmSettings(store), ...s });
            try {
              if (p.reloadLlm) p.reloadLlm();
              else buildRoutedLlm(resolveLlm(config, getLlmSettings(store)), config); // dry-run: validates the new settings
            } catch (e) {
              return json({ error: e instanceof Error ? e.message : "reload failed" }, 400);
            }
            return json({ ok: true, current: effectiveLlmView(config, getLlmSettings(store)) });
          }
          case "llm/reset": {
            setLlmSettings(store, {});
            try { p.reloadLlm?.(); } catch (e) {
              return json({ error: e instanceof Error ? e.message : "reload failed" }, 400);
            }
            return json({ ok: true, current: effectiveLlmView(config, getLlmSettings(store)) });
          }
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      log.warn("panel_error", { route, error: e });
      return json({ error: e instanceof Error ? e.message : "error" }, 400);
    }
  };
}
void (null as unknown as Level);
