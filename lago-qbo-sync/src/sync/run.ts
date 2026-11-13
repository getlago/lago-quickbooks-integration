import { ConfigError } from '../config/errors.js';
import type { Mappings } from '../config/schema.js';
import { systemClock, type Clock } from '../http/clock.js';
import type { LagoClient } from '../lago/client.js';
import type { LagoCreditNote, LagoCustomer, LagoInvoice, LagoInvoiceSummary } from '../lago/types.js';
import type { Logger } from '../log/logger.js';
import type { QboClient } from '../qbo/client.js';
import { AuthError, describeQboError, WritesDisabledError } from '../qbo/errors.js';
import {
  customerByDisplayName,
  allCustomersPage,
  customersByDisplayNames,
  QUERY_IN_MAX,
  QUERY_MAX_RESULTS,
  txnByDocNumber,
  txnsByDocNumbers,
  type TxnEntity,
} from '../qbo/query.js';
import { chunks, groupBatchLookup } from './batchLookup.js';
import type { CompanyContext, QboCustomerRow, QboTxnRow } from '../qbo/types.js';
import {
  currencyProblem,
  decideCustomer,
  decideDocument,
  decidePayment,
  decideVoid,
  lagoIdFromNotes,
  ownedBy,
  type Lookup,
} from '../reconcile/index.js';
import { toQboCreditMemo } from '../transform/creditMemo.js';
import { customerDisplayName, toQboCustomer } from '../transform/customer.js';
import { checkDocNumber, type DocKind } from '../transform/docNumber.js';
import { EMPTY_INVOICE_REASON, isEmptyInvoice, isOutOfScopeInvoice, toQboInvoice } from '../transform/invoice.js';
import type { TransformResult } from '../transform/result.js';
import { TokenStoreError, type TokenStore } from '../tokenStore/types.js';
import { forEachLimit, windowStart } from './pool.js';
import { runReconciliation } from './reconcilePass.js';
import { SummaryBuilder, type Entity, type RunSummary } from './summary.js';

/** What sync needs from the Lago client (read-only). */
export type LagoReader = Pick<LagoClient, 'listInvoices' | 'getInvoice' | 'listCreditNotes' | 'getCreditNote' | 'stats'>;
/** What sync needs from the QBO client. */
export type QboApi = Pick<QboClient, 'query' | 'companyContext' | 'create' | 'sparseUpdateCustomer' | 'voidInvoice' | 'stats'>;

export interface SyncDeps {
  mappings: Mappings;
  lago: LagoReader;
  qbo: QboApi;
  /** Refreshes the token at start (brief §4.3 step 3). */
  auth: { getAccessToken(): Promise<string> };
  tokenStore: TokenStore;
  log: Logger;
  mode: 'apply' | 'dry-run';
  clock?: Clock;
}

/**
 * One sync run (brief §4.3): lock → refresh token → fetch → customers → invoices → credit notes →
 * payments → voids → read-only reconciliation → unlock → summary. Never throws for document
 * problems; only bugs escape.
 */
export async function runSync(deps: SyncDeps): Promise<RunSummary> {
  const clock = deps.clock ?? systemClock;
  const sb = new SummaryBuilder({
    mode: deps.mode,
    environment: deps.mappings.environment,
    realm_id: deps.mappings.qbo.realm_id,
    startedAt: clock.now(),
  });
  const finish = (status: Parameters<SummaryBuilder['build']>[0]['status'], message?: string, staleLock = false) =>
    sb.build({
      status,
      finishedAt: clock.now(),
      qbo: deps.qbo.stats,
      lagoCalls: deps.lago.stats.calls,
      ...(message ? { message } : {}),
      staleLock,
    });

  let locked = false;
  try {
    const lock = await deps.tokenStore.lock();
    if (!lock.acquired) {
      const h = lock.holder;
      const who = h ? ` (pid ${h.pid} on ${h.host}, started ${h.started_at})` : ' (lock file unreadable)';
      if (lock.stale) {
        // Exit 1, not 0: a stale lock stops every run until a person clears it (code review 2026-11-12).
        return finish('locked', `the run lock looks stale${who}; nothing was synced. A person must clear it: README › Runbooks › Stale lock`, true);
      }
      return finish('locked', `another run in progress${who}`);
    }
    locked = true;

    await deps.auth.getAccessToken();
    const company = await deps.qbo.companyContext();
    if (company.country !== 'US') {
      return finish('config_error', `QBO company country is ${company.country}; only US companies are supported (PLAN.md Q8)`);
    }
    await new SyncRun(deps, sb, company, clock).execute();
    return finish('completed');
  } catch (err) {
    if (err instanceof AuthError || err instanceof TokenStoreError) return finish('auth_error', err.message);
    if (err instanceof ConfigError) return finish('config_error', err.message);
    if (err instanceof WritesDisabledError) throw err; // a bug: dry-run reached a write
    deps.log.error('run aborted', { error: err });
    return finish('aborted', describeQboError(err));
  } finally {
    if (locked) await deps.tokenStore.unlock();
  }
}

type CustomerResolution = { ok: true; qboId: string | null } | { ok: false; reason: string };

class SyncRun {
  private readonly m: Mappings;
  private readonly apply: boolean;
  private readonly customers = new Map<string, CustomerResolution>();
  private lagoIdIndex: Promise<Map<string, QboCustomerRow[]>> | null = null;
  /** Batched existence answers, keyed "Invoice:<number>" / "CreditMemo:<number>". */
  private readonly existing = new Map<string, Lookup<QboTxnRow>>();

  constructor(
    private readonly deps: SyncDeps,
    private readonly sb: SummaryBuilder,
    private readonly company: CompanyContext,
    private readonly clock: Clock,
  ) {
    this.m = deps.mappings;
    this.apply = deps.mode === 'apply';
  }

  async execute(): Promise<void> {
    const now = this.clock.now();
    const sync = this.m.sync;
    const issuedFrom = windowStart(now, sync.lookback_days);
    this.sb.windows = {
      documents_issued_from: issuedFrom,
      ...(sync.sync_payments ? { payments_issued_from: windowStart(now, sync.payment_lookback_days) } : {}),
      ...(sync.sync_voids ? { voids_issued_from: windowStart(now, sync.void_lookback_days) } : {}),
      reconcile_issued_from: windowStart(now, sync.reconcile_lookback_days),
    };

    // Review on PR #8: the window must be wide (default 45 days) so an invoice finalized late (a
    // grace period with keep_anchor issuing dates) or issued during an outage is still created.
    // To keep that cheap, the cheap list calls and the batched QBO existence check come first, and
    // Lago details are read only for documents that are not already in QBO as ours.
    const invoiceList = await this.listInvoicesInScope(issuedFrom);
    const creditNoteList = await this.listOrFail('credit_note', () => this.deps.lago.listCreditNotes({ issuing_date_from: issuedFrom }));
    await this.prefetchExisting('Invoice', invoiceList.map((i) => i.number));
    await this.prefetchExisting('CreditMemo', creditNoteList.map((c) => c.number));
    const fetched = await this.fetchDetails('invoice', this.notYetSynced('invoice', 'Invoice', invoiceList), (id) =>
      this.deps.lago.getInvoice(id),
    );
    const creditNotes = await this.fetchDetails('credit_note', this.notYetSynced('credit_note', 'CreditMemo', creditNoteList), (id) =>
      this.deps.lago.getCreditNote(id),
    );

    // Empty invoices are reported, not synced; their customers are not created for them alone.
    const invoices = fetched.filter((inv) => {
      if (!isEmptyInvoice(inv)) return true;
      this.sb.record('invoice', 'skipped', { lago_number: inv.number, lago_id: inv.lago_id, reason: EMPTY_INVOICE_REASON });
      return false;
    });

    await this.customerPass(
      [...invoices.map((i) => i.customer), ...creditNotes.map((c) => c.customer)],
      invoiceList.flatMap((i) => (i.customer ? [i.customer] : [])),
    );
    await this.each(invoices, (inv) => this.invoiceDoc(inv));
    await this.each(creditNotes, (cn) => this.creditNoteDoc(cn));
    if (sync.sync_payments) await this.paymentPass(this.sb.windows.payments_issued_from!);
    if (sync.sync_voids) await this.voidPass(this.sb.windows.voids_issued_from!);

    this.sb.missing = await runReconciliation({
      lago: this.deps.lago,
      qbo: this.deps.qbo,
      rules: this.m.lago.invoice_prefix_rules,
      issuedFrom: this.sb.windows.reconcile_issued_from!,
      maxLookups: sync.reconcile_max_lookups,
      log: this.deps.log,
    });
  }

  // ---- fetch ---------------------------------------------------------------------------------

  private async listInvoicesInScope(from: string): Promise<LagoInvoiceSummary[]> {
    const list = await this.listOrFail('invoice', () => this.deps.lago.listInvoices({ status: 'finalized', issuing_date_from: from }));
    return list.filter((summary) => {
      if (!isOutOfScopeInvoice(summary)) return true;
      this.sb.walletTopups++;
      return false;
    });
  }

  /**
   * Documents the batched existence check already found in QBO as ours (exactly one match, carrying
   * the Lago id) are counted as skipped here, without reading their Lago details. Everything else
   * (absent, foreign, duplicated, or not batch-answerable) goes through the full per-document path.
   */
  private notYetSynced<S extends { lago_id: string; number: string }>(entity: 'invoice' | 'credit_note', qboEntity: TxnEntity, list: readonly S[]): S[] {
    return list.filter((doc) => {
      const known = this.existing.get(`${qboEntity}:${doc.number}`);
      const synced = known?.kind === 'found' && known.rows.length === 1 && ownedBy(known.rows[0]!, doc.lago_id);
      if (synced) this.sb.record(entity, 'skipped');
      return !synced;
    });
  }

  /**
   * Lago detail GETs run `lago_max_concurrent` at a time under the Lago throttle (they are reads, and
   * Lago allows 50/s). Results keep the list order, so the QBO passes stay deterministic.
   */
  private async fetchDetails<S extends { lago_id: string; number: string }, D>(
    entity: Entity,
    list: readonly S[],
    get: (lagoId: string) => Promise<D>,
  ): Promise<D[]> {
    const slots: Array<D | undefined> = new Array(list.length);
    const indexed = list.map((summary, i) => ({ summary, i }));
    await forEachLimit(indexed, this.m.sync.lago_max_concurrent, ({ summary, i }) =>
      this.guard(entity, summary, async () => {
        slots[i] = await get(summary.lago_id);
      }),
    );
    return slots.filter((d): d is D => d !== undefined);
  }

  /** A failed Lago list fails that pass (one failure entry), not the run. Invalid entries are failures too. */
  private async listOrFail<T extends { lago_id: string; number: string }>(
    entity: Entity,
    list: () => Promise<{ items: T[]; invalid: Array<{ lago_id?: string; number?: string; reason: string }> }>,
  ): Promise<T[]> {
    try {
      const result = await list();
      for (const bad of result.invalid) {
        this.sb.record(entity, 'failed', {
          lago_number: bad.number ?? '(unknown)',
          ...(bad.lago_id ? { lago_id: bad.lago_id } : {}),
          reason: `Lago record is missing required fields: ${bad.reason}`,
        });
      }
      return result.items;
    } catch (err) {
      this.rethrowIfFatal(err);
      this.sb.record(entity, 'failed', { lago_number: '(list)', reason: `could not list from Lago: ${describeQboError(err)}` });
      return [];
    }
  }

  // ---- customers -----------------------------------------------------------------------------

  /**
   * `needed`: customers of documents this run will create; they are created if absent.
   * `refreshOnly`: customers of every invoice in the window (from the list call); they are kept up
   * to date and renamed when they already exist in QBO, but never created for that reason alone.
   */
  private async customerPass(needed: LagoCustomer[], refreshOnly: LagoCustomer[]): Promise<void> {
    const neededIds = new Set(needed.map((c) => c.lago_id));
    const unique = [...new Map([...refreshOnly, ...needed].map((c) => [c.lago_id, c])).values()];
    const known = await this.prefetchCustomers(unique);
    await this.each(unique, async (c) => {
      const note = { lago_number: c.external_id, lago_id: c.lago_id };
      const fail = (reason: string) => {
        this.customers.set(c.lago_id, { ok: false, reason });
        this.sb.record('customer', 'failed', { ...note, reason });
      };
      try {
        const t = toQboCustomer(c);
        if (!t.ok) return fail(t.reason);
        const desired = t.value;
        if (desired.CurrencyRef) {
          const problem = currencyProblem(`Customer "${desired.DisplayName}"`, desired.CurrencyRef.value, this.company);
          if (problem) return fail(problem);
        }
        const lookupCustomer = () => this.deps.qbo.query<QboCustomerRow>(customerByDisplayName(desired.DisplayName), 'Customer');
        // Batched answer when the prefetch could give one with certainty, else the single lookup.
        const found = known.get(desired.DisplayName) ?? (await lookupCustomer());
        // Not found by name: maybe renamed in Lago. Look for its Lago id in QBO Notes before creating.
        const byLagoId = found.kind === 'none' ? ((await this.customersByLagoId()).get(c.lago_id) ?? []) : [];
        const decision = decideCustomer(desired, c.lago_id, found, byLagoId);
        if (decision.action === 'create' && !neededIds.has(c.lago_id)) return; // no document needs it
        switch (decision.action) {
          case 'skip':
            this.customers.set(c.lago_id, { ok: true, qboId: found.kind === 'found' ? found.rows[0]!.Id : null });
            this.sb.record('customer', 'skipped');
            return;
          case 'update':
            if (this.apply) await this.deps.qbo.sparseUpdateCustomer(decision.payload);
            this.customers.set(c.lago_id, { ok: true, qboId: decision.payload.Id });
            this.sb.record('customer', this.apply ? 'updated' : 'would_update');
            return;
          case 'create': {
            if (!this.apply) {
              this.customers.set(c.lago_id, { ok: true, qboId: null });
              this.sb.record('customer', 'would_create');
              return;
            }
            const created = await this.deps.qbo.create('customer', desired, () => this.firstMatch(lookupCustomer, () => true));
            this.customers.set(c.lago_id, { ok: true, qboId: created.row.Id });
            this.sb.record('customer', created.recovered ? 'skipped' : 'created');
            return;
          }
          case 'fail':
            return fail(decision.reason);
          default:
            throw new Error(`unexpected customer decision ${decision.action}`);
        }
      } catch (err) {
        this.rethrowIfFatal(err);
        fail(`Customer "${c.external_id}": ${describeQboError(err)}`);
      }
    });
  }

  // ---- invoices and credit notes ---------------------------------------------------------------

  private invoiceDoc(inv: LagoInvoice): Promise<void> {
    return this.syncDocument(
      'invoice',
      'Invoice',
      inv,
      inv.customer.lago_id,
      () => toQboInvoice(inv, this.m),
      (payload, findExisting) => this.deps.qbo.create('invoice', payload, findExisting),
    );
  }

  private creditNoteDoc(cn: LagoCreditNote): Promise<void> {
    return this.syncDocument(
      'credit_note',
      'CreditMemo',
      cn,
      cn.customer.lago_id,
      () => toQboCreditMemo(cn, this.m),
      (payload, findExisting) => this.deps.qbo.create('creditmemo', payload, findExisting),
    );
  }

  /** Shared flow (n8n Transform → Finalize → Lookup → Exists? → Skip/Create), brief §5.3. */
  private async syncDocument<P extends { CustomerRef?: { value: string } }>(
    entity: 'invoice' | 'credit_note',
    qboEntity: TxnEntity,
    doc: { lago_id: string; number: string; currency: string },
    lagoCustomerId: string,
    transform: () => TransformResult<{ payload: P; taxOverride: boolean }>,
    create: (payload: P, findExisting: () => Promise<QboTxnRow | null>) => Promise<{ recovered: boolean }>,
  ): Promise<void> {
    const note = { lago_number: doc.number, lago_id: doc.lago_id };
    const label = `${entity === 'invoice' ? 'Invoice' : 'Credit note'} ${doc.number}`;
    const fail = (reason: string) => this.sb.record(entity, 'failed', { ...note, reason });
    try {
      const check = checkDocNumber(doc.number, entity as DocKind, this.m.lago.invoice_prefix_rules);
      if (!check.ok) return fail(check.reason);
      const t = transform();
      if (!t.ok) return fail(t.reason);
      const currency = currencyProblem(label, doc.currency, this.company);
      if (currency) return fail(currency);
      const customer = this.customers.get(lagoCustomerId);
      if (!customer) return fail(`${label}: customer ${lagoCustomerId} was not processed`);
      if (!customer.ok) return fail(`${label}: its customer could not be synced (${customer.reason})`);

      const lookup = () => this.deps.qbo.query<QboTxnRow>(txnByDocNumber(qboEntity, doc.number), qboEntity);
      // Batched answer when the prefetch could give one with certainty, else the single lookup.
      const known = this.existing.get(`${qboEntity}:${doc.number}`);
      const decision = decideDocument(label, check, known ?? (await lookup()), doc.lago_id);
      if (decision.action === 'skip') return this.sb.record(entity, 'skipped');
      if (decision.action === 'fail') return fail(decision.reason);

      if (!t.value.taxOverride) {
        this.sb.warn(entity, { ...note, reason: 'Lago charged tax but qbo.tax_code_id is empty: QBO computes its own tax' });
      }
      if (!this.apply) return this.sb.record(entity, 'would_create');
      if (!customer.qboId) return fail(`${label}: customer has no QBO Id`);
      // n8n "Finalize Invoice" / "Finalize Credit Note": attach the resolved customer.
      const created = await create({ ...t.value.payload, CustomerRef: { value: customer.qboId } }, () =>
        this.firstMatch(lookup, (row) => ownedBy(row, doc.lago_id)),
      );
      this.sb.record(entity, created.recovered ? 'skipped' : 'created');
    } catch (err) {
      this.rethrowIfFatal(err);
      fail(`${label}: ${describeQboError(err)}`);
    }
  }

  /**
   * Existence checks in batches of 50 (`DocNumber IN (…)`, PLAN.md §9 option A): about 50× fewer
   * QBO calls for a large window. Only numbers that pass the DocNumber guards and can be quoted are
   * batched. A batch that fails leaves its numbers unanswered, so each document falls back to its
   * single lookup and fails on its own if that fails too: a failure never becomes "none" (bug #5).
   */
  private async prefetchExisting(entity: TxnEntity, numbers: readonly string[]): Promise<void> {
    const kind: DocKind = entity === 'Invoice' ? 'invoice' : 'credit_note';
    const batchable = [
      ...new Set(
        numbers.filter((n) => {
          const check = checkDocNumber(n, kind, this.m.lago.invoice_prefix_rules);
          return check.ok && check.compliant && !/[\\\u0000-\u001f\u007f]/.test(n);
        }),
      ),
    ];
    const answered = await this.batchLookup(batchable, (chunk) => txnsByDocNumbers(entity, chunk), entity, (r: QboTxnRow) => r.DocNumber);
    for (const [n, lookup] of answered) this.existing.set(`${entity}:${n}`, lookup);
  }

  /**
   * QBO customers indexed by the Lago id in their Notes, built once per run and only when a customer
   * is not found by name (one query per 1,000 QBO customers, inactive ones included).
   */
  private customersByLagoId(): Promise<Map<string, QboCustomerRow[]>> {
    this.lagoIdIndex ??= (async () => {
      const index = new Map<string, QboCustomerRow[]>();
      for (let start = 1; ; start += QUERY_MAX_RESULTS) {
        const page = await this.deps.qbo.query<QboCustomerRow>(allCustomersPage(start), 'Customer');
        const rows = page.kind === 'found' ? page.rows : [];
        for (const row of rows) {
          const id = lagoIdFromNotes(row.Notes);
          if (id) index.set(id, [...(index.get(id) ?? []), row]);
        }
        if (rows.length < QUERY_MAX_RESULTS) return index;
      }
    })();
    return this.lagoIdIndex;
  }

  /** Customers by DisplayName, batched like documents; names that cannot be quoted get single lookups. */
  private async prefetchCustomers(customers: readonly LagoCustomer[]): Promise<Map<string, Lookup<QboCustomerRow>>> {
    const names = [
      ...new Set(
        customers
          .map((c) => customerDisplayName(c))
          .filter((n): n is string => !!n && !/[\\\u0000-\u001f\u007f]/.test(n)),
      ),
    ];
    return this.batchLookup(names, customersByDisplayNames, 'Customer', (r: QboCustomerRow) => r.DisplayName);
  }

  /**
   * Runs `IN (…)` lookups 50 values at a time and returns the values each batch could answer with
   * certainty (groupBatchLookup). A failed batch is logged and leaves its values unanswered, so they
   * fall back to single lookups: a failure never becomes "none" (bug #5).
   */
  private async batchLookup<Row>(
    values: readonly string[],
    statement: (chunk: readonly string[]) => string,
    entityKey: string,
    keyOf: (row: Row) => string | undefined,
  ): Promise<Map<string, Lookup<Row>>> {
    const out = new Map<string, Lookup<Row>>();
    for (const chunk of chunks(values, QUERY_IN_MAX)) {
      try {
        const result = await this.deps.qbo.query<Row>(statement(chunk), entityKey);
        for (const [v, lookup] of groupBatchLookup(chunk, result.kind === 'found' ? result.rows : [], keyOf)) out.set(v, lookup);
      } catch (err) {
        this.rethrowIfFatal(err);
        this.deps.log.warn('batched lookup failed; falling back to one lookup per value', { entity: entityKey, values: chunk.length, error: err });
      }
    }
    return out;
  }

  // ---- payments ------------------------------------------------------------------------------

  /** brief §5.3 payments, §6 bug #4: ordered after invoices; a missing invoice defers. */
  private async paymentPass(from: string): Promise<void> {
    const paid = await this.listOrFail('payment', () =>
      this.deps.lago.listInvoices({ status: 'finalized', payment_status: 'succeeded', issuing_date_from: from }),
    );
    await this.each(
      paid.filter((i) => !isOutOfScopeInvoice(i)),
      (inv) =>
        this.guard('payment', inv, async () => {
          const note = { lago_number: inv.number, lago_id: inv.lago_id };
          // A $0 invoice has nothing to pay; an empty one is never in QBO and would otherwise defer forever.
          if (inv.total_amount_cents === 0) return this.sb.record('payment', 'skipped');
          const check = checkDocNumber(inv.number, 'invoice', this.m.lago.invoice_prefix_rules);
          if (!check.ok) return this.sb.record('payment', 'failed', { ...note, reason: check.reason });
          const lookup = () => this.deps.qbo.query<QboTxnRow>(txnByDocNumber('Invoice', inv.number), 'Invoice');
          const found = await lookup();
          if (found.kind === 'none' && !check.compliant) {
            return this.sb.record('payment', 'failed', {
              ...note,
              reason: `Payment for invoice ${inv.number}: the number contains characters QBO lookups cannot match`,
            });
          }
          const decision = decidePayment(this.paidInvoice(inv), found);
          switch (decision.action) {
            case 'defer':
              return this.sb.record('payment', 'deferred', { ...note, reason: decision.reason });
            case 'skip':
              return this.sb.record('payment', 'skipped');
            case 'fail':
              return this.sb.record('payment', 'failed', { ...note, reason: decision.reason });
            case 'create_payment': {
              if (!this.apply) return this.sb.record('payment', 'would_create');
              // After an ambiguous failure, the payment landed if the invoice balance is now 0.
              const landed = async () => {
                const again = await lookup();
                const row = again.kind === 'found' ? again.rows[0] : undefined;
                return row && row.Balance === 0 ? row : null;
              };
              const r = await this.deps.qbo.create('payment', decision.payload, landed);
              return this.sb.record('payment', r.recovered ? 'skipped' : 'created');
            }
            default:
              throw new Error(`unexpected payment decision ${decision.action}`);
          }
        }),
    );
  }

  private paidInvoice(inv: LagoInvoiceSummary) {
    return {
      lago_id: inv.lago_id,
      number: inv.number,
      currency: inv.currency,
      total_amount_cents: inv.total_amount_cents,
      payment_status: inv.payment_status,
    };
  }

  // ---- voids ---------------------------------------------------------------------------------

  private async voidPass(from: string): Promise<void> {
    const voided = await this.listOrFail('void', () => this.deps.lago.listInvoices({ status: 'voided', issuing_date_from: from }));
    await this.each(
      voided.filter((i) => !isOutOfScopeInvoice(i)),
      (inv) =>
        this.guard('void', inv, async () => {
          const note = { lago_number: inv.number, lago_id: inv.lago_id };
          const check = checkDocNumber(inv.number, 'invoice', this.m.lago.invoice_prefix_rules);
          // A number QBO cannot hold was never created there.
          if (!check.ok) return this.sb.record('void', 'skipped');
          const found = await this.deps.qbo.query<QboTxnRow>(txnByDocNumber('Invoice', inv.number), 'Invoice');
          if (found.kind === 'none' && !check.compliant) {
            // It may have been created by the n8n workflow before the fix; an empty lookup proves nothing.
            return this.sb.record('void', 'failed', {
              ...note,
              reason: `Void invoice ${inv.number}: the number contains characters QBO lookups cannot match; void it by hand in QBO if it exists`,
            });
          }
          const decision = decideVoid(inv.number, inv.lago_id, found);
          if (decision.action === 'skip') return this.sb.record('void', 'skipped');
          if (decision.action === 'fail') return this.sb.record('void', 'failed', { ...note, reason: decision.reason });
          if (decision.action !== 'void') throw new Error(`unexpected void decision ${decision.action}`);
          if (!this.apply) return this.sb.record('void', 'would_void');
          await this.deps.qbo.voidInvoice(decision.payload);
          this.sb.record('void', 'voided');
        }),
    );
  }

  // ---- helpers -------------------------------------------------------------------------------

  private each<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
    return forEachLimit(items, this.m.sync.max_concurrent, fn);
  }

  /** Runs one document's work; any non-fatal error fails only that document (brief §5.4). */
  private async guard(entity: Entity, doc: { lago_id: string; number: string }, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.rethrowIfFatal(err);
      this.sb.record(entity, 'failed', { lago_number: doc.number, lago_id: doc.lago_id, reason: describeQboError(err) });
    }
  }

  /** Auth problems stop the run (exit 3); a write in dry-run is a bug. Everything else is per document. */
  private rethrowIfFatal(err: unknown): void {
    if (err instanceof AuthError || err instanceof TokenStoreError || err instanceof WritesDisabledError) throw err;
  }

  /** After an ambiguous create: is the document there now, and is it ours? */
  private async firstMatch<R>(lookup: () => Promise<Lookup<R>>, ours: (row: R) => boolean): Promise<R | null> {
    const again = await lookup();
    return again.kind === 'found' ? (again.rows.find(ours) ?? null) : null;
  }
}
