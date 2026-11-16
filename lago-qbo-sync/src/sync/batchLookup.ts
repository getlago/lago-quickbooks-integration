import type { Lookup } from '../reconcile/index.js';

/**
 * Turns the rows of one batched `<field> IN (…)` query into a per-value Lookup, for the values the
 * batch can answer with certainty (PLAN.md §9, option A). Used for invoice/credit memo DocNumbers,
 * customer DisplayNames, and the reconciliation pass.
 *
 * A requested value is answered only when the batch is unambiguous for it:
 *  - rows whose field equals it exactly → "found" (one or more rows, duplicates preserved);
 *  - no row resembles it at all → "none".
 * If QBO returned a row whose field matches a requested value only when case is ignored, that value
 * is left out of the result, so the caller falls back to the single `=` lookup. A failed batch is
 * never turned into "none" (brief §6 bug #5): callers do not call this function when the query throws.
 */
export function groupBatchLookup<Row>(
  requested: readonly string[],
  rows: readonly Row[],
  keyOf: (row: Row) => string | undefined,
): Map<string, Lookup<Row>> {
  const exact = new Map<string, Row[]>();
  const looselyMatched = new Set<string>();
  const byUpper = new Map(requested.map((n) => [n.toUpperCase(), n] as const));
  const wanted = new Set(requested);

  for (const row of rows) {
    const value = String(keyOf(row) ?? '');
    if (wanted.has(value)) {
      exact.set(value, [...(exact.get(value) ?? []), row]);
    } else {
      const similar = byUpper.get(value.toUpperCase());
      if (similar !== undefined) looselyMatched.add(similar);
    }
  }

  const out = new Map<string, Lookup<Row>>();
  for (const n of requested) {
    if (looselyMatched.has(n)) continue; // ambiguous: single lookup decides
    const found = exact.get(n);
    out.set(n, found ? { kind: 'found', rows: found } : { kind: 'none' });
  }
  return out;
}

/** Splits a list into chunks of at most `size` (QBO `IN` takes 50 values here). */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
