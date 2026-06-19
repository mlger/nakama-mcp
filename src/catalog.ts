import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Surface = "client" | "console";

export interface BodyField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface BodySchema {
  type: string;
  fields: BodyField[];
  defs?: Record<string, BodyField[]>;
}

export interface ActionParam {
  name: string;
  in: "path" | "query" | "body" | "header";
  required: boolean;
  type?: string;
  description?: string;
  schemaRef?: string;
  itemsType?: string;
  bodySchema?: BodySchema;
}

export interface Action {
  id: string;
  surface: Surface;
  method: string;
  path: string;
  summary: string;
  tags: string[];
  params: ActionParam[];
}

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, "..", "data", "catalog.json");

export const actions: Action[] = JSON.parse(readFileSync(catalogPath, "utf8")) as Action[];

const byId = new Map<string, Action>(actions.map((a) => [a.id.toLowerCase(), a]));

export function getAction(id: string): Action | undefined {
  return byId.get(id.toLowerCase());
}

/** Compact view used in search results to keep tokens lean. */
export function compact(a: Action) {
  return {
    id: a.id,
    surface: a.surface,
    method: a.method,
    path: a.path,
    summary: a.summary,
    params: a.params.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      type: p.type,
      ...(p.schemaRef ? { schemaRef: p.schemaRef } : {}),
      ...(p.bodySchema ? { bodySchema: p.bodySchema } : {}),
    })),
  };
}

export function searchActions(query: string, surface?: Surface, limit = 20): Action[] {
  let pool = surface ? actions.filter((a) => a.surface === surface) : actions;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return pool.slice(0, limit);

  const scored = pool
    .map((a) => {
      const id = a.id.toLowerCase();
      const summary = a.summary.toLowerCase();
      const hay = `${id} ${a.path.toLowerCase()} ${summary} ${a.tags.join(" ").toLowerCase()} ${a.method.toLowerCase()}`;
      let score = 0;
      for (const t of terms) {
        if (id.includes(t)) score += 5;
        if (summary.includes(t)) score += 2;
        else if (hay.includes(t)) score += 1;
      }
      return { a, score };
    })
    .filter((x) => x.score > 0);

  scored.sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id));
  return scored.slice(0, limit).map((x) => x.a);
}
