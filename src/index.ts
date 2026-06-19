#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { NakamaClient } from "./nakama.js";
import { registerTools } from "./tools.js";
import { registerSecrets } from "./redact.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  registerSecrets([cfg.serverKey, cfg.consolePassword]);
  const nakama = new NakamaClient(cfg);

  const server = new McpServer({
    name: "nakama-mcp",
    version: "0.1.0",
  });

  registerTools(server, nakama);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is reserved for the MCP protocol.
  process.stderr.write(
    `nakama-mcp ready -> client ${cfg.useSsl ? "https" : "http"}://${cfg.host}:${cfg.clientPort}, console :${cfg.consolePort}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`nakama-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
