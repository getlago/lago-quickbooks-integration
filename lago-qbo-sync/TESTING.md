# Testing lago-qbo-sync

A guide for a Lago teammate testing the sync on their own machine, against **their own QuickBooks sandbox company** and **our shared Lago test org**. Allow about an hour, most of it one-time setup.

Background, design decisions and every command are in [README.md](README.md). This page is the shortest path to a useful test.

---

## Ground rules

- **Sandbox and test org only.** Never point `mappings.yaml` at a production QuickBooks company or `.env` at a production Lago org.
- **Your own QuickBooks connection.** Don't copy anyone's token file, and don't connect a QuickBooks company someone else is syncing. The run lock works on one machine only, and each connection rotates the token.
- **Secrets stay local.** `.env` and the token file never go in chat, tickets or Git. The JSON run summary contains no secrets and is safe to share.
- **Test data is permanent.** Lago and QuickBooks can void documents but not delete them. Every seeded record is tagged `qa-<tag>`.

## 1. One-time setup

### What you need

- macOS or Linux with **Node.js 22 or later** (`node --version`).
- An **Intuit developer account** (developer.intuit.com). It comes with a free sandbox company.
- A **Lago API key for the test org**. Ask the project owner; it's shared through the password manager.
- Access to the code: a clone of the repository, or the folder you were sent.

### QuickBooks sandbox

1. In the Intuit developer portal, open **Sandbox** and note your sandbox company's **Company ID** (realm ID).
2. Open that company in QuickBooks: gear icon › Account and settings › Advanced › Currency. Check the home currency is **USD**. The Lago test org also has CAD customers:
   - **Multicurrency off:** CAD documents fail with a clear "multicurrency is off" message. That's a valid test of the currency check.
   - **Multicurrency on:** they sync. Turning it on can't be undone; do it only if you want to test CAD.
3. Make sure there is an **active tax code**. Run `npm run check-config` later; if its `qbo_tax_code` check fails, create a sales tax rate in QuickBooks (Taxes › Sales tax) and use its tax code Id.

### Intuit app

Pick one:
- **Ask the project owner to add you** as a collaborator on the team's Intuit app for this sync, then use its Development keys. One app connecting to different sandbox companies is fine.
- **Or create your own app** with the **Accounting** scope.

Either way, under the app's **Development** settings, the redirect URI `http://localhost:8000/callback` must be registered, exactly.

### Install and configure

```bash
npm install
```

Create a private folder for the token, outside the repository:
```bash
mkdir -p ~/.config/lago-qbo-sync && chmod 700 ~/.config/lago-qbo-sync
```

Create `.env` and fill it in. `TOKEN_STORE_PATH` must be an absolute path, e.g. `/Users/<you>/.config/lago-qbo-sync/qbo.token.json`:
```bash
cp .env.example .env && chmod 600 .env
```

Create `mappings.yaml`, then set `qbo.realm_id` to your sandbox Company ID, in quotes:
```bash
cp mappings.example.yaml mappings.yaml
```

Leave the other Ids for now; step 2 tells you which ones are wrong.

### Connect QuickBooks

The command prints an Intuit URL. Open it, sign in, pick **your** sandbox company and click Connect. Port 8000 must be free.
```bash
npm run auth
```

You should see `"status": "connected"` with your realm ID.

## 2. Check the setup

```bash
npm test
```
Expect all tests to pass (no network involved).

```bash
npm run check-config
```
Every check should be `pass`. If `qbo_items`, `qbo_discount_account` or `qbo_tax_code` fails, fix the Ids in `mappings.yaml` and run it again:
- **Items:** in QuickBooks, Sales › Products and services. The Id is in each item's URL. `default_item_id` must be an active item, e.g. "Services".
- **Discount account:** an income account for discounts, e.g. "Discounts given" (Accounting › Chart of accounts).
- **Tax code:** see "QuickBooks sandbox" above.

Warnings under `lago_numbers` are expected: the test org has numbers with `[` and numbers over 21 characters, on purpose.

## 3. Read-only first run

```bash
npm run dry-run
```

Nothing is written. The summary shows `would_create` counts for what's in the last 3 days of the test org, and `missing_in_qbo` lists everything from the last 45 days that your sandbox doesn't have yet (which is most of it).

## 4. The automated checklist

1. Create the test scenarios in the Lago test org (coupon + tax, credit note + prepaid credits, apostrophe, long name, paid invoice, invoice to void). Running it without `--seed` first shows the plan without writing anything:
   ```bash
   npm run seed -- --seed --confirm-billing-entity=<test-org billing entity code>
   ```
   The project owner gives you the billing entity code of the test org (the script refuses to write without it). Note the `manifest` path it prints, e.g. `.seed/ab12cd.json`.
2. Sync them into your sandbox:
   ```bash
   npm run sync
   ```
3. Void the seeded invoice D in Lago, so the checklist can test voids:
   ```bash
   npm run seed -- --void --manifest=.seed/<tag>.json --confirm-billing-entity=<test-org billing entity code>
   ```
4. Run the checklist. It does two real syncs into your sandbox (payments enabled in memory only) and prints PASS / FAIL / PARTIAL / SKIP for each brief §10 item:
   ```bash
   npm run integration -- --manifest=.seed/<tag>.json
   ```
   Expected: everything PASS, except #8 PARTIAL (deferred payments) and #15 SKIP (throughput, which needs a fresh 500-invoice seed; only run that if asked, it adds 500 permanent invoices).

## 5. Manual scenarios

Do these in the **Lago test org** UI, then run `npm run sync` and compare QuickBooks with Lago. Use USD customers unless you're testing currency.

| # | Do in Lago | Expect in QuickBooks after `npm run sync` |
|---|---|---|
| 1 | Create a customer and a one-off invoice | Customer created; invoice with the same number, total and tax |
| 2 | Run `npm run sync` again without changing anything | Nothing new; everything `skipped` |
| 3 | Edit that customer's email in Lago, create another invoice for them | Customer `updated`; new invoice created |
| 4 | Apply a coupon to a customer, then bill them (subscription or one-off) | A discount line equal to the coupon; total matches Lago |
| 5 | Issue a credit note on one of your invoices | A credit memo with the same number and total |
| 6 | Void one of your synced invoices in Lago | The QBO invoice shows amount 0, note starting with "Voided" |
| 7 | In QuickBooks, create an invoice by hand whose number equals a Lago invoice that isn't synced yet; then sync | That Lago invoice **fails** with "was not created from Lago document …"; your hand-made invoice is untouched |
| 8 | Bill a CAD customer (ask the project owner which test-org customers bill in CAD) | Multicurrency off: fails with "multicurrency is off". On: syncs in CAD |
| 9 | Start `npm run sync` in two terminals at the same time | The second exits immediately with `"status": "locked"` |

For each one, check the counts in the summary (`created` / `skipped` / `failed`) and look the document up in QuickBooks.

## 6. Reporting

For anything surprising, send the project owner:
1. **What you did**: the scenario number or steps, the Lago document number and the time.
2. **The exit code**: `echo $?` right after the command.
3. **The JSON summary** from stdout. It's safe to paste and has no secrets. For a failure, its `failures[]` entry quotes QuickBooks' own error.
4. **What you expected** instead.
5. Optional: rerun with `--verbose`, e.g. `npm run sync -- --verbose`, for one log line per API call. Logs are redacted too, but skim them before sharing.

Exit codes: 0 OK · 1 a document failed (or a stale lock) · 2 configuration · 3 QuickBooks connection (rerun `npm run auth`).

## When something goes wrong

| Symptom | Fix |
|---|---|
| `node: .env: not found` | Create `.env` (step 1) |
| Exit 2, "Environment is invalid" | A variable in `.env` is missing or `TOKEN_STORE_PATH` isn't absolute / is inside the repo |
| Exit 2, "permissions …; it must be 0600" | Run the `chmod 600 …` command from the message |
| Exit 3, `invalid_grant` | Your token expired or someone else connected the same app + company: run `npm run auth` again |
| Exit 2, "only US companies are supported" | Use a US sandbox company |
| `redirect_uri` error in the browser | The redirect URI in the Intuit app isn't exactly `http://localhost:8000/callback` |
| `"status": "locked"` with exit 1 ("looks stale") | A run died while holding the lock: README › Runbooks › Stale lock |
