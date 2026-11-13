/**
 * QBO request payloads built by transform/* and the row shapes read back from QBO queries.
 * Only the fields this job sends or reads are listed. Amounts are dollars (QBO's unit), produced
 * exclusively by transform/money.ts from integer cents.
 */

export interface Ref {
  value: string;
}

export interface QboAddress {
  Line1?: string;
  Line2?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

export interface QboCustomerPayload {
  DisplayName: string;
  CompanyName?: string;
  GivenName?: string;
  FamilyName?: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  BillAddr?: QboAddress;
  CurrencyRef?: Ref;
  Notes: string;
}

export interface QboCustomerUpdate extends Partial<QboCustomerPayload> {
  Id: string;
  SyncToken: string;
  sparse: true;
}

/** "TAX" / "NON" are the US-company line tax codes (PLAN.md Q8: US only). */
export type LineTaxCode = 'TAX' | 'NON';

export interface SalesItemLine {
  LineNum: number;
  Amount: number;
  DetailType: 'SalesItemLineDetail';
  Description: string;
  SalesItemLineDetail: {
    Qty: number;
    UnitPrice: number;
    ItemRef: Ref;
    TaxCodeRef: { value: LineTaxCode };
  };
}

export interface DiscountLine {
  LineNum: number;
  Amount: number;
  DetailType: 'DiscountLineDetail';
  Description: string;
  DiscountLineDetail: {
    PercentBased: false;
    DiscountAccountRef: Ref;
  };
}

export type QboLine = SalesItemLine | DiscountLine;

export interface TxnTaxDetail {
  TxnTaxCodeRef: Ref;
  TotalTax: number;
}

interface QboSalesDocument {
  /** Filled in by sync once the customer pass has resolved the QBO customer Id. */
  CustomerRef?: Ref;
  DocNumber: string;
  TxnDate: string;
  CurrencyRef: Ref;
  Line: QboLine[];
  PrivateNote: string;
  CustomerMemo: { value: string };
  TxnTaxDetail?: TxnTaxDetail;
  BillEmail?: { Address: string };
}

export interface QboInvoicePayload extends QboSalesDocument {
  DueDate?: string;
}

export type QboCreditMemoPayload = QboSalesDocument;

export interface QboPaymentPayload {
  CustomerRef: Ref;
  TotalAmt: number;
  CurrencyRef: Ref;
  Line: Array<{ Amount: number; LinkedTxn: Array<{ TxnId: string; TxnType: 'Invoice' }> }>;
  PrivateNote: string;
}

export interface QboVoidPayload {
  Id: string;
  SyncToken: string;
}

/** Rows returned by `SELECT * FROM Customer WHERE DisplayName = '…'`. */
export interface QboCustomerRow {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  Notes?: string;
  [field: string]: unknown;
}

/** Rows returned by `SELECT * FROM Invoice|CreditMemo WHERE DocNumber = '…'`. */
export interface QboTxnRow {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TotalAmt?: number;
  Balance?: number;
  CustomerRef?: Ref;
  PrivateNote?: string;
  [field: string]: unknown;
}

/** Company facts read once per run (GET /companyinfo, GET /preferences). */
export interface CompanyContext {
  country: string;
  homeCurrency: string;
  multiCurrencyEnabled: boolean;
}
