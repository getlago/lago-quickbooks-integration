import { afterEach, describe, expect, it } from 'vitest';
import { clearSecretsForTests, redactString } from '../../src/log/redact.js';
import { AuthError, RECONNECT_HINT } from '../../src/qbo/errors.js';
import { buildAuthorizeUrl, exchangeAuthorizationCode, INTUIT_OAUTH, QboAuth } from '../../src/qbo/auth.js';
import type { TokenRecord } from '../../src/tokenStore/types.js';
import { captureLogger, fakeFetch, instantClock, json, memoryStore } from '../fakes.js';

afterEach(() => clearSecretsForTests());

const REALM = '1234567890123456';
const CLIENT_ID = 'TEST-client-id-0001';
const CLIENT_SECRET = 'TEST-client-secret-0001';
const stored: TokenRecord = { realm_id: REALM, refresh_token: 'TEST-refresh-old', refresh_expires_at: null, updated_at: 'x' };
const tokens = (over: Record<string, unknown> = {}) =>
  json(200, {
    token_type: 'bearer',
    access_token: 'TEST-access-new',
    refresh_token: 'TEST-refresh-new',
    expires_in: 3600,
    x_refresh_token_expires_in: 8_726_400,
    ...over,
  });

function setup(script: Parameters<typeof fakeFetch>[0], record: TokenRecord | null = stored) {
  const fetch = fakeFetch(script);
  const store = memoryStore(record);
  const log = captureLogger();
  const clock = instantClock();
  const auth = new QboAuth({ store, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, realmId: REALM, fetch, log, clock });
  return { fetch, store, log, clock, auth };
}

describe('QboAuth refresh (brief §4.3 step 3)', () => {
  it('sends the Intuit refresh request with Basic auth and a form body', async () => {
    const { fetch, auth } = setup([tokens()]);
    expect(await auth.getAccessToken()).toBe('TEST-access-new');
    const [req] = fetch.calls;
    expect(req!.url).toBe(INTUIT_OAUTH.tokenUrl);
    expect(req!.method).toBe('POST');
    expect(req!.headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
    expect(req!.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req!.body).toBe('grant_type=refresh_token&refresh_token=TEST-refresh-old');
  });

  it('writes the rotated refresh token to the store before handing out the access token', async () => {
    const { store, auth, clock } = setup([tokens()]);
    await auth.getAccessToken();
    expect(store.events).toEqual(['get', 'set']);
    expect(store.record).toEqual({
      realm_id: REALM,
      refresh_token: 'TEST-refresh-new',
      refresh_expires_at: new Date(clock.now() + 8_726_400_000).toISOString(),
      updated_at: new Date(clock.now()).toISOString(),
    });
  });

  it('keeps the access token in memory: one refresh per run, shared by concurrent callers', async () => {
    const { fetch, auth } = setup([tokens()]);
    await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.refresh()]);
    await auth.getAccessToken();
    expect(fetch.calls).toHaveLength(1);
  });

  it('after a 401 with an old token, reuses the newer token instead of refreshing again (code review)', async () => {
    const { fetch, auth } = setup([tokens()]);
    const fresh = await auth.getAccessToken();
    expect(await auth.refresh('TEST-access-old-rejected')).toBe(fresh);
    expect(fetch.calls).toHaveLength(1);
  });

  it('registers every token as a secret so logs cannot show them', async () => {
    const { auth } = setup([tokens()]);
    await auth.getAccessToken();
    const text = redactString(`TEST-access-new TEST-refresh-new TEST-refresh-old ${CLIENT_SECRET}`);
    expect(text).not.toMatch(/TEST-access-new|TEST-refresh-new|TEST-refresh-old|TEST-client-secret/);
  });

  it('invalid_grant → AuthError with the reconnect hint, store untouched, no token in the message', async () => {
    const { auth, store } = setup([json(400, { error: 'invalid_grant', error_description: 'Token TEST-refresh-old invalid' })]);
    const err = await auth.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toBe(`Intuit rejected the refresh token (invalid_grant). ${RECONNECT_HINT}`);
    expect(store.record).toBe(stored);
  });

  it('no stored token, or a token for another company → AuthError without calling Intuit', async () => {
    const empty = setup([], null);
    await expect(empty.auth.getAccessToken()).rejects.toThrow(/No QuickBooks refresh token in \/secure\/qbo\.token\.json/);
    const other = setup([], { ...stored, realm_id: '123' });
    await expect(other.auth.getAccessToken()).rejects.toThrow(/company 123, but mappings\.yaml names 1234567890123456/);
    expect(empty.fetch.calls.length + other.fetch.calls.length).toBe(0);
  });

  it('retries a transient Intuit failure', async () => {
    const { auth, fetch } = setup([json(503, {}), tokens()]);
    expect(await auth.getAccessToken()).toBe('TEST-access-new');
    expect(fetch.calls).toHaveLength(2);
  });

  it('fails loudly when the new refresh token cannot be saved', async () => {
    const { auth, store } = setup([tokens()]);
    store.failSet = true;
    await expect(auth.getAccessToken()).rejects.toThrow(/could not be saved to \/secure\/qbo\.token\.json/);
  });

  it('warns when the refresh token expires within 14 days', async () => {
    const { auth, log } = setup([tokens({ x_refresh_token_expires_in: 5 * 86_400 })]);
    await auth.getAccessToken();
    expect(log.lines.some((l) => l.includes('expires soon') && l.includes('"days_left":5'))).toBe(true);
  });
});

describe('cli auth helpers', () => {
  it('builds the authorize URL with the accounting scope and state', () => {
    const url = new URL(buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: 'http://localhost:8000/callback', state: 's-123' }));
    expect(url.origin + url.pathname).toBe(INTUIT_OAUTH.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: 'http://localhost:8000/callback',
      state: 's-123',
    });
  });

  it('exchanges the code and stores the first refresh token for the configured company', async () => {
    const fetch = fakeFetch([tokens()]);
    const store = memoryStore(null);
    const rec = await exchangeAuthorizationCode({
      store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      realmId: REALM,
      fetch,
      clock: instantClock(),
      code: 'TEST-auth-code',
      redirectUri: 'http://localhost:8000/callback',
      callbackRealmId: REALM,
    });
    expect(rec.refresh_token).toBe('TEST-refresh-new');
    expect(store.record?.realm_id).toBe(REALM);
    expect(fetch.calls[0]!.body).toBe(
      'grant_type=authorization_code&code=TEST-auth-code&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback',
    );
  });

  it('refuses to save a token for a different company than mappings.yaml', async () => {
    const fetch = fakeFetch([]);
    const store = memoryStore(null);
    await expect(
      exchangeAuthorizationCode({
        store,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        realmId: REALM,
        fetch,
        code: 'TEST-auth-code',
        redirectUri: 'http://localhost:8000/callback',
        callbackRealmId: '42',
      }),
    ).rejects.toThrow(/You connected QBO company 42/);
    expect(fetch.calls).toHaveLength(0);
    expect(store.record).toBeNull();
  });
});
