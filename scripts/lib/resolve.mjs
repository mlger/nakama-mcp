// Shared catalog builder: turns a Swagger 2.0 spec into the action catalog,
// resolving request-body $refs into inline field schemas so execute_action
// knows exactly what each body expects. Pure functions, no I/O.

export function refName(ref) {
  return ref.split("/").pop();
}

export function typeOf(schema) {
  if (!schema) return "any";
  if (schema.$ref) return refName(schema.$ref);
  if (schema.type === "array") {
    const it = schema.items || {};
    const itt = it.$ref ? refName(it.$ref) : it.type || "any";
    return `array<${itt}>`;
  }
  if (schema.enum) return `enum(${schema.enum.join("|")})`;
  if ((schema.type === "integer" || schema.type === "number" || schema.type === "string") && schema.format) {
    return `${schema.type} (${schema.format})`;
  }
  return schema.type || "object";
}

export function fieldsOf(def) {
  const req = new Set(def.required || []);
  return Object.entries(def.properties || {}).map(([name, sch]) => {
    const f = { name, type: typeOf(sch), required: req.has(name) };
    if (sch.description) f.description = sch.description;
    return f;
  });
}

// Resolve a root definition name into { type, fields, defs } where `defs`
// holds every transitively-referenced object type (bounded, cycle-guarded).
export function resolveBody(rootRef, defs) {
  const root = defs[rootRef];
  if (!root) return undefined;
  const out = { type: rootRef, fields: fieldsOf(root) };
  const nested = {};
  const seen = new Set([rootRef]);
  const queue = [];
  const collect = (fields) => {
    for (const f of fields) {
      const t = f.type.replace(/^array<(.+)>$/, "$1");
      if (defs[t] && !seen.has(t)) { seen.add(t); queue.push(t); }
    }
  };
  collect(out.fields);
  let guard = 0;
  while (queue.length && guard++ < 200) {
    const name = queue.shift();
    const flds = fieldsOf(defs[name]);
    nested[name] = flds;
    collect(flds);
  }
  if (Object.keys(nested).length) out.defs = nested;
  return out;
}

export function buildActions(spec, surface) {
  const defs = spec.definitions || {};
  const actions = [];
  for (const [p, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
      const params = (op.parameters || []).map((pr) => {
        const o = { name: pr.name, in: pr.in, required: !!pr.required, type: pr.type || (pr.schema ? "object" : undefined) };
        if (pr.description) o.description = pr.description;
        if (pr.schema?.$ref) {
          o.schemaRef = refName(pr.schema.$ref);
          const resolved = resolveBody(o.schemaRef, defs);
          if (resolved) o.bodySchema = resolved;
        }
        if (pr.items?.type) o.itemsType = pr.items.type;
        return o;
      });
      actions.push({
        id: op.operationId || `${method.toUpperCase()} ${p}`,
        surface,
        method: method.toUpperCase(),
        path: p,
        summary: op.summary || op.description || "",
        tags: op.tags || [],
        params,
      });
    }
  }
  return actions;
}
