import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Single source of truth for the server version: read package.json at runtime
// (mirrors how catalog.ts loads data/catalog.json relative to the build output).
// The MCPB build stages package.json alongside the bundle so this works there too.
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

export const VERSION: string = pkg.version;
