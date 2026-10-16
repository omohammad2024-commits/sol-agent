import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import { httpJson, rid, run } from "./util";

export type SttProvider = "gemini" | "openai";

export function sttProvider(c: Config): SttProvider | null {
  if (c.STT_PROVIDER === "gemini") return c.GEMINI_API_KEY ? "gemini" : null;
  if (c.STT_PROVIDER === "openai") return c.OPENAI_API_KEY ? "openai" : null;
  return c.GEMINI_API_KEY ? "gemini" : c.OPENAI_API_KEY ? "openai" : null;
}
export const sttAvailable = (c: Config) => sttProvider(c) !== null;

/** Convert Telegram's OGG/Opus to a widely supported mono MP3 (falls back to the original if ffmpeg is missing). */
async function toMp3(file: string): Promise<{ file: string; mime: string; temp: boolean }> {
  const out = path.join(path.dirname(file), `.stt-${rid(4)}.mp3`);
  const r = await run("ffmpeg", ["-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", out], { timeoutMs: 60_000 });
  if (r.code === 0 && fs.existsSync(out)) return { file: out, mime: "audio/mpeg", temp: true };
  return { file, mime: "audio/ogg", temp: false };
}

/** Speech → text for a local audio file. Throws with a readable message on failure. */
export async function transcribe(c: Config, file: string): Promise<string> {
  const provider = sttProvider(c);
  if (!provider) throw new Error("Speech-to-text is not configured (set GEMINI_API_KEY or OPENAI_API_KEY)");
  if (provider === "gemini") {
    const a = await toMp3(file);
    try {
      const data = fs.readFileSync(a.file).toString("base64");
      const d = await httpJson<any>(
        `https://generativelanguage.googleapis.com/v1beta/models/${c.STT_MODEL ?? "gemini-2.5-flash"}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": c.GEMINI_API_KEY! },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Transcribe this audio verbatim in the language that is spoken. Output ONLY the transcript, no commentary. If there is no speech, output an empty string." }, { inlineData: { mimeType: a.mime, data } }] }],
            generationConfig: { temperature: 0 },
          }),
        },
        { retries: 1, timeoutMs: 90_000 },
      );
      return (d?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
    } finally {
      if (a.temp) fs.rmSync(a.file, { force: true });
    }
  }
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file).replace(/\.oga$/, ".ogg"));
  form.append("model", c.STT_MODEL ?? "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${c.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI STT HTTP ${res.status}: ${text.slice(0, 200)}`);
  return String(JSON.parse(text).text ?? "").trim();
}
