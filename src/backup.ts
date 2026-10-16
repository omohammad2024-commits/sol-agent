import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Api } from "grammy";
import { InputFile } from "grammy";
import type { Config } from "./config";
import { log } from "./log";
import type { Store } from "./memory/store";

const MAGIC = Buffer.from("SOLB1");

export function encryptBuffer(data: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
}

export function decryptBuffer(data: Buffer, passphrase: string): Buffer {
  if (!data.subarray(0, 5).equals(MAGIC)) throw new Error("Not an encrypted SOL backup");
  const salt = data.subarray(5, 21), iv = data.subarray(21, 33), tag = data.subarray(33, 49), enc = data.subarray(49);
  const d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(passphrase, salt, 32), iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(enc), d.final()]); } catch { throw new Error("Wrong passphrase or corrupted backup"); }
}

export interface BackupResult { file: string; bytes: number; encrypted: boolean }

/** Consistent snapshot -> gzip -> (optional) AES-256-GCM -> data/backups/. */
export function makeBackup(store: Store, config: Config, now = new Date()): BackupResult {
  const dir = path.join(config.DATA_DIR_ABS, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  const tmp = path.join(dir, `.snap-${process.pid}.db`);
  fs.rmSync(tmp, { force: true });
  store.snapshotTo(tmp);
  try {
    let data: Buffer = Buffer.from(Bun.gzipSync(fs.readFileSync(tmp)));
    const encrypted = !!config.BACKUP_PASSPHRASE;
    if (encrypted) data = encryptBuffer(data, config.BACKUP_PASSPHRASE!);
    const file = path.join(dir, `sol-${stamp}.db.gz${encrypted ? ".enc" : ""}`);
    fs.writeFileSync(file, data);
    return { file, bytes: data.length, encrypted };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function pruneBackups(config: Config): number {
  const dir = path.join(config.DATA_DIR_ABS, "backups");
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^sol-.*\.db\.gz(\.enc)?$/.test(f)) continue;
    const full = path.join(dir, f);
    if (Date.now() - fs.statSync(full).mtimeMs > config.BACKUP_KEEP_DAYS * 86400_000) { fs.rmSync(full, { force: true }); n++; }
  }
  return n;
}

export const s3Configured = (c: Config) => !!(c.BACKUP_S3_ENDPOINT && c.BACKUP_S3_BUCKET && c.BACKUP_S3_ACCESS_KEY && c.BACKUP_S3_SECRET_KEY);

export async function uploadS3(c: Config, file: string): Promise<string> {
  const client = new Bun.S3Client({ endpoint: c.BACKUP_S3_ENDPOINT!, bucket: c.BACKUP_S3_BUCKET!, accessKeyId: c.BACKUP_S3_ACCESS_KEY!, secretAccessKey: c.BACKUP_S3_SECRET_KEY!, region: c.BACKUP_S3_REGION });
  const key = `${c.BACKUP_S3_PREFIX ?? ""}${path.basename(file)}`;
  await client.write(key, Bun.file(file));
  return key;
}

/** One full backup run: local file + (owner DM) + (S3). Returns what happened. */
export async function runBackup(store: Store, config: Config, api: Api | null): Promise<{ result: BackupResult; sentToOwner: boolean; s3Key: string | null; pruned: number; errors: string[] }> {
  const result = makeBackup(store, config);
  const errors: string[] = [];
  let sentToOwner = false, s3Key: string | null = null;
  if (api && config.BACKUP_TO_OWNER && config.OWNER_ID) {
    if (result.bytes > 49 * 1024 * 1024) errors.push("backup is larger than Telegram's 50 MB limit; not sent to the owner");
    else if (!result.encrypted) errors.push("not sent to Telegram: set BACKUP_PASSPHRASE first (the backup contains user data)");
    else {
      try { await api.sendDocument(config.OWNER_ID, new InputFile(result.file, path.basename(result.file)), { caption: `🗄 backup ${path.basename(result.file)}` }); sentToOwner = true; } catch (e) { errors.push(`telegram: ${e instanceof Error ? e.message : e}`); }
    }
  }
  if (s3Configured(config)) {
    try { s3Key = await uploadS3(config, result.file); } catch (e) { errors.push(`s3: ${e instanceof Error ? e.message : e}`); }
  }
  const pruned = pruneBackups(config);
  log[errors.length ? "warn" : "info"]("backup_done", { file: path.basename(result.file), bytes: result.bytes, sentToOwner, s3Key, errors });
  return { result, sentToOwner, s3Key, pruned, errors };
}

/** Checks hourly; runs once per day at BACKUP_HOUR (bot time zone). */
export function startBackupScheduler(store: Store, config: Config, api: Api, onError?: (key: string, text: string) => void): () => void {
  if (!config.BACKUP_ENABLED) return () => {};
  const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: config.TIMEZONE, hour: "2-digit", hourCycle: "h23" });
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: config.TIMEZONE });
  const t = setInterval(async () => {
    const now = new Date();
    if (Number(hourFmt.format(now)) !== config.BACKUP_HOUR) return;
    const today = dayFmt.format(now);
    if (store.getSetting("last_backup_day") === today) return;
    store.setSetting("last_backup_day", today);
    try {
      const r = await runBackup(store, config, api);
      if (r.errors.length) onError?.("backup", `⚠️ backup finished with problems: ${r.errors.join("; ")}`);
    } catch (e) { onError?.("backup", `🚨 backup failed: ${e instanceof Error ? e.message : e}`); }
  }, 10 * 60_000);
  return () => clearInterval(t);
}
