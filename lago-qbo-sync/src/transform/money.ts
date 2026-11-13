/**
 * The only place where Lago integer cents become QBO dollar amounts (brief §4.2: "Nothing else
 * touches money"). All arithmetic before this point is done on integer cents or BigInt.
 */

export function assertCents(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer number of cents, got ${value}`);
  return value;
}

/** MAPPING.md "Data Transformations › Cents to Dollars": `Number((cents / 100).toFixed(2))`. Exact for integer cents. */
export function toDollars(cents: number): number {
  assertCents(cents, 'amount');
  return Number((cents / 100).toFixed(2));
}

/** Formats cents for human-readable messages, e.g. 123456 → "1234.56". */
export function formatCents(cents: number): string {
  return toDollars(cents).toFixed(2);
}

/** A non-negative decimal as an exact rational `num / 10^scale`. */
interface Decimal {
  num: bigint;
  scale: number;
  text: string;
}

function parseUnits(raw: string | number | null | undefined): Decimal | null {
  const text = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : '') : (raw ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const num = BigInt(match[1]! + fraction);
  if (num === 0n) return null;
  return { num, scale: fraction.length, text };
}

export interface FeeQuantity {
  /** QBO SalesItemLineDetail.Qty */
  qty: number;
  /** QBO SalesItemLineDetail.UnitPrice, in cents (exact). */
  unitPriceCents: number;
  /**
   * true  → Qty × UnitPrice equals the gross amount exactly (n8n behavior kept).
   * false → the amount does not divide evenly by the units at cent precision, so the line is sent
   *         as Qty 1 × gross (PLAN.md §4.4, approved Q3) and the caller adds the units to the Description.
   */
  exact: boolean;
  /** Units as Lago sent them, for the Description note. */
  unitsText: string;
}

/**
 * MAPPING.md "Line Items - Fees": Qty = units (default 1), UnitPrice = amount / units, and QBO
 * requires Amount = Qty × UnitPrice. The n8n node rounded UnitPrice to 2 decimals and then set
 * Amount = round2(UnitPrice × Qty), which silently changed the line amount (PLAN.md F8).
 *
 * Here the quantity is kept only when gross / units is an exact number of cents; then
 * Qty × UnitPrice == gross with no rounding at all. Otherwise Qty 1 × gross is used, so the line
 * amount always equals Lago's fee amount to the cent.
 */
export function feeQuantity(grossCents: number, units: string | number | null | undefined): FeeQuantity {
  assertCents(grossCents, 'fee amount_cents');
  const parsed = parseUnits(units);
  // n8n: `parseFloat(fee.units) || 1`. Zero, missing or unparseable units become 1.
  if (!parsed) return { qty: 1, unitPriceCents: grossCents, exact: true, unitsText: '1' };

  const scaled = BigInt(grossCents) * 10n ** BigInt(parsed.scale);
  if (scaled % parsed.num === 0n) {
    const unitPriceCents = Number(scaled / parsed.num);
    return { qty: Number(parsed.text), unitPriceCents, exact: true, unitsText: parsed.text };
  }
  return { qty: 1, unitPriceCents: grossCents, exact: false, unitsText: parsed.text };
}
