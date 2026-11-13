/**
 * Errors raised by the HTTP layer. They carry what retry and the run summary need, and never the
 * request headers or body (which may hold tokens). Messages still go through log/redact on output.
 */

export type HttpService = 'lago' | 'qbo' | 'intuit-oauth';

/** A response with a non-2xx status. */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly service: HttpService,
    readonly method: string,
    /** Path only, e.g. "/v3/company/123/query"; the query string is left out of messages. */
    readonly path: string,
    readonly status: number,
    /** Parsed Retry-After, in milliseconds, when the server sent one. */
    readonly retryAfterMs: number | null,
    /** Parsed response body (JSON or text), for fault details. */
    readonly body: unknown,
  ) {
    super(`${service} ${method} ${path} returned HTTP ${status}`);
  }
}

/** The request never produced a response: DNS, connection reset, TLS, or our timeout. */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';

  constructor(
    readonly service: HttpService,
    readonly method: string,
    readonly path: string,
    readonly timedOut: boolean,
    /** True for timeouts and socket errors a retry can fix; false for e.g. a refused redirect. */
    readonly transient: boolean,
    cause: unknown,
  ) {
    super(`${service} ${method} ${path} failed: ${timedOut ? 'timed out' : transient ? 'network error' : 'request refused before a response (not retried)'}`, { cause });
  }
}

/**
 * Retry-After is either delta-seconds or an HTTP date (RFC 9110 §10.2.3).
 * Returns milliseconds from `nowMs`, or null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Only accept an HTTP date ("Sun, 06 Nov 1994 08:49:37 GMT"): Date.parse alone reads "-5" as a year.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}
