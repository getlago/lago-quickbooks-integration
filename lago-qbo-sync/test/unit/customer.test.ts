import { describe, expect, it } from 'vitest';
import type { LagoCustomer } from '../../src/lago/types.js';
import { customerDisplayName, toQboCustomer } from '../../src/transform/customer.js';
import { invoiceFixture } from '../helpers.js';

const base: LagoCustomer = { lago_id: 'cus-1', external_id: 'ext_1' };

describe('customerDisplayName (MAPPING.md "DisplayName Priority Logic")', () => {
  it('uses name → firstname + lastname → legal_name → external_id', () => {
    expect(customerDisplayName({ ...base, name: 'Acme', firstname: 'A', legal_name: 'Acme Inc' })).toBe('Acme');
    expect(customerDisplayName({ ...base, name: '', firstname: 'Dana', lastname: 'Lee', legal_name: 'L' })).toBe('Dana Lee');
    expect(customerDisplayName({ ...base, lastname: 'Lee' })).toBe('Lee');
    expect(customerDisplayName({ ...base, name: null, legal_name: 'Acme Inc' })).toBe('Acme Inc');
    expect(customerDisplayName(base)).toBe('ext_1');
  });

  it('truncates to 100 characters', () => {
    const long = 'N'.repeat(130);
    expect(customerDisplayName({ ...base, name: long })).toBe('N'.repeat(100));
  });

  it("keeps apostrophes as-is (escaping is the QBO query builder's job)", () => {
    expect(customerDisplayName({ ...base, name: "O'Neil Analytics" })).toBe("O'Neil Analytics");
  });

  it('returns null when every source is empty', () => {
    expect(customerDisplayName({ ...base, external_id: '' })).toBeNull();
  });
});

describe('toQboCustomer (n8n "Transform Customer Create/Update")', () => {
  it('maps a full customer exactly as the n8n node does', () => {
    const r = toQboCustomer(invoiceFixture('invoice-coupon-tax').customer);
    expect(r).toEqual({
      ok: true,
      value: {
        DisplayName: 'Acme Robotics',
        CompanyName: 'Acme Robotics Inc.',
        PrimaryEmailAddr: { Address: 'billing@acme.example' },
        PrimaryPhone: { FreeFormNumber: '+1 555 0100' },
        BillAddr: { Line1: '1 Main St', City: 'Springfield', CountrySubDivisionCode: 'CA', PostalCode: '90001', Country: 'US' },
        CurrencyRef: { value: 'USD' },
        Notes: 'Lago ID: cus-0000-0000-0000-000000000001\nExternal ID: acme_001',
      },
    });
  });

  it('truncates CompanyName to 100 characters too (QBO fault 2050 seen in the sandbox)', () => {
    const long = 'L'.repeat(120);
    const r = toQboCustomer({ ...base, name: long });
    expect(r.ok && r.value.DisplayName).toBe('L'.repeat(100));
    expect(r.ok && r.value.CompanyName).toBe('L'.repeat(100));
    const legal = toQboCustomer({ ...base, name: 'Short', legal_name: 'G'.repeat(150) });
    expect(legal.ok && legal.value.CompanyName).toBe('G'.repeat(100));
  });

  it('does not send url or tax_identification_number (not mapped by n8n)', () => {
    const r = toQboCustomer({ ...base, name: 'X', url: 'https://x.example', tax_identification_number: 'FR123' });
    expect(r.ok && Object.keys(r.value)).toEqual(['DisplayName', 'CompanyName', 'Notes']);
  });

  it('maps an individual (firstname + lastname)', () => {
    const r = toQboCustomer(invoiceFixture('invoice-prepaid-and-credit-note').customer);
    expect(r.ok && r.value).toMatchObject({ DisplayName: 'Dana Lee', GivenName: 'Dana', FamilyName: 'Lee' });
    expect(r.ok && r.value.CompanyName).toBeUndefined();
  });

  it('handles a customer with only an external_id (missing optional fields)', () => {
    const r = toQboCustomer(invoiceFixture('invoice-missing-optional').customer);
    expect(r).toEqual({
      ok: true,
      value: { DisplayName: 'cust_ext_003', Notes: 'Lago ID: cus-0000-0000-0000-000000000003\nExternal ID: cust_ext_003' },
    });
  });

  it('fails clearly instead of crashing when there is no usable name', () => {
    expect(toQboCustomer({ ...base, external_id: '' })).toEqual({
      ok: false,
      reason: 'Lago customer cus-1 has no name, legal_name or external_id',
    });
  });
});
