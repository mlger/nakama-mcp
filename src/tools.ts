import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NakamaClient, NakamaError } from "./nakama.js";
import { actions, compact, getAction, searchActions, type Surface } from "./catalog.js";
import { redact } from "./redact.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  let text: string;
  if (err instanceof NakamaError) {
    text = `Request failed (HTTP ${err.status}) for ${err.where}.\n${typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2)}`;
  } else if (err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }
  return { content: [{ type: "text", text: redact(text) }], isError: true };
}

function asJsonString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? {});
}

export function registerTools(server: McpServer, nakama: NakamaClient): void {
  const counts = {
    total: actions.length,
    client: actions.filter((a) => a.surface === "client").length,
    console: actions.filter((a) => a.surface === "console").length,
  };

  // 1. search_actions ---------------------------------------------------------
  server.registerTool(
    "nakama_search_actions",
    {
      title: "Search Nakama API actions",
      description:
        `Search the Nakama API catalog (${counts.total} operations: ${counts.client} client, ${counts.console} console) by natural-language intent ` +
        "and get matching action IDs, HTTP method/path, summaries, and parameter schemas. " +
        "Use this to discover the action_id you then pass to nakama_execute_action. " +
        "Results include resolved request-body field schemas when available. " +
        "Examples: 'list players', 'write storage object', 'leaderboard records', 'ban account', 'active matches'.",
      inputSchema: {
        query: z.string().describe("Natural-language description of what you want to do."),
        surface: z
          .enum(["client", "console"])
          .optional()
          .describe("Limit to 'client' (player-facing :7350) or 'console' (admin :7351) API."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, surface, limit }) => {
      const results = searchActions(query, surface as Surface | undefined, limit ?? 20);
      if (results.length === 0) {
        return ok({ matches: [], hint: "No matches. Try broader terms, or drop the surface filter." });
      }
      return ok({ count: results.length, matches: results.map(compact) });
    },
  );

  // 2. execute_action ---------------------------------------------------------
  server.registerTool(
    "nakama_execute_action",
    {
      title: "Execute a Nakama API action",
      description:
        "Execute any Nakama operation by its action_id (from nakama_search_actions). Provide path_params, query_params, and/or body as needed. " +
        "Auth is handled automatically: console actions auto-login with configured admin credentials; client actions use the player session from nakama_authenticate; " +
        "authenticate endpoints use the server key. For calling server RPCs prefer nakama_call_rpc (it encodes the payload correctly).",
      inputSchema: {
        action_id: z.string().describe("Action ID returned by nakama_search_actions, e.g. 'ListAccounts' or 'Nakama_WriteStorageObjects'."),
        path_params: z.record(z.any()).optional().describe("Values for {placeholders} in the path, e.g. { id: '<uuid>' }."),
        query_params: z.record(z.any()).optional().describe("Query-string parameters."),
        body: z.record(z.any()).optional().describe("JSON request body (for POST/PUT/DELETE actions that take one)."),
        auto_paginate: z.boolean().optional().describe("For GET list endpoints: follow `cursor`/`next_cursor` and merge pages."),
        max_pages: z.number().int().min(1).max(20).optional().describe("Max pages to fetch when auto_paginate is set (default 5)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ action_id, path_params, query_params, body, auto_paginate, max_pages }) => {
      const action = getAction(action_id);
      if (!action) {
        const guess = searchActions(action_id, undefined, 5).map((a) => a.id);
        return fail(
          new Error(`Unknown action_id '${action_id}'. ${guess.length ? `Did you mean: ${guess.join(", ")}?` : "Use nakama_search_actions to find one."}`),
        );
      }
      try {
        const reqOpts = {
          surface: action.surface,
          method: action.method,
          path: action.path,
          pathParams: path_params,
          queryParams: query_params,
          body,
        };
        const data =
          auto_paginate && action.method === "GET"
            ? await nakama.requestPaginated(reqOpts, max_pages ?? 5)
            : await nakama.request(reqOpts);
        return ok(data ?? { ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 3. authenticate (client player session) -----------------------------------
  server.registerTool(
    "nakama_authenticate",
    {
      title: "Authenticate a player (client API)",
      description:
        "Establish a player session for the client API (:7350). Required before calling other client/player endpoints. " +
        "Supports device, custom, or email auth. The session token is held in memory for subsequent calls.",
      inputSchema: {
        method: z.enum(["device", "custom", "email"]).describe("Authentication method."),
        id: z.string().optional().describe("Device or custom ID (for method device/custom)."),
        email: z.string().optional().describe("Email (for method email)."),
        password: z.string().optional().describe("Password (for method email)."),
        username: z.string().optional().describe("Optional username to set when creating the account."),
        create: z.boolean().optional().describe("Create the account if it does not exist (default true on Nakama)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ method, id, email, password, username, create }) => {
      try {
        const data = await nakama.authenticatePlayer({ method, id, email, password, username, create });
        const tok = data.token ?? "";
        return ok({ authenticated: true, method, token_preview: tok ? `${tok.slice(0, 12)}…(${tok.length} chars)` : null });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 4. call_rpc ---------------------------------------------------------------
  server.registerTool(
    "nakama_call_rpc",
    {
      title: "Call a Nakama server RPC",
      description:
        "Invoke a registered runtime RPC function by id over the client API. Pass payload as a JSON object or string; it is encoded as the gateway expects. " +
        "Provide http_key to call an RPC without a player session; otherwise authenticate first with nakama_authenticate.",
      inputSchema: {
        id: z.string().describe("Registered RPC function id."),
        payload: z.union([z.record(z.any()), z.string()]).optional().describe("RPC payload (object or string)."),
        http_key: z.string().optional().describe("Server HTTP key for unauthenticated RPC calls."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id, payload, http_key }) => {
      try {
        const data = await nakama.callRpc(id, payload, http_key);
        return ok(data ?? { ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 5-8. Promoted console reads ----------------------------------------------
  server.registerTool(
    "nakama_console_list_accounts",
    {
      title: "List player accounts (console)",
      description: "List/search player accounts via the console API. Optional filter by user ID or username.",
      inputSchema: {
        filter: z.string().optional().describe("User ID or username filter."),
        tombstones: z.boolean().optional().describe("Search only recorded deletes."),
        cursor: z.string().optional().describe("Pagination cursor."),
        auto_paginate: z.boolean().optional().describe("Follow cursors and merge all pages."),
        max_pages: z.number().int().min(1).max(20).optional().describe("Max pages when auto_paginate (default 5)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter, tombstones, cursor, auto_paginate, max_pages }) => {
      try {
        const opts = { surface: "console" as const, method: "GET", path: "/v2/console/account", queryParams: { filter, tombstones, cursor } };
        return ok(auto_paginate ? await nakama.requestPaginated(opts, max_pages ?? 5) : await nakama.request(opts));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "nakama_console_get_account",
    {
      title: "Get a player account (console)",
      description: "Fetch a single player account (profile, wallet, devices, linked logins) by user ID via the console API.",
      inputSchema: { id: z.string().describe("Player user ID (UUID).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return ok(await nakama.request({ surface: "console", method: "GET", path: "/v2/console/account/{id}", pathParams: { id } }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "nakama_console_list_storage",
    {
      title: "List storage objects (console)",
      description: "List storage objects via the console API, optionally filtered by collection, key, and/or owner user ID.",
      inputSchema: {
        collection: z.string().optional().describe("Storage collection name."),
        key: z.string().optional().describe("Storage key."),
        user_id: z.string().optional().describe("Owner user ID."),
        cursor: z.string().optional().describe("Pagination cursor."),
        auto_paginate: z.boolean().optional().describe("Follow cursors and merge all pages."),
        max_pages: z.number().int().min(1).max(20).optional().describe("Max pages when auto_paginate (default 5)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ collection, key, user_id, cursor, auto_paginate, max_pages }) => {
      try {
        const opts = { surface: "console" as const, method: "GET", path: "/v2/console/storage", queryParams: { collection, key, user_id, cursor } };
        return ok(auto_paginate ? await nakama.requestPaginated(opts, max_pages ?? 5) : await nakama.request(opts));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "nakama_console_get_status",
    {
      title: "Get server status (console)",
      description: "Return Nakama node status and lightweight service metrics (CPU, memory, latency, presences) via the console API.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await nakama.request({ surface: "console", method: "GET", path: "/v2/console/status" }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- Promoted write tools ----------------------------------------------------
  server.registerTool(
    "nakama_write_storage_object",
    {
      title: "Write a storage object (client)",
      description:
        "Write or update a single storage object as the authenticated player (call nakama_authenticate first). " +
        "Pass value as an object or JSON string. Use version '*' to require the object not already exist.",
      inputSchema: {
        collection: z.string().describe("Collection name."),
        key: z.string().describe("Object key."),
        value: z.union([z.record(z.any()), z.string()]).describe("Object value (object or JSON string)."),
        version: z.string().optional().describe("Optimistic-concurrency version; '*' means must-not-exist."),
        permission_read: z.number().int().min(0).max(2).optional().describe("0=none, 1=owner (default), 2=public."),
        permission_write: z.number().int().min(0).max(1).optional().describe("0=none, 1=owner (default)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ collection, key, value, version, permission_read, permission_write }) => {
      try {
        const object = { collection, key, value: asJsonString(value), version, permission_read, permission_write };
        return ok(await nakama.request({ surface: "client", method: "PUT", path: "/v2/storage", body: { objects: [object] } }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "nakama_write_leaderboard_record",
    {
      title: "Write a leaderboard record (client)",
      description: "Submit a score to a leaderboard as the authenticated player (call nakama_authenticate first).",
      inputSchema: {
        leaderboard_id: z.string().describe("Leaderboard ID."),
        score: z.union([z.number(), z.string()]).describe("Score (int64)."),
        subscore: z.union([z.number(), z.string()]).optional().describe("Optional tie-breaker subscore (int64)."),
        metadata: z.union([z.record(z.any()), z.string()]).optional().describe("Optional metadata (object or JSON string)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ leaderboard_id, score, subscore, metadata }) => {
      try {
        const record: Record<string, unknown> = { score: String(score) };
        if (subscore != null) record.subscore = String(subscore);
        if (metadata != null) record.metadata = asJsonString(metadata);
        return ok(await nakama.request({ surface: "client", method: "POST", path: "/v2/leaderboard/{leaderboardId}", pathParams: { leaderboardId: leaderboard_id }, body: record }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "nakama_send_notification",
    {
      title: "Send a notification (console)",
      description: "Send an in-app notification to a player via the console API. Use a positive app-defined code (<=0 is reserved).",
      inputSchema: {
        user_id: z.string().describe("Recipient player user ID."),
        subject: z.string().describe("Notification subject/title."),
        content: z.union([z.record(z.any()), z.string()]).optional().describe("Content (object or JSON string)."),
        code: z.number().int().optional().describe("App-defined notification code (default 0)."),
        persistent: z.boolean().optional().describe("Persist for offline delivery (default true)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ user_id, subject, content, code, persistent }) => {
      try {
        const body = { user_id, subject, content: asJsonString(content ?? {}), code: code ?? 0, persistent: persistent ?? true };
        return ok((await nakama.request({ surface: "console", method: "POST", path: "/v2/console/notification", body })) ?? { ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "nakama_ban_account",
    {
      title: "Ban a player account (console)",
      description: "Ban a player account by user ID via the console API.",
      inputSchema: { id: z.string().describe("Player user ID to ban.") },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return ok((await nakama.request({ surface: "console", method: "POST", path: "/v2/console/account/{id}/ban", pathParams: { id } })) ?? { ok: true, banned: id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "nakama_unban_account",
    {
      title: "Unban a player account (console)",
      description: "Remove a ban from a player account by user ID via the console API.",
      inputSchema: { id: z.string().describe("Player user ID to unban.") },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return ok((await nakama.request({ surface: "console", method: "POST", path: "/v2/console/account/{id}/unban", pathParams: { id } })) ?? { ok: true, unbanned: id });
      } catch (err) {
        return fail(err);
      }
    },
  );


  server.registerTool(
    "nakama_healthcheck",
    {
      title: "Check Nakama connectivity",
      description:
        "Probe both APIs: the client /healthcheck endpoint and a console status call (which also verifies admin login). " +
        "Returns a per-surface reachability report. Use this first when calls are failing.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await nakama.healthcheck());
      } catch (err) {
        return fail(err);
      }
    },
  );

}
