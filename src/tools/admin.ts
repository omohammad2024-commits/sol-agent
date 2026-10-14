import { applyAccess } from "../access";
import { runBackup } from "../backup";
import type { McpManager } from "../mcp";
import { dayKey } from "../pricing";
import type { Tool, ToolContext } from "../types";
import { sleep, truncate } from "../util";

/** The creator (verified by Telegram id) can manage the bot from anywhere; other admins only in private chats. */
const needPrivate = (ctx: ToolContext) => {
  if (ctx.chatType !== "private" && !ctx.isOwner) throw new Error("Admin actions work only in a private chat with an admin (only the creator can use them in groups).");
};
const day = 86_400_000;
const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

/** Natural-language admin panel: the creator just asks, the agent calls these. All admin-level, private-chat only. */
export function makeAdminTools(getTools: () => Tool[], getMcp: () => McpManager | null = () => null): Tool[] {
  const stats: Tool = {
    name: "admin_stats",
    description: "Bot statistics: users, messages, memories, pending reminders, tool usage and errors in the last 24h, uptime, model.",
    level: "admin",
    parameters: { type: "object", properties: {} },
    async run(_a, ctx) {
      needPrivate(ctx);
      const d = ctx.store.toolStats(Date.now() - day);
      return {
        model: `${ctx.config.LLM_PROVIDER}/${ctx.config.LLM_MODEL_RESOLVED}`, mode: ctx.config.WEBHOOK_URL ? "webhook" : "polling",
        uptime_minutes: Math.round(process.uptime() / 60), schema_version: ctx.store.schemaVersion(), ...ctx.store.overview(),
        cost_today_usd: +ctx.store.usageSummary(dayKey(Date.now(), ctx.config.TIMEZONE!)).cost.toFixed(4),
        tool_calls_24h: d.reduce((a, b) => a + b.n, 0), tool_errors_24h: d.reduce((a, b) => a + b.errors, 0), top_tools: d.slice(0, 8),
      };
    },
  };

  const users: Tool = {
    name: "admin_users",
    description: "List the most recently active users with their access level and message counts.",
    level: "admin",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "default 15, max 40" } } },
    async run({ limit }, ctx) {
      needPrivate(ctx);
      return ctx.store.recentUsers(Math.min(Math.max(limit ?? 15, 1), 40)).map((u) => ({
        id: u.user_id, name: u.first_name, username: u.username, level: ctx.levelOf(u.user_id), messages: u.msg_count, last_seen: when(u.last_seen),
      }));
    },
  };

  const rules: Tool = {
    name: "admin_rules",
    description: "Manage the extra behavior rules that are added to your own instructions and apply immediately to everyone. action: list | add (text) | remove (number from the list).",
    level: "admin",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["list", "add", "remove"] }, text: { type: "string", description: "rule text for add (max 500 chars)" }, number: { type: "integer", description: "1-based rule number for remove" } },
      required: ["action"],
    },
    async run({ action, text, number }, ctx) {
      needPrivate(ctx);
      if (action === "add") {
        if (!text?.trim()) throw new Error("text is required");
        if (text.length > 500) throw new Error("Rule too long (max 500 chars)");
        if (ctx.store.getRules().length >= 30) throw new Error("Maximum 30 rules; remove one first");
        return { added: true, number: ctx.store.addRule(text.trim()) };
      }
      if (action === "remove") {
        if (typeof number !== "number") throw new Error("number is required");
        if (!ctx.store.delRule(number)) throw new Error("No rule with that number");
        return { removed: true, rules: ctx.store.getRules() };
      }
      return { rules: ctx.store.getRules() };
    },
  };

  const access: Tool = {
    name: "admin_access",
    description:
      "Change a user's access by numeric Telegram id. action: grant (trusted tools) | ban (the bot ignores them; works on admins too, creator only) | revoke (back to normal: unban / remove runtime admin) | make_admin (creator only). Only the creator can ban or change admins, and the creator's own access can never be changed.",
    level: "admin",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["grant", "ban", "revoke", "make_admin"] }, user_id: { type: "integer" } }, required: ["action", "user_id"] },
    async run({ action, user_id }, ctx) {
      needPrivate(ctx);
      return applyAccess({ store: ctx.store, config: ctx.config, levelOf: ctx.levelOf, actorIsOwner: ctx.isOwner, action, userId: user_id });
    },
  };

  const toolSwitch: Tool = {
    name: "admin_tools",
    description: "List all tools with their on/off state, or switch a tool off/on at runtime. action: list | disable | enable (name).",
    level: "admin",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "disable", "enable"] }, name: { type: "string" } }, required: ["action"] },
    async run({ action, name }, ctx) {
      needPrivate(ctx);
      const tools = getTools();
      const off = new Set(ctx.store.getDisabledTools());
      if (action === "list") return tools.map((t) => ({ name: t.name, level: t.level, powerful: !!t.risky, on: !off.has(t.name) && (!t.enabled || t.enabled(ctx.config)) }));
      if (!name || !tools.some((t) => t.name === name)) throw new Error("Unknown tool name");
      if (name.startsWith("admin_") || name === "whoami") throw new Error("Core admin tools cannot be switched off (you would lock yourself out)");
      ctx.store.setToolDisabled(name, action === "disable");
      return { name, on: action === "enable" };
    },
  };

  const log: Tool = {
    name: "admin_log",
    description: "Recent tool executions (who ran what, success/failure, errors).",
    level: "admin",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "default 15, max 40" } } },
    async run({ limit }, ctx) {
      needPrivate(ctx);
      return ctx.store.recentToolLog(Math.min(Math.max(limit ?? 15, 1), 40)).map((r) => ({ time: when(r.ts), user: r.user_id, tool: r.tool, ok: !!r.ok, ms: r.ms, error: r.err ? truncate(r.err, 120) : undefined }));
    },
  };

  const broadcast: Tool = {
    name: "admin_broadcast",
    description: "Send a message to every known (non-banned) user in private. Only users who started the bot receive it.",
    level: "admin",
    parameters: { type: "object", properties: { text: { type: "string", description: "max 3000 chars" } }, required: ["text"] },
    async run({ text }, ctx) {
      needPrivate(ctx);
      if (text.length > 3000) throw new Error("Message too long");
      let sent = 0, failed = 0;
      for (const id of ctx.store.allUserIds().filter((id) => ctx.levelOf(id) !== "banned")) {
        try { await ctx.api.sendMessage(id, text); sent++; } catch { failed++; }
        await sleep(60);
      }
      return { sent, failed };
    },
  };

  const forget: Tool = {
    name: "admin_forget_user",
    description: "Permanently delete everything stored about a user (memories, history, reminders, profile).",
    level: "admin",
    parameters: { type: "object", properties: { user_id: { type: "integer" } }, required: ["user_id"] },
    async run({ user_id }, ctx) {
      needPrivate(ctx);
      ctx.store.forgetUser(user_id);
      return { forgotten: user_id };
    },
  };

  const costs: Tool = {
    name: "admin_costs",
    description: "LLM usage and ESTIMATED cost: totals, per model, per day and top users. period: today | 7d | 30d. Prices come from a built-in table / MODEL_PRICES and are estimates.",
    level: "admin",
    parameters: { type: "object", properties: { period: { type: "string", enum: ["today", "7d", "30d"] } } },
    async run({ period }, ctx) {
      needPrivate(ctx);
      const days = period === "30d" ? 30 : period === "7d" ? 7 : 1;
      const since = dayKey(Date.now() - (days - 1) * 86_400_000, ctx.config.TIMEZONE!);
      const r4 = (n: number) => +Number(n ?? 0).toFixed(4);
      const sum = ctx.store.usageSummary(since);
      return {
        since, calls: sum.calls, usd_estimate: r4(sum.cost), unpriced_calls: sum.unpriced ?? 0,
        tokens: { input: sum.input, output: sum.output, cache_read: sum.cache_read, cache_write: sum.cache_write },
        by_model: ctx.store.usageByModel(since).map((m) => ({ model: m.model, calls: m.calls, usd: r4(m.cost), unpriced: m.unpriced })),
        by_day: ctx.store.usageByDay(since).map((d) => ({ day: d.day, calls: d.calls, usd: r4(d.cost) })),
        top_users: ctx.store.topSpenders(since, 8).map((u) => ({ user_id: u.user_id, calls: u.calls, usd: r4(u.cost), tokens: u.tokens })),
        daily_budget_per_user_usd: ctx.config.DAILY_BUDGET_USD || "off",
      };
    },
  };

  const mcp: Tool = {
    name: "admin_mcp",
    description:
      "Connect/disconnect external MCP tool servers (remote URL only from chat; local command servers go in the config file). action: list | add | remove. Their tools appear as mcp_<name>_<tool>. Avoid pasting secrets in chat; prefer the config file for servers that need tokens.",
    level: "admin",
    risky: (a) => a.action !== "list",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"] },
        name: { type: "string", description: "short id: a-z 0-9 _" },
        url: { type: "string", description: "Streamable-HTTP MCP endpoint" },
        authorization: { type: "string", description: "optional Authorization header value, e.g. 'Bearer xxx'" },
        level: { type: "string", enum: ["public", "trusted", "admin"], description: "who may use the tools (default admin)" },
        powerful_tools: { type: "array", items: { type: "string" }, description: "tool names that change things (treated as powerful actions)" },
      },
      required: ["action"],
    },
    async run(a, ctx) {
      needPrivate(ctx);
      const m = getMcp();
      if (!m) throw new Error("MCP is not available");
      if (a.action === "list") return m.list();
      if (!a.name) throw new Error("name is required");
      if (a.action === "remove") {
        const ok = await m.remove(a.name);
        m.persistChatServers();
        return { removed: ok };
      }
      if (!a.url) throw new Error("url is required");
      const tools = await m.add({ name: a.name, url: a.url, headers: a.authorization ? { Authorization: a.authorization } : undefined, level: a.level ?? "admin", powerful: a.powerful_tools }, "chat");
      m.persistChatServers();
      return { connected: a.name, tools };
    },
  };

  const backup: Tool = {
    name: "admin_backup",
    description: "Run a database backup now (compressed, encrypted if BACKUP_PASSPHRASE is set; sent to the creator and/or uploaded to S3 when configured).",
    level: "admin",
    parameters: { type: "object", properties: {} },
    async run(_a, ctx) {
      needPrivate(ctx);
      const r = await runBackup(ctx.store, ctx.config, ctx.api);
      return { file: r.result.file.split("/").pop(), mb: +(r.result.bytes / 1048576).toFixed(2), encrypted: r.result.encrypted, sent_to_owner: r.sentToOwner, s3_key: r.s3Key, pruned_old: r.pruned, problems: r.errors };
    },
  };

  return [stats, costs, users, rules, access, toolSwitch, log, broadcast, forget, mcp, backup];
}
