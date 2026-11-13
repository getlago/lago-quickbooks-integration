import { describe, expect, it } from 'vitest';
import { cleanObject } from '../../src/transform/clean.js';
import { checkDocNumber } from '../../src/transform/docNumber.js';
import { feeQuantity, formatCents, toDollars } from '../../src/transform/money.js';
import { testMappings } from '../helpers.js';

describe('toDollars', () => {
  it('converts integer cents exactly (MAPPING.md "Cents to Dollars")', () => {
    expect(toDollars(123456)).toBe(1234.56);
    expect(toDollars(25000)).toBe(250);
    expect(toDollars(1005)).toBe(10.05);
    expect(toDollars(0)).toBe(0);
    expect(toDollars(-2000)).toBe(-20);
    expect(formatCents(1)).toBe('0.01');
  });

  it('refuses non-integer cents instead of rounding them silently', () => {
    expect(() => toDollars(10.5)).toThrow(/integer/);
    expect(() => toDollars(Number.NaN)).toThrow(/integer/);
  });
});

describe('feeQuantity (multi-unit fees, PLAN.md §4.4)', () => {
  it('keeps Qty when gross divides evenly into cents', () => {
    expect(feeQuantity(5000, '2500.0')).toEqual({ qty: 2500, unitPriceCents: 2, exact: true, unitsText: '2500.0' });
    expect(feeQuantity(999, '3')).toMatchObject({ qty: 3, unitPriceCents: 333, exact: true });
    expect(feeQuantity(1001, '0.5')).toMatchObject({ qty: 0.5, unitPriceCents: 2002, exact: true });
  });

  it('falls back to Qty 1 × gross when it does not (n8n would have sent 3 × 3.33 = 9.99)', () => {
    expect(feeQuantity(1000, '3.0')).toEqual({ qty: 1, unitPriceCents: 1000, exact: false, unitsText: '3.0' });
    expect(feeQuantity(12345, '1234.5678')).toMatchObject({ qty: 1, unitPriceCents: 12345, exact: false });
  });

  it('treats missing, zero or unparseable units as 1 (n8n `parseFloat(units) || 1`)', () => {
    for (const units of [undefined, null, '', '0', '0.0', 'abc', '-3', '1e3']) {
      expect(feeQuantity(4200, units)).toMatchObject({ qty: 1, unitPriceCents: 4200, exact: true });
    }
  });

  it('accepts numeric units as older payloads send them', () => {
    expect(feeQuantity(600, 3)).toMatchObject({ qty: 3, unitPriceCents: 200, exact: true });
  });
});

describe('cleanObject (port of n8n cleanObject)', () => {
  it('drops undefined, null, empty strings and objects left empty, keeps arrays, zero and false', () => {
    expect(
      cleanObject({
        a: undefined,
        b: null,
        c: '',
        d: 0,
        e: false,
        BillAddr: { Line1: undefined, City: null },
        Ref: { value: 'x', name: undefined },
        Line: [{ Amount: 0, Description: '' }],
      }),
    ).toEqual({ d: 0, e: false, Ref: { value: 'x' }, Line: [{ Amount: 0 }] });
  });

  it('does not mutate its input', () => {
    const input = { a: undefined, b: { c: 1 } };
    cleanObject(input);
    expect(input).toEqual({ a: undefined, b: { c: 1 } });
  });
});

describe('checkDocNumber (brief §6 bugs #2 and #3)', () => {
  const rules = testMappings().lago.invoice_prefix_rules;

  it('accepts a compliant number of exactly 21 characters', () => {
    expect(checkDocNumber('ACME-202610-001-CN001', 'credit_note', rules)).toEqual({
      ok: true,
      number: 'ACME-202610-001-CN001',
      compliant: true,
    });
  });

  it('fails a 26-character credit note number with the explicit prefix message', () => {
    const r = checkDocNumber('LAGO-DEMO-202610-004-CN001', 'credit_note', rules);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('26 characters; QBO allows 21');
      expect(r.reason).toContain('Lago prefix too long: credit note numbers add -CN001; keep the prefix ≤ 4 characters');
    }
  });

  it('fails a 22-character invoice number', () => {
    const r = checkDocNumber('ACMECORP-202610-00001', 'invoice', rules);
    expect(r.ok).toBe(true);
    const r22 = checkDocNumber('ACMECORPX-202610-00001', 'invoice', rules);
    expect(r22.ok).toBe(false);
    if (!r22.ok) expect(r22.reason).toMatch(/22 characters; QBO allows 21/);
  });

  it('marks numbers with [ or other characters as non-compliant (lookups cannot be trusted)', () => {
    for (const n of ['[AC]-202610-006', 'AC/202610', "AC'1", 'AC 1']) {
      expect(checkDocNumber(n, 'invoice', rules)).toMatchObject({ ok: true, compliant: false });
    }
  });

  it('fails an empty number', () => {
    expect(checkDocNumber('', 'invoice', rules).ok).toBe(false);
  });
});
