# Remote HTTP Transport — Design

**Date:** 2026-06-20
**Status:** Approved (design); pending implementation plan
**Author:** brainstormed via superpowers:brainstorming

## Goal

Add a remote, network-reachable **streamable-HTTP** transport to nakama-mcp so the
server can be hosted once and reached by multiple MCP clients, while the existing
**stdio** transport remains the default and is unchanged. This realizes the
"Remote streamable-HTTP" upgrade path already named in the README.

## Background

Today `src/index.ts` hardwires `StdioServerTransport`. A single `NakamaClient`
singleton holds two pieces of state:

- a **player session** token (set by `nakama_authenticate`, client API `:7350`), and
- a cached **console admin** token (auto-login, console API `:7351`).

Over stdio this is correct: one client, one process. Over remote HTTP with multiple
concurrent MCP clients, the player session must be **isolated per client** — otherwise
one caller's `nakama_authenticate` clobbers another's. The console token is the same
admin credentials for everyone, so it can be **shared**.

## Decisions (locked during brainstorming)

1. **Targeting:** one fixed Nakama per deployment, configured by `NAKAMA_*` env vars
   exactly as today. No per-request Nakama targeting / multi-tenancy.
2. **Concurrency:** multiple simultaneous MCP clients, each with an **isolated player
   session**. Requires stateful HTTP (`Mcp-Session-Id`) and a per-session `NakamaClient`.
3. **Endpoint auth:** a **static bearer token** (`MCP_AUTH_TOKEN`). Full OAuth is out of
   scope for this iteration.
4. **Transport selection:** `MCP_TRANSPORT=stdio|http`, **default `stdio`**. Existing
   stdio setups (Claude Desktop configs, the MCPB bundle, the integration test) keep working.
5. **HTTP layer:** bare `node:http` + the SDK's `StreamableHTTPServerTransport`. **No new
   direct dependencies** (Express is present only transitively via the SDK and is not adopted).

## Global Constraints

- **Node** `>= 18` (unchanged engines floor; uses global `fetch`, `node:http`, `node:crypto`).
- **Runtime dependencies stay at exactly two:** `@modelcontextprotocol/sdk` and `zod`.
  Do not add a direct dependency on Express or any HTTP framework.
- **ESM / NodeNext:** relative imports use the `.js` extension from `.ts` sources.
- **stdout is reserved for the MCP stdio protocol** — all logs go to `process.stderr`.
- **All model-visible / error output passes through `redact()`** (existing rule).
- stdio behavior must be **byte-for-byte unchanged** when `MCP_TRANSPORT` is unset or `stdio`.

## Architecture

The tool layer (`src/tools.ts`) and `NakamaClient` request logic do **not** change
behavior. Two small seams enable per-session isolation, plus a new HTTP module and a
transport branch in the entry point.

### Seam 1 — Shared console auth (`src/nakama.ts`)

Extract the cached admin token out of `NakamaClient`'s private field into an injected
holder so all per-session clients share one admin login.

```ts
export interface ConsoleAuth {
  token?: TokenState;        // existing internal shape: { token, refreshToken?, expiresAt? }
  inFlight?: Promise<void>;  // guards concurrent logins
}
```

- `new NakamaClient(cfg)` → creates its own private `ConsoleAuth` (stdio path, behavior
  identical to today).
- `new NakamaClient(cfg, sharedConsoleAuth)` → uses the shared holder (http path).
- `ensureConsole()` reads/writes the holder. If a login is already `inFlight`, await it
  instead of starting a second one; clear `inFlight` in a `finally`.

The player `session` field stays private and per-instance — that is exactly the state we
want isolated per MCP session.

### Seam 2 — Server factory (`src/server.ts`, new)

Extract the inline "build client + server + register tools" wiring from `index.ts` into a
single function reused by both transports.

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NakamaConfig } from "./config.js";
import { NakamaClient, type ConsoleAuth } from "./nakama.js";

export function buildMcpServer(cfg: NakamaConfig, consoleAuth?: ConsoleAuth): McpServer;
```

Internally: `new NakamaClient(cfg, consoleAuth)`, `new McpServer({ name: "nakama-mcp",
version: "0.1.0" })`, `registerTools(server, nakama)`, return the server.

### New — HTTP server (`src/http.ts`)

Owns the `node:http` server, routing, bearer check, the per-session transport map, and
lifecycle/cleanup.

```ts
import type { NakamaConfig } from "./config.js";
import type { HttpConfig } from "./config.js";

export async function startHttpServer(cfg: NakamaConfig, http: HttpConfig): Promise<void>;
```

State: `const transports = new Map<string, StreamableHTTPServerTransport>()` and one
shared `ConsoleAuth` holder injected into every `buildMcpServer(cfg, sharedConsoleAuth)`.

### Entry point (`src/index.ts`, modified)

```ts
const cfg = loadConfig();
const http = loadHttpConfig();
registerSecrets([cfg.serverKey, cfg.consolePassword, http.authToken]);
if (http.transport === "http") {
  await startHttpServer(cfg, http);
} else {
  const server = buildMcpServer(cfg);                 // stdio: own ConsoleAuth
  await server.connect(new StdioServerTransport());
  process.stderr.write(`nakama-mcp ready -> ...\n`);  // existing message preserved
}
```

## HTTP surface & request lifecycle

Endpoints (MCP endpoint path is `MCP_HTTP_PATH`, default `/mcp`):

- `POST {path}` — MCP messages (initialize and all tool calls).
- `GET {path}` — opens the SSE stream for server→client messages.
- `DELETE {path}` — explicit session termination.
- `GET /healthz` — liveness; returns `200 {"ok":true}`; **no auth** (for load balancers).

**Bearer check** runs first on every `{path}` request (not on `/healthz`): if
`MCP_AUTH_TOKEN` is set and `Authorization: Bearer <token>` does not match, respond `401`
and stop.

**Session lifecycle** (`transports` map keyed by `Mcp-Session-Id`):

1. **POST, no `Mcp-Session-Id`, body is an `initialize` request** → mint a session:
   - `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(),
     onsessioninitialized: (sid) => transports.set(sid, transport) })`
   - `transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); }`
   - `const server = buildMcpServer(cfg, sharedConsoleAuth); await server.connect(transport);`
   - read + `JSON.parse` the body, then `await transport.handleRequest(req, res, body)`.
2. **POST/GET/DELETE with a known `Mcp-Session-Id`** → look up the transport and
   `await transport.handleRequest(req, res, body?)`.
3. **Request with a missing/unknown session id that is not an `initialize`** → `400` with a
   JSON-RPC error body ("No valid session; send initialize first").

**Body reading:** bare `node:http` — accumulate the request stream to a string and
`JSON.parse`. Malformed JSON → `400`. Pass the parsed value as the third argument to
`handleRequest`.

**Per-session isolation:** each session's own `NakamaClient` holds its own player session,
so `nakama_authenticate` state never leaks between clients. The shared `ConsoleAuth`
holder means admin login happens once and is reused.

**Idle reaping:** track a last-activity timestamp per session (updated on each
`handleRequest`). A periodic sweep (interval derived from the TTL) closes and removes
sessions idle longer than `MCP_SESSION_TTL_MS` (default 30 min), so abandoned clients do
not leak memory. The sweep timer is `unref()`-ed so it never keeps the process alive.

## Configuration

New `MCP_*` env vars, parsed by a new `loadHttpConfig(): HttpConfig` in `src/config.ts`.
`NAKAMA_*` vars and the existing `loadConfig()` are unchanged.

```ts
export interface HttpConfig {
  transport: "stdio" | "http";
  host: string;
  port: number;
  path: string;
  authToken?: string;
  sessionTtlMs: number;
}
```

| Variable | Default | Notes |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` \| `http`. Unknown value → error at startup. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Loopback by default. |
| `MCP_HTTP_PORT` | `3000` | Listen port (http mode). |
| `MCP_HTTP_PATH` | `/mcp` | MCP endpoint path. |
| `MCP_AUTH_TOKEN` | _(unset)_ | Static bearer token; registered as a redaction secret. |
| `MCP_SESSION_TTL_MS` | `1800000` | Idle-session reap threshold (30 min). |

### Security defaults (fail safe)

- If `MCP_HTTP_HOST` is **non-loopback** and `MCP_AUTH_TOKEN` is **unset** → **refuse to
  start** with: `Refusing to bind <host> without MCP_AUTH_TOKEN. Set a token or bind
  127.0.0.1.` Prevents accidentally exposing Nakama admin to the open internet.
- Loopback bind with no token → start, but write a stderr warning.
- `MCP_AUTH_TOKEN` is passed to `registerSecrets(...)` so it is scrubbed from error output.

"Loopback" = `127.0.0.0/8`, `::1`, or `localhost`.

## Error handling

- Tool-level errors are unchanged: they flow through `ok()` / `fail()` and `redact()`
  inside `src/tools.ts`.
- HTTP-level failures (bad JSON, unknown session, failed auth) return JSON-RPC-shaped
  error bodies — never a stack trace.
- A top-level `try/catch` around request handling returns `500` with a generic message;
  details go only to stderr (through `redact()` where they may contain secrets).
- `SIGINT` / `SIGTERM` → close all transports and the HTTP server for clean shutdown.

## Testing

New `test/http.test.mjs`, added to the **fast** `npm test` tier (no Nakama required —
`tools/list` does not call Nakama, matching the existing stdio `smoke.mjs`).

1. Start the server in http mode on an **ephemeral port** with a known `MCP_AUTH_TOKEN`.
2. **Auth:** raw `fetch` to `{path}` with no/wrong bearer → `401`; `GET /healthz` → `200`.
3. **Handshake + tools:** drive it with the SDK's `StreamableHTTPClientTransport` + `Client`,
   call `tools/list`, assert all **14** tools are present.
4. **Session isolation:** two independent `initialize` handshakes return two **distinct**
   `Mcp-Session-Id` values.
5. Shut the server down cleanly at the end (no hanging handles → CI-friendly).

`package.json`: add `test:http` and include it in the `test` script. `test/integration.mjs`
remains stdio-only and unchanged; CI's two-tier structure is preserved.

## Documentation

- `README.md` — new "Remote HTTP transport" section: env vars, security guardrail, an
  example host config, and a curl/`/healthz` sanity check.
- `.env.example` — add the `MCP_*` vars (commented).
- `CHANGELOG.md` — note the added HTTP transport.
- `manifest.json` (MCPB) is **not** changed — the bundle remains a local stdio server.

## Out of scope (YAGNI)

- Per-request / multi-tenant Nakama targeting.
- Full OAuth 2.0 authorization-server flow.
- TLS termination (expected to be handled by a reverse proxy / platform).
- Running the live integration suite over HTTP (stays stdio).

## File summary

| File | Change |
|---|---|
| `src/server.ts` | **new** — `buildMcpServer()` factory |
| `src/http.ts` | **new** — `node:http` server, routing, bearer, session map, reaper |
| `src/config.ts` | modify — add `HttpConfig` + `loadHttpConfig()` |
| `src/nakama.ts` | modify — `ConsoleAuth` holder injection + in-flight login guard |
| `src/index.ts` | modify — transport branch; register `authToken` secret |
| `test/http.test.mjs` | **new** — HTTP smoke test |
| `package.json` | modify — `test:http` wired into `test` |
| `README.md`, `.env.example`, `CHANGELOG.md` | modify — document the transport |
