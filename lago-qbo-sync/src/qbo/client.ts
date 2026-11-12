import { z } from 'zod';
import type { Mappings } from '../config/schema.js';
import { systemClock, type Clock } from '../http/clock.js';
import { HttpError, NetworkError } from '../http/errors.js';
import { sendRequest, type FetchLike } from '../http/request.js';
import { classifyRead, classifyWrite, withRetry, type Classify } from '../http/retry.js';
import type { Throttle } from '../http/throttle.js';
import type { Logger } from '../log/logger.js';
import type { Lookup } from '../reconcile/index.js';
import { AuthError, parseFault, QboFaultError, QboLookupError, WritesDisabledError } from './errors.js';
import { qboUrl, type QboPath } from './query.js';
import type {
  CompanyContext,
  QboCreditMemoPayload,
  QboCustomerPayload,
  QboCustomerRow,
  QboCustomerUpdate,
  QboInvoicePayload,
  QboPaymentPayload,
  QboTxnRow,
  QboVoidPayload,
} from './types.js';

/** What the client needs from auth: a cached token, and a forced refresh after a 401. */
export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
  /**
   * Called after a 401 with the token that was rejected. If a newer token already exists (another
   * request refreshed meanwhile), the source returns it instead of asking Intuit again.
   */
  refresh(rejectedToken?: string): Promise<string>;
}

/** How long to wait before checking whether an unconfirmed create landed (QBO can commit late). */
const VERIFY_DELAY_MS = 5_000;

/**
 * A create that QBO did not confirm (5xx or timeout) and that a later lookup did not find. It is
 * not resent in this run: QBO may still commit it, and a resend could create a duplicate. The
 * document fails; the next run looks it up again and creates it only if it is still missing.
 */
export class UnconfirmedWriteError extends Error {
  override readonly name = 'UnconfirmedWriteError';
}

export interface QboClientOptions {
  environment: Mappings['environment'];
  realmId: string;
  minorVersion: number;
  auth: AccessTokenSource;
  fetch: FetchLike;
  /** The single QBO queue (brief §5.4). */
  throttle: Throttle;
  log: Logger;
  /** 'disabled' in dry-run: any write method throws before touching the network. */
  writes: 'enabled' | 'disabled';
  clock?: Clock;
  random?: () => number;
}

/** Per-status call counts for the run summary (brief §3: "every QBO call returned 200"). */
export interface QboStats {
  calls: number;
  byStatus: Record<string, number>;
}

/** Writable entities (brief §8 least privilege) and the key QBO wraps each response in. */
const ENTITY_KEY = {
  customer: 'Customer',
  invoice: 'Invoice',
  creditmemo: 'CreditMemo',
  payment: 'Payment',
} as const;
type WritableEntity = keyof typeof ENTITY_KEY;

type CreatePayload = {
  customer: QboCustomerPayload;
  invoice: QboInvoicePayload;
  creditmemo: QboCreditMemoPayload;
  payment: QboPaymentPayload;
};

export interface CreateResult<Row> {
  row: Row;
  /**
   * true when the POST failed ambiguously (5xx / timeout) but the follow-up lookup found the
   * document: it had been created, and was not created again (PLAN.md §4.7).
   */
  recovered: boolean;
}

const companyInfoSchema = z.looseObject({ CompanyInfo: z.looseObject({ Country: z.string() }) });
const preferencesSchema = z.looseObject({
  Preferences: z.looseObject({
    CurrencyPrefs: z.looseObject({
      MultiCurrencyEnabled: z.boolean().optional(),
      HomeCurrency: z.looseObject({ value: z.string() }),
    }),
  }),
});

/** A 5xx or no response: the write may or may not have been applied. */
const isAmbiguous = (err: unknown) => err instanceof NetworkError || (err instanceof HttpError && err.status >= 500);

export class QboClient {
  readonly stats: QboStats = { calls: 0, byStatus: {} };
  private readonly clock: Clock;

  constructor(private readonly opts: QboClientOptions) {
    this.clock = opts.clock ?? systemClock;
  }

  // ---- reads -------------------------------------------------------------------------------

  /**
   * Runs a statement built by qbo/query.ts. Returns "none" only when QBO answers with a
   * QueryResponse that has no rows for `entityKey`; anything else is an error (brief §6 bug #5).
   */
  async query<Row>(statement: string, entityKey: string): Promise<Lookup<Row>> {
    const body = await this.call('GET', this.url({ kind: 'query' }, { query: statement }), undefined, classifyRead);
    const response = (body as { QueryResponse?: unknown } | null)?.QueryResponse;
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      throw new QboLookupError(`QBO query for ${entityKey} returned no QueryResponse; cannot tell whether it exists`);
    }
    const rows = (response as Record<string, unknown>)[entityKey];
    if (rows === undefined) return { kind: 'none' };
    if (!Array.isArray(rows)) throw new QboLookupError(`QBO query for ${entityKey} returned a malformed result`);
    return rows.length === 0 ? { kind: 'none' } : { kind: 'found', rows: rows as Row[] };
  }

  /** Country, home currency and multicurrency flag, read once per run. */
  async companyContext(): Promise<CompanyContext> {
    const info = companyInfoSchema.safeParse(await this.call('GET', this.url({ kind: 'companyinfo' }), undefined, classifyRead));
    const prefs = preferencesSchema.safeParse(await this.call('GET', this.url({ kind: 'preferences' }), undefined, classifyRead));
    if (!info.success || !prefs.success) throw new QboLookupError('QBO company info or preferences had an unexpected format');
    const currency = prefs.data.Preferences.CurrencyPrefs;
    return {
      country: info.data.CompanyInfo.Country,
      homeCurrency: currency.HomeCurrency.value,
      multiCurrencyEnabled: currency.MultiCurrencyEnabled ?? false,
    };
  }

  // ---- writes ------------------------------------------------------------------------------

  /**
   * Creates a document. QBO does not enforce unique DocNumber, so a POST that fails ambiguously
   * (5xx, timeout) is never repeated in the same run: after a short wait, `findExisting` checks
   * whether it landed; if not, the document fails with UnconfirmedWriteError and the next run decides
   * (code review 2026-11-12: an immediate lookup could miss a late commit and the resend duplicate it).
   */
  async create<E extends WritableEntity, Row>(
    entity: E,
    payload: CreatePayload[E],
    findExisting: () => Promise<Row | null>,
  ): Promise<CreateResult<Row>> {
    this.assertWrites(`create ${entity}`);
    const url = this.url({ kind: 'entity', entity });
    const body = JSON.stringify(payload);
    try {
      return { row: this.unwrap<Row>(entity, await this.call('POST', url, body, classifyWrite)), recovered: false };
    } catch (err) {
      if (!isAmbiguous(err)) throw err;
      this.opts.log.warn('qbo create failed ambiguously; checking whether it was applied', { entity, error: err });
      await this.clock.sleep(VERIFY_DELAY_MS);
      const existing = await findExisting();
      if (existing) return { row: existing, recovered: true };
      throw new UnconfirmedWriteError(
        `QBO did not confirm the ${entity} create (${err instanceof NetworkError ? 'no response' : `HTTP ${(err as HttpError).status}`}) and it is not in QBO yet; not resent, to avoid a duplicate. The next run creates it if it is still missing`,
      );
    }
  }

  /** Sparse customer update. SyncToken makes a repeated update fail rather than apply twice. */
  async sparseUpdateCustomer(payload: QboCustomerUpdate): Promise<QboCustomerRow> {
    this.assertWrites('update customer');
    const body = await this.call('POST', this.url({ kind: 'entity', entity: 'customer' }), JSON.stringify(payload), classifyWrite);
    return this.unwrap<QboCustomerRow>('customer', body);
  }

  /** `POST /invoice?operation=void` with Id + SyncToken (n8n "Void Invoice in QB"). */
  async voidInvoice(payload: QboVoidPayload): Promise<QboTxnRow> {
    this.assertWrites('void invoice');
    const url = this.url({ kind: 'entity', entity: 'invoice' }, { operation: 'void' });
    return this.unwrap<QboTxnRow>('invoice', await this.call('POST', url, JSON.stringify(payload), classifyWrite));
  }

  // ---- plumbing ----------------------------------------------------------------------------

  private url(path: QboPath, params: Record<string, string> = {}): string {
    return qboUrl(this.opts.environment, this.opts.realmId, this.opts.minorVersion, path, params);
  }

  private assertWrites(what: string): void {
    if (this.opts.writes !== 'enabled') throw new WritesDisabledError(`refusing to ${what}: writes are disabled (dry-run)`);
  }

  private unwrap<Row>(entity: WritableEntity, body: unknown): Row {
    const row = (body as Record<string, unknown> | null)?.[ENTITY_KEY[entity]];
    if (row === null || typeof row !== 'object') throw new QboLookupError(`QBO ${entity} response has no ${ENTITY_KEY[entity]} object`);
    return row as Row;
  }

  /**
   * One logical call: retries per `classify` through the shared throttle, and on 401 refreshes the
   * token once and tries again (brief §5.4). A second 401 is an AuthError (exit code 3).
   */
  private async call(method: 'GET' | 'POST', url: string, body: string | undefined, classify: Classify): Promise<unknown> {
    let refreshed = false;
    const used = { token: undefined as string | undefined };
    for (;;) {
      try {
        return await withRetry(() => this.attempt(method, url, body, used), {
          classify,
          clock: this.clock,
          ...(this.opts.random ? { random: this.opts.random } : {}),
          onRetry: ({ attempt, delayMs, error }) => {
            if (error instanceof HttpError && error.status === 429) this.opts.throttle.pauseFor(delayMs);
            this.opts.log.warn('qbo call retrying', { method, path: new URL(url).pathname, attempt, delay_ms: delayMs, error });
          },
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) {
          if (refreshed) throw new AuthError('QBO rejected the access token again right after a refresh');
          refreshed = true;
          await this.opts.auth.refresh(used.token);
          continue;
        }
        throw err;
      }
    }
  }

  private async attempt(method: 'GET' | 'POST', url: string, body: string | undefined, used: { token?: string | undefined }): Promise<unknown> {
    return this.opts.throttle.run(async () => {
      // Read the token after the queue wait, so a request never starts with a token another
      // request has already replaced (code review 2026-11-12).
      const token = await this.opts.auth.getAccessToken();
      used.token = token;
      this.stats.calls++;
      const started = this.clock.now();
      try {
        const res = await sendRequest(
          this.opts.fetch,
          {
            service: 'qbo',
            method,
            url,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body } : {}),
          },
          () => this.clock.now(),
        );
        this.count(String(res.status));
        this.opts.log.debug('qbo call', { method, path: new URL(url).pathname, status: res.status, ms: this.clock.now() - started });
        if (parseFault(res.body)) throw new QboFaultError(new URL(url).pathname, res.body);
        return res.body;
      } catch (err) {
        if (err instanceof HttpError) this.count(String(err.status));
        else if (err instanceof NetworkError) this.count('network');
        throw err;
      }
    });
  }

  private count(key: string): void {
    this.stats.byStatus[key] = (this.stats.byStatus[key] ?? 0) + 1;
  }
}
