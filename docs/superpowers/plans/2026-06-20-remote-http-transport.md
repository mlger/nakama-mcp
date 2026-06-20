# Remote HTTP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stateful, network-reachable streamable-HTTP transport to nakama-mcp, selectable via `MCP_TRANSPORT=http`, while stdio stays the default and is byte-for-byte unchanged.

**Architecture:** Two small seams (a shared `ConsoleAuth` holder injected into `NakamaClient`, and a `buildMcpServer` factory) let each HTTP MCP session own an isolated `NakamaClient` (isolated player session) while sharing one admin login. A new `src/http.ts` runs a bare `node:http` server with a per-session `StreamableHTTPServerTransport` map, a static bearer-token gate, and an idle-session reaper.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`), `node:http`, `node:crypto`. Tests are standalone `.mjs` scripts importing from `dist/`.

## Global Constraints

- **Node** `>= 18`. Uses global `fetch`, `node:http`, `node:crypto`.
- **Runtime dependencies stay exactly two:** `@modelcontextprotocol/sdk` and `zod`. Do NOT add Express or any HTTP framework as a direct dependency.
- **ESM / NodeNext:** relative imports use the `.js` extension from `.ts` sources (e.g. `import { x } from "./config.js"`).
- **stdout is reserved for the MCP stdio protocol** — all logs go to `process.stderr`.
- **All model-visible / error output passes through `redact()`** (existing rule).
- **stdio behavior must be byte-for-byte unchanged** when `MCP_TRANSPORT` is unset or `stdio`.
- Build before running tests (tests import `dist/`): `npm run build`.
- Tool count is **14** (existing `smoke.mjs` invariant).

---

### Task 1: HTTP config parsing + security guardrail

**Files:**
- Modify: `src/config.ts` (append after `loadConfig`)
- Test: `test/http-config.test.mjs` (create)

**Interfaces:**
- Produces:
  - `interface HttpConfig { transport: "stdio" | "http"; host: string; port: number; path: string; authToken?: string; sessionTtlMs: number; }`
  - `function loadHttpConfig(): HttpConfig`
  - `function httpSecurityError(host: string, authToken?: string): string | undefined` — returns an error message if binding is unsafe (non-loopback host with no token), else `undefined`.
- Consumes: existing private `intEnv(name, fallback)` in `src/config.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/http-config.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node test/http-config.test.mjs`
Expected: build fails OR test fails with "httpSecurityError is not a function" / "loadHttpConfig is not a function" (not yet implemented).

- [ ] **Step 3: Implement the config additions**

Append to `src/config.ts` (after the existing `loadConfig` function):

```ts
export interface HttpConfig {
  transport: "stdio" | "http";
  host: string;
  port: number;
  path: string;
  authToken?: string;
  sessionTtlMs: number;
}

export function loadHttpConfig(): HttpConfig {
  const transport = (process.env.MCP_TRANSPORT?.trim() || "stdio").toLowerCase();
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid MCP_TRANSPORT '${transport}'. Use 'stdio' or 'http'.`);
  }
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  return {
    transport,
    host: process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1",
    port: intEnv("MCP_HTTP_PORT", 3000),
    path: process.env.MCP_HTTP_PATH?.trim() || "/mcp",
    authToken: token && token.length > 0 ? token : undefined,
    sessionTtlMs: intEnv("MCP_SESSION_TTL_MS", 1_800_000),
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

/** Returns an error message if the bind target is unsafe (non-loopback without a token), else undefined. */
export function httpSecurityError(host: string, authToken?: string): string | undefined {
  if (!authToken && !isLoopbackHost(host)) {
    return `Refusing to bind ${host} without MCP_AUTH_TOKEN. Set a token or bind 127.0.0.1.`;
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node test/http-config.test.mjs`
Expected: PASS — all checks pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/http-config.test.mjs
git commit -m "feat: add HTTP transport config parsing + bind security guardrail"
```

---

### Task 2: Shared ConsoleAuth seam in NakamaClient

**Files:**
- Modify: `src/nakama.ts` (`NakamaClient` constructor, `ensureConsole`, `authFor`)
- Test: `test/console-auth.test.mjs` (create)

**Interfaces:**
- Produces:
  - `export interface ConsoleAuth { token?: TokenState; inFlight?: Promise<void>; }`
  - `new NakamaClient(cfg)` → own private holder (stdio, unchanged behavior).
  - `new NakamaClient(cfg, sharedConsoleAuth)` → uses the shared holder; concurrent/sequential clients share one admin login.
- Consumes: existing private `TokenState` interface, `decodeJwtExpMs`, `request()` in `src/nakama.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/console-auth.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node test/console-auth.test.mjs`
Expected: FAIL — current `NakamaClient` ignores a second constructor arg, so each client logs in on its own (`authCalls === 2` after the concurrent step), failing the first assertion.

- [ ] **Step 3: Implement the ConsoleAuth seam**

In `src/nakama.ts`, add the interface near `TokenState` (after the `TokenState` interface):

```ts
export interface ConsoleAuth {
  token?: TokenState;
  inFlight?: Promise<void>;
}
```

Replace the class fields and constructor:

```ts
export class NakamaClient {
  private session?: TokenState; // player session (client API)
  private consoleAuth: ConsoleAuth; // console admin token holder (shareable)

  constructor(private cfg: NakamaConfig, consoleAuth?: ConsoleAuth) {
    this.consoleAuth = consoleAuth ?? {};
  }
```

In `authFor`, replace the console branch tail:

```ts
    // console
    if (path === "/v2/console/authenticate") return undefined;
    await this.ensureConsole();
    return `Bearer ${this.consoleAuth.token!.token}`;
```

Replace `ensureConsole` entirely:

```ts
  private async ensureConsole(): Promise<void> {
    const a = this.consoleAuth;
    const valid = a.token && (!a.token.expiresAt || a.token.expiresAt > Date.now() + 5000);
    if (valid) return;
    if (a.inFlight) return a.inFlight;
    a.inFlight = (async () => {
      const data = await this.request<{ token: string; refresh_token?: string }>({
        surface: "console",
        method: "POST",
        path: "/v2/console/authenticate",
        body: { username: this.cfg.consoleUsername, password: this.cfg.consolePassword },
        authOverride: null,
      });
      if (!data?.token) throw new Error("Console login did not return a token. Check NAKAMA_CONSOLE_USERNAME / NAKAMA_CONSOLE_PASSWORD.");
      a.token = { token: data.token, refreshToken: data.refresh_token, expiresAt: decodeJwtExpMs(data.token) };
    })();
    try {
      await a.inFlight;
    } finally {
      a.inFlight = undefined;
    }
  }
```

- [ ] **Step 4: Run the new test + the full suite to verify nothing regressed**

Run: `npm run build && node test/console-auth.test.mjs && npm test`
Expected: console-auth test PASS; `npm test` (resolve + redact + smoke) all PASS — stdio behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/nakama.ts test/console-auth.test.mjs
git commit -m "feat: inject shareable ConsoleAuth holder with in-flight login guard"
```

---

### Task 3: Server factory; stdio path uses it

**Files:**
- Create: `src/server.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `export function buildMcpServer(cfg: NakamaConfig, consoleAuth?: ConsoleAuth): McpServer`
- Consumes: `ConsoleAuth` (Task 2), `registerTools` (`src/tools.ts`), `NakamaConfig` (`src/config.ts`).

- [ ] **Step 1: Create the factory**

Create `src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NakamaConfig } from "./config.js";
import { NakamaClient, type ConsoleAuth } from "./nakama.js";
import { registerTools } from "./tools.js";

/** Build a fully-wired MCP server bound to a (per-session) NakamaClient. */
export function buildMcpServer(cfg: NakamaConfig, consoleAuth?: ConsoleAuth): McpServer {
  const nakama = new NakamaClient(cfg, consoleAuth);
  const server = new McpServer({ name: "nakama-mcp", version: "0.1.0" });
  registerTools(server, nakama);
  return server;
}
```

- [ ] **Step 2: Rewrite the stdio path in `src/index.ts` to use the factory**

Replace the body of `src/index.ts` above `main().catch(...)` with:

```ts
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
```

(The `McpServer`, `NakamaClient`, and `registerTools` imports move out of `index.ts` into `server.ts`. The HTTP branch is added in Task 4.)

- [ ] **Step 3: Run the smoke suite to verify the stdio path still works**

Run: `npm run build && npm test`
Expected: PASS — `smoke.mjs` still sees 14 tools and a working `initialize`/`tools/list`/`search_actions`, proving the factory produces an identical stdio server.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/index.ts
git commit -m "refactor: extract buildMcpServer factory; stdio path uses it"
```

---

### Task 4: HTTP server skeleton — routing, bearer auth, healthz

**Files:**
- Create: `src/http.ts`
- Modify: `src/index.ts` (add the http branch + register `authToken` secret)
- Modify: `package.json` (add `test:http`, wire into `test`)
- Test: `test/http.test.mjs` (create — auth + healthz checks)

**Interfaces:**
- Produces: `export async function startHttpServer(cfg: NakamaConfig, http: HttpConfig): Promise<void>` — binds the server, prints a `nakama-mcp ready -> http://<host>:<port><path> ...` line to stderr (with the **actual** bound port), throws if `httpSecurityError` is non-empty.
- Consumes: `loadHttpConfig`, `HttpConfig`, `httpSecurityError` (Task 1); `buildMcpServer` (Task 3); `ConsoleAuth` (Task 2).

- [ ] **Step 1: Write the failing test (auth + healthz only)**

Create `test/http.test.mjs`:

```js
#!/usr/bin/env node
// HTTP transport smoke test (no Nakama required). Spawns the built server in
// http mode on an ephemeral port and checks auth + healthz.
// Session/handshake checks are added in a later task.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const TOKEN = "test-token-123456";

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
} catch (err) {
  console.log(`\nFATAL: ${err.message}`);
} finally {
  child.kill();
}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node test/http.test.mjs`
Expected: FAIL — the server has no http branch yet (it starts in stdio mode and never prints an `http://` ready line), so `startServer()` times out.

- [ ] **Step 3: Create `src/http.ts` (skeleton: routing, auth, healthz, security throw)**

Create `src/http.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { httpSecurityError, type HttpConfig } from "./config.js";
import type { NakamaConfig } from "./config.js";
import type { ConsoleAuth } from "./nakama.js";
import { buildMcpServer } from "./server.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw); // SyntaxError handled by caller
}

export async function startHttpServer(cfg: NakamaConfig, http: HttpConfig): Promise<void> {
  const secErr = httpSecurityError(http.host, http.authToken);
  if (secErr) throw new Error(secErr);

  const sharedConsoleAuth: ConsoleAuth = {};
  const sessions = new Map<string, Session>();

  const authOk = (req: IncomingMessage): boolean => {
    if (!http.authToken) return true;
    return req.headers["authorization"] === `Bearer ${http.authToken}`;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname !== http.path) {
        return rpcError(res, 404, "Not found");
      }
      if (!authOk(req)) {
        return rpcError(res, 401, "Unauthorized");
      }

      // Session routing is added in the next task.
      return rpcError(res, 501, "Not implemented");
    } catch (err) {
      process.stderr.write(`nakama-mcp http error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) rpcError(res, 500, "Internal server error");
    }
  });

  const shutdown = () => {
    for (const s of sessions.values()) void s.transport.close();
    server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve) => server.listen(http.port, http.host, resolve));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : http.port;
  process.stderr.write(
    `nakama-mcp ready -> http://${http.host}:${boundPort}${http.path} (transport=http, auth=${http.authToken ? "on" : "off"})\n`,
  );
  if (!http.authToken) {
    process.stderr.write("nakama-mcp warning: MCP_AUTH_TOKEN is not set; endpoint is unauthenticated (loopback only).\n");
  }

  // Silence unused-variable lint until session routing lands in the next task.
  void buildMcpServer;
  void randomUUID;
  void isInitializeRequest;
  void sharedConsoleAuth;
}
```

> Note: the `void buildMcpServer; void randomUUID; void isInitializeRequest; void sharedConsoleAuth;` lines exist only so this skeleton type-checks under `strict` with unused imports; Task 5 removes them when those symbols are actually used.

- [ ] **Step 4: Add the http branch + secret registration in `src/index.ts`**

Update `src/index.ts` imports and `main()`:

```ts
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
```

(`main().catch(...)` at the bottom of the file is unchanged.)

- [ ] **Step 5: Wire `test:http` into `package.json`**

In `package.json` `scripts`, add `test:http` and include it in `test`:

```json
    "test:http": "node test/http.test.mjs",
    "test": "npm run test:resolve && npm run test:redact && npm run test:smoke && npm run test:http",
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run build && node test/http.test.mjs`
Expected: PASS — `/healthz` → 200, missing/wrong bearer → 401. (The `/mcp` initialize path still returns 501; that is exercised in Task 5.)

- [ ] **Step 7: Commit**

```bash
git add src/http.ts src/index.ts package.json test/http.test.mjs
git commit -m "feat: HTTP server skeleton with bearer auth, /healthz, transport branch"
```

---

### Task 5: Per-session transport handling (initialize, routing, isolation)

**Files:**
- Modify: `src/http.ts` (replace the `501 Not implemented` block with real session handling; remove the `void ...` placeholder lines)
- Test: `test/http.test.mjs` (extend with handshake + tools/list + isolation checks)

**Interfaces:**
- Consumes: `StreamableHTTPServerTransport`, `isInitializeRequest`, `randomUUID`, `buildMcpServer`, the `sessions` map and `sharedConsoleAuth` from Task 4.
- Produces: a working stateful `/mcp` endpoint — `initialize` mints a session (own `NakamaClient`, shared console auth), known `Mcp-Session-Id` routes to its transport, unknown/missing session is rejected.

- [ ] **Step 1: Extend the test with handshake + isolation checks**

In `test/http.test.mjs`, add these imports at the top (after the existing imports):

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

Add a helper above the `try` block:

```js
async function connectClient() {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(transport);
  return { client, transport };
}
```

Inside the existing `try` block, after the `wrongAuth` check, add:

```js
  const EXPECTED_TOOLS = 14;
  const a = await connectClient();
  const list = await a.client.listTools();
  ok(list.tools.length === EXPECTED_TOOLS, `tools/list returns ${EXPECTED_TOOLS} (got ${list.tools.length})`);
  ok(typeof a.transport.sessionId === "string" && a.transport.sessionId.length > 0, "session A has an id");

  const b = await connectClient();
  ok(typeof b.transport.sessionId === "string" && b.transport.sessionId.length > 0, "session B has an id");
  ok(a.transport.sessionId !== b.transport.sessionId, "two clients get distinct session ids");

  await a.client.close();
  await b.client.close();
```

- [ ] **Step 2: Run the test to verify the new checks fail**

Run: `npm run build && node test/http.test.mjs`
Expected: the auth/healthz checks still PASS, but `connectClient()` FAILS (the endpoint returns 501), so the tools/isolation checks fail.

- [ ] **Step 3: Implement session handling in `src/http.ts`**

Remove the four `void ...;` placeholder lines at the end of `startHttpServer`. Then replace the placeholder block:

```ts
      // Session routing is added in the next task.
      return rpcError(res, 501, "Not implemented");
```

with:

```ts
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Existing session: route to its transport.
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) return rpcError(res, 404, "Unknown session id");
        existing.lastActivity = Date.now();
        let body: unknown;
        if (req.method === "POST") {
          try {
            body = await readBody(req);
          } catch {
            return rpcError(res, 400, "Invalid JSON body");
          }
        }
        return existing.transport.handleRequest(req, res, body);
      }

      // No session id: only a POST initialize may create one.
      if (req.method !== "POST") {
        return rpcError(res, 400, "No valid session; send initialize first");
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        return rpcError(res, 400, "Invalid JSON body");
      }
      if (!isInitializeRequest(body)) {
        return rpcError(res, 400, "No valid session; send initialize first");
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, lastActivity: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const mcp = buildMcpServer(cfg, sharedConsoleAuth);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node test/http.test.mjs`
Expected: PASS — auth/healthz pass; the SDK client completes the handshake, `tools/list` returns 14, and two clients receive distinct session ids.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: resolve + redact + smoke + http all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http.ts test/http.test.mjs
git commit -m "feat: stateful per-session HTTP transport with isolated NakamaClient"
```

---

### Task 6: Idle-session reaper

**Files:**
- Modify: `src/http.ts` (add `reapIdleSessions` export + interval wiring)
- Test: `test/http-reaper.test.mjs` (create)

**Interfaces:**
- Produces: `export function reapIdleSessions(sessions: Map<string, { transport: { close(): unknown }; lastActivity: number }>, ttlMs: number, now?: number): string[]` — closes and removes sessions idle longer than `ttlMs`; returns the reaped session ids.

- [ ] **Step 1: Write the failing test**

Create `test/http-reaper.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node test/http-reaper.test.mjs`
Expected: FAIL — `reapIdleSessions is not a function` (not yet exported).

- [ ] **Step 3: Implement the reaper + wire the interval**

In `src/http.ts`, add the exported function (place it above `startHttpServer`, after the `readBody` helper):

```ts
/** Close and remove sessions idle longer than ttlMs. Returns reaped session ids. */
export function reapIdleSessions(
  sessions: Map<string, { transport: { close(): unknown }; lastActivity: number }>,
  ttlMs: number,
  now: number = Date.now(),
): string[] {
  const reaped: string[] = [];
  for (const [sid, s] of sessions) {
    if (now - s.lastActivity > ttlMs) {
      sessions.delete(sid);
      void s.transport.close();
      reaped.push(sid);
    }
  }
  return reaped;
}
```

In `startHttpServer`, after the `sessions` map is created and before `const server = createServer(...)`, add the sweep timer:

```ts
  const sweep = setInterval(
    () => reapIdleSessions(sessions, http.sessionTtlMs),
    Math.max(1000, Math.floor(http.sessionTtlMs / 4)),
  );
  sweep.unref();
```

Update `shutdown` to clear the interval:

```ts
  const shutdown = () => {
    clearInterval(sweep);
    for (const s of sessions.values()) void s.transport.close();
    server.close();
  };
```

- [ ] **Step 4: Run the reaper test + full suite**

Run: `npm run build && node test/http-reaper.test.mjs && npm test`
Expected: reaper test PASS; full suite (resolve + redact + smoke + http) PASS.

- [ ] **Step 5: Add `test:http-reaper` to `package.json` and the `test` script**

In `package.json` `scripts`:

```json
    "test:http-reaper": "node test/http-reaper.test.mjs",
    "test": "npm run test:resolve && npm run test:redact && npm run test:smoke && npm run test:http && npm run test:http-reaper",
```

- [ ] **Step 6: Commit**

```bash
git add src/http.ts test/http-reaper.test.mjs package.json
git commit -m "feat: idle-session reaper for the HTTP transport"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (new "Remote HTTP transport" section)
- Modify: `.env.example` (add `MCP_*` vars)
- Modify: `CHANGELOG.md` (note the feature)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the `.env.example` entries**

Append to `.env.example`:

```bash
# --- Remote HTTP transport (optional; default transport is stdio) ---
# MCP_TRANSPORT=http
# MCP_HTTP_HOST=127.0.0.1
# MCP_HTTP_PORT=3000
# MCP_HTTP_PATH=/mcp
# MCP_AUTH_TOKEN=change-me-required-for-non-loopback-binds
# MCP_SESSION_TTL_MS=1800000
```

- [ ] **Step 2: Add the README section**

Insert into `README.md`, after the "Add to an MCP host" section and before "How auth works":

````markdown
## Remote HTTP transport

By default the server speaks **stdio**. Set `MCP_TRANSPORT=http` to run it as a
network-reachable streamable-HTTP server that multiple MCP clients can share. It still
targets the single Nakama configured by your `NAKAMA_*` vars; each connected MCP client
gets its own isolated player session, and the console admin login is shared.

| Variable | Default | Notes |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Set to `http` to enable the HTTP server. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Loopback by default. |
| `MCP_HTTP_PORT` | `3000` | Listen port. |
| `MCP_HTTP_PATH` | `/mcp` | MCP endpoint path. |
| `MCP_AUTH_TOKEN` | _(unset)_ | Static bearer token required in `Authorization: Bearer …`. |
| `MCP_SESSION_TTL_MS` | `1800000` | Idle session timeout (30 min). |

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=s3cret npm start
# nakama-mcp ready -> http://127.0.0.1:3000/mcp (transport=http, auth=on)
curl -s http://127.0.0.1:3000/healthz   # -> {"ok":true}
```

**Security:** if you bind a non-loopback address (e.g. `MCP_HTTP_HOST=0.0.0.0`) the server
**refuses to start** unless `MCP_AUTH_TOKEN` is set, so Nakama admin is never accidentally
exposed. The endpoint is plain HTTP — terminate TLS at a reverse proxy for public hosting.
`GET /healthz` is unauthenticated for load balancers; all `/mcp` traffic requires the token.
````

- [ ] **Step 3: Add the CHANGELOG entry**

Add under the top/unreleased section of `CHANGELOG.md`:

```markdown
### Added
- Remote streamable-HTTP transport (`MCP_TRANSPORT=http`): stateful, multi-client, with
  per-session isolated player sessions, shared console admin login, a static bearer token
  (`MCP_AUTH_TOKEN`), a non-loopback bind guardrail, `GET /healthz`, and an idle-session reaper.
```

- [ ] **Step 4: Verify docs build/no broken suite**

Run: `npm run build && npm test`
Expected: PASS (docs-only change; suite stays green).

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example CHANGELOG.md
git commit -m "docs: document the remote HTTP transport"
```

---

## Self-Review

**1. Spec coverage:**
- One fixed Nakama, env-config → unchanged `loadConfig`; HTTP uses same `cfg` (Tasks 3–5). ✓
- Multiple clients, isolated player sessions → per-session `NakamaClient` via `buildMcpServer(cfg, sharedConsoleAuth)` (Task 5). ✓
- Shared console token → `ConsoleAuth` holder + in-flight guard (Task 2). ✓
- Static bearer token → `authOk` 401 gate (Task 4). ✓
- Transport selection, stdio default → `MCP_TRANSPORT` branch (Tasks 1, 4). ✓
- Bare `node:http` + SDK transport, no new deps → Task 4/5; Global Constraints enforce two-deps. ✓
- HTTP surface (POST/GET/DELETE `/mcp`, `/healthz`) → Task 4 (healthz/auth) + Task 5 (POST/GET/DELETE via `handleRequest`). ✓
- Session lifecycle (mint/route/reject) → Task 5. ✓
- Security fail-safe (refuse non-loopback w/o token) → `httpSecurityError` (Task 1) thrown in `startHttpServer` (Task 4). ✓
- `MCP_AUTH_TOKEN` redacted → `registerSecrets([..., http.authToken])` (Task 4). ✓
- Error handling (JSON-RPC errors, 500, clean shutdown) → Task 4/5 (`rpcError`, try/catch, SIGINT/SIGTERM). ✓
- Idle reaping → Task 6. ✓
- Testing (401, healthz, handshake, 14 tools, isolation, reaper) → Tasks 4–6. ✓
- Docs (README, .env.example, CHANGELOG; manifest unchanged) → Task 7. ✓
- Out of scope (multi-tenant, OAuth, TLS, http integration) → not implemented. ✓

**2. Placeholder scan:** No TBD/TODO. The only intentional "stub" is Task 4's `501 Not implemented` block and `void ...` lines, both explicitly removed in Task 5 with full replacement code shown. Every code step contains complete code.

**3. Type consistency:** `HttpConfig` fields (Task 1) match usage in `startHttpServer` (Tasks 4–6). `buildMcpServer(cfg, consoleAuth?)` signature identical in Tasks 3, 4, 5. `ConsoleAuth` shape (`token?`, `inFlight?`) consistent in Tasks 2 and used as `{}` in Task 4/5. `reapIdleSessions(sessions, ttlMs, now?)` signature matches the Task 6 test's call. `httpSecurityError(host, authToken?)` matches Task 1 test and Task 4 call. The `Session` interface (`transport`, `lastActivity`) is structurally compatible with the reaper's looser parameter type.
