/**
 * Processes items with at most `limit` in flight. With the default `max_concurrent: 1` this is a
 * plain sequential loop. Request rate is still enforced by the shared throttle; this only allows
 * independent documents to overlap their network latency.
 */
export async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** YYYY-MM-DD of `now` minus `days`, in UTC (Lago `issuing_date_from` is inclusive). */
export function windowStart(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}
