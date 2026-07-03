#!/usr/bin/env node
// Live HTTP transport integration test: drives the built server in HTTP mode
// against a REAL Nakama (start one with `docker compose up -d --wait`), over the
// MCP streamable-HTTP transport, using the SDK client.
//
//   npm run build && npm run test:http-integration
//
// This complements test/integration.mjs (which drives live Nakama over stdio)
// and test/http.test.mjs (which drives the HTTP transport with no Nakama). It
// verifies the HTTP transport end-to-end against a live backend, including the
// per-session player-session isolation that only the HTTP transport provides.
//
// Honors the same NAKAMA_* env vars as the server (defaults = docker-compose).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");
const TOKEN = "http-it-token-123456";
const EXPECTED_TOOLS = 14;

const results = [];
let failed = 0;
function record(label, okFlag, detail) {
  results.push({ label, ok: okFlag, detail });
  if (okFlag) console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ""}`);
  else { failed++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// Spawn server in http mode on an ephemeral port; resolve the bound port from
// the stderr ready line. Inherits process.env so NAKAMA_* reach the server.
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [entry], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, MCP_TRANSPORT: "http", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "0", MCP_AUTH_TOKEN: TOKEN },
    });
    let err = "";
    const t = setTimeout(() => reject(new Error("server did not become ready: " + err)), 15000);
    child.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (process.env.VERBOSE) process.stderr.write("[srv] " + s);
      const m = s.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(t); resolve({ child, port: Number(m[1]) }); }
    });
    child.on("exit", (code) => {
      if (code != null) reject(new Error(`server exited early (code ${code}): ${err}`));
    });
  });
}

async function connectClient(base) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "http-it", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { isError: !!r.isError, data, text };
}

// Canonical JSON compare — the backend (CockroachDB JSONB) re-renders stored
// JSON with its own whitespace/key order, so byte compare is brittle.
const canonicalJson = (v) => {
  const parsed = typeof v === "string" ? JSON.parse(v) : v;
  const sort = (x) =>
    Array.isArray(x) ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]))
        : x;
  return JSON.stringify(sort(parsed));
};

console.log("nakama-mcp http integration test (live Nakama over HTTP transport)\n");

const { child, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
let clientA, clientB;

try {
  // --- Transport surface (needs no Nakama) -----------------------------------
  const health = await fetch(`${base}/healthz`);
  record("GET /healthz returns 200", health.status === 200, `status=${health.status}`);

  const noAuth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  record("POST /mcp without bearer returns 401", noAuth.status === 401, `status=${noAuth.status}`);

  clientA = await connectClient(base);
  const list = await clientA.client.listTools();
  record("tools/list returns 14 tools", list.tools.length === EXPECTED_TOOLS, `${list.tools.length} tools`);

  // --- Console API (auto-login, shared across HTTP sessions) -----------------
  let status;
  {
    const r = await callTool(clientA.client, "nakama_console_get_status");
    record("console_get_status (auto-login + console bearer)", !r.isError && r.data && typeof r.data === "object", r.isError ? r.text : "got node status");
    status = r.data;
  }

  // --- Per-session player isolation (HTTP-only guarantee) --------------------
  // Two MCP sessions over HTTP must each hold their OWN player session; the
  // client API surface is not shared across sessions even though the console
  // admin login is.
  clientB = await connectClient(base);
  record("sessions A and B have distinct ids",
    clientA.transport.sessionId !== clientB.transport.sessionId && !!clientA.transport.sessionId,
    `A=${clientA.transport.sessionId?.slice(0, 8)} B=${clientB.transport.sessionId?.slice(0, 8)}`);

  const deviceA = `httpit-A-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const deviceB = `httpit-B-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  let r = await callTool(clientA.client, "nakama_authenticate", { method: "device", id: deviceA, create: true });
  record("session A authenticates a distinct player", !r.isError && r.data?.authenticated === true, r.isError ? r.text : r.data?.token_preview);

  r = await callTool(clientB.client, "nakama_authenticate", { method: "device", id: deviceB, create: true });
  record("session B authenticates a distinct player", !r.isError && r.data?.authenticated === true, r.isError ? r.text : r.data?.token_preview);

  let userA, userB;
  r = await callTool(clientA.client, "nakama_execute_action", { action_id: "Nakama_GetAccount" });
  userA = r.data?.user?.id;
  record("session A GetAccount returns its own user", !r.isError && !!userA, r.isError ? r.text : `user.id=${userA}`);

  r = await callTool(clientB.client, "nakama_execute_action", { action_id: "Nakama_GetAccount" });
  userB = r.data?.user?.id;
  record("session B GetAccount returns a different user", !r.isError && !!userB && userB !== userA, r.isError ? r.text : `user.id=${userB}`);

  // --- Storage write/read round-trip over HTTP -------------------------------
  const collection = "http_it";
  const key = `k-${Date.now()}`;
  const value = { via: "http-transport", ts: Date.now() };
  r = await callTool(clientA.client, "nakama_write_storage_object", { collection, key, value });
  record("write_storage_object over HTTP", !r.isError, r.isError ? r.text : `ack version=${r.data?.acks?.[0]?.version?.slice(0, 10)}…`);

  r = await callTool(clientA.client, "nakama_execute_action", {
    action_id: "Nakama_ReadStorageObjects",
    body: { object_ids: [{ collection, key, user_id: userA }] },
  });
  {
    const obj = r.data?.objects?.[0];
    record("read back the written storage object", !r.isError && obj && canonicalJson(obj.value) === canonicalJson(value), r.isError ? r.text : "round-trip value matches");
  }

  // --- Auto-pagination through the HTTP path ---------------------------------
  r = await callTool(clientA.client, "nakama_console_list_accounts", { auto_paginate: true, max_pages: 3 });
  record("auto-pagination works over HTTP", !r.isError && typeof r.data?.__pages_fetched === "number", r.isError ? r.text : `pages=${r.data?.__pages_fetched}, more=${r.data?.__more_available}`);

  // --- Healthcheck (both surfaces reachable through the HTTP transport) ------
  r = await callTool(clientA.client, "nakama_healthcheck");
  record("healthcheck reports both surfaces reachable", !r.isError && r.data?.client?.reachable && r.data?.console?.reachable, r.isError ? r.text : "client + console reachable");

  // --- Error path is redacted before it reaches the client -------------------
  // A request that the backend rejects (missing required body field) must
  // still return redacted output and surface as isError, not crash the tool.
  r = await callTool(clientA.client, "nakama_execute_action", {
    action_id: "Nakama_WriteStorageObjects",
    body: { objects: [{ collection: "http_it", key: `bad-${Date.now()}` /* value intentionally omitted */ }] },
  });
  record("malformed write returns isError (not a throw) with redacted text",
    r.isError && typeof r.text === "string" && r.text.length > 0,
    r.isError ? `isError ok, len=${r.text.length}` : r.text);

  // --- search_actions still works --------------------------------------------
  r = await callTool(clientA.client, "nakama_search_actions", { query: "ban account", limit: 3 });
  record("search_actions works over HTTP", !r.isError && r.data?.count > 0, r.isError ? r.text : `${r.data.count} matches`);

  if (status !== undefined) console.log(`\n  (node status seen: ${typeof status === "object" ? "ok" : "n/a"})`);
} catch (err) {
  record("uncaught", false, err.message);
  if (/ECONNREFUSED|Failed to reach|timeout/i.test(err.message)) {
    console.log("\nIs Nakama running?  Try:  docker compose up -d --wait   (wait for healthy)");
  }
} finally {
  try { if (clientA) await clientA.client.close(); } catch {}
  try { if (clientB) await clientB.client.close(); } catch {}
  child.kill();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""} of ${results.length}.`);
process.exit(failed > 0 || passed === 0 ? 1 : 0);
