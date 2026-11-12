import { describe, expect, it } from 'vitest';
import {
  byIds,
  customerByDisplayName,
  literal,
  qboUrl,
  QueryBuildError,
  txnByDocNumber,
  txnsByDocNumbers,
} from '../../src/qbo/query.js';

/** What QBO's server sees after decoding the `query` parameter. */
function decodedQuery(url: string): string {
  const raw = /[?&]query=([^&]*)/.exec(url)?.[1];
  if (raw === undefined) throw new Error('no query parameter');
  return decodeURIComponent(raw);
}

const queryUrl = (statement: string) => qboUrl('sandbox', '1234567890123456', 75, { kind: 'query' }, { query: statement });

describe('literal (brief §6 bug #1)', () => {
  it("escapes single quotes as \\' (O'Neil)", () => {
    expect(literal("O'Neil Analytics")).toBe("'O\\'Neil Analytics'");
    expect(customerByDisplayName("O'Neil Analytics")).toBe("SELECT * FROM Customer WHERE DisplayName = 'O\\'Neil Analytics'");
  });

  it('cannot be broken out of with quotes', () => {
    const q = customerByDisplayName("x' OR DisplayName = 'y");
    expect(q).toBe("SELECT * FROM Customer WHERE DisplayName = 'x\\' OR DisplayName = \\'y'");
  });

  it('refuses backslashes, control characters and empty values rather than guessing an escape', () => {
    expect(() => literal('a\\b')).toThrow(QueryBuildError);
    expect(() => literal('a\nb')).toThrow(QueryBuildError);
    expect(() => literal('a\u0000b')).toThrow(QueryBuildError);
    expect(() => literal('')).toThrow(QueryBuildError);
  });
});

describe('qboUrl', () => {
  it('encodes the whole statement with encodeURIComponent: no raw [, ], #, &, %, \\ or spaces in the URL', () => {
    const statement = txnByDocNumber('Invoice', "[AC]-2026#1&x=%'");
    const url = queryUrl(statement);
    const queryValue = /query=([^&]*)/.exec(url)![1]!;
    // encodeURIComponent leaves ' ( ) * ! unencoded; they are valid in a query string, and the
    // n8n DocNumber lookups that worked in testing sent them the same way.
    expect(queryValue).not.toMatch(/[\[\]#& \\]|%(?![0-9A-F]{2})/);
    expect(url).toContain('%5BAC%5D-2026%231%26x%3D%25%5C\'');
    expect(decodedQuery(url)).toBe(statement);
  });

  it("encodes spaces as %20, never '+'", () => {
    const url = queryUrl(customerByDisplayName('Acme Robotics'));
    expect(url).toContain('Acme%20Robotics');
    expect(url).not.toContain('+');
  });

  it('builds sandbox and production base URLs with minorversion on every call', () => {
    expect(qboUrl('sandbox', '1', 75, { kind: 'entity', entity: 'invoice' })).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/1/invoice?minorversion=75',
    );
    expect(qboUrl('production', '1', 75, { kind: 'entity', entity: 'invoice' }, { operation: 'void' })).toBe(
      'https://quickbooks.api.intuit.com/v3/company/1/invoice?operation=void&minorversion=75',
    );
    expect(qboUrl('sandbox', '1', 75, { kind: 'companyinfo' })).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/1/companyinfo/1?minorversion=75',
    );
    expect(qboUrl('sandbox', '1', 75, { kind: 'preferences' })).toContain('/v3/company/1/preferences?');
  });

  it('refuses a non-numeric realm id', () => {
    expect(() => qboUrl('sandbox', '1/../2', 75, { kind: 'query' })).toThrow(QueryBuildError);
  });
});

describe('statement builders', () => {
  it('looks up invoices and credit memos by DocNumber', () => {
    expect(txnByDocNumber('Invoice', 'ACME-202610-001')).toBe("SELECT * FROM Invoice WHERE DocNumber = 'ACME-202610-001'");
    expect(txnByDocNumber('CreditMemo', 'ACME-202610-001-CN001')).toBe(
      "SELECT * FROM CreditMemo WHERE DocNumber = 'ACME-202610-001-CN001'",
    );
  });

  it('batches DocNumbers for reconciliation, 1 to 50 per query', () => {
    expect(txnsByDocNumbers('Invoice', ['A-1', "B'2"])).toBe(
      "SELECT * FROM Invoice WHERE DocNumber IN ('A-1', 'B\\'2') MAXRESULTS 1000",
    );
    expect(() => txnsByDocNumbers('Invoice', [])).toThrow(QueryBuildError);
    expect(() => txnsByDocNumbers('Invoice', Array.from({ length: 51 }, (_, i) => `N-${i}`))).toThrow(QueryBuildError);
  });

  it('looks up configured ids for check-config', () => {
    expect(byIds('Item', ['1', '10'])).toBe("SELECT * FROM Item WHERE Id IN ('1', '10') MAXRESULTS 1000");
  });
});
