// Usage:  BACKUP_PASSPHRASE=... bun scripts/restore.ts data/backups/sol-20261013-04.db.gz.enc data/sol.db
// Stop the bot first. The old database (if any) is kept as <out>.bak
import fs from "node:fs";
import { decryptBuffer } from "../src/backup";

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error("usage: bun scripts/restore.ts <backup file> <output db>"); process.exit(1); }
let data: Buffer = fs.readFileSync(src);
if (src.endsWith(".enc")) {
  const pass = process.env.BACKUP_PASSPHRASE;
  if (!pass) { console.error("set BACKUP_PASSPHRASE"); process.exit(1); }
  data = decryptBuffer(data, pass);
}
const db = Buffer.from(Bun.gunzipSync(new Uint8Array(data)));
if (db.subarray(0, 15).toString() !== "SQLite format 3") { console.error("restored data is not a SQLite database"); process.exit(1); }
if (fs.existsSync(out)) fs.renameSync(out, out + ".bak");
for (const ext of ["-wal", "-shm"]) fs.rmSync(out + ext, { force: true });
fs.writeFileSync(out, db);
console.log(`restored ${db.length} bytes to ${out}`);
