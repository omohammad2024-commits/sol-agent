import type { Config } from "./config";
import type { Store } from "./memory/store";

export type Level = "public" | "trusted" | "admin";
export const levelRank: Record<Level, number> = { public: 0, trusted: 1, admin: 2 };

export type LevelOf = (id: number) => Level | "banned";

export type FileKind = "auto" | "photo" | "video" | "audio" | "animation" | "document";

export interface ToolContext {
  config: Config;
  store: Store;
  userId: number;
  chatId: number;
  chatType: string;
  username?: string;
  displayName: string;
  level: Level;
  /** True only when the Telegram user id equals OWNER_ID (set by the server, never by chat text). */
  isOwner: boolean;
  /** Effective access level of any Telegram user id (env lists + runtime ACL). */
  levelOf: LevelOf;
  /** Scheduled / background run: no human is waiting, so powerful (risky) tools are unavailable. */
  unattended?: boolean;
  /** Ask the vision-capable model about an image (OCR, description). */
  vision(img: { mime: string; data: string }, prompt: string): Promise<string>;
  /** Per-user writable workspace directory (absolute). */
  workdir: string;
  sendText(text: string): Promise<void>;
  sendVoice(data: Uint8Array): Promise<void>;
  sendFile(file: { path?: string; data?: Uint8Array; filename: string }, kind?: FileKind, caption?: string): Promise<void>;
  /** grammY Api instance. */
  api: any;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  level: Level;
  /**
   * Powerful/irreversible action. No buttons: instead the agent refuses to run it in a turn that already
   * read untrusted external content (prompt-injection guard). Function form decides per call.
   */
  risky?: boolean | ((args: any) => boolean);
  /** Output comes from outside (web, files) and is wrapped as untrusted data. */
  untrusted?: boolean;
  /** Reading this output marks the whole turn as "tainted" (blocks risky tools for the rest of the turn). */
  taints?: boolean;
  enabled?: (c: Config) => boolean;
  run(args: any, ctx: ToolContext): Promise<unknown>;
}
