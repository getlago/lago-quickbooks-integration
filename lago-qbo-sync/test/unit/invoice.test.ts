import { describe, expect, it } from 'vitest';
import type { SalesItemLine } from '../../src/qbo/types.js';
import { isEmptyInvoice, isOutOfScopeInvoice, toQboInvoice } from '../../src/transform/invoice.js';
import { invoiceFixture, qboTotalCents, testMappings } from '../helpers.js';

const withTax = testMappings({ taxCodeId: '7' });
const noTax = testMappings();

function transform(name: string, mappings = withTax) {
  const inv = invoiceFixture(name);
  const r = toQboInvoice(inv, mappings);
  if (!r.ok) throw new Error(r.reason);
  return { inv, ...r.value };
}

describe('toQboInvoice — coupon + tax', () => {
  it('produces the n8n payload: gross fee lines, one positive discount line, Lago tax override', () => {
    const { payload, customerDisplayName, taxOverride } = transform('invoice-coupon-tax');
    expect(customerDisplayName).toBe('Acme Robotics');
    expect(taxOverride).toBe(true);
    expect(payload).toEqual({
      DocNumber: 'ACME-202610-001',
      TxnDate: '2026-10-20',
      DueDate: '2026-11-19',
      CurrencyRef: { value: 'USD' },
      Line: [
        {
          LineNum: 1,
          Amount: 100,
          DetailType: 'SalesItemLineDetail',
          Description: 'Startup plan',
          SalesItemLineDetail: { Qty: 1, UnitPrice: 100, ItemRef: { value: '10' }, TaxCodeRef: { value: 'TAX' } },
        },
        {
          LineNum: 2,
          Amount: 50,
          DetailType: 'SalesItemLineDetail',
          Description: 'API calls',
          SalesItemLineDetail: { Qty: 2500, UnitPrice: 0.02, ItemRef: { value: '20' }, TaxCodeRef: { value: 'TAX' } },
        },
        {
          LineNum: 3,
          Amount: 15,
          DetailType: 'DiscountLineDetail',
          Description: 'Discounts (Coupons and Usage Credits)',
          DiscountLineDetail: { PercentBased: false, DiscountAccountRef: { value: '1' } },
        },
      ],
      PrivateNote: 'Lago Invoice: inv-0000-0000-0000-000000000001',
      CustomerMemo: { value: 'Invoice ACME-202610-001' },
      TxnTaxDetail: { TxnTaxCodeRef: { value: '7' }, TotalTax: 27 },
      BillEmail: { Address: 'billing@acme.example' },
    });
    expect(payload.CustomerRef).toBeUndefined(); // set by sync after the customer pass
  });

  it('matches Lago to the cent: QBO TotalAmt = total_amount_cents / 100, tax = taxes_amount_cents / 100', () => {
    const { inv, payload } = transform('invoice-coupon-tax');
    expect(qboTotalCents(payload)).toBe(inv.total_amount_cents);
    expect(payload.TxnTaxDetail?.TotalTax).toBe((inv.taxes_amount_cents ?? 0) / 100);
  });

  it('without a tax code: no TxnTaxDetail, lines still TAX, pre-tax amount still checked', () => {
    const { inv, payload, taxOverride } = transform('invoice-coupon-tax', noTax);
    expect(payload.TxnTaxDetail).toBeUndefined();
    expect(taxOverride).toBe(false);
    expect((payload.Line[0] as SalesItemLine).SalesItemLineDetail.TaxCodeRef.value).toBe('TAX');
    expect(qboTotalCents(payload)).toBe(inv.total_amount_cents - (inv.taxes_amount_cents ?? 0));
  });
});

describe('toQboInvoice — credits', () => {
  it('progressive billing credits (before taxes) become the discount line', () => {
    const { inv, payload } = transform('invoice-progressive-billing');
    expect(payload.Line).toHaveLength(2);
    expect(payload.Line[1]).toMatchObject({ DetailType: 'DiscountLineDetail', Amount: 80 });
    expect(payload.Line[0]).toMatchObject({
      Amount: 200,
      Description: 'Compute (hours)',
      SalesItemLineDetail: { Qty: 1000, UnitPrice: 0.2, TaxCodeRef: { value: 'NON' } },
    });
    expect(payload.TxnTaxDetail).toBeUndefined();
    expect(qboTotalCents(payload)).toBe(inv.total_amount_cents);
  });

  it('applied credit notes and prepaid credits become negative NON lines on the default item', () => {
    const { inv, payload } = transform('invoice-prepaid-and-credit-note');
    expect(payload.Line.slice(1)).toEqual([
      {
        LineNum: 2,
        Amount: -20,
        DetailType: 'SalesItemLineDetail',
        Description: 'Credit note credits',
        SalesItemLineDetail: { Qty: 1, UnitPrice: -20, ItemRef: { value: '1' }, TaxCodeRef: { value: 'NON' } },
      },
      {
        LineNum: 3,
        Amount: -30,
        DetailType: 'SalesItemLineDetail',
        Description: 'Prepaid credits',
        SalesItemLineDetail: { Qty: 1, UnitPrice: -30, ItemRef: { value: '1' }, TaxCodeRef: { value: 'NON' } },
      },
    ]);
    expect(payload.TxnTaxDetail).toEqual({ TxnTaxCodeRef: { value: '7' }, TotalTax: 10 });
    expect(qboTotalCents(payload)).toBe(inv.total_amount_cents);
    expect(payload.Line[0]).toMatchObject({ Description: 'Premium', SalesItemLineDetail: { ItemRef: { value: '1' } } });
  });
});

describe('toQboInvoice — multi-unit rounding (PLAN.md §4.4)', () => {
  it('keeps every line equal to the Lago fee; uneven splits become Qty 1 with units in the description', () => {
    const { inv, payload } = transform('invoice-multi-unit-rounding');
    const [uneven, even, half] = payload.Line as SalesItemLine[];
    expect(uneven).toMatchObject({
      Amount: 10,
      Description: 'Seats (3.0 units at 3.3333333333 each)',
      SalesItemLineDetail: { Qty: 1, UnitPrice: 10, ItemRef: { value: '30' } },
    });
    expect(even).toMatchObject({ Amount: 9.99, Description: 'Seats (prorated)', SalesItemLineDetail: { Qty: 3, UnitPrice: 3.33 } });
    expect(half).toMatchObject({ Amount: 10.01, SalesItemLineDetail: { Qty: 0.5, UnitPrice: 20.02, ItemRef: { value: '1' } } });
    expect(qboTotalCents(payload)).toBe(inv.total_amount_cents); // qboTotalCents also checks Amount = Qty × UnitPrice
  });

  it('keeps the units note when a long description is truncated to 4000 characters', () => {
    const inv = invoiceFixture('invoice-multi-unit-rounding');
    inv.fees![0]!.item!.name = 'D'.repeat(5000);
    const r = toQboInvoice(inv, withTax);
    const line = r.ok ? (r.value.payload.Line[0] as SalesItemLine) : undefined;
    expect(line?.Description).toHaveLength(4000);
    expect(line?.Description.endsWith(' (3.0 units at 3.3333333333 each)')).toBe(true);
  });
});

describe('toQboInvoice — missing optional fields', () => {
  it("falls back to 'Fee', the default item, no DueDate, no BillEmail, external_id as customer", () => {
    const { inv, payload, customerDisplayName } = transform('invoice-missing-optional');
    expect(customerDisplayName).toBe('cust_ext_003');
    expect(payload).not.toHaveProperty('DueDate');
    expect(payload).not.toHaveProperty('BillEmail');
    expect(payload).not.toHaveProperty('TxnTaxDetail');
    expect(payload.Line).toEqual([
      {
        LineNum: 1,
        Amount: 42,
        DetailType: 'SalesItemLineDetail',
        Description: 'Fee',
        SalesItemLineDetail: { Qty: 1, UnitPrice: 42, ItemRef: { value: '40' }, TaxCodeRef: { value: 'NON' } },
      },
    ]);
    expect(qboTotalCents(payload)).toBe(inv.total_amount_cents);
  });

  it('passes [ in numbers and apostrophes in names through unchanged (guards live in reconcile/query)', () => {
    const { payload, customerDisplayName } = transform('invoice-bracket-number');
    expect(payload.DocNumber).toBe('[AC]-202610-006');
    expect(customerDisplayName).toBe("O'Neil Analytics");
  });
});

describe('toQboInvoice — amount invariant', () => {
  it('fails the document instead of posting a total that differs from Lago', () => {
    const inv = invoiceFixture('invoice-coupon-tax');
    inv.total_amount_cents = 16201;
    expect(toQboInvoice(inv, withTax)).toEqual({
      ok: false,
      reason:
        'Invoice ACME-202610-001: amount check failed, QBO lines + tax would be 162.00 but Lago expects 162.01; nothing was sent',
    });
  });

  it('catches a credit that Lago did not apply to the total', () => {
    const inv = invoiceFixture('invoice-prepaid-and-credit-note');
    inv.prepaid_credit_amount_cents = 0; // the total still includes the 30.00 prepaid deduction
    const r = toQboInvoice(inv, withTax);
    expect(r.ok).toBe(false);
  });
});

describe('isEmptyInvoice (decided 2026-11-11: skip and report)', () => {
  it('is true only for total 0 with no fees, no credits and no prepaid credits', () => {
    expect(isEmptyInvoice(invoiceFixture('invoice-empty'))).toBe(true);
    const base = invoiceFixture('invoice-empty');
    expect(isEmptyInvoice({ ...base, fees: undefined, credits: undefined })).toBe(true);
    // $0 invoices that carry lines are real documents and are synced.
    const zeroFee = invoiceFixture('invoice-missing-optional');
    zeroFee.fees![0]!.amount_cents = 0;
    zeroFee.total_amount_cents = 0;
    expect(isEmptyInvoice(zeroFee)).toBe(false);
    expect(isEmptyInvoice({ ...base, credits: [{ amount_cents: 0, before_taxes: true }] })).toBe(false);
    expect(isEmptyInvoice({ ...base, prepaid_credit_amount_cents: 500 })).toBe(false);
    expect(isEmptyInvoice({ ...base, total_amount_cents: 1 })).toBe(false);
  });

  it('would otherwise produce the Line: [] that QBO rejects', () => {
    const r = toQboInvoice(invoiceFixture('invoice-empty'), withTax);
    expect(r.ok && r.value.payload.Line).toEqual([]);
  });
});

describe('isOutOfScopeInvoice', () => {
  it('skips wallet top-up invoices only', () => {
    expect(isOutOfScopeInvoice(invoiceFixture('invoice-wallet-topup'))).toBe(true);
    for (const t of ['subscription', 'add_on', 'one_off', 'advance_charges', 'progressive_billing']) {
      expect(isOutOfScopeInvoice({ invoice_type: t })).toBe(false);
    }
  });
});
