import { redactString, redactValue } from './redact.js';

/**
 * Structured output. Logs go to stderr as JSON lines; the run result (summary) goes to stdout as
 * one JSON document, so a scheduler can parse stdout without filtering logs out.
 *
 * Everything is redacted twice: field-by-field (sensitive keys, registered secrets) and then the
 * final serialized line, in case a secret was split across fields or built by string concatenation.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** Writes the command's result document to stdout. */
  result(doc: unknown): void;
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  level?: Level;
  /** Defaults to process.stderr / process.stdout. Tests pass collectors. */
  stderr?: (line: string) => void;
  stdout?: (text: string) => void;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}, bound: Fields = {}): Logger {
  const min = ORDER[options.level ?? 'info'];
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text + '\n'));
  const now = options.now ?? (() => new Date());

  const emit = (level: Level, msg: string, fields?: Fields) => {
    if (ORDER[level] < min) return;
    const record = redactValue({ ts: now().toISOString(), level, msg, ...bound, ...fields });
    stderr(redactString(safeStringify(record)));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    result: (doc) => stdout(redactString(safeStringify(redactValue(doc), 2))),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

function safeStringify(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), indent);
  } catch {
    return JSON.stringify({ msg: 'unserializable log record' });
  }
}
