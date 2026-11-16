/**
 * The single place where secrets are scrubbed (brief §8). Every byte the process writes to stdout
 * or stderr goes through `redactString` (via the logger), including error messages and stacks.
 *
 * Three layers, so one missed case does not leak:
 *  1. Known values: secrets registered at startup (env) and as they are obtained (tokens).
 *  2. Sensitive keys: object fields such as `authorization` or `refresh_token` are blanked whatever their value.
 *  3. Patterns: `Bearer …`, `Basic …` and token-like form/query parameters.
 */

export const REDACTED = '[REDACTED]';

/** Shorter values are not registered: they would blank ordinary words in log lines. */
const MIN_SECRET_LENGTH = 6;

// `code` is deliberately not a key here: Lago item codes and QBO fault codes must stay readable.
// The OAuth authorization code only travels in the callback query string, covered by PATTERNS.
const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|access_?token|refresh_?token|id_?token|client_?secret|api_?key|password|secret)$/i;

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${REDACTED}`],
  [/\b(access_token|refresh_token|id_token|client_secret|api_key|code)=([^&\s"']+)/gi, `$1=${REDACTED}`],
  [/"(access_token|refresh_token|id_token|client_secret|api_key)"\s*:\s*"[^"]*"/gi, `"$1":"${REDACTED}"`],
];

const secrets = new Set<string>();

/**
 * Registers a secret value. Its URL-encoded and base64 forms are registered too, because they
 * appear in query strings and Basic auth headers.
 */
export function registerSecret(value: string | undefined | null): void {
  if (!value || value.length < MIN_SECRET_LENGTH) return;
  for (const variant of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) {
    secrets.add(variant);
  }
}

/** Test hook: forget registered secrets. Not used by production code. */
export function clearSecretsForTests(): void {
  secrets.clear();
}

export function redactString(text: string): string {
  let out = text;
  // Longest first, so a secret that contains another secret is fully removed.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Deep copy with sensitive keys blanked and every string redacted. Handles Errors and cycles. */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) return redactError(value, seen);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(v, seen);
  }
  return out;
}

export interface RedactedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  [extra: string]: unknown;
}

export function redactError(err: Error, seen = new WeakSet<object>()): RedactedError {
  seen.add(err);
  const out: RedactedError = { name: err.name, message: redactString(err.message) };
  if (err.stack) out.stack = redactString(err.stack);
  if (err.cause !== undefined) out.cause = redactValue(err.cause, seen);
  // Own enumerable fields (e.g. ConfigError.issues, QBO fault details) are kept, redacted.
  for (const [key, v] of Object.entries(err)) {
    if (key in out) continue;
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(v, seen);
  }
  return out;
}
