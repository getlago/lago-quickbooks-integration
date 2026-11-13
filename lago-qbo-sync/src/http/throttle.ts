import { systemClock, type Clock } from './clock.js';

/**
 * One queue per remote service, through which every request start passes (brief §5.4).
 *
 * Limits enforced by design (brief §3, QBO: 500 req/min, 10 req/s, 10 concurrent per realm):
 *  - spacing: request starts are at least 1000 / ratePerSecond ms apart, so there is no burst
 *    above the rate within any second;
 *  - a sliding 60 s window caps starts per minute (450 for QBO, under the 500 limit);
 *  - at most `maxConcurrent` requests are in flight;
 *  - `pauseFor` holds every start, e.g. after a 429, so concurrent callers back off together.
 * Requests start in FIFO order.
 */
export interface ThrottleOptions {
  ratePerSecond: number;
  maxConcurrent: number;
  maxPerMinute?: number;
  clock?: Clock;
}

export interface Throttle {
  run<T>(fn: () => Promise<T>): Promise<T>;
  pauseFor(ms: number): void;
  /** Number of requests started so far (for the run summary's call count). */
  readonly started: number;
}

const MINUTE_MS = 60_000;

export function createThrottle(options: ThrottleOptions): Throttle {
  if (!(options.ratePerSecond > 0)) throw new Error('ratePerSecond must be > 0');
  if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
  const clock = options.clock ?? systemClock;
  const spacingMs = 1000 / options.ratePerSecond;
  const maxPerMinute = options.maxPerMinute ?? Number.POSITIVE_INFINITY;

  const waiting: Array<() => void> = [];
  const recentStarts: number[] = [];
  let active = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  let notBefore = Number.NEGATIVE_INFINITY;
  let started = 0;
  let pumping = false;

  const delayUntilNextStart = (now: number): number => {
    while (recentStarts.length > 0 && recentStarts[0]! <= now - MINUTE_MS) recentStarts.shift();
    let wait = Math.max(0, lastStart + spacingMs - now, notBefore - now);
    if (recentStarts.length >= maxPerMinute) wait = Math.max(wait, recentStarts[0]! + MINUTE_MS - now);
    return wait;
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length > 0 && active < options.maxConcurrent) {
        const wait = delayUntilNextStart(clock.now());
        if (wait > 0) {
          await clock.sleep(wait);
          continue;
        }
        const now = clock.now();
        lastStart = now;
        recentStarts.push(now);
        active++;
        started++;
        waiting.shift()!();
      }
    } finally {
      pumping = false;
    }
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        void pump();
      });
      try {
        return await fn();
      } finally {
        active--;
        void pump();
      }
    },
    pauseFor(ms: number) {
      notBefore = Math.max(notBefore, clock.now() + ms);
    },
    get started() {
      return started;
    },
  };
}
