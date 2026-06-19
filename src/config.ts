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
