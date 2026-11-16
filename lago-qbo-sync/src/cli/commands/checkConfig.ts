import type { Mappings } from '../../config/schema.js';
import type { LagoClient } from '../../lago/client.js';
import type { Logger } from '../../log/logger.js';
import { AuthError, describeQboError } from '../../qbo/errors.js';
import { byIds, QUERY_IN_MAX, type ConfigEntity } from '../../qbo/query.js';
import type { QboClient } from '../../qbo/client.js';
import { checkDocNumber } from '../../transform/docNumber.js';
import { windowStart } from '../../sync/pool.js';
import { TokenStoreError } from '../../tokenStore/types.js';
import { buildSyncContext, type CliIO } from '../context.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface CheckDeps {
  mappings: Mappings;
  qbo: Pick<QboClient, 'query' | 'companyContext'>;
  lago: Pick<LagoClient, 'listBillingEntities' | 'listInvoices' | 'listCreditNotes'>;
  auth: { getAccessToken(): Promise<string> };
  nowMs: number;
}

const MAX_LISTED = 10;

/**
 * `npm run check-config` (brief §7.1): read-only checks that the configuration matches the QBO
 * company and the Lago numbering. Order matters: a failed token check stops the QBO checks.
 */
export async function runChecks(deps: CheckDeps): Promise<Check[]> {
  const checks: Check[] = [{ name: 'config', status: 'pass', detail: 'mappings.yaml and environment are valid' }];
  const m = deps.mappings;

  // Token + realm reachable. An auth problem is rethrown: it maps to exit code 3.
  await deps.auth.getAccessToken();
  checks.push({ name: 'qbo_token', status: 'pass', detail: 'refresh token accepted by Intuit' });

  try {
    const company = await deps.qbo.companyContext();
    const currency = `home currency ${company.homeCurrency}, multicurrency ${company.multiCurrencyEnabled ? 'on' : 'off'}`;
    checks.push(
      company.country === 'US'
        ? { name: 'qbo_company', status: 'pass', detail: `realm ${m.qbo.realm_id} reachable: US company, ${currency}` }
        : { name: 'qbo_company', status: 'fail', detail: `country is ${company.country}; only US companies are supported (PLAN.md Q8)` },
    );
  } catch (err) {
    if (err instanceof AuthError) throw err;
    checks.push({ name: 'qbo_company', status: 'fail', detail: `realm ${m.qbo.realm_id} not reachable: ${describeQboError(err)}` });
    return checks;
  }

  // Every referenced Item Id must exist and be active.
  const itemRefs = new Map<string, string[]>();
  const addRef = (id: string, where: string) => itemRefs.set(id, [...(itemRefs.get(id) ?? []), where]);
  addRef(m.qbo.default_item_id, 'qbo.default_item_id');
  for (const [code, id] of Object.entries(m.items)) addRef(id, `items.${code}`);
  checks.push(await checkIds(deps.qbo, 'Item', 'qbo_items', itemRefs));
  checks.push(await checkIds(deps.qbo, 'Account', 'qbo_discount_account', new Map([[m.qbo.discount_account_id, ['qbo.discount_account_id']]])));
  checks.push(
    m.qbo.tax_code_id
      ? await checkIds(deps.qbo, 'TaxCode', 'qbo_tax_code', new Map([[m.qbo.tax_code_id, ['qbo.tax_code_id']]]))
      : { name: 'qbo_tax_code', status: 'warn', detail: 'qbo.tax_code_id is empty: QBO will compute its own tax instead of using Lago\'s' },
  );

  checks.push(...(await checkLagoNumbering(deps)));
  return checks;
}

async function checkIds(
  qbo: CheckDeps['qbo'],
  entity: ConfigEntity,
  name: string,
  refs: Map<string, string[]>,
): Promise<Check> {
  const ids = [...refs.keys()];
  const found = new Map<string, boolean>();
  try {
    for (let i = 0; i < ids.length; i += QUERY_IN_MAX) {
      const r = await qbo.query<{ Id: string; Active?: boolean; Name?: string }>(byIds(entity, ids.slice(i, i + QUERY_IN_MAX)), entity);
      if (r.kind === 'found') for (const row of r.rows) found.set(row.Id, row.Active !== false);
    }
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { name, status: 'fail', detail: `could not query ${entity}: ${describeQboError(err)}` };
  }
  const missing = ids.filter((id) => !found.has(id)).map((id) => `${entity} ${id} (${refs.get(id)!.join(', ')}) does not exist`);
  const inactive = ids.filter((id) => found.get(id) === false).map((id) => `${entity} ${id} (${refs.get(id)!.join(', ')}) is inactive`);
  const problems = [...missing, ...inactive];
  return problems.length > 0
    ? { name, status: 'fail', detail: problems.join('; ') }
    : { name, status: 'pass', detail: `${ids.length} ${entity} Id(s) exist and are active` };
}

/**
 * Brief §6 bugs #2 and #3: warn when the Lago prefix has characters QBO lookups cannot match, and
 * when recent Lago numbers are longer than QBO allows. Recent numbers come from the reconcile window.
 */
async function checkLagoNumbering(deps: CheckDeps): Promise<Check[]> {
  const rules = deps.mappings.lago.invoice_prefix_rules;
  const pattern = new RegExp(rules.allowed_pattern);
  const checks: Check[] = [];
  try {
    const entities = await deps.lago.listBillingEntities();
    const bad = entities.filter((e) => e.document_number_prefix && !pattern.test(e.document_number_prefix));
    checks.push(
      bad.length > 0
        ? {
            name: 'lago_prefix',
            status: 'warn',
            detail: bad
              .map((e) => `billing entity ${e.code}: prefix "${e.document_number_prefix}" has characters other than letters, digits and "-"; QBO lookups cannot match it, so its documents will fail instead of risking duplicates`)
              .join('; '),
          }
        : { name: 'lago_prefix', status: 'pass', detail: `${entities.length} billing entit${entities.length === 1 ? 'y' : 'ies'}, prefixes compliant` },
    );

    const from = windowStart(deps.nowMs, deps.mappings.sync.reconcile_lookback_days);
    const invoices = await deps.lago.listInvoices({ status: 'finalized', issuing_date_from: from });
    const creditNotes = await deps.lago.listCreditNotes({ issuing_date_from: from });
    const numbers = [
      ...invoices.items.map((i) => ({ n: i.number, kind: 'invoice' as const })),
      ...creditNotes.items.map((c) => ({ n: c.number, kind: 'credit_note' as const })),
    ];
    const tooLong = numbers.filter((x) => !checkDocNumber(x.n, x.kind, rules).ok).map((x) => `${x.n} (${x.n.length})`);
    const nonCompliant = numbers.filter((x) => !pattern.test(x.n)).map((x) => x.n);
    const list = (xs: string[]) => xs.slice(0, MAX_LISTED).join(', ') + (xs.length > MAX_LISTED ? `, … ${xs.length - MAX_LISTED} more` : '');
    const problems = [
      ...(tooLong.length ? [`${tooLong.length} number(s) longer than ${rules.max_docnumber_length} characters: ${list(tooLong)}. Lago prefix too long: credit note numbers add -CN001; keep the prefix ≤ 4 characters`] : []),
      ...(nonCompliant.length ? [`${nonCompliant.length} number(s) with characters QBO lookups cannot match: ${list(nonCompliant)}`] : []),
    ];
    checks.push(
      problems.length > 0
        ? { name: 'lago_numbers', status: 'warn', detail: problems.join('; ') }
        : { name: 'lago_numbers', status: 'pass', detail: `${numbers.length} document number(s) since ${from} fit QBO` },
    );
  } catch (err) {
    if (err instanceof AuthError) throw err;
    checks.push({ name: 'lago', status: 'fail', detail: `Lago API not reachable or key rejected: ${describeQboError(err)}` });
  }
  return checks;
}

export async function checkConfigCommand(io: CliIO, log: Logger): Promise<number> {
  const ctx = buildSyncContext(io, log, 'disabled');
  const lock = await ctx.tokenStore.lock();
  if (!lock.acquired) {
    log.result({ status: 'locked', exit_code: 0, message: 'a sync is running; run check-config again when it ends' });
    return 0;
  }
  try {
    const checks = await runChecks({ mappings: ctx.mappings, qbo: ctx.qbo, lago: ctx.lago, auth: ctx.auth, nowMs: ctx.clock.now() });
    const failed = checks.some((c) => c.status === 'fail');
    const exit_code = failed ? 2 : 0;
    log.result({ status: failed ? 'failed' : 'ok', exit_code, checks });
    return exit_code;
  } catch (err) {
    if (err instanceof AuthError || err instanceof TokenStoreError) {
      log.result({ status: 'auth_error', exit_code: 3, message: err.message });
      return 3;
    }
    throw err;
  } finally {
    await ctx.tokenStore.unlock();
  }
}
