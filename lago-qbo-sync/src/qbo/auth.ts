import { z } from 'zod';
import { systemClock, type Clock } from '../http/clock.js';
import { HttpError } from '../http/errors.js';
import { encodeParams, sendRequest, type FetchLike } from '../http/request.js';
import { classifyRead, withRetry } from '../http/retry.js';
import type { Logger } from '../log/logger.js';
import { registerSecret } from '../log/redact.js';
import type { TokenRecord, TokenStore } from '../tokenStore/types.js';
import { AuthError } from './errors.js';

/**
 * Intuit OAuth 2.0 endpoints, from Intuit's OpenID discovery document
 * (developer.api.intuit.com/.well-known/openid_sandbox_configuration, checked 2026-10-23).
 * Same endpoints for sandbox and production companies.
 */
export const INTUIT_OAUTH = {
  authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
  tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  scope: 'com.intuit.quickbooks.accounting',
} as const;

/** Warn this long before the refresh token's hard expiry (PLAN.md F12). */
const EXPIRY_WARNING_DAYS = 14;

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().optional(),
  x_refresh_token_expires_in: z.number().optional(),
});

export interface QboAuthOptions {
  store: TokenStore;
  clientId: string;
  clientSecret: string;
  /** mappings.yaml qbo.realm_id: the stored token must belong to this company. */
  realmId: string;
  fetch: FetchLike;
  log: Logger;
  clock?: Clock;
}

function basicAuth(clientId: string, clientSecret: string): string {
  const value = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  registerSecret(value);
  return `Basic ${value}`;
}

/**
 * Shared by refresh and code exchange: POST the form, map errors. Only the refresh grant is retried
 * on transient failures. An authorization code is single-use: if a response is lost, a retry would
 * only get `invalid_grant` and hide the real cause (review on PR #8), so the code exchange is sent once.
 */
async function requestTokens(
  opts: Pick<QboAuthOptions, 'clientId' | 'clientSecret' | 'fetch' | 'clock'>,
  form: Record<string, string>,
  action: string,
): Promise<z.infer<typeof tokenResponseSchema>> {
  const clock = opts.clock ?? systemClock;
  const body = encodeParams(form);
  let res;
  try {
    res = await withRetry(
      () =>
        sendRequest(
          opts.fetch,
          {
            service: 'intuit-oauth',
            method: 'POST',
            url: INTUIT_OAUTH.tokenUrl,
            headers: {
              Authorization: basicAuth(opts.clientId, opts.clientSecret),
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
          },
          () => clock.now(),
        ),
      { classify: form.grant_type === 'refresh_token' ? classifyRead : () => 'stop', clock },
    );
  } catch (err) {
    if (err instanceof HttpError && (err.status === 400 || err.status === 401)) {
      // Intuit's error code (e.g. invalid_grant, invalid_client) is safe to show; descriptions are not echoed.
      const code = (err.body as { error?: unknown } | null)?.error;
      throw new AuthError(`Intuit rejected the ${action}${typeof code === 'string' ? ` (${code})` : ''}`);
    }
    throw new AuthError(`Intuit token endpoint did not answer the ${action}: ${(err as Error).message}`);
  }
  const parsed = tokenResponseSchema.safeParse(res.body);
  if (!parsed.success) throw new AuthError(`Intuit returned an unexpected response to the ${action}`);
  registerSecret(parsed.data.access_token);
  registerSecret(parsed.data.refresh_token);
  return parsed.data;
}

function toRecord(realmId: string, tokens: z.infer<typeof tokenResponseSchema>, now: number): TokenRecord {
  const expires = tokens.x_refresh_token_expires_in;
  return {
    realm_id: realmId,
    refresh_token: tokens.refresh_token,
    refresh_expires_at: expires !== undefined ? new Date(now + expires * 1000).toISOString() : null,
    updated_at: new Date(now).toISOString(),
  };
}

/**
 * Holds the access token in memory only (brief §4.3 step 3). Refreshing writes the rotated refresh
 * token to the store before the new access token is used for anything. Concurrent callers share one
 * refresh.
 */
export class QboAuth {
  private accessToken: string | null = null;
  private inFlight: Promise<string> | null = null;
  private readonly clock: Clock;

  constructor(private readonly opts: QboAuthOptions) {
    this.clock = opts.clock ?? systemClock;
    registerSecret(opts.clientSecret);
    registerSecret(opts.clientId);
  }

  async getAccessToken(): Promise<string> {
    return this.accessToken ?? this.refresh();
  }

  /**
   * Refreshes the access token. With `rejectedToken` (after a 401), a newer token that another
   * request already obtained is returned as is, so concurrent 401s cause one Intuit refresh, not one each.
   */
  refresh(rejectedToken?: string): Promise<string> {
    if (rejectedToken !== undefined && this.accessToken !== null && this.accessToken !== rejectedToken) {
      return Promise.resolve(this.accessToken);
    }
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<string> {
    const { store, realmId, log } = this.opts;
    const current = await store.get();
    if (!current) throw new AuthError(`No QuickBooks refresh token in ${store.describe()}`);
    registerSecret(current.refresh_token);
    if (current.realm_id !== realmId) {
      throw new AuthError(
        `The stored token is for QBO company ${current.realm_id}, but mappings.yaml names ${realmId}`,
      );
    }

    const tokens = await requestTokens(
      this.opts,
      { grant_type: 'refresh_token', refresh_token: current.refresh_token },
      'refresh token',
    );
    const record = toRecord(realmId, tokens, this.clock.now());
    try {
      await store.set(record);
    } catch (err) {
      throw new AuthError(
        `Intuit issued a new refresh token but it could not be saved to ${store.describe()} (${(err as Error).message}); the stored token may no longer work`,
      );
    }
    this.warnIfExpiring(record, log);
    this.accessToken = tokens.access_token;
    log.info('qbo token refreshed', { refresh_expires_at: record.refresh_expires_at });
    return tokens.access_token;
  }

  private warnIfExpiring(record: TokenRecord, log: Logger): void {
    if (!record.refresh_expires_at) return;
    const daysLeft = (Date.parse(record.refresh_expires_at) - this.clock.now()) / 86_400_000;
    if (daysLeft < EXPIRY_WARNING_DAYS) {
      log.warn('qbo refresh token expires soon; reconnect before it does', {
        refresh_expires_at: record.refresh_expires_at,
        days_left: Math.floor(daysLeft),
      });
    }
  }
}

/** Step 1 of `cli auth`: the URL the user opens in a browser. */
export function buildAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const params = {
    client_id: args.clientId,
    response_type: 'code',
    scope: INTUIT_OAUTH.scope,
    redirect_uri: args.redirectUri,
    state: args.state,
  };
  const query = encodeParams(params);
  return `${INTUIT_OAUTH.authorizeUrl}?${query}`;
}

/**
 * Step 2 of `cli auth`: exchange the authorization code and store the first refresh token.
 * `callbackRealmId` (from Intuit's redirect) must match mappings.yaml, so the job can never be
 * connected to a different company than the one it is configured for.
 */
export async function exchangeAuthorizationCode(
  opts: Pick<QboAuthOptions, 'store' | 'clientId' | 'clientSecret' | 'realmId' | 'fetch' | 'clock'> & {
    code: string;
    redirectUri: string;
    callbackRealmId: string;
  },
): Promise<TokenRecord> {
  registerSecret(opts.code);
  registerSecret(opts.clientSecret);
  if (opts.callbackRealmId !== opts.realmId) {
    throw new AuthError(
      `You connected QBO company ${opts.callbackRealmId}, but mappings.yaml names ${opts.realmId}; nothing was saved`,
    );
  }
  const tokens = await requestTokens(
    opts,
    { grant_type: 'authorization_code', code: opts.code, redirect_uri: opts.redirectUri },
    'authorization code',
  );
  const record = toRecord(opts.realmId, tokens, (opts.clock ?? systemClock).now());
  await opts.store.set(record);
  return record;
}
