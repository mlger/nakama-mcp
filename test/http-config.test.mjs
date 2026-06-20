#!/usr/bin/env node
// Unit test for HTTP config parsing + the bind security guardrail.
// Requires `npm run build` first (imports dist).
import { httpSecurityError } from "../dist/config.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log(`  PASS  ${m}`); else { failed++; console.log(`  FAIL  ${m}`); } };

console.log("http config unit test\n");

ok(httpSecurityError("0.0.0.0", undefined) !== undefined, "non-loopback without token is rejected");
ok(httpSecurityError("0.0.0.0", "tok") === undefined, "non-loopback with token is allowed");
ok(httpSecurityError("127.0.0.1", undefined) === undefined, "loopback without token is allowed");
ok(httpSecurityError("::1", undefined) === undefined, "ipv6 loopback without token is allowed");
ok(httpSecurityError("localhost", undefined) === undefined, "localhost without token is allowed");
ok(httpSecurityError("127.0.0.5", undefined) === undefined, "127.0.0.0/8 without token is allowed");

// loadHttpConfig reads process.env; verify defaults + parsing.
const { loadHttpConfig } = await import("../dist/config.js");
for (const k of ["MCP_TRANSPORT","MCP_HTTP_HOST","MCP_HTTP_PORT","MCP_HTTP_PATH","MCP_AUTH_TOKEN","MCP_SESSION_TTL_MS"]) delete process.env[k];
const def = loadHttpConfig();
ok(def.transport === "stdio", "default transport is stdio");
ok(def.host === "127.0.0.1" && def.port === 3000 && def.path === "/mcp", "defaults host/port/path");
ok(def.authToken === undefined && def.sessionTtlMs === 1800000, "defaults token/ttl");

process.env.MCP_TRANSPORT = "http";
process.env.MCP_HTTP_PORT = "8080";
process.env.MCP_AUTH_TOKEN = "secret";
const cfg = loadHttpConfig();
ok(cfg.transport === "http" && cfg.port === 8080 && cfg.authToken === "secret", "parses overrides");

let threw = false;
process.env.MCP_TRANSPORT = "bogus";
try { loadHttpConfig(); } catch { threw = true; }
ok(threw, "invalid MCP_TRANSPORT throws");

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
