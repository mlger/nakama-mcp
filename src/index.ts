#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerSecrets } from "./redact.js";
import { buildMcpServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  registerSecrets([cfg.serverKey, cfg.consolePassword]);

  const server = buildMcpServer(cfg);
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
