import fs from "node:fs";
import path from "node:path";

// Delete downloaded attachments (workspaces/<user>/incoming) older than maxAgeMs.
export function cleanupIncoming(dataDir: string, maxAgeMs = 24 * 3600_000): number {
  const root = path.join(dataDir, "workspaces");
  let removed = 0;
  if (!fs.existsSync(root)) return 0;
  for (const u of fs.readdirSync(root)) {
    const dir = path.join(root, u, "incoming");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > maxAgeMs) { fs.rmSync(full, { force: true }); removed++; }
      } catch {}
    }
  }
  return removed;
}

export function startMaintenance(dataDir: string): () => void {
  cleanupIncoming(dataDir);
  const t = setInterval(() => cleanupIncoming(dataDir), 3600_000);
  return () => clearInterval(t);
}
