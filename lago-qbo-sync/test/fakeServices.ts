import type { InvoiceFilter, ListResult } from '../src/lago/client.js';
import type { LagoCreditNote, LagoCreditNoteSummary, LagoInvoice, LagoInvoiceSummary } from '../src/lago/types.js';
import type { Lookup } from '../src/reconcile/index.js';
import type { CompanyContext, QboCustomerRow, QboTxnRow } from '../src/qbo/types.js';
import type { LagoReader, QboApi } from '../src/sync/run.js';
import { qboTotalCents } from './helpers.js';

/**
 * In-memory stand-ins for Lago and QBO, so sync can be tested end to end (reruns, ordering,
 * dry-run) without a network. FakeQbo parses the statements built by qbo/query.ts and mimics the
 * QBO behaviors the brief describes, including bug #2: numbers containing `[` never match a lookup.
 */

const unescape = (s: string) => s.replace(/\\'/g, "'");
const LITERAL = "'((?:\\\\'|[^'])*)'";

export class FakeQbo {
  stats = { calls: 0, byStatus: {} as Record<string, number> };
  customers: QboCustomerRow[] = [];
  invoices: QboTxnRow[] = [];
  creditMemos: QboTxnRow[] = [];
  payments: Array<Record<string, unknown>> = [];
  writes: string[] = [];
  company: CompanyContext = { country: 'US', homeCurrency: 'USD', multiCurrencyEnabled: false };
  /** Return an Error to make a matching query fail (e.g. to test bug #5). */
  failQuery: (statement: string) => Error | undefined = () => undefined;
  /** Simulate QBO not supporting `DocNumber IN (...)`. */
  rejectInQueries = false;
  private nextId = 100;

  private hit(status = '200') {
    this.stats.calls++;
    this.stats.byStatus[status] = (this.stats.byStatus[status] ?? 0) + 1;
  }

  /** QBO lookups do not match numbers with `[` even when encoded (brief §6 bug #2). */
  private matches(docNumber: string | undefined, wanted: string): boolean {
    return docNumber === wanted && !wanted.includes('[');
  }

  async query<Row>(statement: string, entityKey: string): Promise<Lookup<Row>> {
    const failure = this.failQuery(statement);
    if (failure) {
      this.hit('500');
      throw failure;
    }
    let m: RegExpExecArray | null;
    let rows: unknown[] = [];
    if ((m = new RegExp(`^SELECT \\* FROM Customer WHERE DisplayName = ${LITERAL}$`).exec(statement))) {
      const name = unescape(m[1]!);
      rows = this.customers.filter((c) => c.DisplayName === name);
    } else if ((m = new RegExp(`^SELECT \\* FROM (Invoice|CreditMemo) WHERE DocNumber = ${LITERAL}$`).exec(statement))) {
      const wanted = unescape(m[2]!);
      rows = this.table(m[1]!).filter((r) => this.matches(r.DocNumber, wanted));
    } else if ((m = /^SELECT \* FROM Customer WHERE Active IN \(true, false\) STARTPOSITION (\d+) MAXRESULTS 1000$/.exec(statement))) {
      const start = Number(m[1]) - 1;
      rows = this.customers.slice(start, start + 1000);
    } else if ((m = /^SELECT \* FROM Customer WHERE DisplayName IN \((.*)\) MAXRESULTS 1000$/.exec(statement))) {
      if (this.rejectInQueries) {
        this.hit('400');
        const { HttpError } = await import('../src/http/errors.js');
        throw new HttpError('qbo', 'GET', '/query', 400, null, { Fault: { Error: [{ Message: 'QueryParserError' }] } });
      }
      const wanted = [...m[1]!.matchAll(new RegExp(LITERAL, 'g'))].map((x) => unescape(x[1]!));
      rows = this.customers.filter((c) => wanted.includes(c.DisplayName));
    } else if ((m = /^SELECT \* FROM (Invoice|CreditMemo) WHERE DocNumber IN \((.*)\) MAXRESULTS 1000$/.exec(statement))) {
      if (this.rejectInQueries) {
        this.hit('400');
        const { HttpError } = await import('../src/http/errors.js');
        throw new HttpError('qbo', 'GET', '/query', 400, null, { Fault: { Error: [{ Message: 'QueryParserError' }] } });
      }
      const wanted = [...m[2]!.matchAll(new RegExp(LITERAL, 'g'))].map((x) => unescape(x[1]!));
      rows = this.table(m[1]!).filter((r) => wanted.some((w) => this.matches(r.DocNumber, w)));
    } else {
      throw new Error(`FakeQbo cannot parse: ${statement}`);
    }
    this.hit();
    void entityKey;
    return rows.length === 0 ? { kind: 'none' } : { kind: 'found', rows: structuredClone(rows) as Row[] };
  }

  private table(entity: string): QboTxnRow[] {
    return entity === 'Invoice' ? this.invoices : this.creditMemos;
  }

  async companyContext(): Promise<CompanyContext> {
    this.hit();
    this.hit();
    return this.company;
  }

  async create(entity: string, payload: Record<string, unknown>): Promise<{ row: unknown; recovered: boolean }> {
    this.hit();
    this.writes.push(`create ${entity}`);
    const Id = String(this.nextId++);
    if (entity === 'customer') {
      const row = { ...structuredClone(payload), Id, SyncToken: '0' } as QboCustomerRow;
      this.customers.push(row);
      return { row, recovered: false };
    }
    if (entity === 'payment') {
      const line = (payload.Line as Array<{ Amount: number; LinkedTxn: Array<{ TxnId: string }> }>)[0]!;
      const inv = this.invoices.find((i) => i.Id === line.LinkedTxn[0]!.TxnId)!;
      inv.Balance = Math.round(((inv.Balance ?? 0) - line.Amount) * 100) / 100;
      this.payments.push({ ...payload, Id });
      return { row: { Id }, recovered: false };
    }
    const total = qboTotalCents(payload as never) / 100;
    const row: QboTxnRow = {
      ...structuredClone(payload),
      Id,
      SyncToken: '0',
      TotalAmt: total,
      Balance: entity === 'invoice' ? total : 0,
    } as QboTxnRow;
    (entity === 'invoice' ? this.invoices : this.creditMemos).push(row);
    return { row, recovered: false };
  }

  async sparseUpdateCustomer(payload: { Id: string } & Record<string, unknown>): Promise<QboCustomerRow> {
    this.hit();
    this.writes.push('update customer');
    const row = this.customers.find((c) => c.Id === payload.Id)!;
    const { sparse: _s, SyncToken: _t, ...fields } = payload;
    Object.assign(row, fields, { SyncToken: String(Number(row.SyncToken) + 1) });
    return row;
  }

  async voidInvoice(payload: { Id: string }): Promise<QboTxnRow> {
    this.hit();
    this.writes.push('void invoice');
    const row = this.invoices.find((i) => i.Id === payload.Id)!;
    // What QBO does, observed in the sandbox: amounts to 0 and a "Voided - " PrivateNote prefix.
    Object.assign(row, {
      TotalAmt: 0,
      Balance: 0,
      PrivateNote: `Voided - ${row.PrivateNote ?? ''}`,
      SyncToken: String(Number(row.SyncToken) + 1),
    });
    return row;
  }

  asApi(): QboApi {
    return this as unknown as QboApi;
  }
}

function invoiceSummary(i: LagoInvoice): LagoInvoiceSummary {
  const { fees: _f, credits: _c, ...rest } = i;
  return rest;
}

export class FakeLago {
  stats = { calls: 0 };
  constructor(
    public invoices: LagoInvoice[],
    public creditNotes: LagoCreditNote[],
  ) {
    // Real Lago returns a customer's current data on every document. Fixtures are written
    // independently, so give every document the first fixture's version of its customer.
    const canonical = new Map<string, LagoInvoice['customer']>();
    for (const doc of [...invoices, ...creditNotes]) {
      if (!canonical.has(doc.customer.lago_id)) canonical.set(doc.customer.lago_id, structuredClone(doc.customer));
      doc.customer = structuredClone(canonical.get(doc.customer.lago_id)!);
    }
  }

  async listInvoices(filter: InvoiceFilter): Promise<ListResult<LagoInvoiceSummary>> {
    this.stats.calls++;
    const items = this.invoices
      .filter((i) => i.status === filter.status)
      .filter((i) => !filter.payment_status || i.payment_status === filter.payment_status)
      .filter((i) => i.issuing_date >= filter.issuing_date_from)
      .map(invoiceSummary);
    return { items: structuredClone(items), invalid: [] };
  }

  async getInvoice(lagoId: string): Promise<LagoInvoice> {
    this.stats.calls++;
    const found = this.invoices.find((i) => i.lago_id === lagoId);
    if (!found) throw new Error(`no invoice ${lagoId}`);
    return structuredClone(found);
  }

  async listCreditNotes(filter: { issuing_date_from: string }): Promise<ListResult<LagoCreditNoteSummary>> {
    this.stats.calls++;
    const items = this.creditNotes
      .filter((c) => c.issuing_date >= filter.issuing_date_from)
      .map((c) => ({ lago_id: c.lago_id, number: c.number, issuing_date: c.issuing_date }));
    return { items, invalid: [] };
  }

  async getCreditNote(lagoId: string): Promise<LagoCreditNote> {
    this.stats.calls++;
    const found = this.creditNotes.find((c) => c.lago_id === lagoId);
    if (!found) throw new Error(`no credit note ${lagoId}`);
    return structuredClone(found);
  }

  asReader(): LagoReader {
    return this as unknown as LagoReader;
  }
}
