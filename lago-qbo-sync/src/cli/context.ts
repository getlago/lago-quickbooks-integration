import type { Env, EnvKey, Mappings } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { systemClock, type Clock } from '../http/clock.js';
import type { FetchLike } from '../http/request.js';
import { createThrottle } from '../http/throttle.js';
import { LagoClient } from '../lago/client.js';
import { createLogger, type Logger } from '../log/logger.js';
import { registerSecret } from '../log/redact.js';
import { QboAuth } from '../qbo/auth.js';
import { QboClient } from '../qbo/client.js';
import { createTokenStore } from '../tokenStore/index.js';
import type { TokenStore } from '../tokenStore/types.js';

/** Everything the CLI touches in the outside world, injectable so commands can be tested offline. */
export interface CliIO {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Repository root: mappings.yaml is resolved from here and TOKEN_STORE_PATH must be outside it. */
  cwd: string;
  fetch: FetchLike;
  stdout: (text: string) => void;
  stderr: (line: string) => void;
  clock?: Clock;
}

/** QBO allows 500/min per realm (brief §3); the queue stays at 450 to leave headroom. */
export const QBO_MAX_PER_MINUTE = 450;

export const SYNC_ENV = ['LAGO_API_KEY', 'QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'TOKEN_STORE', 'TOKEN_STORE_PATH'] as const;
export const AUTH_ENV = ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'TOKEN_STORE', 'TOKEN_STORE_PATH'] as const;

export function makeLogger(io: CliIO, verbose: boolean): Logger {
  return createLogger({
    level: verbose ? 'debug' : 'info',
    stderr: io.stderr,
    stdout: io.stdout,
    ...(io.clock ? { now: () => new Date(io.clock!.now()) } : {}),
  });
}

export interface BaseContext<K extends EnvKey> {
  mappings: Mappings;
  env: Pick<Env, K>;
  clock: Clock;
  tokenStore: TokenStore;
}

/**
 * Loads and validates config and env (brief §4.3 step 1; throws ConfigError → exit 2) and registers
 * every secret with the redactor before anything can log it.
 */
export function loadBase<K extends EnvKey>(io: CliIO, requiredEnv: readonly K[]): BaseContext<K> & { env: Pick<Env, K> } {
  // Register whatever secrets are present first, so even a config error cannot echo them.
  for (const key of ['LAGO_API_KEY', 'QBO_CLIENT_ID', 'QBO_CLIENT_SECRET'] as const) registerSecret(io.env[key]);
  const { mappings, env } = loadConfig({ env: io.env, requiredEnv, repoRoot: io.cwd });
  const storeEnv = env as unknown as Pick<Env, 'TOKEN_STORE' | 'TOKEN_STORE_PATH'>;
  return { mappings, env, clock: io.clock ?? systemClock, tokenStore: createTokenStore(storeEnv) };
}

export interface SyncContext extends BaseContext<(typeof SYNC_ENV)[number]> {
  log: Logger;
  auth: QboAuth;
  qbo: QboClient;
  lago: LagoClient;
}

/**
 * Builds the clients for a run. Pass `base` when the config was already loaded (e.g. to choose the
 * write mode from `environment` first), so it is read and validated only once.
 */
export function buildSyncContext(
  io: CliIO,
  log: Logger,
  writes: 'enabled' | 'disabled',
  base: BaseContext<(typeof SYNC_ENV)[number]> = loadBase(io, SYNC_ENV),
): SyncContext {
  const { mappings, env, clock } = base;
  const auth = new QboAuth({
    store: base.tokenStore,
    clientId: env.QBO_CLIENT_ID,
    clientSecret: env.QBO_CLIENT_SECRET,
    realmId: mappings.qbo.realm_id,
    fetch: io.fetch,
    log,
    clock,
  });
  const qbo = new QboClient({
    environment: mappings.environment,
    realmId: mappings.qbo.realm_id,
    minorVersion: mappings.qbo.minor_version,
    auth,
    fetch: io.fetch,
    throttle: createThrottle({
      ratePerSecond: mappings.sync.max_requests_per_second,
      maxConcurrent: mappings.sync.max_concurrent,
      maxPerMinute: QBO_MAX_PER_MINUTE,
      clock,
    }),
    log,
    writes,
    clock,
  });
  const lago = new LagoClient({
    apiUrl: mappings.lago.api_url,
    apiKey: env.LAGO_API_KEY,
    fetch: io.fetch,
    throttle: createThrottle({
      ratePerSecond: mappings.sync.lago_max_requests_per_second,
      maxConcurrent: mappings.sync.lago_max_concurrent,
      clock,
    }),
    log,
    clock,
  });
  return { ...base, log, auth, qbo, lago };
}
