import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/errors.js';
import { QboClient, UnconfirmedWriteError, type AccessTokenSource } from '../../src/qbo/client.js';
import { AuthError, describeQboError, QboFaultError, QboLookupError, WritesDisabledError } from '../../src/qbo/errors.js';
import { customerByDisplayName, txnByDocNumber } from '../../src/qbo/query.js';
import type { QboTxnRow } from '../../src/qbo/types.js';
import { captureLogger, fakeFetch, fastThrottle, instantClock, json, type Responder } from '../fakes.js';

const REALM = '1234567890123456';

function setup(script: Responder[], writes: 'enabled' | 'disabled' = 'enabled') {
  const fetch = fakeFetch(script);
  const clock = instantClock();
  let n = 0;
  const auth: AccessTokenSource & { refreshes: number } = {
    refreshes: 0,
    getAccessToken: async () => `TEST-access-${n}`,
    refresh: async () => {
      auth.refreshes++;
      n++;
      return `TEST-access-${n}`;
    },
  };
  const client = new QboClient({
    environment: 'sandbox',
    realmId: REALM,
    minorVersion: 75,
    auth,
    fetch,
    throttle: fastThrottle(clock),
    log: captureLogger(),
    writes,
    clock,
    random: () => 0.5,
  });
  return { client, fetch, auth, clock };
}

const fault = (message: string, detail: string, code: string, element = '') => ({
  Fault: { Error: [{ Message: message, Detail: detail, code, element }], type: 'ValidationFault' },
  time: '2026-11-10T00:00:00.000-08:00',
});

describe('QboClient.query', () => {
  it('sends an encoded GET with Accept, Bearer and minorversion; empty QueryResponse means none', async () => {
    const { client, fetch } = setup([json(200, { QueryResponse: {}, time: 't' })]);
    expect(await client.query(customerByDisplayName("O'Neil Analytics"), 'Customer')).toEqual({ kind: 'none' });
    const req = fetch.calls[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/query?query=` +
        encodeURIComponent("SELECT * FROM Customer WHERE DisplayName = 'O\\'Neil Analytics'") +
        '&minorversion=75',
    );
    expect(req.headers).toEqual({ Authorization: 'Bearer TEST-access-0', Accept: 'application/json' });
  });

  it('returns rows when found', async () => {
    const { client } = setup([json(200, { QueryResponse: { Invoice: [{ Id: '7', SyncToken: '0' }], maxResults: 1 } })]);
    expect(await client.query<QboTxnRow>(txnByDocNumber('Invoice', 'A-1'), 'Invoice')).toEqual({
      kind: 'found',
      rows: [{ Id: '7', SyncToken: '0' }],
    });
  });

  it('never reads a malformed answer as "none" (brief §6 bug #5)', async () => {
    const { client } = setup([json(200, { time: 't' }), json(200, { QueryResponse: { Invoice: {} } })]);
    await expect(client.query('SELECT 1', 'Invoice')).rejects.toThrow(QboLookupError);
    await expect(client.query('SELECT 1', 'Invoice')).rejects.toThrow(QboLookupError);
  });

  it('treats a 200 with a Fault body as an error', async () => {
    const { client } = setup([json(200, fault('Invalid query', 'QueryParserError', '4000'))]);
    const err = await client.query('SELECT 1', 'Invoice').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QboFaultError);
    expect(describeQboError(err)).toBe('QBO Fault ValidationFault: Invalid query | QueryParserError | code 4000');
  });

  it('does not retry a 400; the fault message is kept for the run summary', async () => {
    const { client, fetch } = setup([json(400, fault('Duplicate Document Number Error', 'DocNumber=A-1', '6140', 'DocNumber'))]);
    const err = await client.query('SELECT 1', 'Invoice').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(fetch.calls).toHaveLength(1);
    expect(describeQboError(err)).toBe(
      'QBO HTTP 400 ValidationFault: Duplicate Document Number Error | DocNumber=A-1 | code 6140 | element DocNumber',
    );
  });

  it("explains Intuit's HTML 400 (the '[' bug in the n8n workflow)", async () => {
    const { client } = setup([new Response('<html><body>Bad Request</body></html>', { status: 400 })]);
    const err = await client.query('SELECT 1', 'Invoice').catch((e: unknown) => e);
    expect(describeQboError(err)).toMatch(/HTML page instead of JSON/);
  });

  it('retries 429 (honoring Retry-After) and 5xx, and counts every status', async () => {
    const { client, clock, fetch } = setup([
      json(429, {}, { 'retry-after': '3' }),
      json(503, {}),
      json(200, { QueryResponse: {} }),
    ]);
    await client.query('SELECT 1', 'Invoice');
    expect(fetch.calls).toHaveLength(3);
    expect(clock.slept.filter((ms) => ms >= 1000)).toEqual([3000, 1500]);
    expect(client.stats).toEqual({ calls: 3, byStatus: { '429': 1, '503': 1, '200': 1 } });
  });

  it('gives up after 5 attempts on persistent 5xx', async () => {
    const { client, fetch } = setup(Array.from({ length: 5 }, () => json(500, {})));
    await expect(client.query('SELECT 1', 'Invoice')).rejects.toBeInstanceOf(HttpError);
    expect(fetch.calls).toHaveLength(5);
  });
});

describe('QboClient 401 handling (brief §5.4)', () => {
  it('refreshes once and retries with the new token', async () => {
    const { client, fetch, auth } = setup([json(401, {}), json(200, { QueryResponse: {} })]);
    await client.query('SELECT 1', 'Invoice');
    expect(auth.refreshes).toBe(1);
    expect(fetch.calls.map((c) => c.headers.Authorization)).toEqual(['Bearer TEST-access-0', 'Bearer TEST-access-1']);
    expect(client.stats.byStatus).toEqual({ '401': 1, '200': 1 });
  });

  it('a second 401 is an AuthError (exit code 3)', async () => {
    const { client, auth } = setup([json(401, {}), json(401, {})]);
    await expect(client.query('SELECT 1', 'Invoice')).rejects.toBeInstanceOf(AuthError);
    expect(auth.refreshes).toBe(1);
  });
});

describe('QboClient writes', () => {
  const invoice = { DocNumber: 'A-1', TxnDate: '2026-10-20', CurrencyRef: { value: 'USD' }, Line: [], PrivateNote: 'p', CustomerMemo: { value: 'm' } };

  it('creates and unwraps the entity', async () => {
    const { client, fetch } = setup([json(200, { Invoice: { Id: '9', SyncToken: '0' } })]);
    const r = await client.create('invoice', invoice, async () => null);
    expect(r).toEqual({ row: { Id: '9', SyncToken: '0' }, recovered: false });
    expect(fetch.calls[0]!.url).toBe(`https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/invoice?minorversion=75`);
    expect(fetch.calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual(invoice);
  });

  it('after an ambiguous 5xx, finds the document instead of creating it twice', async () => {
    const { client, fetch } = setup([json(502, {})]);
    const r = await client.create('invoice', invoice, async () => ({ Id: '9', SyncToken: '0' }));
    expect(r).toEqual({ row: { Id: '9', SyncToken: '0' }, recovered: true });
    expect(fetch.calls).toHaveLength(1);
  });

  it('after an unconfirmed create that is not found, never resends in the same run (code review 2026-11-12)', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { client, fetch, clock } = setup([timeout]);
    let looked = 0;
    const err = await client
      .create('invoice', invoice, async () => {
        looked++;
        return null;
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnconfirmedWriteError);
    expect((err as Error).message).toContain('not resent, to avoid a duplicate');
    expect(looked).toBe(1);
    expect(fetch.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // It waited before checking, so a late commit by QBO can be seen.
    expect(clock.slept).toContain(5000);
  });

  it('a 400 fails the document without a lookup or retry', async () => {
    const { client, fetch } = setup([json(400, fault('Invalid Reference Id', 'Item 99', '2500', 'ItemRef'))]);
    let looked = false;
    await expect(
      client.create('invoice', invoice, async () => {
        looked = true;
        return null;
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(looked).toBe(false);
    expect(fetch.calls).toHaveLength(1);
  });

  it('voids with operation=void and Id + SyncToken', async () => {
    const { client, fetch } = setup([json(200, { Invoice: { Id: '9', SyncToken: '2', TotalAmt: 0, Balance: 0 } })]);
    await client.voidInvoice({ Id: '9', SyncToken: '1' });
    expect(fetch.calls[0]!.url).toContain('/invoice?operation=void&minorversion=75');
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({ Id: '9', SyncToken: '1' });
  });

  it('dry-run: every write method throws before any request', async () => {
    const { client, fetch } = setup([], 'disabled');
    await expect(client.create('invoice', invoice, async () => null)).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(client.sparseUpdateCustomer({ Id: '1', SyncToken: '0', sparse: true })).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(client.voidInvoice({ Id: '1', SyncToken: '0' })).rejects.toBeInstanceOf(WritesDisabledError);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('QboClient.companyContext', () => {
  it('reads country, home currency and multicurrency', async () => {
    const { client, fetch } = setup([
      json(200, { CompanyInfo: { Country: 'US', CompanyName: 'Sandbox Co' } }),
      json(200, { Preferences: { CurrencyPrefs: { MultiCurrencyEnabled: false, HomeCurrency: { value: 'USD' } } } }),
    ]);
    expect(await client.companyContext()).toEqual({ country: 'US', homeCurrency: 'USD', multiCurrencyEnabled: false });
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual([
      `/v3/company/${REALM}/companyinfo/${REALM}`,
      `/v3/company/${REALM}/preferences`,
    ]);
  });
});
