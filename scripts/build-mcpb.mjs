#!/usr/bin/env node
// Assemble the MCPB bundle: bundle the server with esbuild, then stage
// manifest + catalog. Output dir: mcpb-build/  (pack it with `npm run mcpb:pack`).
import { build } from "esbuild";
import { rmSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "mcpb-build");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "server"), { recursive: true });
mkdirSync(join(out, "data"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: join(out, "server", "index.mjs"),
  // SDK ships ESM; keep the import.meta.url-based catalog path working.
  banner: { js: "// nakama-mcp — bundled MCPB server (generated; do not edit)" },
});

copyFileSync(join(root, "data", "catalog.json"), join(out, "data", "catalog.json"));
copyFileSync(join(root, "manifest.json"), join(out, "manifest.json"));
// Staged so the bundled server can read its version from package.json at runtime
// (src/version.ts resolves ../package.json relative to server/index.mjs).
copyFileSync(join(root, "package.json"), join(out, "package.json"));

console.log("Assembled mcpb-build/ (server/index.mjs, data/catalog.json, manifest.json, package.json)");
