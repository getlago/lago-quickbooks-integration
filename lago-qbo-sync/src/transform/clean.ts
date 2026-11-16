/**
 * Port of the n8n `cleanObject` helper (MAPPING.md "Object Cleanup"), as a non-mutating function.
 *
 * Removes undefined values and objects left empty. It also removes null and '' (the n8n nodes got
 * the same effect with `value || undefined` at each field; doing it here covers every field,
 * e.g. a null `payment_due_date`). Arrays are kept and their elements cleaned.
 */
export function cleanObject<T>(value: T): T {
  return cleanValue(value) as T;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !isEmpty(v)).map(cleanValue);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (isEmpty(v)) continue;
    const cleaned = cleanValue(v);
    if (cleaned !== null && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
      continue;
    }
    out[key] = cleaned;
  }
  return out;
}
