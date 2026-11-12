import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../src/http/clock.js';
import { createThrottle } from '../../src/http/throttle.js';

// systemClock uses Date.now and setTimeout, which vitest fakes: these tests run in virtual time.
beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe('createThrottle', () => {
  it('spaces request starts at 1000 / rate ms (default 5 req/s → 200 ms)', async () => {
    const t = createThrottle({ ratePerSecond: 5, maxConcurrent: 1 });
    const starts: number[] = [];
    await settle(Promise.all(Array.from({ length: 5 }, () => t.run(async () => starts.push(Date.now())))));
    expect(starts).toEqual([0, 200, 400, 600, 800]);
    expect(t.started).toBe(5);
  });

  it('never runs more than maxConcurrent at once', async () => {
    const t = createThrottle({ ratePerSecond: 100, maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const starts: number[] = [];
    const task = () =>
      t.run(async () => {
        starts.push(Date.now());
        peak = Math.max(peak, ++active);
        await systemClock.sleep(1000);
        active--;
      });
    await settle(Promise.all([task(), task(), task(), task()]));
    expect(peak).toBe(2);
    expect(starts).toEqual([0, 10, 1000, 1010]);
  });

  it('caps starts in any sliding 60 s window', async () => {
    const t = createThrottle({ ratePerSecond: 10, maxConcurrent: 1, maxPerMinute: 3 });
    const starts: number[] = [];
    await settle(Promise.all(Array.from({ length: 4 }, () => t.run(async () => starts.push(Date.now())))));
    expect(starts).toEqual([0, 100, 200, 60_000]);
  });

  it('stays within QBO limits by design: ≤ 8/s, ≤ 450/min at the maximum allowed config', async () => {
    const t = createThrottle({ ratePerSecond: 8, maxConcurrent: 10, maxPerMinute: 450 });
    const starts: number[] = [];
    await settle(Promise.all(Array.from({ length: 1000 }, () => t.run(async () => starts.push(Date.now())))));
    const maxInWindow = (windowMs: number) => {
      let max = 0;
      for (let i = 0, j = 0; i < starts.length; i++) {
        while (starts[i]! - starts[j]! >= windowMs) j++;
        max = Math.max(max, i - j + 1);
      }
      return max;
    };
    expect(maxInWindow(1000)).toBeLessThanOrEqual(8);
    expect(maxInWindow(60_000)).toBeLessThanOrEqual(450);
  });

  it('pauseFor holds every start (used after a 429)', async () => {
    const t = createThrottle({ ratePerSecond: 5, maxConcurrent: 1 });
    t.pauseFor(5000);
    const starts: number[] = [];
    await settle(Promise.all([t.run(async () => starts.push(Date.now())), t.run(async () => starts.push(Date.now()))]));
    expect(starts).toEqual([5000, 5200]);
  });

  it('starts in FIFO order and releases the slot when a task throws', async () => {
    const t = createThrottle({ ratePerSecond: 100, maxConcurrent: 1 });
    const order: string[] = [];
    const failing = t.run(async () => {
      order.push('a');
      throw new Error('boom');
    });
    const failingAssertion = expect(failing).rejects.toThrow('boom'); // attach before timers run
    const ok = t.run(async () => {
      order.push('b');
      return 'done';
    });
    await vi.runAllTimersAsync();
    await failingAssertion;
    await expect(ok).resolves.toBe('done');
    expect(order).toEqual(['a', 'b']);
  });

  it('rejects invalid settings', () => {
    expect(() => createThrottle({ ratePerSecond: 0, maxConcurrent: 1 })).toThrow();
    expect(() => createThrottle({ ratePerSecond: 1, maxConcurrent: 0 })).toThrow();
  });
});
