import type { Mappings } from '../config/schema.js';
import type { LagoCreditNote } from '../lago/types.js';
import type { QboCreditMemoPayload, QboLine } from '../qbo/types.js';
import { cleanObject } from './clean.js';
import { customerDisplayName } from './customer.js';
import { checkTotal, description, itemRef, lineTaxCode, txnTaxDetail } from './lines.js';
import { assertCents, formatCents, toDollars } from './money.js';
import { fail, ok, type TransformResult } from './result.js';

export interface CreditMemoTransform {
  payload: QboCreditMemoPayload;
  customerDisplayName: string;
  taxOverride: boolean;
}

/**
 * Port of n8n "Transform Credit Note" + "Map CN Items to QB" (MAPPING.md "Credit Note Mapping").
 * CustomerRef is set later by sync (n8n "Finalize Credit Note").
 */
export function toQboCreditMemo(cn: LagoCreditNote, mappings: Mappings): TransformResult<CreditMemoTransform> {
  const label = `Credit note ${cn.number}`;
  const displayName = customerDisplayName(cn.customer);
  if (!displayName) return fail(`${label}: Lago customer has no name, legal_name or external_id`);

  const taxCents = assertCents(cn.taxes_amount_cents ?? 0, 'taxes_amount_cents');
  const lines: QboLine[] = [];
  let netCents = 0;

  // MAPPING.md "Credit Note Mapping › Line Items": Qty 1, UnitPrice = Amount.
  for (const item of cn.items ?? []) {
    const cents = assertCents(item.amount_cents, 'credit note item amount_cents');
    const text = item.fee?.item?.invoice_display_name || item.fee?.item?.name || 'Credit Note Item';
    lines.push({
      LineNum: lines.length + 1,
      Amount: toDollars(cents),
      DetailType: 'SalesItemLineDetail',
      Description: description(text),
      SalesItemLineDetail: {
        Qty: 1,
        UnitPrice: toDollars(cents),
        ItemRef: itemRef(item.fee?.item?.code, mappings),
        // MAPPING.md: TAX if fee.taxes_rate > 0 (n8n credit note node; the invoice node uses taxes_amount_cents).
        TaxCodeRef: lineTaxCode((item.fee?.taxes_rate ?? 0) > 0),
      },
    });
    netCents += cents;
  }

  // n8n fallback when the credit note has no items: one NON line for the whole total.
  if (lines.length === 0) {
    const total = assertCents(cn.total_amount_cents, 'total_amount_cents');
    lines.push({
      LineNum: 1,
      Amount: toDollars(total),
      DetailType: 'SalesItemLineDetail',
      Description: `Credit Note: ${cn.reason || 'Adjustment'}`,
      SalesItemLineDetail: {
        Qty: 1,
        UnitPrice: toDollars(total),
        ItemRef: { value: mappings.qbo.default_item_id },
        TaxCodeRef: lineTaxCode(false),
      },
    });
    netCents += total;
  }

  const taxDetail = txnTaxDetail(taxCents, mappings);
  const mismatch = checkTotal({
    label,
    linesNetCents: netCents,
    lagoTotalCents: cn.total_amount_cents,
    lagoTaxCents: taxCents,
    taxOverride: taxDetail !== undefined,
  });
  if (mismatch) {
    // PLAN.md F9 / Q4 (b): the n8n mapping has no line for the coupon share of a credit note.
    const coupon = cn.coupons_adjustment_amount_cents ?? 0;
    return fail(
      coupon > 0
        ? `${mismatch}. The credit note carries a coupon adjustment of ${formatCents(coupon)} that the ` +
            'current mapping does not post; waiting for the bookkeeper to decide how to book it (PLAN.md Q4)'
        : mismatch,
    );
  }

  const payload = cleanObject<QboCreditMemoPayload>({
    DocNumber: cn.number,
    TxnDate: cn.issuing_date,
    CurrencyRef: { value: cn.currency },
    Line: lines,
    PrivateNote: `Lago Credit Note: ${cn.lago_id}`,
    CustomerMemo: { value: `Credit Note ${cn.number}` },
    TxnTaxDetail: taxDetail,
    BillEmail: cn.customer.email ? { Address: cn.customer.email } : undefined,
  });

  return ok({ payload, customerDisplayName: displayName, taxOverride: taxDetail !== undefined || taxCents === 0 });
}
