import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Config } from "./config";
import { log } from "./log";
import type { Store } from "./memory/store";
import type { Level, Tool } from "./types";

export interface McpServerSpec {
  name: string;
  /** Remote server (Streamable HTTP). */
  url?: string;
  headers?: Record<string, string>;
  /** Local server (stdio) - only from the operator's config file, never from chat. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Who may use its tools (default admin). */
  level?: Level;
  /** Tool names that may change things in the outside world: treated as powerful (blocked after untrusted content). */
  powerful?: string[];
  disabled?: boolean;
}

interface Live { spec: McpServerSpec; client: Client; tools: Tool[]; source: "file" | "chat" }

const NAME_RE = /^[a-z0-9_]{1,24}$/;
const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "TMPDIR"];

/** Flatten an MCP tool result into text for the model. */
export function flattenResult(res: any): string {
  const parts: string[] = [];
  for (const c of res?.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image") parts.push(`[image ${c.mimeType ?? ""} omitted]`);
    else if (c.type === "resource") parts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`);
    else parts.push(JSON.stringify(c));
  }
  if (!parts.length && res?.structuredContent) parts.push(JSON.stringify(res.structuredContent));
  const text = parts.join("\n").trim() || "(empty result)";
  if (res?.isError) throw new Error(text);
  return text;
}

/**
 * Connects to MCP servers and exposes their tools as regular agent tools (mcp_<server>_<tool>).
 * Tools are added to / removed from the shared `tools` array at runtime.
 */
export class McpManager {
  private live = new Map<string, Live>();
  constructor(private config: Config, private store: Store, private tools: Tool[]) {}

  /** Servers from the operator's file plus those the admin added from chat (URL only). */
  async connectAll(): Promise<void> {
    const specs: { spec: McpServerSpec; source: "file" | "chat" }[] = [];
    try {
      if (fs.existsSync(this.config.MCP_CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(this.config.MCP_CONFIG_PATH, "utf8"));
        for (const s of Array.isArray(raw) ? raw : raw.servers ?? []) specs.push({ spec: s, source: "file" });
      }
    } catch (e) { log.error("mcp_config_invalid", { error: e }); }
    for (const s of this.store.jsonSetting<McpServerSpec[]>("mcp_servers", [])) specs.push({ spec: s, source: "chat" });
    await Promise.all(specs.map(({ spec, source }) => this.add(spec, source).catch((e) => log.warn("mcp_connect_failed", { server: spec.name, error: e }))));
  }

  list() {
    return [...this.live.values()].map((l) => ({ name: l.spec.name, transport: l.spec.url ? "http" : "stdio", url: l.spec.url, level: l.spec.level ?? "admin", tools: l.tools.map((t) => t.name), source: l.source }));
  }

  async add(spec: McpServerSpec, source: "file" | "chat" = "file"): Promise<string[]> {
    if (spec.disabled) return [];
    if (!NAME_RE.test(spec.name)) throw new Error("Server name must be 1-24 chars of a-z, 0-9, _");
    if (this.live.has(spec.name)) throw new Error(`Server "${spec.name}" is already connected`);
    if (!spec.url && !spec.command) throw new Error("Server needs a url or a command");
    if (source === "chat" && !spec.url) throw new Error("Only remote (URL) servers can be added from chat; stdio servers must be configured in the config file");
    if (spec.url && !/^https?:\/\//i.test(spec.url)) throw new Error("URL must start with http(s)://");

    const client = new Client({ name: "sol-agent", version: "1.0.0" });
    const transport = spec.url
      ? new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers ?? {} } })
      : new StdioClientTransport({
          command: spec.command!, args: spec.args ?? [],
          // never leak the bot's own secrets to child processes
          env: { ...Object.fromEntries(SAFE_ENV_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]!])), ...(spec.env ?? {}) },
          stderr: "ignore",
        });
    await Promise.race([client.connect(transport), new Promise((_, rej) => setTimeout(() => rej(new Error("connect timed out (20s)")), 20_000))]);
    const listed = await client.listTools();
    const level: Level = spec.level ?? "admin";
    const powerful = new Set(spec.powerful ?? []);
    const made: Tool[] = listed.tools.slice(0, 60).map((t: any) => {
      const schema = t.inputSchema && t.inputSchema.type === "object" ? t.inputSchema : { type: "object", properties: {} };
      return {
        name: `mcp_${spec.name}_${String(t.name).replace(/[^a-zA-Z0-9_]/g, "_")}`.slice(0, 64),
        description: `[${spec.name}] ${t.description ?? t.name}`.slice(0, 900),
        parameters: { type: "object", properties: schema.properties ?? {}, required: schema.required ?? [] },
        level,
        untrusted: true,
        taints: true,
        risky: powerful.has(t.name) ? true : undefined,
        async run(args: any) {
          return flattenResult(await client.callTool({ name: t.name, arguments: args }));
        },
      } as Tool;
    });
    this.tools.push(...made);
    this.live.set(spec.name, { spec, client, tools: made, source });
    log.info("mcp_connected", { server: spec.name, tools: made.length });
    return made.map((t) => t.name);
  }

  async remove(name: string): Promise<boolean> {
    const l = this.live.get(name);
    if (!l) return false;
    for (const t of l.tools) { const i = this.tools.indexOf(t); if (i >= 0) this.tools.splice(i, 1); }
    this.live.delete(name);
    await l.client.close().catch(() => {});
    return true;
  }

  /** Persist a chat-added server so it survives restarts. */
  persistChatServers() {
    this.store.setJsonSetting("mcp_servers", [...this.live.values()].filter((l) => l.source === "chat").map((l) => l.spec));
  }

  async closeAll() { for (const n of [...this.live.keys()]) await this.remove(n); }
}

export function exampleMcpConfig(): string {
  return JSON.stringify({ servers: [{ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data/shared"], level: "admin" }, { name: "notes", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer TOKEN" }, level: "trusted", powerful: ["delete_note"] }] }, null, 2);
}
export const mcpConfigDir = (c: Config) => path.dirname(c.MCP_CONFIG_PATH);
