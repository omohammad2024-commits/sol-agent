import type { AgentDeps } from "./agent";
import { recordUsage } from "./agent";
import { embedOne } from "./embed";
import { log } from "./log";
import { truncate } from "./util";

const SUMMARY_SYSTEM = `You compress an old part of a chat into a compact memory note.
Write in the language the conversation uses (Persian if mixed). At most 110 words, plain text, no markdown.
Keep: names, decisions, facts about people, preferences, promises, unfinished tasks, important numbers/links.
Drop: greetings, filler, tool chatter. Never include secrets, tokens or passwords. Output ONLY the note.`;

const inFlight = new Set<number>();

/** Background job: when enough un-summarized messages pile up, turn the old part into an "episode". */
export async function maybeSummarize(deps: AgentDeps, chatId: number): Promise<boolean> {
  const { store, config, llm } = deps;
  if (inFlight.has(chatId)) return false;
  const upto = store.getSummarizedUpTo(chatId);
  if (store.countMessagesAfter(chatId, upto) < config.SUMMARY_TRIGGER) return false;
  const cutoff = store.summarizeCutoff(chatId, config.HISTORY_LIMIT);
  if (cutoff <= upto) return false;
  inFlight.add(chatId);
  try {
    const msgs = store.messagesBetween(chatId, upto, cutoff, 150);
    if (!msgs.length) return false;
    const transcript = msgs
      .map((m) => `${m.role === "user" ? "U" : "SOL"}: ${truncate(m.text.replace(/^\[msg_id:[^\]]*\]\n?/, ""), 500)}`)
      .join("\n");
    const res = await llm.chat({ system: SUMMARY_SYSTEM, messages: [{ role: "user", parts: [{ type: "text", text: transcript }] }], tools: [], tier: "fast", maxTokens: 400 });
    recordUsage(deps, { userId: 0, chatId }, res);
    const summary = res.parts.filter((p) => p.type === "text").map((p: any) => p.text).join("\n").trim();
    if (!summary) return false;
    const last = msgs[msgs.length - 1]!;
    store.addEpisode({ chatId, summary: truncate(summary, 1200), embedding: await embedOne(config, summary, "doc"), fromMsg: msgs[0]!.id, toMsg: last.id });
    store.setSummarizedUpTo(chatId, last.id);
    log.info("episode_created", { chatId, messages: msgs.length });
    return true;
  } catch (e) {
    log.warn("summarize_failed", { chatId, error: e });
    return false;
  } finally {
    inFlight.delete(chatId);
  }
}
