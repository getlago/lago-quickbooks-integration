import { systemClock, type Clock } from './clock.js';
import { HttpError, NetworkError } from './errors.js';

/**
 * Retry with exponential backoff (brief §5.4): 5 tries, 1 s base, ×2, jitter, honoring Retry-After.
 *
 * What is retryable is decided per call by a `classify` function, because it depends on the request:
 * a read can be retried on 5xx, but a QBO create may already have been applied when a 5xx or a
 * timeout comes back, so the QBO client must check by lookup before retrying it (PLAN.md §4.7).
 * 400 and 401 are never retried here; 401 has its own refresh-once path in the QBO client.
 */

export type RetryVerdict = 'retry' | 'stop';
export type Classify = (err: unknown) => RetryVerdict;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  /** A Retry-After longer than this is not waited out: the call fails instead. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxRetryAfterMs: 120_000,
};

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  classify: Classify;
  policy?: RetryPolicy;
  clock?: Clock;
  /** Returns a number in [0, 1). Injected for deterministic tests. */
  random?: () => number;
  /** Called before each wait: used to log, and to pause the shared throttle after a 429. */
  onRetry?: (event: RetryEvent) => void;
}

/** Safe default for reads (GET, and QBO queries): 429, 5xx and transient network errors. */
export const classifyRead: Classify = (err) => {
  if (err instanceof NetworkError) return err.transient ? 'retry' : 'stop';
  if (err instanceof HttpError && (err.status === 429 || err.status >= 500)) return 'retry';
  return 'stop';
};

/**
 * For non-idempotent writes: only a 429 is retried, because QBO rejects it before processing.
 * A 5xx or a network error is surfaced so the caller can find out whether the write landed.
 */
export const classifyWrite: Classify = (err) => (err instanceof HttpError && err.status === 429 ? 'retry' : 'stop');

/**
 * Equal jitter: half of the exponential delay is fixed, the other half random. Waits always grow,
 * while concurrent callers do not retry in lockstep.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exp = policy.baseDelayMs * policy.factor ** (attempt - 1);
  return Math.round(exp / 2 + random() * (exp / 2));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= policy.maxAttempts || options.classify(err) === 'stop') throw err;
      const retryAfter = err instanceof HttpError ? err.retryAfterMs : null;
      if (retryAfter !== null && retryAfter > policy.maxRetryAfterMs) throw err;
      const delayMs = Math.max(backoffDelay(attempt, policy, random), retryAfter ?? 0);
      options.onRetry?.({ attempt, delayMs, error: err });
      await clock.sleep(delayMs);
    }
  }
}
