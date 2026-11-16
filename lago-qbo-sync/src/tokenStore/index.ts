import type { Env } from '../config/schema.js';
import { FileTokenStore } from './file.js';
import type { TokenStore } from './types.js';

/**
 * Picks the token store from TOKEN_STORE (brief §7.2). Adding a secrets-manager store means adding
 * a value to the TOKEN_STORE enum in config/schema.ts and a case here; nothing else changes.
 */
export function createTokenStore(env: Pick<Env, 'TOKEN_STORE' | 'TOKEN_STORE_PATH'>): TokenStore {
  switch (env.TOKEN_STORE) {
    case 'file':
      return new FileTokenStore(env.TOKEN_STORE_PATH);
  }
}

export type { LockOutcome, TokenRecord, TokenStore } from './types.js';
