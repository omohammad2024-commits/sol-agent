// Tiny MCP server (stdio) used by the tests: real protocol, real SDK on both sides.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.tool("echo", "Echo the text back", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
server.tool("boom", "Always fails", {}, async () => ({ isError: true, content: [{ type: "text", text: "it broke" }] }));
server.tool("leak", "Reports whether a secret env var is visible", {}, async () => ({ content: [{ type: "text", text: `BOT_TOKEN=${process.env.BOT_TOKEN ?? "none"}` }] }));
await server.connect(new StdioServerTransport());
