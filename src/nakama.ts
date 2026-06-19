import type { NakamaConfig } from "./config.js";
import type { Surface } from "./catalog.js";
import { redact } from "./redact.js";

export class NakamaError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    public where: string,
  ) {
    super(`Nakama ${where} -> HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "NakamaError";
  }
}

function mergePages(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = Array.isArray(v) && Array.isArray(prev) ? [...prev, ...v] : v;
  }
  return out;
}

interface RequestOpts {
  surface: Surface;
  method: string;
  path: string;
  pathParams?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  body?: unknown;
  /** string = use as Authorization header; null = send no auth; undefined = auto-derive */
  authOverride?: string | null;
}

interface TokenState {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
}

function decodeJwtExpMs(token: string): number | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { exp?: number };
    return claims.exp ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class NakamaClient {
  private session?: TokenState; // player session (client API)
  private consoleToken?: TokenState; // console admin token

  constructor(private cfg: NakamaConfig) {}

  private baseUrl(surface: Surface): string {
    const proto = this.cfg.useSsl ? "https" : "http";
    const port = surface === "console" ? this.cfg.consolePort : this.cfg.clientPort;
    return `${proto}://${this.cfg.host}:${port}`;
  }

  private basicServerKey(): string {
    return "Basic " + Buffer.from(`${this.cfg.serverKey}:`).toString("base64");
  }

  hasSession(): boolean {
    return !!this.session;
  }

  private async authFor(surface: Surface, path: string): Promise<string | undefined> {
    if (surface === "client") {
      if (path.startsWith("/v2/account/authenticate") || path === "/v2/account/session/refresh") {
        return this.basicServerKey();
      }
      if (path === "/" || path === "/healthcheck") return undefined;
      if (!this.session) {
        throw new Error(
          "No player session yet. Client API endpoints require a player session token — call nakama_authenticate first (e.g. device or email login).",
        );
      }
      return `Bearer ${this.session.token}`;
    }
    // console
    if (path === "/v2/console/authenticate") return undefined;
    await this.ensureConsole();
    return `Bearer ${this.consoleToken!.token}`;
  }

  async request<T = unknown>(opts: RequestOpts): Promise<T> {
    const { surface, method, pathParams, queryParams, body } = opts;
    const path = opts.path.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const v = pathParams?.[key];
      if (v == null) throw new Error(`Missing required path parameter: ${key}`);
      return encodeURIComponent(String(v));
    });

    const url = new URL(this.baseUrl(surface) + path);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        if (v == null) continue;
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
        else url.searchParams.append(k, String(v));
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    const auth = opts.authOverride === undefined ? await this.authFor(surface, path) : opts.authOverride;
    if (auth) headers["Authorization"] = auth;

    let bodyStr: string | undefined;
    if (body !== undefined && method.toUpperCase() !== "GET") {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to reach Nakama at ${url.origin} (${reason}). Check that the server is running and host/port/SSL settings are correct.`);
    }

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw new NakamaError(res.status, data, `${method.toUpperCase()} ${path}`);
    return data as T;
  }

  private async ensureConsole(): Promise<void> {
    const valid = this.consoleToken && (!this.consoleToken.expiresAt || this.consoleToken.expiresAt > Date.now() + 5000);
    if (valid) return;
    const data = await this.request<{ token: string; refresh_token?: string }>({
      surface: "console",
      method: "POST",
      path: "/v2/console/authenticate",
      body: { username: this.cfg.consoleUsername, password: this.cfg.consolePassword },
      authOverride: null,
    });
    if (!data?.token) throw new Error("Console login did not return a token. Check NAKAMA_CONSOLE_USERNAME / NAKAMA_CONSOLE_PASSWORD.");
    this.consoleToken = { token: data.token, refreshToken: data.refresh_token, expiresAt: decodeJwtExpMs(data.token) };
  }

  /** Authenticate a player against the client API and store the session token. */
  async authenticatePlayer(input: {
    method: "device" | "email" | "custom";
    id?: string;
    email?: string;
    password?: string;
    username?: string;
    create?: boolean;
  }): Promise<{ token: string; refresh_token?: string }> {
    let path: string;
    let body: Record<string, unknown>;
    if (input.method === "device") {
      if (!input.id) throw new Error("device auth requires `id`");
      path = "/v2/account/authenticate/device";
      body = { id: input.id };
    } else if (input.method === "custom") {
      if (!input.id) throw new Error("custom auth requires `id`");
      path = "/v2/account/authenticate/custom";
      body = { id: input.id };
    } else {
      if (!input.email || !input.password) throw new Error("email auth requires `email` and `password`");
      path = "/v2/account/authenticate/email";
      body = { email: input.email, password: input.password };
    }
    const query: Record<string, unknown> = {};
    if (input.create != null) query.create = input.create;
    if (input.username) query.username = input.username;

    const data = await this.request<{ token: string; refresh_token?: string }>({
      surface: "client",
      method: "POST",
      path,
      queryParams: query,
      body,
    });
    this.session = { token: data.token, refreshToken: data.refresh_token, expiresAt: decodeJwtExpMs(data.token) };
    return data;
  }

  /**
   * Call a registered server RPC over the client API.
   * The REST gateway binds the HTTP body to the RPC `payload` string, so the
   * payload must be sent as a JSON-encoded string (handled here).
   */
  async callRpc(id: string, payload?: unknown, httpKey?: string): Promise<unknown> {
    const query: Record<string, unknown> = {};
    if (httpKey) query.httpKey = httpKey;
    // Encode payload as a JSON string value, which is what the gateway expects.
    const inner = payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload);
    return this.request({
      surface: "client",
      method: "POST",
      path: "/v2/rpc/{id}",
      pathParams: { id },
      queryParams: query,
      body: inner, // request() will JSON.stringify -> quoted JSON string
      authOverride: httpKey ? null : undefined,
    });
  }

  /**
   * Like request(), but follows Nakama list cursors and merges array fields
   * across pages. Reads `cursor` / `next_cursor` from each response. Bounded.
   */
  async requestPaginated<T = Record<string, unknown>>(opts: RequestOpts, maxPages = 5): Promise<T> {
    const cap = Math.max(1, Math.min(maxPages, 20));
    let cursor = "";
    let pages = 0;
    let merged: Record<string, unknown> | null = null;
    let nonObject: unknown = undefined;
    do {
      const queryParams = { ...(opts.queryParams ?? {}) };
      if (cursor) queryParams.cursor = cursor;
      const data = await this.request<unknown>({ ...opts, queryParams });
      pages++;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const obj = data as Record<string, unknown>;
        merged = merged == null ? { ...obj } : mergePages(merged, obj);
        cursor = String(obj.cursor ?? obj.next_cursor ?? "");
      } else {
        nonObject = data;
        cursor = "";
      }
    } while (cursor && pages < cap);

    if (merged) {
      merged.__pages_fetched = pages;
      merged.__more_available = Boolean(cursor);
      return merged as T;
    }
    return nonObject as T;
  }

  /** Probe connectivity/auth for both surfaces. Never throws. */
  async healthcheck(): Promise<{
    config: { host: string; clientPort: number; consolePort: number; ssl: boolean };
    client: { reachable: boolean; error?: string };
    console: { reachable: boolean; authenticated: boolean; error?: string };
  }> {
    const report = {
      config: { host: this.cfg.host, clientPort: this.cfg.clientPort, consolePort: this.cfg.consolePort, ssl: this.cfg.useSsl },
      client: { reachable: false } as { reachable: boolean; error?: string },
      console: { reachable: false, authenticated: false } as { reachable: boolean; authenticated: boolean; error?: string },
    };
    try {
      await this.request({ surface: "client", method: "GET", path: "/healthcheck" });
      report.client.reachable = true;
    } catch (err) {
      report.client.error = redact(err instanceof Error ? err.message : String(err));
    }
    try {
      await this.ensureConsole();
      await this.request({ surface: "console", method: "GET", path: "/v2/console/status" });
      report.console.reachable = true;
      report.console.authenticated = true;
    } catch (err) {
      report.console.error = redact(err instanceof Error ? err.message : String(err));
    }
    return report;
  }
}
