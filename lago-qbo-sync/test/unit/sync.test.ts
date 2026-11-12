import { describe, expect, it } from 'vitest';
import type { Mappings } from '../../src/config/schema.js';
import { HttpError } from '../../src/http/errors.js';
import type { LagoCreditNote, LagoInvoice } from '../../src/lago/types.js';
import { AuthError } from '../../src/qbo/errors.js';
import { runSync } from '../../src/sync/run.js';
import type { LockOutcome, TokenStore } from '../../src/tokenStore/types.js';
import { FakeLago, FakeQbo } from '../fakeServices.js';
import { captureLogger, instantClock } from '../fakes.js';
import { creditNoteFixture, invoiceFixture, testMappings } from '../helpers.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');

const CLEAN_INVOICES = [
  'invoice-coupon-tax',
  'invoice-progressive-billing',
  'invoice-prepaid-and-credit-note',
  'invoice-multi-unit-rounding',
  'invoice-missing-optional',
  'invoice-wallet-topup',
];
const CLEAN_CREDIT_NOTES = ['credit-note-basic', 'credit-note-no-items'];

function mappings(sync: Partial<Mappings['sync']> = {}): Mappings {
  const m = testMappings({ taxCodeId: '7' });
  return { ...m, sync: { ...m.sync, lookback_days: 30, ...sync } };
}

function store(lock: LockOutcome = { acquired: true }): TokenStore & { unlocked: number } {
  const s = {
    unlocked: 0,
    get: async () => null,
    set: async () => undefined,
    lock: async () => lock,
    unlock: async () => {
      s.unlocked++;
    },
    describe: () => '/secure/qbo.token.json',
  };
  return s;
}

function scenario(opts: {
  invoices?: LagoInvoice[];
  creditNotes?: LagoCreditNote[];
  sync?: Partial<Mappings['sync']>;
  qbo?: FakeQbo;
} = {}) {
  const qbo = opts.qbo ?? new FakeQbo();
  const lago = new FakeLago(
    opts.invoices ?? CLEAN_INVOICES.map(invoiceFixture),
    opts.creditNotes ?? CLEAN_CREDIT_NOTES.map(creditNoteFixture),
  );
  const tokenStore = store();
  const run = (mode: 'apply' | 'dry-run' = 'apply', auth = { getAccessToken: async () => 'TEST-token' }) =>
    runSync({
      mappings: mappings(opts.sync),
      lago: lago.asReader(),
      qbo: qbo.asApi(),
      auth,
      tokenStore,
      log: captureLogger(),
      mode,
      clock: instantClock(NOW),
    });
  return { qbo, lago, tokenStore, run };
}

describe('runSync — goal §3: idempotent, amounts to the cent', () => {
  it('first run creates customers, invoices and credit memos; wallet top-ups are out of scope', async () => {
    const { run, qbo } = scenario();
    const s = await run();
    expect(s.status).toBe('completed');
    expect(s.exit_code).toBe(0);
    expect(s.failures).toEqual([]);
    expect(s.counts.customer.created).toBe(3);
    expect(s.counts.invoice.created).toBe(5);
    expect(s.counts.credit_note.created).toBe(2);
    expect(s.out_of_scope.wallet_topup_invoices).toBe(1);
    expect(s.missing_in_qbo).toMatchObject({ method: 'batched', checked: 7, items: [] });
    expect(s.qbo.unexpected_statuses).toEqual([]);
    expect(qbo.invoices.every((i) => i.CustomerRef?.value)).toBe(true);
  });

  it('QBO TotalAmt equals Lago total_amount_cents / 100 and TotalTax equals taxes_amount_cents / 100', async () => {
    const { run, qbo, lago } = scenario();
    await run();
    for (const inv of lago.invoices.filter((i) => i.invoice_type !== 'credit')) {
      const row = qbo.invoices.find((r) => r.DocNumber === inv.number)!;
      expect(row.TotalAmt, inv.number).toBe(inv.total_amount_cents / 100);
      const tax = (row as { TxnTaxDetail?: { TotalTax: number } }).TxnTaxDetail?.TotalTax ?? 0;
      expect(tax, inv.number).toBe((inv.taxes_amount_cents ?? 0) / 100);
    }
    for (const cn of lago.creditNotes) {
      expect(qbo.creditMemos.find((r) => r.DocNumber === cn.number)!.TotalAmt).toBe(cn.total_amount_cents / 100);
    }
  });

  it('a second run over the same window creates nothing (all "already synced")', async () => {
    const { run, qbo } = scenario();
    await run();
    const writesAfterFirst = qbo.writes.length;
    const s = await run();
    expect(qbo.writes.length).toBe(writesAfterFirst);
    expect(s.counts.customer).toMatchObject({ created: 0, updated: 0, skipped: 3 });
    expect(s.counts.invoice).toMatchObject({ created: 0, skipped: 5 });
    expect(s.counts.credit_note).toMatchObject({ created: 0, skipped: 2 });
    expect(s.exit_code).toBe(0);
  });

  it('a changed customer is sparse-updated, then skipped on the next run', async () => {
    const { run, lago } = scenario();
    await run();
    for (const cn of lago.creditNotes) if (cn.customer.lago_id.endsWith('01')) cn.customer.email = 'ap@acme.example';
    expect((await run()).counts.customer.updated).toBe(1);
    expect((await run()).counts.customer).toMatchObject({ updated: 0, skipped: 3 });
  });
});

describe('runSync — known n8n bugs (§6) do not reappear', () => {
  it('[ in numbers, 26-char numbers and coupon credit notes fail explicitly; the run continues', async () => {
    const { run, qbo } = scenario({
      invoices: [...CLEAN_INVOICES, 'invoice-bracket-number'].map(invoiceFixture),
      creditNotes: [...CLEAN_CREDIT_NOTES, 'credit-note-long-number', 'credit-note-coupon-adjustment'].map(creditNoteFixture),
    });
    const s = await run();
    expect(s.exit_code).toBe(1);
    expect(s.counts.invoice).toMatchObject({ created: 5, failed: 1 });
    expect(s.counts.credit_note).toMatchObject({ created: 2, failed: 2 });
    expect(s.counts.customer.created).toBe(4); // O'Neil Analytics included (apostrophe)
    expect(qbo.customers.map((c) => c.DisplayName)).toContain("O'Neil Analytics");
    expect(s.failures.map((f) => [f.entity, f.lago_number])).toEqual([
      ['invoice', '[AC]-202610-006'],
      ['credit_note', 'LAGO-DEMO-202610-004-CN001'],
      ['credit_note', 'ACME-202610-001-CN002'],
    ]);
    expect(s.failures[1]!.reason).toContain('keep the prefix ≤ 4 characters');
    expect(qbo.invoices.some((i) => i.DocNumber === '[AC]-202610-006')).toBe(false);
    expect(s.missing_in_qbo.items.map((i) => [i.lago_number, i.reason])).toEqual([
      ['[AC]-202610-006', 'unverifiable_docnumber'],
      ['LAGO-DEMO-202610-004-CN001', 'docnumber_too_long'],
      ['ACME-202610-001-CN002', 'not_found'],
    ]);
  });

  it('a failed lookup never leads to a create (bug #5): batch fails, then the single lookup fails', async () => {
    const qbo = new FakeQbo();
    // Every query naming this number fails: the batched IN check and the single = lookup.
    qbo.failQuery = (q) =>
      q.includes("'ACME-202610-001'") && !q.includes('FROM Customer') ? new HttpError('qbo', 'GET', '/query', 500, null, {}) : undefined;
    const { run } = scenario({ qbo });
    const s = await run();
    expect(qbo.invoices.map((i) => i.DocNumber)).not.toContain('ACME-202610-001');
    expect(s.failures).toEqual([
      expect.objectContaining({ entity: 'invoice', lago_number: 'ACME-202610-001', reason: expect.stringContaining('HTTP 500') }),
    ]);
    expect(s.counts.invoice.created).toBe(4);
    expect(s.qbo.unexpected_statuses).toEqual(['500']);
  });

  it('payments run after invoices: a same-run invoice is paid, a missing one is deferred (bug #4)', async () => {
    const invoices = CLEAN_INVOICES.map(invoiceFixture);
    invoices[0]!.payment_status = 'succeeded'; // ACME-202610-001, created in this run's invoice pass
    const old = invoiceFixture('invoice-bracket-number');
    Object.assign(old, { lago_id: 'inv-old', number: 'ACME-202609-099', issuing_date: '2026-09-15', payment_status: 'succeeded' });
    invoices.push(old); // inside the 45-day payment window, outside the 30-day document window
    const { run, qbo } = scenario({ invoices, sync: { sync_payments: true } });

    const first = await run();
    expect(first.counts.payment).toMatchObject({ created: 1, deferred: 1, failed: 0 });
    expect(first.deferred).toEqual([
      { entity: 'payment', lago_number: 'ACME-202609-099', lago_id: 'inv-old', reason: 'invoice ACME-202609-099 is not in QBO yet' },
    ]);
    expect(first.exit_code).toBe(0);
    expect(qbo.invoices.find((i) => i.DocNumber === 'ACME-202610-001')!.Balance).toBe(0);
    expect(qbo.payments[0]).toMatchObject({ TotalAmt: 162, PrivateNote: expect.stringContaining('inv-0000-0000-0000-000000000001') });

    // The missing invoice reaches QBO (e.g. a wider window); the next run pays it, the paid one is skipped.
    qbo.invoices.push({ Id: '900', SyncToken: '0', DocNumber: 'ACME-202609-099', TotalAmt: 25, Balance: 25, CustomerRef: { value: '1' }, PrivateNote: 'Lago Invoice: inv-old' });
    const second = await run();
    expect(second.counts.payment).toMatchObject({ created: 1, skipped: 1, deferred: 0 });
    expect((await run()).counts.payment).toMatchObject({ created: 0, skipped: 2 });
  });

  it('voids a voided Lago invoice once; an unmatchable number fails instead of being skipped', async () => {
    const invoices = CLEAN_INVOICES.map(invoiceFixture);
    const voided = invoiceFixture('invoice-progressive-billing');
    Object.assign(voided, { lago_id: 'inv-void', number: 'ACME-202610-050', status: 'voided' });
    const voidedBracket = invoiceFixture('invoice-bracket-number');
    Object.assign(voidedBracket, { lago_id: 'inv-void2', status: 'voided' });
    const qbo = new FakeQbo();
    qbo.invoices.push({ Id: '77', SyncToken: '3', DocNumber: 'ACME-202610-050', TotalAmt: 120, Balance: 120, PrivateNote: 'Lago Invoice: inv-void' });
    const { run } = scenario({ invoices: [...invoices, voided, voidedBracket], qbo });

    const first = await run();
    expect(first.counts.void).toMatchObject({ voided: 1, failed: 1 });
    expect(qbo.invoices.find((i) => i.Id === '77')).toMatchObject({ TotalAmt: 0, Balance: 0 });
    expect((await run()).counts.void).toMatchObject({ voided: 0, skipped: 1, failed: 1 });
  });
});

describe('runSync — lifecycle and exit codes (brief §4.3)', () => {
  it('dry-run reads everything and writes nothing', async () => {
    const { run, qbo } = scenario();
    const s = await run('dry-run');
    expect(s.mode).toBe('dry-run');
    expect(qbo.writes).toEqual([]);
    expect(s.counts.customer.would_create).toBe(3);
    expect(s.counts.invoice.would_create).toBe(5);
    expect(s.counts.credit_note.would_create).toBe(2);
    expect(s.missing_in_qbo.items).toHaveLength(7);
    expect(s.exit_code).toBe(0);
  });

  it('a second run while one holds the lock exits 0 with status "locked" and touches nothing', async () => {
    const { qbo, lago } = scenario();
    const s = await runSync({
      mappings: mappings(),
      lago: lago.asReader(),
      qbo: qbo.asApi(),
      auth: { getAccessToken: async () => 't' },
      tokenStore: store({ acquired: false, holder: { pid: 42, host: 'box', started_at: '2026-10-24T11:59:00Z' }, stale: false }),
      log: captureLogger(),
      mode: 'apply',
      clock: instantClock(NOW),
    });
    expect(s).toMatchObject({ status: 'locked', exit_code: 0 });
    expect(s.message).toContain('pid 42 on box');
    expect(qbo.stats.calls + lago.stats.calls).toBe(0);
  });

  it('a stale lock exits 1 so it cannot pass as a healthy run (code review 2026-11-12)', async () => {
    const { qbo, lago } = scenario();
    const s = await runSync({
      mappings: mappings(),
      lago: lago.asReader(),
      qbo: qbo.asApi(),
      auth: { getAccessToken: async () => 't' },
      tokenStore: store({ acquired: false, holder: null, stale: true }),
      log: captureLogger(),
      mode: 'apply',
      clock: instantClock(NOW),
    });
    expect(s).toMatchObject({ status: 'locked', exit_code: 1 });
    expect(s.message).toContain('Stale lock');
  });

  it('an invalid refresh token exits 3 with the reconnect hint and releases the lock', async () => {
    const { run, tokenStore, qbo } = scenario();
    const s = await run('apply', {
      getAccessToken: async () => {
        throw new AuthError('Intuit rejected the refresh token (invalid_grant)');
      },
    });
    expect(s).toMatchObject({ status: 'auth_error', exit_code: 3 });
    expect(s.message).toContain('npm run auth');
    expect(tokenStore.unlocked).toBe(1);
    expect(qbo.stats.calls).toBe(0);
  });

  it('an auth failure in the middle of the run stops it with exit 3', async () => {
    const qbo = new FakeQbo();
    qbo.failQuery = (q) => (q.includes('FROM Invoice') ? new AuthError('QBO rejected the access token again') : undefined);
    const { run } = scenario({ qbo });
    expect(await run()).toMatchObject({ status: 'auth_error', exit_code: 3 });
  });

  it('refuses a non-US company (exit 2) and a foreign currency without multicurrency (document fails)', async () => {
    const nonUs = new FakeQbo();
    nonUs.company = { country: 'FR', homeCurrency: 'EUR', multiCurrencyEnabled: false };
    expect(await scenario({ qbo: nonUs }).run()).toMatchObject({ status: 'config_error', exit_code: 2 });

    const eurInvoice = invoiceFixture('invoice-missing-optional');
    eurInvoice.currency = 'EUR';
    const s = await scenario({ invoices: [eurInvoice], creditNotes: [] }).run();
    expect(s.failures[0]!.reason).toBe(
      'Invoice ACME-202610-005: currency EUR differs from the QBO home currency USD and multicurrency is off in QBO',
    );
  });

  it('fails documents of a customer whose QBO namesake belongs to another Lago customer (Q7)', async () => {
    const qbo = new FakeQbo();
    qbo.customers.push({ Id: '5', SyncToken: '0', DisplayName: 'Acme Robotics', Notes: 'Lago ID: cus-someone-else\nExternal ID: x' });
    const s = await scenario({ qbo }).run();
    expect(s.counts.customer.failed).toBe(1);
    expect(s.counts.invoice.failed).toBe(3);
    expect(s.failures.find((f) => f.entity === 'invoice')!.reason).toContain('its customer could not be synced');
    expect(qbo.invoices.every((i) => i.CustomerRef?.value !== '5')).toBe(true);
  });
});

describe('runSync — batched existence checks (PLAN.md §9 option A)', () => {
  it('checks invoices and credit notes with one IN query each instead of one query per document', async () => {
    const qbo = new FakeQbo();
    const queries: string[] = [];
    const original = qbo.query.bind(qbo);
    qbo.query = (async (statement: string, key: string) => {
      queries.push(statement);
      return original(statement, key);
    }) as typeof qbo.query;
    const s = await scenario({ qbo }).run();
    expect(s.counts.invoice.created).toBe(5);
    const docQueries = queries.filter((q) => /FROM (Invoice|CreditMemo)/.test(q));
    // 1 batch for 5 invoices + 1 batch for 2 credit notes during sync, then the 2 reconciliation batches.
    expect(docQueries.filter((q) => q.includes('DocNumber = '))).toEqual([]);
    expect(docQueries.filter((q) => q.includes('DocNumber IN ('))).toHaveLength(4);
  });

  it('falls back to one lookup per document when the batch is rejected, with the same result', async () => {
    const qbo = new FakeQbo();
    qbo.rejectInQueries = true;
    const { run } = scenario({ qbo });
    const first = await run();
    expect(first.counts.invoice).toMatchObject({ created: 5, failed: 0 });
    expect(first.counts.credit_note).toMatchObject({ created: 2, failed: 0 });
    const second = await run();
    expect(second.counts.invoice).toMatchObject({ created: 0, skipped: 5 });
  });

  it('a duplicate already in QBO is still reported through the batch', async () => {
    const qbo = new FakeQbo();
    qbo.invoices.push({ Id: '1', SyncToken: '0', DocNumber: 'ACME-202610-002' }, { Id: '2', SyncToken: '0', DocNumber: 'ACME-202610-002' });
    const s = await scenario({ qbo }).run();
    expect(s.failures).toEqual([expect.objectContaining({ lago_number: 'ACME-202610-002', reason: expect.stringContaining('Ids 1, 2') })]);
  });
});

describe('runSync — empty invoices (decided 2026-11-11: skip and report)', () => {
  it('skips and lists an empty invoice, creates no customer for it, skips its $0 payment, keeps exit 0', async () => {
    const { run, qbo } = scenario({
      invoices: [...CLEAN_INVOICES, 'invoice-empty'].map(invoiceFixture),
      sync: { sync_payments: true },
    });
    const s = await run();
    expect(s.exit_code).toBe(0);
    expect(s.failures).toEqual([]);
    expect(s.counts.invoice).toMatchObject({ created: 5, skipped: 1, failed: 0 });
    expect(s.skipped_documents).toEqual([
      {
        entity: 'invoice',
        lago_number: 'ACME-202611-008',
        lago_id: 'inv-0000-0000-0000-000000000008',
        reason: 'empty invoice (total 0, no fees, no credits): nothing to book',
      },
    ]);
    expect(qbo.customers.map((c) => c.DisplayName)).not.toContain('Andes Remit');
    expect(qbo.invoices.map((i) => i.DocNumber)).not.toContain('ACME-202611-008');
    expect(s.counts.payment).toMatchObject({ skipped: 1, deferred: 0 });
    expect(s.missing_in_qbo.items.map((i) => i.lago_number)).not.toContain('ACME-202611-008');
  });
});

describe('runSync — reconciliation pass (PLAN.md §4.12)', () => {
  it('falls back to per-document lookups when QBO rejects IN, and reports truncation at the cap', async () => {
    const qbo = new FakeQbo();
    qbo.rejectInQueries = true;
    const s = await scenario({ qbo, sync: { reconcile_max_lookups: 3 } }).run('dry-run');
    expect(s.missing_in_qbo).toMatchObject({ method: 'per_document', truncated: true, checked: 3 });
    expect(s.missing_in_qbo.items).toHaveLength(3);
    expect(s.exit_code).toBe(0); // a 400 from the reconciliation probe is not a document failure
  });
});

describe('runSync — ownership and batched customers (code review 2026-11-12)', () => {
  it('a foreign QBO invoice with the same number fails the Lago invoice instead of being "already synced"', async () => {
    const qbo = new FakeQbo();
    qbo.invoices.push({ Id: '555', SyncToken: '0', DocNumber: 'ACME-202610-001', TotalAmt: 10, Balance: 10, PrivateNote: 'typed by hand' });
    const s = await scenario({ qbo }).run();
    expect(s.counts.invoice).toMatchObject({ created: 4, skipped: 0, failed: 1 });
    expect(s.failures[0]!.reason).toContain('(Id 555) that was not created from Lago document inv-0000-0000-0000-000000000001');
    expect(s.missing_in_qbo.items).toContainEqual(expect.objectContaining({ lago_number: 'ACME-202610-001', reason: 'number_used_by_other_document' }));
  });

  it('never voids a foreign QBO invoice that shares the number of a voided Lago invoice', async () => {
    const voided = invoiceFixture('invoice-progressive-billing');
    Object.assign(voided, { lago_id: 'inv-void', number: 'ACME-202610-050', status: 'voided' });
    const qbo = new FakeQbo();
    qbo.invoices.push({ Id: '77', SyncToken: '3', DocNumber: 'ACME-202610-050', TotalAmt: 120, Balance: 120, PrivateNote: 'typed by hand' });
    const s = await scenario({ invoices: [...CLEAN_INVOICES.map(invoiceFixture), voided], qbo }).run();
    expect(s.counts.void).toMatchObject({ voided: 0, failed: 1 });
    expect(qbo.invoices.find((i) => i.Id === '77')).toMatchObject({ TotalAmt: 120, Balance: 120 });
  });

  it('looks customers up with one IN query, and falls back to single lookups when it is rejected', async () => {
    const qbo = new FakeQbo();
    const queries: string[] = [];
    const original = qbo.query.bind(qbo);
    qbo.query = (async (statement: string, key: string) => {
      queries.push(statement);
      return original(statement, key);
    }) as typeof qbo.query;
    const { run } = scenario({ qbo });
    await run();
    const second = await run();
    expect(second.counts.customer).toMatchObject({ skipped: 3, failed: 0 });
    const customerQueries = queries.filter((q) => q.includes('FROM Customer'));
    expect(customerQueries.filter((q) => q.includes('DisplayName = '))).toEqual([]);
    expect(customerQueries.filter((q) => q.includes('DisplayName IN ('))).toHaveLength(2);

    const rejecting = new FakeQbo();
    rejecting.rejectInQueries = true;
    const r = await scenario({ qbo: rejecting }).run();
    expect(r.counts.customer).toMatchObject({ created: 3, failed: 0 });
  });
});
