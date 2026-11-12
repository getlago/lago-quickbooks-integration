import { describe, expect, it } from 'vitest';
import type { QboCustomerPayload, QboCustomerRow, QboTxnRow } from '../../src/qbo/types.js';
import {
  currencyProblem,
  decideCustomer,
  decideDocument,
  decidePayment,
  decideVoid,
  ownedBy,
  missingReason,
  type Lookup,
} from '../../src/reconcile/index.js';
import { toQboPayment } from '../../src/transform/payment.js';
import { extractVoidInfo } from '../../src/transform/void.js';
import { invoiceFixture, testMappings } from '../helpers.js';

const none = { kind: 'none' } as const;
const found = <R>(...rows: R[]): Lookup<R> => ({ kind: 'found', rows });
/** The Lago id of invoice-coupon-tax; QBO documents created from it carry it in PrivateNote. */
const LAGO = 'inv-0000-0000-0000-000000000001';
const txn = (over: Partial<QboTxnRow> = {}): QboTxnRow => ({ Id: '101', SyncToken: '0', PrivateNote: `Lago Invoice: ${LAGO}`, ...over });

describe('decideDocument (invoices and credit memos)', () => {
  const ok = { number: 'ACME-202610-001', compliant: true };

  it('creates when QBO says none, skips when exactly one exists', () => {
    expect(decideDocument('Invoice X', ok, none, LAGO)).toEqual({ action: 'create' });
    expect(decideDocument('Invoice X', ok, found(txn()), LAGO)).toEqual({ action: 'skip', reason: 'already synced (QBO Id 101)' });
  });

  it('fails on existing duplicates instead of picking one', () => {
    const d = decideDocument('Invoice X', ok, found(txn(), txn({ Id: '102' })), LAGO);
    expect(d).toMatchObject({ action: 'fail' });
    expect(d.action === 'fail' && d.reason).toContain('Ids 101, 102');
  });

  it('never creates a non-compliant number on an empty lookup (brief §6 bug #2)', () => {
    const bracket = { number: '[AC]-202610-006', compliant: false };
    expect(decideDocument('Invoice [AC]', bracket, none, LAGO)).toMatchObject({ action: 'fail' });
    // If QBO does find it, skipping is safe.
    expect(decideDocument('Invoice [AC]', bracket, found(txn()), LAGO)).toMatchObject({ action: 'skip' });
  });
});

describe('ownership: only documents created from this Lago document (code review 2026-11-12)', () => {
  const ok = { number: 'ACME-202610-001', compliant: true };
  const foreign = txn({ Id: '555', PrivateNote: 'Manual invoice entered by the bookkeeper' });

  it('ownedBy reads the Lago id in PrivateNote, including after QBO prefixes "Voided - "', () => {
    expect(ownedBy(txn(), LAGO)).toBe(true);
    expect(ownedBy(txn({ PrivateNote: `Voided - Lago Invoice: ${LAGO}` }), LAGO)).toBe(true);
    expect(ownedBy(txn({ PrivateNote: undefined }), LAGO)).toBe(false);
    expect(ownedBy(foreign, LAGO)).toBe(false);
    expect(ownedBy(txn(), '')).toBe(false);
  });

  it('never reports a same-numbered foreign document as "already synced"', () => {
    const d = decideDocument('Invoice ACME-202610-001', ok, found(foreign), LAGO);
    expect(d).toMatchObject({ action: 'fail' });
    expect(d.action === 'fail' && d.reason).toContain('(Id 555) that was not created from Lago document');
  });

  it('never pays a foreign document', () => {
    const inv = invoiceFixture('invoice-coupon-tax');
    expect(decidePayment(inv, found({ ...foreign, Balance: 162, CustomerRef: { value: '5' } }))).toMatchObject({ action: 'fail' });
  });

  it('never voids a foreign document', () => {
    expect(decideVoid('ACME-202610-001', LAGO, found({ ...foreign, TotalAmt: 50, Balance: 50 }))).toMatchObject({ action: 'fail' });
  });

  it('the reconciliation pass reports the number as used by another document', () => {
    const rules = testMappings().lago.invoice_prefix_rules;
    expect(missingReason('ACME-202610-001', 'invoice', rules, found(foreign), LAGO)).toBe('number_used_by_other_document');
  });
});

describe('decideCustomer', () => {
  const desired: QboCustomerPayload = {
    DisplayName: "O'Neil Analytics",
    PrimaryEmailAddr: { Address: 'ap@oneil.example' },
    BillAddr: { City: 'Springfield' },
    CurrencyRef: { value: 'USD' },
    Notes: 'Lago ID: cus-4\nExternal ID: oneil_004',
  };
  const row = (over: Partial<QboCustomerRow> = {}): QboCustomerRow => ({
    Id: '55',
    SyncToken: '3',
    DisplayName: "O'Neil Analytics",
    PrimaryEmailAddr: { Address: 'ap@oneil.example' },
    BillAddr: { Id: '900', City: 'Springfield' },
    CurrencyRef: { value: 'USD', name: 'United States Dollar' },
    Notes: 'Lago ID: cus-4\r\nExternal ID: oneil_004',
    Active: true,
    ...over,
  });

  it('creates when absent', () => {
    expect(decideCustomer(desired, 'cus-4', none)).toEqual({ action: 'create' });
  });

  it('skips when nothing we own changed (extra QBO fields and CRLF are ignored), so reruns write nothing', () => {
    expect(decideCustomer(desired, 'cus-4', found(row()))).toEqual({ action: 'skip', reason: 'unchanged (QBO Id 55)' });
  });

  it('sparse-updates with Id and SyncToken when a field changed', () => {
    const d = decideCustomer(desired, 'cus-4', found(row({ PrimaryEmailAddr: { Address: 'old@oneil.example' } })));
    expect(d).toEqual({ action: 'update', payload: { ...desired, Id: '55', SyncToken: '3', sparse: true } });
  });

  it('fails when the QBO customer belongs to another Lago customer (PLAN.md Q7)', () => {
    const d = decideCustomer(desired, 'cus-4', found(row({ Notes: 'Lago ID: cus-9\nExternal ID: other' })));
    expect(d).toMatchObject({ action: 'fail' });
    expect(d.action === 'fail' && d.reason).toContain('belongs to Lago customer cus-9, not cus-4');
  });

  it('adopts a same-name QBO customer that has no Lago ID in its Notes (n8n behavior)', () => {
    expect(decideCustomer(desired, 'cus-4', found(row({ Notes: undefined })))).toMatchObject({ action: 'update' });
  });
});

describe('decidePayment (PLAN.md Q10, brief §6 bug #4)', () => {
  const inv = invoiceFixture('invoice-coupon-tax'); // total 162.00

  it('defers when the invoice is not in QBO yet, never fails', () => {
    expect(decidePayment(inv, none)).toEqual({ action: 'defer', reason: 'invoice ACME-202610-001 is not in QBO yet' });
  });

  it('skips a QBO invoice with balance 0', () => {
    expect(decidePayment(inv, found(txn({ Balance: 0, CustomerRef: { value: '55' } })))).toMatchObject({ action: 'skip' });
  });

  it('creates a linked payment for the Lago total when the balance equals it', () => {
    const d = decidePayment(inv, found(txn({ Id: '700', Balance: 162, TotalAmt: 162, CustomerRef: { value: '55' } })));
    expect(d).toEqual({
      action: 'create_payment',
      payload: {
        CustomerRef: { value: '55' },
        TotalAmt: 162,
        CurrencyRef: { value: 'USD' },
        Line: [{ Amount: 162, LinkedTxn: [{ TxnId: '700', TxnType: 'Invoice' }] }],
        PrivateNote: 'Payment for Lago Invoice: ACME-202610-001\nLago Invoice ID: inv-0000-0000-0000-000000000001',
      },
    });
  });

  it('fails on a partial balance instead of overpaying', () => {
    const d = decidePayment(inv, found(txn({ Balance: 100, CustomerRef: { value: '55' } })));
    expect(d).toMatchObject({ action: 'fail' });
    expect(d.action === 'fail' && d.reason).toContain('QBO balance is 100.00 but the Lago total is 162.00');
  });

  it('fails on duplicates or a missing Balance', () => {
    expect(decidePayment(inv, found(txn(), txn()))).toMatchObject({ action: 'fail' });
    expect(decidePayment(inv, found(txn({ Balance: undefined })))).toMatchObject({ action: 'fail' });
  });

  it('toQboPayment fails when the QBO invoice has no customer', () => {
    expect(toQboPayment(inv, txn()).ok).toBe(false);
  });
});

describe('decideVoid', () => {
  it('skips when absent, voids with Id + SyncToken when present', () => {
    expect(decideVoid('X', LAGO, none)).toMatchObject({ action: 'skip' });
    expect(decideVoid('X', LAGO, found(txn({ Id: '9', SyncToken: '4', TotalAmt: 50, Balance: 50 })))).toEqual({
      action: 'void',
      payload: { Id: '9', SyncToken: '4' },
    });
  });

  it('skips an invoice QBO already shows as voided (shape observed in the sandbox)', () => {
    const voided = txn({ TotalAmt: 0, Balance: 0, PrivateNote: `Voided - Lago Invoice: ${LAGO}` });
    expect(decideVoid('X', LAGO, found(voided))).toMatchObject({ action: 'skip' });
  });

  it('still voids a $0 invoice that QBO does not mark as voided', () => {
    const zero = txn({ Id: '12', SyncToken: '0', TotalAmt: 0, Balance: 0, PrivateNote: `Lago Invoice: ${LAGO}` });
    expect(decideVoid('X', LAGO, found(zero))).toEqual({ action: 'void', payload: { Id: '12', SyncToken: '0' } });
    expect(decideVoid('X', LAGO, found(txn({ TotalAmt: 0, Balance: 0 })))).toMatchObject({ action: 'void' });
  });

  it('extracts the void info like the n8n node', () => {
    expect(extractVoidInfo({ lago_id: 'inv-1', number: 'ACME-1' })).toEqual({ lagoId: 'inv-1', number: 'ACME-1' });
  });
});

describe('currencyProblem (brief §6 multicurrency note)', () => {
  const usdOnly = { country: 'US', homeCurrency: 'USD', multiCurrencyEnabled: false };
  it('allows the home currency, or any currency with multicurrency on', () => {
    expect(currencyProblem('Invoice X', 'USD', usdOnly)).toBeNull();
    expect(currencyProblem('Invoice X', 'EUR', { ...usdOnly, multiCurrencyEnabled: true })).toBeNull();
  });
  it('fails a foreign currency when multicurrency is off', () => {
    expect(currencyProblem('Invoice X', 'EUR', usdOnly)).toBe(
      'Invoice X: currency EUR differs from the QBO home currency USD and multicurrency is off in QBO',
    );
  });
});

describe('missingReason (read-only reconciliation, PLAN.md §4.12)', () => {
  const rules = testMappings().lago.invoice_prefix_rules;
  it('classifies each case', () => {
    expect(missingReason('ACME-202610-001', 'invoice', rules, found(txn()), LAGO)).toBeNull();
    expect(missingReason('ACME-202610-001', 'invoice', rules, none, LAGO)).toBe('not_found');
    expect(missingReason('[AC]-202610-006', 'invoice', rules, none, LAGO)).toBe('unverifiable_docnumber');
    expect(missingReason('LAGO-DEMO-202610-004-CN001', 'credit_note', rules, none, LAGO)).toBe('docnumber_too_long');
    expect(missingReason('ACME-202610-001', 'invoice', rules, found(txn(), txn()), LAGO)).toBe('duplicate_in_qbo');
  });
});
