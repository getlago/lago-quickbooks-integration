import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { parseMappings } from '../src/config/load.js';
import type { Mappings } from '../src/config/schema.js';
import { lagoCreditNoteSchema, lagoInvoiceSchema, type LagoCreditNote, type LagoInvoice } from '../src/lago/types.js';
import type { QboLine } from '../src/qbo/types.js';

const root = path.resolve(import.meta.dirname, '..');
const fixtureDir = path.join(root, 'test', 'fixtures', 'lago');

/** Loads a fixture and validates it with the same schema the Lago client uses, so fixtures stay realistic. */
function load<S extends z.ZodType>(name: string, schema: S): z.infer<S> {
  const raw = JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8')) as unknown;
  return schema.parse(raw);
}

export const invoiceFixture = (name: string): LagoInvoice => load(name, lagoInvoiceSchema);
export const creditNoteFixture = (name: string): LagoCreditNote => load(name, lagoCreditNoteSchema);

/** mappings.example.yaml with optional overrides of qbo.tax_code_id and items. */
export function testMappings(overrides: { taxCodeId?: string; items?: Record<string, string> } = {}): Mappings {
  const base = parseMappings(readFileSync(path.join(root, 'mappings.example.yaml'), 'utf8'));
  return {
    ...base,
    qbo: { ...base.qbo, tax_code_id: overrides.taxCodeId ?? base.qbo.tax_code_id },
    items: overrides.items ?? { startup: '10', api_calls: '20', seats: '30', onboarding_fee: '40' },
  };
}

const cents = (dollars: number) => Math.round(dollars * 100);

/**
 * What QBO will compute as TotalAmt for a payload, in cents: sales lines − discount lines + TotalTax.
 * Also asserts QBO's line rule Amount = Qty × UnitPrice (brief §5.2).
 */
export function qboTotalCents(doc: { Line: QboLine[]; TxnTaxDetail?: { TotalTax: number } }): number {
  let total = 0;
  for (const line of doc.Line) {
    if (line.DetailType === 'SalesItemLineDetail') {
      const { Qty, UnitPrice } = line.SalesItemLineDetail;
      if (cents(Qty * UnitPrice) !== cents(line.Amount)) {
        throw new Error(`line ${line.LineNum}: Amount ${line.Amount} != Qty ${Qty} × UnitPrice ${UnitPrice}`);
      }
      total += cents(line.Amount);
    } else {
      total -= cents(line.Amount);
    }
  }
  return total + cents(doc.TxnTaxDetail?.TotalTax ?? 0);
}
