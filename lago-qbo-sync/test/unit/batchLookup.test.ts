import { describe, expect, it } from 'vitest';
import type { QboTxnRow } from '../../src/qbo/types.js';
import { chunks, groupBatchLookup } from '../../src/sync/batchLookup.js';

const row = (Id: string, DocNumber: string): QboTxnRow => ({ Id, SyncToken: '0', DocNumber });
const byDoc = (r: QboTxnRow) => r.DocNumber;

describe('groupBatchLookup', () => {
  it('answers found / none per requested number', () => {
    const m = groupBatchLookup(['A-1', 'A-2', 'A-3'], [row('7', 'A-1'), row('9', 'A-3')], byDoc);
    expect(m.get('A-1')).toEqual({ kind: 'found', rows: [row('7', 'A-1')] });
    expect(m.get('A-2')).toEqual({ kind: 'none' });
    expect(m.get('A-3')).toEqual({ kind: 'found', rows: [row('9', 'A-3')] });
  });

  it('keeps duplicates so reconcile can fail them', () => {
    const m = groupBatchLookup(['A-1'], [row('7', 'A-1'), row('8', 'A-1')], byDoc);
    expect(m.get('A-1')).toEqual({ kind: 'found', rows: [row('7', 'A-1'), row('8', 'A-1')] });
  });

  it('leaves a number unanswered when QBO returned it with different case (single lookup decides)', () => {
    const m = groupBatchLookup(['DEMO-1', 'DEMO-2'], [row('7', 'demo-1')], byDoc);
    expect(m.has('DEMO-1')).toBe(false);
    expect(m.get('DEMO-2')).toEqual({ kind: 'none' });
  });

  it('ignores rows for numbers that were not requested', () => {
    expect(groupBatchLookup(['A-1'], [row('5', 'B-9')], byDoc).get('A-1')).toEqual({ kind: 'none' });
  });

  it('works on any key, e.g. customer DisplayName', () => {
    const m = groupBatchLookup(["O'Brien & Sons", 'Acme'], [{ Id: '1', DisplayName: "O'Brien & Sons" }], (r) => r.DisplayName);
    expect(m.get("O'Brien & Sons")).toEqual({ kind: 'found', rows: [{ Id: '1', DisplayName: "O'Brien & Sons" }] });
    expect(m.get('Acme')).toEqual({ kind: 'none' });
  });

  it('chunks lists for IN queries', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 50)).toEqual([]);
  });
});
