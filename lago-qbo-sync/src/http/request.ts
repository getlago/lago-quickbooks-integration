import { HttpError, NetworkError, parseRetryAfter, type HttpService } from './errors.js';

/** `fetch`, injectable for tests. Native fetch is the only HTTP client (brief §4.1). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpRequest {
  service: HttpService;
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Error bodies are kept for fault messages; anything longer is cut (an HTML error page, say). */
const MAX_TEXT_BODY = 2000;

/**
 * The one query-string / form encoder (brief §6 bug #1): every key and value goes through
 * encodeURIComponent. Used for Lago and QBO URLs and the Intuit token form body.
 */
export function encodeParams(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Socket-level error codes that a retry can fix. Anything else (a refused redirect, a TLS or
 * DNS misconfiguration) fails the same way every time, so it is not retried.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** fetch wraps the socket error: `TypeError('fetch failed', { cause: { code } })`. */
function isTransient(err: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(invalid url)';
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > MAX_TEXT_BODY ? `${text.slice(0, MAX_TEXT_BODY)}…` : text;
  }
}

/**
 * Sends one request. Returns the parsed body for 2xx; throws HttpError for any other status and
 * NetworkError when no response arrived (including our timeout). Errors carry the URL path only,
 * never headers or the request body.
 */
export async function sendRequest(fetchFn: FetchLike, req: HttpRequest, nowMs: () => number): Promise<HttpResponse> {
  const path = pathOf(req.url);
  let res: Response;
  try {
    res = await fetchFn(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: 'error', // never follow a redirect with our Authorization header to another host
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new NetworkError(req.service, req.method, path, timedOut, isTransient(err, timedOut), err);
  }
  const body = await readBody(res);
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(req.service, req.method, path, res.status, parseRetryAfter(res.headers.get('retry-after'), nowMs()), body);
  }
  return { status: res.status, body, headers: res.headers };
}
