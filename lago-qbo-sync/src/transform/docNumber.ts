import type { Mappings } from '../config/schema.js';

export type DocKind = 'invoice' | 'credit_note';

export type DocNumberCheck =
  | { ok: true; number: string; compliant: boolean }
  | { ok: false; reason: string };

type PrefixRules = Mappings['lago']['invoice_prefix_rules'];

/**
 * Guards for QBO DocNumber, applied before any QBO call.
 *
 * - Brief §6 bug #3: QBO DocNumber is at most 21 characters; a longer number fails the document.
 * - Brief §6 bug #2: numbers with characters outside `allowed_pattern` (e.g. `[`) did not match in
 *   QBO queries even when URL-encoded. They are marked non-compliant, so reconcile never treats an
 *   empty lookup for them as proof the document is absent.
 */
export function checkDocNumber(number: string, kind: DocKind, rules: PrefixRules): DocNumberCheck {
  if (number.length === 0) return { ok: false, reason: 'Lago document has an empty number' };
  if (number.length > rules.max_docnumber_length) {
    const hint =
      kind === 'credit_note'
        ? 'Lago prefix too long: credit note numbers add -CN001; keep the prefix ≤ 4 characters'
        : 'Lago prefix too long: shorten the Lago document number prefix';
    return {
      ok: false,
      reason: `DocNumber "${number}" is ${number.length} characters; QBO allows ${rules.max_docnumber_length}. ${hint}`,
    };
  }
  return { ok: true, number, compliant: new RegExp(rules.allowed_pattern).test(number) };
}
