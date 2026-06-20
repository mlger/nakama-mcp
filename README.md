# nakama-mcp

[![CI](https://github.com/mlger/nakama-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mlger/nakama-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

An MCP (Model Context Protocol) server for [Heroic Labs Nakama](https://github.com/heroiclabs/nakama).
It lets Claude (or any MCP host) talk to a running Nakama instance across **both** of its HTTP APIs:

- **Client API** (`:7350`) — player-facing: authentication, accounts, friends, groups, storage, leaderboards, tournaments, RPCs, …
- **Console API** (`:7351`) — admin/operations: search players, inspect & edit storage, leaderboards, active matches, server status & metrics, …

Nakama exposes ~180 operations across the two surfaces, so this server uses a **search + execute** design instead of one tool per endpoint, plus a handful of promoted convenience tools for the most common jobs.

## Tools

| Tool | Read/Write | What it does |
|---|---|---|
| `nakama_search_actions` | read | Find operations by intent → returns action IDs, method/path, params. |
| `nakama_execute_action` | write | Run any operation by `action_id` with `path_params` / `query_params` / `body`. |
| `nakama_authenticate` | write | Establish a player session (device / custom / email) for client-API calls. |
| `nakama_call_rpc` | write | Call a registered runtime RPC (payload encoded the way the gateway expects). |
| `nakama_console_list_accounts` | read | List / search player accounts. |
| `nakama_console_get_account` | read | Fetch one player account by user ID. |
| `nakama_console_list_storage` | read | List storage objects (filter by collection / key / owner). |
| `nakama_console_get_status` | read | Node status and lightweight service metrics. |
| `nakama_healthcheck` | read | Probe client + console reachability and admin login. |
| `nakama_write_storage_object` | write | Write/update a storage object as the authenticated player. |
| `nakama_write_leaderboard_record` | write | Submit a score to a leaderboard as the authenticated player. |
| `nakama_send_notification` | write | Send an in-app notification to a player (console). |
| `nakama_ban_account` | write | Ban a player account by user ID (console). |
| `nakama_unban_account` | write | Remove a ban from a player account (console). |

### Reliability features

- **Auto-pagination** — `nakama_execute_action`, `nakama_console_list_accounts`, and `nakama_console_list_storage` accept `auto_paginate: true` (+ optional `max_pages`, default 5) to follow `cursor`/`next_cursor` and merge pages, adding `__pages_fetched` / `__more_available` to the result.
- **Secret redaction** — error output is scrubbed of the configured server key / console password, JWTs, and `Basic`/`Bearer` header values before it reaches the model.
- **Healthcheck** — `nakama_healthcheck` probes both surfaces (and verifies admin login); use it first when calls fail.

Typical flow: ask `nakama_search_actions` for what you want → take the `action_id` → call `nakama_execute_action`. The promoted tools are shortcuts for frequent reads.

## Install & build

```bash
npm install
npm run build
```

## Configuration

All configuration is via environment variables. Defaults match a stock local Nakama dev setup.

| Variable | Default | Notes |
|---|---|---|
| `NAKAMA_HOST` | `127.0.0.1` | Host for both APIs. |
| `NAKAMA_PORT` | `7350` | Client API port. |
| `NAKAMA_CONSOLE_PORT` | `7351` | Console API port. |
| `NAKAMA_USE_SSL` | `false` | Use `https` instead of `http`. |
| `NAKAMA_SERVER_KEY` | `defaultkey` | Server key for client authenticate endpoints. |
| `NAKAMA_CONSOLE_USERNAME` | `admin` | Console admin user. |
| `NAKAMA_CONSOLE_PASSWORD` | `password` | Console admin password. |
| `NAKAMA_TIMEOUT_MS` | `15000` | Per-request timeout. |

See `.env.example`. These are **secrets** — prefer your MCP host's env config over committing them.

## Add to an MCP host

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "nakama": {
      "command": "node",
      "args": ["/absolute/path/to/nakama-mcp/dist/index.js"],
      "env": {
        "NAKAMA_HOST": "127.0.0.1",
        "NAKAMA_SERVER_KEY": "defaultkey",
        "NAKAMA_CONSOLE_USERNAME": "admin",
        "NAKAMA_CONSOLE_PASSWORD": "password"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add nakama -- node /absolute/path/to/nakama-mcp/dist/index.js
```

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

## How auth works

- **Console API**: the server auto-logs-in with `NAKAMA_CONSOLE_USERNAME` / `NAKAMA_CONSOLE_PASSWORD` on first use, caches the JWT, and refreshes when it expires. You don't call a login tool.
- **Client API**: authenticate endpoints use HTTP Basic with `NAKAMA_SERVER_KEY`. Every other client endpoint needs a **player session** — call `nakama_authenticate` first; the session token is held in memory for the rest of the connection.
- **RPCs**: `nakama_call_rpc` JSON-encodes the payload as Nakama's REST gateway expects. Pass `http_key` to call an RPC without a player session.

## Usage examples (what to ask Claude)

- "Search Nakama for how to ban an account, then ban user `<uuid>`."
- "List the 10 most recent players whose username contains `test`."
- "Show me server status and current latency."
- "Authenticate as device `demo-1`, then write a storage object in collection `saves`."
- "Call the `healthcheck` RPC."

## Testing against a real Nakama

A `docker-compose.yml` (Nakama 3.37.0 + CockroachDB) and a live integration test are included.

```bash
docker compose up -d          # start Nakama + DB (wait until healthy)
npm run build
npm run test:integration      # drives the MCP server over stdio against the live server
docker compose down -v        # stop and wipe
```

The test exercises the full path end to end: `tools/list`, console auto-login + status,
list accounts, player device authentication, `GetAccount`, and a storage write/read round-trip.
It prints a PASS/FAIL summary and exits non-zero on any failure, so it is CI-friendly.
Set `VERBOSE=1` to see server logs. It honors the same `NAKAMA_*` env vars as the server
(defaults already match the bundled compose).

## Continuous integration

`.github/workflows/ci.yml` runs on every push and PR:

- **smoke** — `npm ci` → build → `npm run test:resolve` + `npm run test:redact` + `npm run test:smoke` (unit + protocol surface; no Nakama). Fast.
- **integration** — boots Nakama + CockroachDB with `docker compose up --wait`, then runs `npm run test:integration`, dumps server logs on failure, and tears down.

Run the same checks locally:

```bash
npm test                   # resolver + smoke, no server needed
npm run test:integration   # needs `docker compose up -d`
```

## Regenerating the API catalog

The bundled `data/catalog.json` is generated from Nakama's upstream OpenAPI (Swagger 2.0) specs.
`regen-catalog` also **resolves request-body `$ref`s into inline field schemas**, so `nakama_search_actions`
shows Claude the exact fields (name, type, required, description — including nested objects) each POST/PUT body expects.

Run it on your machine (needs network) to refresh and fully enrich the catalog:

```bash
npm run regen-catalog            # uses master
npm run regen-catalog -- v3.37.0 # a specific git ref/tag
```

The resolver is covered by a unit test (`npm run test:resolve`).

## Install as a desktop extension (MCPB)

For zero-prerequisite installs (no Node, no `npm`, no build), package the server as an
[MCPB](https://github.com/anthropics/mcpb) bundle and install the single file.

```bash
npm run mcpb        # builds mcpb-build/ and packs dist-mcpb/nakama-mcp.mcpb
```

`npm run mcpb` runs two steps you can also run separately:

- `npm run mcpb:build` — type-checks, bundles the server with esbuild into `mcpb-build/server/index.mjs`, and stages `manifest.json` + `data/catalog.json`.
- `npm run mcpb:pack` — packs `mcpb-build/` into `dist-mcpb/nakama-mcp.mcpb` (validates the manifest). A plain `cd mcpb-build && zip -r ../dist-mcpb/nakama-mcp.mcpb .` also works.

Then **drag `dist-mcpb/nakama-mcp.mcpb` onto Claude Desktop** to install. The installer prompts for
the connection settings declared in `manifest.json` (host, ports, HTTPS, server key, console
username/password); the server key and console password are stored in the OS keychain.

> MCPB is the right choice when Nakama runs on the user's own machine/localhost. If you target a
> shared or cloud Nakama, a remote HTTP server is the better distribution path (see below).

## Distribution / upgrade path

This is a **local stdio** server — the fastest shape to prototype and run against your own Nakama.
For wider distribution to people who don't have Node set up, the recommended next steps are:

- **MCPB bundle** — package the server with its Node runtime so it installs without prerequisites (best when it still needs to reach a Nakama the user runs locally).
- **Remote streamable-HTTP** — host it once behind a URL (best if it targets a shared/cloud Nakama); add OAuth there if needed.

The tool layer and Nakama client are transport-agnostic, so moving to either is mostly swapping `StdioServerTransport` in `src/index.ts`.

## Contributing & security

- Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and the two-tier test workflow.
- Changes are tracked in [CHANGELOG.md](CHANGELOG.md).
- Found a security issue? Please report it privately — see [SECURITY.md](SECURITY.md). Don't open a public issue.

## License

Apache-2.0 — see [LICENSE](LICENSE). Nakama is a trademark of Heroic Labs; this is an independent integration.
