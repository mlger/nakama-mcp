#!/usr/bin/env node
// Unit test for secret redaction. Requires `npm run build` first (imports dist).
import { registerSecrets, redact } from "../dist/redact.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log(`  PASS  ${m}`); else { failed++; console.log(`  FAIL  ${m}`); } };

console.log("redaction unit test\n");

registerSecrets(["supersecretkey", "password123", "abc"]); // "abc" too short -> ignored
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.c2lnbmF0dXJl";

ok(redact("key=supersecretkey ok") === "key=*** ok", "literal secret scrubbed");
ok(redact("pw=password123!") === "pw=***!", "second secret scrubbed");
ok(redact("abc stays") === "abc stays", "too-short secret not scrubbed");
ok(redact(`token ${jwt} end`) === "token *** end", "JWT scrubbed");
ok(redact("Authorization: Bearer abc.def.ghi") === "Authorization: Bearer ***", "Bearer header scrubbed");
ok(redact("auth Basic ZGVmYXVsdGtleTo=") === "auth Basic ***", "Basic header scrubbed");
ok(redact("nothing to see") === "nothing to see", "clean text untouched");

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
