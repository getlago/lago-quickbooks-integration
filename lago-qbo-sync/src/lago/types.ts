import { z } from 'zod';

/**
 * Shapes of the Lago API objects this job reads, limited to the fields it uses.
 * Field names come from the Lago API reference (GET /invoices/{lago_id}, GET /credit_notes/{lago_id})
 * and from the n8n Code nodes in reference/. Objects are loose: Lago adds fields over time and
 * extra fields must not break a run. A missing *used* field fails that one document, not the run.
 */

const optionalText = z.string().nullish();
const cents = z.number().int();

export const lagoCustomerSchema = z.looseObject({
  lago_id: z.string(),
  external_id: z.string(),
  name: optionalText,
  firstname: optionalText,
  lastname: optionalText,
  legal_name: optionalText,
  email: optionalText,
  phone: optionalText,
  address_line1: optionalText,
  address_line2: optionalText,
  city: optionalText,
  state: optionalText,
  zipcode: optionalText,
  country: optionalText,
  currency: optionalText,
});
export type LagoCustomer = z.infer<typeof lagoCustomerSchema>;

const lagoItemSchema = z.looseObject({
  type: optionalText,
  code: optionalText,
  name: optionalText,
  invoice_display_name: optionalText,
});

export const lagoFeeSchema = z.looseObject({
  amount_cents: cents.nullish(),
  taxes_amount_cents: cents.nullish(),
  taxes_rate: z.number().nullish(),
  // Lago sends units as a decimal string ("3.0"); older payloads may send a number.
  units: z.union([z.string(), z.number()]).nullish(),
  precise_unit_amount: optionalText,
  description: optionalText,
  item: lagoItemSchema.nullish(),
});
export type LagoFee = z.infer<typeof lagoFeeSchema>;

export const lagoCreditSchema = z.looseObject({
  amount_cents: cents,
  before_taxes: z.boolean(),
  item: z.looseObject({ type: optionalText, code: optionalText, name: optionalText }).nullish(),
});
export type LagoCredit = z.infer<typeof lagoCreditSchema>;

export const lagoInvoiceSchema = z.looseObject({
  lago_id: z.string(),
  number: z.string(),
  issuing_date: z.string(),
  payment_due_date: optionalText,
  currency: z.string(),
  status: z.string(),
  payment_status: optionalText,
  invoice_type: z.string(),
  total_amount_cents: cents,
  taxes_amount_cents: cents.nullish(),
  prepaid_credit_amount_cents: cents.nullish(),
  fees: z.array(lagoFeeSchema).nullish(),
  credits: z.array(lagoCreditSchema).nullish(),
  customer: lagoCustomerSchema,
});
export type LagoInvoice = z.infer<typeof lagoInvoiceSchema>;

/** An invoice as returned by GET /invoices (list): no fees or credits (PLAN.md F6). */
export const lagoInvoiceSummarySchema = z.looseObject({
  lago_id: z.string(),
  number: z.string(),
  issuing_date: z.string(),
  currency: z.string(),
  status: z.string(),
  payment_status: optionalText,
  invoice_type: z.string(),
  total_amount_cents: cents,
  /** Included in the list response; used to keep existing QBO customers up to date. */
  customer: lagoCustomerSchema.optional(),
});
export type LagoInvoiceSummary = z.infer<typeof lagoInvoiceSummarySchema>;

export const lagoCreditNoteItemSchema = z.looseObject({
  amount_cents: cents,
  fee: lagoFeeSchema.nullish(),
});

export const lagoCreditNoteSchema = z.looseObject({
  lago_id: z.string(),
  number: z.string(),
  issuing_date: z.string(),
  currency: z.string(),
  reason: optionalText,
  invoice_number: optionalText,
  total_amount_cents: cents,
  taxes_amount_cents: cents.nullish(),
  coupons_adjustment_amount_cents: cents.nullish(),
  items: z.array(lagoCreditNoteItemSchema).nullish(),
  customer: lagoCustomerSchema,
});
export type LagoCreditNote = z.infer<typeof lagoCreditNoteSchema>;

/** A credit note as returned by GET /credit_notes (list); `items` is not guaranteed there. */
export const lagoCreditNoteSummarySchema = z.looseObject({
  lago_id: z.string(),
  number: z.string(),
  issuing_date: z.string(),
});
export type LagoCreditNoteSummary = z.infer<typeof lagoCreditNoteSummarySchema>;

/** GET /billing_entities, used by check-config to validate the numbering prefix (PLAN.md F11). */
export const lagoBillingEntitySchema = z.looseObject({
  code: z.string(),
  document_number_prefix: optionalText,
  document_numbering: optionalText,
});
export type LagoBillingEntity = z.infer<typeof lagoBillingEntitySchema>;

export const lagoPageMetaSchema = z.looseObject({
  current_page: z.number().int(),
  next_page: z.number().int().nullish(),
  total_pages: z.number().int().optional(),
  total_count: z.number().int().optional(),
});
