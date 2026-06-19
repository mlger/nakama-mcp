#!/usr/bin/env node
// Regenerate data/catalog.json from Nakama's upstream OpenAPI (Swagger 2.0) specs,
// inlining request-body field schemas. Run on your own machine (network needed):
//   npm run regen-catalog            # master
//   npm run regen-catalog -- v3.37.0 # a specific git ref/tag
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildActions } from "./lib/resolve.mjs";

const ref = process.argv[2] || "master";
const SOURCES = [
  { surface: "client", url: `https://raw.githubusercontent.com/heroiclabs/nakama/${ref}/apigrpc/apigrpc.swagger.json` },
  { surface: "console", url: `https://raw.githubusercontent.com/heroiclabs/nakama/${ref}/console/console.swagger.json` },
];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const all = [];
for (const { surface, url } of SOURCES) {
  process.stderr.write(`Fetching ${surface}: ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const spec = await res.json();
  const actions = buildActions(spec, surface);
  const withBody = actions.filter((a) => a.params.some((p) => p.bodySchema)).length;
  process.stderr.write(`  -> ${actions.length} ${surface} actions (${withBody} with resolved body schema)\n`);
  all.push(...actions);
}

mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "catalog.json"), JSON.stringify(all));
process.stderr.write(`Wrote data/catalog.json (${all.length} actions, ref=${ref})\n`);
