import type { Api } from "grammy";
import { getGroupCfg, isChatAdmin, setGroupCfg } from "../groups";
import type { Tool, ToolContext } from "../types";
import { truncate } from "../util";

const needGroup = (ctx: ToolContext) => {
  if (ctx.chatType === "private") throw new Error("This only works inside a group chat");
};
async function needGroupAdmin(ctx: ToolContext) {
  needGroup(ctx);
  if (ctx.level === "admin" || ctx.isOwner) return;
  if (!(await isChatAdmin(ctx.api as Api, ctx.chatId, ctx.userId))) throw new Error("Only group admins (or the bot's admins) can do this");
}

export const summarizeGroup: Tool = {
  name: "summarize_group",
  description: "Get the saved recent messages of this group so you can summarize them (who said what, decisions, open questions). Works only where group logging is enabled. Pick last_n or hours; add focus for a specific topic.",
  level: "public",
  untrusted: true,
  taints: true,
  parameters: { type: "object", properties: { last_n: { type: "integer", description: "default 200, max 500" }, hours: { type: "number", description: "only messages from the last N hours" }, focus: { type: "string", description: "optional topic to focus on (you filter, not the tool)" } } },
  async run({ last_n, hours }, ctx) {
    needGroup(ctx);
    const cfg = getGroupCfg(ctx.store, ctx.config, ctx.chatId);
    if (!cfg.log) throw new Error("Message logging is off in this group, so there is nothing to summarize. A group admin can ask me to turn it on (members should be told).");
    const rows = ctx.store.recentGroupMessages(ctx.chatId, { limit: Math.min(Math.max(last_n ?? 200, 1), 500), sinceMs: hours ? Date.now() - hours * 3600_000 : 0 });
    if (!rows.length) return { messages: 0, note: "No saved messages in that range yet" };
    const tz = ctx.config.TIMEZONE!;
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hourCycle: "h23" });
    let text = rows.map((r) => `[${fmt.format(r.ts)}] ${r.name}: ${truncate(r.text, 400)}`).join("\n");
    let dropped = 0;
    while (text.length > 11000 && rows.length > dropped + 1) { dropped++; text = rows.slice(dropped).map((r) => `[${fmt.format(r.ts)}] ${r.name}: ${truncate(r.text, 400)}`).join("\n"); }
    return { messages: rows.length - dropped, from: new Date(rows[dropped]!.ts).toISOString(), to: new Date(rows.at(-1)!.ts).toISOString(), transcript: text };
  },
};

export const groupSettings: Tool = {
  name: "group_settings",
  description:
    "Configure THIS group (group admins / bot admins only). action: show | logging (enabled) | clear_log | welcome (text with {name} {group}, or empty to turn off) | moderation (enabled) | add_rule (text; natural-language rule enforced by AI) | remove_rule (number) | antispam (enabled) | limits (max_warnings, mute_minutes) | warnings | pardon (user_id). Moderation needs the bot to be a group admin with delete/restrict rights.",
  level: "public",
  risky: (a) => !["show", "warnings"].includes(a.action),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["show", "logging", "clear_log", "welcome", "moderation", "add_rule", "remove_rule", "antispam", "limits", "warnings", "pardon"] },
      enabled: { type: "boolean" }, text: { type: "string" }, number: { type: "integer" },
      max_warnings: { type: "integer" }, mute_minutes: { type: "integer" }, user_id: { type: "integer" },
    },
    required: ["action"],
  },
  async run(a, ctx) {
    await needGroupAdmin(ctx);
    const cfg = getGroupCfg(ctx.store, ctx.config, ctx.chatId);
    const save = () => setGroupCfg(ctx.store, ctx.chatId, cfg);
    switch (a.action) {
      case "show":
        return { logging: cfg.log, welcome: cfg.welcome, moderation: cfg.mod, saved_log_messages: ctx.store.recentGroupMessages(ctx.chatId, { limit: 1000 }).length };
      case "logging":
        cfg.log = !!a.enabled; save();
        return { logging: cfg.log, note: cfg.log ? "Messages of this group are now saved (last 1000) for summaries. Tell the members." : "Logging off." };
      case "clear_log":
        ctx.store.clearGroupLog(ctx.chatId);
        return { cleared: true };
      case "welcome":
        cfg.welcome = a.text?.trim() ? truncate(a.text.trim(), 600) : null; save();
        return { welcome: cfg.welcome };
      case "moderation":
        cfg.mod.enabled = !!a.enabled; save();
        return { moderation: cfg.mod.enabled, note: "The bot must be an admin of the group with 'delete messages' and 'restrict members' rights." };
      case "antispam":
        cfg.mod.antispam = !!a.enabled; save();
        return { antispam: cfg.mod.antispam };
      case "add_rule":
        if (!a.text?.trim()) throw new Error("text is required");
        if (cfg.mod.rules.length >= 15) throw new Error("At most 15 rules");
        cfg.mod.rules.push(truncate(a.text.trim(), 300)); save();
        return { rules: cfg.mod.rules };
      case "remove_rule":
        if (!(a.number >= 1 && a.number <= cfg.mod.rules.length)) throw new Error("No rule with that number");
        cfg.mod.rules.splice(a.number - 1, 1); save();
        return { rules: cfg.mod.rules };
      case "limits":
        if (a.max_warnings) cfg.mod.maxWarnings = Math.min(Math.max(a.max_warnings, 1), 10);
        if (a.mute_minutes) cfg.mod.muteMinutes = Math.min(Math.max(a.mute_minutes, 1), 60 * 24 * 7);
        save();
        return { max_warnings: cfg.mod.maxWarnings, mute_minutes: cfg.mod.muteMinutes };
      case "warnings":
        return ctx.store.listWarnings(ctx.chatId);
      case "pardon":
        if (!a.user_id) throw new Error("user_id is required");
        ctx.store.clearWarnings(ctx.chatId, a.user_id);
        return { pardoned: a.user_id };
      default:
        throw new Error("Unknown action");
    }
  },
};

export const groupModerate: Tool = {
  name: "group_moderate",
  description: "Manual moderation in THIS group (group admins / bot admins only): warn, mute (minutes), unmute, kick (remove, can rejoin), ban, unban. Needs the numeric user_id (the metadata line shows reply_to_user for replied-to messages). The bot needs admin rights in the group.",
  level: "public",
  risky: true,
  parameters: {
    type: "object",
    properties: { action: { type: "string", enum: ["warn", "mute", "unmute", "kick", "ban", "unban"] }, user_id: { type: "integer" }, minutes: { type: "integer", description: "mute length (default 60)" }, reason: { type: "string" } },
    required: ["action", "user_id"],
  },
  async run({ action, user_id, minutes, reason }, ctx) {
    await needGroupAdmin(ctx);
    if (ctx.levelOf(user_id) === "admin" || (await isChatAdmin(ctx.api as Api, ctx.chatId, user_id))) throw new Error("Cannot moderate an admin");
    const api = ctx.api as Api;
    const full = { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true };
    switch (action) {
      case "warn": {
        const n = ctx.store.addWarning(ctx.chatId, user_id, reason ?? "manual warning");
        return { warnings: n };
      }
      case "mute":
        await api.restrictChatMember(ctx.chatId, user_id, { can_send_messages: false }, { until_date: Math.floor(Date.now() / 1000) + Math.min(Math.max(minutes ?? 60, 1), 60 * 24 * 30) * 60 });
        return { muted: user_id, minutes: minutes ?? 60 };
      case "unmute":
        await api.restrictChatMember(ctx.chatId, user_id, full);
        return { unmuted: user_id };
      case "kick":
        await api.banChatMember(ctx.chatId, user_id);
        await api.unbanChatMember(ctx.chatId, user_id, { only_if_banned: true });
        return { kicked: user_id };
      case "ban":
        await api.banChatMember(ctx.chatId, user_id);
        return { banned: user_id };
      case "unban":
        await api.unbanChatMember(ctx.chatId, user_id, { only_if_banned: true });
        return { unbanned: user_id };
      default:
        throw new Error("Unknown action");
    }
  },
};

export const groupTools: Tool[] = [summarizeGroup, groupSettings, groupModerate];
