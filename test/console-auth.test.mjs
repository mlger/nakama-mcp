#!/usr/bin/env node
// Two NakamaClients sharing a ConsoleAuth holder must trigger only ONE
// console login, even when called concurrently (in-flight guard).
// Requires `npm run build` first. No Nakama required — global fetch is stubbed.
import { NakamaClient } from "../dist/nakama.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log(`  PASS  ${m}`); else { failed++; console.log(`  FAIL  ${m}`); } };

const cfg = {
  host: "127.0.0.1", clientPort: 7350, consolePort: 7351, useSsl: false,
  serverKey: "defaultkey", consoleUsername: "admin", consolePassword: "password", timeoutMs: 5000,
};

let authCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/v2/console/authenticate")) {
    authCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ token: "faketoken" }) };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok" }) };
};

console.log("console-auth sharing unit test\n");

const shared = {};
const a = new NakamaClient(cfg, shared);
const b = new NakamaClient(cfg, shared);

// Concurrent first use across two clients -> in-flight guard collapses to one login.
await Promise.all([
  a.request({ surface: "console", method: "GET", path: "/v2/console/status" }),
  b.request({ surface: "console", method: "GET", path: "/v2/console/status" }),
]);
ok(authCalls === 1, `concurrent shared clients log in once (got ${authCalls})`);

// Subsequent call reuses cached token -> no new login.
await b.request({ surface: "console", method: "GET", path: "/v2/console/status" });
ok(authCalls === 1, `cached token reused, still one login (got ${authCalls})`);

// A client with its own (default) holder logs in independently.
const solo = new NakamaClient(cfg);
await solo.request({ surface: "console", method: "GET", path: "/v2/console/status" });
ok(authCalls === 2, `independent holder logs in separately (got ${authCalls})`);

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
