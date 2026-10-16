export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches any of the bot's names as a whole word (Latin or Persian; ZWNJ counts as part of a word),
 * so "sol" matches "hey sol," and "سول جان" / "سول‌جان" but not "solution" or "سولفات".
 */
export function buildNameRegex(names: string[]): RegExp | null {
  const parts = names.map((n) => n.trim()).filter(Boolean).map(escapeRegExp);
  if (!parts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}\\u200c_])(?:${parts.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

export interface RespondInput {
  chatType: string;
  text: string;
  botUsername?: string;
  replyToBot: boolean;
  nameRe: RegExp | null;
  /** The same user was answered by the bot a few seconds ago in this group. */
  followUp: boolean;
}

/** Should the bot answer this message? Private: always. Groups: only when addressed. */
export function shouldRespond(i: RespondInput): boolean {
  if (i.chatType === "private") return true;
  if (i.replyToBot) return true;
  if (i.botUsername && i.text.toLowerCase().includes(`@${i.botUsername.toLowerCase()}`)) return true;
  if (i.nameRe?.test(i.text)) return true;
  return i.followUp;
}
