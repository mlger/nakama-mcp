#!/usr/bin/env node
// No-network smoke test: starts the built server over stdio and checks the
// protocol surface only (no Nakama required). Fast feedback for CI + local dev.
//   npm run build && npm run test:smoke
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const EXPECTED_TOOLS = 14;

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
    const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), 10000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });

const results = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
async function check(label, fn) {
  try { const d = await fn(); results.push(true); console.log(`  PASS  ${label}${d ? `  — ${d}` : ""}`); }
  catch (err) { results.push(false); console.log(`  FAIL  ${label}\n        ${err.message}`); }
}

console.log("nakama-mcp smoke test (no Nakama required)\n");
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  await check("initialize returns serverInfo", async () => {
    assert(init.result?.serverInfo?.name === "nakama-mcp", "bad serverInfo");
    return init.result.serverInfo.name;
  });

  let tools = [];
  await check(`tools/list returns ${EXPECTED_TOOLS} tools`, async () => {
    const m = await rpc("tools/list", {});
    tools = m.result?.tools ?? [];
    assert(tools.length === EXPECTED_TOOLS, `expected ${EXPECTED_TOOLS}, got ${tools.length}`);
    return `${tools.length} tools`;
  });

  await check("every tool has a description + annotations", async () => {
    for (const t of tools) {
      assert(typeof t.description === "string" && t.description.length > 10, `${t.name}: weak description`);
      assert(t.annotations && typeof t.annotations.readOnlyHint === "boolean", `${t.name}: missing readOnlyHint`);
    }
    return "all valid";
  });

  await check("nakama_healthcheck tool is registered", async () => {
    assert(tools.some((t) => t.name === "nakama_healthcheck"), "missing nakama_healthcheck");
    return "present";
  });

  await check("search_actions works against the bundled catalog", async () => {
    const m = await rpc("tools/call", { name: "nakama_search_actions", arguments: { query: "leaderboard records", limit: 3 } });
    const data = JSON.parse(m.result?.content?.[0]?.text ?? "{}");
    assert(data.count > 0, "no matches");
    return `${data.count} matches`;
  });
} catch (err) {
  console.log(`\nFATAL: ${err.message}`);
} finally {
  child.kill();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed > 0 || results.length === 0 ? 1 : 0);
