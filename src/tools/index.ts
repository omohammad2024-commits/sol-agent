import type { Config } from "../config";
import type { Tool } from "../types";
import type { McpManager } from "../mcp";
import { makeAdminTools } from "./admin";
import { docTools } from "./docs";
import { groupTools } from "./groups";
import { speechTools } from "./speech";
import { execTools } from "./exec";
import { fileTools } from "./files";
import { github } from "./github";
import { infoTools } from "./info";
import { jobTools } from "./jobs";
import { mediaTools } from "./media";
import { memoryTools } from "./memory";
import { telegramTools } from "./telegram";
import { virustotalScan } from "./virustotal";
import { webTools } from "./web";

/** All tools whose prerequisites (API keys, sandbox) are configured. */
export function buildTools(config: Config, hooks: { getMcp?: () => McpManager | null } = {}): Tool[] {
  const all: Tool[] = [...infoTools, ...webTools, ...mediaTools, ...fileTools, ...memoryTools, ...jobTools, ...docTools, ...speechTools, ...groupTools, ...telegramTools, ...execTools, virustotalScan, github];
  all.push(...makeAdminTools(() => all, hooks.getMcp));
  const names = new Set<string>();
  for (const t of all) {
    if (names.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    names.add(t.name);
  }
  return all.filter((t) => !t.enabled || t.enabled(config));
}
