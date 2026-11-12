import { describe, expect, it } from 'vitest';
import {
  bulkInvoices,
  describeBulkPlan,
  describePlan,
  isAllowedWrite,
  parseSeedArgs,
  seedNames,
  writeRefusal,
} from '../../scripts/seed.js';

describe('bulk seed (§10 throughput)', () => {
  it('parses --bulk within bounds and refuses it with --void', () => {
    expect(parseSeedArgs(['--bulk=500'])).toEqual({ mode: 'plan', bulk: 500 });
    expect(parseSeedArgs(['--seed', '--bulk=500', '--confirm-billing-entity=x'])).toEqual({ mode: 'seed', bulk: 500, confirmBillingEntity: 'x' });
    expect(parseSeedArgs(['--bulk=0'])).toMatchObject({ error: expect.stringContaining('1 to 1000') });
    expect(parseSeedArgs(['--bulk=abc'])).toMatchObject({ error: expect.any(String) });
    expect(parseSeedArgs(['--void', '--manifest=m.json', '--bulk=5'])).toMatchObject({ error: expect.stringContaining('--void') });
  });

  it('spreads 500 invoices over 25 tagged customers, half of them taxed', () => {
    const invoices = bulkInvoices('t1', 500);
    expect(invoices).toHaveLength(500);
    expect(new Set(invoices.map((i) => i.customer.externalId)).size).toBe(25);
    expect(invoices.every((i) => i.customer.externalId.startsWith('qa-t1-bulk-'))).toBe(true);
    expect(invoices.filter((i) => i.customer.taxed).length).toBe(240);
    expect(Math.min(...invoices.map((i) => i.unitAmountCents))).toBe(1000);
    expect(Math.max(...invoices.map((i) => i.unitAmountCents))).toBe(1822);
    expect(describeBulkPlan('t1', 500).join('\n')).toContain('500 one-off invoices');
  });
});

describe('seed script guards (PLAN.md Q11: test org only)', () => {
  it('defaults to plan-only; --seed and --void are explicit', () => {
    expect(parseSeedArgs([])).toEqual({ mode: 'plan' });
    expect(parseSeedArgs(['--seed', '--confirm-billing-entity=acme'])).toEqual({ mode: 'seed', confirmBillingEntity: 'acme' });
    expect(parseSeedArgs(['--void'])).toEqual({ error: '--void needs --manifest=.seed/<tag>.json' });
    expect(parseSeedArgs(['--force'])).toEqual({ error: 'Unknown option: --force' });
  });

  it('refuses unless sandbox AND a billing entity of this org is named', () => {
    const codes = ['acme_test', 'neo_de'];
    expect(writeRefusal({ environment: 'production', confirmBillingEntity: 'acme_test', billingEntityCodes: codes })).toMatch(/not "sandbox"/);
    expect(writeRefusal({ environment: 'sandbox', confirmBillingEntity: undefined, billingEntityCodes: codes })).toMatch(/acme_test, neo_de/);
    expect(writeRefusal({ environment: 'sandbox', confirmBillingEntity: 'prod_entity', billingEntityCodes: codes })).toMatch(/refusing/);
    expect(writeRefusal({ environment: 'sandbox', confirmBillingEntity: 'neo_de', billingEntityCodes: codes })).toBeNull();
  });

  it('only writes to the listed endpoints (never DELETE, never updates)', () => {
    for (const p of ['/taxes', '/customers', '/coupons', '/applied_coupons', '/plans', '/add_ons', '/subscriptions', '/invoices', '/wallets', '/credit_notes/estimate', '/credit_notes', '/payments', '/invoices/00000000-0000-4000-8000-000000000001/void']) {
      expect(isAllowedWrite(p), p).toBe(true);
    }
    for (const p of ['/invoices/x/finalize', '/organizations', '/webhook_endpoints', '/customers/abc', '/plans/x', '/invoices/../organizations/void']) {
      expect(isAllowedWrite(p), p).toBe(false);
    }
  });

  it('tags every resource and covers the planned §10 scenarios', () => {
    const n = seedNames('abc123');
    for (const code of [n.tax, n.coupon, n.plan, n.addOn, n.customerA, n.customerB, n.customerC, n.subA, n.subB1, n.subB2]) {
      expect(code.startsWith('qa-abc123-')).toBe(true);
    }
    expect(n.nameB).toContain("O'Brien");
    expect(n.nameC.length).toBe(120);
    const plan = describePlan(n).join('\n');
    for (const scenario of ['coupon + tax', 'Prepaid credits + applied credit note', 'Long names', 'Voided invoice']) {
      expect(plan).toContain(scenario);
    }
    expect(plan).toContain('Nothing is deleted');
  });
});
