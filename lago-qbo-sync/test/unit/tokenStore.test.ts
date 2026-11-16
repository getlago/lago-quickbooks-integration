import { chmodSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { FileTokenStore } from '../../src/tokenStore/file.js';
import { TokenStoreError, type TokenRecord } from '../../src/tokenStore/types.js';

function tempStore(options: ConstructorParameters<typeof FileTokenStore>[1] = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lago-qbo-store-'));
  chmodSync(dir, 0o700);
  const file = path.join(dir, 'qbo.token.json');
  return { dir, file, store: new FileTokenStore(file, options) };
}

const record: TokenRecord = {
  realm_id: '1234567890123456',
  refresh_token: 'TEST-refresh-token-value',
  refresh_expires_at: null,
  updated_at: '2026-11-10T00:00:00.000Z',
};

describe('FileTokenStore get/set', () => {
  it('returns null before the first handshake', async () => {
    expect(await tempStore().store.get()).toBeNull();
  });

  it('round-trips a record, writes mode 0600, leaves no temp files', async () => {
    const { dir, file, store } = tempStore();
    await store.set(record);
    expect(await store.get()).toEqual(record);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['qbo.token.json']);
    await store.set({ ...record, refresh_token: 'TEST-rotated' });
    expect((await store.get())?.refresh_token).toBe('TEST-rotated');
    expect(readdirSync(dir)).toEqual(['qbo.token.json']);
  });

  it('refuses to start when the file is readable by others (brief §8)', async () => {
    const { file, store } = tempStore();
    await store.set(record);
    chmodSync(file, 0o644);
    await expect(store.get()).rejects.toThrow(ConfigError);
    await expect(store.get()).rejects.toThrow(/0644; it must be 0600\. Run: chmod 600/);
  });

  it('refuses a symlink and a directory others can write to', async () => {
    const a = tempStore();
    const target = path.join(a.dir, 'real.json');
    writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
    symlinkSync(target, a.file);
    await expect(a.store.get()).rejects.toThrow(/symlink/);

    const b = tempStore();
    chmodSync(b.dir, 0o777);
    await expect(b.store.get()).rejects.toThrow(/writable by group or others/);
    chmodSync(b.dir, 0o700);
  });

  it('reports a corrupt file without quoting its content', async () => {
    const { file, store } = tempStore();
    writeFileSync(file, '{"refresh_token":"TEST-leak-me"', { mode: 0o600 });
    const err = await store.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenStoreError);
    expect((err as Error).message).not.toContain('TEST-leak-me');

    writeFileSync(file, JSON.stringify({ refresh_token: 'TEST-leak-me' }), { mode: 0o600 });
    const err2 = await store.get().catch((e: unknown) => e);
    expect((err2 as Error).message).toMatch(/unexpected format/);
    expect((err2 as Error).message).not.toContain('TEST-leak-me');
  });

  it('requires an absolute path', () => {
    expect(() => new FileTokenStore('relative/token.json')).toThrow(ConfigError);
  });
});

describe('FileTokenStore lock (brief §4.3: two runs at once)', () => {
  it('lets one run in and turns the second away with the holder', async () => {
    const { file } = tempStore();
    const first = new FileTokenStore(file, { pid: 111, host: 'h', isProcessAlive: () => true });
    const second = new FileTokenStore(file, { pid: 222, host: 'h', isProcessAlive: () => true });
    expect(await first.lock()).toEqual({ acquired: true });
    const busy = await second.lock();
    expect(busy).toMatchObject({ acquired: false, stale: false, holder: { pid: 111, host: 'h' } });
    expect(statSync(`${file}.lock`).mode & 0o777).toBe(0o600);
  });

  it('only the holder can unlock', async () => {
    const { file } = tempStore();
    const first = new FileTokenStore(file, { pid: 111, host: 'h', isProcessAlive: () => true });
    const second = new FileTokenStore(file, { pid: 222, host: 'h', isProcessAlive: () => true });
    await first.lock();
    await second.unlock();
    expect((await second.lock()).acquired).toBe(false);
    await first.unlock();
    expect((await second.lock()).acquired).toBe(true);
  });

  it('an empty or unreadable lock file is stale after a minute (crash between create and write)', async () => {
    const { file } = tempStore();
    writeFileSync(`${file}.lock`, '', { mode: 0o600 });
    const fresh = new FileTokenStore(file, { pid: 222, host: 'h', now: () => new Date() });
    expect(await fresh.lock()).toMatchObject({ acquired: false, holder: null, stale: false });
    const later = new FileTokenStore(file, { pid: 222, host: 'h', now: () => new Date(Date.now() + 2 * 60 * 1000) });
    expect(await later.lock()).toMatchObject({ acquired: false, holder: null, stale: true });
  });

  it('reports (but does not break) a stale lock: dead process, or older than 2 h', async () => {
    const { file } = tempStore();
    await new FileTokenStore(file, { pid: 111, host: 'h', now: () => new Date('2026-11-10T00:00:00Z') }).lock();

    const deadHolder = new FileTokenStore(file, { pid: 222, host: 'h', isProcessAlive: () => false });
    expect(await deadHolder.lock()).toMatchObject({ acquired: false, stale: true });

    const later = new FileTokenStore(file, {
      pid: 222,
      host: 'other-host',
      now: () => new Date('2026-11-10T03:00:00Z'),
      isProcessAlive: () => true,
    });
    expect(await later.lock()).toMatchObject({ acquired: false, stale: true });

    const soon = new FileTokenStore(file, {
      pid: 222,
      host: 'other-host',
      now: () => new Date('2026-11-10T00:30:00Z'),
      isProcessAlive: () => false, // different host: pid liveness is not checked
    });
    expect(await soon.lock()).toMatchObject({ acquired: false, stale: false });
  });
});
