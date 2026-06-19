#!/usr/bin/env node
// Unit test for the catalog body-schema resolver, using a synthetic Swagger spec.
import { buildActions, resolveBody } from "../scripts/lib/resolve.mjs";

const spec = {
  swagger: "2.0",
  paths: {
    "/test/{id}": {
      post: {
        operationId: "TestWrite",
        summary: "Write test objects.",
        tags: ["Test"],
        parameters: [
          { name: "id", in: "path", required: true, type: "string" },
          { name: "dry", in: "query", required: false, type: "boolean" },
          { name: "body", in: "body", required: true, schema: { $ref: "#/definitions/TestWriteReq" } },
        ],
      },
    },
  },
  definitions: {
    TestWriteReq: {
      type: "object",
      required: ["objects"],
      properties: {
        objects: { type: "array", items: { $ref: "#/definitions/TestObj" } },
        dryRun: { type: "boolean", description: "Validate only." },
      },
    },
    TestObj: {
      type: "object",
      required: ["collection", "key"],
      properties: {
        collection: { type: "string" },
        key: { type: "string" },
        score: { type: "string", format: "int64", description: "Score value." },
        meta: { $ref: "#/definitions/Meta" },
      },
    },
    Meta: { type: "object", properties: { k: { type: "string" } } },
  },
};

let failed = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  PASS  ${msg}`); } else { failed++; console.log(`  FAIL  ${msg}`); } };

console.log("resolver unit test\n");

const actions = buildActions(spec, "client");
const a = actions[0];
ok(a.id === "TestWrite", "operationId captured");
ok(a.params.find((p) => p.in === "path")?.name === "id", "path param captured");

const body = a.params.find((p) => p.in === "body");
ok(body?.schemaRef === "TestWriteReq", "body schemaRef captured");
ok(!!body?.bodySchema, "bodySchema resolved");

const fields = body.bodySchema.fields;
const objs = fields.find((f) => f.name === "objects");
ok(objs?.type === "array<TestObj>", `objects typed as array<TestObj> (got ${objs?.type})`);
ok(objs?.required === true, "objects marked required");
ok(fields.find((f) => f.name === "dryRun")?.type === "boolean", "dryRun typed boolean");

const d = body.bodySchema.defs || {};
ok(!!d.TestObj, "nested TestObj expanded");
ok(d.TestObj.find((f) => f.name === "score")?.type === "string (int64)", "int64 format surfaced");
ok(d.TestObj.find((f) => f.name === "collection")?.required === true, "nested required surfaced");
ok(d.TestObj.find((f) => f.name === "meta")?.type === "Meta", "nested ref typed by name");
ok(!!d.Meta, "transitively-referenced Meta expanded");

// cycle guard
const cyc = { A: { properties: { self: { $ref: "#/definitions/A" }, b: { $ref: "#/definitions/B" } } }, B: { properties: { a: { $ref: "#/definitions/A" } } } };
const r = resolveBody("A", cyc);
ok(!!r && !!r.defs?.B, "cycle-safe expansion completes");

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
