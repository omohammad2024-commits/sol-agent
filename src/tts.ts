import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config } from "./config";
import { fetchRetry, rid, run } from "./util";

export type TtsProvider = "gemini" | "openai";

export function ttsProvider(c: Config): TtsProvider | null {
  if (c.TTS_PROVIDER === "off") return null;
  if (c.TTS_PROVIDER === "gemini") return c.GEMINI_API_KEY ? "gemini" : null;
  if (c.TTS_PROVIDER === "openai") return c.OPENAI_API_KEY ? "openai" : null;
  return c.GEMINI_API_KEY ? "gemini" : c.OPENAI_API_KEY ? "openai" : null;
}

/** Strip things that sound terrible when read aloud (code, links, markdown). */
export function speechText(md: string, max = 1500): string {
  return md
    .replace(/```[\s\S]*?```/g, " (کد) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " لینک ")
    .replace(/[*_#>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Text -> OGG/Opus bytes (what Telegram voice notes use). */
export async function synthesize(c: Config, text: string): Promise<Buffer> {
  const provider = ttsProvider(c);
  if (!provider) throw new Error("Text-to-speech is not configured (set GEMINI_API_KEY or OPENAI_API_KEY)");
  const input = speechText(text);
  if (!input) throw new Error("Nothing to say");
  if (provider === "openai") {
    const res = await fetchRetry("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: c.TTS_MODEL ?? "gpt-4o-mini-tts", voice: c.TTS_VOICE ?? "alloy", input, response_format: "opus" }),
    }, { retries: 1, timeoutMs: 90_000 });
    return Buffer.from(await res.arrayBuffer());
  }
  const model = c.TTS_MODEL ?? "gemini-2.5-flash-preview-tts";
  const res = await fetchRetry(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": c.GEMINI_API_KEY! },
    body: JSON.stringify({
      contents: [{ parts: [{ text: input }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.TTS_VOICE ?? "Kore" } } } },
    }),
  }, { retries: 1, timeoutMs: 90_000 });
  const d: any = JSON.parse(await res.text());
  const part = d?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!part) throw new Error("The TTS model returned no audio");
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
  const tmp = path.join(os.tmpdir(), `tts-${rid(4)}`);
  fs.writeFileSync(`${tmp}.pcm`, Buffer.from(part.inlineData.data, "base64"));
  try {
    const r = await run("ffmpeg", ["-y", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", `${tmp}.pcm`, "-c:a", "libopus", "-b:a", "32k", "-application", "voip", `${tmp}.ogg`], { timeoutMs: 60_000 });
    if (r.code !== 0 || !fs.existsSync(`${tmp}.ogg`)) throw new Error(`ffmpeg failed to encode the voice: ${r.stderr.slice(-200)}`);
    return fs.readFileSync(`${tmp}.ogg`);
  } finally {
    fs.rmSync(`${tmp}.pcm`, { force: true });
    fs.rmSync(`${tmp}.ogg`, { force: true });
  }
}
