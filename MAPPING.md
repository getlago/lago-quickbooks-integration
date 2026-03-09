# Lago to QuickBooks Data Mapping Reference

This document provides detailed information about how data is mapped from Lago to QuickBooks in the n8n integration workflow.

---

## Table of Contents

1. [Customer Mapping](#customer-mapping)
2. [Invoice Mapping](#invoice-mapping)
3. [Credit Note Mapping](#credit-note-mapping)
4. [Payment Mapping](#payment-mapping)
5. [Item Code Mapping](#item-code-mapping)
6. [Tax Mapping](#tax-mapping)
7. [Discount/Credit Mapping](#discountcredit-mapping)
8. [Data Transformations](#data-transformations)

---

## Customer Mapping

### Field Mapping

Lago customers are transformed to QuickBooks customer records with the following field mappings:

| Lago Field | QuickBooks Field | Priority | Notes |
|------------|------------------|----------|-------|
| `name` | `DisplayName` | 1st choice | Max 100 characters |
| `firstname + lastname` | `DisplayName` | 2nd choice | Concatenated with space |
| `legal_name` | `DisplayName` | 3rd choice | If name not available |
| `external_id` | `DisplayName` | 4th choice | Fallback if all else empty |
| `legal_name` | `CompanyName` | 1st choice | |
| `name` | `CompanyName` | 2nd choice | Fallback |
| `firstname` | `GivenName` | - | Individual's first name |
| `lastname` | `FamilyName` | - | Individual's last name |
| `email` | `PrimaryEmailAddr.Address` | - | |
| `phone` | `PrimaryPhone.FreeFormNumber` | - | |
| `url` | `WebAddr.URI` | - | Company website |
| `address_line1` | `BillAddr.Line1` | - | Billing address |
| `address_line2` | `BillAddr.Line2` | - | |
| `city` | `BillAddr.City` | - | |
| `state` | `BillAddr.CountrySubDivisionCode` | - | |
| `zipcode` | `BillAddr.PostalCode` | - | |
| `country` | `BillAddr.Country` | - | |
| `shipping_address.*` | `ShipAddr.*` | - | Same structure as BillAddr |
| `tax_identification_number` | `TaxIdentificationNumber` | - | Tax ID/VAT number |
| `currency` | `CurrencyRef.value` | - | Currency code (USD, EUR, etc.) |
| `lago_id` | `Notes` | - | Stored in notes for reference |
| `external_id` | `Notes` | - | Stored in notes for reference |
| `slug` | `Notes` | - | Stored in notes for reference |

### DisplayName Priority Logic

```javascript
const displayName =
  lagoCustomer.name ||
  [lagoCustomer.firstname, lagoCustomer.lastname].filter(Boolean).join(' ') ||
  lagoCustomer.legal_name ||
  lagoCustomer.external_id;
```

### Notes Format

```
Lago ID: {lago_id}
External ID: {external_id}
```

### Upsert Logic

1. Lookup customer by `DisplayName`
2. If found: Update existing customer (using `Id`, `SyncToken`, `sparse: true`)
3. If not found: Create new customer

---

## Invoice Mapping

### Header Fields

| Lago Field | QuickBooks Field | Transform | Notes |
|------------|------------------|-----------|-------|
| `customer` (lookup) | `CustomerRef.value` | Customer ID | Looked up or created |
| `number` | `DocNumber` | - | Invoice number |
| `issuing_date` | `TxnDate` | - | Transaction date |
| `payment_due_date` | `DueDate` | - | |
| `currency` | `CurrencyRef.value` | - | Currency code |
| `lago_id` | `PrivateNote` | - | Internal note |
| `number` | `CustomerMemo.value` | Template | Visible to customer |
| `customer.email` | `BillEmail.Address` | - | Billing email |

### Line Items - Fees (SalesItemLineDetail)

Each Lago `fee` becomes a QuickBooks line item:

| Lago Fee Field | QuickBooks Field | Transform | Notes |
|----------------|------------------|-----------|-------|
| `amount_cents` | `Amount` | cents ÷ 100 | **Gross amount** (before coupons) |
| `item.invoice_display_name` | `Description` | 1st choice | Max 4000 chars |
| `item.name` | `Description` | 2nd choice | |
| `description` | `Description` | 3rd choice | |
| `units` | `SalesItemLineDetail.Qty` | parseFloat | Defaults to 1 |
| `precise_unit_amount` | `SalesItemLineDetail.UnitPrice` | cents ÷ 100 | Calculated from amount/units |
| `item.code` | `SalesItemLineDetail.ItemRef.value` | Via mapping | See [Item Code Mapping](#item-code-mapping) |
| `taxes_amount_cents > 0` | `SalesItemLineDetail.TaxCodeRef.value` | 'TAX' or 'NON' | TAX if taxable |

**Important**: The workflow uses **gross amounts** for fees (before coupons/progressive billing credits are applied). This ensures QuickBooks displays the full amount on line items.

### Line Items - Before-Tax Credits (DiscountLineDetail)

Coupons and progressive billing credits (credits with `before_taxes: true`) are combined into a single discount line:

| Source | QuickBooks Field | Transform | Notes |
|--------|------------------|-----------|-------|
| Sum of credits with `before_taxes: true` | `Amount` | cents ÷ 100 | Positive amount |
| - | `Description` | - | "Discounts (Coupons and Usage Credits)" |
| - | `DetailType` | - | DiscountLineDetail |
| Config: `QB_DISCOUNT_ACCOUNT_ID` | `DiscountAccountRef.value` | - | Account for discounts |
| - | `PercentBased` | - | false (amount-based) |

### Line Items - After-Tax Credits (Negative SalesItemLineDetail)

Credit notes applied to invoices and prepaid credits (credits with `before_taxes: false`) are added as negative line items:

| Lago Field | QuickBooks Field | Transform | Notes |
|------------|------------------|-----------|-------|
| `credit.amount_cents` | `Amount` | -(cents ÷ 100) | Negative amount |
| - | `Description` | - | "Credit note credits" or "Prepaid credits" |
| - | `DetailType` | - | SalesItemLineDetail |
| Config: `QB_DEFAULT_ITEM_ID` | `ItemRef.value` | - | Default item |
| - | `TaxCodeRef.value` | - | 'NON' (non-taxable) |

### Tax Details (TxnTaxDetail)

| Lago Field | QuickBooks Field | Transform | Notes |
|------------|------------------|-----------|-------|
| `taxes_amount_cents` | `TxnTaxDetail.TotalTax` | cents ÷ 100 | **Exact tax override** |
| Config: `QB_TAX_CODE_ID` | `TxnTaxDetail.TxnTaxCodeRef.value` | - | Required for override |

**Critical**: API calls use `?minorversion=70` to enable tax override functionality.

### Invoice Creation Flow

1. **Transform Invoice**: Convert Lago invoice to QB format
2. **Map Lago Items**: Apply item code mappings
3. **Lookup Customer**: Find or create customer in QB
4. **Finalize Invoice**: Attach customer ID
5. **Lookup Invoice**: Check for duplicates by `DocNumber`
6. **Create or Skip**: Create if new, skip if duplicate

---

## Credit Note Mapping

### Header Fields

| Lago Field | QuickBooks Field | Transform | Notes |
|------------|------------------|-----------|-------|
| `customer` (lookup) | `CustomerRef.value` | Customer ID | Looked up or created |
| `number` | `DocNumber` | - | Credit memo number |
| `issuing_date` | `TxnDate` | - | Transaction date |
| `currency` | `CurrencyRef.value` | - | Currency code |
| `lago_id` | `PrivateNote` | Template | Internal note |
| `reason` | `PrivateNote` | Template | Reason for credit |
| `invoice.number` | `PrivateNote` | Template | Original invoice reference |
| `number` | `CustomerMemo.value` | Template | Visible to customer |
| `customer.email` | `BillEmail.Address` | - | Billing email |

### Line Items

Each Lago credit note `item` becomes a QuickBooks line item:

| Lago CN Item Field | QuickBooks Field | Transform | Notes |
|--------------------|------------------|-----------|-------|
| `amount_cents` | `Amount` | cents ÷ 100 | |
| `fee.item.invoice_display_name` | `Description` | 1st choice | Max 4000 chars |
| `fee.item.name` | `Description` | 2nd choice | |
| - | `Description` | 3rd choice | "Credit Note Item" |
| 1 | `SalesItemLineDetail.Qty` | - | Fixed |
| `amount_cents` | `SalesItemLineDetail.UnitPrice` | cents ÷ 100 | Same as Amount |
| `fee.item.code` | `SalesItemLineDetail.ItemRef.value` | Via mapping | See [Item Code Mapping](#item-code-mapping) |
| `fee.taxes_rate > 0` | `SalesItemLineDetail.TaxCodeRef.value` | 'TAX' or 'NON' | TAX if taxable |

### Tax Details (TxnTaxDetail)

Same as invoices - uses `TxnTaxDetail.TotalTax` for exact tax override.

### Credit Note Creation Flow

1. **Transform Credit Note**: Convert Lago CN to QB format
2. **Map CN Items**: Apply item code mappings
3. **Lookup Customer**: Find or create customer in QB
4. **Finalize Credit Note**: Attach customer ID
5. **Lookup CN**: Check for duplicates by `DocNumber`
6. **Create or Skip**: Create if new, skip if duplicate

---

## Payment Mapping

### Payment Object

| Lago Field | QuickBooks Field | Transform | Notes |
|------------|------------------|-----------|-------|
| Invoice lookup | `CustomerRef.value` | - | From QB invoice |
| `total_amount_cents` | `TotalAmt` | cents ÷ 100 | Payment amount |
| `currency` | `CurrencyRef.value` | - | Currency code |
| `total_amount_cents` | `Line[0].Amount` | cents ÷ 100 | Same as TotalAmt |
| QB Invoice ID | `Line[0].LinkedTxn[0].TxnId` | - | Links payment to invoice |
| - | `Line[0].LinkedTxn[0].TxnType` | - | 'Invoice' |
| `number`, `lago_id` | `PrivateNote` | Template | Internal tracking |

### Payment Status Mapping

| Lago Status | Action | Notes |
|-------------|--------|-------|
| `succeeded` | Create Payment | Links payment to invoice |
| `failed` | Log only | QB doesn't track failed payments |
| `pending` | Log only | No action in QB |
| `refunded` | Create Refund Receipt | (Not implemented in current workflow) |

### Payment Creation Flow

1. **Extract Payment Info**: Get status and amounts
2. **Lookup Invoice**: Find QB invoice by `DocNumber`
3. **Check Status**: Only proceed if `succeeded`
4. **Create Payment Object**: Link to invoice
5. **Create Payment**: Submit to QB

---

## Item Code Mapping

### Configuration Location

Configured in the **Item Mappings Config** node:

```javascript
const MAPPINGS = {
  ITEM_MAPPINGS: {
    'startup_plan': '1',      // Lago code → QB Item ID
    'premium_plan': '2',
    'api_calls': '3',
    'storage': '4',
  },
  ITEM_FALLBACK_ID: '1',      // Used when no mapping found
};
```

### Mapping Logic

For each line item:

1. Extract `item.code` from Lago fee/credit note item
2. Look up in `ITEM_MAPPINGS`
3. If found: Use mapped QB Item ID
4. If not found: Use `ITEM_FALLBACK_ID`

### Example

**Lago Fee:**
```json
{
  "item": {
    "code": "premium_plan",
    "name": "Premium Subscription"
  }
}
```

**QuickBooks Line Item:**
```json
{
  "SalesItemLineDetail": {
    "ItemRef": {
      "value": "2",        // From ITEM_MAPPINGS['premium_plan']
      "name": "Services"
    }
  }
}
```

---

## Tax Mapping

### Tax Override System

This workflow uses Lago's calculated tax amounts instead of QuickBooks' automatic tax calculations.

### Configuration

```javascript
const MAPPINGS = {
  QB_TAX_CODE_ID: '2',  // Your QuickBooks Tax Code ID
};
```

### How It Works

1. **Line Item Level**: Each line item is marked as `TAX` or `NON` based on whether it has tax in Lago
   ```javascript
   TaxCodeRef: { value: hasTax ? 'TAX' : 'NON' }
   ```

2. **Transaction Level**: The total tax amount is specified exactly
   ```javascript
   TxnTaxDetail: {
     TxnTaxCodeRef: { value: QB_TAX_CODE_ID },
     TotalTax: centsToDollars(taxes_amount_cents)  // Exact amount from Lago
   }
   ```

3. **API Version**: Uses `?minorversion=70` to enable tax override
   ```
   POST /v3/company/{realmId}/invoice?minorversion=70
   ```

### Finding Your Tax Code ID

Run this query in QuickBooks API Explorer:

```sql
SELECT * FROM TaxCode
```

Look for the ID of your tax code (e.g., "Sales Tax", "VAT").

### Example

**Lago Invoice:**
- Subtotal: $1,000.00
- Tax (25%): $250.00
- Total: $1,250.00

**QuickBooks Invoice:**
```json
{
  "Line": [
    {
      "Amount": 1000.00,
      "SalesItemLineDetail": {
        "TaxCodeRef": { "value": "TAX" }
      }
    }
  ],
  "TxnTaxDetail": {
    "TxnTaxCodeRef": { "value": "2" },
    "TotalTax": 250.00
  }
}
```

Result: QB shows exactly $250.00 tax, regardless of configured tax rates.

---

## Discount/Credit Mapping

### Before-Tax Discounts (DiscountLineDetail)

Used for coupons and progressive billing credits.

#### Configuration

```javascript
const MAPPINGS = {
  DISCOUNT_MAPPINGS: {
    'startup_deal': '1',       // Discount code → QB Account ID
    'loyalty_discount': '2',
  },
  DISCOUNT_FALLBACK_ACCOUNT_ID: '1'
};
```

#### Mapping Logic

Currently, all before-tax credits are combined into a single discount line using `QB_DISCOUNT_ACCOUNT_ID`. Individual discount code mapping is available for future customization.

### After-Tax Credits (Negative Line Items)

Credit notes and prepaid credits are applied after tax calculation and appear as negative line items.

---

## Data Transformations

### Currency Transformations

#### Cents to Dollars

All Lago amounts in cents are converted to dollars:

```javascript
const centsToDollars = (cents) => Number((cents / 100).toFixed(2));
```

**Examples:**
- `amount_cents: 123456` → `Amount: 1234.56`
- `taxes_amount_cents: 25000` → `TotalTax: 250.00`

#### Precise Unit Amount

Lago provides precise unit amounts as strings:

```javascript
const preciseToDollars = (preciseStr) => Number(parseFloat(preciseStr).toFixed(2));
```

**Example:**
- `precise_unit_amount: "123.456789"` → `UnitPrice: 123.46`

### String Transformations

#### Truncation

QuickBooks has field length limits:

- **DisplayName**: 100 characters max
- **Description**: 4,000 characters max

```javascript
displayName.substring(0, 100)
description.substring(0, 4000)
```

#### Concatenation

Multiple Lago fields can be combined:

```javascript
// DisplayName from firstname + lastname
[lagoCustomer.firstname, lagoCustomer.lastname].filter(Boolean).join(' ')

// Notes field
`Lago ID: ${lago_id}\nExternal ID: ${external_id}`
```

### Object Cleanup

Removes undefined values to avoid QB API errors:

```javascript
const cleanObject = (obj) => {
  Object.keys(obj).forEach(key => {
    if (obj[key] === undefined) delete obj[key];
    else if (typeof obj[key] === 'object' && obj[key] !== null) {
      cleanObject(obj[key]);
      if (Object.keys(obj[key]).length === 0) delete obj[key];
    }
  });
};
```

### Credit Categorization

Credits are separated into before-tax and after-tax:

```javascript
if (credit.before_taxes) {
  // Coupons, progressive billing - DiscountLineDetail
  beforeTaxDiscountCents += credit.amount_cents;
} else {
  // Credit notes - negative SalesItemLineDetail
  afterTaxCreditNotes.push(credit);
}
```

---

## Workflow Configuration Reference

### Required IDs

To use this workflow, you must configure the following IDs in QuickBooks:

| Configuration | Where to Find | How to Configure |
|---------------|---------------|------------------|
| `QB_REALM_ID` | QuickBooks Company Settings | "Verify HMAC Signature" node |
| `QB_DEFAULT_ITEM_ID` | QuickBooks Products & Services | "Verify HMAC Signature" node |
| `QB_DISCOUNT_ACCOUNT_ID` | QuickBooks Chart of Accounts | "Verify HMAC Signature" node |
| `QB_TAX_CODE_ID` | Query: `SELECT * FROM TaxCode` | "Item Mappings Config" node |
| Item Mappings | QuickBooks Products & Services | "Item Mappings Config" node |

### Finding QuickBooks IDs

1. **Realm ID**: Your company ID, found in URLs when logged into QuickBooks Online
2. **Item IDs**: Query `SELECT * FROM Item` in API Explorer
3. **Account IDs**: Query `SELECT * FROM Account` in API Explorer
4. **Tax Code ID**: Query `SELECT * FROM TaxCode` in API Explorer

---

## Summary

This mapping system provides:

- ✅ **Flexible customer data mapping** with priority fallbacks
- ✅ **Accurate tax representation** using Lago's calculated amounts
- ✅ **Customizable item mappings** for different billing plans
- ✅ **Credit handling** for both before-tax (coupons) and after-tax (credit notes)
- ✅ **Gross amount display** showing full amounts before discounts
- ✅ **Duplicate prevention** via lookup-first approach
- ✅ **Automatic customer creation** when processing invoices/credit notes

For implementation details, see the code in the n8n workflow nodes.
