# nakama-mcp

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg?logo=node.js&logoColor=white)](#prerequisites)
[![MCP](https://img.shields.io/badge/MCP-server-6E56CF.svg)](https://modelcontextprotocol.io)

An MCP (Model Context Protocol) server for [Heroic Labs Nakama](https://github.com/heroiclabs/nakama).
It lets Claude (or any MCP host) talk to a running Nakama instance across **both** of its HTTP APIs:

- **Client API** (`:7350`) — player-facing: authentication, accounts, friends, groups, storage, leaderboards, tournaments, RPCs, …
- **Console API** (`:7351`) — admin/operations: search players, inspect & edit storage, leaderboards, active matches, server status & metrics, …

Nakama exposes ~180 operations (87 client, 92 console) across the two surfaces, so this server uses a **search + execute** design instead of one tool per endpoint, plus a handful of promoted convenience tools for the most common jobs.

## Contents

- [Tools](#tools)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Install & build](#install--build)
- [Configuration](#configuration)
- [Add to an MCP host](#add-to-an-mcp-host)
- [How auth works](#how-auth-works)
- [Usage examples (what to ask Claude)](#usage-examples-what-to-ask-claude)
- [Testing against a real Nakama](#testing-against-a-real-nakama)
- [Continuous integration](#continuous-integration)
- [Regenerating the API catalog](#regenerating-the-api-catalog)
- [Install as a desktop extension (MCPB)](#install-as-a-desktop-extension-mcpb)
- [Distribution / upgrade path](#distribution--upgrade-path)
- [License](#license)

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

## Quick start

```bash
npm install && npm run build                                 # 1. build the server
claude mcp add nakama -- node "$(pwd)/dist/index.js"          # 2. add to Claude Code
```

3. Point it at your Nakama with `NAKAMA_*` env vars (defaults match a stock local dev setup — see [Configuration](#configuration)), then ask Claude something from the [examples](#usage-examples-what-to-ask-claude).

Using Claude Desktop instead of Claude Code? See [Add to an MCP host](#add-to-an-mcp-host). No Node toolchain? Install the [desktop extension (MCPB)](#install-as-a-desktop-extension-mcpb).

## Prerequisites

- **Node.js `>=18`** — required to build and run the server.
- **A running Nakama instance** to connect to. Don't have one? The bundled `docker-compose.yml` spins up Nakama + CockroachDB locally (see [Testing against a real Nakama](#testing-against-a-real-nakama)).
- **Docker** — only needed if you run the integration test or use the bundled compose file.

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

## License

Apache-2.0. Nakama is a trademark of Heroic Labs; this is an independent integration.
