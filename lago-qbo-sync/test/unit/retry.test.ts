import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, NetworkError, parseRetryAfter } from '../../src/http/errors.js';
import { classifyRead, classifyWrite, withRetry, type RetryEvent } from '../../src/http/retry.js';

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

const http = (status: number, retryAfterMs: number | null = null) =>
  new HttpError('qbo', 'GET', '/v3/company/1/query', status, retryAfterMs, null);
const network = () => new NetworkError('qbo', 'GET', '/v3/company/1/query', true, true, new Error('timeout'));
const refusedRedirect = () =>
  new NetworkError('qbo', 'GET', '/v3/company/1/query', false, false, new TypeError('fetch failed', { cause: new Error('unexpected redirect') }));

/** Runs `withRetry` with responses served in order; records attempts and waits. */
async function run(responses: Array<Error | string>, classify = classifyRead) {
  const events: RetryEvent[] = [];
  let calls = 0;
  const promise = withRetry(
    async () => {
      const r = responses[Math.min(calls++, responses.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
    { classify, random: () => 0.5, onRetry: (e) => events.push(e) },
  );
  const settled = promise.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await vi.runAllTimersAsync();
  return { ...(await settled), calls: () => calls, delays: events.map((e) => e.delayMs), elapsed: Date.now() };
}

describe('withRetry (brief §5.4: 5 tries, 1 s base, ×2, jitter, Retry-After)', () => {
  it('retries 429 and 5xx with growing jittered delays, then succeeds', async () => {
    const r = await run([http(429), http(500), http(503), 'ok']);
    expect(r.value).toBe('ok');
    expect(r.calls()).toBe(4);
    // equal jitter with random 0.5: exp/2 + exp/4 → 750, 1500, 3000
    expect(r.delays).toEqual([750, 1500, 3000]);
  });

  it('gives up after 5 attempts and rethrows the last error', async () => {
    const r = await run([http(503)]);
    expect(r.calls()).toBe(5);
    expect(r.delays).toEqual([750, 1500, 3000, 6000]);
    expect(r.error).toBeInstanceOf(HttpError);
    expect((r.error as HttpError).status).toBe(503);
  });

  it('waits at least Retry-After when the server sends it', async () => {
    const r = await run([http(429, 10_000), 'ok']);
    expect(r.delays).toEqual([10_000]);
    expect(r.elapsed).toBe(10_000);
  });

  it('fails instead of waiting out an unreasonable Retry-After', async () => {
    const r = await run([http(429, 10 * 60_000), 'ok']);
    expect(r.calls()).toBe(1);
    expect(r.error).toBeInstanceOf(HttpError);
  });

  it('never retries 400 or 401', async () => {
    for (const status of [400, 401, 403, 404]) {
      const r = await run([http(status), 'ok']);
      expect(r.calls()).toBe(1);
      expect((r.error as HttpError).status).toBe(status);
    }
  });

  it('retries network errors and timeouts on reads', async () => {
    const r = await run([network(), 'ok']);
    expect(r.value).toBe('ok');
    expect(r.calls()).toBe(2);
  });

  it('does not retry a network error that cannot heal (review finding: refused redirect)', async () => {
    const r = await run([refusedRedirect(), 'ok']);
    expect(r.calls()).toBe(1);
    expect(r.error).toBeInstanceOf(NetworkError);
  });

  it('writes: retries only 429; a 5xx or timeout is surfaced so the caller can check by lookup', async () => {
    expect((await run([http(429), 'ok'], classifyWrite)).value).toBe('ok');
    expect((await run([http(500), 'ok'], classifyWrite)).calls()).toBe(1);
    expect((await run([network(), 'ok'], classifyWrite)).calls()).toBe(1);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(' 0 ', 0)).toBe(0);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000)).toBe(6000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:01 GMT', 4000)).toBe(0);
  });

  it('returns null for missing or unparseable values', () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('', 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter('-5', 0)).toBeNull();
  });
});

describe('sendRequest network error classification', () => {
  it('marks socket errors transient and a refused redirect not transient', async () => {
    const { sendRequest } = await import('../../src/http/request.js');
    const fail = (cause: unknown) => async () => {
      throw new TypeError('fetch failed', { cause });
    };
    const req = { service: 'qbo' as const, method: 'GET' as const, url: 'https://x.example/q', headers: {} };
    const reset = await sendRequest(fail(Object.assign(new Error('socket'), { code: 'ECONNRESET' })), req, () => 0).catch((e: unknown) => e);
    const redirect = await sendRequest(fail(new Error('unexpected redirect')), req, () => 0).catch((e: unknown) => e);
    expect((reset as NetworkError).transient).toBe(true);
    expect((redirect as NetworkError).transient).toBe(false);
  });

  it('encodeParams encodes every key and value', async () => {
    const { encodeParams } = await import('../../src/http/request.js');
    expect(encodeParams({ query: "SELECT * FROM X WHERE A = 'b c'", 'a&b': '1=2' })).toBe(
      "query=SELECT%20*%20FROM%20X%20WHERE%20A%20%3D%20'b%20c'&a%26b=1%3D2",
    );
  });
});
