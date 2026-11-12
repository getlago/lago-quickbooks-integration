import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { systemClock } from '../src/http/clock.js';
import { HttpError } from '../src/http/errors.js';
import { encodeParams, sendRequest, type FetchLike } from '../src/http/request.js';
import { classifyRead, classifyWrite, withRetry } from '../src/http/retry.js';
import { createThrottle, type Throttle } from '../src/http/throttle.js';
import { createLogger, type Logger } from '../src/log/logger.js';
import { registerSecret } from '../src/log/redact.js';

/**
 * Seeds the Lago TEST org with the brief §10 scenarios the sandbox has not exercised yet
 * (PLAN.md Q11: a separate script behind --seed, test org only).
 *
 * This is the only code in the repository that writes to Lago. It is not used by the sync.
 *
 * Safety:
 *  - Without --seed it only prints what it would create (no Lago request at all).
 *  - With --seed it refuses unless mappings.yaml says `environment: sandbox` AND
 *    --confirm-billing-entity=<code> names a billing entity of the org the key belongs to
 *    (proof the operator looked at which org this is).
 *  - Writes go only to a fixed list of endpoints; nothing is ever deleted.
 *  - Every code carries a `qa-<tag>` marker; every created id is written to .seed/<tag>.json.
 * Payloads follow the Lago API reference and the team's lago-api-testing skill.
 */

// ---- arguments and guards ---------------------------------------------------------------------

export interface SeedArgs {
  mode: 'plan' | 'seed' | 'void';
  confirmBillingEntity?: string;
  manifest?: string;
  /** §10 throughput test: create this many one-off invoices instead of the scenario set. */
  bulk?: number;
}

export const BULK_MAX = 1000;
export const BULK_CUSTOMERS = 25;

export function parseSeedArgs(argv: readonly string[]): SeedArgs | { error: string } {
  let mode: SeedArgs['mode'] = 'plan';
  let confirmBillingEntity: string | undefined;
  let manifest: string | undefined;
  let bulk: number | undefined;
  for (const arg of argv) {
    if (arg === '--seed') mode = 'seed';
    else if (arg === '--void') mode = 'void';
    else if (arg.startsWith('--confirm-billing-entity=')) confirmBillingEntity = arg.split('=')[1];
    else if (arg.startsWith('--manifest=')) manifest = arg.split('=')[1];
    else if (arg.startsWith('--bulk=')) {
      bulk = Number(arg.split('=')[1]);
      if (!Number.isInteger(bulk) || bulk < 1 || bulk > BULK_MAX) return { error: `--bulk must be an integer from 1 to ${BULK_MAX}` };
    } else return { error: `Unknown option: ${arg}` };
  }
  if (mode === 'void' && !manifest) return { error: '--void needs --manifest=.seed/<tag>.json' };
  if (mode === 'void' && bulk) return { error: '--bulk cannot be combined with --void' };
  return {
    mode,
    ...(confirmBillingEntity ? { confirmBillingEntity } : {}),
    ...(manifest ? { manifest } : {}),
    ...(bulk ? { bulk } : {}),
  };
}

/** Returns why writing is refused, or null when every guard passes. */
export function writeRefusal(args: {
  environment: string;
  confirmBillingEntity: string | undefined;
  billingEntityCodes: readonly string[];
}): string | null {
  if (args.environment !== 'sandbox') return 'mappings.yaml environment is not "sandbox": seeding is for the test org only';
  if (!args.confirmBillingEntity) {
    return `add --confirm-billing-entity=<code> naming one of this org's billing entities (${args.billingEntityCodes.join(', ')}) to confirm it is the test org`;
  }
  if (!args.billingEntityCodes.includes(args.confirmBillingEntity)) {
    return `billing entity "${args.confirmBillingEntity}" is not in the org this API key belongs to (${args.billingEntityCodes.join(', ')}); refusing`;
  }
  return null;
}

/** Endpoints the seed may POST to. Anything else is a bug and is refused before sending. */
const WRITE_PATHS: readonly RegExp[] = [
  /^\/taxes$/,
  /^\/customers$/,
  /^\/coupons$/,
  /^\/applied_coupons$/,
  /^\/plans$/,
  /^\/add_ons$/,
  /^\/subscriptions$/,
  /^\/invoices$/,
  /^\/wallets$/,
  /^\/credit_notes\/estimate$/,
  /^\/credit_notes$/,
  /^\/payments$/,
  /^\/invoices\/[0-9a-f-]+\/void$/,
];

export function isAllowedWrite(p: string): boolean {
  return WRITE_PATHS.some((re) => re.test(p));
}

// ---- the plan --------------------------------------------------------------------------------

export interface SeedNames {
  tag: string;
  tax: string;
  coupon: string;
  plan: string;
  addOn: string;
  customerA: string;
  customerB: string;
  customerC: string;
  subA: string;
  subB1: string;
  subB2: string;
  nameA: string;
  nameB: string;
  nameC: string;
}

export function seedNames(tag: string): SeedNames {
  const longBase = `Northwind Long Legal Name Holdings International Subsidiary for Usage Based Billing Tests (QA ${tag}) `;
  return {
    tag,
    tax: `qa-${tag}-tax10`,
    coupon: `qa-${tag}-coupon15`,
    plan: `qa-${tag}-plan100`,
    addOn: `qa-${tag}-addon`,
    customerA: `qa-${tag}-coupon-tax`,
    customerB: `qa-${tag}-credits`,
    customerC: `qa-${tag}-long-name`,
    subA: `qa-${tag}-sub-a`,
    subB1: `qa-${tag}-sub-b1`,
    subB2: `qa-${tag}-sub-b2`,
    nameA: `Seed Coupon Tax (QA ${tag})`,
    nameB: `O'Brien & Sons (QA ${tag})`,
    nameC: longBase.padEnd(120, 'x'),
  };
}

/** What --seed will do, in order, with the §10 item each step serves. Printed before any write. */
export function describePlan(n: SeedNames): string[] {
  return [
    `Tag ${n.tag}. All codes start with qa-${n.tag}-. Nothing is deleted. Ids go to .seed/${n.tag}.json.`,
    '',
    'Shared setup',
    `  1. Tax ${n.tax}: 10%`,
    `  2. Coupon ${n.coupon}: fixed $15.00, once`,
    `  3. Plan ${n.plan}: $100.00 / month, paid in advance, no usage charges`,
    `  4. Add-on ${n.addOn}: $25.00`,
    '',
    '§10 "Invoice with coupon + tax"',
    `  5. Customer ${n.customerA} "${n.nameA}", USD, tax ${n.tax}`,
    `  6. Apply coupon ${n.coupon} to it`,
    `  7. Subscription ${n.subA} (anniversary) → invoice A: $100.00 − $15.00 coupon + 10% tax = $93.50 (Lago computes)`,
    '',
    '§10 "Prepaid credits + applied credit note", "Credit note → credit memo", "apostrophe"',
    `  8. Customer ${n.customerB} "${n.nameB}", USD, tax ${n.tax}`,
    `  9. Subscription ${n.subB1} → invoice B1: $100.00 + $10.00 tax = $110.00`,
    ' 10. Credit note on B1: $20.00 of the fee (+ its tax) as customer credit (amount from Lago\'s estimate)',
    ' 11. Wallet: $30.00 granted (free) prepaid credits',
    ` 12. Subscription ${n.subB2} → invoice B2: $110.00 − credit note credit − $30.00 prepaid (Lago computes)`,
    '',
    '§10 "Long names", "Paid invoice → payment" (payments sync stays off until you enable it)',
    ` 13. Customer ${n.customerC} "${n.nameC.slice(0, 40)}…" (${n.nameC.length} chars, QBO keeps 100), USD, no tax`,
    ` 14. One-off invoice C: add-on ${n.addOn} × 1 = $25.00`,
    ' 15. Manual payment of invoice C, full amount (reference qa-seed)',
    '',
    '§10 "Voided invoice → voided in QBO" (two steps: sync first, then void)',
    ` 16. One-off invoice D for ${n.customerA}: add-on × 1 = $25.00 + tax`,
    '     Later: npm run seed -- --void --manifest=… voids D in Lago, then the next sync voids it in QBO.',
    '',
    'Not seeded: "[" prefix and 22+ char numbers (already in the org), 500 documents (separate, on request).',
  ];
}

// ---- bulk (§10 "500 documents within 10 minutes") -------------------------------------------------

export interface BulkCustomer {
  externalId: string;
  name: string;
  taxed: boolean;
}

export interface BulkInvoice {
  index: number;
  customer: BulkCustomer;
  units: number;
  unitAmountCents: number;
}

export function bulkCustomers(tag: string): BulkCustomer[] {
  return Array.from({ length: BULK_CUSTOMERS }, (_, i) => {
    const nn = String(i + 1).padStart(2, '0');
    return { externalId: `qa-${tag}-bulk-${nn}`, name: `Bulk Customer ${nn} (QA ${tag})`, taxed: i % 2 === 1 };
  });
}

/** Deterministic spread: 25 customers round-robin, 1–3 units, unit prices $10.00–$18.22. */
export function bulkInvoices(tag: string, count: number): BulkInvoice[] {
  const customers = bulkCustomers(tag);
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    customer: customers[i % customers.length]!,
    units: 1 + (i % 3),
    unitAmountCents: 1000 + (i % 7) * 137,
  }));
}

export function describeBulkPlan(tag: string, count: number): string[] {
  const invoices = bulkInvoices(tag, count);
  const preTax = invoices.reduce((s, i) => s + i.units * i.unitAmountCents, 0);
  const taxed = invoices.filter((i) => i.customer.taxed).length;
  return [
    `Tag ${tag}. Throughput seed for brief §10 ("500 documents synced within 10 minutes"). Nothing is deleted. Ids go to .seed/${tag}.json.`,
    '',
    `  1. Tax qa-${tag}-tax10: 10%`,
    `  2. Add-on qa-${tag}-bulk-addon`,
    `  3. ${BULK_CUSTOMERS} customers qa-${tag}-bulk-01 … -${String(BULK_CUSTOMERS).padStart(2, '0')} ("Bulk Customer NN (QA ${tag})"), USD; even-numbered ones taxed 10%`,
    `  4. ${count} one-off invoices, round-robin over the customers: 1–3 units at $10.00–$18.22`,
    `     ${taxed} taxed, ${count - taxed} untaxed; $${(preTax / 100).toFixed(2)} before tax in total`,
    '',
    `About ${count + BULK_CUSTOMERS + 3} Lago calls (≈ ${Math.ceil((count + BULK_CUSTOMERS + 3) / 5 / 60)} min at 5 req/s). One-off invoices cannot be deleted, only voided.`,
  ];
}

// ---- writer --------------------------------------------------------------------------------------

class SeedWriter {
  calls = 0;
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike,
    private readonly throttle: Throttle,
    private readonly log: Logger,
  ) {}

  private async request(method: 'GET' | 'POST', p: string, body?: unknown, params: Record<string, string> = {}): Promise<unknown> {
    if (method === 'POST' && !isAllowedWrite(p)) throw new Error(`seed refused to write to ${p}`);
    const query = encodeParams(params);
    const url = `${this.base}${p}${query ? `?${query}` : ''}`;
    const res = await withRetry(
      () =>
        this.throttle.run(() => {
          this.calls++;
          return sendRequest(
            this.fetchFn,
            {
              service: 'lago',
              method,
              url,
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              },
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            },
            () => systemClock.now(),
          );
        }),
      // Writes are not retried on 5xx: a repeated POST could create a second resource.
      { classify: method === 'GET' ? classifyRead : classifyWrite },
    );
    return res.body;
  }

  get = (p: string, params?: Record<string, string>) => this.request('GET', p, undefined, params);

  async post<T = Record<string, unknown>>(p: string, body: unknown, key: string): Promise<T> {
    try {
      const out = (await this.request('POST', p, body)) as Record<string, unknown> | null;
      return (key ? out?.[key] : out) as T;
    } catch (err) {
      if (err instanceof HttpError) {
        // Lago 422 bodies explain the validation problem; they hold no secrets.
        this.log.error('lago rejected a seed request', { path: p, status: err.status, body: err.body });
      }
      throw err;
    }
  }
}

interface InvoiceRow {
  lago_id: string;
  number: string;
  status: string;
  invoice_type: string;
  total_amount_cents: number;
  taxes_amount_cents?: number;
  fees?: Array<{ lago_id: string; amount_cents: number; item?: { type?: string } }>;
}

/**
 * Lago issues subscription invoices asynchronously. Waits for a new finalized invoice of `type`
 * for the customer. A draft (the org has a grace period) stops the seed with a clear message.
 */
async function waitForInvoice(w: SeedWriter, customer: string, type: string, known: Set<string>): Promise<InvoiceRow> {
  for (let i = 0; i < 45; i++) {
    const body = (await w.get('/invoices', { external_customer_id: customer, per_page: '100' })) as { invoices: InvoiceRow[] };
    const fresh = body.invoices.filter((inv) => !known.has(inv.lago_id) && inv.invoice_type === type);
    const done = fresh.find((inv) => inv.status === 'finalized');
    if (done) {
      known.add(done.lago_id);
      return ((await w.get(`/invoices/${done.lago_id}`)) as { invoice: InvoiceRow }).invoice;
    }
    if (fresh.some((inv) => inv.status === 'draft')) {
      throw new Error(`invoice for ${customer} is a draft (the org has a grace period); finalize it in Lago, then rerun the remaining steps by hand`);
    }
    await systemClock.sleep(2000);
  }
  throw new Error(`no finalized ${type} invoice for ${customer} after 90 s`);
}

// ---- main ----------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const log = createLogger({});
  const args = parseSeedArgs(process.argv.slice(2));
  if ('error' in args) {
    process.stderr.write(`${args.error}\nUsage: npm run seed [-- --seed --confirm-billing-entity=<code>] [-- --void --manifest=.seed/<tag>.json --confirm-billing-entity=<code>]\n`);
    return 2;
  }
  const { mappings, env } = loadConfig({ env: process.env, requiredEnv: ['LAGO_API_KEY'], repoRoot });
  registerSecret(env.LAGO_API_KEY);
  const base = mappings.lago.api_url.replace(/\/+$/, '');
  const target = `Target Lago org: ${new URL(base).host} (mappings.yaml environment: ${mappings.environment})`;

  if (args.mode === 'plan') {
    const tag = randomBytes(3).toString('hex');
    const lines = args.bulk ? describeBulkPlan(tag, args.bulk) : describePlan(seedNames(tag));
    const how = `npm run seed -- --seed${args.bulk ? ` --bulk=${args.bulk}` : ''} --confirm-billing-entity=<code>`;
    process.stdout.write([target, 'PLAN ONLY: nothing is sent to Lago.', '', ...lines, '', `To create it: ${how}`, ''].join('\n'));
    return 0;
  }

  const w = new SeedWriter(base, env.LAGO_API_KEY, (u, i) => fetch(u, i), createThrottle({ ratePerSecond: 5, maxConcurrent: 1 }), log);
  const entities = ((await w.get('/billing_entities')) as { billing_entities: Array<{ code: string }> }).billing_entities.map((e) => e.code);
  const refusal = writeRefusal({ environment: mappings.environment, confirmBillingEntity: args.confirmBillingEntity, billingEntityCodes: entities });
  if (refusal) {
    process.stderr.write(`${target}\nRefusing to write: ${refusal}\n`);
    return 2;
  }

  if (args.mode === 'void') {
    const manifest = JSON.parse(readFileSync(path.resolve(repoRoot, args.manifest!), 'utf8')) as { tag: string; invoice_d?: InvoiceRow };
    const d = manifest.invoice_d;
    if (!d) throw new Error('manifest has no invoice_d');
    process.stdout.write(`${target}\nVoiding seeded invoice D ${d.number} (${d.lago_id}) of tag ${manifest.tag}\n`);
    await w.post(`/invoices/${d.lago_id}/void`, {}, '');
    log.result({ status: 'voided', invoice: d.number, lago_id: d.lago_id, lago_calls: w.calls });
    return 0;
  }

  if (args.bulk) return runBulk(w, log, repoRoot, base, target, args.bulk);

  // --seed
  const n = seedNames(randomBytes(3).toString('hex'));
  process.stdout.write([target, ...describePlan(n), ''].join('\n'));
  const manifest: Record<string, unknown> = { tag: n.tag, created_at: new Date().toISOString(), target: new URL(base).host, names: n };
  const manifestPath = path.join(repoRoot, '.seed', `${n.tag}.json`);
  const save = () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  };
  const step = (label: string, detail: Record<string, unknown> = {}) => log.info(`seed: ${label}`, detail);
  const summarize = (inv: InvoiceRow) => ({ lago_id: inv.lago_id, number: inv.number, total_amount_cents: inv.total_amount_cents, taxes_amount_cents: inv.taxes_amount_cents });

  try {
    await w.post('/taxes', { tax: { code: n.tax, name: `QA ${n.tag} 10%`, rate: '10.0' } }, 'tax');
    step('tax created', { code: n.tax });
    await w.post('/coupons', { coupon: { code: n.coupon, name: `QA ${n.tag} $15 off`, coupon_type: 'fixed_amount', amount_cents: 1500, amount_currency: 'USD', frequency: 'once', expiration: 'no_expiration' } }, 'coupon');
    await w.post('/plans', { plan: { name: `QA ${n.tag} $100 monthly`, code: n.plan, interval: 'monthly', amount_cents: 10000, amount_currency: 'USD', pay_in_advance: true, charges: [] } }, 'plan');
    await w.post('/add_ons', { add_on: { code: n.addOn, name: `QA ${n.tag} add-on`, amount_cents: 2500, amount_currency: 'USD' } }, 'add_on');
    step('shared setup created', { coupon: n.coupon, plan: n.plan, add_on: n.addOn });
    save();

    // A: coupon + tax
    await w.post('/customers', { customer: { external_id: n.customerA, name: n.nameA, currency: 'USD', email: 'qa-seed-a@example.com', tax_codes: [n.tax] } }, 'customer');
    await w.post('/applied_coupons', { applied_coupon: { external_customer_id: n.customerA, coupon_code: n.coupon } }, 'applied_coupon');
    const knownA = new Set<string>();
    await w.post('/subscriptions', { subscription: { external_customer_id: n.customerA, plan_code: n.plan, external_id: n.subA, billing_time: 'anniversary' } }, 'subscription');
    const invA = await waitForInvoice(w, n.customerA, 'subscription', knownA);
    manifest.invoice_a = summarize(invA);
    save();
    step('invoice A', manifest.invoice_a as Record<string, unknown>);

    // B: credit note + prepaid credits
    await w.post('/customers', { customer: { external_id: n.customerB, name: n.nameB, currency: 'USD', email: 'qa-seed-b@example.com', tax_codes: [n.tax] } }, 'customer');
    const knownB = new Set<string>();
    await w.post('/subscriptions', { subscription: { external_customer_id: n.customerB, plan_code: n.plan, external_id: n.subB1, billing_time: 'anniversary' } }, 'subscription');
    const invB1 = await waitForInvoice(w, n.customerB, 'subscription', knownB);
    manifest.invoice_b1 = summarize(invB1);
    save();
    const fee = invB1.fees?.find((f) => f.amount_cents >= 2000);
    if (!fee) throw new Error(`invoice B1 ${invB1.number} has no fee of at least $20.00 to credit`);
    const items = [{ fee_id: fee.lago_id, amount_cents: 2000 }];
    const estimate = await w.post<Record<string, unknown> | undefined>('/credit_notes/estimate', { credit_note: { invoice_id: invB1.lago_id, items } }, 'estimated_credit_note');
    const sub = Number(estimate?.sub_total_excluding_taxes_amount_cents);
    const tax = Number(estimate?.taxes_amount_cents);
    if (!Number.isSafeInteger(sub) || !Number.isSafeInteger(tax)) {
      throw new Error(`unexpected credit note estimate response (keys: ${Object.keys(estimate ?? {}).join(', ')}); stopping before creating the credit note`);
    }
    const cn = await w.post<{ lago_id: string; number: string; total_amount_cents: number }>(
      '/credit_notes',
      { credit_note: { invoice_id: invB1.lago_id, reason: 'other', description: `QA ${n.tag}`, items, credit_amount_cents: sub + tax, refund_amount_cents: 0 } },
      'credit_note',
    );
    manifest.credit_note = { lago_id: cn.lago_id, number: cn.number, total_amount_cents: cn.total_amount_cents };
    save();
    step('credit note', manifest.credit_note as Record<string, unknown>);
    await w.post('/wallets', { wallet: { external_customer_id: n.customerB, name: `QA ${n.tag} prepaid`, currency: 'USD', rate_amount: '1.00', granted_credits: '30.00' } }, 'wallet');
    await w.post('/subscriptions', { subscription: { external_customer_id: n.customerB, plan_code: n.plan, external_id: n.subB2, billing_time: 'anniversary' } }, 'subscription');
    const invB2 = await waitForInvoice(w, n.customerB, 'subscription', knownB);
    manifest.invoice_b2 = summarize(invB2);
    save();
    step('invoice B2', manifest.invoice_b2 as Record<string, unknown>);

    // C: long name + paid one-off invoice
    await w.post('/customers', { customer: { external_id: n.customerC, name: n.nameC, currency: 'USD', email: 'qa-seed-c@example.com' } }, 'customer');
    const invC = await w.post<InvoiceRow>('/invoices', { invoice: { external_customer_id: n.customerC, currency: 'USD', fees: [{ add_on_code: n.addOn, units: 1, unit_amount_cents: 2500, description: `QA ${n.tag} one-off` }] } }, 'invoice');
    manifest.invoice_c = summarize(invC);
    save();
    await w.post('/payments', { payment: { invoice_id: invC.lago_id, amount_cents: invC.total_amount_cents, reference: `qa-seed-${n.tag}`, paid_at: new Date().toISOString() } }, 'payment');
    step('invoice C paid', manifest.invoice_c as Record<string, unknown>);

    // D: to be voided later
    const invD = await w.post<InvoiceRow>('/invoices', { invoice: { external_customer_id: n.customerA, currency: 'USD', fees: [{ add_on_code: n.addOn, units: 1, unit_amount_cents: 2500, description: `QA ${n.tag} to void` }] } }, 'invoice');
    manifest.invoice_d = summarize(invD);
    save();
    step('invoice D (to void later)', manifest.invoice_d as Record<string, unknown>);

    log.result({ status: 'seeded', tag: n.tag, manifest: path.relative(repoRoot, manifestPath), lago_calls: w.calls, ...manifest });
    return 0;
  } catch (err) {
    save();
    log.error('seed stopped; everything created so far is in the manifest', { manifest: manifestPath, error: err });
    return 1;
  }
}

async function runBulk(w: SeedWriter, log: Logger, repoRoot: string, base: string, target: string, count: number): Promise<number> {
  const tag = randomBytes(3).toString('hex');
  process.stdout.write([target, ...describeBulkPlan(tag, count), ''].join('\n'));
  const manifestPath = path.join(repoRoot, '.seed', `${tag}.json`);
  const created: Array<{ index: number; lago_id: string; number: string; total_amount_cents: number }> = [];
  const manifest: Record<string, unknown> = { tag, kind: 'bulk', created_at: new Date().toISOString(), target: new URL(base).host, invoices: created };
  const save = () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  };
  const started = Date.now();
  try {
    const tax = `qa-${tag}-tax10`;
    const addOn = `qa-${tag}-bulk-addon`;
    await w.post('/taxes', { tax: { code: tax, name: `QA ${tag} 10%`, rate: '10.0' } }, 'tax');
    await w.post('/add_ons', { add_on: { code: addOn, name: `QA ${tag} bulk item`, amount_cents: 1000, amount_currency: 'USD' } }, 'add_on');
    for (const c of bulkCustomers(tag)) {
      await w.post('/customers', { customer: { external_id: c.externalId, name: c.name, currency: 'USD', ...(c.taxed ? { tax_codes: [tax] } : {}) } }, 'customer');
    }
    save();
    log.info('seed: bulk setup created', { tax, add_on: addOn, customers: BULK_CUSTOMERS });
    for (const inv of bulkInvoices(tag, count)) {
      const row = await w.post<InvoiceRow>(
        '/invoices',
        { invoice: { external_customer_id: inv.customer.externalId, currency: 'USD', fees: [{ add_on_code: addOn, units: inv.units, unit_amount_cents: inv.unitAmountCents, description: `QA ${tag} bulk #${inv.index}` }] } },
        'invoice',
      );
      created.push({ index: inv.index, lago_id: row.lago_id, number: row.number, total_amount_cents: row.total_amount_cents });
      if (inv.index % 50 === 0) {
        save();
        log.info('seed: bulk progress', { created: inv.index, of: count, elapsed_s: Math.round((Date.now() - started) / 1000) });
      }
    }
    save();
    log.result({ status: 'seeded', kind: 'bulk', tag, manifest: path.relative(repoRoot, manifestPath), invoices: created.length, first: created[0]?.number, last: created.at(-1)?.number, lago_calls: w.calls, elapsed_s: Math.round((Date.now() - started) / 1000) });
    return 0;
  } catch (err) {
    save();
    log.error('bulk seed stopped; everything created so far is in the manifest', { manifest: manifestPath, created: created.length, error: err });
    return 1;
  }
}

function isMain(): boolean {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      createLogger({}).error('seed failed', { error: err });
      process.exitCode = 1;
    },
  );
}
