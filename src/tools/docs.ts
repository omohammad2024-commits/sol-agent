import fs from "node:fs";
import path from "node:path";
import { isRtl, readDocument, toCsv, toDocx, toHtml, toPdfChromium, toPdfLatin, toXlsx, RTL_RE } from "../docs";
import { resolveSafe } from "../security";
import type { Tool, ToolContext } from "../types";
import { truncate } from "../util";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const safeName = (s: string, ext: string) => (s.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/\.\w{1,5}$/, "").trim().slice(0, 60) || "document") + ext;

export const readDoc: Tool = {
  name: "read_document",
  description: "Read the text of a document from the user's workspace: PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV/TXT/MD/JSON/HTML. For long files use offset to continue. Scanned PDFs / images: use ocr_image instead.",
  level: "trusted",
  untrusted: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      pages: { type: "string", description: "PDF page range like '1-5' or '3'" },
      offset: { type: "integer", description: "character offset to continue reading (default 0)" },
      max_chars: { type: "integer", description: "default 9000, max 11000" },
    },
    required: ["path"],
  },
  async run({ path: p, pages, offset, max_chars }, ctx) {
    const full = resolveSafe(ctx.workdir, p);
    if (!fs.existsSync(full)) throw new Error("File not found");
    let range: [number, number] | undefined;
    if (pages) {
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(pages).trim());
      if (!m) throw new Error("pages must look like '1-5' or '3'");
      range = [Number(m[1]), Number(m[2] ?? m[1])];
    }
    const r = await readDocument(full, { pages: range });
    const start = Math.max(offset ?? 0, 0), max = Math.min(max_chars ?? 9000, 11000);
    const slice = r.text.slice(start, start + max);
    const end = start + slice.length;
    return { file: p, type: r.type, pages: r.pages, total_chars: r.text.length, offset: start, text: slice, ...(end < r.text.length ? { more: `call again with offset=${end}` } : {}) };
  },
};

export const ocrImage: Tool = {
  name: "ocr_image",
  description: "Look at an image from the workspace (photo, screenshot, scan, receipt, handwriting): extract its text or answer a question about it. Persian and English supported.",
  level: "trusted",
  untrusted: true,
  parameters: { type: "object", properties: { path: { type: "string" }, question: { type: "string", description: "optional; default = extract all text exactly as written" } }, required: ["path"] },
  async run({ path: p, question }, ctx) {
    const full = resolveSafe(ctx.workdir, p);
    const mime = MIME[path.extname(full).toLowerCase()];
    if (!mime) throw new Error("Not a supported image (png, jpg, webp, gif)");
    const buf = fs.readFileSync(full);
    if (buf.length > 6 * 1024 * 1024) throw new Error("Image is larger than 6 MB");
    const prompt = question?.trim() || "Extract ALL the text in this image exactly as written, preserving line breaks and the original language. If there is no text, describe the image in one sentence.";
    const text = await ctx.vision({ mime, data: buf.toString("base64") }, prompt);
    return { file: p, text: truncate(text, 9000) };
  },
};

async function deliver(ctx: ToolContext, data: Buffer, filename: string, caption?: string) {
  fs.mkdirSync(ctx.workdir, { recursive: true });
  const file = path.join(ctx.workdir, filename);
  fs.writeFileSync(file, data);
  if (data.length > 49 * 1024 * 1024) throw new Error("The file is larger than Telegram's 50 MB bot limit");
  await ctx.sendFile({ path: file, filename }, "document", caption);
  return { sent: true, file: filename, size_kb: Math.max(1, Math.round(data.length / 1024)) };
}

export const createDocument: Tool = {
  name: "create_document",
  description:
    "Create a document file and send it to the chat. format: docx (Word) | pdf | html | md. Write the content in Markdown (# headings, **bold**, lists, | tables |, ``` code ```). Persian/Arabic (right-to-left) is handled automatically. Use for reports, letters, CVs, summaries, contracts, notes.",
  level: "trusted",
  parameters: {
    type: "object",
    properties: { format: { type: "string", enum: ["docx", "pdf", "html", "md"] }, title: { type: "string" }, content: { type: "string", description: "Markdown body (do not repeat the title)" }, filename: { type: "string", description: "optional file name without extension" } },
    required: ["format", "title", "content"],
  },
  async run({ format, title, content, filename }, ctx) {
    if (content.length > 200_000) throw new Error("Content too long");
    const base = filename || title;
    if (format === "docx") return deliver(ctx, await toDocx(title, content), safeName(base, ".docx"));
    if (format === "html") return deliver(ctx, Buffer.from(toHtml(title, content), "utf8"), safeName(base, ".html"));
    if (format === "md") return deliver(ctx, Buffer.from(`# ${title}\n\n${content}\n`, "utf8"), safeName(base, ".md"));
    // pdf
    if (RTL_RE.test(title + content)) {
      try {
        return await deliver(ctx, await toPdfChromium(title, content), safeName(base, ".pdf"));
      } catch (e) {
        const r = await deliver(ctx, await toDocx(title, content), safeName(base, ".docx"), "PDF with right-to-left text needs Chromium on the server; here is the Word version (open it and Save as PDF).");
        return { ...r, note: `PDF for Persian/Arabic text is not available on this server (${e instanceof Error ? e.message : e}). I sent a Word file instead.` };
      }
    }
    return deliver(ctx, await toPdfLatin(title, content), safeName(base, ".pdf"));
  },
};

export const createSpreadsheet: Tool = {
  name: "create_spreadsheet",
  description: "Create an Excel (.xlsx) or CSV file from tabular data and send it to the chat. rows is an array of arrays; the first row is the header. Strings starting with '=' become formulas (e.g. '=SUM(B2:B10)'). Persian text is fine.",
  level: "trusted",
  parameters: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["xlsx", "csv"] },
      filename: { type: "string" },
      sheets: { type: "array", items: { type: "object", properties: { name: { type: "string" }, rows: { type: "array", items: { type: "array", items: {} } } }, required: ["rows"] }, description: "one or more sheets (csv uses only the first)" },
    },
    required: ["format", "sheets"],
  },
  async run({ format, filename, sheets }, ctx) {
    if (!Array.isArray(sheets) || !sheets.length) throw new Error("sheets must be a non-empty array");
    const total = sheets.reduce((n: number, s: any) => n + (Array.isArray(s.rows) ? s.rows.length : 0), 0);
    if (total > 50_000) throw new Error("Too many rows (max 50,000)");
    const clean = sheets.map((s: any, i: number) => ({ name: String(s.name ?? `Sheet${i + 1}`), rows: (s.rows ?? []).map((r: unknown) => (Array.isArray(r) ? r : [r])) }));
    const base = filename || "table";
    if (format === "csv") return deliver(ctx, toCsv(clean[0]!.rows), safeName(base, ".csv"));
    return deliver(ctx, await toXlsx(clean), safeName(base, ".xlsx"));
  },
};

export const docTools: Tool[] = [readDoc, ocrImage, createDocument, createSpreadsheet];
void isRtl;
