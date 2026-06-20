# Contributing to nakama-mcp

Thanks for your interest in improving nakama-mcp! This is a small, focused MCP
server for [Heroic Labs Nakama](https://github.com/heroiclabs/nakama).
Contributions of all sizes are welcome — bug reports, docs, and code.

## Ground rules

- Be respectful and constructive in issues, reviews, and discussions.
- Keep changes focused; one logical change per pull request.
- By contributing, you agree your work is licensed under the project's
  [Apache-2.0 License](LICENSE).

## Development setup

Requires **Node.js >= 18**. Docker is needed only for the integration tests.

```bash
npm install
npm run build      # tsc -> dist/
```

Configuration is via `NAKAMA_*` environment variables — see [`.env.example`](.env.example)
and the [Configuration](README.md#configuration) section of the README. Defaults
match a stock local Nakama dev setup.

## Testing

The suite is two tiers (see [README](README.md#continuous-integration)):

```bash
npm test                 # fast, no server: resolver + redaction + smoke
npm run test:integration # live: needs `docker compose up -d --wait` first
```

Both tiers run in CI on every push and PR. Please make sure:

- `npm test` passes locally before opening a PR.
- If your change touches the Nakama client, tools, or catalog, run
  `npm run test:integration` against a live server (`docker compose up -d --wait`).
- New behavior is covered by a test where practical.

## Submitting changes

1. Fork and branch from `main` (e.g. `fix/...`, `feat/...`, `docs/...`).
2. Make your change and add/adjust tests.
3. Run `npm run build && npm test`.
4. Open a pull request against `main` and fill out the template. CI must be green.

## Regenerating the API catalog

`data/catalog.json` is generated from Nakama's upstream OpenAPI specs. If your
change depends on a newer Nakama API surface, regenerate it (needs network):

```bash
npm run regen-catalog            # master
npm run regen-catalog -- v3.37.0 # a specific ref/tag
```

The resolver is covered by `npm run test:resolve`.

## Reporting bugs & requesting features

Open an issue at <https://github.com/mlger/nakama-mcp/issues>. Include your Node
version, OS, and Nakama version, plus steps to reproduce. For security issues,
**do not** open a public issue — see [SECURITY.md](SECURITY.md).
