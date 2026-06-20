export interface NakamaConfig {
  host: string;
  clientPort: number;
  consolePort: number;
  useSsl: boolean;
  serverKey: string;
  consoleUsername: string;
  consolePassword: string;
  timeoutMs: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function loadConfig(): NakamaConfig {
  return {
    host: process.env.NAKAMA_HOST?.trim() || "127.0.0.1",
    clientPort: intEnv("NAKAMA_PORT", 7350),
    consolePort: intEnv("NAKAMA_CONSOLE_PORT", 7351),
    useSsl: boolEnv("NAKAMA_USE_SSL", false),
    serverKey: process.env.NAKAMA_SERVER_KEY?.trim() || "defaultkey",
    consoleUsername: process.env.NAKAMA_CONSOLE_USERNAME?.trim() || "admin",
    consolePassword: process.env.NAKAMA_CONSOLE_PASSWORD ?? "password",
    timeoutMs: intEnv("NAKAMA_TIMEOUT_MS", 15000),
  };
}

export interface HttpConfig {
  transport: "stdio" | "http";
  host: string;
  port: number;
  path: string;
  authToken?: string;
  sessionTtlMs: number;
}

export function loadHttpConfig(): HttpConfig {
  const transport = (process.env.MCP_TRANSPORT?.trim() || "stdio").toLowerCase();
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid MCP_TRANSPORT '${transport}'. Use 'stdio' or 'http'.`);
  }
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  return {
    transport,
    host: process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1",
    port: intEnv("MCP_HTTP_PORT", 3000),
    path: process.env.MCP_HTTP_PATH?.trim() || "/mcp",
    authToken: token && token.length > 0 ? token : undefined,
    sessionTtlMs: intEnv("MCP_SESSION_TTL_MS", 1_800_000),
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

/** Returns an error message if the bind target is unsafe (non-loopback without a token), else undefined. */
export function httpSecurityError(host: string, authToken?: string): string | undefined {
  if (!authToken && !isLoopbackHost(host)) {
    return `Refusing to bind ${host} without MCP_AUTH_TOKEN. Set a token or bind 127.0.0.1.`;
  }
  return undefined;
}
