#!/usr/bin/env node
// VERSION must be sourced from package.json (single source of truth), not a
// hardcoded literal. Requires `npm run build` first (imports dist).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../dist/version.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log(`  PASS  ${m}`); else { failed++; console.log(`  FAIL  ${m}`); } };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

console.log("version unit test\n");

ok(typeof VERSION === "string" && VERSION.length > 0, "VERSION is a non-empty string");
ok(VERSION === pkg.version, `VERSION matches package.json (${VERSION} === ${pkg.version})`);

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
