import type { Mappings } from '../config/schema.js';
import type { LagoFee } from '../lago/types.js';
import type { LineTaxCode, Ref, TxnTaxDetail } from '../qbo/types.js';
import { formatCents, toDollars } from './money.js';

/** QBO Description limit (MAPPING.md "String Transformations › Truncation"). */
export const DESCRIPTION_MAX = 4000;

/**
 * MAPPING.md "Item Code Mapping": item.code → configured QBO Item Id, else the fallback item.
 * n8n had two fallbacks (QB_DEFAULT_ITEM_ID for lines without a code, ITEM_FALLBACK_ID for
 * unmapped codes); mappings.yaml has one, `qbo.default_item_id`, used for both (PLAN.md §5).
 * `ItemRef.name: 'Services'` from n8n is not sent: it was hard-coded whatever the real item was.
 */
export function itemRef(code: string | null | undefined, mappings: Mappings): Ref {
  const mapped = code ? mappings.items[code] : undefined;
  return { value: mapped ?? mappings.qbo.default_item_id };
}

/** Truncates a description to the QBO limit, keeping `suffix` whole. */
export function description(base: string, suffix = ''): string {
  return base.substring(0, DESCRIPTION_MAX - suffix.length) + suffix;
}

export function lineTaxCode(hasTax: boolean): { value: LineTaxCode } {
  return { value: hasTax ? 'TAX' : 'NON' };
}

/**
 * MAPPING.md "Tax Details (TxnTaxDetail)": only when there is tax and a tax code is configured.
 * The QBO client sends `minorversion` (75, PLAN.md Q2) on every call.
 */
export function txnTaxDetail(taxCents: number, mappings: Mappings): TxnTaxDetail | undefined {
  if (taxCents > 0 && mappings.qbo.tax_code_id) {
    return { TxnTaxCodeRef: { value: mappings.qbo.tax_code_id }, TotalTax: toDollars(taxCents) };
  }
  return undefined;
}

/** Fee description priority, MAPPING.md "Line Items - Fees" (n8n adds the final 'Fee'). */
export function feeDescription(fee: LagoFee): string {
  return fee.item?.invoice_display_name || fee.item?.name || fee.description || 'Fee';
}

/**
 * Amount invariant (PLAN.md §1): what QBO will compute as TotalAmt must equal Lago's total to
 * the cent, checked before anything is sent.
 *
 * With a tax override, QBO's total is lines + TotalTax, so it must equal Lago's total.
 * Without one (no tax code, or no tax), QBO computes its own tax, so only the pre-tax part can be
 * checked: lines must equal Lago's total minus Lago's tax.
 */
export function checkTotal(args: {
  label: string;
  linesNetCents: number;
  lagoTotalCents: number;
  lagoTaxCents: number;
  taxOverride: boolean;
}): string | null {
  const expected = args.taxOverride ? args.lagoTotalCents : args.lagoTotalCents - args.lagoTaxCents;
  const actual = args.taxOverride ? args.linesNetCents + args.lagoTaxCents : args.linesNetCents;
  if (actual === expected) return null;
  const what = args.taxOverride ? 'lines + tax' : 'lines (before tax)';
  return (
    `${args.label}: amount check failed, QBO ${what} would be ${formatCents(actual)} ` +
    `but Lago expects ${formatCents(expected)}; nothing was sent`
  );
}
