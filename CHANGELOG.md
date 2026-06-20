# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `nakama_send_notification`: send `content` as a JSON object instead of a
  stringified JSON, so the console `/v2/console/notification` endpoint no longer
  rejects it with an HTTP 400 protojson error.
- Integration test storage round-trips now compare values by canonical JSON
  equality instead of byte-for-byte, fixing false failures caused by the
  backend (CockroachDB JSONB) re-rendering stored JSON.

### Changed

- CI uses `actions/checkout@v5` and `actions/setup-node@v5` on Node 22,
  clearing the Node 20 deprecation warning.

### Added

- Community health files: `LICENSE` (Apache-2.0), `CONTRIBUTING.md`,
  `SECURITY.md`, `CHANGELOG.md`, and Dependabot config.

## [0.1.0] - 2026-06-19

### Added

- Initial release: MCP server for Heroic Labs Nakama covering the client
  (`:7350`) and console (`:7351`) APIs with a search + execute design.
- 14 tools: `nakama_search_actions`, `nakama_execute_action`,
  `nakama_authenticate`, `nakama_call_rpc`, four promoted console reads,
  promoted write tools (storage, leaderboard, notification, ban/unban), and
  `nakama_healthcheck`.
- Reliability features: auto-pagination, secret redaction, and a healthcheck probe.
- MCPB bundle packaging, a `docker-compose.yml` for local Nakama, unit + smoke
  + live integration tests, and CI.

[Unreleased]: https://github.com/mlger/nakama-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mlger/nakama-mcp/releases/tag/v0.1.0
