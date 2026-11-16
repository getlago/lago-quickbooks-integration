import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from './errors.js';
import { envSchema, mappingsSchema, type Env, type EnvKey, type Mappings } from './schema.js';

/** Turns zod issues into "path: message" lines. Never includes the received value (it may be a secret). */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

/** Parses and validates mappings.yaml text. Pure: no file or network access. */
export function parseMappings(yamlText: string, source = 'mappings.yaml'): Mappings {
  let raw: unknown;
  try {
    // Duplicate keys are an error (yaml's default), and aliases are capped against expansion bombs.
    raw = parseYaml(yamlText, { uniqueKeys: true, maxAliasCount: 50 });
  } catch (err) {
    const detail = err instanceof YAMLParseError ? err.message : 'unreadable YAML';
    throw new ConfigError(`${source} is not valid YAML`, [detail]);
  }
  const result = mappingsSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(`${source} is invalid`, formatIssues(result.error));
  return Object.freeze(result.data);
}

/**
 * Validates the environment variables a command needs. Each command asks only for the keys it
 * uses (e.g. `auth` does not need LAGO_API_KEY).
 *
 * TOKEN_STORE_PATH must be absolute and outside the repository, so the refresh token can never be
 * committed (brief §7.2). File permissions are checked by the token store itself (brief §8).
 */
export function loadEnv<K extends EnvKey>(
  env: NodeJS.ProcessEnv,
  keys: readonly K[],
  repoRoot: string,
): Pick<Env, K> {
  // zod's pick() mask type cannot be expressed for a generic K; the cast is checked by the return type.
  const mask = Object.fromEntries(keys.map((k) => [k, true])) as never;
  const result = envSchema.pick(mask).safeParse(env);
  if (!result.success) throw new ConfigError('Environment is invalid (see .env.example)', formatIssues(result.error));
  const parsed = result.data as unknown as Pick<Env, K>;

  if ('TOKEN_STORE_PATH' in parsed) {
    const issue = tokenStorePathIssue(String(parsed.TOKEN_STORE_PATH), repoRoot);
    if (issue) throw new ConfigError('Environment is invalid (see .env.example)', [`TOKEN_STORE_PATH: ${issue}`]);
  }
  return Object.freeze(parsed);
}

function tokenStorePathIssue(storePath: string, repoRoot: string): string | null {
  if (!path.isAbsolute(storePath)) return 'must be an absolute path';
  const root = existsSync(repoRoot) ? realpathSync(repoRoot) : path.resolve(repoRoot);
  // Resolve symlinks on the nearest existing ancestor: the file itself may not exist before `auth`.
  let probe = path.resolve(storePath);
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const resolved = path.join(realpathSync(probe), path.relative(probe, path.resolve(storePath)));
  const rel = path.relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return 'must be outside the repository';
  return null;
}

export interface LoadedConfig<K extends EnvKey> {
  readonly mappings: Mappings;
  readonly env: Pick<Env, K>;
  readonly mappingsPath: string;
}

/** Reads mappings.yaml (MAPPINGS_PATH or ./mappings.yaml) and validates it with the environment. */
export function loadConfig<K extends EnvKey>(options: {
  env: NodeJS.ProcessEnv;
  requiredEnv: readonly K[];
  repoRoot: string;
}): LoadedConfig<K> {
  const env = loadEnv(options.env, options.requiredEnv, options.repoRoot);
  const mappingsPath = path.resolve(options.repoRoot, options.env.MAPPINGS_PATH || 'mappings.yaml');
  let text: string;
  try {
    text = readFileSync(mappingsPath, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read ${mappingsPath}`, ['copy mappings.example.yaml to mappings.yaml and edit it']);
  }
  return { mappings: parseMappings(text, path.basename(mappingsPath)), env, mappingsPath };
}
