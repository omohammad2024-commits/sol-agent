import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

export const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
/** True when the first strong letter is right-to-left (Persian/Arabic/Hebrew). */
export function isRtl(text: string): boolean {
  const m = text.match(/[A-Za-z\u0590-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/);
  return !!m && RTL_RE.test(m[0]);
}

/** Direction of a whole document: right-to-left when the body starts with an RTL letter or most of its letters are RTL (a Latin title or a few English words do not flip it). */
export function docIsRtl(title: string, body: string): boolean {
  const sample = (body.trim() ? body : title).slice(0, 4000);
  const rtl = (sample.match(/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  return isRtl(sample) || rtl > latin;
}

// ---------------------------------------------------------------------------------------------
// Markdown-ish content model (shared by docx / pdf / html writers)
// ---------------------------------------------------------------------------------------------
export type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "code"; text: string }
  | { t: "quote"; text: string }
  | { t: "table"; rows: string[][] };

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { out.push({ t: "p", text: para.join(" ").trim() }); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push({ t: "code", text: code.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); out.push({ t: "h", level: h[1]!.length, text: h[2]!.trim() }); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      out.push({ t: "table", rows });
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*•]\s+/, "").trim());
      out.push({ t: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, "").trim());
      out.push({ t: "ol", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push({ t: "quote", text: q.join(" ").trim() });
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return out;
}

export interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean }
/** Inline **bold**, *italic* and `code`. */
export function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) runs.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) runs.push({ text: tok.slice(1, -1), code: true });
    else runs.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}
export const plain = (t: string) => inlineRuns(t).map((r) => r.text).join("");

// ---------------------------------------------------------------------------------------------
// writers
// ---------------------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inlineHtml = (t: string) => inlineRuns(t).map((r) => (r.code ? `<code>${esc(r.text)}</code>` : r.bold ? `<b>${esc(r.text)}</b>` : r.italic ? `<i>${esc(r.text)}</i>` : esc(r.text))).join("");

export function toHtml(title: string, md: string): string {
  const rtl = docIsRtl(title, md);
  const body = parseBlocks(md).map((b) => {
    switch (b.t) {
      case "h": return `<h${Math.min(b.level + 1, 5)}>${inlineHtml(b.text)}</h${Math.min(b.level + 1, 5)}>`;
      case "p": return `<p>${inlineHtml(b.text)}</p>`;
      case "ul": return `<ul>${b.items.map((x) => `<li>${inlineHtml(x)}</li>`).join("")}</ul>`;
      case "ol": return `<ol>${b.items.map((x) => `<li>${inlineHtml(x)}</li>`).join("")}</ol>`;
      case "code": return `<pre dir="ltr">${esc(b.text)}</pre>`;
      case "quote": return `<blockquote>${inlineHtml(b.text)}</blockquote>`;
      case "table": return `<table>${b.rows.map((r, i) => `<tr>${r.map((c) => `<${i ? "td" : "th"}>${inlineHtml(c)}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`;
    }
  }).join("\n");
  return `<!doctype html><html lang="${rtl ? "fa" : "en"}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:Vazirmatn,"Noto Sans Arabic",Tahoma,Arial,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.8;color:#222}
h1,h2,h3,h4,h5{line-height:1.3}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #bbb;padding:6px 10px;text-align:start}th{background:#f1f1f1}
pre{background:#f6f6f6;padding:12px;overflow:auto;border-radius:6px}code{background:#f0f0f0;padding:1px 4px;border-radius:4px}blockquote{border-inline-start:4px solid #ccc;margin:1rem 0;padding:0 1rem;color:#555}
</style></head><body><h1>${esc(title)}</h1>\n${body}\n</body></html>`;
}

export async function toDocx(title: string, md: string): Promise<Buffer> {
  const d = await import("docx");
  const rtl = docIsRtl(title, md);
  const font = rtl ? { ascii: "Tahoma", hAnsi: "Tahoma", cs: "Tahoma" } : { ascii: "Calibri", hAnsi: "Calibri", cs: "Calibri" };
  const runs = (t: string) => inlineRuns(t).map((r) => new d.TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? "Consolas" : font, rightToLeft: rtl && !r.code }));
  const para = (t: string, extra: Record<string, unknown> = {}) => new d.Paragraph({ children: runs(t), bidirectional: rtl, alignment: rtl ? d.AlignmentType.START : undefined, spacing: { after: 120 }, ...extra });
  const heading = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4];
  const children: any[] = [new d.Paragraph({ children: [new d.TextRun({ text: title, bold: true, size: 40, font, rightToLeft: rtl })], heading: d.HeadingLevel.TITLE, bidirectional: rtl, spacing: { after: 240 } })];
  let olInstance = 0;
  for (const b of parseBlocks(md)) {
    if (b.t === "h") children.push(new d.Paragraph({ children: [new d.TextRun({ text: plain(b.text), bold: true, font, rightToLeft: rtl })], heading: heading[Math.min(b.level, 4) - 1], bidirectional: rtl, spacing: { before: 200, after: 100 } }));
    else if (b.t === "p") children.push(para(b.text));
    else if (b.t === "ul") for (const it of b.items) children.push(para(it, { bullet: { level: 0 } }));
    else if (b.t === "ol") { olInstance++; for (const it of b.items) children.push(para(it, { numbering: { reference: "num", level: 0, instance: olInstance } })); }
    else if (b.t === "quote") children.push(para(b.text, { indent: { left: 400 } }));
    else if (b.t === "code") for (const ln of b.text.split("\n")) children.push(new d.Paragraph({ children: [new d.TextRun({ text: ln || " ", font: "Consolas", size: 20 })], shading: { type: d.ShadingType.CLEAR, fill: "F2F2F2" } }));
    else if (b.t === "table") {
      const cols = Math.max(...b.rows.map((r) => r.length), 1);
      children.push(new d.Table({
        width: { size: 100, type: d.WidthType.PERCENTAGE }, visuallyRightToLeft: rtl,
        rows: b.rows.map((r, ri) => new d.TableRow({ tableHeader: ri === 0, children: Array.from({ length: cols }, (_, ci) => new d.TableCell({ shading: ri === 0 ? { type: d.ShadingType.CLEAR, fill: "E8E8E8" } : undefined, children: [new d.Paragraph({ children: inlineRuns(r[ci] ?? "").map((x) => new d.TextRun({ text: x.text, bold: ri === 0 || x.bold, italics: x.italic, font, rightToLeft: rtl })), bidirectional: rtl })] })) })),
      }));
      children.push(new d.Paragraph({ text: "" }));
    }
  }
  const numbering = { config: [{ reference: "num", levels: [{ level: 0, format: d.LevelFormat.DECIMAL, text: "%1.", alignment: d.AlignmentType.START }] }] };
  return Buffer.from(await d.Packer.toBuffer(new d.Document({ title, numbering, sections: [{ children }] })));
}

/** Latin-script PDF via pdfkit (no complex-script shaping; RTL text goes through Chromium instead). */
export async function toPdfLatin(title: string, md: string): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ margin: 54, size: "A4", info: { Title: title } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  doc.font("Helvetica-Bold").fontSize(22).text(title).moveDown(0.8);
  const sizes = [18, 15, 13, 12];
  for (const b of parseBlocks(md)) {
    if (b.t === "h") doc.moveDown(0.4).font("Helvetica-Bold").fontSize(sizes[Math.min(b.level, 4) - 1]!).text(plain(b.text)).moveDown(0.2);
    else if (b.t === "p") doc.font("Helvetica").fontSize(11).text(plain(b.text), { align: "left" }).moveDown(0.5);
    else if (b.t === "ul") { doc.font("Helvetica").fontSize(11); for (const it of b.items) doc.text(`•  ${plain(it)}`, { indent: 10 }); doc.moveDown(0.5); }
    else if (b.t === "ol") { doc.font("Helvetica").fontSize(11); b.items.forEach((it, n) => doc.text(`${n + 1}.  ${plain(it)}`, { indent: 10 })); doc.moveDown(0.5); }
    else if (b.t === "quote") doc.font("Helvetica-Oblique").fontSize(11).text(plain(b.text), { indent: 20 }).moveDown(0.5);
    else if (b.t === "code") doc.font("Courier").fontSize(9).text(b.text).moveDown(0.5);
    else if (b.t === "table") {
      doc.font("Helvetica").fontSize(10);
      const cols = Math.max(...b.rows.map((r) => r.length), 1);
      const w = (doc.page.width - 108) / cols;
      for (const [ri, r] of b.rows.entries()) {
        const y = doc.y;
        let h = 14;
        r.forEach((c, ci) => { doc.font(ri === 0 ? "Helvetica-Bold" : "Helvetica").text(plain(c), 54 + ci * w, y, { width: w - 6 }); h = Math.max(h, doc.y - y); });
        doc.y = y + h + 4;
        doc.moveTo(54, doc.y - 2).lineTo(doc.page.width - 54, doc.y - 2).strokeColor("#cccccc").stroke();
      }
      doc.moveDown(0.5);
    }
  }
  doc.end();
  return done;
}

/** PDF through headless Chromium (handles Persian/Arabic perfectly). Throws if Playwright/Chromium are missing. */
export async function toPdfChromium(title: string, md: string): Promise<Buffer> {
  let pw: any;
  try { pw = await import(/* @vite-ignore */ "playwright" as string); } catch { throw new Error("Chromium (playwright) is not installed"); }
  const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(toHtml(title, md), { waitUntil: "load" });
    return Buffer.from(await page.pdf({ format: "A4", margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" }, printBackground: true }));
  } finally { await browser.close(); }
}

export async function toXlsx(sheets: { name: string; rows: unknown[][]; header?: boolean }[]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "SOL";
  const used = new Set<string>();
  for (const [si, s] of sheets.entries()) {
    let name = (s.name || `Sheet${si + 1}`).replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || `Sheet${si + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)}_${si}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: s.rows.some((r) => r.some((c) => typeof c === "string" && isRtl(c))), state: s.header === false ? "normal" : "frozen", ySplit: s.header === false ? 0 : 1 } as any] });
    for (const r of s.rows) ws.addRow(r.map((c) => (typeof c === "string" && c.startsWith("=") ? { formula: c.slice(1) } : c)));
    if (s.header !== false && ws.rowCount) { ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } }; }
    ws.columns.forEach((col) => {
      let w = 8;
      col.eachCell?.({ includeEmpty: false }, (cell) => { w = Math.max(w, Math.min(String(cell.value && typeof cell.value === "object" ? (cell.value as any).result ?? "" : cell.value ?? "").length + 2, 60)); });
      col.width = w;
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toCsv(rows: unknown[][]): Buffer {
  const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return Buffer.from("\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n"), "utf8"); // BOM so Excel shows Persian correctly
}

// ---------------------------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------------------------
export interface ReadResult { type: string; pages?: number; text: string }

export async function readDocument(file: string, opts: { pages?: [number, number] } = {}): Promise<ReadResult> {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = text as unknown as string[];
    const [a, b] = opts.pages ?? [1, totalPages];
    const sel = pages.slice(Math.max(a - 1, 0), Math.min(b, totalPages));
    return { type: "pdf", pages: totalPages, text: sel.map((t, i) => `--- page ${a + i} ---\n${t.trim()}`).join("\n\n") };
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    return { type: "docx", text: (await mammoth.extractRawText({ buffer: buf })).value.trim() };
  }
  if (ext === ".xlsx" || ext === ".xlsm") {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const out: string[] = [];
    wb.eachSheet((ws) => {
      out.push(`=== sheet: ${ws.name} (${ws.rowCount} rows x ${ws.columnCount} cols) ===`);
      let n = 0;
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (n++ >= 300) return;
        const vals = (row.values as any[]).slice(1).map((v) => (v && typeof v === "object" ? (v.result ?? v.text ?? (v.richText ? v.richText.map((x: any) => x.text).join("") : JSON.stringify(v))) : v ?? ""));
        out.push(vals.join(" | "));
      });
    });
    return { type: "xlsx", text: out.join("\n") };
  }
  if (ext === ".pptx") {
    const files = unzipSync(new Uint8Array(buf));
    const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    const text = slides.map((n, i) => `--- slide ${i + 1} ---\n` + [...strFromU8(files[n]!).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).join("\n")).join("\n\n");
    return { type: "pptx", pages: slides.length, text };
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext)) throw new Error("This is an image: use ocr_image");
  if ([".doc", ".xls", ".ppt"].includes(ext)) throw new Error(`Old binary ${ext} files are not supported; ask for a .docx/.xlsx/.pptx`);
  if (buf.subarray(0, 4000).includes(0)) throw new Error("Binary file of unknown type");
  const text = buf.toString("utf8");
  if (ext === ".html" || ext === ".htm") return { type: "html", text: text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
  return { type: ext.slice(1) || "text", text };
}
