import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------------------------
// Versioned migrations (PRAGMA user_version). Never edit an old migration; append a new one.
// ---------------------------------------------------------------------------------------------
const V1 = `
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, msg_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, role TEXT NOT NULL,
  user_id INTEGER, text TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, owner TEXT NOT NULL,
  key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(scope, owner, key)
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  text TEXT NOT NULL, due_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS acl (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tool_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id INTEGER, chat_id INTEGER,
  tool TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER NOT NULL, err TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_log_ts ON tool_log(ts);
`;

const hasColumn = (db: Database, table: string, col: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

const MIGRATIONS: ((db: Database) => void)[] = [
  // 1: base schema
  (db) => db.exec(V1),
  // 2: semantic memory + conversation summaries
  (db) => {
    if (!hasColumn(db, "memories", "embedding")) db.exec("ALTER TABLE memories ADD COLUMN embedding BLOB");
    db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, summary TEXT NOT NULL, embedding BLOB,
        from_msg INTEGER NOT NULL, to_msg INTEGER NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes(chat_id, id);
      CREATE TABLE IF NOT EXISTS chat_state (chat_id INTEGER PRIMARY KEY, summarized_upto INTEGER NOT NULL DEFAULT 0);
    `);
  },
  // 3: unified jobs (reminders, recurring tasks, background prompts, price alerts)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        chat_type TEXT NOT NULL DEFAULT 'private', kind TEXT NOT NULL, text TEXT NOT NULL, payload TEXT,
        cron TEXT, tz TEXT, due_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        runs INTEGER NOT NULL DEFAULT 0, max_runs INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER, created_at INTEGER NOT NULL, last_run INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(active, due_at);
      INSERT INTO jobs(chat_id, user_id, chat_type, kind, text, due_at, max_runs, created_at)
        SELECT chat_id, user_id, 'private', 'reminder', text, due_at, 1, due_at FROM reminders WHERE done=0;
    `);
  },
  // 4: usage / cost tracking
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER,
      model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_log(day, user_id);
  `),
  // 5: group log + moderation warnings
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS group_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, msg_id INTEGER, user_id INTEGER, name TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_log ON group_log(chat_id, id);
    CREATE TABLE IF NOT EXISTS warnings (
      chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL, last_reason TEXT,
      PRIMARY KEY(chat_id, user_id)
    );
  `),
];

export function migrate(db: Database): number {
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[i]!(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${i + 1} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return MIGRATIONS.length;
}

export const SCHEMA_VERSION = MIGRATIONS.length;

// ---------------------------------------------------------------------------------------------

export type Scope = "user" | "group" | "global";
export type AclLevel = "trusted" | "banned" | "admin";

export interface UserRow { user_id: number; username: string | null; first_name: string | null; first_seen: number; last_seen: number; msg_count: number }
export interface MemRow { key: string; value: string; updated_at: number }
export interface MemEmbRow extends MemRow { embedding: Float32Array | null }
export interface EpisodeRow { id: number; chat_id: number; summary: string; embedding: Float32Array | null; from_msg: number; to_msg: number; ts: number }
export interface JobRow {
  id: number; chat_id: number; user_id: number; chat_type: string; kind: "reminder" | "prompt" | "alert"; text: string; payload: string | null;
  cron: string | null; tz: string | null; due_at: number; active: number; runs: number; max_runs: number | null; attempts: number;
  expires_at: number | null; created_at: number; last_run: number | null;
}
export interface NewJob {
  chatId: number; userId: number; chatType?: string; kind: JobRow["kind"]; text: string; payload?: unknown; cron?: string | null; tz?: string | null;
  dueAt: number; maxRuns?: number | null; expiresAt?: number | null;
}
export interface UsageRow { calls: number; input: number; output: number; cache_read: number; cache_write: number; cost: number; unpriced: number }

const toBlob = (f: Float32Array | null | undefined) => (f ? Buffer.from(f.buffer, f.byteOffset, f.byteLength) : null);
const fromBlob = (b: Uint8Array | null | undefined): Float32Array | null =>
  b && b.byteLength >= 4 && b.byteLength % 4 === 0 ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null;

export class Store {
  readonly db: Database;
  constructor(file: string) {
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    migrate(this.db);
  }
  close() { this.db.close(); }
  schemaVersion(): number { return (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version; }
  /** Consistent snapshot of the whole database into `file` (safe while the bot is running). */
  snapshotTo(file: string) {
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }

  // ---- users ----
  touchUser(u: { id: number; username?: string; first_name?: string }) {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO users(user_id, username, first_name, first_seen, last_seen, msg_count) VALUES(?,?,?,?,?,1)
         ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_seen=excluded.last_seen, msg_count=msg_count+1`,
      )
      .run(u.id, u.username ?? null, u.first_name ?? null, now, now);
  }
  getUser(id: number): UserRow | null {
    return (this.db.query("SELECT * FROM users WHERE user_id=?").get(id) as UserRow) ?? null;
  }

  // ---- short-term history ----
  addMessage(chatId: number, role: "user" | "assistant", text: string, userId?: number) {
    this.db.query("INSERT INTO messages(chat_id, role, user_id, text, ts) VALUES(?,?,?,?,?)").run(chatId, role, userId ?? null, text, Date.now());
    this.db
      .query("DELETE FROM messages WHERE chat_id=? AND id <= COALESCE((SELECT id FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1 OFFSET 300), 0)")
      .run(chatId, chatId);
  }
  history(chatId: number, limit: number): { role: "user" | "assistant"; text: string }[] {
    const rows = this.db.query("SELECT role, text FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?").all(chatId, limit) as { role: "user" | "assistant"; text: string }[];
    return rows.reverse();
  }
  clearHistory(chatId: number) {
    this.db.query("DELETE FROM messages WHERE chat_id=?").run(chatId);
    this.db.query("DELETE FROM chat_state WHERE chat_id=?").run(chatId);
  }
  countMessages(userId: number): number {
    return (this.db.query("SELECT COUNT(*) c FROM messages WHERE user_id=?").get(userId) as { c: number }).c;
  }
  latestMessageId(chatId: number): number {
    return ((this.db.query("SELECT MAX(id) m FROM messages WHERE chat_id=?").get(chatId) as { m: number | null }).m) ?? 0;
  }
  countMessagesAfter(chatId: number, afterId: number): number {
    return (this.db.query("SELECT COUNT(*) c FROM messages WHERE chat_id=? AND id>?").get(chatId, afterId) as { c: number }).c;
  }
  /** id of the message that is `keepLast` positions from the newest (everything <= it may be summarized). 0 if too few. */
  summarizeCutoff(chatId: number, keepLast: number): number {
    return ((this.db.query("SELECT id FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1 OFFSET ?").get(chatId, keepLast) as { id: number } | null)?.id) ?? 0;
  }
  messagesBetween(chatId: number, afterId: number, uptoId: number, limit = 150): { id: number; role: "user" | "assistant"; text: string; ts: number }[] {
    return this.db.query("SELECT id, role, text, ts FROM messages WHERE chat_id=? AND id>? AND id<=? ORDER BY id LIMIT ?").all(chatId, afterId, uptoId, limit) as any[];
  }
  searchMessages(chatId: number, q: string, limit = 8): { role: string; text: string; ts: number }[] {
    const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    return this.db.query("SELECT role, text, ts FROM messages WHERE chat_id=? AND text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?").all(chatId, like, limit) as any[];
  }
  getSummarizedUpTo(chatId: number): number {
    return ((this.db.query("SELECT summarized_upto s FROM chat_state WHERE chat_id=?").get(chatId) as { s: number } | null)?.s) ?? 0;
  }
  setSummarizedUpTo(chatId: number, id: number) {
    this.db.query("INSERT INTO chat_state(chat_id, summarized_upto) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET summarized_upto=excluded.summarized_upto").run(chatId, id);
  }

  // ---- episodes (summaries of old conversation segments) ----
  addEpisode(e: { chatId: number; summary: string; embedding?: Float32Array | null; fromMsg: number; toMsg: number }): number {
    return Number(this.db.query("INSERT INTO episodes(chat_id, summary, embedding, from_msg, to_msg, ts) VALUES(?,?,?,?,?,?)").run(e.chatId, e.summary, toBlob(e.embedding), e.fromMsg, e.toMsg, Date.now()).lastInsertRowid);
  }
  recentEpisodes(chatId: number, n: number): EpisodeRow[] {
    return (this.db.query("SELECT * FROM episodes WHERE chat_id=? ORDER BY id DESC LIMIT ?").all(chatId, n) as any[]).map((r) => ({ ...r, embedding: fromBlob(r.embedding) })).reverse();
  }
  episodeCount(chatId: number): number {
    return (this.db.query("SELECT COUNT(*) c FROM episodes WHERE chat_id=?").get(chatId) as { c: number }).c;
  }
  episodesWithEmbeddings(chatId: number, limit = 300): EpisodeRow[] {
    return (this.db.query("SELECT * FROM episodes WHERE chat_id=? ORDER BY id DESC LIMIT ?").all(chatId, limit) as any[]).map((r) => ({ ...r, embedding: fromBlob(r.embedding) }));
  }

  // ---- long-term memory ----
  memSet(scope: Scope, owner: string, key: string, value: string, embedding?: Float32Array | null) {
    this.db
      .query(
        `INSERT INTO memories(scope, owner, key, value, updated_at, embedding) VALUES(?,?,?,?,?,?)
         ON CONFLICT(scope, owner, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, embedding=excluded.embedding`,
      )
      .run(scope, owner, key, value, Date.now(), toBlob(embedding));
  }
  memGet(scope: Scope, owner: string, key: string): string | null {
    const r = this.db.query("SELECT value FROM memories WHERE scope=? AND owner=? AND key=?").get(scope, owner, key) as { value: string } | null;
    return r?.value ?? null;
  }
  memDelete(scope: Scope, owner: string, key: string): boolean {
    return this.db.query("DELETE FROM memories WHERE scope=? AND owner=? AND key=?").run(scope, owner, key).changes > 0;
  }
  memList(scope: Scope, owner: string, limit = 50): MemRow[] {
    return this.db.query("SELECT key, value, updated_at FROM memories WHERE scope=? AND owner=? ORDER BY updated_at DESC LIMIT ?").all(scope, owner, limit) as MemRow[];
  }
  memListWithEmbeddings(scope: Scope, owner: string, limit = 500): MemEmbRow[] {
    return (this.db.query("SELECT key, value, updated_at, embedding FROM memories WHERE scope=? AND owner=? ORDER BY updated_at DESC LIMIT ?").all(scope, owner, limit) as any[]).map((r) => ({ ...r, embedding: fromBlob(r.embedding) }));
  }
  memSearch(scope: Scope, owner: string, q: string, limit = 20): MemRow[] {
    const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    return this.db
      .query("SELECT key, value, updated_at FROM memories WHERE scope=? AND owner=? AND (key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?")
      .all(scope, owner, like, like, limit) as MemRow[];
  }
  memCount(scope: Scope, owner: string): number {
    return (this.db.query("SELECT COUNT(*) c FROM memories WHERE scope=? AND owner=?").get(scope, owner) as { c: number }).c;
  }

  // ---- jobs (reminders / recurring / background prompts / alerts) ----
  addJob(j: NewJob): number {
    return Number(
      this.db
        .query("INSERT INTO jobs(chat_id, user_id, chat_type, kind, text, payload, cron, tz, due_at, max_runs, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(j.chatId, j.userId, j.chatType ?? "private", j.kind, j.text, j.payload === undefined ? null : JSON.stringify(j.payload), j.cron ?? null, j.tz ?? null, j.dueAt, j.maxRuns ?? null, j.expiresAt ?? null, Date.now()).lastInsertRowid,
    );
  }
  getJob(id: number): JobRow | null { return (this.db.query("SELECT * FROM jobs WHERE id=?").get(id) as JobRow) ?? null; }
  dueJobs(now: number): JobRow[] {
    return this.db.query("SELECT * FROM jobs WHERE active=1 AND due_at<=? ORDER BY due_at LIMIT 50").all(now) as JobRow[];
  }
  /** Record a successful run; `next` = next due time or null to finish. Finishes automatically at max_runs. */
  markRun(id: number, next: number | null) {
    const j = this.getJob(id);
    if (!j) return;
    const runs = j.runs + 1;
    const done = next === null || (j.max_runs !== null && runs >= j.max_runs) || (j.expires_at !== null && next > j.expires_at);
    this.db.query("UPDATE jobs SET runs=?, last_run=?, attempts=0, active=?, due_at=? WHERE id=?").run(runs, Date.now(), done ? 0 : 1, done ? j.due_at : next, id);
  }
  /** Record a failed run. One-shot jobs are dropped after 3 failures; recurring ones skip to `next`. */
  failJob(id: number, next: number | null): number {
    this.db.query("UPDATE jobs SET attempts=attempts+1 WHERE id=?").run(id);
    const j = this.getJob(id)!;
    if (j.attempts >= 3) {
      if (next !== null) this.db.query("UPDATE jobs SET attempts=0, due_at=? WHERE id=?").run(next, id);
      else this.db.query("UPDATE jobs SET active=0 WHERE id=?").run(id);
    }
    return j.attempts;
  }
  /** Move the next check without counting a run (alerts). */
  snoozeJob(id: number, dueAt: number) { this.db.query("UPDATE jobs SET due_at=? WHERE id=?").run(dueAt, id); }
  finishJob(id: number) { this.db.query("UPDATE jobs SET active=0 WHERE id=?").run(id); }
  listJobs(userId: number, kinds?: JobRow["kind"][]): JobRow[] {
    const rows = this.db.query("SELECT * FROM jobs WHERE active=1 AND user_id=? ORDER BY due_at LIMIT 100").all(userId) as JobRow[];
    return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  }
  countActiveJobs(userId: number): number {
    return (this.db.query("SELECT COUNT(*) c FROM jobs WHERE active=1 AND user_id=?").get(userId) as { c: number }).c;
  }
  cancelJob(id: number, userId: number, isAdmin: boolean): boolean {
    return (isAdmin ? this.db.query("UPDATE jobs SET active=0 WHERE id=? AND active=1").run(id) : this.db.query("UPDATE jobs SET active=0 WHERE id=? AND active=1 AND user_id=?").run(id, userId)).changes > 0;
  }

  // ---- settings ----
  getSetting(key: string): string | null {
    return ((this.db.query("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | null)?.value) ?? null;
  }
  setSetting(key: string, value: string) {
    this.db.query("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  deleteSetting(key: string) { this.db.query("DELETE FROM settings WHERE key=?").run(key); }
  jsonSetting<T>(key: string, d: T): T {
    try { const v = this.getSetting(key); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
  }
  setJsonSetting(key: string, v: unknown) { this.setSetting(key, JSON.stringify(v)); }

  // ---- access control (runtime overrides) ----
  getAcl(id: number): AclLevel | null {
    return ((this.db.query("SELECT level FROM acl WHERE user_id=?").get(id) as { level: AclLevel } | null)?.level) ?? null;
  }
  setAcl(id: number, level: AclLevel | null) {
    if (level === null) this.db.query("DELETE FROM acl WHERE user_id=?").run(id);
    else this.db.query("INSERT INTO acl(user_id, level, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET level=excluded.level, updated_at=excluded.updated_at").run(id, level, Date.now());
  }
  listAcl(): { user_id: number; level: string }[] {
    return this.db.query("SELECT user_id, level FROM acl ORDER BY updated_at DESC LIMIT 100").all() as { user_id: number; level: string }[];
  }

  // ---- tool log / stats ----
  logTool(r: { userId: number; chatId: number; tool: string; ok: boolean; ms: number; err?: string }) {
    this.db.query("INSERT INTO tool_log(ts, user_id, chat_id, tool, ok, ms, err) VALUES(?,?,?,?,?,?,?)").run(Date.now(), r.userId, r.chatId, r.tool, r.ok ? 1 : 0, r.ms, r.err ?? null);
    this.db.query("DELETE FROM tool_log WHERE id <= (SELECT MAX(id) FROM tool_log) - 5000").run();
  }
  toolStats(sinceMs: number): { tool: string; n: number; errors: number }[] {
    return this.db.query("SELECT tool, COUNT(*) n, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) errors FROM tool_log WHERE ts>=? GROUP BY tool ORDER BY n DESC").all(sinceMs) as { tool: string; n: number; errors: number }[];
  }
  countToolSince(tool: string, sinceMs: number, okOnly = true): number {
    return (this.db.query(`SELECT COUNT(*) c FROM tool_log WHERE tool=? AND ts>=? ${okOnly ? "AND ok=1" : ""}`).get(tool, sinceMs) as { c: number }).c;
  }
  recentToolLog(n: number): { ts: number; user_id: number; tool: string; ok: number; ms: number; err: string | null }[] {
    return this.db.query("SELECT ts, user_id, tool, ok, ms, err FROM tool_log ORDER BY id DESC LIMIT ?").all(n) as any[];
  }

  // ---- usage / cost ----
  addUsage(r: { userId: number; chatId?: number; model: string; day: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }) {
    this.db.query("INSERT INTO usage_log(ts, day, user_id, chat_id, model, input, output, cache_read, cache_write, cost) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(Date.now(), r.day, r.userId, r.chatId ?? null, r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.cost);
    this.db.query("DELETE FROM usage_log WHERE id <= (SELECT MAX(id) FROM usage_log) - 200000").run();
  }
  spentToday(userId: number, day: string): number {
    return ((this.db.query("SELECT COALESCE(SUM(cost),0) c FROM usage_log WHERE user_id=? AND day=?").get(userId, day) as { c: number }).c);
  }
  usageSummary(sinceDay: string): UsageRow {
    return this.db.query("SELECT COUNT(*) calls, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write, COALESCE(SUM(cost),0) cost, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced FROM usage_log WHERE day>=?").get(sinceDay) as UsageRow;
  }
  usageByModel(sinceDay: string): (UsageRow & { model: string })[] {
    return this.db.query("SELECT model, COUNT(*) calls, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write, COALESCE(SUM(cost),0) cost, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced FROM usage_log WHERE day>=? GROUP BY model ORDER BY cost DESC").all(sinceDay) as any[];
  }
  topSpenders(sinceDay: string, n: number): { user_id: number; calls: number; cost: number; tokens: number }[] {
    return this.db.query("SELECT user_id, COUNT(*) calls, COALESCE(SUM(cost),0) cost, SUM(input+output+cache_read+cache_write) tokens FROM usage_log WHERE day>=? GROUP BY user_id ORDER BY cost DESC, tokens DESC LIMIT ?").all(sinceDay, n) as any[];
  }
  usageByDay(sinceDay: string): { day: string; calls: number; cost: number }[] {
    return this.db.query("SELECT day, COUNT(*) calls, COALESCE(SUM(cost),0) cost FROM usage_log WHERE day>=? GROUP BY day ORDER BY day").all(sinceDay) as any[];
  }

  // ---- group log & moderation ----
  logGroupMessage(chatId: number, msgId: number | null, userId: number | null, name: string, text: string) {
    this.db.query("INSERT INTO group_log(chat_id, msg_id, user_id, name, text, ts) VALUES(?,?,?,?,?,?)").run(chatId, msgId, userId, name, text, Date.now());
    this.db.query("DELETE FROM group_log WHERE chat_id=? AND id <= COALESCE((SELECT id FROM group_log WHERE chat_id=? ORDER BY id DESC LIMIT 1 OFFSET 1000), 0)").run(chatId, chatId);
  }
  recentGroupMessages(chatId: number, opts: { limit?: number; sinceMs?: number } = {}): { name: string; text: string; ts: number }[] {
    const rows = this.db.query("SELECT name, text, ts FROM group_log WHERE chat_id=? AND ts>=? ORDER BY id DESC LIMIT ?").all(chatId, opts.sinceMs ?? 0, opts.limit ?? 200) as any[];
    return rows.reverse();
  }
  clearGroupLog(chatId: number) { this.db.query("DELETE FROM group_log WHERE chat_id=?").run(chatId); }
  addWarning(chatId: number, userId: number, reason: string): number {
    this.db.query("INSERT INTO warnings(chat_id, user_id, count, last_ts, last_reason) VALUES(?,?,1,?,?) ON CONFLICT(chat_id, user_id) DO UPDATE SET count=count+1, last_ts=excluded.last_ts, last_reason=excluded.last_reason").run(chatId, userId, Date.now(), reason);
    return this.getWarnings(chatId, userId);
  }
  getWarnings(chatId: number, userId: number): number {
    return ((this.db.query("SELECT count c FROM warnings WHERE chat_id=? AND user_id=?").get(chatId, userId) as { c: number } | null)?.c) ?? 0;
  }
  clearWarnings(chatId: number, userId: number) { this.db.query("DELETE FROM warnings WHERE chat_id=? AND user_id=?").run(chatId, userId); }
  listWarnings(chatId: number): { user_id: number; count: number; last_reason: string | null }[] {
    return this.db.query("SELECT user_id, count, last_reason FROM warnings WHERE chat_id=? AND count>0 ORDER BY count DESC LIMIT 30").all(chatId) as any[];
  }

  // ---- admin overview ----
  overview() {
    const c = (sql: string) => (this.db.query(sql).get() as { c: number }).c;
    return {
      users: c("SELECT COUNT(*) c FROM users"),
      messages: c("SELECT COUNT(*) c FROM messages"),
      memories: c("SELECT COUNT(*) c FROM memories"),
      episodes: c("SELECT COUNT(*) c FROM episodes"),
      activeJobs: c("SELECT COUNT(*) c FROM jobs WHERE active=1"),
    };
  }
  recentUsers(n: number): UserRow[] {
    return this.db.query("SELECT * FROM users ORDER BY last_seen DESC LIMIT ?").all(n) as UserRow[];
  }
  allUserIds(): number[] {
    return (this.db.query("SELECT user_id FROM users").all() as { user_id: number }[]).map((r) => r.user_id);
  }
  /** Delete everything stored about a user (privacy / "forget me"). */
  forgetUser(id: number) {
    this.db.query("DELETE FROM memories WHERE scope='user' AND owner=?").run(String(id));
    this.db.query("DELETE FROM messages WHERE chat_id=? OR user_id=?").run(id, id);
    this.db.query("DELETE FROM episodes WHERE chat_id=?").run(id);
    this.db.query("DELETE FROM chat_state WHERE chat_id=?").run(id);
    this.db.query("DELETE FROM jobs WHERE user_id=?").run(id);
    this.db.query("DELETE FROM usage_log WHERE user_id=?").run(id);
    this.db.query("DELETE FROM group_log WHERE user_id=?").run(id);
    this.db.query("DELETE FROM warnings WHERE user_id=?").run(id);
    this.db.query("DELETE FROM users WHERE user_id=?").run(id);
  }

  // ---- creator-defined rules & tool switches ----
  getRules(): string[] { return this.jsonSetting<string[]>("rules", []); }
  addRule(text: string): number { const r = this.getRules(); r.push(text); this.setJsonSetting("rules", r); return r.length; }
  delRule(n: number): boolean {
    const r = this.getRules(); if (n < 1 || n > r.length) return false;
    r.splice(n - 1, 1); this.setJsonSetting("rules", r); return true;
  }
  getDisabledTools(): string[] { return this.jsonSetting<string[]>("disabled_tools", []); }
  setToolDisabled(name: string, disabled: boolean) {
    const s = new Set(this.getDisabledTools()); if (disabled) s.add(name); else s.delete(name);
    this.setJsonSetting("disabled_tools", [...s]);
  }
}
