import type { Mappings } from '../config/schema.js';
import { encodeParams } from '../http/request.js';

/**
 * The only way this job builds QBO query statements and URLs (brief §6 bug #1).
 *
 * - User data only enters a statement through `literal()`, which escapes `'` as `\'`
 *   (brief §6 #1, e.g. O'Neil) and refuses characters whose escaping QBO does not document.
 * - The whole statement is encoded with `encodeURIComponent`. `URLSearchParams` is not used: it
 *   encodes spaces as `+`, which QBO does not read as a space.
 * - Entities and fields come from fixed unions, never from data.
 */

export const QBO_BASE_URL = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const satisfies Record<Mappings['environment'], string>;

/** Most numbers per `IN (...)` lookup in the reconciliation pass (PLAN.md §4.12). */
export const QUERY_IN_MAX = 50;
/** QBO returns at most 1000 rows per query. */
export const QUERY_MAX_RESULTS = 1000;

/** Raised when a value cannot be put in a QBO query safely. The document fails; nothing is sent. */
export class QueryBuildError extends Error {
  override readonly name = 'QueryBuildError';
}

export type TxnEntity = 'Invoice' | 'CreditMemo';
export type ConfigEntity = 'Item' | 'Account' | 'TaxCode';

/**
 * A quoted QBO query string literal. Backslashes and control characters are refused: Intuit
 * documents `\'` for quotes but not how a backslash is escaped, and guessing could turn
 * "not found" into a duplicate create.
 */
export function literal(value: string): string {
  if (value.length === 0) throw new QueryBuildError('cannot query an empty value');
  if (value.includes('\\')) throw new QueryBuildError(`cannot query a value containing a backslash: ${value}`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new QueryBuildError(`cannot query a value containing control characters: ${JSON.stringify(value)}`);
  return `'${value.replace(/'/g, "\\'")}'`;
}

export function customerByDisplayName(displayName: string): string {
  return `SELECT * FROM Customer WHERE DisplayName = ${literal(displayName)}`;
}

export function txnByDocNumber(entity: TxnEntity, docNumber: string): string {
  return `SELECT * FROM ${entity} WHERE DocNumber = ${literal(docNumber)}`;
}

function inList(values: readonly string[]): string {
  if (values.length === 0 || values.length > QUERY_IN_MAX) {
    throw new QueryBuildError(`IN lookups take 1 to ${QUERY_IN_MAX} values, got ${values.length}`);
  }
  return `(${values.map(literal).join(', ')})`;
}

/**
 * Batched existence check (sync passes and reconciliation). `IN` on DocNumber is confirmed in the
 * sandbox (PLAN.md §9). Full rows (`*`) are needed: the ownership check reads PrivateNote.
 */
export function txnsByDocNumbers(entity: TxnEntity, docNumbers: readonly string[]): string {
  return `SELECT * FROM ${entity} WHERE DocNumber IN ${inList(docNumbers)} MAXRESULTS ${QUERY_MAX_RESULTS}`;
}

/** Batched customer lookup; if QBO rejects `IN` on DisplayName, sync falls back to single lookups. */
export function customersByDisplayNames(displayNames: readonly string[]): string {
  return `SELECT * FROM Customer WHERE DisplayName IN ${inList(displayNames)} MAXRESULTS ${QUERY_MAX_RESULTS}`;
}

/** check-config: do the configured Item / Account / TaxCode Ids exist? */
export function byIds(entity: ConfigEntity, ids: readonly string[]): string {
  if (ids.length === 0 || ids.length > QUERY_IN_MAX) {
    throw new QueryBuildError(`Id lookups take 1 to ${QUERY_IN_MAX} values, got ${ids.length}`);
  }
  return `SELECT * FROM ${entity} WHERE Id IN (${ids.map(literal).join(', ')}) MAXRESULTS ${QUERY_MAX_RESULTS}`;
}

/** QBO entity path segments this job may call (brief §8 least privilege). */
export type QboPath =
  | { kind: 'query' }
  | { kind: 'entity'; entity: 'customer' | 'invoice' | 'creditmemo' | 'payment' }
  | { kind: 'companyinfo' }
  | { kind: 'preferences' };

/**
 * Builds `https://…/v3/company/{realm}/{path}?…&minorversion=N`. Every parameter value is encoded
 * with encodeURIComponent; the realm is validated as digits by config.
 */
export function qboUrl(
  environment: Mappings['environment'],
  realmId: string,
  minorVersion: number,
  path: QboPath,
  params: Record<string, string> = {},
): string {
  if (!/^\d+$/.test(realmId)) throw new QueryBuildError('realm id must be numeric');
  const segment =
    path.kind === 'query'
      ? 'query'
      : path.kind === 'entity'
        ? path.entity
        : path.kind === 'companyinfo'
          ? `companyinfo/${realmId}`
          : 'preferences';
  const query = encodeParams({ ...params, minorversion: String(minorVersion) });
  return `${QBO_BASE_URL[environment]}/v3/company/${realmId}/${segment}?${query}`;
}
