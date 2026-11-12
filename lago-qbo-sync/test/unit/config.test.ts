import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { loadConfig, loadEnv, parseMappings } from '../../src/config/load.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const exampleYaml = readFileSync(path.join(repoRoot, 'mappings.example.yaml'), 'utf8');

/** Replaces one `key: value` line of the example. Fails the test if the line is not found. */
function withLine(key: string, value: string, yaml = exampleYaml): string {
  const re = new RegExp(`^(\\s*${key}:)[^\\n#]*`, 'm');
  if (!re.test(yaml)) throw new Error(`no line for ${key}`);
  // Trailing space keeps any following "# comment" valid YAML.
  return yaml.replace(re, `$1 ${value} `);
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return [...(err as ConfigError).issues];
  }
  throw new Error('expected a ConfigError');
}

describe('parseMappings', () => {
  it('accepts mappings.example.yaml and applies nothing unexpected', () => {
    const m = parseMappings(exampleYaml);
    expect(m.environment).toBe('sandbox');
    expect(m.qbo).toEqual({
      realm_id: '1234567890123456',
      default_item_id: '1',
      discount_account_id: '1',
      tax_code_id: '',
      minor_version: 75,
    });
    expect(m.items).toEqual({ onboarding_fee: '1' });
    expect(m.sync.max_requests_per_second).toBe(5);
    expect(m.sync.max_concurrent).toBe(1);
    expect(m.sync.sync_payments).toBe(false);
    expect(m.sync.reconcile_lookback_days).toBe(45);
  });

  it('applies defaults for optional keys (brief §3.4 throttle defaults)', () => {
    const minimal = `
environment: sandbox
qbo: { realm_id: "1", default_item_id: "1", discount_account_id: "1", tax_code_id: "" }
lago: { invoice_prefix_rules: { allowed_pattern: "^[A-Za-z0-9-]+$", max_docnumber_length: 21 } }
sync: { lookback_days: 3 }
`;
    const m = parseMappings(minimal);
    expect(m.qbo.minor_version).toBe(75);
    expect(m.lago.api_url).toBe('https://api.getlago.com/api/v1');
    expect(m.items).toEqual({});
    expect(m.sync).toMatchObject({
      max_requests_per_second: 5,
      max_concurrent: 1,
      sync_payments: false,
      sync_voids: true,
      payment_lookback_days: 45,
      void_lookback_days: 45,
    });
  });

  it('rejects unknown keys instead of ignoring a typo', () => {
    const issues = issuesOf(() => parseMappings(exampleYaml.replace('sync_voids:', 'sync_void:')));
    expect(issues.join('\n')).toMatch(/sync_void/);
  });

  it('rejects unquoted or non-numeric QBO ids', () => {
    expect(issuesOf(() => parseMappings(withLine('default_item_id', '1'))).join()).toMatch(/qbo\.default_item_id/);
    expect(issuesOf(() => parseMappings(withLine('onboarding_fee', '"abc"'))).join()).toMatch(/items\.onboarding_fee/);
  });

  it('rejects NON as the tax override code', () => {
    expect(issuesOf(() => parseMappings(withLine('tax_code_id', '"NON"'))).join()).toMatch(/not NON/);
  });

  it('rejects a throttle above QBO limits (500/min, 10/s, 10 concurrent)', () => {
    expect(issuesOf(() => parseMappings(withLine('max_requests_per_second', '10'))).join()).toMatch(
      /sync\.max_requests_per_second/,
    );
    expect(issuesOf(() => parseMappings(withLine('max_concurrent', '11'))).join()).toMatch(/sync\.max_concurrent/);
  });

  it('rejects a DocNumber limit above 21 (brief §6 bug #3)', () => {
    expect(issuesOf(() => parseMappings(withLine('max_docnumber_length', '22'))).join()).toMatch(
      /max_docnumber_length/,
    );
  });

  it('rejects an invalid or unanchored prefix pattern', () => {
    expect(issuesOf(() => parseMappings(withLine('allowed_pattern', '"^[A-Z"'))).join()).toMatch(/regular expression/);
    expect(issuesOf(() => parseMappings(withLine('allowed_pattern', '"[A-Z]+"'))).join()).toMatch(/anchored/);
  });

  it('only allows Lago Cloud over https (no third-party hosts, brief §8)', () => {
    const bad = ['"http://api.getlago.com/api/v1"', '"https://evil.example.com/api/v1"', '"https://api.getlago.com/v2"'];
    for (const url of bad) expect(issuesOf(() => parseMappings(withLine('api_url', url))).join()).toMatch(/lago\.api_url/);
    expect(parseMappings(withLine('api_url', '"https://api.eu.getlago.com/api/v1"')).lago.api_url).toContain('eu');
  });

  it('rejects a reconcile window shorter than the sync window', () => {
    expect(issuesOf(() => parseMappings(withLine('reconcile_lookback_days', '2'))).join()).toMatch(/reconcile_lookback_days/);
  });

  it('rejects duplicate keys and broken YAML', () => {
    expect(() => parseMappings(exampleYaml + '\nenvironment: production\n')).toThrow(ConfigError);
    expect(() => parseMappings('qbo: [unclosed')).toThrow(/not valid YAML/);
  });

  it('reports every problem at once, not just the first', () => {
    const yaml = withLine('max_concurrent', '0', withLine('environment', 'staging'));
    expect(issuesOf(() => parseMappings(yaml)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('loadEnv', () => {
  const outside = path.join(os.tmpdir(), 'lago-qbo-sync-test', 'qbo.token.json');
  const fullEnv = {
    LAGO_API_KEY: 'lago_test_key_123456',
    QBO_CLIENT_ID: 'client_id_123456',
    QBO_CLIENT_SECRET: 'client_secret_abcdef',
    TOKEN_STORE: 'file',
    TOKEN_STORE_PATH: outside,
  };

  it('returns only the requested keys', () => {
    const env = loadEnv(fullEnv, ['QBO_CLIENT_ID', 'TOKEN_STORE'], repoRoot);
    expect(env).toEqual({ QBO_CLIENT_ID: 'client_id_123456', TOKEN_STORE: 'file' });
  });

  it('reports missing keys by name without echoing any value', () => {
    let message = '';
    try {
      loadEnv({ ...fullEnv, LAGO_API_KEY: '', TOKEN_STORE: 'vault' }, ['LAGO_API_KEY', 'QBO_CLIENT_SECRET', 'TOKEN_STORE'], repoRoot);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/LAGO_API_KEY/);
    expect(message).toMatch(/TOKEN_STORE/);
    expect(message).not.toContain(fullEnv.QBO_CLIENT_SECRET);
    expect(message).not.toContain('vault');
  });

  it('requires TOKEN_STORE_PATH to be absolute and outside the repository', () => {
    expect(issuesOf(() => loadEnv({ ...fullEnv, TOKEN_STORE_PATH: 'tokens.json' }, ['TOKEN_STORE_PATH'], repoRoot)).join()).toMatch(
      /absolute/,
    );
    const inside = path.join(repoRoot, 'secrets', 'qbo.token.json');
    expect(issuesOf(() => loadEnv({ ...fullEnv, TOKEN_STORE_PATH: inside }, ['TOKEN_STORE_PATH'], repoRoot)).join()).toMatch(
      /outside the repository/,
    );
    expect(loadEnv(fullEnv, ['TOKEN_STORE_PATH'], repoRoot).TOKEN_STORE_PATH).toBe(outside);
  });
});

describe('loadConfig', () => {
  it('reads MAPPINGS_PATH and fails clearly when the file is missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lago-qbo-cfg-'));
    const file = path.join(dir, 'm.yaml');
    writeFileSync(file, exampleYaml);
    const cfg = loadConfig({ env: { MAPPINGS_PATH: file }, requiredEnv: [], repoRoot: dir });
    expect(cfg.mappings.qbo.realm_id).toBe('1234567890123456');
    expect(() => loadConfig({ env: {}, requiredEnv: [], repoRoot: dir })).toThrow(/mappings\.example\.yaml/);
  });
});
