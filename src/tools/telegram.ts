import type { Tool } from "../types";
import { httpJson, truncate } from "../util";

// ---- telegra.ph ----
function toNodes(content: string): any[] {
  const nodes: any[] = [];
  for (const raw of content.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    const img = block.match(/^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/);
    if (img) { nodes.push({ tag: "figure", children: [{ tag: "img", attrs: { src: img[1] } }] }); continue; }
    const h = block.match(/^(#{1,6})\s+(.+)$/);
    if (h && !block.includes("\n")) { nodes.push({ tag: h[1]!.length <= 2 ? "h3" : "h4", children: [h[2]] }); continue; }
    if (block.startsWith(">")) { nodes.push({ tag: "blockquote", children: [block.replace(/^>\s?/gm, "")] }); continue; }
    if (/^([-*]\s)/.test(block)) { nodes.push({ tag: "ul", children: block.split("\n").map((l) => ({ tag: "li", children: [l.replace(/^[-*]\s+/, "")] })) }); continue; }
    nodes.push({ tag: "p", children: [block.replace(/\n/g, " ")] });
  }
  return nodes;
}

export const publishTelegraph: Tool = {
  name: "publish_telegraph",
  description: "Publish a long article to telegra.ph and return its URL. Content is plain text: blank-line-separated paragraphs, '# Heading', '- bullets', '> quote', '![](image-url)'.",
  level: "trusted",
  parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, author: { type: "string" } }, required: ["title", "content"] },
  async run({ title, content, author }, ctx) {
    let token = ctx.store.getSetting("telegraph_token");
    if (!token) {
      const acc = await httpJson<any>(`https://api.telegra.ph/createAccount?short_name=${encodeURIComponent(ctx.config.BOT_NAME!.slice(0, 32))}&author_name=${encodeURIComponent(ctx.config.BOT_NAME!)}`);
      if (!acc.ok) throw new Error(`Telegraph: ${acc.error}`);
      token = acc.result.access_token as string;
      ctx.store.setSetting("telegraph_token", token);
    }
    const nodes = toNodes(content);
    if (!nodes.length) throw new Error("Empty content");
    const r = await httpJson<any>("https://api.telegra.ph/createPage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: token, title: truncate(title, 256), author_name: author ?? ctx.displayName, content: nodes, return_content: false }),
    });
    if (!r.ok) throw new Error(`Telegraph: ${r.error}`);
    return { url: r.result.url };
  },
};

// ---- gifts (Telegram Stars) ----
export const listGifts: Tool = {
  name: "list_gifts",
  description: "List the gifts the bot can send with Telegram Stars (ids, star prices).",
  level: "admin",
  parameters: { type: "object", properties: {} },
  async run(_a, ctx) {
    const r = await (ctx.api.raw as any).getAvailableGifts();
    return (r.gifts ?? []).map((g: any) => ({ id: g.id, stars: g.star_count, emoji: g.sticker?.emoji, remaining: g.remaining_count }));
  },
};

export const sendGift: Tool = {
  name: "send_gift",
  description: "Send a Telegram gift (paid with the bot's Stars balance) to a user. Use list_gifts first for ids.",
  level: "admin",
  risky: true,
  parameters: {
    type: "object",
    properties: { user_id: { type: "integer" }, gift_id: { type: "string" }, text: { type: "string", description: "Optional note (max 128 chars)" } },
    required: ["user_id", "gift_id"],
  },
  async run({ user_id, gift_id, text }, ctx) {
    const cap = ctx.config.MAX_GIFTS_PER_DAY;
    if (ctx.store.countToolSince("send_gift", Date.now() - 86_400_000) >= cap) throw new Error(`Daily gift limit reached (${cap}/24h). Ask the creator to raise MAX_GIFTS_PER_DAY.`);
    await (ctx.api.raw as any).sendGift({ user_id, gift_id, ...(text ? { text: truncate(text, 128) } : {}) });
    return { sent: true };
  },
};

// ---- chat / message management ----
export const chatInfo: Tool = {
  name: "chat_info",
  description: "Basic info about the current chat (type, title, member count).",
  level: "public",
  parameters: { type: "object", properties: {} },
  async run(_a, ctx) {
    const c = await ctx.api.getChat(ctx.chatId);
    let members: number | undefined;
    try { members = await ctx.api.getChatMemberCount(ctx.chatId); } catch {}
    return { id: c.id, type: c.type, title: c.title ?? c.first_name, description: c.description, members };
  },
};

export const deleteMessage: Tool = {
  name: "delete_message",
  description: "Delete a message in the current chat by message_id (bot needs delete rights in groups; bot's own messages always work).",
  level: "admin",
  risky: true,
  parameters: { type: "object", properties: { message_id: { type: "integer" } }, required: ["message_id"] },
  async run({ message_id }, ctx) {
    await ctx.api.deleteMessage(ctx.chatId, message_id);
    return { deleted: true };
  },
};

export const pinMessage: Tool = {
  name: "pin_message",
  description: "Pin (or unpin) a message in the current chat.",
  level: "admin",
  risky: true,
  parameters: { type: "object", properties: { message_id: { type: "integer" }, unpin: { type: "boolean" } }, required: ["message_id"] },
  async run({ message_id, unpin }, ctx) {
    if (unpin) await ctx.api.unpinChatMessage(ctx.chatId, message_id);
    else await ctx.api.pinChatMessage(ctx.chatId, message_id, { disable_notification: true });
    return { ok: true };
  },
};

// ---- user summary ----
export const userSummary: Tool = {
  name: "user_summary",
  description: "Summary of a user's profile and activity with this bot (first/last seen, message count, saved memories, pending reminders). Defaults to the current user; other users: admin only.",
  level: "public",
  parameters: { type: "object", properties: { user_id: { type: "integer" } } },
  async run({ user_id }, ctx) {
    const id = user_id ?? ctx.userId;
    if (id !== ctx.userId && ctx.level !== "admin") throw new Error("Only admins can look up other users");
    const u = ctx.store.getUser(id);
    if (!u) return { found: false };
    return {
      user_id: u.user_id, name: u.first_name, username: u.username, first_seen: new Date(u.first_seen).toISOString(), last_seen: new Date(u.last_seen).toISOString(),
      messages_to_bot: u.msg_count, saved_memories: ctx.store.memCount("user", String(id)), active_tasks: ctx.store.countActiveJobs(id),
    };
  },
};

export const whoami: Tool = {
  name: "whoami",
  description: "The requesting user's Telegram numeric id, this chat's id, their access level and whether they are the creator. Use when someone asks 'what is my id' or for their permissions.",
  level: "public",
  parameters: { type: "object", properties: {} },
  async run(_a, ctx) {
    return { user_id: ctx.userId, chat_id: ctx.chatId, chat_type: ctx.chatType, username: ctx.username ?? null, access_level: ctx.level, is_creator: ctx.isOwner };
  },
};

export const resetChat: Tool = {
  name: "reset_chat",
  description: "Erase the short-term conversation history of THIS chat (the user asked to forget/clear the conversation). Long-term memory is not touched.",
  level: "public",
  parameters: { type: "object", properties: {} },
  async run(_a, ctx) {
    ctx.store.clearHistory(ctx.chatId);
    return { cleared: true };
  },
};

export const telegramTools: Tool[] = [whoami, resetChat, publishTelegraph, listGifts, sendGift, chatInfo, deleteMessage, pinMessage, userSummary];
