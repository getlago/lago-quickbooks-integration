# N8N Credentials Setup Guide

This guide walks you through setting up the required credentials in N8N for the Lago to QuickBooks integration.

## 1. QuickBooks OAuth2 Credentials

### Step 1: Create a QuickBooks Developer Account

1. Go to [Intuit Developer Portal](https://developer.intuit.com/)
2. Sign up or log in
3. Create a new app:
   - Click "Create an app"
   - Select "QuickBooks Online and Payments"
   - Choose your app type (Production or Sandbox for testing)

### Step 2: Configure OAuth Settings

In your Intuit Developer app settings:

1. Go to **Keys & OAuth**
2. Note your **Client ID** and **Client Secret**
3. Add Redirect URI:
   ```
   https://your-n8n-instance.com/rest/oauth2-credential/callback
   ```

### Step 3: Create N8N OAuth2 Credential

1. In N8N, go to **Credentials** → **Add Credential**
2. Search for **OAuth2 API**
3. Configure as follows:

| Field | Value |
|-------|-------|
| **Name** | `QuickBooks OAuth2` |
| **Grant Type** | Authorization Code |
| **Authorization URL** | `https://appcenter.intuit.com/connect/oauth2` |
| **Access Token URL** | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` |
| **Client ID** | Your QuickBooks Client ID |
| **Client Secret** | Your QuickBooks Client Secret |
| **Scope** | `com.intuit.quickbooks.accounting` |
| **Auth URI Query Parameters** | Add: `response_type` = `code` |
| **Authentication** | Header |

4. Click **Connect my account** and authorize

### Step 4: Get Your Realm ID

1. After connecting, note your **Realm ID** (Company ID)
2. You can also find it in the QuickBooks URL after logging in:
   ```
   https://app.qbo.intuit.com/app/homepage?companyId=YOUR_REALM_ID
   ```

### Step 5: Get Tax Code and Tax Rate IDs (for Tax Override)

To use Lago's calculated tax instead of QuickBooks automatic tax, you need the Tax Code and Tax Rate IDs.

**Option A: Query via API**

Use an HTTP Request node in N8N with your QuickBooks credentials:

```
GET https://sandbox-quickbooks.api.intuit.com/v3/company/YOUR_REALM_ID/query?query=SELECT * FROM TaxCode
```

```
GET https://sandbox-quickbooks.api.intuit.com/v3/company/YOUR_REALM_ID/query?query=SELECT * FROM TaxRate
```

**Option B: Use QuickBooks API Explorer**

1. Go to [Intuit Developer API Explorer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/taxcode)
2. Connect your sandbox/production company
3. Run queries for TaxCode and TaxRate entities

Note the `Id` values from the responses for:
- **QB_TAX_CODE_ID**: The TaxCode Id (e.g., "2")
- **QB_TAX_RATE_ID**: The TaxRate Id (e.g., "3")

---

## 2. Lago API Credentials (for Initial Sync)

### Create HTTP Header Auth Credential

1. In N8N, go to **Credentials** → **Add Credential**
2. Search for **Header Auth**
3. Configure:

| Field | Value |
|-------|-------|
| **Name** | `Lago API Key` |
| **Header Name** | `Authorization` |
| **Header Value** | `Bearer YOUR_LAGO_API_KEY` |

To get your Lago API key:
1. Log into Lago
2. Go to **Settings** → **API Keys**
3. Copy your API key

---

## 3. Webhook Signature Verification

The Lago webhook signature is verified using HMAC-SHA256. Here's how to set it up:

### Configure Lago Webhook

1. Log into Lago
2. Go to **Settings** → **Webhooks**
3. Click **Add Endpoint**
4. Configure:
   - **URL**: `https://your-n8n-instance.com/webhook/lago-webhook`
   - **Events**: Select all relevant events (customer.*, invoice.*, credit_note.*)
5. Enable **Signature Verification**
6. Copy the **Webhook Secret**

### Set N8N Environment Variable

Add the webhook secret to N8N:

**Option A: Docker/Environment**
```bash
export LAGO_WEBHOOK_SECRET=your_webhook_secret
```

**Option B: N8N Settings**
1. Go to N8N Settings
2. Add environment variable: `LAGO_WEBHOOK_SECRET`

---

## 4. Optional: Slack Notifications

To receive error alerts via Slack:

### Create Slack App

1. Go to [Slack API](https://api.slack.com/apps)
2. Create a new app
3. Add **OAuth Scopes**: `chat:write`, `channels:read`
4. Install to workspace
5. Copy the **Bot Token**

### Create N8N Slack Credential

1. In N8N, go to **Credentials** → **Add Credential**
2. Search for **Slack API**
3. Configure:

| Field | Value |
|-------|-------|
| **Name** | `Slack Bot` |
| **Access Token** | Your Bot Token (xoxb-...) |

---

## 5. Optional: Google Sheets Error Logging

For logging errors to a spreadsheet:

### Create Google Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable Google Sheets API
4. Create a Service Account
5. Download the JSON key file

### Create N8N Google Sheets Credential

1. In N8N, go to **Credentials** → **Add Credential**
2. Search for **Google Sheets OAuth2 API** or **Service Account**
3. Upload or paste your credentials

### Prepare the Error Log Sheet

Create a Google Sheet with these columns:
- Timestamp
- Workflow
- Node
- Webhook Type
- Lago ID
- Error
- Execution ID

Share the sheet with your service account email.

---

## Credential Checklist

Before running the integration, ensure you have:

- [ ] QuickBooks OAuth2 credential created and connected
- [ ] Realm ID noted and configured in workflow (`QB_REALM_ID`)
- [ ] Default Item ID configured (`QB_DEFAULT_ITEM_ID`)
- [ ] Tax Code ID configured for tax override (`QB_TAX_CODE_ID`)
- [ ] Tax Rate ID configured for tax override (`QB_TAX_RATE_ID`)
- [ ] Lago Webhook Secret configured (`LAGO_WEBHOOK_SECRET`)
- [ ] Item mappings configured in **Item Mappings Config** node
- [ ] (Optional) Lago API Key credential (for initial sync only)
- [ ] (Optional) Slack credential for alerts
- [ ] (Optional) Google Sheets credential for logging

---

## Testing Credentials

### Test QuickBooks Connection

Run this query in an HTTP Request node:
```
GET https://sandbox-quickbooks.api.intuit.com/v3/company/YOUR_REALM_ID/companyinfo/YOUR_REALM_ID
```

If successful, you'll see your company information.

### Test Lago Webhook

Use the N8N webhook test feature:
1. Open the main workflow
2. Click on "Lago Webhook Receiver"
3. Click "Listen for test event"
4. Send a test webhook from Lago (Settings → Webhooks → Test)

---

## Troubleshooting

### "Invalid grant" error
- Your refresh token may have expired
- Re-authorize the QuickBooks credential

### "Signature mismatch" error
- Verify LAGO_WEBHOOK_SECRET matches Lago settings
- Ensure the webhook URL is exactly correct

### "Rate limit exceeded"
- QuickBooks has API rate limits
- Add delays between bulk operations
- Consider using the Minor Version parameter for optimizations

### "Entity not found"
- The referenced customer/invoice doesn't exist in QuickBooks
- For invoices/credit notes: Customer is auto-created if not found
- For payments: Ensure the invoice exists before payment webhook

### Tax not appearing on invoice
- Ensure `QB_TAX_CODE_ID` and `QB_TAX_RATE_ID` are configured
- Verify Tax Code and Tax Rate exist in your QuickBooks company
- Check that the Lago invoice has `taxes_amount_cents > 0`

### Duplicate invoice/credit note created
- The workflow checks by `DocNumber` (Lago invoice/credit note number)
- Ensure the Lago number is unique
- Check if an existing document was manually created with the same number
