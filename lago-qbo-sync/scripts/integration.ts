import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, type Check } from '../src/cli/commands/checkConfig.js';
import { buildSyncContext, type CliIO } from '../src/cli/context.js';
import type { Mappings } from '../src/config/schema.js';
import { createLogger } from '../src/log/logger.js';
import { customerByDisplayName, txnByDocNumber, type TxnEntity } from '../src/qbo/query.js';
import type { QboTxnRow } from '../src/qbo/types.js';
import { isVoidedInQbo } from '../src/reconcile/index.js';
import { windowStart } from '../src/sync/pool.js';
import { runSync } from '../src/sync/run.js';
import type { RunSummary } from '../src/sync/summary.js';
import { checkDocNumber } from '../src/transform/docNumber.js';
import { DISPLAY_NAME_MAX } from '../src/transform/customer.js';

/**
 * Brief §9/§10: runs the sandbox test checklist and prints PASS / FAIL / PARTIAL / SKIP per item.
 *
 *   npm run integration -- --manifest=.seed/<tag>.json [--bulk-manifest=.seed/<tag>.json]
 *
 * Needs a scenario seed (npm run seed -- --seed …). Item 9 needs invoice D voided first
 * (npm run seed -- --void …); item 15 needs a bulk seed that has not been synced yet.
 *
 * What it does to the systems:
 *  - QBO sandbox: two real sync runs, with sync_payments turned on IN MEMORY for this script only
 *    (mappings.yaml is not edited). Refuses to run unless environment is sandbox.
 *  - Lago: reads only.
 *  - Two CLI child processes: one with a throwaway invalid token (item 12), one while this script
 *    holds the run lock (item 13). Neither can write anything.
 * Exit code: 0 when no item FAILs.
 */

type Status = 'PASS' | 'FAIL' | 'PARTIAL' | 'SKIP';
interface Item {
  id: number;
  name: string;
  status: Status;
  detail: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = path.join(repoRoot, 'dist', 'src', 'cli', 'index.js');
const cents = (d: unknown) => Math.round(Number(d ?? 0) * 100);

interface Manifest {
  tag: string;
  names: { nameA: string; nameB: string; nameC: string };
  invoice_a: { lago_id: string };
  invoice_b2: { lago_id: string };
  invoice_c: { lago_id: string };
  invoice_d: { lago_id: string };
  credit_note: { lago_id: string };
}

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

/** Runs the built CLI in a child process; returns its exit code and output. */
function runCli(args: string[], envOverride: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: repoRoot, env: { ...process.env, ...envOverride } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function lastJson(text: string): Record<string, unknown> {
  const start = text.lastIndexOf('\n{\n') >= 0 ? text.lastIndexOf('\n{\n') + 1 : text.indexOf('{');
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<number> {
  const manifestPath = arg('manifest');
  if (!manifestPath) {
    process.stderr.write('Usage: npm run integration -- --manifest=.seed/<tag>.json [--bulk-manifest=.seed/<tag>.json]\n');
    return 2;
  }
  const manifest = JSON.parse(readFileSync(path.resolve(repoRoot, manifestPath), 'utf8')) as Manifest;
  const bulkPath = arg('bulk-manifest');
  const bulk = bulkPath ? (JSON.parse(readFileSync(path.resolve(repoRoot, bulkPath), 'utf8')) as { tag: string; invoices: unknown[] }) : null;

  const log = createLogger({ level: 'warn' });
  const io: CliIO = {
    argv: [],
    env: process.env,
    cwd: repoRoot,
    fetch: (u, i) => fetch(u, i),
    stdout: (t) => process.stdout.write(t + '\n'),
    stderr: (l) => process.stderr.write(l + '\n'),
  };
  const read = buildSyncContext(io, log, 'disabled');
  if (read.mappings.environment !== 'sandbox') {
    process.stderr.write('Refusing: mappings.yaml environment is not "sandbox".\n');
    return 2;
  }
  const items: Item[] = [];
  const record = (id: number, name: string, status: Status, detail: string) => items.push({ id, name, status, detail });

  /** Holds the run lock for read phases, so a scheduled sync cannot interleave. */
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const lock = await read.tokenStore.lock();
    if (!lock.acquired) throw new Error('another run holds the lock; try again when it ends');
    try {
      return await fn();
    } finally {
      await read.tokenStore.unlock();
    }
  };
  const qboDocs = async (entity: TxnEntity, number: string) => {
    const q = await read.qbo.query<QboTxnRow & { Line?: Array<Record<string, unknown>>; TxnTaxDetail?: { TotalTax?: number } }>(txnByDocNumber(entity, number), entity);
    return q.kind === 'found' ? q.rows : [];
  };
  const qboCustomers = async (name: string) => {
    const q = await read.qbo.query<{ Id: string; DisplayName: string }>(customerByDisplayName(name), 'Customer');
    return q.kind === 'found' ? q.rows : [];
  };

  // ---- 1. check-config, and a deliberately wrong item id ---------------------------------------
  const checks = await withLock(async () => {
    const deps = { mappings: read.mappings, qbo: read.qbo, lago: read.lago, auth: read.auth, nowMs: Date.now() };
    const real = await runChecks(deps);
    const wrong: Mappings = { ...read.mappings, items: { ...read.mappings.items, integration_wrong_item: '999999' } };
    const bad = await runChecks({ ...deps, mappings: wrong });
    return { real, bad };
  });
  const failed = checks.real.filter((c) => c.status === 'fail');
  const caught = checks.bad.find((c: Check) => c.name === 'qbo_items' && c.status === 'fail' && c.detail.includes('999999'));
  record(1, 'check-config passes; wrong item ID is caught', failed.length === 0 && caught ? 'PASS' : 'FAIL',
    failed.length ? `check-config failed: ${failed.map((c) => c.name).join(', ')}` : caught ? caught.detail : 'wrong item id was not reported');

  // ---- two real sync runs (payments on, in memory only) -----------------------------------------
  const withPayments: Mappings = { ...read.mappings, sync: { ...read.mappings.sync, sync_payments: true } };
  const sync = async (): Promise<RunSummary> => {
    const ctx = buildSyncContext(io, log, 'enabled');
    return runSync({ mappings: withPayments, lago: ctx.lago, qbo: ctx.qbo, auth: ctx.auth, tokenStore: ctx.tokenStore, log, mode: 'apply' });
  };
  process.stderr.write('Running sync 1 of 2 (sandbox, payments on in memory)…\n');
  const run1 = await sync();
  process.stderr.write(`  done in ${Math.round(run1.duration_ms / 1000)} s; sync 2 of 2…\n`);
  const run2 = await sync();
  process.stderr.write(`  done in ${Math.round(run2.duration_ms / 1000)} s; checking documents…\n`);
  const writesInRun2 = (['customer', 'invoice', 'credit_note', 'payment', 'void'] as const).reduce(
    (n, e) => n + run2.counts[e].created + run2.counts[e].updated + run2.counts[e].voided,
    0,
  );

  await withLock(async () => {
    const lago = (id: string) => read.lago.getInvoice(id);

    // ---- 2, 3: customers ----------------------------------------------------------------------
    const a = await qboCustomers(manifest.names.nameA);
    const b = await qboCustomers(manifest.names.nameB);
    const c = await qboCustomers(manifest.names.nameC.substring(0, DISPLAY_NAME_MAX));
    record(2, 'New Lago customer → QBO customer; rerun → skipped',
      a.length === 1 && b.length === 1 && c.length === 1 && run2.counts.customer.created === 0 && run2.counts.customer.updated === 0 ? 'PASS' : 'FAIL',
      `seeded customers in QBO: ${a.length}/${b.length}/${c.length} (want 1 each, long name cut to ${DISPLAY_NAME_MAX}); rerun created ${run2.counts.customer.created}, updated ${run2.counts.customer.updated}, skipped ${run2.counts.customer.skipped}`);
    record(3, 'Customer name with an apostrophe syncs', b.length === 1 && b[0]!.DisplayName === manifest.names.nameB ? 'PASS' : 'FAIL',
      `QBO DisplayName ${JSON.stringify(b[0]?.DisplayName ?? null)}`);

    // ---- 4: coupon + tax ------------------------------------------------------------------------
    const invA = await lago(manifest.invoice_a.lago_id);
    const qA = await qboDocs('Invoice', invA.number);
    const coupon = (invA.credits ?? []).filter((x) => x.before_taxes).reduce((s, x) => s + x.amount_cents, 0);
    const discount = (qA[0]?.Line ?? []).filter((l) => l.DetailType === 'DiscountLineDetail').reduce((s, l) => s + cents(l.Amount), 0);
    const okA = qA.length === 1 && cents(qA[0]!.TotalAmt) === invA.total_amount_cents && cents(qA[0]!.TxnTaxDetail?.TotalTax) === (invA.taxes_amount_cents ?? 0) && discount === coupon && coupon > 0;
    record(4, 'Invoice with coupon + tax matches Lago to the cent', okA ? 'PASS' : 'FAIL',
      `${invA.number}: total ${invA.total_amount_cents / 100}/${qA[0]?.TotalAmt}, tax ${(invA.taxes_amount_cents ?? 0) / 100}/${qA[0]?.TxnTaxDetail?.TotalTax}, discount ${coupon / 100}/${discount / 100} (Lago/QBO)`);

    // ---- 5: prepaid + applied credit note --------------------------------------------------------
    const invB2 = await lago(manifest.invoice_b2.lago_id);
    const qB2 = await qboDocs('Invoice', invB2.number);
    const lineSum = (text: string) => (qB2[0]?.Line ?? []).filter((l) => l.Description === text).reduce((s, l) => s + cents(l.Amount), 0);
    const cnCredit = (invB2.credits ?? []).filter((x) => !x.before_taxes).reduce((s, x) => s + x.amount_cents, 0);
    const prepaid = invB2.prepaid_credit_amount_cents ?? 0;
    const okB2 = qB2.length === 1 && cents(qB2[0]!.TotalAmt) === invB2.total_amount_cents && lineSum('Credit note credits') === -cnCredit && lineSum('Prepaid credits') === -prepaid && cnCredit > 0 && prepaid > 0;
    record(5, 'Prepaid credits + applied credit note → negative lines', okB2 ? 'PASS' : 'FAIL',
      `${invB2.number}: total ${invB2.total_amount_cents / 100}/${qB2[0]?.TotalAmt}, credit note ${-cnCredit / 100}/${lineSum('Credit note credits') / 100}, prepaid ${-prepaid / 100}/${lineSum('Prepaid credits') / 100} (Lago/QBO)`);

    // ---- 6: credit memo -------------------------------------------------------------------------
    const cn = await read.lago.getCreditNote(manifest.credit_note.lago_id);
    const qCn = await qboDocs('CreditMemo', cn.number);
    const okCn = qCn.length === 1 && cents(qCn[0]!.TotalAmt) === cn.total_amount_cents && cents(qCn[0]!.TxnTaxDetail?.TotalTax) === (cn.taxes_amount_cents ?? 0) && run2.counts.credit_note.created === 0;
    record(6, 'Credit note → credit memo; rerun → skipped', okCn ? 'PASS' : 'FAIL',
      `${cn.number}: total ${cn.total_amount_cents / 100}/${qCn[0]?.TotalAmt}, copies ${qCn.length}, rerun created ${run2.counts.credit_note.created}`);

    // ---- 7: payment -----------------------------------------------------------------------------
    const invC = await lago(manifest.invoice_c.lago_id);
    const qC = await qboDocs('Invoice', invC.number);
    const okPay = invC.payment_status === 'succeeded' && qC.length === 1 && qC[0]!.Balance === 0 && run2.counts.payment.created === 0;
    record(7, 'Paid invoice → payment linked, balance 0; rerun → skipped', okPay ? 'PASS' : 'FAIL',
      `${invC.number}: Lago ${invC.payment_status}, QBO balance ${qC[0]?.Balance}; rerun payments created ${run2.counts.payment.created}, skipped ${run2.counts.payment.skipped}`);

    // ---- 8: deferred payment --------------------------------------------------------------------
    const deferred = [...run1.deferred, ...run2.deferred].filter((d) => d.entity === 'payment');
    record(8, 'Payment for an invoice not yet in QBO → deferred, then synced next run', deferred.length > 0 ? 'PARTIAL' : 'SKIP',
      deferred.length > 0
        ? `deferred (never failed): ${[...new Set(deferred.map((d) => d.lago_number))].join(', ')}. "Synced next run" happens only when the invoice is created, i.e. issued inside lookback_days; proven by the unit test "payments run after invoices" (README › Known limitations)`
        : 'no paid invoice missing from QBO in the payment window');

    // ---- 9: void --------------------------------------------------------------------------------
    const invD = await lago(manifest.invoice_d.lago_id);
    const qD = await qboDocs('Invoice', invD.number);
    if (invD.status !== 'voided') {
      record(9, 'Voided invoice → voided in QBO', 'SKIP', `${invD.number} is not voided in Lago yet: npm run seed -- --void --manifest=${manifestPath} --confirm-billing-entity=<code>, then rerun`);
    } else {
      record(9, 'Voided invoice → voided in QBO', qD.length === 1 && isVoidedInQbo(qD[0]!) && run2.counts.void.voided === 0 ? 'PASS' : 'FAIL',
        `${invD.number}: QBO TotalAmt ${qD[0]?.TotalAmt}, Balance ${qD[0]?.Balance}, note ${JSON.stringify(qD[0]?.PrivateNote ?? '').slice(0, 30)}…; rerun voided ${run2.counts.void.voided}`);
    }

    // ---- 10, 11: numbers QBO cannot hold safely -------------------------------------------------
    const from = windowStart(Date.now(), read.mappings.sync.reconcile_lookback_days);
    const listed = await read.lago.listInvoices({ status: 'finalized', issuing_date_from: from });
    const cns = await read.lago.listCreditNotes({ issuing_date_from: from });
    const bracket = listed.items.filter((i) => i.number.includes('['));
    if (bracket.length === 0) {
      record(10, 'Prefix with [ → check-config warning, no duplicate', 'SKIP', 'no "[" numbers in the reconcile window');
    } else {
      const warned = checks.real.some((c) => c.status === 'warn' && c.detail.includes('['));
      const copies = await Promise.all(bracket.map(async (i) => [i.number, (await qboDocs('Invoice', i.number)).length] as const));
      const dup = copies.filter(([, n]) => n > 1);
      record(10, 'Prefix with [ → check-config warning, no duplicate', warned && dup.length === 0 ? 'PASS' : 'FAIL',
        `warning ${warned ? 'shown' : 'MISSING'}; QBO copies: ${copies.map(([n, k]) => `${n}=${k}`).join(', ')}`);
    }
    const long = [...listed.items.map((i) => ({ n: i.number, kind: 'invoice' as const })), ...cns.items.map((c) => ({ n: c.number, kind: 'credit_note' as const }))]
      .filter((x) => x.n.length > read.mappings.lago.invoice_prefix_rules.max_docnumber_length);
    if (long.length === 0) {
      record(11, '22+ character number → explicit failure, run continues', 'SKIP', 'no over-long numbers in the reconcile window');
    } else {
      const messages = long.map((x) => checkDocNumber(x.n, x.kind, read.mappings.lago.invoice_prefix_rules));
      const explicit = messages.every((r) => !r.ok && r.reason.includes('QBO allows') && r.reason.includes('Lago prefix too long'));
      const reported = long.every((x) => run1.missing_in_qbo.items.some((m) => m.lago_number === x.n && m.reason === 'docnumber_too_long'));
      record(11, '22+ character number → explicit failure, run continues', explicit && reported && run1.status === 'completed' ? 'PASS' : 'FAIL',
        `${long.map((x) => `${x.n} (${x.n.length})`).join(', ')}: explicit message ${explicit ? 'yes' : 'NO'}, in missing_in_qbo ${reported ? 'yes' : 'NO'}, run ${run1.status}`);
    }

    // ---- 15: throughput -------------------------------------------------------------------------
    if (!bulk) {
      record(15, '500 documents synced within 10 minutes', 'SKIP', 'pass --bulk-manifest after a fresh bulk seed (npm run seed -- --seed --bulk=500 …)');
    } else if (run1.counts.invoice.created < 500) {
      record(15, '500 documents synced within 10 minutes', 'SKIP', `bulk ${bulk.tag} was already synced before this run (created ${run1.counts.invoice.created}); seed a fresh bulk to time it`);
    } else {
      record(15, '500 documents synced within 10 minutes', run1.duration_ms < 600_000 ? 'PASS' : 'FAIL',
        `${run1.counts.invoice.created} invoices + ${run1.counts.customer.created} customers created in ${Math.round(run1.duration_ms / 1000)} s`);
    }
  });

  // ---- 12: invalid refresh token ----------------------------------------------------------------
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lago-qbo-int-'));
  chmodSync(dir, 0o700);
  const badToken = `INVALID-integration-${Date.now()}`;
  const badPath = path.join(dir, 'qbo.token.json');
  writeFileSync(badPath, JSON.stringify({ realm_id: read.mappings.qbo.realm_id, refresh_token: badToken, refresh_expires_at: null, updated_at: new Date().toISOString() }), { mode: 0o600 });
  const bad = await runCli(['sync'], { TOKEN_STORE_PATH: badPath });
  rmSync(dir, { recursive: true, force: true });
  const realToken = (JSON.parse(readFileSync(String(process.env.TOKEN_STORE_PATH), 'utf8')) as { refresh_token: string }).refresh_token;
  const secrets = [process.env.LAGO_API_KEY, process.env.QBO_CLIENT_ID, process.env.QBO_CLIENT_SECRET, realToken, badToken].filter((s): s is string => !!s);
  const leaked = secrets.filter((s) => (bad.stdout + bad.stderr).includes(s)).length;
  const badResult = lastJson(bad.stdout);
  record(12, 'Invalid refresh token → exit 3, reconnect message, no secret', bad.code === 3 && String(badResult.message ?? '').includes('npm run auth') && leaked === 0 ? 'PASS' : 'FAIL',
    `exit ${bad.code}; message ${JSON.stringify(String(badResult.message ?? '')).slice(0, 70)}…; ${secrets.length} secrets checked, ${leaked} found in output`);

  // ---- 13: two runs at once ------------------------------------------------------------------
  const held = await read.tokenStore.lock();
  let second = { code: -1, stdout: '', stderr: '' };
  try {
    second = await runCli(['dry-run']);
  } finally {
    if (held.acquired) await read.tokenStore.unlock();
  }
  const secondResult = lastJson(second.stdout);
  record(13, 'Two runs at once → second exits on the lock', held.acquired && second.code === 0 && secondResult.status === 'locked' ? 'PASS' : 'FAIL',
    `second run: exit ${second.code}, status ${String(secondResult.status)}, "${String(secondResult.message ?? '').slice(0, 60)}…"`);

  // ---- 14: every QBO call 200 ------------------------------------------------------------------
  const unexpected = [...new Set([...run1.qbo.unexpected_statuses, ...run2.qbo.unexpected_statuses, ...Object.keys(read.qbo.stats.byStatus).filter((s) => !['200', '401', '429'].includes(s))])];
  record(14, 'Every QBO call returned 200 (401/429 only if retried)', unexpected.length === 0 ? 'PASS' : 'FAIL',
    `run 1 ${JSON.stringify(run1.qbo.by_status)}, run 2 ${JSON.stringify(run2.qbo.by_status)}, checks ${JSON.stringify(read.qbo.stats.byStatus)}${unexpected.length ? `; unexpected ${unexpected.join(', ')}` : ''}`);

  // ---- report ---------------------------------------------------------------------------------
  items.sort((x, y) => x.id - y.id);
  const width = Math.max(...items.map((i) => i.name.length));
  process.stdout.write(`\nIntegration checklist (brief §10), sandbox realm ${read.mappings.qbo.realm_id}, seed ${manifest.tag}\n\n`);
  for (const i of items) process.stdout.write(`${i.status.padEnd(7)} ${String(i.id).padStart(2)}. ${i.name.padEnd(width)}  ${i.detail}\n`);
  const count = (s: Status) => items.filter((i) => i.status === s).length;
  process.stdout.write(`\n${count('PASS')} pass, ${count('PARTIAL')} partial, ${count('SKIP')} skip, ${count('FAIL')} fail. Writes in rerun: ${writesInRun2}.\n`);
  return count('FAIL') > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    createLogger({}).error('integration run failed', { error: err });
    process.exitCode = 1;
  },
);
