import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NakamaConfig } from "./config.js";
import { NakamaClient, type ConsoleAuth } from "./nakama.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

/** Build a fully-wired MCP server bound to a (per-session) NakamaClient. */
export function buildMcpServer(cfg: NakamaConfig, consoleAuth?: ConsoleAuth): McpServer {
  const nakama = new NakamaClient(cfg, consoleAuth);
  const server = new McpServer({ name: "nakama-mcp", version: VERSION });
  registerTools(server, nakama);
  return server;
}
