import type { LagoCustomer } from '../lago/types.js';
import type { QboCustomerPayload } from '../qbo/types.js';
import { cleanObject } from './clean.js';
import { fail, ok, type TransformResult } from './result.js';

/** QBO DisplayName limit (MAPPING.md "Customer Mapping", "String Transformations › Truncation"). */
export const DISPLAY_NAME_MAX = 100;
/**
 * QBO CompanyName limit, from QBO's own fault in the sandbox (2050, "Max:100", element CompanyName).
 * Not in MAPPING.md or the n8n node, which sent it untruncated (deviation decided 2026-11-12).
 */
export const COMPANY_NAME_MAX = 100;

/**
 * MAPPING.md "DisplayName Priority Logic": name → firstname + lastname → legal_name → external_id,
 * truncated to 100 characters. Same expression as every n8n customer node.
 */
export function customerDisplayName(c: LagoCustomer): string | null {
  const name =
    c.name || [c.firstname, c.lastname].filter(Boolean).join(' ') || c.legal_name || c.external_id;
  return name ? name.substring(0, DISPLAY_NAME_MAX) : null;
}

/** MAPPING.md "Notes Format". Also used by reconcile to check customer identity (PLAN.md Q7). */
export function customerNotes(c: LagoCustomer): string {
  return `Lago ID: ${c.lago_id}\nExternal ID: ${c.external_id}`;
}

/**
 * Port of n8n "Transform Customer Create" / "Transform Customer Update" / "Prepare Customer for
 * Invoice" / "Prepare Customer for CN" (four identical copies). MAPPING.md "Customer Mapping".
 * WebAddr, ShipAddr and TaxIdentificationNumber are listed in MAPPING.md but not sent by n8n, so
 * they are not sent here (README "Deviations").
 */
export function toQboCustomer(c: LagoCustomer): TransformResult<QboCustomerPayload> {
  const displayName = customerDisplayName(c);
  if (!displayName) return fail(`Lago customer ${c.lago_id} has no name, legal_name or external_id`);

  return ok(
    cleanObject<QboCustomerPayload>({
      DisplayName: displayName,
      CompanyName: (c.legal_name || c.name || undefined)?.substring(0, COMPANY_NAME_MAX),
      GivenName: c.firstname || undefined,
      FamilyName: c.lastname || undefined,
      PrimaryEmailAddr: c.email ? { Address: c.email } : undefined,
      PrimaryPhone: c.phone ? { FreeFormNumber: c.phone } : undefined,
      BillAddr: {
        Line1: c.address_line1 || undefined,
        Line2: c.address_line2 || undefined,
        City: c.city || undefined,
        CountrySubDivisionCode: c.state || undefined,
        PostalCode: c.zipcode || undefined,
        Country: c.country || undefined,
      },
      CurrencyRef: c.currency ? { value: c.currency } : undefined,
      Notes: customerNotes(c),
    }),
  );
}
