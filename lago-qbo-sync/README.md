# lago-qbo-sync

A scheduled job that pulls billing documents from **Lago** (read-only API) and writes them to **QuickBooks Online** (QBO). It replaces the community n8n workflow (the JSON and guides at the root of the [lago-quickbooks-integration](https://github.com/getlago/lago-quickbooks-integration) repository): same business logic, plus the fixes listed in brief §6, in a pull-based design. It runs as a plain CLI command now; later it will run as a Claude scheduled routine (`SKILL.md`).

**Each run** takes the run lock, refreshes the QBO token, then syncs in order: customers → invoices → credit notes → payments → voids. It finishes with a read-only reconciliation report and prints one JSON summary. Reruns are safe: everything already in QBO is skipped.

**Testing it yourself?** Follow [TESTING.md](TESTING.md): setup with your own QBO sandbox, the automated checklist, manual scenarios, and how to report results.

---

## Contents

1. [Setup](#1-setup)
2. [Commands and exit codes](#2-commands-and-exit-codes)
3. [Configuration reference](#3-configuration-reference)
4. [Run lifecycle and the run summary](#4-run-lifecycle-and-the-run-summary)
5. [Design decisions](#5-design-decisions)
6. [Deviations from the n8n workflow and MAPPING.md](#6-deviations-from-the-n8n-workflow-and-mappingmd)
7. [Known limitations](#7-known-limitations)
8. [Security](#8-security)
9. [Testing and sandbox evidence](#9-testing-and-sandbox-evidence)
10. [Adding a secrets-manager token store](#10-adding-a-secrets-manager-token-store)
11. [Runbooks: reconnect QBO, stale lock](#11-runbooks)
12. [Before production](#12-before-production)

---

## 1. Setup

**Requirements:** Node.js 22 or later (Node 20 reached end of life in April 2026), a Lago API key, and a QBO company.

1. **Create a dedicated Intuit app.** Don't reuse the n8n workflow's app: Intuit rotates refresh tokens per app and company, and two systems refreshing the same connection can invalidate each other's tokens.
   - In developer.intuit.com, create an app with the **Accounting** scope (`com.intuit.quickbooks.accounting`).
   - Under the app's Development keys, add the redirect URI `http://localhost:8000/callback`.
2. **Install:**
   ```bash
   npm install
   ```
3. **Make a private folder for the token, outside the repo:**
   ```bash
   mkdir -p ~/.config/lago-qbo-sync && chmod 700 ~/.config/lago-qbo-sync
   ```
4. **Create `.env`** (gitignored) and fill it in:
   ```bash
   cp .env.example .env && chmod 600 .env
   ```
   You need the Lago API key, the Intuit client ID and secret, `TOKEN_STORE=file`, and `TOKEN_STORE_PATH` as an absolute path into the folder from step 3. See [§3](#3-configuration-reference).
5. **Create `mappings.yaml`** (gitignored) and set the realm, item, account and tax code Ids:
   ```bash
   cp mappings.example.yaml mappings.yaml
   ```
6. **Connect QBO once.** The command prints an Intuit URL; open it, approve, and the first refresh token is saved to the token store:
   ```bash
   npm run auth
   ```
7. **Check the configuration** against QBO and Lago (read-only):
   ```bash
   npm run check-config
   ```
8. **Preview, then sync:**
   ```bash
   npm run dry-run
   ```
   ```bash
   npm run sync
   ```

`npm run <command>` builds with `tsc` and runs `node --env-file=.env …`. Node stops with its own error if `.env` is missing.

## 2. Commands and exit codes

| Command | What it does | Writes to QBO |
|---|---|---|
| `npm run sync` | One run. In **production** it is a dry-run unless you pass `--apply` (`npm run sync -- --apply`). | yes (sandbox, or production with `--apply`) |
| `npm run dry-run` | Reads Lago and QBO and reports `would_create` / `would_update` / `would_void`. The token is still refreshed and saved. | no |
| `npm run check-config` | Read-only checks (details below). | no |
| `npm run auth` | One-time OAuth connection, sandbox only. | no (writes the token store) |
| `npm run seed` | Test data for the Lago **test org** (see §9). Plan-only unless `--seed`. | no (writes to Lago) |
| `npm run integration` | The §10 checklist against sandbox + test org, PASS/FAIL per item. | yes (sandbox) |
| `npm test` | Unit tests (vitest), no network. | no |

`check-config` verifies:
- the token works and the realm is reachable;
- the company is US-based;
- every referenced Item Id, the discount account and the tax code exist and are active;
- Lago billing-entity prefixes contain only letters, digits and `-`;
- recent Lago numbers fit QBO's 21-character DocNumber limit.

`--verbose` adds debug logs (one line per HTTP call) to any command.

| Exit code | Meaning |
|---|---|
| 0 | No document failed. Deferred payments and `missing_in_qbo` entries don't count as failures. Also returned with `"status": "locked"` when another run holds the lock. |
| 1 (locked) | `"status": "locked"` with a **stale** lock: a previous run died holding it, and every run stops until a person clears it ([runbook](#stale-lock)). |
| 1 | At least one document failed, or the run was `aborted` (e.g. QBO unreachable at start). |
| 2 | Configuration error: invalid `mappings.yaml` or `.env`, unsafe token-file permissions, non-US company. |
| 3 | Authentication error: no or invalid refresh token, wrong company, a second 401. See the [reconnect runbook](#reconnect-qbo-exit-code-3). |

Every command prints exactly one JSON document on stdout, including on errors. Logs go to stderr as JSON lines.

## 3. Configuration reference

### `mappings.yaml` (shareable; never put a secret in it)

Validated at startup; unknown keys are errors.

| Key | Default | Meaning |
|---|---|---|
| `environment` | (required) | `sandbox` or `production`. Production syncs are dry-runs unless `--apply`. |
| `qbo.realm_id` | (required) | QBO company Id. The stored token must belong to this company. |
| `qbo.default_item_id` | (required) | Fallback Item for unmapped Lago item codes, fees without a code, and credit lines. |
| `qbo.discount_account_id` | (required) | `DiscountAccountRef` for before-tax credits (coupons, progressive billing). |
| `qbo.tax_code_id` | (required, may be `""`) | TaxCode for `TxnTaxDetail`, which makes QBO use Lago's exact tax. Empty: QBO computes its own tax, and the run warns per document. `NON` is refused. |
| `qbo.minor_version` | 75 | Sent on every call. Intuit has ignored 1–74 since 2025-08-01. |
| `items` | `{}` | Lago item code → QBO Item Id. |
| `lago.api_url` | `https://api.getlago.com/api/v1` | Lago Cloud only (`api.getlago.com` or `api.eu.getlago.com`), https. |
| `lago.invoice_prefix_rules.allowed_pattern` | — | Anchored regex for numbers QBO lookups can match reliably, e.g. `^[A-Za-z0-9-]+$`. |
| `lago.invoice_prefix_rules.max_docnumber_length` | — | ≤ 21 (QBO limit). |
| `sync.lookback_days` | — (3 in the example) | Window, by `issuing_date`, for invoices and credit notes. |
| `sync.payment_lookback_days` | 45 | Window for paid invoices. |
| `sync.void_lookback_days` | 45 | Window for voided invoices. |
| `sync.reconcile_lookback_days` | 45 | Window for the read-only `missing_in_qbo` report. Must be ≥ `lookback_days`. |
| `sync.reconcile_max_lookups` | 1000 | Cap on per-document lookups if batched lookups are unavailable. |
| `sync.sync_payments` | false | Off until the bookkeeper confirms who books payments. |
| `sync.sync_voids` | true | |
| `sync.max_requests_per_second` | 5 | QBO request rate. Maximum 8: 8/s is 480/min, under QBO's 500/min. |
| `sync.max_concurrent` | 1 | QBO requests in flight. Maximum 10. |
| `sync.lago_max_requests_per_second` | 10 | Lago request rate (Lago allows 50/s per org). |
| `sync.lago_max_concurrent` | 4 | Lago reads in flight. |

### Environment (`.env`, never committed)

| Variable | Used by | Notes |
|---|---|---|
| `LAGO_API_KEY` | sync, dry-run, check-config, seed | Used read-only by the sync; the seed script is the only writer. |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | all except seed | From the dedicated Intuit app. |
| `TOKEN_STORE` | all except seed | `file` (the only implementation today). |
| `TOKEN_STORE_PATH` | all except seed | Absolute, outside the repo. The file must be 0600, and its folder must not be writable by others. |
| `MAPPINGS_PATH` | optional | Defaults to `./mappings.yaml`. |

The refresh token lives **only** in the token store, never in `.env`.

## 4. Run lifecycle and the run summary

1. Load and validate `mappings.yaml` and `.env`; on any error, exit 2.
2. Take the run lock (`<TOKEN_STORE_PATH>.lock`). If it is held, print `status: "locked"` and exit 0.
3. Refresh the QBO access token. The rotated refresh token is written to the store **before** anything else; the access token stays in memory only.
4. Read the company: it must be a US company; its home currency and multicurrency flag are kept for the currency check.
5. Fetch Lago documents in the window. Lago's list endpoints don't include fees, so there's one detail GET per document.
6. **Customers:** the distinct customers of those documents. Each is created, sparse-updated if changed, or skipped if unchanged.
7. **Invoices, then credit notes:** existence is checked in batches of 50; each document is created or skipped.
8. **Payments** (if `sync_payments`), then **voids** (if `sync_voids`).
9. **Reconciliation** (read-only): Lago invoices and credit notes from the last `reconcile_lookback_days` that QBO doesn't have.
10. Release the lock; print the summary; exit with its code.

**Summary fields** (stdout):

| Field | Content |
|---|---|
| `status` | `completed`, `locked`, `auth_error`, `config_error` or `aborted` |
| `mode`, `environment`, `realm_id` | what ran, where |
| `started_at`, `finished_at`, `duration_ms` | timing |
| `exit_code` | as in §2 |
| `message` | set for non-completed runs |
| `windows` | the date windows used |
| `counts.<customer\|invoice\|credit_note\|payment\|void>` | created, updated, voided, skipped, deferred, failed, would_create, would_update, would_void |
| `out_of_scope.wallet_topup_invoices` | wallet top-ups skipped by design |
| `qbo.calls`, `qbo.by_status`, `qbo.unexpected_statuses` | anything other than 200/401/429 is listed |
| `lago.calls` | |
| `failures[]` | `{entity, lago_number, lago_id, reason}`. The reason carries QBO's own `Message \| Detail \| code \| element`. |
| `deferred[]` | payments waiting for their invoice |
| `skipped_documents[]` | skips worth a look, e.g. empty invoices |
| `warnings[]` | e.g. tax charged but no tax code configured |
| `missing_in_qbo` | `{checked, truncated, method, items[]}`. Each item's reason is `not_found`, `unverifiable_docnumber`, `docnumber_too_long`, `duplicate_in_qbo` or `number_used_by_other_document`. Read-only; doesn't affect the exit code. |

## 5. Design decisions

**Architecture**

- **Pull, not webhooks.** A missed or out-of-order webhook was a missed document in n8n. Every run looks back over a window (3 days by default), so a failed run is caught up by the next one.
- **Stateless idempotency.** There's no database. Before creating anything, the job asks QBO whether it already exists (invoices and credit memos by DocNumber, customers by DisplayName). The only persisted state is the refresh token. QBO does not enforce unique DocNumbers, so the lookup is what prevents duplicates.

**Lookups**

- **Ownership: a number match is not enough.** A QBO invoice or credit memo counts as "this Lago document" only if its PrivateNote carries the Lago id (`Lago Invoice: <id>` / `Lago Credit Note: <id>`, the n8n format; QBO keeps it after a void as `Voided - Lago Invoice: <id>`). A same-numbered document created by hand or by another tool is never skipped as synced, paid or voided: the Lago document fails with an explicit message, and the reconciliation report shows `number_used_by_other_document`.
- **A failed lookup is never "not found"** (bug #5). A lookup returns either "none" or rows. A non-200, a Fault, or a response without `QueryResponse` throws, and that document fails; nothing is created.
- **Batched existence checks.** Invoices and credit memos are checked 50 per query with `DocNumber IN (…)`, customers with `DisplayName IN (…)`, and the reconciliation pass uses the same helper. That halved the QBO calls of a 500-invoice run and cut a no-change rerun of 1,017 invoices to 110 QBO calls. If a batch fails, or QBO matches a number only when case is ignored, those documents fall back to single `=` lookups.
- **Queries are built in one place.** User data enters a query only through `literal()`, which escapes `'` as `\'` and refuses backslashes and control characters. Then the whole statement goes through `encodeURIComponent`.

**Writes**

- **A create QBO didn't confirm is never resent in the same run.** After a 5xx or a timeout on a POST, the job waits 5 s and looks the document up. If it's there, the run carries on. If not, the document fails with "not resent, to avoid a duplicate", and the next run looks it up again and creates it only if it's still missing. An immediate resend could duplicate a create that QBO commits late. Only 429s are retried directly.
- **Money is integer cents** until one conversion to dollars at output (`transform/money.ts`). Each invoice and credit memo checks, before sending, that the QBO total it will produce equals Lago's `total_amount_cents`. A mismatch fails the document with both amounts, and nothing is sent.
- **Multi-unit rounding.** A fee keeps its quantity only if amount ÷ units is a whole number of cents. Otherwise it's sent as Qty 1 × the exact amount, with "(N units at P each)" added to the description. QBO requires Amount = Qty × UnitPrice, and the n8n rounding changed line amounts (3 × $3.33 = $9.99 for a $10.00 fee).

**Rate limits and retries**

- **Rate limits by design.** One throttle per service evenly spaces request starts (no bursts), caps QBO at 450 starts per sliding minute, limits concurrency, and pauses everyone after a 429. A unit test pushes 1,000 calls at the highest allowed setting and checks no 1 s window has more than 8 and no 60 s window more than 450.
- **Retries:** 5 attempts, 1 s base, ×2, with jitter, never less than `Retry-After`. 400s are never retried, and neither are network errors a retry can't fix (a refused redirect, TLS or DNS misconfiguration); only timeouts and socket errors are. A 401 triggers one token refresh and one retry; a second 401 is exit 3. The access token is read when a request leaves the queue, and a 401 on an already-replaced token reuses the newer one instead of asking Intuit again.

**Run safety**

- **One failing document never stops a run.** Only auth problems stop it (exit 3).
- **Customer identity.** If the QBO customer with the same DisplayName has Notes naming a *different* Lago ID, the customer and its documents fail. Two Lago customers sharing a name must not post to one QBO customer.
- **Dry-run can't write.** The QBO client is built with writes disabled, and every write method throws before any network call.
- **The Lago client is GET-only by construction**, and a test asserts it. The seed script has its own writer, limited to 13 endpoints and never used by the sync.

**Dependencies**

- `yaml` (config) and `zod` (validating config and Lago payloads) at runtime; `typescript`, `@types/node` and `vitest` for development.
- HTTP is native `fetch`, locking is `fs`, the one-time OAuth callback is `node:http`. No framework, no database, no web server.

## 6. Deviations from the n8n workflow and MAPPING.md

> Code comments cite `PLAN.md` (e.g. "PLAN.md Q4", "F8", "§4.12"). That is the project's internal design log and is not published in the public repository. Every decision it records is summarized in §5 and in the tables below: Q-numbers match the "Decided" column.

Where the n8n workflow and MAPPING.md disagree, the n8n JSON wins (brief §2).

| Topic | MAPPING.md / mapping-config.json | n8n (ported) |
|---|---|---|
| Customer Notes | adds `Slug` | `Lago ID` + `External ID` only |
| Customer `WebAddr`, `ShipAddr`, `TaxIdentificationNumber` | mapped | not sent |
| Fee description fallback | `{item.type}: {item.code}` | `'Fee'` |
| Fee `UnitPrice` | `precise_unit_amount` | amount ÷ units |
| Line tax code | README says `taxes_rate > 0` | invoices: `taxes_amount_cents > 0`; credit notes: `fee.taxes_rate > 0` |
| Invoice / credit memo PrivateNote | more fields | `Lago Invoice: <id>` / `Lago Credit Note: <id>` |
| Discount line sign | negated | positive (QBO's `DiscountLineDetail`) |
| Discount account | per coupon code | one `discount_account_id` |

Changes made by this job on purpose:

| Change | Why | Decided |
|---|---|---|
| Fixes for brief §6 bugs #1–#5 | required | brief |
| `minorversion=75` instead of 70 | Intuit ignores 70 | Q2 |
| Multi-unit rounding fallback (§5) | n8n changed line amounts | Q3 |
| A credit note whose coupon share makes its total differ from Lago **fails** | n8n has no line for it; waiting for the bookkeeper | Q4 (b) |
| Wallet top-up invoices (`invoice_type: credit`) skipped and counted | out of scope (brief §11) | Q6 |
| Customer identity check (§5) | prevents posting to the wrong customer | Q7 |
| US QBO companies only | `TAX`/`NON` line codes are US-only | Q8 |
| Payment only when QBO balance = Lago total; skip at 0; otherwise fail | never overpay a partly settled invoice | Q10 |
| Payment PrivateNote adds the Lago invoice id | traceability | Q10 |
| Empty invoices (total 0, no fees, no credits) skipped and listed; no customer created for them alone; no $0 payment | QBO rejects an invoice with no lines (fault 2020) | 2026-11-11 |
| **CompanyName** truncated to 100 characters, like DisplayName | QBO limit (fault 2050); n8n sent it as-is | 2026-11-12 |
| "Already voided" requires total 0, balance 0 **and** QBO's `Voided` note prefix | a $0 invoice with lines is still voided | 2026-11-12 |
| Skip, pay and void only QBO documents whose PrivateNote carries the Lago id | n8n trusted the DocNumber alone and could void or pay a document it didn't create | code review 2026-11-12 |
| An unconfirmed create (5xx/timeout, not found after 5 s) is not resent in the same run | a late QBO commit plus a resend would duplicate it | code review 2026-11-12 |
| A stale run lock exits 1 instead of 0 | a dead run's lock would otherwise stop every sync while each run reports success | code review 2026-11-12 |
| `ItemRef.name: 'Services'` not sent | n8n hard-coded it whatever the item | plan |
| `null` and `''` stripped before sending, as well as `undefined` | covers fields n8n missed (e.g. a null `payment_due_date`) | plan |
| Units must be a plain decimal; anything else counts as 1 | `parseFloat` would read `"1e3"` as 1000 | plan |
| Unchanged customers are skipped, not re-updated | a rerun writes nothing | plan |

**A finding that contradicts the brief.** Bug #2 says a `[` in a DocNumber never matches a QBO lookup, even URL-encoded. With this job's encoding it **does** match: `[DE-0A82-202610-001` and `-002` were found, by `=` and by `IN`, each exactly once, and a payment was correctly applied to one of them. The behavior the brief requires is unchanged: `check-config` warns, and an empty lookup for such a number fails the document instead of creating it. Whether to relax that rule is for the brief's owner to decide.

## 7. Known limitations

- **No `updated_at` filter in Lago.** Each window filters on `issuing_date` only. A payment or void that happens after the window has passed is missed, so the payment and void windows are 45 days.
- **Deferred payments resolve only if their invoice gets created.** If a paid invoice was issued before `lookback_days` and is not in QBO, its payment stays deferred, and the invoice is listed in `missing_in_qbo` (seen in the sandbox: `WP-202611-001`).
- **Customers are synced only when they have a document in the window.** A Lago customer edit with no new document doesn't reach QBO.
- **Inactive QBO customers aren't returned by lookups.** Creating a customer with the same name then fails with QBO's "Duplicate Name". Reactivate or rename the customer in QBO.
- **Multicurrency.** Foreign-currency documents are sent without an exchange rate, as in n8n, so QBO applies its own daily rate to the home-currency figures. With multicurrency off, foreign-currency documents fail.
- **US-only tax model.** Lines use `TAX`/`NON`; one `tax_code_id` carries Lago's exact total tax.
- **Throughput.** A first sync of 500 new invoices takes about 9–10 minutes at the brief's defaults (5/s, 1 concurrent). The limit is QBO answering each create in about 0.77 s, one at a time. If volumes grow, `max_concurrent: 2` stays within QBO limits and roughly halves create time.
- **Out of scope** (brief §11): refunds, wallet top-up accounting, revenue recognition, multi-entity, production OAuth hosting, a hosted secrets manager.

## 8. Security

- **Secrets** come from the environment only. They are registered at startup, and every token as it is obtained, and redacted from every log line, error message, stack trace and the summary. Redaction covers registered values (including URL-encoded and base64 forms), sensitive keys (`authorization`, `refresh_token`, …) and `Bearer`/`Basic`/token-parameter patterns. A unit test and an end-to-end CLI test search captured output for test secrets. The sandbox invalid-token run was checked for the real ones.
- **Token store:** written atomically (temp file, fsync, rename, fsync of the folder) with mode 0600. The job refuses to start if the file is broader than 0600, is a symlink, belongs to another user, or sits in a folder others can write to. A token for a company other than `qbo.realm_id` is refused.
- **Least privilege.** Lago: GET only. QBO writes: Customer (create, sparse update), Invoice, CreditMemo, Payment, and Invoice void. Requests never follow redirects, so the token can't leak to another host, and time out after 30 s.
- **Network.** Only Lago and Intuit are called; there is no telemetry.
- **Production** syncs are dry-runs unless `--apply`.

### Contributing to this repository (it is public)

Anything committed here is public and permanent, so a secret that reaches a commit counts as leaked, even if it's removed in the next commit.

- **Never commit** `.env`, `mappings.yaml`, the token file (`*.token.json`), `.seed/` manifests or a real company ID. All of them are in `.gitignore`. Only `.env.example` and `mappings.example.yaml` belong in Git, with placeholder values.
- **Enable the pre-commit hook** once per clone, from the repository root. It refuses those files by name and, if [gitleaks](https://github.com/gitleaks/gitleaks) is installed, scans the staged changes:
  ```bash
  git config core.hooksPath lago-qbo-sync/scripts/hooks
  ```
- **CI scans every push and pull request** with gitleaks (pinned version, checksum-verified, full history) and runs the typecheck and unit tests. Test credentials are fake and start with `TEST-`; that's the only allowlisted pattern (`.gitleaks.toml`).
- **Paste only run summaries** in issues and pull requests. They're redacted by design; `--verbose` logs are redacted too, but read them before sharing.
- **If a secret is ever pushed:** rotate it **first** (Lago API key in Lago; Intuit client secret in the Intuit portal; reconnect QuickBooks with `npm run auth`), then tell the repository admins. Rewriting history doesn't help once a secret is public: it may already be cloned or cached.

## 9. Testing and sandbox evidence

- **`npm test`**: 218 unit tests, no network. They cover:
  - every transform, using fixtures shaped like real Lago payloads (coupons, progressive billing, prepaid credits, applied credit notes, taxed and untaxed fees, multi-unit rounding, missing fields, long names, apostrophes, `[`, 22+ characters, empty invoices);
  - reconcile decisions, query escaping, the throttle and retry (in virtual time), the token store and lock, auth, both clients against a fake `fetch`;
  - end-to-end sync against in-memory QBO and Lago, and the CLI.
- **`npm run seed`** creates the §10 scenarios in the Lago **test org**. Writing needs `--seed`, `environment: sandbox`, and `--confirm-billing-entity=<code of this org>`:
  - customers with coupon + tax, a credit note plus prepaid credits, an apostrophe, a 120-character name;
  - a paid invoice, and an invoice to void later (`--void`);
  - `--bulk=500` creates 500 one-off invoices for the throughput test.

  All codes start with `qa-<tag>-`, and ids go to `.seed/<tag>.json`.
- **`npm run integration -- --manifest=.seed/<tag>.json [--bulk-manifest=…]`** runs the §10 checklist:
  - two real syncs into the sandbox, with payments enabled in memory only;
  - an invalid-token run and a run while the lock is held, as child processes.

  It prints PASS / FAIL / PARTIAL / SKIP per item.

**Sandbox results** (a US sandbox company, 2026-11-11 to 2026-11-12):

| §10 item | Result |
|---|---|
| check-config; wrong item Id caught | pass |
| Customer created; rerun skipped | pass |
| Apostrophe name | pass (`O'Brien & Sons`) |
| Coupon + tax to the cent | pass: $93.50 with tax $8.50 via code 5, $15 discount on account 86 |
| Prepaid + applied credit note | pass: $58.00 with −$22 and −$30 lines |
| Credit memo; rerun skipped | pass: $22.00 with tax $2.00 |
| Payment linked, balance 0; rerun skipped | pass (4 payments) |
| Payment for an invoice not yet in QBO | deferred, never failed; resolution needs the invoice inside the window (§7) |
| Voided invoice | pass |
| `[` prefix: warning, no duplicate | pass (and the bug #2 finding in §6) |
| 22+ characters: explicit failure | pass |
| Invalid token: exit 3, no secret | pass (0.3 s, 0 API calls) |
| Two runs at once | pass: the second exits 0 with `locked` |
| Every QBO call 200 | pass in every run after the empty-invoice fix |
| 500 documents < 10 min | pass: 9 min 49 s with 1,017 invoices in the window (500 created); rerun 2 min 23 s |

The test org and QBO sandbox keep this data (about 1,000 `qa-` test invoices). Lago and QBO can void documents but not delete them.

## 10. Adding a secrets-manager token store

The token store is the only persisted state, behind a five-method interface in `src/tokenStore/types.ts`:

```ts
interface TokenStore {
  get(): Promise<TokenRecord | null>;   // { realm_id, refresh_token, refresh_expires_at, updated_at }
  set(record: TokenRecord): Promise<void>; // must be atomic
  lock(): Promise<LockOutcome>;         // never blocks; { acquired } or { acquired: false, holder, stale }
  unlock(): Promise<void>;              // releases only this process's lock
  describe(): string;                   // location for messages, never a secret
}
```

To add one (e.g. AWS Secrets Manager plus a DynamoDB conditional write for the lock):

1. Write `src/tokenStore/<name>.ts` implementing the interface:
   - `set` must replace the whole record atomically, using a version or compare-and-set if the backend supports it;
   - `lock` must be a conditional create that fails if one exists, with the holder and a start time so stale locks can be reported.
2. Add `'<name>'` to `TOKEN_STORE` in `src/config/schema.ts`, plus any settings it needs (non-secret ones in env, never in `mappings.yaml`).
3. Add a `case` in `createTokenStore()` in `src/tokenStore/index.ts`.
4. Copy the file store's tests (`test/unit/tokenStore.test.ts`) for round-trip, lock contention and stale detection.

Nothing else changes: auth, the clients and sync only see the interface. Keep the rule that the rotated refresh token is saved **before** it's used. With a remote store, a failed `set` must stop the run (it already maps to exit 3).

## 11. Runbooks

### Reconnect QBO (exit code 3)

The summary's `message` says why. Typical causes:

| Message | Cause |
|---|---|
| `Intuit rejected the refresh token (invalid_grant)` | Token expired (100 days unused, or the 5-year cap), revoked, or rotated by another system using the same app |
| `No QuickBooks refresh token in …` | First run, or the store was deleted |
| `The stored token is for QBO company X, but mappings.yaml names Y` | `realm_id` changed |
| `QBO rejected the access token again right after a refresh` | App disconnected in QBO, or scope removed |

Steps:
1. Make sure no other system uses this Intuit app for this company (see §1).
2. Check that `mappings.yaml` `qbo.realm_id` is the intended company.
3. Run the connection again and approve in the browser; it overwrites the stored token:
   ```bash
   npm run auth
   ```
   This works for sandbox only; production needs a public HTTPS redirect URI, out of scope.
4. Confirm the connection, then sync. The next run catches up everything inside the lookback windows:
   ```bash
   npm run check-config
   ```
   ```bash
   npm run sync
   ```

The job logs a warning when the refresh token has less than 14 days left. Reconnect before it expires.

### Stale lock

`status: "locked"` with **exit code 1** and "the run lock looks stale" means a previous run died while holding the lock: the process no longer exists on this host, the lock is older than 2 hours, or the lock file is unreadable (a crash while it was being written) and older than a minute. Nothing syncs until it's cleared, and the job never removes it by itself.
1. Check that no sync is running, then remove the lock file (path = `TOKEN_STORE_PATH` + `.lock`):
   ```bash
   ps aux | grep "cli/index.js" | grep -v grep
   ```
   ```bash
   rm "$HOME/.config/lago-qbo-sync/qbo.token.json.lock"
   ```
2. Run `npm run sync`. Idempotency makes the rerun safe.

### Production OAuth (out of scope)

Intuit requires a public HTTPS redirect URI for production apps, so `npm run auth` refuses `environment: production`. To connect production, host the callback (any HTTPS endpoint that receives `code`, `state` and `realmId` and calls `exchangeAuthorizationCode` from `src/qbo/auth.ts`), or do the handshake once elsewhere and write the resulting record into the token store.

## 12. Before production

These need a decision from the customer or their bookkeeper; none is a code change:

1. **Discount account.** The sandbox uses 86 (Discounts given). Production needs the account the bookkeeper wants coupons in. The n8n default `1` was an income account.
2. **Payments.** `sync_payments` stays `false` until it's settled who books payments: Lago via this job, or Stripe via another integration. Booking them twice would double-count.
3. **Credit notes with a coupon share** currently fail (Q4 b); the bookkeeper chooses how to book them.
4. **Multicurrency.** Does the customer bill in more than one currency? If so, multicurrency must be on in QBO (it can't be turned off again), and the bookkeeper must accept QBO's exchange rate (§7).
5. **Lago numbering prefix.** Keep it to letters, digits and `-`, short enough that credit notes (`…-CN001`) stay within 21 characters. Run `check-config` against production first.
6. **A separate Intuit production app**, connected once (see "Production OAuth" above).
7. **First production run:** `npm run sync` without `--apply` (a dry-run), review the summary, then `npm run sync -- --apply`.
