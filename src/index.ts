#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadHttpConfig } from "./config.js";
import { registerSecrets } from "./redact.js";
import { buildMcpServer } from "./server.js";
import { startHttpServer } from "./http.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const http = loadHttpConfig();
  registerSecrets([cfg.serverKey, cfg.consolePassword, http.authToken]);

  if (http.transport === "http") {
    await startHttpServer(cfg, http);
    return;
  }

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
