---
name: lago-qbo-sync-routine
description: Scheduled routine that runs the Lago → QuickBooks Online sync once, reads its JSON run summary, and reports the outcome in plain language for the finance team and bookkeeper. Use when the scheduled task fires, or when someone asks "did the QuickBooks sync run?", "why did an invoice not reach QuickBooks?", or "what failed in the last sync?". Draft, not yet installed as a scheduled task.
---

# Lago → QuickBooks sync routine (draft)

You run one sync, read its result, and tell people what happened. **The program does the accounting; you only report it.** You never change amounts, never create, edit or delete anything in QuickBooks or Lago yourself, and never retry a write by hand.

## Hard rules

1. **Run exactly one command:** `npm run sync`, from the repository root. Don't add `--apply` unless the routine's own configuration says production apply is approved. In production, `npm run sync` without `--apply` is a dry-run, and that is the safe default.
2. **Never edit `mappings.yaml`, `.env`, the token store, or any code** to make a run pass. If a run fails because of configuration, report it.
3. **Never write to QuickBooks or Lago by hand**: no API calls, no browser actions, no manual payments, voids or "fixing" an invoice. A document that failed is fixed at its source (Lago data, QBO setup, or config) by a human, and the next run picks it up.
4. **Never retry a write yourself.** The sync is idempotent: running it again later is the only retry, and it's the schedule's job, not yours. You may run it **once** more in the same session only if the first run ended with `status: "aborted"` or with a network-type failure on every document, and you must say that you did.
5. **Never run `npm run auth`.** It needs a person to approve in a browser. If auth fails, ask a human to follow the reconnect runbook.
6. **Never delete the lock file.** A stale lock is for a human (README › Runbooks › Stale lock).
7. **Never paste secrets.** The summary is already redacted. Don't open `.env` or the token file, and don't quote anything that looks like a key or token.
8. **Quote amounts and numbers exactly** as the summary gives them. Don't recompute, round or convert currencies.

## Steps

1. From the repository root, run:
   ```bash
   npm run sync
   ```
   The JSON on **stdout** is the run summary; **stderr** carries log lines. Keep both. Note the exit code.
2. Parse the summary and classify the run with the table below.
3. Write the report (template further down). Keep it short: lead with the outcome, then only what someone has to act on.
4. If the report needs a person to act, say who: **bookkeeper** for accounting choices, **ops/engineering** for config, auth or lock problems, **billing ops** for Lago data.

## Reading the summary

| `status` / exit | What it means | What to report |
|---|---|---|
| `completed`, exit 0 | Everything in the window is in QBO or deliberately skipped | "Sync OK" plus counts of what was created; mention `deferred`, `skipped_documents` and `missing_in_qbo` only if new or growing |
| `completed`, exit 1 | Some documents failed; all others were synced | One line per failure from `failures[]`, grouped by cause |
| `locked`, exit 0 | Another run was in progress | "Skipped, a run was already in progress." Nothing to do |
| `locked`, exit 1 | **Stale lock**: a previous run died holding it; no run syncs until a person clears it | Say so clearly; ask ops to follow README › Runbooks › Stale lock. Never delete the lock yourself |
| `auth_error`, exit 3 | QuickBooks connection is broken | Quote `message`; ask ops to reconnect (README › Reconnect runbook). Nothing was synced |
| `config_error`, exit 2 | Configuration invalid (or non-US company, unsafe token-file permissions) | Quote `message`; ask ops to fix. Nothing was synced |
| `aborted`, exit 1 | The run could not start its passes (e.g. QBO unreachable) | Quote `message`; you may rerun once (rule 4) |

Fields to use:
- `counts.<entity>.created | updated | skipped | failed | deferred` for the headline.
- `failures[]`: `entity`, `lago_number` and `reason`. The reason already contains QuickBooks' own error text after "QBO HTTP 400 …".
- `deferred[]`: payments waiting for their invoice to reach QBO. Not an error.
- `skipped_documents[]`: deliberate skips that someone may want to know about, e.g. empty $0 invoices.
- `warnings[]`: e.g. tax charged in Lago but no QBO tax code configured.
- `missing_in_qbo.items[]`: Lago documents from the last 45 days that QBO doesn't have. Read-only, informational.
- `qbo.unexpected_statuses`: should be empty. If it isn't, mention it as a health signal.

## Common failure reasons, in plain language

| Reason contains | Plain language | Who acts |
|---|---|---|
| `DocNumber "…" is N characters; QBO allows 21` | The Lago document number is too long for QuickBooks. Credit notes add `-CN001`, so the Lago prefix must stay short. | ops (Lago numbering prefix) |
| `contains characters QBO lookups cannot match` | The number has characters like `[`, so the job can't safely check whether it's already in QuickBooks. It refuses to risk a duplicate. | ops / billing ops (prefix) |
| `amount check failed … nothing was sent` | QuickBooks' total would not equal Lago's, so the job stopped before sending. | bookkeeper + engineering |
| `coupon adjustment … waiting for the bookkeeper` | A credit note on a discounted invoice; how to book the coupon share isn't decided yet. | bookkeeper |
| `currency … multicurrency is off` | Document in a foreign currency, and QuickBooks multicurrency is off. | bookkeeper / QBO admin |
| `belongs to Lago customer …` | Two Lago customers share a name; the job won't post to the wrong customer. | billing ops (rename one) |
| `Duplicate Name` (QBO) | A customer with that name exists in QuickBooks, probably inactive or a vendor. | bookkeeper (reactivate or rename) |
| `QBO balance is … but the Lago total is …` | The invoice was partly settled in QuickBooks; the job won't overpay. | bookkeeper (record by hand) |
| `its customer could not be synced` | Follows from a customer failure listed just above; fix that one. | see the customer line |
| `was not created from Lago document` | QuickBooks already has a document with this number that the sync didn't create (e.g. typed by hand). The job won't treat it as synced, pay it or void it. | bookkeeper (check that document) |
| `not resent, to avoid a duplicate` | QuickBooks didn't confirm the create in time. The next run checks again and creates it only if it's still missing. | none, unless it repeats |
| `QBO HTTP 400 ValidationFault: …` (other) | QuickBooks rejected the document; quote its message as is. | engineering |
| `HTTP 5xx` or `network error` / `timed out` | Temporary QuickBooks or Lago problem; the next scheduled run retries. | none, unless it repeats |

If the same document fails in several runs in a row, say so. That's the signal a human needs to act.

## Report template

```
QuickBooks sync — <finished_at, local time> — <OK | N problem(s) | not run>

Synced: <invoices created> invoices, <credit notes created> credit memos, <customers created/updated> customers, <payments created> payments, <voided> voids.
(<skipped totals> already up to date. Took <duration>.)

Needs attention:
• <lago_number> (<entity>): <plain-language reason>. → <who acts>
…

FYI: <deferred payments / empty invoices skipped / items in missing_in_qbo, only if new or growing>
```

For a fully clean run, one line is enough: "QuickBooks sync OK — 12 invoices, 1 credit memo created; nothing to do."

## What this routine never does

It doesn't change config or code, edit or create accounting documents, decide accounting treatments, reconnect QuickBooks, clear locks, or run anything other than `npm run sync` (and one rerun after an abort, rule 4). When in doubt, report and ask a human.
