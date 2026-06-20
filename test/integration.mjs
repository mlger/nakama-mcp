#!/usr/bin/env node
// Live integration test: drives the nakama-mcp server over stdio against a REAL
// Nakama (start one with `docker compose up -d`). Exits non-zero on any failure.
//
//   npm run build && npm run test:integration
//
// Honors the same NAKAMA_* env vars as the server (defaults = docker-compose).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");

const child = spawn("node", [entry], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write("[srv] " + d); });

let nextId = 1;
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const rpc = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 30000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });

async function callTool(name, args = {}) {
  const m = await rpc("tools/call", { name, arguments: args });
  if (m.error) throw new Error(`${name}: ${JSON.stringify(m.error)}`);
  const r = m.result || {};
  const text = r.content?.[0]?.text ?? "";
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { isError: !!r.isError, data, text };
}

const results = [];
const skip = (reason) => ({ __skip: true, reason });
async function check(label, fn) {
  try {
    const detail = await fn();
    if (detail && detail.__skip) {
      results.push({ label, ok: true, skipped: true, detail: detail.reason });
      console.log(`  SKIP  ${label}  — ${detail.reason}`);
      return;
    }
    results.push({ label, ok: true, detail });
    console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ""}`);
  } catch (err) {
    results.push({ label, ok: false, detail: err.message });
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// Compare storage values by semantic JSON equality, not byte-for-byte: the
// backend (CockroachDB JSONB) renders stored JSON with its own whitespace and
// key ordering, so a literal string compare is brittle across server versions.
const canonicalJson = (v) => {
  const parsed = typeof v === "string" ? JSON.parse(v) : v;
  const sort = (x) =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]))
        : x;
  return JSON.stringify(sort(parsed));
};

console.log("nakama-mcp integration test\n");

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration", version: "0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  await check("tools/list returns 14 tools", async () => {
    const m = await rpc("tools/list", {});
    const n = m.result?.tools?.length ?? 0;
    assert(n === 14, `expected 14 tools, got ${n}`);
    return `${n} tools`;
  });

  await check("console_get_status (auto-login + bearer)", async () => {
    const r = await callTool("nakama_console_get_status");
    assert(!r.isError, r.text);
    assert(r.data && typeof r.data === "object", "no status object");
    return "got node status";
  });

  await check("console_list_accounts", async () => {
    const r = await callTool("nakama_console_list_accounts", { });
    assert(!r.isError, r.text);
    assert(r.data && ("users" in r.data || "total_count" in r.data), "no users field");
    return `total_count=${r.data.total_count ?? "?"}`;
  });

  const deviceId = `it-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await check("authenticate device (Basic server key)", async () => {
    const r = await callTool("nakama_authenticate", { method: "device", id: deviceId, create: true });
    assert(!r.isError, r.text);
    assert(r.data.authenticated === true, "not authenticated");
    return r.data.token_preview;
  });

  let userId;
  await check("execute Nakama_GetAccount (player session bearer)", async () => {
    const r = await callTool("nakama_execute_action", { action_id: "Nakama_GetAccount" });
    assert(!r.isError, r.text);
    userId = r.data?.user?.id;
    assert(userId, "no user.id in account");
    return `user.id=${userId}`;
  });

  const collection = "it_tests";
  const key = `k-${Date.now()}`;
  const value = JSON.stringify({ hello: "world", ts: Date.now() });
  await check("execute Nakama_WriteStorageObjects (write)", async () => {
    const r = await callTool("nakama_execute_action", {
      action_id: "Nakama_WriteStorageObjects",
      body: { objects: [{ collection, key, value, permission_read: 1, permission_write: 1 }] },
    });
    assert(!r.isError, r.text);
    assert(Array.isArray(r.data?.acks) && r.data.acks.length === 1, "no ack returned");
    return `ack version=${r.data.acks[0].version?.slice(0, 10)}…`;
  });

  await check("execute Nakama_ReadStorageObjects (read back)", async () => {
    const r = await callTool("nakama_execute_action", {
      action_id: "Nakama_ReadStorageObjects",
      body: { object_ids: [{ collection, key, user_id: userId }] },
    });
    assert(!r.isError, r.text);
    const obj = r.data?.objects?.[0];
    assert(obj, "object not found on read-back");
    assert(canonicalJson(obj.value) === canonicalJson(value), `value mismatch: ${obj.value}`);
    return "round-trip value matches";
  });

  await check("write_storage_object (promoted) round-trip", async () => {
    const c2 = "it_promoted";
    const k2 = `k-${Date.now()}`;
    const v2 = { via: "promoted", n: 42 };
    const w = await callTool("nakama_write_storage_object", { collection: c2, key: k2, value: v2 });
    assert(!w.isError, w.text);
    const r = await callTool("nakama_execute_action", { action_id: "Nakama_ReadStorageObjects", body: { object_ids: [{ collection: c2, key: k2, user_id: userId }] } });
    assert(!r.isError, r.text);
    assert(canonicalJson(r.data?.objects?.[0]?.value) === canonicalJson(v2), "value mismatch via promoted tool");
    return "written & read via promoted tool";
  });

  await check("send_notification (console)", async () => {
    const r = await callTool("nakama_send_notification", { user_id: userId, subject: "integration test", content: { msg: "hi" }, code: 1 });
    assert(!r.isError, r.text);
    return "sent";
  });

  await check("ban then unban account (console)", async () => {
    const b = await callTool("nakama_ban_account", { id: userId });
    assert(!b.isError, b.text);
    const u = await callTool("nakama_unban_account", { id: userId });
    assert(!u.isError, u.text);
    return "ban + unban ok";
  });

  await check("healthcheck reports both surfaces reachable", async () => {
    const r = await callTool("nakama_healthcheck");
    assert(!r.isError, r.text);
    assert(r.data?.client?.reachable && r.data?.console?.reachable, `not reachable: ${JSON.stringify(r.data)}`);
    return "client + console reachable";
  });

  await check("auto-pagination on list_accounts", async () => {
    const r = await callTool("nakama_console_list_accounts", { auto_paginate: true, max_pages: 3 });
    assert(!r.isError, r.text);
    assert(typeof r.data?.__pages_fetched === "number", "no pagination metadata");
    return `pages=${r.data.__pages_fetched}, more=${r.data.__more_available}`;
  });

  await check("write_leaderboard_record (env-gated)", async () => {
    const lb = process.env.NAKAMA_TEST_LEADERBOARD;
    if (!lb) return skip("set NAKAMA_TEST_LEADERBOARD to run");
    const r = await callTool("nakama_write_leaderboard_record", { leaderboard_id: lb, score: 100, metadata: { from: "test" } });
    assert(!r.isError, r.text);
    return `wrote score to ${lb}`;
  });

  await check("search_actions still works", async () => {
    const r = await callTool("nakama_search_actions", { query: "ban account", limit: 3 });
    assert(!r.isError && r.data.count > 0, "no matches");
    return `${r.data.count} matches`;
  });
} catch (err) {
  console.log(`\nFATAL: ${err.message}`);
  if (/ECONNREFUSED|Failed to reach|timeout/.test(err.message)) {
    console.log("Is Nakama running?  Try:  docker compose up -d");
  }
} finally {
  child.kill();
}

const passed = results.filter((r) => r.ok && !r.skipped).length;
const skipped = results.filter((r) => r.skipped).length;
const failed = results.filter((r) => !r.ok).length;
if (results.some((r) => !r.ok && /Failed to reach|ECONNREFUSED/.test(r.detail))) {
  console.log("\nCould not reach Nakama. Start it with:  docker compose up -d   (wait for healthy)");
}
console.log(`\n${passed} passed${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} failed` : ""} of ${results.length}.`);
process.exit(failed > 0 || passed === 0 ? 1 : 0);
