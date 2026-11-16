import type { Mappings } from '../config/schema.js';
import { HttpError } from '../http/errors.js';
import type { Logger } from '../log/logger.js';
import { AuthError, describeQboError, QboFaultError } from '../qbo/errors.js';
import { QUERY_IN_MAX, txnByDocNumber, txnsByDocNumbers, type TxnEntity } from '../qbo/query.js';
import type { QboTxnRow } from '../qbo/types.js';
import { missingReason, type Lookup } from '../reconcile/index.js';
import { chunks, groupBatchLookup } from './batchLookup.js';
import { TokenStoreError } from '../tokenStore/types.js';
import { isEmptyInvoice, isOutOfScopeInvoice } from '../transform/invoice.js';
import type { LagoReader, QboApi } from './run.js';
import type { MissingEntry, RunSummary } from './summary.js';

interface Doc {
  entity: 'invoice' | 'credit_note';
  qboEntity: TxnEntity;
  lago_id: string;
  number: string;
  issuing_date: string;
  /** Invoices only: a $0 invoice that is not in QBO may be an empty one, which is never synced. */
  total_amount_cents?: number;
}

/** Characters `literal()` refuses; such numbers cannot be looked up at all. */
const UNQUERYABLE = /[\\\u0000-\u001f\u007f]/;

/**
 * Read-only reconciliation (PLAN.md §4.12, added on approval): lists Lago finalized invoices and
 * credit notes issued since `issuedFrom` and reports those QBO does not have. Never writes and never
 * fails the run; a problem here is reported in `missing_in_qbo.error`.
 */
export async function runReconciliation(args: {
  lago: LagoReader;
  qbo: QboApi;
  rules: Mappings['lago']['invoice_prefix_rules'];
  issuedFrom: string;
  maxLookups: number;
  log: Logger;
}): Promise<RunSummary['missing_in_qbo']> {
  const result: RunSummary['missing_in_qbo'] = { checked: 0, truncated: false, method: 'batched', items: [] };
  try {
    const docs = await listDocs(args.lago, args.issuedFrom);
    const lookups = await lookupInQbo(args, docs, result);
    for (const doc of docs) {
      const lookup = lookups.get(key(doc));
      if (lookup === undefined) continue; // not checked (truncated, or cannot be queried: below)
      result.checked++;
      const reason = missingReason(doc.number, doc.entity, args.rules, lookup, doc.lago_id);
      if (reason === 'not_found' && doc.total_amount_cents === 0 && (await isEmpty(args.lago, doc))) continue;
      if (reason) result.items.push(entry(doc, reason));
    }
    // Numbers that cannot be queried at all are reported as unverifiable.
    for (const doc of docs.filter((d) => UNQUERYABLE.test(d.number))) {
      result.checked++;
      result.items.push(entry(doc, 'unverifiable_docnumber'));
    }
  } catch (err) {
    if (err instanceof AuthError || err instanceof TokenStoreError) throw err;
    args.log.warn('reconciliation pass stopped', { error: err });
    result.error = describeQboError(err);
  }
  return result;
}

/** Empty invoices are skipped by design, so their absence from QBO is expected (one detail GET each). */
async function isEmpty(lago: LagoReader, doc: Doc): Promise<boolean> {
  try {
    return isEmptyInvoice(await lago.getInvoice(doc.lago_id));
  } catch (err) {
    if (err instanceof AuthError || err instanceof TokenStoreError) throw err;
    return false; // cannot tell: keep reporting it as missing
  }
}

function entry(doc: Doc, reason: MissingEntry['reason']): MissingEntry {
  return { entity: doc.entity, lago_number: doc.number, lago_id: doc.lago_id, issuing_date: doc.issuing_date, reason };
}

const key = (doc: Pick<Doc, 'qboEntity' | 'number'>) => `${doc.qboEntity}:${doc.number}`;

async function listDocs(lago: LagoReader, from: string): Promise<Doc[]> {
  const invoices = await lago.listInvoices({ status: 'finalized', issuing_date_from: from });
  const creditNotes = await lago.listCreditNotes({ issuing_date_from: from });
  return [
    ...invoices.items
      .filter((i) => !isOutOfScopeInvoice(i))
      .map((i) => ({
        entity: 'invoice' as const,
        qboEntity: 'Invoice' as const,
        lago_id: i.lago_id,
        number: i.number,
        issuing_date: i.issuing_date,
        total_amount_cents: i.total_amount_cents,
      })),
    ...creditNotes.items.map((c) => ({
      entity: 'credit_note' as const,
      qboEntity: 'CreditMemo' as const,
      lago_id: c.lago_id,
      number: c.number,
      issuing_date: c.issuing_date,
    })),
  ];
}

/**
 * The QBO documents carrying each number, as full rows (the ownership check reads PrivateNote).
 * Batched `DocNumber IN (...)` first, grouped by the same helper as the sync passes, so a number QBO
 * matched only by case gets a single lookup. If QBO rejects the batched form (400 / Fault), every
 * document gets a single lookup instead. Single lookups are capped at `maxLookups`.
 */
async function lookupInQbo(
  args: { qbo: QboApi; maxLookups: number; log: Logger },
  docs: Doc[],
  result: RunSummary['missing_in_qbo'],
): Promise<Map<string, Lookup<QboTxnRow>>> {
  const lookups = new Map<string, Lookup<QboTxnRow>>();
  const queryable = docs.filter((d) => !UNQUERYABLE.test(d.number));

  batches: for (const qboEntity of ['Invoice', 'CreditMemo'] as const) {
    const numbers = [...new Set(queryable.filter((d) => d.qboEntity === qboEntity).map((d) => d.number))];
    for (const chunk of chunks(numbers, QUERY_IN_MAX)) {
      let found: Lookup<QboTxnRow>;
      try {
        found = await args.qbo.query<QboTxnRow>(txnsByDocNumbers(qboEntity, chunk), qboEntity);
      } catch (err) {
        if ((err instanceof HttpError && err.status === 400) || err instanceof QboFaultError) {
          args.log.warn('QBO rejected batched DocNumber IN lookups; falling back to one lookup per document', { error: err });
          result.method = 'per_document';
          lookups.clear();
          break batches;
        }
        throw err;
      }
      const answered = groupBatchLookup(chunk, found.kind === 'found' ? found.rows : [], (r) => r.DocNumber);
      for (const [n, lookup] of answered) lookups.set(key({ qboEntity, number: n }), lookup);
    }
  }

  let singles = 0;
  for (const doc of queryable) {
    if (lookups.has(key(doc))) continue;
    if (singles >= args.maxLookups) {
      result.truncated = true;
      break;
    }
    singles++;
    lookups.set(key(doc), await args.qbo.query<QboTxnRow>(txnByDocNumber(doc.qboEntity, doc.number), doc.qboEntity));
  }
  return lookups;
}
