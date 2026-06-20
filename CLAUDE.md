# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local **stdio MCP server** that exposes a running [Heroic Labs Nakama](https://github.com/heroiclabs/nakama) instance to MCP hosts. It wraps Nakama's two HTTP APIs:

- **Client API** (`:7350`) — player-facing (auth, accounts, storage, leaderboards, RPCs).
- **Console API** (`:7351`) — admin/ops (search players, storage, status, ban).

Nakama exposes ~180 operations, so rather than one tool per endpoint the server uses a **search + execute** design over a generated catalog, plus ~12 promoted convenience tools for the most common jobs. Source is TypeScript (ESM, strict); there is no runtime framework beyond the MCP SDK and `zod`.

## Commands

```bash
npm run build              # tsc -> dist/
npm run dev                # tsc --watch
npm test                   # fast suite, no server: resolve + redact + smoke
npm run test:integration   # live suite: needs `docker compose up -d --wait` first
npm run regen-catalog          # rebuild data/catalog.json from Nakama master (needs network)
npm run regen-catalog -- v3.37.0   # ...from a specific git ref/tag
npm run mcpb               # build + pack the MCPB desktop bundle -> dist-mcpb/nakama-mcp.mcpb
```

Run a single test directly (each is a standalone Node script, not a framework):

```bash
node test/resolve.test.mjs     # also: npm run test:resolve
node test/redact.test.mjs      # also: npm run test:redact
node test/smoke.mjs            # also: npm run test:smoke
node test/integration.mjs     # also: npm run test:integration (live server)
```

There is **no linter**; `tsc` (strict mode) is the type gate. Always `npm run build` before running tests, since tests load `dist/`.

## Architecture

Request flow: `nakama_search_actions` (find an `action_id`) → `nakama_execute_action` (run it). Everything funnels through one `NakamaClient.request()`.

- **`src/index.ts`** — entry point. Loads config, registers secrets for redaction, constructs `NakamaClient`, registers tools, connects `StdioServerTransport`. **stdout is reserved for the MCP protocol — all logging goes to stderr.**
- **`src/catalog.ts`** — loads `data/catalog.json` into `actions[]`, indexed by lowercased id. `searchActions()` is a simple term-scoring search (id match weighted highest); `compact()` trims results to keep token use lean.
- **`src/tools.ts`** — registers all 14 MCP tools with their zod input schemas. The two generic tools (`search_actions`, `execute_action`) plus `authenticate`/`call_rpc`, four promoted console reads, and the promoted writes (storage, leaderboard, notification, ban/unban) + healthcheck. `ok()`/`fail()` wrap results; `fail()` always runs output through `redact()`.
- **`src/nakama.ts`** — the HTTP client. `request()` does path-param substitution, query building, auth header derivation, fetch with timeout, and JSON/`NakamaError` handling. `requestPaginated()` follows `cursor`/`next_cursor` and merges array fields (adds `__pages_fetched`/`__more_available`). Holds in-memory session state.
- **`src/config.ts`** — reads `NAKAMA_*` env vars into `NakamaConfig` with dev-friendly defaults.
- **`src/redact.ts`** — registry-based secret scrubbing (server key, console password, JWTs, `Basic`/`Bearer` headers). Applied to **all** error/diagnostic text before it reaches the model.

### Auth model (handled automatically inside `NakamaClient`)

`authFor(surface, path)` decides the `Authorization` header per request:

- **Console API**: lazy auto-login via `ensureConsole()` using `NAKAMA_CONSOLE_USERNAME`/`PASSWORD`; JWT is cached and refreshed 5s before expiry (`decodeJwtExpMs`). No login tool is exposed.
- **Client authenticate endpoints** (`/v2/account/authenticate/*`, session refresh): HTTP Basic with the server key.
- **Other client endpoints**: require a **player session** — `nakama_authenticate` stores the token in memory (`this.session`); calling them first throws a clear "call nakama_authenticate first" error.
- **RPCs** (`callRpc`): the REST gateway binds the body to the RPC `payload` **string**, so the payload is JSON-encoded into a quoted string. Pass `http_key` to skip the player session (`authOverride: null`).

### The catalog (`data/catalog.json`)

Generated, **committed**, and shipped (listed in `package.json` `files`). `scripts/regen-catalog.mjs` fetches Nakama's upstream Swagger 2.0 specs and runs `scripts/lib/resolve.mjs` (`buildActions`), which **inlines request-body `$ref`s into flat `bodySchema` field lists** so `search_actions` can show Claude exact POST/PUT body fields. The resolver is the one piece with real logic and is unit-tested by `test/resolve.test.mjs`. Don't hand-edit `catalog.json`; regenerate it.

## Conventions & gotchas

- **ESM with NodeNext**: relative imports must use the `.js` extension even though sources are `.ts` (e.g. `import { loadConfig } from "./config.js"`).
- **Never write to stdout** outside the MCP transport — it corrupts the protocol stream. Use `process.stderr`.
- **All model-visible error text must go through `redact()`** — `fail()` and `healthcheck()` already do; preserve that if you add output paths.
- New convenience tools follow the existing pattern in `tools.ts`: zod `inputSchema`, accurate `annotations` (`readOnlyHint`/`destructiveHint`), `try/catch` → `ok()`/`fail()`, and accept object-or-JSON-string for proto struct fields via `asJsonString`/`asJsonObject`.
- The tool layer and client are transport-agnostic; moving to remote streamable-HTTP is mostly swapping `StdioServerTransport` in `index.ts`.

## Testing notes

Two tiers, both gating CI (`.github/workflows/ci.yml`):

- **smoke** (`resolve` + `redact` + `smoke`) — pure unit + MCP protocol surface, no Nakama. Fast; run on every change.
- **integration** — boots Nakama 3.37.0 + CockroachDB via `docker-compose.yml` (`docker compose up --wait`), then drives the built server over stdio end-to-end (tools/list, console login + status, list/get account, device auth, storage write/read). Honors the same `NAKAMA_*` env vars; defaults match the bundled compose. `VERBOSE=1` surfaces server logs.

Run `npm run build && npm test` before any PR; run integration too if you touch the client, tools, or catalog.
