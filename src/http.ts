import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { httpSecurityError, type HttpConfig, type NakamaConfig } from "./config.js";
import type { ConsoleAuth } from "./nakama.js";
import { buildMcpServer } from "./server.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw); // SyntaxError handled by caller
}

export async function startHttpServer(cfg: NakamaConfig, http: HttpConfig): Promise<void> {
  const secErr = httpSecurityError(http.host, http.authToken);
  if (secErr) throw new Error(secErr);

  const sharedConsoleAuth: ConsoleAuth = {};
  const sessions = new Map<string, Session>();

  const authOk = (req: IncomingMessage): boolean => {
    if (!http.authToken) return true;
    return req.headers["authorization"] === `Bearer ${http.authToken}`;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname !== http.path) {
        return rpcError(res, 404, "Not found");
      }
      if (!authOk(req)) {
        return rpcError(res, 401, "Unauthorized");
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Existing session: route to its transport.
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) return rpcError(res, 404, "Unknown session id");
        existing.lastActivity = Date.now();
        let body: unknown;
        if (req.method === "POST") {
          try {
            body = await readBody(req);
          } catch {
            return rpcError(res, 400, "Invalid JSON body");
          }
        }
        return existing.transport.handleRequest(req, res, body);
      }

      // No session id: only a POST initialize may create one.
      if (req.method !== "POST") {
        return rpcError(res, 400, "No valid session; send initialize first");
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        return rpcError(res, 400, "Invalid JSON body");
      }
      if (!isInitializeRequest(body)) {
        return rpcError(res, 400, "No valid session; send initialize first");
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, lastActivity: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const mcp = buildMcpServer(cfg, sharedConsoleAuth);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      process.stderr.write(`nakama-mcp http error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) rpcError(res, 500, "Internal server error");
    }
  });

  const shutdown = () => {
    for (const s of sessions.values()) void s.transport.close();
    server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve) => server.listen(http.port, http.host, resolve));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : http.port;
  process.stderr.write(
    `nakama-mcp ready -> http://${http.host}:${boundPort}${http.path} (transport=http, auth=${http.authToken ? "on" : "off"})\n`,
  );
  if (!http.authToken) {
    process.stderr.write("nakama-mcp warning: MCP_AUTH_TOKEN is not set; endpoint is unauthenticated (loopback only).\n");
  }
}
