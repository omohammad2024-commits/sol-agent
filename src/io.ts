import fs from "node:fs";
import path from "node:path";
import { InputFile, type Api } from "grammy";
import { recordUsage, type AgentDeps } from "./agent";
import { levelRank, type FileKind, type Level, type LevelOf, type ToolContext } from "./types";
import { chunkText, mdToHtml, truncate } from "./util";

export const kindByExt = (file: string): FileKind => {
  const e = path.extname(file).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(e)) return "photo";
  if (e === ".gif") return "animation";
  if ([".mp4", ".mov", ".webm", ".mkv"].includes(e)) return "video";
  if ([".mp3", ".m4a", ".ogg", ".wav", ".flac", ".opus"].includes(e)) return "audio";
  return "document";
};

export function createIO(api: Api, redact: (s: string) => string) {
  async function sendText(chatId: number, text: string, replyTo?: number) {
    for (const chunk of chunkText(redact(text))) {
      const o = { link_preview_options: { is_disabled: true }, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) };
      try {
        await api.sendMessage(chatId, mdToHtml(chunk), { ...o, parse_mode: "HTML" });
      } catch {
        await api.sendMessage(chatId, chunk, o);
      }
      replyTo = undefined;
    }
  }
  async function sendFile(chatId: number, file: { path?: string; data?: Uint8Array; filename: string }, kind: FileKind = "auto", caption?: string, replyTo?: number) {
    const input = file.path ? new InputFile(file.path, file.filename) : new InputFile(file.data!, file.filename);
    const k = kind === "auto" ? kindByExt(file.filename) : kind;
    const o = { ...(caption ? { caption: truncate(caption, 1000) } : {}), ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) };
    if (k === "photo") await api.sendPhoto(chatId, input, o);
    else if (k === "video") await api.sendVideo(chatId, input, o);
    else if (k === "audio") await api.sendAudio(chatId, input, o);
    else if (k === "animation") await api.sendAnimation(chatId, input, o);
    else await api.sendDocument(chatId, input, o);
  }
  async function sendVoice(chatId: number, data: Uint8Array, replyTo?: number) {
    await api.sendVoice(chatId, new InputFile(data, "voice.ogg"), replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {});
  }
  return { sendText, sendFile, sendVoice };
}
export type IO = ReturnType<typeof createIO>;

export interface CtxInit {
  userId: number; chatId: number; chatType: string; username?: string; displayName: string;
  level: Level; levelOf: LevelOf; replyTo?: number; unattended?: boolean;
}

/** One place that builds the tool context (used by chat messages, scheduled jobs and inline queries). */
export function buildContext(deps: AgentDeps, io: IO, api: Api, init: CtxInit): ToolContext {
  const { config, store } = deps;
  const workdir = path.join(config.DATA_DIR_ABS, "workspaces", `u${init.userId}`);
  fs.mkdirSync(workdir, { recursive: true });
  const chatId = init.chatId;
  return {
    config, store, userId: init.userId, chatId, chatType: init.chatType, username: init.username, displayName: init.displayName,
    level: init.level, isOwner: !!config.OWNER_ID && init.userId === config.OWNER_ID, levelOf: init.levelOf, unattended: init.unattended, workdir, api,
    sendText: (t) => io.sendText(chatId, t),
    sendFile: (file, kind, caption) => io.sendFile(chatId, file, kind, caption, init.replyTo),
    sendVoice: (data) => io.sendVoice(chatId, data, init.replyTo),
    async vision(img, prompt) {
      const res = await deps.llm.chat({
        system: "You are a precise OCR and image-understanding assistant. Answer only what is asked, in the language of the question.",
        messages: [{ role: "user", parts: [{ type: "image", mime: img.mime, data: img.data }, { type: "text", text: prompt }] }],
        tools: [], tier: "strong", maxTokens: 3000,
      });
      recordUsage(deps, { userId: init.userId, chatId }, res);
      return res.parts.filter((p) => p.type === "text").map((p: any) => p.text).join("\n").trim();
    },
  };
}

export const hasAccess = (level: Level | "banned") => level !== "banned" && levelRank[level] >= 0;
