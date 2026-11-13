#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../config/errors.js';
import { redactString } from '../log/redact.js';
import { AuthError } from '../qbo/errors.js';
import { TokenStoreError } from '../tokenStore/types.js';
import { authCommand } from './commands/auth.js';
import { checkConfigCommand } from './commands/checkConfig.js';
import { syncCommand } from './commands/sync.js';
import { makeLogger, type CliIO } from './context.js';

/**
 * Entry point (brief §4.2 "cli"): sync | dry-run | check-config | auth.
 * Exit codes (brief §4.3): 0 ok, 1 a document failed, 2 config error, 3 auth error.
 * Every output line goes through the redacting logger; even unexpected crashes are redacted.
 */

const USAGE = `Usage: lago-qbo-sync <command> [--apply] [--verbose]

Commands:
  sync          Run one sync (dry-run by default when environment is production; add --apply)
  dry-run       Read everything, write nothing, report what would happen
  check-config  Verify mappings.yaml against QBO and Lago (read-only)
  auth          One-time QuickBooks connection (sandbox), stores the first refresh token
`;

const COMMANDS = ['sync', 'dry-run', 'check-config', 'auth'] as const;
type Command = (typeof COMMANDS)[number];
const FLAGS = new Set(['--apply', '--verbose']);

export function parseArgs(argv: readonly string[]): { command: Command; apply: boolean; verbose: boolean } | { error: string } {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command as Command)) return { error: `Unknown command: ${command ?? '(none)'}` };
  const unknown = rest.filter((a) => !FLAGS.has(a));
  if (unknown.length > 0) return { error: `Unknown option: ${unknown.join(' ')}` };
  if (rest.includes('--apply') && command !== 'sync') return { error: '--apply only applies to sync' };
  return { command: command as Command, apply: rest.includes('--apply'), verbose: rest.includes('--verbose') };
}

export async function runCli(io: CliIO): Promise<number> {
  const args = parseArgs(io.argv);
  if ('error' in args) {
    io.stderr(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  const log = makeLogger(io, args.verbose);
  try {
    switch (args.command) {
      case 'sync':
      case 'dry-run':
        return await syncCommand(io, log, args.command, args.apply);
      case 'check-config':
        return await checkConfigCommand(io, log);
      case 'auth':
        return await authCommand(io, log);
    }
  } catch (err) {
    // Errors raised before a command could print its own result (config load, token store setup).
    if (err instanceof ConfigError) {
      log.result({ status: 'config_error', exit_code: 2, message: err.message });
      return 2;
    }
    if (err instanceof AuthError || err instanceof TokenStoreError) {
      log.result({ status: 'auth_error', exit_code: 3, message: err.message });
      return 3;
    }
    log.error('unexpected error', { error: err });
    log.result({ status: 'aborted', exit_code: 1, message: 'unexpected error; see the error log line above' });
    return 1;
  }
}

/** True when this file is the process entry point (not imported by tests). */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const crash = (err: unknown) => {
    process.stderr.write(redactString(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`) + '\n');
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  // This file runs as dist/src/cli/index.js; the repository root (mappings.yaml, package.json) is three levels up.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  runCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: repoRoot,
    fetch: (url, init) => fetch(url, init),
    stdout: (t) => process.stdout.write(t + '\n'),
    stderr: (l) => process.stderr.write(l + '\n'),
  }).then((code) => {
    process.exitCode = code;
  }, crash);
}
