import { randomBytes } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { lstat, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../config/errors.js';
import {
  tokenRecordSchema,
  TokenStoreError,
  type LockHolder,
  type LockOutcome,
  type TokenRecord,
  type TokenStore,
} from './types.js';

/** A lock older than this is reported as stale (a run takes minutes, brief §3). */
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
/** An unreadable lock older than this is stale: a live run writes its holder within milliseconds. */
const UNREADABLE_LOCK_GRACE_MS = 60 * 1000;

export interface FileTokenStoreOptions {
  now?: () => Date;
  pid?: number;
  host?: string;
  /** Returns false when no process with this pid exists on this host. */
  isProcessAlive?: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Local-development token store (brief §4.2): one JSON file, mode 0600, outside the repo
 * (TOKEN_STORE_PATH, checked by config). Run lock: `<path>.lock`, created with O_EXCL.
 */
export class FileTokenStore implements TokenStore {
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly host: string;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(
    private readonly filePath: string,
    options: FileTokenStoreOptions = {},
  ) {
    if (!path.isAbsolute(filePath)) throw new ConfigError('TOKEN_STORE_PATH must be an absolute path');
    this.lockPath = `${filePath}.lock`;
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.host = options.host ?? os.hostname();
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  describe(): string {
    return this.filePath;
  }

  /**
   * Brief §8: refuse to start if the file is readable or writable by anyone but the owner.
   * Also refuses a symlink (it could point anywhere) and a directory others can write to
   * (they could replace the file).
   */
  private async checkSafety(): Promise<boolean> {
    const dir = path.dirname(this.filePath);
    let dirStat;
    try {
      dirStat = await stat(dir);
    } catch {
      throw new ConfigError(`Token store directory ${dir} does not exist`);
    }
    if ((dirStat.mode & 0o022) !== 0) {
      throw new ConfigError(`Token store directory ${dir} is writable by group or others; run: chmod go-w ${dir}`);
    }

    let fileStat;
    try {
      fileStat = await lstat(this.filePath);
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
    if (fileStat.isSymbolicLink()) throw new ConfigError(`Token store ${this.filePath} is a symlink; use a regular file`);
    if (!fileStat.isFile()) throw new ConfigError(`Token store ${this.filePath} is not a regular file`);
    const mode = fileStat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new ConfigError(
        `Token store ${this.filePath} has permissions ${mode.toString(8).padStart(4, '0')}; it must be 0600. Run: chmod 600 ${this.filePath}`,
      );
    }
    if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) {
      throw new ConfigError(`Token store ${this.filePath} is owned by another user`);
    }
    return true;
  }

  async get(): Promise<TokenRecord | null> {
    if (!(await this.checkSafety())) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      throw new TokenStoreError(`Token store ${this.filePath} is not valid JSON`);
    }
    const parsed = tokenRecordSchema.safeParse(raw);
    // The zod message is not included: it could quote the token value.
    if (!parsed.success) throw new TokenStoreError(`Token store ${this.filePath} has an unexpected format`);
    return parsed.data;
  }

  /** Atomic replace: write a 0600 temp file in the same directory, fsync, rename over the target. */
  async set(record: TokenRecord): Promise<void> {
    await this.checkSafety();
    const valid = tokenRecordSchema.parse(record);
    const tmp = `${this.filePath}.tmp-${this.pid}-${randomBytes(4).toString('hex')}`;
    const handle = await open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
    try {
      await handle.writeFile(JSON.stringify(valid, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    // Make the rename durable before the run goes on (the old token may already be invalid).
    const dir = await open(path.dirname(this.filePath), fsc.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  async lock(): Promise<LockOutcome> {
    await this.checkSafety();
    const holder: LockHolder = { pid: this.pid, host: this.host, started_at: this.now().toISOString() };
    let handle;
    try {
      handle = await open(this.lockPath, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const current = await this.readHolder();
      return { acquired: false, holder: current, stale: await this.isStale(current) };
    }
    try {
      await handle.writeFile(JSON.stringify(holder) + '\n', 'utf8');
      await handle.close();
      return { acquired: true };
    } catch (err) {
      // Never leave an empty lock behind (code review 2026-11-12): it would block every later run.
      await handle.close().catch(() => undefined);
      await unlink(this.lockPath).catch(() => undefined);
      throw err;
    }
  }

  async unlock(): Promise<void> {
    const current = await this.readHolder();
    if (current && current.pid === this.pid && current.host === this.host) {
      await unlink(this.lockPath).catch((err: unknown) => {
        if (!isNotFound(err)) throw err;
      });
    }
  }

  private async readHolder(): Promise<LockHolder | null> {
    try {
      const parsed = JSON.parse(await readFile(this.lockPath, 'utf8')) as Partial<LockHolder>;
      if (typeof parsed.pid === 'number' && typeof parsed.host === 'string' && typeof parsed.started_at === 'string') {
        return { pid: parsed.pid, host: parsed.host, started_at: parsed.started_at };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * A lock is stale when its process is gone (same host), when it is older than 2 h, or when its
   * content is unreadable (a crash between creating and writing it) and the file is older than a
   * minute: a live run writes the holder within milliseconds.
   */
  private async isStale(holder: LockHolder | null): Promise<boolean> {
    if (!holder) {
      try {
        const { mtimeMs } = await stat(this.lockPath);
        return this.now().getTime() - mtimeMs > UNREADABLE_LOCK_GRACE_MS;
      } catch {
        return false; // the lock disappeared meanwhile
      }
    }
    const age = this.now().getTime() - Date.parse(holder.started_at);
    if (Number.isFinite(age) && age > STALE_LOCK_MS) return true;
    return holder.host === this.host && !this.isProcessAlive(holder.pid);
  }
}
