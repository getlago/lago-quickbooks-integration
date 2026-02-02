# Lago to QuickBooks Integration via N8N

A complete integration solution that synchronizes billing data from [Lago](https://www.getlago.com/) to [QuickBooks Online](https://quickbooks.intuit.com/) using [N8N](https://n8n.io/) as the middleware.

## Overview

This integration handles the following Lago webhook events and creates corresponding records in QuickBooks:

| Lago Event | QuickBooks Action |
|------------|-------------------|
| `customer.created` | Create Customer |
| `customer.updated` | Update Customer |
| `invoice.generated` | Create Invoice with Line Items |
| `credit_note.generated` | Create Credit Memo |
| `invoice.payment_status_updated` | Create Payment (if succeeded) |

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

## Installation

### 1. Import the Workflow

1. Open your N8N instance
2. Go to **Workflows** → **Import from File**
3. Select `workflows/lago-quickbooks-main.json`
4. The workflow will be imported with all nodes configured

### 2. Configure Environment Variables

Set the following environment variables in N8N:

```bash
# Lago Configuration
LAGO_WEBHOOK_SECRET=your_lago_webhook_secret

# QuickBooks Configuration
QB_ENVIRONMENT=sandbox  # or 'production'
QB_REALM_ID=your_company_id
QB_DEFAULT_ITEM_ID=1
QB_DISCOUNT_ACCOUNT_ID=1
```

### 3. Set Up QuickBooks OAuth2 Credentials

1. Go to **Credentials** in N8N
2. Create new **OAuth2 API** credential
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
Verify HMAC Signature
        │
        ▼
Route by Webhook Type ─────┬───────────┬───────────┬───────────┐
        │                  │           │           │           │
        ▼                  ▼           ▼           ▼           ▼
   Customer            Customer    Invoice     Credit      Payment
   Created             Updated    Generated    Note       Updated
        │                  │           │           │           │
        ▼                  ▼           ▼           ▼           ▼
   Transform           Transform   Transform   Transform   Extract
   Customer            Customer    Invoice     Credit      Payment
        │                  │           │        Note         Info
        └────────┬─────────┘           │           │           │
                 ▼                     ▼           ▼           ▼
          Lookup Customer        Lookup Customer  ...     Lookup Invoice
                 │                     │                       │
                 ▼                     ▼                       ▼
          Prepare Upsert        Finalize Invoice        Check Status
                 │                     │                    │    │
                 ▼                     ▼                    ▼    ▼
        Create/Update QB        Create Invoice QB     Payment  Log
              Customer                                        Status
                 │                     │                  │
                 └─────────────────────┴──────────────────┴─► Respond Success
```

## Data Mapping

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
| `applied_taxes[]` | `TxnTaxDetail.TaxLine[]` |

### Fee to Line Item Mapping

| Lago Fee Field | QuickBooks Line Field |
|----------------|----------------------|
| `amount_cents` / 100 | `Amount` |
| `item.invoice_display_name` / `item.name` | `Description` |
| `units` | `SalesItemLineDetail.Qty` |
| `precise_unit_amount` | `SalesItemLineDetail.UnitPrice` |
| `taxes_rate > 0` | `TaxCodeRef: TAX/NON` |

## Customization

### Adding New Mappings

Edit `config/mapping-config.json` to customize field mappings:

```json
{
  "itemMapping": {
    "mappings": {
      "your_lago_item_code": {
        "qbItemId": "123",
        "qbItemName": "Your QB Item"
      }
    }
  }
}
```

### Custom Tax Codes

Map Lago tax codes to QuickBooks tax codes:

```json
{
  "taxCodeMapping": {
    "mappings": {
      "your_lago_tax_code": {
        "qbTaxCodeId": "TAX",
        "qbTaxRateId": "5"
      }
    }
  }
}
```

### Modifying Transformations

To modify how data is transformed, edit the corresponding Code nodes in the workflow:

1. **Transform Customer (Create/Update)**: Customer field mapping
2. **Transform Invoice**: Invoice and line item creation
3. **Transform Credit Note**: Credit memo creation
4. **Create Payment Object**: Payment linking

## Error Handling

The workflow includes error handling for common scenarios:

1. **Invalid Signature**: Rejects webhooks with invalid HMAC signatures
2. **Customer Not Found**: Throws error if invoice references non-existent customer
3. **Invoice Not Found**: Throws error if payment references non-existent invoice

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
2. **Invoices**: Verify line items, taxes, and discounts
3. **Payments**: Confirm payment is linked to invoice

## Production Checklist

- [ ] Change `QB_ENVIRONMENT` to `production`
- [ ] Update QuickBooks OAuth credentials for production
- [ ] Configure proper error handling workflow
- [ ] Set up monitoring/alerting
- [ ] Test with real Lago webhooks
- [ ] Verify all tax codes are mapped correctly
- [ ] Configure proper item mappings
- [ ] Enable workflow execution logging

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
