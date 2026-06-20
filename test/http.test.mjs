#!/usr/bin/env node
// HTTP transport smoke test (no Nakama required). Spawns the built server in
// http mode on an ephemeral port and checks auth, healthz, the MCP handshake,
// the tool surface, and per-session isolation.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const TOKEN = "test-token-123456";
const EXPECTED_TOOLS = 14;

let failed = 0;
const ok = (c, m) => { if (c) console.log(`  PASS  ${m}`); else { failed++; console.log(`  FAIL  ${m}`); } };

// Spawn server in http mode; resolve with the actual bound port parsed from the ready line.
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [entry], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, MCP_TRANSPORT: "http", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "0", MCP_AUTH_TOKEN: TOKEN },
    });
    let err = "";
    const t = setTimeout(() => reject(new Error("server did not become ready: " + err)), 10000);
    child.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (process.env.VERBOSE) process.stderr.write("[srv] " + s);
      const m = s.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(t); resolve({ child, port: Number(m[1]) }); }
    });
  });
}

console.log("nakama-mcp http transport test (no Nakama required)\n");
const { child, port } = await startServer();
const base = `http://127.0.0.1:${port}`;

async function connectClient() {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

try {
  const health = await fetch(`${base}/healthz`);
  ok(health.status === 200, "GET /healthz returns 200");

  const noAuth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  ok(noAuth.status === 401, "POST /mcp without bearer returns 401");

  const wrongAuth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer wrong" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  ok(wrongAuth.status === 401, "POST /mcp with wrong bearer returns 401");

  const a = await connectClient();
  const list = await a.client.listTools();
  ok(list.tools.length === EXPECTED_TOOLS, `tools/list returns ${EXPECTED_TOOLS} (got ${list.tools.length})`);
  ok(typeof a.transport.sessionId === "string" && a.transport.sessionId.length > 0, "session A has an id");

  const b = await connectClient();
  ok(typeof b.transport.sessionId === "string" && b.transport.sessionId.length > 0, "session B has an id");
  ok(a.transport.sessionId !== b.transport.sessionId, "two clients get distinct session ids");

  await a.client.close();
  await b.client.close();
} catch (err) {
  console.log(`\nFATAL: ${err.message}`);
} finally {
  child.kill();
}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
