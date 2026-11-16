import type { Clock } from '../src/http/clock.js';
import type { FetchLike } from '../src/http/request.js';
import { createThrottle } from '../src/http/throttle.js';
import { createLogger, type Logger } from '../src/log/logger.js';
import type { LockOutcome, TokenRecord, TokenStore } from '../src/tokenStore/types.js';

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type Responder = Response | Error | ((req: Recorded) => Response | Error);

/**
 * A fetch that serves responses in order and records every request. Running past the end of the
 * script fails the test loudly instead of hanging.
 */
export function fakeFetch(script: Responder[]): FetchLike & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const req: Recorded = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    };
    calls.push(req);
    const next = script[calls.length - 1];
    if (next === undefined) throw new Error(`unexpected request #${calls.length}: ${req.method} ${url}`);
    const res = typeof next === 'function' ? next(req) : next;
    if (res instanceof Error) throw res;
    return res;
  }) as FetchLike & { calls: Recorded[] };
  fn.calls = calls;
  return fn;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Virtual time that advances instantly on sleep, so retry backoff does not slow tests. */
export function instantClock(start = 1_700_000_000_000): Clock & { slept: number[] } {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

export function fastThrottle(clock: Clock) {
  return createThrottle({ ratePerSecond: 1000, maxConcurrent: 1, clock });
}

export function captureLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', stderr: (l) => lines.push(l), stdout: (t) => lines.push(t) });
  return Object.assign(log, { lines });
}

/** In-memory TokenStore that records the order of operations. */
export function memoryStore(initial: TokenRecord | null): TokenStore & { record: TokenRecord | null; events: string[]; failSet?: boolean } {
  const store = {
    record: initial,
    events: [] as string[],
    failSet: false,
    async get() {
      store.events.push('get');
      return store.record;
    },
    async set(r: TokenRecord) {
      store.events.push('set');
      if (store.failSet) throw new Error('disk full');
      store.record = r;
    },
    async lock(): Promise<LockOutcome> {
      return { acquired: true };
    },
    async unlock() {},
    describe: () => '/secure/qbo.token.json',
  };
  return store;
}
