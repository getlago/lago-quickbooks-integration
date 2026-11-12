import { HttpError, NetworkError } from '../http/errors.js';

export const RECONNECT_HINT = 'Reconnect QuickBooks: run `npm run auth` (README › Reconnect runbook).';

/**
 * QBO authorization failed: no or invalid refresh token, wrong company, or a second 401 after a
 * refresh. The CLI maps it to exit code 3 (brief §4.3). Messages never contain token values.
 */
export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(reason: string) {
    super(`${reason}. ${RECONNECT_HINT}`);
  }
}

/** QBO answered 200 but with a Fault body. */
export class QboFaultError extends Error {
  override readonly name = 'QboFaultError';

  constructor(
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`QBO returned a Fault for ${path}`);
  }
}

/**
 * A query returned something that is neither rows nor "none" (no QueryResponse object).
 * Brief §6 bug #5: this must never be read as "QBO says none", so it is an error.
 */
export class QboLookupError extends Error {
  override readonly name = 'QboLookupError';
}

/** A write was attempted while writes are disabled (dry-run). This is a bug, not a data error. */
export class WritesDisabledError extends Error {
  override readonly name = 'WritesDisabledError';
}

export interface FaultDetail {
  message: string;
  detail?: string;
  code?: string;
  element?: string;
}

/** Reads `Fault.Error[]` (brief §5.4: Message / Detail / element). Tolerates lower-case `fault`. */
export function parseFault(body: unknown): { type?: string; errors: FaultDetail[] } | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const fault = (record.Fault ?? record.fault) as Record<string, unknown> | undefined;
  if (!fault || typeof fault !== 'object') return null;
  const list = (fault.Error ?? fault.error) as unknown;
  const errors = Array.isArray(list)
    ? list.map((e: Record<string, unknown>) => ({
        message: String(e.Message ?? e.message ?? 'unknown error'),
        ...(e.Detail ?? e.detail ? { detail: String(e.Detail ?? e.detail) } : {}),
        ...(e.code ? { code: String(e.code) } : {}),
        ...(e.element ? { element: String(e.element) } : {}),
      }))
    : [];
  return { ...(fault.type ? { type: String(fault.type) } : {}), errors };
}

/** One line for the run summary: what QBO said, in its own words. */
export function describeQboError(err: unknown): string {
  if (err instanceof HttpError && err.service !== 'qbo') return `${err.service} HTTP ${err.status} on ${err.path}`;
  if (err instanceof HttpError || err instanceof QboFaultError) {
    const status = err instanceof HttpError ? `HTTP ${err.status}` : 'Fault';
    const fault = parseFault(err.body);
    if (fault && fault.errors.length > 0) {
      const parts = fault.errors.map((e) =>
        [e.message, e.detail, e.code ? `code ${e.code}` : '', e.element ? `element ${e.element}` : ''].filter(Boolean).join(' | '),
      );
      return `QBO ${status}${fault.type ? ` ${fault.type}` : ''}: ${parts.join('; ')}`;
    }
    if (typeof err.body === 'string' && /<html/i.test(err.body)) {
      return `QBO ${status} with an HTML page instead of JSON (Intuit rejected the request before the API ran; usually a malformed URL)`;
    }
    return `QBO ${status} on ${err.path}`;
  }
  if (err instanceof NetworkError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
