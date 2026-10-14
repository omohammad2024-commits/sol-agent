import fs from "node:fs";
import path from "node:path";
import type { Tool } from "../types";
import { resolveSafe } from "../security";
import { truncate } from "../util";

export const readFile: Tool = {
  name: "read_file",
  description: "Read a text file from the user's workspace (relative path). Max ~100 KB shown.",
  level: "trusted",
  untrusted: true,
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async run({ path: p }, ctx) {
    const full = resolveSafe(ctx.workdir, p);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error("Not a file");
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 4000).includes(0)) return { path: p, size: st.size, note: "Binary file; use inspect_media or send_file." };
    return { path: p, size: st.size, content: truncate(buf.toString("utf8"), 100_000) };
  },
};

export const writeFile: Tool = {
  name: "write_file",
  description: "Create/overwrite a text file in the user's workspace (relative path, max 1 MB).",
  level: "trusted",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } }, required: ["path", "content"] },
  async run({ path: p, content, append }, ctx) {
    if (Buffer.byteLength(content) > 1_000_000) throw new Error("Content too large (max 1 MB)");
    const full = resolveSafe(ctx.workdir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (append) fs.appendFileSync(full, content);
    else fs.writeFileSync(full, content);
    return { ok: true, path: p, bytes: Buffer.byteLength(content) };
  },
};

export const listFiles: Tool = {
  name: "list_files",
  description: "List files in the user's workspace (optionally a sub-directory).",
  level: "trusted",
  parameters: { type: "object", properties: { dir: { type: "string" } } },
  async run({ dir }, ctx) {
    const full = resolveSafe(ctx.workdir, dir ?? ".");
    return fs.readdirSync(full, { withFileTypes: true }).slice(0, 200).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
      size: e.isFile() ? fs.statSync(path.join(full, e.name)).size : undefined,
    }));
  },
};

export const sendFile: Tool = {
  name: "send_file",
  description: "Send a file from the user's workspace to the chat (max 50 MB).",
  level: "trusted",
  parameters: { type: "object", properties: { path: { type: "string" }, caption: { type: "string" } }, required: ["path"] },
  async run({ path: p, caption }, ctx) {
    const full = resolveSafe(ctx.workdir, p);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error("Not a file");
    if (st.size > 50 * 1024 * 1024) throw new Error("File is larger than Telegram's 50 MB bot limit");
    await ctx.sendFile({ path: full, filename: path.basename(full) }, "auto", caption);
    return { sent: true, file: p };
  },
};

export const fileTools: Tool[] = [readFile, writeFile, listFiles, sendFile];
