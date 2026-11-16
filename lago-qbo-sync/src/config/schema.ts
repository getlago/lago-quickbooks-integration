import { z } from 'zod';

/**
 * Schema for mappings.yaml (brief §7.1). The file is shareable, so nothing here is a secret.
 * Every object is strict: an unknown or misspelled key is an error, not silently ignored.
 */

/** QBO entity Ids are numeric strings. Quoting them in YAML is required so "01" stays "01". */
const qboId = z.string().regex(/^\d+$/, 'must be a numeric QBO Id in quotes, e.g. "1"');

/** QBO limits per realm: 500 req/min, 10 req/s, 10 concurrent (brief §3). 8/s keeps a sustained run under 500/min. */
export const QBO_MAX_RPS = 8;
export const QBO_MAX_CONCURRENT = 10;
/** Lago limit for non-event endpoints is 50 req/s per organization. */
export const LAGO_MAX_RPS = 50;
/** QBO DocNumber maximum length (brief §6 bug #3). */
export const QBO_DOCNUMBER_MAX = 21;

const regexSource = z.string().superRefine((value, ctx) => {
  try {
    new RegExp(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'is not a valid regular expression' });
    return;
  }
  if (!value.startsWith('^') || !value.endsWith('$')) {
    ctx.addIssue({ code: 'custom', message: 'must be anchored with ^ and $ so it checks the whole number' });
  }
});

/**
 * Only Lago Cloud hosts over HTTPS: the job may call Lago and Intuit and nothing else (brief §8).
 * Self-hosted Lago is out of scope for the first customer.
 */
const lagoApiUrl = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'is not a valid URL' });
    return;
  }
  if (url.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'must use https' });
  if (!/(^|\.)getlago\.com$/.test(url.hostname)) {
    ctx.addIssue({ code: 'custom', message: 'must be a getlago.com host (e.g. api.getlago.com or api.eu.getlago.com)' });
  }
  if (url.pathname.replace(/\/+$/, '') !== '/api/v1') ctx.addIssue({ code: 'custom', message: 'must end with /api/v1' });
  if (url.search || url.hash || url.username || url.password) {
    ctx.addIssue({ code: 'custom', message: 'must not contain a query, fragment or credentials' });
  }
});

const days = (max: number) => z.number().int().min(1).max(max);

export const mappingsSchema = z
  .strictObject({
    environment: z.enum(['sandbox', 'production']),
    qbo: z.strictObject({
      realm_id: qboId,
      default_item_id: qboId,
      discount_account_id: qboId,
      // Empty = no TxnTaxDetail override (MAPPING.md "Tax Mapping"). "NON" is the non-taxable
      // code and must not be used here (ITEM-TAX-MAPPING-GUIDE.md "Which ID to use?").
      tax_code_id: z
        .string()
        .regex(/^[A-Za-z0-9]*$/, 'must be a QBO TaxCode Id or empty')
        .refine((v) => v.toUpperCase() !== 'NON', 'must be a taxable code, not NON'),
      // Intuit serves every request as minor version 75 or later (PLAN.md F5).
      minor_version: z.number().int().min(75).default(75),
    }),
    items: z.record(z.string().min(1), qboId).default({}),
    lago: z.strictObject({
      api_url: lagoApiUrl.default('https://api.getlago.com/api/v1'),
      invoice_prefix_rules: z.strictObject({
        allowed_pattern: regexSource,
        max_docnumber_length: z.number().int().min(1).max(QBO_DOCNUMBER_MAX),
      }),
    }),
    sync: z.strictObject({
      lookback_days: days(90),
      payment_lookback_days: days(365).default(45),
      void_lookback_days: days(365).default(45),
      reconcile_lookback_days: days(365).default(45),
      reconcile_max_lookups: z.number().int().min(1).default(1000),
      sync_payments: z.boolean().default(false),
      sync_voids: z.boolean().default(true),
      max_requests_per_second: z.number().positive().max(QBO_MAX_RPS).default(5),
      max_concurrent: z.number().int().min(1).max(QBO_MAX_CONCURRENT).default(1),
      lago_max_requests_per_second: z.number().positive().max(LAGO_MAX_RPS).default(10),
      // Lago reads only (detail GETs). QBO concurrency stays `max_concurrent` (brief default 1).
      lago_max_concurrent: z.number().int().min(1).max(10).default(4),
    }),
  })
  .superRefine((cfg, ctx) => {
    // The reconciliation report must at least cover what the run itself syncs.
    if (cfg.sync.reconcile_lookback_days < cfg.sync.lookback_days) {
      ctx.addIssue({
        code: 'custom',
        path: ['sync', 'reconcile_lookback_days'],
        message: 'must be >= sync.lookback_days',
      });
    }
  });

export type Mappings = z.infer<typeof mappingsSchema>;

/** Secrets and deployment settings, from the environment only (brief §7.2). */
export const envSchema = z.object({
  LAGO_API_KEY: z.string().min(1, 'is required'),
  QBO_CLIENT_ID: z.string().min(1, 'is required'),
  QBO_CLIENT_SECRET: z.string().min(1, 'is required'),
  TOKEN_STORE: z.enum(['file']),
  TOKEN_STORE_PATH: z.string().min(1, 'is required'),
  MAPPINGS_PATH: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
export type EnvKey = keyof Env;
