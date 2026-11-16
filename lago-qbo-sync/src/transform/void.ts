import type { LagoInvoice } from '../lago/types.js';
import type { QboTxnRow, QboVoidPayload } from '../qbo/types.js';

/** n8n "Extract Void Invoice Info". */
export interface VoidInfo {
  lagoId: string;
  number: string;
}

export function extractVoidInfo(inv: Pick<LagoInvoice, 'lago_id' | 'number'>): VoidInfo {
  return { lagoId: inv.lago_id, number: inv.number };
}

/** n8n "Void Invoice in QB" body: `{ Id, SyncToken }` sent to `POST /invoice?operation=void`. */
export function toQboVoid(row: QboTxnRow): QboVoidPayload {
  return { Id: row.Id, SyncToken: row.SyncToken };
}
