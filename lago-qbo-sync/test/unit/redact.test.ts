import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { createLogger } from '../../src/log/logger.js';
import { clearSecretsForTests, REDACTED, redactString, redactValue, registerSecret } from '../../src/log/redact.js';

// Distinctive fake values, so a grep of captured output proves they never escape (brief §8).
const SECRETS = {
  lagoKey: 'TEST-lago-key-7f3a9c1e',
  clientId: 'TEST-client-id-ab12cd',
  clientSecret: 'TEST-client-secret-9z8y7x',
  refreshToken: 'TEST-refresh-AB12+/cd==',
  accessToken: 'TEST-access-eyJhbGciOi.payload.sig',
};

afterEach(() => clearSecretsForTests());

function registerAll() {
  for (const value of Object.values(SECRETS)) registerSecret(value);
}

function expectNoSecrets(text: string) {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(text, `${name} leaked`).not.toContain(value);
    expect(text, `${name} (url-encoded) leaked`).not.toContain(encodeURIComponent(value));
    expect(text, `${name} (base64) leaked`).not.toContain(Buffer.from(value).toString('base64'));
  }
}

describe('redactString', () => {
  it('removes registered secrets and their encoded forms', () => {
    registerAll();
    const text = [
      `key=${SECRETS.lagoKey}`,
      `body refresh=${encodeURIComponent(SECRETS.refreshToken)}`,
      `b64 ${Buffer.from(SECRETS.clientSecret).toString('base64')}`,
    ].join(' | ');
    const out = redactString(text);
    expectNoSecrets(out);
    expect(out).toContain(REDACTED);
  });

  it('removes bearer/basic credentials and token parameters even when not registered', () => {
    const out = redactString(
      'Authorization: Bearer abc.def.ghi; Basic dXNlcjpwYXNz; grant_type=refresh_token&refresh_token=r-123&code=xyz&state=s1',
    );
    expect(out).not.toMatch(/abc\.def\.ghi|dXNlcjpwYXNz|r-123|xyz/);
    expect(out).toContain('state=s1');
    expect(out).toContain('grant_type=refresh_token');
  });

  it('redacts token fields inside raw JSON text (e.g. an Intuit response body in an error)', () => {
    const out = redactString('{"access_token":"a-1","refresh_token":"r-1","expires_in":3600}');
    expect(out).not.toMatch(/a-1|r-1/);
    expect(out).toContain('"expires_in":3600');
  });

  it('ignores values too short to be secrets, so ordinary words survive', () => {
    registerSecret('abc');
    expect(redactString('abc def')).toBe('abc def');
  });
});

describe('redactValue', () => {
  it('blanks sensitive keys whatever their value, keeps business fields such as item codes', () => {
    const out = redactValue({
      headers: { Authorization: 'anything', Accept: 'application/json' },
      refresh_token: 'x',
      clientSecret: 'y',
      item: { code: 'api_calls' },
      Fault: { Error: [{ code: '6240', Message: 'Duplicate Name' }] },
    });
    expect(out).toEqual({
      headers: { Authorization: REDACTED, Accept: 'application/json' },
      refresh_token: REDACTED,
      clientSecret: REDACTED,
      item: { code: 'api_calls' },
      Fault: { Error: [{ code: '6240', Message: 'Duplicate Name' }] },
    });
  });

  it('redacts error messages, stacks, causes and custom fields', () => {
    registerAll();
    const cause = new Error(`token endpoint said ${SECRETS.refreshToken} is invalid`);
    const err = new Error(`request with ${SECRETS.accessToken} failed`, { cause });
    (err as unknown as Record<string, unknown>).request = { url: `https://x/?api_key=${SECRETS.lagoKey}` };
    const out = JSON.stringify(redactValue(err));
    expectNoSecrets(out);
    expect(out).toContain('failed');
  });

  it('survives circular structures', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactValue(a)).toEqual({ name: 'a', self: '[Circular]' });
  });
});

describe('logger', () => {
  it('never writes a test secret to stdout or stderr (brief §8 grep test)', () => {
    registerAll();
    const out: string[] = [];
    const log = createLogger({ level: 'debug', stderr: (l) => out.push(l), stdout: (t) => out.push(t) });

    log.debug('calling QBO', { headers: { Authorization: `Bearer ${SECRETS.accessToken}` } });
    log.info(`refreshed token ${SECRETS.refreshToken}`);
    log.warn('lago call', { url: `https://api.getlago.com/api/v1/invoices?x=${SECRETS.lagoKey}` });
    log.error('auth failed', {
      err: new Error(`invalid_client for ${SECRETS.clientId}:${SECRETS.clientSecret}`),
      basic: `Basic ${Buffer.from(`${SECRETS.clientId}:${SECRETS.clientSecret}`).toString('base64')}`,
    });
    log.child({ run: 'r1' }).error('config', { err: new ConfigError('bad', [`LAGO_API_KEY: ${SECRETS.lagoKey}`]) });
    log.result({ failures: [{ reason: `token ${SECRETS.accessToken} rejected` }] });

    const captured = out.join('\n');
    expect(out.length).toBe(6);
    expectNoSecrets(captured);
    // Lines remain machine-readable.
    for (const line of out.slice(0, 5)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('respects the level threshold and binds child fields', () => {
    const out: string[] = [];
    const log = createLogger({ level: 'warn', stderr: (l) => out.push(l), now: () => new Date(0) });
    log.info('hidden');
    log.child({ run: 'r1' }).warn('shown', { n: 1 });
    expect(out).toEqual(['{"ts":"1970-01-01T00:00:00.000Z","level":"warn","msg":"shown","run":"r1","n":1}']);
  });
});
