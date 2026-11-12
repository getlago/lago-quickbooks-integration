import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Logger } from '../../log/logger.js';
import { registerSecret } from '../../log/redact.js';
import { buildAuthorizeUrl, exchangeAuthorizationCode } from '../../qbo/auth.js';
import { AuthError } from '../../qbo/errors.js';
import { AUTH_ENV, loadBase, type CliIO } from '../context.js';

/**
 * `npm run auth` (brief §7.3): one-time OAuth authorization-code flow for the sandbox.
 *
 * A temporary listener on the loopback interface receives Intuit's redirect, once, then closes.
 * It is not a server the job runs: it exists only for the few minutes of the handshake.
 * Production needs a public HTTPS redirect URI, which is out of scope (README › Production auth).
 */
export const SANDBOX_REDIRECT_PORT = 8000;
export const SANDBOX_REDIRECT_URI = `http://localhost:${SANDBOX_REDIRECT_PORT}/callback`;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export type CallbackResult = { ok: true; code: string; realmId: string } | { ok: false; reason: string };

/** Validates Intuit's redirect: state must match (CSRF), and code + realmId must be present. */
export function parseCallback(url: URL, expectedState: string): CallbackResult {
  const state = url.searchParams.get('state') ?? '';
  const a = Buffer.from(state);
  const b = Buffer.from(expectedState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'state does not match; start `npm run auth` again' };
  const error = url.searchParams.get('error');
  if (error) return { ok: false, reason: `Intuit returned "${error}" (was access denied?)` };
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  if (!code || !realmId) return { ok: false, reason: 'the redirect has no code or realmId' };
  return { ok: true, code, realmId };
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${body}</p></body>`;

/** Listens on 127.0.0.1 and ::1 (the browser may resolve "localhost" to either) for one /callback. */
export function waitForCallback(port: number, expectedState: string, timeoutMs = CALLBACK_TIMEOUT_MS): Promise<{ code: string; realmId: string }> {
  return new Promise((resolve, reject) => {
    const servers: Server[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of servers) s.close();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new AuthError('No redirect from Intuit within 5 minutes'))), timeoutMs);

    for (const host of ['127.0.0.1', '::1']) {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        if (req.method !== 'GET' || url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const result = parseCallback(url, expectedState);
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(result.ok ? PAGE('QuickBooks connected', 'You can close this tab.') : PAGE('Connection failed', result.reason));
        finish(() => (result.ok ? resolve({ code: result.code, realmId: result.realmId }) : reject(new AuthError(result.reason))));
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        // ::1 may not exist on IPv4-only hosts; that is fine as long as 127.0.0.1 listens.
        if (host === '::1' && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) return;
        finish(() => reject(new AuthError(`Cannot listen on ${host}:${port} (${err.code ?? err.message})`)));
      });
      server.listen(port, host);
      servers.push(server);
    }
  });
}

export async function authCommand(io: CliIO, log: Logger, options: { port?: number; timeoutMs?: number } = {}): Promise<number> {
  const base = loadBase(io, AUTH_ENV);
  if (base.mappings.environment === 'production') {
    log.result({
      status: 'config_error',
      exit_code: 2,
      message:
        'Production OAuth needs a public HTTPS redirect URI registered in the Intuit app; that is out of scope (README › Production auth).',
    });
    return 2;
  }
  const lock = await base.tokenStore.lock();
  if (!lock.acquired) {
    log.result({ status: 'locked', exit_code: 1, message: 'a sync is running; run `npm run auth` when it ends' });
    return 1;
  }
  try {
    const state = randomBytes(32).toString('hex');
    const port = options.port ?? SANDBOX_REDIRECT_PORT;
    const redirectUri = options.port ? `http://localhost:${port}/callback` : SANDBOX_REDIRECT_URI;
    const url = buildAuthorizeUrl({ clientId: base.env.QBO_CLIENT_ID, redirectUri, state });
    // Written outside the logger on purpose: the URL holds the client id (public in OAuth, but
    // registered as a secret for logs) and the state, nothing else. The human needs it verbatim.
    io.stderr(`\nOpen this URL in a browser, sign in to the QBO sandbox company ${base.mappings.qbo.realm_id} and approve:\n\n${url}\n`);

    const callback = await waitForCallback(port, state, options.timeoutMs);
    registerSecret(callback.code);
    const record = await exchangeAuthorizationCode({
      store: base.tokenStore,
      clientId: base.env.QBO_CLIENT_ID,
      clientSecret: base.env.QBO_CLIENT_SECRET,
      realmId: base.mappings.qbo.realm_id,
      fetch: io.fetch,
      clock: base.clock,
      code: callback.code,
      redirectUri,
      callbackRealmId: callback.realmId,
    });
    log.result({
      status: 'connected',
      exit_code: 0,
      realm_id: record.realm_id,
      refresh_expires_at: record.refresh_expires_at,
      token_store: base.tokenStore.describe(),
    });
    return 0;
  } catch (err) {
    if (err instanceof AuthError) {
      log.result({ status: 'auth_error', exit_code: 3, message: err.message });
      return 3;
    }
    throw err;
  } finally {
    await base.tokenStore.unlock();
  }
}
