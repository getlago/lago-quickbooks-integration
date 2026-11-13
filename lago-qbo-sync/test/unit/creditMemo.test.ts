import { describe, expect, it } from 'vitest';
import { toQboCreditMemo } from '../../src/transform/creditMemo.js';
import { creditNoteFixture, qboTotalCents, testMappings } from '../helpers.js';

const withTax = testMappings({ taxCodeId: '7' });
const noTax = testMappings();

describe('toQboCreditMemo (n8n "Transform Credit Note" + "Map CN Items to QB")', () => {
  it('maps items, tax codes from fee.taxes_rate, and the Lago tax override', () => {
    const cn = creditNoteFixture('credit-note-basic');
    const r = toQboCreditMemo(cn, withTax);
    expect(r).toEqual({
      ok: true,
      value: {
        customerDisplayName: 'Acme Robotics',
        taxOverride: true,
        payload: {
          DocNumber: 'ACME-202610-001-CN001',
          TxnDate: '2026-10-23',
          CurrencyRef: { value: 'USD' },
          Line: [
            {
              LineNum: 1,
              Amount: 50,
              DetailType: 'SalesItemLineDetail',
              Description: 'Startup plan',
              SalesItemLineDetail: { Qty: 1, UnitPrice: 50, ItemRef: { value: '10' }, TaxCodeRef: { value: 'TAX' } },
            },
            {
              LineNum: 2,
              Amount: 20,
              DetailType: 'SalesItemLineDetail',
              Description: 'Onboarding',
              SalesItemLineDetail: { Qty: 1, UnitPrice: 20, ItemRef: { value: '40' }, TaxCodeRef: { value: 'NON' } },
            },
          ],
          PrivateNote: 'Lago Credit Note: cn-0000-0000-0000-000000000001',
          CustomerMemo: { value: 'Credit Note ACME-202610-001-CN001' },
          TxnTaxDetail: { TxnTaxCodeRef: { value: '7' }, TotalTax: 10 },
          BillEmail: { Address: 'billing@acme.example' },
        },
      },
    });
    if (r.ok) expect(qboTotalCents(r.value.payload)).toBe(cn.total_amount_cents);
  });

  it('without a tax code, checks the pre-tax amount only', () => {
    const cn = creditNoteFixture('credit-note-basic');
    const r = toQboCreditMemo(cn, noTax);
    expect(r.ok && r.value.payload.TxnTaxDetail).toBeUndefined();
    if (r.ok) expect(qboTotalCents(r.value.payload)).toBe(cn.total_amount_cents - (cn.taxes_amount_cents ?? 0));
  });

  it('fails a credit note whose coupon share the mapping cannot post (PLAN.md Q4 (b))', () => {
    const r = toQboCreditMemo(creditNoteFixture('credit-note-coupon-adjustment'), withTax);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('QBO lines + tax would be 106.20 but Lago expects 97.20');
      expect(r.reason).toContain('coupon adjustment of 9.00');
      expect(r.reason).toContain('PLAN.md Q4');
    }
  });

  it('accepts a credit note with a coupon share when the items are already net of it', () => {
    const cn = creditNoteFixture('credit-note-coupon-adjustment');
    cn.items![0]!.amount_cents = 8100;
    const r = toQboCreditMemo(cn, withTax);
    expect(r.ok).toBe(true);
    if (r.ok) expect(qboTotalCents(r.value.payload)).toBe(9720);
  });

  it('uses the n8n single-line fallback when there are no items', () => {
    const r = toQboCreditMemo(creditNoteFixture('credit-note-no-items'), withTax);
    expect(r.ok && r.value.payload.Line).toEqual([
      {
        LineNum: 1,
        Amount: 12,
        DetailType: 'SalesItemLineDetail',
        Description: 'Credit Note: Adjustment',
        SalesItemLineDetail: { Qty: 1, UnitPrice: 12, ItemRef: { value: '1' }, TaxCodeRef: { value: 'NON' } },
      },
    ]);
    expect(r.ok && r.value.customerDisplayName).toBe('cust_ext_003');
  });

  it('fails the no-items fallback when it would count the tax twice', () => {
    const cn = creditNoteFixture('credit-note-no-items');
    cn.taxes_amount_cents = 200;
    expect(toQboCreditMemo(cn, withTax).ok).toBe(false);
  });

  it('builds the payload for a 26-character number (the length guard runs in sync, before any QBO call)', () => {
    const r = toQboCreditMemo(creditNoteFixture('credit-note-long-number'), withTax);
    expect(r.ok && r.value.payload.DocNumber).toBe('LAGO-DEMO-202610-004-CN001');
  });
});
