import type { Mappings } from '../../config/schema.js';
import type { Logger } from '../../log/logger.js';
import { runSync } from '../../sync/run.js';
import { buildSyncContext, loadBase, SYNC_ENV, type CliIO } from '../context.js';

/**
 * brief §8: dry-run is the default when `environment: production` unless --apply is passed.
 * `dry-run` is always a dry-run, whatever the flags.
 */
export function resolveMode(command: 'sync' | 'dry-run', environment: Mappings['environment'], apply: boolean): {
  mode: 'apply' | 'dry-run';
  notice?: string;
} {
  if (command === 'dry-run') return { mode: 'dry-run' };
  if (environment === 'production' && !apply) {
    return { mode: 'dry-run', notice: 'environment is production: ran as a dry-run. Pass --apply to write to QuickBooks.' };
  }
  return { mode: 'apply' };
}

/** `npm run sync` / `npm run dry-run`: one run, JSON summary on stdout, exit code from the summary. */
export async function syncCommand(io: CliIO, log: Logger, command: 'sync' | 'dry-run', apply: boolean): Promise<number> {
  // Config first: the mode decides whether the QBO client is built with write access.
  const base = loadBase(io, SYNC_ENV);
  const { mode, notice } = resolveMode(command, base.mappings.environment, apply);
  const ctx = buildSyncContext(io, log, mode === 'apply' ? 'enabled' : 'disabled', base);

  const summary = await runSync({
    mappings: ctx.mappings,
    lago: ctx.lago,
    qbo: ctx.qbo,
    auth: ctx.auth,
    tokenStore: ctx.tokenStore,
    log,
    mode,
    clock: ctx.clock,
  });
  log.result(notice ? { ...summary, notice } : summary);
  return summary.exit_code;
}
