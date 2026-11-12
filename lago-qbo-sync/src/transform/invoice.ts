import type { Mappings } from '../config/schema.js';
import type { LagoInvoice } from '../lago/types.js';
import type { QboInvoicePayload, QboLine } from '../qbo/types.js';
import { cleanObject } from './clean.js';
import { customerDisplayName } from './customer.js';
import { checkTotal, description, feeDescription, itemRef, lineTaxCode, txnTaxDetail } from './lines.js';
import { assertCents, feeQuantity, toDollars } from './money.js';
import { fail, ok, type TransformResult } from './result.js';

export interface InvoiceTransform {
  payload: QboInvoicePayload;
  customerDisplayName: string;
  /** false when Lago charged tax but no tax code is configured: QBO will compute its own tax. */
  taxOverride: boolean;
}

/**
 * Wallet top-up invoices are out of scope (brief §11, PLAN.md Q6). n8n never received them via
 * `invoice.created`; they are counted as `skipped: out_of_scope`.
 */
export function isOutOfScopeInvoice(invoice: Pick<LagoInvoice, 'invoice_type'>): boolean {
  return invoice.invoice_type === 'credit';
}

/**
 * A finalized Lago invoice with nothing on it: total 0, no fees, no credits, no prepaid credits
 * (e.g. a billing period with no charges). The n8n mapping would send `Line: []`, which QBO rejects
 * (400, code 2020). There is nothing to book, so it is skipped and reported instead (PLAN.md §9,
 * decided 2026-11-11). A $0 invoice that has fee lines is not empty and is synced normally.
 */
export function isEmptyInvoice(
  inv: Pick<LagoInvoice, 'total_amount_cents' | 'fees' | 'credits' | 'prepaid_credit_amount_cents'>,
): boolean {
  return (
    inv.total_amount_cents === 0 &&
    (inv.fees ?? []).length === 0 &&
    (inv.credits ?? []).length === 0 &&
    (inv.prepaid_credit_amount_cents ?? 0) === 0
  );
}

export const EMPTY_INVOICE_REASON = 'empty invoice (total 0, no fees, no credits): nothing to book';

/**
 * Port of n8n "Transform Invoice" + "Map Lago Items to QB". CustomerRef is set later by sync
 * (n8n "Finalize Invoice") once the customer pass has resolved the QBO customer Id.
 */
export function toQboInvoice(inv: LagoInvoice, mappings: Mappings): TransformResult<InvoiceTransform> {
  const label = `Invoice ${inv.number}`;
  const displayName = customerDisplayName(inv.customer);
  if (!displayName) return fail(`${label}: Lago customer has no name, legal_name or external_id`);

  const taxCents = assertCents(inv.taxes_amount_cents ?? 0, 'taxes_amount_cents');
  const lines: QboLine[] = [];
  let lineNum = 1;
  let netCents = 0;

  // MAPPING.md "Line Items - Fees": every fee, even zero-amount ones, at its GROSS amount
  // (before coupons and progressive billing credits).
  for (const fee of inv.fees ?? []) {
    const grossCents = assertCents(fee.amount_cents ?? 0, 'fee amount_cents');
    const q = feeQuantity(grossCents, fee.units);
    // PLAN.md §4.4 (approved Q3): when the amount does not divide evenly by the units, send
    // Qty 1 × gross and keep the units visible in the description.
    const note = q.exact
      ? ''
      : fee.precise_unit_amount
        ? ` (${q.unitsText} units at ${fee.precise_unit_amount} each)`
        : ` (${q.unitsText} units)`;
    lines.push({
      LineNum: lineNum++,
      Amount: toDollars(grossCents),
      DetailType: 'SalesItemLineDetail',
      Description: description(feeDescription(fee), note),
      SalesItemLineDetail: {
        Qty: q.qty,
        UnitPrice: toDollars(q.unitPriceCents),
        ItemRef: itemRef(fee.item?.code, mappings),
        // MAPPING.md: TAX if the fee's taxes_amount_cents > 0 (n8n invoice node).
        TaxCodeRef: lineTaxCode((fee.taxes_amount_cents ?? 0) > 0),
      },
    });
    netCents += grossCents;
  }

  // MAPPING.md "Credit Categorization": before_taxes → one discount line; else after-tax lines.
  let beforeTaxCents = 0;
  const afterTaxCredits: number[] = [];
  for (const credit of inv.credits ?? []) {
    const amount = assertCents(credit.amount_cents, 'credit amount_cents');
    if (credit.before_taxes) beforeTaxCents += amount;
    else afterTaxCredits.push(amount);
  }

  // MAPPING.md "Line Items - Before-Tax Credits (DiscountLineDetail)": positive amount.
  if (beforeTaxCents > 0) {
    lines.push({
      LineNum: lineNum++,
      Amount: toDollars(beforeTaxCents),
      DetailType: 'DiscountLineDetail',
      Description: 'Discounts (Coupons and Usage Credits)',
      DiscountLineDetail: { PercentBased: false, DiscountAccountRef: { value: mappings.qbo.discount_account_id } },
    });
    netCents -= beforeTaxCents;
  }

  // MAPPING.md "Line Items - After-Tax Credits": negative lines on the default item, NON.
  const negativeLine = (cents: number, text: string): QboLine => ({
    LineNum: lineNum++,
    Amount: -toDollars(cents),
    DetailType: 'SalesItemLineDetail',
    Description: text,
    SalesItemLineDetail: {
      Qty: 1,
      UnitPrice: -toDollars(cents),
      ItemRef: { value: mappings.qbo.default_item_id },
      TaxCodeRef: lineTaxCode(false),
    },
  });
  for (const cents of afterTaxCredits) {
    lines.push(negativeLine(cents, 'Credit note credits'));
    netCents -= cents;
  }

  const prepaidCents = assertCents(inv.prepaid_credit_amount_cents ?? 0, 'prepaid_credit_amount_cents');
  if (prepaidCents > 0) {
    lines.push(negativeLine(prepaidCents, 'Prepaid credits'));
    netCents -= prepaidCents;
  }

  const taxDetail = txnTaxDetail(taxCents, mappings);
  const mismatch = checkTotal({
    label,
    linesNetCents: netCents,
    lagoTotalCents: inv.total_amount_cents,
    lagoTaxCents: taxCents,
    taxOverride: taxDetail !== undefined,
  });
  if (mismatch) return fail(mismatch);

  // MAPPING.md "Invoice Mapping › Header Fields".
  const payload = cleanObject<QboInvoicePayload>({
    DocNumber: inv.number,
    TxnDate: inv.issuing_date,
    DueDate: inv.payment_due_date ?? undefined,
    CurrencyRef: { value: inv.currency },
    Line: lines,
    PrivateNote: `Lago Invoice: ${inv.lago_id}`,
    CustomerMemo: { value: `Invoice ${inv.number}` },
    TxnTaxDetail: taxDetail,
    BillEmail: inv.customer.email ? { Address: inv.customer.email } : undefined,
  });

  return ok({ payload, customerDisplayName: displayName, taxOverride: taxDetail !== undefined || taxCents === 0 });
}
