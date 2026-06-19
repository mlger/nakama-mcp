// Best-effort scrubbing of secrets from text returned to the model (error
// messages, healthcheck reports). Tokens and keys must never leak in output.

const secrets: string[] = [];

/** Register literal secret values to scrub (server key, console password, …). */
export function registerSecrets(values: (string | undefined)[]): void {
  for (const v of values) {
    if (v && v.length >= 6 && !secrets.includes(v)) secrets.push(v);
  }
}

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const AUTH = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/g;

export function redact(input: string): string {
  let out = input;
  for (const sec of secrets) {
    if (sec) out = out.split(sec).join("***");
  }
  out = out.replace(JWT, "***").replace(AUTH, "$1 ***");
  return out;
}
