#!/usr/bin/env node
// Unit test for the idle-session reaper. Requires `npm run build` first.
// Uses fake session entries (transport stubbed) — no server, no Nakama.
import { reapIdleSessions } from "../dist/http.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log(`  PASS  ${m}`); else { failed++; console.log(`  FAIL  ${m}`); } };

console.log("idle session reaper unit test\n");

let closed = 0;
const mkSession = (lastActivity) => ({ transport: { close: () => { closed++; } }, lastActivity });

const now = 1_000_000;
const ttl = 1000;
const sessions = new Map([
  ["fresh", mkSession(now - 500)],   // within ttl -> keep
  ["stale", mkSession(now - 5000)],  // beyond ttl -> reap
  ["edge",  mkSession(now - 1000)],  // exactly ttl, not strictly greater -> keep
]);

const reaped = reapIdleSessions(sessions, ttl, now);

ok(reaped.length === 1 && reaped[0] === "stale", "only the stale session is reaped");
ok(!sessions.has("stale"), "stale session removed from map");
ok(sessions.has("fresh") && sessions.has("edge"), "fresh + edge sessions retained");
ok(closed === 1, "reaped session's transport.close() was called once");

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
