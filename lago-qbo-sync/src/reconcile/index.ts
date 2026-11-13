import type { Mappings } from '../config/schema.js';
import type {
  CompanyContext,
  QboCustomerPayload,
  QboCustomerRow,
  QboCustomerUpdate,
  QboPaymentPayload,
  QboTxnRow,
  QboVoidPayload,
} from '../qbo/types.js';
import { checkDocNumber, type DocKind } from '../transform/docNumber.js';
import { formatCents } from '../transform/money.js';
import { toQboPayment, type LagoPaidInvoice } from '../transform/payment.js';
import { toQboVoid } from '../transform/void.js';

/**
 * Pure per-document decisions (brief §4.2 "reconcile"). No network: sync performs the lookups and
 * passes their results in.
 *
 * A lookup result is either "QBO says none" or "QBO returned rows". A lookup that *failed* is not a
 * value of this type: the QBO client throws, sync records the document as failed, and no create can
 * follow (brief §6 bug #5).
 */
export type Lookup<Row> = { kind: 'none' } | { kind: 'found'; rows: readonly Row[] };

export type Decision<Payload = never> =
  | { action: 'create' }
  | { action: 'update'; payload: Payload }
  | { action: 'void'; payload: Payload }
  | { action: 'create_payment'; payload: Payload }
  | { action: 'skip'; reason: string }
  | { action: 'defer'; reason: string }
  | { action: 'fail'; reason: string };

/**
 * Ownership (code review 2026-11-12): a QBO document with the right DocNumber is only treated as
 * "this Lago document" when its PrivateNote carries the Lago id. Every invoice and credit memo this
 * job creates has it ("Lago Invoice: <id>" / "Lago Credit Note: <id>", the n8n format, kept by QBO
 * after a void as "Voided - Lago Invoice: <id>"). A same-numbered document created by hand or by
 * another tool is never skipped as synced, paid or voided by this job.
 */
export function ownedBy(row: QboTxnRow, lagoId: string): boolean {
  return lagoId.length > 0 && (row.PrivateNote ?? '').includes(lagoId);
}

function notOwned(label: string, number: string, row: QboTxnRow, lagoId: string): string {
  return (
    `${label}: QBO already has a document numbered "${number}" (Id ${row.Id}) that was not created from ` +
    `Lago document ${lagoId} (its private note does not carry that id); nothing was changed, check it in QBO`
  );
}

/**
 * Invoices and credit memos (brief §5.3): create if absent, skip if present.
 * `docNumber` must already have passed `checkDocNumber` (length guard).
 */
export function decideDocument(
  label: string,
  docNumber: { number: string; compliant: boolean },
  lookup: Lookup<QboTxnRow>,
  lagoId: string,
): Decision {
  if (lookup.kind === 'found') {
    if (lookup.rows.length > 1) {
      return {
        action: 'fail',
        reason: `${label}: ${lookup.rows.length} documents with DocNumber "${docNumber.number}" already exist in QBO (Ids ${lookup.rows.map((r) => r.Id).join(', ')}); fix the duplicates in QBO`,
      };
    }
    const row = lookup.rows[0]!;
    if (!ownedBy(row, lagoId)) return { action: 'fail', reason: notOwned(label, docNumber.number, row, lagoId) };
    return { action: 'skip', reason: `already synced (QBO Id ${row.Id})` };
  }
  if (!docNumber.compliant) {
    // Brief §6 bug #2: QBO lookups do not match numbers with some characters (e.g. `[`), so an empty
    // result does not prove absence. Creating would risk a duplicate.
    return {
      action: 'fail',
      reason: `${label}: DocNumber "${docNumber.number}" contains characters QBO lookups cannot match, so the job cannot prove it is not already in QBO; change the Lago prefix to letters, digits and "-"`,
    };
  }
  return { action: 'create' };
}

const LAGO_ID_IN_NOTES = /Lago ID:\s*(\S+)/;

/** The Lago customer id this job wrote into a QBO customer's Notes (MAPPING.md "Notes Format"). */
export function lagoIdFromNotes(notes: string | undefined): string | undefined {
  return LAGO_ID_IN_NOTES.exec(notes ?? '')?.[1];
}

/** Normalizes values the way QBO may store them, for "unchanged?" comparison. */
function normalize(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
}

/** True when every field we would send already has the same value in QBO. */
function sameAsExisting(desired: object, existing: Record<string, unknown> | undefined): boolean {
  for (const [key, value] of Object.entries(desired)) {
    const current = existing?.[key];
    if (value !== null && typeof value === 'object') {
      if (current === null || typeof current !== 'object') return false;
      if (!sameAsExisting(value, current as Record<string, unknown>)) return false;
    } else if (normalize(value) !== normalize(current)) {
      return false;
    }
  }
  return true;
}

/**
 * Customers (brief §5.3, n8n "Prepare Customer Upsert"): looked up by DisplayName; create if absent,
 * sparse-update if present. An unchanged customer is skipped so a rerun writes nothing (PLAN.md §4.5).
 * A customer whose QBO Notes name a different Lago customer fails instead of receiving another
 * customer's documents (PLAN.md Q7).
 *
 * When the name finds nothing, `byLagoId` (QBO customers whose Notes carry this Lago id) decides:
 * one match means the customer was renamed in Lago, so it is updated (renamed) instead of duplicated
 * (review on PR #8); several matches fail; none means a new customer.
 */
export function decideCustomer(
  desired: QboCustomerPayload,
  lagoId: string,
  lookup: Lookup<QboCustomerRow>,
  byLagoId: readonly QboCustomerRow[] = [],
): Decision<QboCustomerUpdate> {
  if (lookup.kind === 'none') {
    if (byLagoId.length > 1) {
      return {
        action: 'fail',
        reason: `Customer "${desired.DisplayName}": ${byLagoId.length} QBO customers carry Lago id ${lagoId} (Ids ${byLagoId.map((r) => r.Id).join(', ')}); merge them in QBO`,
      };
    }
    const renamed = byLagoId[0];
    if (!renamed) return { action: 'create' };
    return { action: 'update', payload: { ...withoutCurrency(desired), Id: renamed.Id, SyncToken: renamed.SyncToken, sparse: true } };
  }
  if (lookup.rows.length > 1) {
    return { action: 'fail', reason: `Customer "${desired.DisplayName}": ${lookup.rows.length} QBO customers share this DisplayName` };
  }
  const row = lookup.rows[0]!;
  const linkedLagoId = lagoIdFromNotes(row.Notes);
  if (linkedLagoId && linkedLagoId !== lagoId) {
    return {
      action: 'fail',
      reason: `Customer "${desired.DisplayName}": QBO customer ${row.Id} belongs to Lago customer ${linkedLagoId}, not ${lagoId}; two Lago customers share this name, rename one in Lago or QBO`,
    };
  }
  // QBO fixes a customer's currency at creation and silently ignores changes, so it is never
  // compared or sent for an existing customer (otherwise every run "updates" it, seen in the sandbox).
  // A real mismatch surfaces on that customer's documents as QBO's own currency error.
  const comparable = withoutCurrency(desired);
  if (sameAsExisting(comparable, row)) return { action: 'skip', reason: `unchanged (QBO Id ${row.Id})` };
  return { action: 'update', payload: { ...comparable, Id: row.Id, SyncToken: row.SyncToken, sparse: true } };
}

function withoutCurrency(desired: QboCustomerPayload): Omit<QboCustomerPayload, 'CurrencyRef'> {
  const { CurrencyRef: _currency, ...rest } = desired;
  return rest;
}

function balanceCents(row: QboTxnRow): number | null {
  return typeof row.Balance === 'number' && Number.isFinite(row.Balance) ? Math.round(row.Balance * 100) : null;
}

/**
 * Payments (brief §5.3, PLAN.md Q10). Invoice missing in QBO → defer: the invoice pass of this or the
 * next run creates it (brief §6 bug #4). Balance 0 → skip. Balance equal to the Lago total → pay.
 * Any other balance → fail, so a partially settled invoice is never overpaid.
 */
export function decidePayment(inv: LagoPaidInvoice, lookup: Lookup<QboTxnRow>): Decision<QboPaymentPayload> {
  const label = `Payment for invoice ${inv.number}`;
  if (lookup.kind === 'none') return { action: 'defer', reason: `invoice ${inv.number} is not in QBO yet` };
  if (lookup.rows.length > 1) {
    return { action: 'fail', reason: `${label}: ${lookup.rows.length} QBO invoices have this DocNumber` };
  }
  const row = lookup.rows[0]!;
  if (!ownedBy(row, inv.lago_id)) return { action: 'fail', reason: notOwned(label, inv.number, row, inv.lago_id) };
  const balance = balanceCents(row);
  if (balance === null) return { action: 'fail', reason: `${label}: QBO invoice ${row.Id} has no Balance` };
  if (balance === 0) return { action: 'skip', reason: `already paid (QBO invoice ${row.Id} balance is 0)` };
  if (balance !== inv.total_amount_cents) {
    return {
      action: 'fail',
      reason: `${label}: QBO balance is ${formatCents(balance)} but the Lago total is ${formatCents(inv.total_amount_cents)}; the invoice was partly settled in QBO, record this payment by hand`,
    };
  }
  const payment = toQboPayment(inv, row);
  return payment.ok ? { action: 'create_payment', payload: payment.value } : { action: 'fail', reason: payment.reason };
}

/**
 * How QBO shows a voided invoice, observed in the sandbox on 2026-11-12 (PLAN.md §9): TotalAmt 0,
 * Balance 0, and a PrivateNote that QBO prefixes with "Voided - ". All three are required, so a
 * $0 invoice with lines that was never voided is still voided when Lago voids it.
 */
export function isVoidedInQbo(row: QboTxnRow): boolean {
  return row.TotalAmt === 0 && row.Balance === 0 && /^Voided\b/.test(row.PrivateNote ?? '');
}

/**
 * Voids (brief §5.3): void if present and not already voided; skip if absent. Never voids a QBO
 * invoice that was not created from this Lago invoice (ownership above).
 */
export function decideVoid(number: string, lagoId: string, lookup: Lookup<QboTxnRow>): Decision<QboVoidPayload> {
  if (lookup.kind === 'none') return { action: 'skip', reason: 'not in QBO, nothing to void' };
  if (lookup.rows.length > 1) {
    return { action: 'fail', reason: `Void invoice ${number}: ${lookup.rows.length} QBO invoices have this DocNumber` };
  }
  const row = lookup.rows[0]!;
  if (!ownedBy(row, lagoId)) return { action: 'fail', reason: notOwned(`Void invoice ${number}`, number, row, lagoId) };
  if (isVoidedInQbo(row)) return { action: 'skip', reason: `already voided (QBO Id ${row.Id})` };
  return { action: 'void', payload: toQboVoid(row) };
}

/**
 * Brief §6 note: CurrencyRef only works with multicurrency on. A document in another currency than
 * the company's home currency fails when multicurrency is off.
 */
export function currencyProblem(label: string, currency: string, company: CompanyContext): string | null {
  if (company.multiCurrencyEnabled || currency === company.homeCurrency) return null;
  return `${label}: currency ${currency} differs from the QBO home currency ${company.homeCurrency} and multicurrency is off in QBO`;
}

export type MissingReason =
  | 'not_found'
  | 'unverifiable_docnumber'
  | 'docnumber_too_long'
  | 'duplicate_in_qbo'
  | 'number_used_by_other_document';

/**
 * Read-only reconciliation pass (PLAN.md §4.12): is this Lago document in QBO?
 * Returns null when exactly one QBO document matches.
 */
export function missingReason(
  number: string,
  kind: DocKind,
  rules: Mappings['lago']['invoice_prefix_rules'],
  lookup: Lookup<QboTxnRow>,
  lagoId: string,
): MissingReason | null {
  const check = checkDocNumber(number, kind, rules);
  if (!check.ok) return 'docnumber_too_long';
  if (lookup.kind === 'found') {
    if (lookup.rows.length > 1) return 'duplicate_in_qbo';
    return ownedBy(lookup.rows[0]!, lagoId) ? null : 'number_used_by_other_document';
  }
  return check.compliant ? 'not_found' : 'unverifiable_docnumber';
}
