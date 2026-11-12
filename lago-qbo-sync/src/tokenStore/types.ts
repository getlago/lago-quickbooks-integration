import { z } from 'zod';

/**
 * The only state this job persists (brief §4.4): the current Intuit refresh token.
 *
 * The interface is deliberately small so a secrets-manager implementation (README "Adding a
 * secrets-manager token store") can replace the file one without touching any other module.
 * Implementations must make `set` atomic: a crash mid-write must leave either the old or the new
 * record, never a truncated one.
 */
export const tokenRecordSchema = z.strictObject({
  /** The QBO company the token was issued for. A mismatch with mappings.yaml is an auth error. */
  realm_id: z.string().regex(/^\d+$/),
  refresh_token: z.string().min(1),
  /** From Intuit's `x_refresh_token_expires_in`, when present (PLAN.md F12). */
  refresh_expires_at: z.string().nullable(),
  updated_at: z.string(),
});
export type TokenRecord = z.infer<typeof tokenRecordSchema>;

export interface LockHolder {
  pid: number;
  host: string;
  started_at: string;
}

export type LockOutcome =
  | { acquired: true }
  /** `stale` is true when the holder process is gone or the lock is old; it is reported, not broken. */
  | { acquired: false; holder: LockHolder | null; stale: boolean };

export interface TokenStore {
  get(): Promise<TokenRecord | null>;
  set(record: TokenRecord): Promise<void>;
  /** Run-level mutual exclusion (brief §4.3 step 2). Never blocks: returns immediately. */
  lock(): Promise<LockOutcome>;
  /** Releases the lock only if this process holds it. */
  unlock(): Promise<void>;
  /** Human-readable location for messages, e.g. the file path. Never contains a secret. */
  describe(): string;
}

/** The stored record is unreadable or corrupt. Reconnecting (`npm run auth`) rewrites it. */
export class TokenStoreError extends Error {
  override readonly name = 'TokenStoreError';
}
