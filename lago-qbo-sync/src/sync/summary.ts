import type { MissingReason } from '../reconcile/index.js';

/**
 * The run summary printed as JSON on stdout (brief §4.3 step 6). SKILL.md tells the scheduled
 * routine how to read it; keep field names stable.
 */

export type Entity = 'customer' | 'invoice' | 'credit_note' | 'payment' | 'void';

export const OUTCOMES = [
  'created',
  'updated',
  'voided',
  'skipped',
  'deferred',
  'failed',
  'would_create',
  'would_update',
  'would_void',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** `aborted`: the run could not start its passes (e.g. QBO company info unreachable); exit code 1. */
export type RunStatus = 'completed' | 'locked' | 'auth_error' | 'config_error' | 'aborted';

export interface DocumentNote {
  entity: Entity;
  lago_number: string;
  lago_id?: string;
  reason: string;
}

export interface MissingEntry {
  entity: 'invoice' | 'credit_note';
  lago_number: string;
  lago_id: string;
  issuing_date: string;
  reason: MissingReason;
}

export interface RunSummary {
  status: RunStatus;
  mode: 'apply' | 'dry-run';
  environment: string;
  realm_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code: 0 | 1 | 2 | 3;
  message?: string;
  windows: Record<string, string>;
  counts: Record<Entity, Record<Outcome, number>>;
  out_of_scope: { wallet_topup_invoices: number };
  qbo: { calls: number; by_status: Record<string, number>; unexpected_statuses: string[] };
  lago: { calls: number };
  failures: DocumentNote[];
  deferred: DocumentNote[];
  /** Skips worth a human glance (e.g. empty invoices). Routine "already synced" skips are only counted. */
  skipped_documents: DocumentNote[];
  warnings: DocumentNote[];
  missing_in_qbo: {
    checked: number;
    truncated: boolean;
    method: 'batched' | 'per_document' | 'not_run';
    error?: string;
    items: MissingEntry[];
  };
}

/**
 * Statuses that are expected in a healthy run (brief §3): 200, plus 401 (refreshed and retried)
 * and 429 (retried after backoff). Anything else is listed in `unexpected_statuses`.
 */
const EXPECTED_STATUSES = new Set(['200', '401', '429']);

export class SummaryBuilder {
  private readonly counts = Object.fromEntries(
    (['customer', 'invoice', 'credit_note', 'payment', 'void'] as const).map((e) => [
      e,
      Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
    ]),
  ) as Record<Entity, Record<Outcome, number>>;
  readonly failures: DocumentNote[] = [];
  readonly deferred: DocumentNote[] = [];
  readonly skipped: DocumentNote[] = [];
  readonly warnings: DocumentNote[] = [];
  walletTopups = 0;
  windows: Record<string, string> = {};
  missing: RunSummary['missing_in_qbo'] = { checked: 0, truncated: false, method: 'not_run', items: [] };

  constructor(
    private readonly base: { mode: RunSummary['mode']; environment: string; realm_id: string; startedAt: number },
  ) {}

  record(entity: Entity, outcome: Outcome, note?: Omit<DocumentNote, 'entity'>): void {
    this.counts[entity][outcome]++;
    if (outcome === 'failed' && note) this.failures.push({ entity, ...note });
    if (outcome === 'deferred' && note) this.deferred.push({ entity, ...note });
    if (outcome === 'skipped' && note) this.skipped.push({ entity, ...note });
  }

  warn(entity: Entity, note: Omit<DocumentNote, 'entity'>): void {
    this.warnings.push({ entity, ...note });
  }

  build(args: {
    status: RunStatus;
    finishedAt: number;
    qbo: { calls: number; byStatus: Record<string, number> };
    lagoCalls: number;
    message?: string;
    /** A stale lock needs a person (README › Runbooks › Stale lock), so it must not exit 0. */
    staleLock?: boolean;
  }): RunSummary {
    // brief §4.3: 0 no failures, 1 any document failed, 2 config error, 3 auth error.
    const exit_code =
      args.status === 'auth_error'
        ? 3
        : args.status === 'config_error'
          ? 2
          : args.status === 'locked'
            ? args.staleLock
              ? 1
              : 0
            : args.status === 'aborted' || this.failures.length > 0
              ? 1
              : 0;
    return {
      status: args.status,
      mode: this.base.mode,
      environment: this.base.environment,
      realm_id: this.base.realm_id,
      started_at: new Date(this.base.startedAt).toISOString(),
      finished_at: new Date(args.finishedAt).toISOString(),
      duration_ms: args.finishedAt - this.base.startedAt,
      exit_code,
      ...(args.message ? { message: args.message } : {}),
      windows: this.windows,
      counts: this.counts,
      out_of_scope: { wallet_topup_invoices: this.walletTopups },
      qbo: {
        calls: args.qbo.calls,
        by_status: { ...args.qbo.byStatus },
        unexpected_statuses: Object.keys(args.qbo.byStatus).filter((s) => !EXPECTED_STATUSES.has(s)).sort(),
      },
      lago: { calls: args.lagoCalls },
      failures: this.failures,
      deferred: this.deferred,
      skipped_documents: this.skipped,
      warnings: this.warnings,
      missing_in_qbo: this.missing,
    };
  }
}
