import type { LagoInvoice } from '../lago/types.js';
import type { QboPaymentPayload, QboTxnRow } from '../qbo/types.js';
import { assertCents, toDollars } from './money.js';
import { fail, ok, type TransformResult } from './result.js';

/** n8n "Extract Payment Info": the Lago fields the payment pass needs. */
export type LagoPaidInvoice = Pick<LagoInvoice, 'lago_id' | 'number' | 'currency' | 'total_amount_cents' | 'payment_status'>;

/**
 * Port of n8n "Create Payment Object" (MAPPING.md "Payment Mapping"): a Payment for the Lago total,
 * linked to the QBO invoice found by DocNumber. Whether to create it at all (balance checks,
 * defer when the invoice is missing) is decided by reconcile, not here.
 *
 * PrivateNote adds the Lago invoice id to the n8n text (PLAN.md Q10).
 */
export function toQboPayment(inv: LagoPaidInvoice, qboInvoice: QboTxnRow): TransformResult<QboPaymentPayload> {
  const customerId = qboInvoice.CustomerRef?.value;
  if (!customerId) return fail(`Invoice ${inv.number}: QBO invoice ${qboInvoice.Id} has no CustomerRef`);
  const amount = toDollars(assertCents(inv.total_amount_cents, 'total_amount_cents'));
  return ok({
    CustomerRef: { value: customerId },
    TotalAmt: amount,
    CurrencyRef: { value: inv.currency },
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: qboInvoice.Id, TxnType: 'Invoice' }] }],
    PrivateNote: `Payment for Lago Invoice: ${inv.number}\nLago Invoice ID: ${inv.lago_id}`,
  });
}
