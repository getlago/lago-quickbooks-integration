import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCallback, waitForCallback } from '../../src/cli/commands/auth.js';
import { runChecks, type CheckDeps } from '../../src/cli/commands/checkConfig.js';
import { resolveMode } from '../../src/cli/commands/sync.js';
import type { CliIO } from '../../src/cli/context.js';
import { parseArgs, runCli } from '../../src/cli/index.js';
import type { FetchLike } from '../../src/http/request.js';
import { clearSecretsForTests } from '../../src/log/redact.js';
import type { Lookup } from '../../src/reconcile/index.js';
import { instantClock, json, type Recorded } from '../fakes.js';
import { testMappings } from '../helpers.js';

afterEach(() => clearSecretsForTests());

describe('parseArgs', () => {
  it('accepts the four commands and known flags only', () => {
    expect(parseArgs(['sync', '--apply'])).toEqual({ command: 'sync', apply: true, verbose: false });
    expect(parseArgs(['dry-run', '--verbose'])).toEqual({ command: 'dry-run', apply: false, verbose: true });
    expect(parseArgs(['check-config'])).toMatchObject({ command: 'check-config' });
    expect(parseArgs(['auth'])).toMatchObject({ command: 'auth' });
    expect(parseArgs([])).toEqual({ error: 'Unknown command: (none)' });
    expect(parseArgs(['sync', '--force'])).toEqual({ error: 'Unknown option: --force' });
    expect(parseArgs(['dry-run', '--apply'])).toEqual({ error: '--apply only applies to sync' });
  });
});

describe('resolveMode (brief §8: production defaults to dry-run)', () => {
  it('sandbox sync applies; production sync needs --apply; dry-run never writes', () => {
    expect(resolveMode('sync', 'sandbox', false)).toEqual({ mode: 'apply' });
    expect(resolveMode('sync', 'production', false)).toMatchObject({ mode: 'dry-run', notice: expect.stringContaining('--apply') });
    expect(resolveMode('sync', 'production', true)).toEqual({ mode: 'apply' });
    expect(resolveMode('dry-run', 'sandbox', true)).toEqual({ mode: 'dry-run' });
  });
});

describe('runChecks (check-config, brief §7.1)', () => {
  function deps(over: { items?: Record<string, string>; existing?: Record<string, string[]>; prefix?: string; numbers?: string[]; country?: string; taxCode?: string } = {}): CheckDeps {
    const m = testMappings({ items: over.items ?? { onboarding_fee: '40' }, taxCodeId: over.taxCode ?? '7' });
    const existing = over.existing ?? { Item: ['1', '40'], Account: ['1'], TaxCode: ['7'] };
    return {
      mappings: m,
      nowMs: Date.parse('2026-10-24T00:00:00Z'),
      auth: { getAccessToken: async () => 't' },
      qbo: {
        companyContext: async () => ({ country: over.country ?? 'US', homeCurrency: 'USD', multiCurrencyEnabled: false }),
        query: async <Row>(statement: string, entity: string): Promise<Lookup<Row>> => {
          const ids = [...statement.matchAll(/'(\d+)'/g)].map((x) => x[1]!);
          const rows = ids.filter((id) => existing[entity]?.includes(id)).map((Id) => ({ Id, Active: true }));
          return rows.length ? { kind: 'found', rows: rows as Row[] } : { kind: 'none' };
        },
      },
      lago: {
        listBillingEntities: async () => [{ code: 'acme', document_number_prefix: over.prefix ?? 'ACME', document_numbering: 'per_billing_entity' }],
        listInvoices: async () => ({
          items: (over.numbers ?? ['ACME-202610-001']).map((n) => ({ lago_id: n, number: n, issuing_date: '2026-10-01', currency: 'USD', status: 'finalized', invoice_type: 'subscription', total_amount_cents: 1 })),
          invalid: [],
        }),
        listCreditNotes: async () => ({ items: [], invalid: [] }),
      },
    };
  }
  const byName = (checks: Awaited<ReturnType<typeof runChecks>>) => Object.fromEntries(checks.map((c) => [c.name, c]));

  it('passes a correct configuration', async () => {
    const checks = await runChecks(deps());
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ['config', 'pass'],
      ['qbo_token', 'pass'],
      ['qbo_company', 'pass'],
      ['qbo_items', 'pass'],
      ['qbo_discount_account', 'pass'],
      ['qbo_tax_code', 'pass'],
      ['lago_prefix', 'pass'],
      ['lago_numbers', 'pass'],
    ]);
  });

  it('catches a deliberately wrong item id and names the mapping that uses it (§10)', async () => {
    const c = byName(await runChecks(deps({ items: { onboarding_fee: '999' } })));
    expect(c.qbo_items).toEqual({ name: 'qbo_items', status: 'fail', detail: 'Item 999 (items.onboarding_fee) does not exist' });
  });

  it('warns about a [ prefix and numbers longer than 21 characters (§6 bugs #2, #3, §10)', async () => {
    const c = byName(await runChecks(deps({ prefix: '[AC]', numbers: ['[AC]-202610-001', 'LAGO-DEMO-202610-004-XX'] })));
    expect(c.lago_prefix!.status).toBe('warn');
    expect(c.lago_prefix!.detail).toContain('prefix "[AC]"');
    expect(c.lago_numbers!.status).toBe('warn');
    expect(c.lago_numbers!.detail).toContain('LAGO-DEMO-202610-004-XX (23)');
    expect(c.lago_numbers!.detail).toContain('[AC]-202610-001');
  });

  it('fails a non-US company, warns on an empty tax code', async () => {
    expect(byName(await runChecks(deps({ country: 'CA' }))).qbo_company!.status).toBe('fail');
    expect(byName(await runChecks(deps({ taxCode: '' }))).qbo_tax_code!.status).toBe('warn');
  });
});

describe('auth callback (brief §7.3)', () => {
  it('validates state, error and required parameters', () => {
    const u = (q: string) => new URL(`http://localhost:8000/callback?${q}`);
    expect(parseCallback(u('code=c1&realmId=42&state=s'), 's')).toEqual({ ok: true, code: 'c1', realmId: '42' });
    expect(parseCallback(u('code=c1&realmId=42&state=x'), 's')).toMatchObject({ ok: false, reason: expect.stringContaining('state') });
    expect(parseCallback(u('error=access_denied&state=s'), 's')).toMatchObject({ ok: false, reason: expect.stringContaining('access_denied') });
    expect(parseCallback(u('realmId=42&state=s'), 's')).toMatchObject({ ok: false });
  });

  it('receives one redirect on the loopback listener, then closes', async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const waiting = waitForCallback(port, 'st', 5000);
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=c1&realmId=42&state=st`);
    expect(res.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'c1', realmId: '42' });
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });
});

// ---- end-to-end through runCli, with a routing fake fetch ------------------------------------

const SECRETS = {
  LAGO_API_KEY: 'TEST-e2e-lago-key-123456',
  QBO_CLIENT_ID: 'TEST-e2e-client-id-123456',
  QBO_CLIENT_SECRET: 'TEST-e2e-client-secret-123456',
};
const REFRESH = 'TEST-e2e-refresh-token-123456';

function workspace(environment: 'sandbox' | 'production' = 'sandbox') {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'lago-qbo-repo-'));
  const example = readFileSync(path.resolve(import.meta.dirname, '../../mappings.example.yaml'), 'utf8');
  writeFileSync(path.join(repo, 'mappings.yaml'), example.replace('environment: sandbox', `environment: ${environment}`));
  const secure = mkdtempSync(path.join(os.tmpdir(), 'lago-qbo-secure-'));
  chmodSync(secure, 0o700);
  const tokenPath = path.join(secure, 'qbo.token.json');
  writeFileSync(
    tokenPath,
    JSON.stringify({ realm_id: '1234567890123456', refresh_token: REFRESH, refresh_expires_at: null, updated_at: 'x' }),
    { mode: 0o600 },
  );
  return { repo, tokenPath, env: { ...SECRETS, TOKEN_STORE: 'file', TOKEN_STORE_PATH: tokenPath } };
}

/** Routes by URL: Intuit token endpoint, QBO reads, Lago lists. Records every request. */
function router(tokenResponse: () => Response): FetchLike & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string> });
    if (url.startsWith('https://oauth.platform.intuit.com/')) return tokenResponse();
    if (url.includes('/companyinfo/')) return json(200, { CompanyInfo: { Country: 'US' } });
    if (url.includes('/preferences')) return json(200, { Preferences: { CurrencyPrefs: { MultiCurrencyEnabled: false, HomeCurrency: { value: 'USD' } } } });
    if (url.includes('api.getlago.com/api/v1/invoices')) return json(200, { invoices: [], meta: { current_page: 1, next_page: null } });
    if (url.includes('api.getlago.com/api/v1/credit_notes')) return json(200, { credit_notes: [], meta: { current_page: 1, next_page: null } });
    throw new Error(`unrouted ${url}`);
  }) as FetchLike & { calls: Recorded[] };
  fn.calls = calls;
  return fn;
}

async function cli(argv: string[], ws: ReturnType<typeof workspace>, fetch: FetchLike) {
  const out: string[] = [];
  const io: CliIO = {
    argv,
    env: ws.env,
    cwd: ws.repo,
    fetch,
    stdout: (t) => out.push(t),
    stderr: (l) => out.push(l),
    clock: instantClock(Date.parse('2026-10-24T12:00:00Z')),
  };
  const code = await runCli(io);
  const result = JSON.parse(out.filter((l) => l.startsWith('{\n')).pop() ?? '{}') as Record<string, unknown>;
  return { code, out: out.join('\n'), result };
}

describe('runCli end to end (offline)', () => {
  it('a full sync run with an empty window: exit 0, rotated token stored, no secret in any output', async () => {
    const ws = workspace();
    const fetch = router(() => json(200, { access_token: 'TEST-e2e-access-123456', refresh_token: 'TEST-e2e-refresh-new-123456', expires_in: 3600 }));
    const r = await cli(['sync', '--verbose'], ws, fetch);
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ status: 'completed', mode: 'apply', exit_code: 0 });
    expect(JSON.parse(readFileSync(ws.tokenPath, 'utf8')).refresh_token).toBe('TEST-e2e-refresh-new-123456');
    for (const secret of [...Object.values(SECRETS), REFRESH, 'TEST-e2e-access-123456', 'TEST-e2e-refresh-new-123456']) {
      expect(r.out, secret).not.toContain(secret);
    }
    expect(fetch.calls.filter((c) => c.url.includes('getlago.com')).every((c) => c.method === 'GET')).toBe(true);
  });

  it('an expired refresh token: exit 3, reconnect message, no secret in output (§10)', async () => {
    const ws = workspace();
    const r = await cli(['sync'], ws, router(() => json(400, { error: 'invalid_grant', error_description: `bad ${REFRESH}` })));
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ status: 'auth_error', exit_code: 3 });
    expect(String(r.result.message)).toContain('npm run auth');
    for (const secret of [...Object.values(SECRETS), REFRESH]) expect(r.out, secret).not.toContain(secret);
  });

  it('production without --apply runs as a dry-run and sends no QBO write', async () => {
    const ws = workspace('production');
    const fetch = router(() => json(200, { access_token: 'TEST-e2e-access-123456', refresh_token: 'TEST-e2e-refresh-new-123456' }));
    const r = await cli(['sync'], ws, fetch);
    expect(r.result).toMatchObject({ mode: 'dry-run', notice: expect.stringContaining('--apply') });
    expect(fetch.calls.filter((c) => c.method === 'POST' && !c.url.includes('oauth'))).toEqual([]);
    expect(fetch.calls.some((c) => c.url.startsWith('https://quickbooks.api.intuit.com/'))).toBe(true);
  });

  it('config errors exit 2 before any network call', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws.repo, 'mappings.yaml'), 'environment: staging\n');
    const fetch = router(() => json(500, {}));
    const r = await cli(['dry-run'], ws, fetch);
    expect(r.code).toBe(2);
    expect(r.result).toMatchObject({ status: 'config_error', exit_code: 2 });
    expect(fetch.calls).toEqual([]);
  });

  it('a token store readable by others is refused (brief §8)', async () => {
    const ws = workspace();
    chmodSync(ws.tokenPath, 0o644);
    const fetch = router(() => json(500, {}));
    const r = await cli(['sync'], ws, fetch);
    expect(r.code).toBe(2);
    expect(String(r.result.message)).toContain('chmod 600');
    expect(fetch.calls).toEqual([]);
  });
});
