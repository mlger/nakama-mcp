# Security Policy

## Supported versions

nakama-mcp is pre-1.0 and ships fixes on the latest release only. Please test
against the most recent version before reporting.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/mlger/nakama-mcp/security) of this repository.
2. Click **Report a vulnerability** to open a private advisory visible only to the maintainers.

Please include, where possible:

- The type of issue and the affected component (e.g. the Nakama client, a tool, redaction).
- Steps to reproduce, proof-of-concept, and impact.
- The version and your environment (Node version, OS, Nakama version).

We aim to acknowledge reports within a few days and will coordinate a fix and
disclosure timeline with you.

## Scope & handling notes

This server brokers credentials to a Nakama instance. A few things to keep in mind:

- **Secrets live in env vars** (`NAKAMA_SERVER_KEY`, `NAKAMA_CONSOLE_PASSWORD`, …).
  Prefer your MCP host's secret/keychain config over committing them. The MCPB
  bundle stores the server key and console password in the OS keychain.
- **Error output is redacted** — the configured server key/console password, JWTs,
  and `Basic`/`Bearer` header values are scrubbed before reaching the model
  (see `src/redact.ts`, covered by `npm run test:redact`). If you find a way to
  leak a secret past redaction, that is in scope — please report it privately.

Thank you for helping keep nakama-mcp and its users safe.
