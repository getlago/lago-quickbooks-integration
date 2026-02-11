# Lago to QuickBooks Integration via N8N

A complete integration solution that synchronizes billing data from [Lago](https://www.getlago.com/) to [QuickBooks Online](https://quickbooks.intuit.com/) using [N8N](https://n8n.io/) as the middleware.

## Overview

This integration handles the following Lago webhook events and creates corresponding records in QuickBooks:

| Lago Event | QuickBooks Action |
|------------|-------------------|
| `customer.created` | Create/Update Customer |
| `customer.updated` | Create/Update Customer |
| `invoice.created` | Create Invoice with Line Items |
| `invoice.one_off_created` | Create Invoice with Line Items |
| `credit_note.created` | Create Credit Memo |
| `invoice.payment_status_updated` | Create Payment (if succeeded) |

### Key Features

- **Item Mappings**: Map Lago item codes to QuickBooks Item IDs with fallbacks
- **Tax Override**: Uses Lago's exact tax amounts via `TxnTaxDetail.TotalTax` (works with AST enabled using `minorversion=70`)
- **Customer Auto-Creation**: Automatically creates customers if they don't exist when processing invoices/credit notes
- **Duplicate Prevention**: Checks if invoice/credit memo already exists before creating

## Architecture

```
┌─────────────┐     Webhook      ┌─────────────┐     API Calls     ┌─────────────┐
│    Lago     │ ───────────────► │     N8N     │ ─────────────────► │ QuickBooks  │
│   Billing   │   (HMAC Signed)  │  Middleware │    (OAuth 2.0)    │   Online    │
└─────────────┘                  └─────────────┘                    └─────────────┘
```

## Prerequisites

1. **N8N Instance**: Self-hosted or N8N Cloud
2. **Lago Account**: With API access and webhook configuration
3. **QuickBooks Online Account**: Developer account for OAuth credentials

## Documentation

- **[SETUP-GUIDE.md](SETUP-GUIDE.md)**: Complete setup instructions including OAuth2 credential configuration
- **[ITEM-TAX-MAPPING-GUIDE.md](ITEM-TAX-MAPPING-GUIDE.md)**: Practical guide for configuring item and tax mappings at scale
- **[MAPPING.md](MAPPING.md)**: Detailed data mapping reference for all entities (customers, invoices, credit notes, payments)
- **[mapping-config.json](mapping-config.json)**: JSON schema reference for mapping structure

## Installation

### 1. Import the Workflow

1. Open your N8N instance
2. Go to **Workflows** → **Import from File**
3. Select `lago-quickbooks-main.json`
4. The workflow will be imported with all nodes configured

### 2. Configure Workflow Settings

The workflow configuration is split between two nodes:

#### Verify HMAC Signature Node (Basic Settings)

```javascript
const CONFIG = {
  // Lago Settings
  LAGO_WEBHOOK_SECRET: 'your_lago_webhook_secret_here',
  BYPASS_SIGNATURE: true,  // Set to false in production

  // QuickBooks Settings
  QB_ENVIRONMENT: 'sandbox',  // 'sandbox' or 'production'
  QB_REALM_ID: 'your_quickbooks_company_id',
  QB_DEFAULT_ITEM_ID: '1',           // Default item for line items
  QB_DISCOUNT_ACCOUNT_ID: '1'        // Account for discounts/credits
};
```

#### Item Mappings Config Node (Mappings & Tax)

See [Item Mappings](#item-mappings) and [Tax Override](#tax-override-configuration) sections below.

### 3. Set Up QuickBooks OAuth2 Credentials

**Important**: See [SETUP-GUIDE.md](SETUP-GUIDE.md) for detailed credential setup instructions.

1. Click the **+** button in n8n's top menu → Select **Credentials**
2. Create new **QuickBooks OAuth2 API** credential
3. Configure with your QuickBooks app credentials:

| Field | Value |
|-------|-------|
| Authorization URL | `https://appcenter.intuit.com/connect/oauth2` |
| Access Token URL | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` |
| Client ID | Your QuickBooks Client ID |
| Client Secret | Your QuickBooks Client Secret |
| Scope | `com.intuit.quickbooks.accounting` |
| Auth URI Query Parameters | `response_type=code` |

### 4. Configure Lago Webhook

1. In Lago, go to **Settings** → **Webhooks**
2. Add a new webhook endpoint:
   - **URL**: `https://your-n8n-instance.com/webhook/lago-webhook`
   - **Signature**: Enable HMAC signature
3. Copy the webhook secret to your N8N environment variables

## Workflow Structure

### Main Workflow Nodes

```
Lago Webhook Receiver
        │
        ▼
Verify HMAC Signature ──► Item Mappings Config
        │
        ▼
Route by Webhook Type ─────┬───────────┬───────────┬───────────┐
        │                  │           │           │           │
        ▼                  ▼           ▼           ▼           ▼
   Customer            Customer    Invoice     Credit      Payment
   Created             Updated    Created      Note       Updated
        │                  │           │           │           │
        ▼                  ▼           ▼           ▼           ▼
   Transform           Transform   Transform   Transform   Extract
   Customer            Customer    Invoice     Credit      Payment
        │                  │           │        Note         Info
        └────────┬─────────┘           │           │           │
                 ▼                     ▼           ▼           ▼
          Lookup Customer         Map Items    Map Items   Lookup Invoice
                 │                     │           │           │
                 ▼                     ▼           ▼           ▼
          Prepare Upsert        Lookup Cust  Lookup Cust  Check Status
                 │                     │           │        │    │
                 ▼                     ▼           ▼        ▼    ▼
        Create/Update QB      Customer Exists? Customer?  Payment Log
                             ┌───┴───┐     ┌───┴───┐
                             ▼       ▼     ▼       ▼
                          Finalize  Create Finalize Create
                          Invoice   Cust   CN      Cust
                             │       │     │       │
                             └───┬───┘     └───┬───┘
                                 ▼             ▼
                          Lookup Invoice  Lookup CN
                                 │             │
                                 ▼             ▼
                          Invoice Exists? CN Exists?
                          ┌───┴───┐     ┌───┴───┐
                          ▼       ▼     ▼       ▼
                        Skip   Create  Skip   Create
                        Dup    Invoice Dup    CN
```

### Invoice/Credit Note Flow Features

1. **Item Mapping**: Maps Lago item codes to QuickBooks Item IDs
2. **Customer Auto-Creation**: Creates customer in QB if not found
3. **Duplicate Prevention**: Skips creation if document already exists
4. **Tax Override**: Uses `TxnTaxDetail.TotalTax` to pass Lago's exact tax amount (requires `minorversion=70`)

## Data Mapping

**For comprehensive mapping details, see [MAPPING.md](MAPPING.md).**

### Customer Mapping

| Lago Field | QuickBooks Field |
|------------|------------------|
| `name` / `firstname + lastname` | `DisplayName` |
| `legal_name` | `CompanyName` |
| `firstname` | `GivenName` |
| `lastname` | `FamilyName` |
| `email` | `PrimaryEmailAddr.Address` |
| `phone` | `PrimaryPhone.FreeFormNumber` |
| `address_*` | `BillAddr.*` |
| `shipping_address.*` | `ShipAddr.*` |
| `currency` | `CurrencyRef.value` |
| `tax_identification_number` | `TaxIdentificationNumber` |

### Invoice Mapping

| Lago Field | QuickBooks Field |
|------------|------------------|
| `number` | `DocNumber` |
| `issuing_date` | `TxnDate` |
| `payment_due_date` | `DueDate` |
| `currency` | `CurrencyRef.value` |
| `fees[]` | `Line[]` (SalesItemLineDetail) |
| `credits[]` | `Line[]` (DiscountLineDetail) |
| `taxes_amount_cents` | `TxnTaxDetail.TotalTax` |

### Fee to Line Item Mapping

| Lago Fee Field | QuickBooks Line Field |
|----------------|----------------------|
| `amount_cents` / 100 | `Amount` |
| `item.invoice_display_name` / `item.name` | `Description` |
| `units` | `SalesItemLineDetail.Qty` |
| `precise_unit_amount` | `SalesItemLineDetail.UnitPrice` |
| `taxes_rate > 0` | `TaxCodeRef: TAX/NON` |

### Credit Note Mapping

| Lago Field | QuickBooks Field |
|------------|------------------|
| `number` | `DocNumber` |
| `issuing_date` | `TxnDate` |
| `currency` | `CurrencyRef.value` |
| `items[]` | `Line[]` (SalesItemLineDetail) |
| `taxes_amount_cents` | `TxnTaxDetail.TotalTax` |

### Credit Note Item to Line Item Mapping

| Lago Credit Note Item Field | QuickBooks Line Field |
|-----------------------------|----------------------|
| `amount_cents` / 100 | `Amount` |
| `fee.item.invoice_display_name` / `fee.item.name` | `Description` |
| `fee.taxes_rate > 0` | `TaxCodeRef: TAX/NON` |

## Customization

### Item Mappings

**For detailed item and tax mapping configuration, see [ITEM-TAX-MAPPING-GUIDE.md](ITEM-TAX-MAPPING-GUIDE.md).**

Edit the **Item Mappings Config** node to map Lago item codes to QuickBooks Item IDs:

```javascript
const MAPPINGS = {
  // Map Lago fees.item.code to QuickBooks Item IDs
  ITEM_MAPPINGS: {
    'startup_plan': '1',      // Lago code → QB Item ID
    'premium_plan': '2',
    'api_calls': '3',
  },
  ITEM_FALLBACK_ID: '1',      // Used when no mapping found

  // Tax Code for tax override (see Tax Override section)
  QB_TAX_CODE_ID: '',         // Your QuickBooks Tax Code ID

  // Map Lago credit codes to QuickBooks Discount Account IDs
  DISCOUNT_MAPPINGS: {
    'startup_deal': '1',
    'loyalty_discount': '2',
  },
  DISCOUNT_FALLBACK_ACCOUNT_ID: '1'
};
```

### Tax Override Configuration

This workflow uses Lago's calculated tax amounts instead of QuickBooks Automated Sales Tax (AST). This works even with AST enabled by using `TxnTaxDetail.TotalTax` with API `minorversion=70`.

#### How It Works

1. Line items are marked `TAX` or `NON` based on whether they have tax in Lago
2. The `TxnTaxDetail.TotalTax` field specifies the exact tax amount from Lago
3. The `TxnTaxCodeRef` associates the transaction with your tax code
4. API calls use `?minorversion=70` to ensure QuickBooks honors the override

#### Setup

1. Find your QuickBooks Tax Code ID:
   ```sql
   SELECT * FROM TaxCode
   ```

2. Configure in the **Item Mappings Config** node:
   ```javascript
   QB_TAX_CODE_ID: '2',    // Your Tax Code ID
   ```

#### Example

For a Lago invoice with $1000 subtotal + $250 tax (25%):
- Line items total: $1000 (marked as `TAX`)
- `TxnTaxDetail.TotalTax`: $250
- QuickBooks invoice total: $1250

For a Lago credit note with $500 subtotal + $125 tax (25%):
- Line items total: $500 (marked as `TAX`)
- `TxnTaxDetail.TotalTax`: $125
- QuickBooks credit memo total: $625

QuickBooks will display the exact tax amounts from Lago regardless of any tax rates configured in your AST settings.

### Modifying Transformations

To modify how data is transformed, edit the corresponding Code nodes in the workflow:

1. **Transform Customer (Create/Update)**: Customer field mapping
2. **Transform Invoice**: Invoice and line item creation
3. **Transform Credit Note**: Credit memo creation
4. **Create Payment Object**: Payment linking

## Error Handling

The workflow includes built-in handling for common scenarios:

1. **Invalid Signature**: Rejects webhooks with invalid HMAC signatures (when `BYPASS_SIGNATURE: false`)
2. **Customer Not Found**: Automatically creates customer if not found (for invoices/credit notes)
3. **Duplicate Documents**: Skips creation if invoice/credit note already exists in QuickBooks
4. **Invoice Not Found for Payment**: Throws error if payment references non-existent invoice

### Recommended Error Workflow

Create a separate error workflow in N8N to:
- Log failed webhook processing
- Send alerts via Slack/Email
- Retry failed operations

## Testing

### Using N8N Test Webhook

1. Click on the **Lago Webhook Receiver** node
2. Click **Listen for Test Event**
3. Send a test webhook from Lago or use curl:

```bash
curl -X POST https://your-n8n-instance.com/webhook-test/lago-webhook \
  -H "Content-Type: application/json" \
  -H "X-Lago-Signature: your_signature" \
  -d '{
    "webhook_type": "customer.created",
    "object_type": "customer",
    "customer": {
      "lago_id": "test-123",
      "name": "Test Customer",
      "email": "test@example.com"
    }
  }'
```

### Verifying QuickBooks Data

After processing, verify in QuickBooks:
1. **Customers**: Check for new/updated customer records
2. **Invoices**: Verify line items, taxes, and total amounts
3. **Credit Memos**: Verify line items, taxes, and total amounts
4. **Payments**: Confirm payment is linked to invoice

## Production Checklist

- [ ] Change `QB_ENVIRONMENT` to `production`
- [ ] Set `BYPASS_SIGNATURE` to `false`
- [ ] Update QuickBooks OAuth credentials for production
- [ ] Configure `QB_TAX_CODE_ID` in **Item Mappings Config** node for tax override
- [ ] Configure item mappings in **Item Mappings Config** node
- [ ] Set proper `QB_DEFAULT_ITEM_ID` for unmapped items
- [ ] Configure proper error handling workflow
- [ ] Set up monitoring/alerting
- [ ] Test with real Lago webhooks
- [ ] Enable workflow execution logging
- [ ] Configure concurrency limits for high volume (see below)

## High Volume Configuration

For handling large invoice volumes (e.g., 10,000+ invoices/day), configure N8N's native concurrency control.

### QuickBooks API Rate Limits

| Limit | Value |
|-------|-------|
| Standard endpoints | 500 requests/minute |
| Concurrent requests | 10 max |
| Per-second limit | 10 requests/second |

### Required Environment Variable

Set this environment variable on your N8N instance:

```bash
N8N_CONCURRENCY_PRODUCTION_LIMIT=10
```

This limits concurrent webhook executions to 10, matching QuickBooks' concurrent request limit. Excess webhooks are queued in memory (FIFO order) and processed as capacity frees up.

### How It Works

```
Webhook burst arrives (e.g., 10,000 in 5 minutes)
        │
        ▼
N8N accepts all webhooks, responds 200 immediately
        │
        ▼
10 execute concurrently, rest queue in memory
        │
        ▼
Built-in Wait nodes (1s each) pace API calls
        │
        ▼
Queue drains at ~100 invoices/minute
        │
        ▼
10,000 invoices processed in ~100 minutes
```

### Throughput Estimates

| Concurrency Limit | Wait Time | Throughput | 10k Invoices |
|-------------------|-----------|------------|--------------|
| 10 | 1s between calls | ~100/min | ~100 minutes |
| 5 | 1s between calls | ~50/min | ~200 minutes |

### Why Lookup-First is Required

The workflow uses a lookup-first approach to prevent duplicates:

1. **Query QB** for existing invoice by DocNumber
2. **Skip** if found, **Create** if not found

**Why not optimistic creates?** QuickBooks does NOT enforce unique `DocNumber` values. If you skip the lookup and just try to create, QB will happily create duplicate invoices with the same DocNumber. The lookup step is essential.

### Important Notes

1. **Memory Queue**: Webhooks queue in N8N's memory. If N8N restarts, queued webhooks are lost. Consider using Lago's webhook retry mechanism for resilience.

2. **No Redis Required**: This solution uses N8N's built-in concurrency control, not queue mode (which requires Redis).

3. **Wait Nodes**: The workflow includes Wait nodes (1 second) after each QuickBooks API call to prevent rate limit errors.

4. **Monitoring**: Monitor N8N's execution queue depth via the UI or API to ensure the queue isn't growing unbounded.

## Troubleshooting

### Common Issues

1. **Invalid Signature Error**
   - Verify `LAGO_WEBHOOK_SECRET` matches Lago configuration
   - Ensure raw body is being used for signature verification

2. **Customer Not Found**
   - Ensure customers are synced before invoices
   - Check that Lago ID is stored in QB customer notes

3. **OAuth Token Expired**
   - N8N should auto-refresh tokens
   - If not, re-authenticate in credentials

4. **Currency Mismatch**
   - QuickBooks may require multi-currency to be enabled
   - Ensure currency codes match QB supported currencies

5. **Tax Amount Not Matching**
   - Ensure `QB_TAX_CODE_ID` is configured in Item Mappings Config
   - Verify the API call includes `?minorversion=70` (already configured in workflow)
   - The workflow uses `TxnTaxDetail.TotalTax` to override AST calculations

### Debugging

Enable detailed logging in N8N:
1. Go to **Settings** → **Log Level**
2. Set to **Debug** for verbose output
3. Check execution history for detailed node outputs

## Support

- **Lago Documentation**: https://docs.getlago.com/
- **QuickBooks API**: https://developer.intuit.com/
- **N8N Documentation**: https://docs.n8n.io/

## License

MIT License - Feel free to modify and use in your projects.
