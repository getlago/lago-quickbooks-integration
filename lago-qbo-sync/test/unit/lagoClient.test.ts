import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LagoClient, LagoSchemaError } from '../../src/lago/client.js';
import { captureLogger, fakeFetch, fastThrottle, instantClock, json, type Responder } from '../fakes.js';

const API = 'https://api.getlago.com/api/v1';
const KEY = 'TEST-lago-api-key-0001';

function setup(script: Responder[]) {
  const fetch = fakeFetch(script);
  const clock = instantClock();
  const client = new LagoClient({ apiUrl: API, apiKey: KEY, fetch, throttle: fastThrottle(clock), log: captureLogger(), clock, random: () => 0.5 });
  return { client, fetch };
}

const summary = (n: number) => ({
  lago_id: `inv-${n}`,
  number: `ACME-202610-${String(n).padStart(3, '0')}`,
  issuing_date: '2026-10-20',
  currency: 'USD',
  status: 'finalized',
  payment_status: 'pending',
  invoice_type: 'subscription',
  total_amount_cents: 100 * n,
});
const page = (items: unknown[], current: number, next: number | null) =>
  json(200, { invoices: items, meta: { current_page: current, next_page: next, total_pages: 3, total_count: 5 } });

describe('LagoClient', () => {
  it('paginates until next_page is null, with documented filters, GET only, Bearer key', async () => {
    const { client, fetch } = setup([
      page([summary(1), summary(2)], 1, 2),
      page([summary(3), summary(4)], 2, 3),
      page([summary(5)], 3, null),
    ]);
    const r = await client.listInvoices({ status: 'finalized', payment_status: 'succeeded', issuing_date_from: '2026-09-26' });
    expect(r.items.map((i) => i.lago_id)).toEqual(['inv-1', 'inv-2', 'inv-3', 'inv-4', 'inv-5']);
    expect(r.invalid).toEqual([]);
    expect(fetch.calls.map((c) => c.url)).toEqual([1, 2, 3].map(
      (p) => `${API}/invoices?status=finalized&issuing_date_from=2026-09-26&payment_status=succeeded&page=${p}&per_page=100`,
    ));
    for (const c of fetch.calls) {
      expect(c.method).toBe('GET');
      expect(c.body).toBeUndefined();
      expect(c.headers).toEqual({ Authorization: `Bearer ${KEY}`, Accept: 'application/json' });
    }
    expect(client.stats.calls).toBe(3);
  });

  it('reports list entries missing required fields instead of dropping them', async () => {
    const { lago_id: _drop, ...noId } = summary(2);
    const { client } = setup([page([summary(1), { ...noId, number: 'BROKEN-1' }], 1, null)]);
    const r = await client.listInvoices({ status: 'voided', issuing_date_from: '2026-09-26' });
    expect(r.items).toHaveLength(1);
    expect(r.invalid).toEqual([{ number: 'BROKEN-1', reason: expect.stringContaining('lago_id') }]);
  });

  it('fetches a full invoice by encoded id and validates it', async () => {
    const fixture = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../fixtures/lago/invoice-coupon-tax.json'), 'utf8'));
    const { client, fetch } = setup([json(200, { invoice: fixture }), json(200, { invoice: { lago_id: 'x' } })]);
    const inv = await client.getInvoice('inv/../1');
    expect(inv.fees).toHaveLength(2);
    expect(fetch.calls[0]!.url).toBe(`${API}/invoices/inv%2F..%2F1`);
    await expect(client.getInvoice('x')).rejects.toBeInstanceOf(LagoSchemaError);
  });

  it('lists credit notes and billing entities', async () => {
    const { client, fetch } = setup([
      json(200, { credit_notes: [{ lago_id: 'cn-1', number: 'A-CN001', issuing_date: '2026-10-23' }], meta: { current_page: 1, next_page: null } }),
      json(200, { billing_entities: [{ code: 'acme', document_number_prefix: 'ACME', document_numbering: 'per_billing_entity' }] }),
    ]);
    expect((await client.listCreditNotes({ issuing_date_from: '2026-10-20' })).items).toHaveLength(1);
    expect(await client.listBillingEntities()).toEqual([
      { code: 'acme', document_number_prefix: 'ACME', document_numbering: 'per_billing_entity' },
    ]);
    expect(fetch.calls[0]!.url).toBe(`${API}/credit_notes?issuing_date_from=2026-10-20&page=1&per_page=100`);
    expect(fetch.calls[1]!.url).toBe(`${API}/billing_entities`);
  });

  it('retries a 429 from Lago', async () => {
    const { client, fetch } = setup([json(429, {}), page([summary(1)], 1, null)]);
    expect((await client.listInvoices({ status: 'finalized', issuing_date_from: '2026-10-20' })).items).toHaveLength(1);
    expect(fetch.calls).toHaveLength(2);
  });

  it('stops on a pagination loop and rejects bad dates', async () => {
    const { client } = setup([page([summary(1)], 1, 1)]);
    await expect(client.listInvoices({ status: 'finalized', issuing_date_from: '2026-10-20' })).rejects.toThrow(/does not advance/);
    expect(() => client.listInvoices({ status: 'finalized', issuing_date_from: '20/10/2026' })).toThrow(/YYYY-MM-DD/);
  });
});
