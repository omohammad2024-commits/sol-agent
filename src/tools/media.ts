import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import type { Config } from "../config";
import type { Tool } from "../types";
import { resolveSafe } from "../security";
import { httpJson, rid, run, truncate } from "../util";

const MAX_SEND = 49 * 1024 * 1024;
const ALLOWED_HOSTS = ["youtube.com", "youtu.be", "music.youtube.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "reddit.com", "redd.it"];
const hostAllowed = (h: string) => ALLOWED_HOSTS.some((a) => h === a || h.endsWith("." + a));

// ---- download_media ----
export const downloadMedia: Tool = {
  name: "download_media",
  description: "Download a video or audio from YouTube, Instagram, TikTok, X/Twitter or Reddit and send it to the chat (<=50 MB). For songs you can pass a search phrase instead of a URL (YouTube search, audio mode).",
  level: "trusted",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "A supported URL, or (audio only) a search phrase like 'Artist - Song'" },
      mode: { type: "string", enum: ["video", "audio"], description: "default video; audio = mp3" },
    },
    required: ["source"],
  },
  async run({ source, mode }, ctx) {
    const isUrl = /^https?:\/\//i.test(source);
    let target: string;
    let m: "video" | "audio" = mode === "audio" ? "audio" : "video";
    if (isUrl) {
      const u = new URL(source);
      if (!hostAllowed(u.hostname.toLowerCase())) throw new Error("This site is not supported (YouTube, Instagram, TikTok, X, Reddit only)");
      target = u.toString();
    } else {
      if (source.length > 200) throw new Error("Search phrase too long");
      target = `ytsearch1:${source}`;
      m = "audio";
    }
    const dir = path.join(ctx.workdir, `dl-${rid(4)}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const args = ["--no-playlist", "--no-warnings", "--no-simulate", "--restrict-filenames", "--max-filesize", "49M", "-o", path.join(dir, "%(id)s.%(ext)s"), "--print", "%(title)s", "--print", "after_move:filepath"];
      if (m === "audio") args.push("-x", "--audio-format", "mp3", "-f", "bestaudio/best");
      else args.push("-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4");
      if (ctx.config.YTDLP_COOKIES && fs.existsSync(ctx.config.YTDLP_COOKIES)) args.push("--cookies", ctx.config.YTDLP_COOKIES);
      args.push(target);
      const r = await run("yt-dlp", args, { timeoutMs: 180_000 });
      if (r.code !== 0) throw new Error(`yt-dlp failed: ${truncate(r.stderr.trim().split("\n").slice(-3).join(" "), 400)}`);
      const lines = r.stdout.trim().split("\n").filter(Boolean);
      const file = lines[lines.length - 1]!;
      const title = lines.length > 1 ? lines[0]! : path.basename(file);
      if (!file || !fs.existsSync(file)) throw new Error("Download finished but no file was produced (file may exceed 49 MB)");
      const size = fs.statSync(file).size;
      if (size > MAX_SEND) throw new Error("File is larger than Telegram's 50 MB bot limit");
      await ctx.sendFile({ path: file, filename: path.basename(file) }, m === "audio" ? "audio" : "video", title);
      return { sent: true, title, size_mb: +(size / 1048576).toFixed(1), mode: m };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

// ---- edit_gif ----
export const editGif: Tool = {
  name: "edit_gif",
  description: "Edit a GIF/animation/short video from the workspace: add caption text, change speed, or reverse. The result is sent to the chat. Persian text may not shape correctly (ffmpeg limitation).",
  level: "trusted",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "Relative workspace path of the source (attachments are saved under incoming/)" },
      op: { type: "string", enum: ["text", "speed", "reverse"] },
      text: { type: "string", description: "Caption for op=text (max 120 chars)" },
      position: { type: "string", enum: ["top", "bottom"], description: "default bottom" },
      factor: { type: "number", description: "Speed multiplier 0.25-4 for op=speed (2 = twice as fast)" },
      format: { type: "string", enum: ["gif", "mp4"], description: "default gif" },
    },
    required: ["input", "op"],
  },
  async run({ input, op, text, position, factor, format }, ctx) {
    const src = resolveSafe(ctx.workdir, input);
    if (!fs.existsSync(src)) throw new Error("Input file not found");
    const filters: string[] = [];
    const outFmt = format === "mp4" ? "mp4" : "gif";
    const outFile = path.join(ctx.workdir, `edit-${rid(4)}.${outFmt}`);
    let textFile: string | null = null;
    if (op === "speed") {
      const f = Math.min(Math.max(Number(factor ?? 2), 0.25), 4);
      filters.push(`setpts=PTS/${f}`, "fps=20");
    } else if (op === "reverse") {
      filters.push("reverse");
    } else {
      if (!text || text.length > 120) throw new Error("text is required (max 120 chars)");
      textFile = path.join(ctx.workdir, `.txt-${rid(4)}`);
      fs.writeFileSync(textFile, text);
      const y = position === "top" ? "12" : "h-th-12";
      filters.push(`drawtext=fontfile=${ctx.config.FONT_PATH}:textfile=${textFile}:fontsize=h/10:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=${y}`);
    }
    try {
      let args: string[];
      if (outFmt === "gif") {
        args = ["-y", "-i", src, "-vf", `${filters.join(",")}${filters.length ? "," : ""}split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse`, "-loop", "0", outFile];
      } else {
        args = ["-y", "-i", src, "-vf", [...filters, "scale=trunc(iw/2)*2:trunc(ih/2)*2"].join(","), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", outFile];
      }
      const r = await run("ffmpeg", args, { timeoutMs: 120_000 });
      if (r.code !== 0 || !fs.existsSync(outFile)) throw new Error(`ffmpeg failed: ${truncate(r.stderr.trim().split("\n").slice(-3).join(" "), 400)}`);
      const size = fs.statSync(outFile).size;
      if (size > MAX_SEND) throw new Error("Result is larger than 50 MB");
      await ctx.sendFile({ path: outFile, filename: path.basename(outFile) }, "animation");
      return { sent: true, op, size_kb: Math.round(size / 1024) };
    } finally {
      fs.rmSync(outFile, { force: true });
      if (textFile) fs.rmSync(textFile, { force: true });
    }
  },
};

// ---- generate_image ----
export const generateImage: Tool = {
  name: "generate_image",
  description: "Generate an image from a text prompt (English prompts work best) and send it to the chat.",
  level: "trusted",
  enabled: (c: Config) => !!c.GEMINI_API_KEY,
  parameters: { type: "object", properties: { prompt: { type: "string", description: "Detailed description of the image" } }, required: ["prompt"] },
  async run({ prompt }, ctx) {
    if (String(prompt).length > 2000) throw new Error("Prompt too long");
    const d = await httpJson<any>(
      `https://generativelanguage.googleapis.com/v1beta/models/${ctx.config.IMAGE_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": ctx.config.GEMINI_API_KEY! },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
      },
      { retries: 1, timeoutMs: 120_000 },
    );
    const parts: any[] = d?.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p.inlineData?.data);
    if (!img) throw new Error(`The model returned no image${d?.promptFeedback?.blockReason ? ` (blocked: ${d.promptFeedback.blockReason})` : ""}`);
    const ext = (img.inlineData.mimeType ?? "image/png").split("/")[1] ?? "png";
    await ctx.sendFile({ data: Buffer.from(img.inlineData.data, "base64"), filename: `image.${ext}` }, "photo");
    return { sent: true };
  },
};

// ---- inspect_media ----
export const inspectMedia: Tool = {
  name: "inspect_media",
  description: "Inspect an image/audio/video/GIF file in the workspace with ffprobe: container, duration, size, codecs, resolution, fps, bitrate.",
  level: "trusted",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async run({ path: p }, ctx) {
    const full = resolveSafe(ctx.workdir, p);
    if (!fs.existsSync(full)) throw new Error("File not found");
    const r = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", full], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`ffprobe failed: ${truncate(r.stderr, 300)}`);
    const j = JSON.parse(r.stdout);
    return {
      file: p, size_bytes: Number(j.format?.size ?? fs.statSync(full).size), format: j.format?.format_long_name,
      duration_s: j.format?.duration ? +Number(j.format.duration).toFixed(2) : null, bit_rate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
      tags: j.format?.tags ?? undefined,
      streams: (j.streams ?? []).map((s: any) => ({
        type: s.codec_type, codec: s.codec_name, width: s.width, height: s.height, fps: s.avg_frame_rate && s.avg_frame_rate !== "0/0" ? s.avg_frame_rate : undefined,
        sample_rate: s.sample_rate, channels: s.channels,
      })),
    };
  },
};

// ---- make_qr ----
export const makeQr: Tool = {
  name: "make_qr",
  description: "Generate a QR code image from text or a link and send it to the chat.",
  level: "public",
  parameters: { type: "object", properties: { content: { type: "string", description: "Text or URL (max 1000 chars)" } }, required: ["content"] },
  async run({ content }, ctx) {
    if (String(content).length > 1000) throw new Error("Content too long for a QR code");
    const buf = await QRCode.toBuffer(content, { width: 640, margin: 2, errorCorrectionLevel: "M" });
    await ctx.sendFile({ data: buf, filename: "qr.png" }, "photo");
    return { sent: true };
  },
};

export const mediaTools: Tool[] = [downloadMedia, editGif, generateImage, inspectMedia, makeQr];
