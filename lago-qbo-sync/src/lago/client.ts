import { z } from 'zod';
import { systemClock, type Clock } from '../http/clock.js';
import { HttpError } from '../http/errors.js';
import { encodeParams, sendRequest, type FetchLike } from '../http/request.js';
import { classifyRead, withRetry } from '../http/retry.js';
import type { Throttle } from '../http/throttle.js';
import type { Logger } from '../log/logger.js';
import { registerSecret } from '../log/redact.js';
import {
  lagoBillingEntitySchema,
  lagoCreditNoteSchema,
  lagoCreditNoteSummarySchema,
  lagoInvoiceSchema,
  lagoInvoiceSummarySchema,
  lagoPageMetaSchema,
  type LagoBillingEntity,
  type LagoCreditNote,
  type LagoCreditNoteSummary,
  type LagoInvoice,
  type LagoInvoiceSummary,
} from './types.js';

/**
 * Read-only Lago client (brief §5.1). It has no way to send anything but GET: the method is a
 * constant in `get()`, and no other request function exists in this module.
 *
 * Every query parameter used here is documented in the Lago API reference (checked 2026-10-23):
 * GET /invoices: status, payment_status, issuing_date_from, page, per_page
 * GET /credit_notes: issuing_date_from, page, per_page
 */

export interface LagoClientOptions {
  /** mappings.yaml lago.api_url, e.g. https://api.getlago.com/api/v1 (validated by config). */
  apiUrl: string;
  apiKey: string;
  fetch: FetchLike;
  throttle: Throttle;
  log: Logger;
  clock?: Clock;
  random?: () => number;
}

export interface InvoiceFilter {
  status: 'finalized' | 'voided';
  payment_status?: 'succeeded';
  /** YYYY-MM-DD, inclusive. */
  issuing_date_from: string;
}

/** List entries that do not match the expected shape are reported, not dropped silently. */
export interface ListResult<T> {
  items: T[];
  invalid: Array<{ lago_id?: string; number?: string; reason: string }>;
}

/** A Lago object did not have a field the job needs. That document fails; the run goes on. */
export class LagoSchemaError extends Error {
  override readonly name = 'LagoSchemaError';
}

export const LAGO_PER_PAGE = 100;
/** Guard against a pagination loop: 500 pages × 100 = 50,000 documents in one window. */
const MAX_PAGES = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export class LagoClient {
  readonly stats = { calls: 0 };
  private readonly clock: Clock;
  private readonly base: string;

  constructor(private readonly opts: LagoClientOptions) {
    this.clock = opts.clock ?? systemClock;
    this.base = opts.apiUrl.replace(/\/+$/, '');
    registerSecret(opts.apiKey);
  }

  listInvoices(filter: InvoiceFilter): Promise<ListResult<LagoInvoiceSummary>> {
    if (!DATE.test(filter.issuing_date_from)) throw new Error('issuing_date_from must be YYYY-MM-DD');
    const params: Record<string, string> = { status: filter.status, issuing_date_from: filter.issuing_date_from };
    if (filter.payment_status) params.payment_status = filter.payment_status;
    return this.paginate('/invoices', params, 'invoices', lagoInvoiceSummarySchema);
  }

  /** Full invoice with fees and credits (not included in the list, PLAN.md F6). */
  getInvoice(lagoId: string): Promise<LagoInvoice> {
    return this.getOne(`/invoices/${encodeURIComponent(lagoId)}`, 'invoice', lagoInvoiceSchema);
  }

  listCreditNotes(filter: { issuing_date_from: string }): Promise<ListResult<LagoCreditNoteSummary>> {
    if (!DATE.test(filter.issuing_date_from)) throw new Error('issuing_date_from must be YYYY-MM-DD');
    return this.paginate('/credit_notes', { issuing_date_from: filter.issuing_date_from }, 'credit_notes', lagoCreditNoteSummarySchema);
  }

  /** Full credit note with items[].fee.item. */
  getCreditNote(lagoId: string): Promise<LagoCreditNote> {
    return this.getOne(`/credit_notes/${encodeURIComponent(lagoId)}`, 'credit_note', lagoCreditNoteSchema);
  }

  async listBillingEntities(): Promise<LagoBillingEntity[]> {
    const body = await this.get('/billing_entities', {});
    const parsed = z.looseObject({ billing_entities: z.array(lagoBillingEntitySchema) }).safeParse(body);
    if (!parsed.success) throw new LagoSchemaError(`GET /billing_entities: ${describeIssues(parsed.error)}`);
    return parsed.data.billing_entities;
  }

  private async getOne<S extends z.ZodType>(path: string, key: string, schema: S): Promise<z.infer<S>> {
    const body = await this.get(path, {});
    const parsed = schema.safeParse((body as Record<string, unknown> | null)?.[key]);
    if (!parsed.success) throw new LagoSchemaError(`GET ${path}: ${describeIssues(parsed.error)}`);
    return parsed.data;
  }

  /** Follows `meta.next_page` until it is null (brief §5.1 "paginate until the last page"). */
  private async paginate<S extends z.ZodType>(
    path: string,
    params: Record<string, string>,
    key: string,
    schema: S,
  ): Promise<ListResult<z.infer<S>>> {
    const result: ListResult<z.infer<S>> = { items: [], invalid: [] };
    let page = 1;
    for (let fetched = 0; ; fetched++) {
      if (fetched >= MAX_PAGES) throw new Error(`GET ${path}: more than ${MAX_PAGES} pages; narrow the lookback window`);
      const body = (await this.get(path, { ...params, page: String(page), per_page: String(LAGO_PER_PAGE) })) as Record<
        string,
        unknown
      > | null;
      const list = body?.[key];
      const meta = lagoPageMetaSchema.safeParse(body?.meta);
      if (!Array.isArray(list) || !meta.success) throw new LagoSchemaError(`GET ${path}: response has no ${key} list or meta`);
      for (const raw of list) {
        const parsed = schema.safeParse(raw);
        if (parsed.success) {
          result.items.push(parsed.data);
        } else {
          const r = (raw ?? {}) as { lago_id?: unknown; number?: unknown };
          result.invalid.push({
            ...(typeof r.lago_id === 'string' ? { lago_id: r.lago_id } : {}),
            ...(typeof r.number === 'string' ? { number: r.number } : {}),
            reason: describeIssues(parsed.error),
          });
        }
      }
      const next = meta.data.next_page;
      if (next === null || next === undefined) return result;
      if (next <= page) throw new LagoSchemaError(`GET ${path}: next_page ${next} does not advance past ${page}`);
      page = next;
    }
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const query = encodeParams(params);
    const url = `${this.base}${path}${query ? `?${query}` : ''}`;
    const res = await withRetry(
      () =>
        this.opts.throttle.run(() => {
          this.stats.calls++;
          return sendRequest(
            this.opts.fetch,
            {
              service: 'lago',
              method: 'GET',
              url,
              headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: 'application/json' },
            },
            () => this.clock.now(),
          );
        }),
      {
        classify: classifyRead,
        clock: this.clock,
        ...(this.opts.random ? { random: this.opts.random } : {}),
        onRetry: ({ attempt, delayMs, error }) => {
          if (error instanceof HttpError && error.status === 429) this.opts.throttle.pauseFor(delayMs);
          this.opts.log.warn('lago call retrying', { path, attempt, delay_ms: delayMs, error });
        },
      },
    );
    return res.body;
  }
}
