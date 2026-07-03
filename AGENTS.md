# AGENTS.md

Workspace guide for ZCode agents working in `nakama-mcp`. For deeper detail, read [`CLAUDE.md`](CLAUDE.md) — it is the authoritative architecture reference.

## What this is

An MCP (Model Context Protocol) server that exposes a running [Heroic Labs Nakama](https://github.com/heroiclabs/nakama) instance to MCP hosts. TypeScript, ESM, strict mode. No runtime framework beyond `@modelcontextprotocol/sdk` + `zod`; HTTP transport uses bare `node:http`. Wraps Nakama's two HTTP APIs:

- **Client API** (`:7350`) — player-facing (auth, accounts, storage, leaderboards, RPCs).
- **Console API** (`:7351`) — admin/ops (search players, storage, status, ban).

Speaks **stdio by default**, or streamable-HTTP when `MCP_TRANSPORT=http`. Nakama exposes ~180 operations, so the server uses a **search + execute** design (`nakama_search_actions` → `nakama_execute_action`) over a generated catalog, plus ~12 promoted convenience tools.

## Key directories

- `src/` — TypeScript source (see layer map below).
- `data/catalog.json` — **generated & committed**, shipped in the npm package. Do not hand-edit; run `npm run regen-catalog`.
- `scripts/` — catalog regen (`regen-catalog.mjs`, `lib/resolve.mjs`) and MCPB bundling (`build-mcpb.mjs`).
- `test/` — each test is a **standalone Node script** (no test framework); see commands below.
- `docs/superpowers/` — design/plan notes for past features.

## Commands

```bash
npm install
npm run build              # tsc -> dist/ (strict). ALWAYS build before testing — tests load dist/.
npm run dev                # tsc --watch
npm test                   # fast suite, no server (resolve + redact + smoke + http + http-reaper + version)
npm run test:integration   # needs `docker compose up -d --wait` first (stdio, Nakama 3.37.0 + CockroachDB)
npm run test:http-integration  # same prerequisite; drives the live server over the HTTP transport
npm run regen-catalog      # rebuild data/catalog.json from Nakama upstream (needs network)
npm run regen-catalog -- v3.37.0   # ...from a specific git ref/tag
npm run mcpb               # build + pack desktop bundle -> dist-mcpb/nakama-mcp.mcpb
```

Run one test directly (each is standalone):

```bash
node test/resolve.test.mjs        # catalog body-schema resolver
node test/redact.test.mjs         # secret scrubbing
node test/smoke.mjs               # stdio protocol surface (tools/list, no Nakama)
node test/http.test.mjs           # HTTP transport + auth + sessions
node test/http-config.test.mjs    # config parsing + bind guardrail
node test/console-auth.test.mjs   # shared console-auth holder / in-flight login guard
node test/http-reaper.test.mjs    # idle-session reaper
node test/integration.mjs         # live end-to-end over stdio (needs docker compose up)
node test/http-integration.test.mjs  # live end-to-end over the HTTP transport (needs docker compose up)
```

There is **no linter**; `tsc` strict mode is the type gate. CI (`.github/workflows/ci.yml`) runs the fast suite on every push and the integration suite against dockerized Nakama.

## Architecture & layer rules

Request flow: `nakama_search_actions` (find `action_id`) → `nakama_execute_action` (run it). Everything funnels through one `NakamaClient.request()`.

- `src/index.ts` — entry; loads config, registers redaction secrets, branches on `MCP_TRANSPORT`.
- `src/server.ts` — `buildMcpServer(cfg, consoleAuth?)` factory shared by **both** transports. Add new tools/config here, not in a single transport.
- `src/tools.ts` — registers all 14 MCP tools with zod schemas. `ok()`/`fail()` wrap results; `fail()` always runs output through `redact()`.
- `src/nakama.ts` — HTTP client. `request()` does path-param substitution, auth header, fetch+timeout, error handling. `requestPaginated()` follows cursors. Holds in-memory player session state.
- `src/http.ts` — streamable-HTTP transport. Per-session `NakamaClient` (isolated player session), **shared** `ConsoleAuth`. `reapIdleSessions()` enforces `MCP_SESSION_TTL_MS`.
- `src/catalog.ts` — loads `data/catalog.json`; `searchActions()` is term-scoring (id match weighted highest).
- `src/config.ts` — `loadConfig()` reads `NAKAMA_*`; `loadHttpConfig()` reads `MCP_*`. `httpSecurityError()` enforces the bind guardrail.
- `src/redact.ts` — registry-based scrubbing of server key, console password, JWTs, `Basic`/`Bearer` headers.

Auth is automatic inside `NakamaClient.authFor(surface, path)`: console lazy-auto-logins (JWT cached, refreshed 5s before expiry, in-flight-guarded); client authenticate uses HTTP Basic w/ server key; other client endpoints require a player session from `nakama_authenticate`; RPC payloads are JSON-encoded into a quoted string per Nakama's REST gateway.

## Conventions & gotchas

- **ESM + NodeNext**: relative imports must use the `.js` extension even though sources are `.ts` (e.g. `import { loadConfig } from "./config.js"`).
- **Never write to stdout** outside the MCP transport — it corrupts the protocol stream. Log to `process.stderr`.
- **All model-visible error text goes through `redact()`** — `fail()` and `healthcheck()` already do; preserve this for any new output path.
- **New convenience tools** follow the pattern in `tools.ts`: zod `inputSchema`, accurate `annotations` (`readOnlyHint`/`destructiveHint`), `try/catch` → `ok()`/`fail()`, object-or-JSON-string for proto struct fields via `asJsonString`/`asJsonObject`.
- **HTTP transport isolation**: each session must get its own `NakamaClient` — never hoist player-session state to a shared singleton. The bearer-token check must stay **before** any session lookup/body read. Binding a non-loopback host without `MCP_AUTH_TOKEN` is a hard startup failure by design — do not soften to a warning.
- **Secrets**: `NAKAMA_SERVER_KEY` and `NAKAMA_CONSOLE_PASSWORD` are secrets. Don't paste them into prompts or commit `.env`.

## Read before changing sensitive areas

- Catalog/resolver logic → `scripts/lib/resolve.mjs` + `test/resolve.test.mjs`.
- HTTP transport security → `src/http.ts` + `src/config.ts` (`httpSecurityError`) + `test/http-config.test.mjs`.
- Auth model → `src/nakama.ts` (`authFor`, `ensureConsole`) + `test/console-auth.test.mjs`.
- Full architecture walk-through → [`CLAUDE.md`](CLAUDE.md).
