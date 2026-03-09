# Lago to QuickBooks Integration - Setup Guide

## 🔧 QuickBooks OAuth2 Credential Setup (REQUIRED)

### The Problem You're Experiencing

When you trigger HTTP nodes for QB API calls, you're prompted to "choose the connection" in each node. This happens because **the OAuth2 credential needs initial authorization**.

### The Solution - One-Time Setup

All QuickBooks HTTP Request nodes in this workflow already reference the **same credential** (ID: `quickbooks-oauth2`). You only need to authorize it **once** in n8n's Credentials panel.

#### Step-by-Step:

1. **Open Credentials Panel**
   - Click the **+** button in n8n's top menu bar
   - Select **Credentials** from the dropdown
   - Alternatively, you can access credentials from the left sidebar if available

2. **Find Your QuickBooks OAuth2 Credential**
   - Look for: "QuickBooks OAuth2" or credential ID "quickbooks-oauth2"
   - If it doesn't exist, create it:
     - Click **"Add Credential"**
     - Search for **"QuickBooks OAuth2 API"**
     - Fill in:
       - **Client ID**: From your QuickBooks app
       - **Client Secret**: From your QuickBooks app
       - **Environment**: sandbox or production
       - **Scope**: `com.intuit.quickbooks.accounting`

3. **Authorize the Credential**
   - Click **"Connect my account"** or **"Reauthorize"**
   - A popup window will open
   - **Log in to QuickBooks** and authorize access
   - Select the QuickBooks company
   - Complete the OAuth flow

4. **Save the Credential**
   - The credential is now authorized
   - Close the credentials panel

5. **Test Your Workflow**
   - All 14 QuickBooks HTTP nodes will now work automatically
   - No need to select credentials in individual nodes
   - The credential reference is already configured

### Why This Works

n8n's credential system works like this:
- ✅ Credentials are configured **once** in the Credentials panel
- ✅ Nodes **reference** credentials by ID
- ✅ All nodes using the same credential ID share the same authorization
- ❌ You do NOT need to configure OAuth in each individual node

### QuickBooks HTTP Nodes in This Workflow

This workflow has **14 HTTP Request nodes** that call QuickBooks API:

**Customer Operations (3 nodes):**
1. `Lookup Customer in QB` - Find existing customer
2. `Create Update Customer QB` - Create/update customer
3. `Lookup Customer for Invoice` - Find customer for invoice flow

**Invoice Operations (4 nodes):**
4. `Create Customer for Invoice` - Create customer if missing (invoice flow)
5. `Lookup Invoice in QB` - Check if invoice exists
6. `Create Invoice in QB` - Create new invoice with `minorversion=70` for tax override

**Credit Note Operations (3 nodes):**
7. `Lookup Customer for CN` - Find customer for credit note flow
8. `Create Customer for CN` - Create customer if missing (CN flow)
9. `Lookup CN in QB` - Check if credit memo exists
10. `Create Credit Memo QB` - Create new credit memo with `minorversion=70` for tax override

**Payment Operations (2 nodes):**
11. `Lookup Invoice for Payment` - Find invoice to mark paid
12. `Create Payment in QB` - Record payment

**Void Operations (2 nodes):**
13. `Lookup Invoice for Void` - Find invoice to void
14. `Void Invoice in QB` - Void the invoice

**All 14 nodes use the same credential: `quickbooks-oauth2`**

---

## 📋 Configuration Checklist

Before running the workflow, verify these settings:

### In `Verify HMAC Signature` Node:
```javascript
const CONFIG = {
  LAGO_WEBHOOK_SECRET: 'your_lago_webhook_secret_here',
  BYPASS_SIGNATURE: true,  // Set to false in production
  QB_ENVIRONMENT: 'sandbox',  // 'sandbox' or 'production'
  QB_REALM_ID: 'your_quickbooks_company_id',
  QB_DEFAULT_ITEM_ID: '1',
  QB_DISCOUNT_ACCOUNT_ID: '1'
};
```

### In `Item Mappings Config` Node:
```javascript
const MAPPINGS = {
  ITEM_MAPPINGS: {
    // Map your Lago item codes to QB Item IDs
    // 'startup': '1',
    // 'premium': '2',
  },
  ITEM_FALLBACK_ID: '1',  // Used when no mapping found

  QB_TAX_CODE_ID: '',  // Required for tax override (e.g., '2')

  DISCOUNT_MAPPINGS: {
    // Map your discount codes
  },
  DISCOUNT_FALLBACK_ACCOUNT_ID: '1'
};
```

### In n8n Credentials Panel:
- ✅ QuickBooks OAuth2 API credential created
- ✅ Credential authorized (OAuth flow completed)
- ✅ Correct company selected

---

## 🔍 Troubleshooting

### "Choose connection" prompts in HTTP nodes
**Cause**: OAuth2 credential not authorized
**Solution**: Follow the setup steps above to authorize the credential once

### "Invalid grant" or "Unauthorized" errors
**Cause**: OAuth token expired
**Solution**: Re-authorize the credential in Credentials panel (click the + button → Credentials)

### Invoice tax calculations wrong
**Cause**: `QB_TAX_CODE_ID` not configured
**Solution**: Set the correct Tax Code ID in Item Mappings Config node

### Rate limit errors from QuickBooks
**Cause**: Too many API calls
**Solution**: Wait nodes are already in place; ensure they're not bypassed

---

## 📚 Reference

### QuickBooks API Documentation
- [OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [Customer API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer)
- [Invoice API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice)
- [Credit Memo API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/creditmemo)
- [Payment API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment)

### n8n Credentials
- [QuickBooks OAuth2 Setup](https://docs.n8n.io/integrations/builtin/credentials/quickbooks/)
- [Using Credentials](https://docs.n8n.io/workflows/credentials/)

---

## ✅ Verification Steps

After setting up credentials, test with these steps:

1. **Test Customer Sync**
   - Send a `customer.created` webhook from Lago
   - Check n8n execution log
   - Verify customer created in QuickBooks

2. **Test Invoice Creation**
   - Send an `invoice.created` webhook from Lago
   - Should create customer (if missing) and invoice
   - Verify in QuickBooks

3. **Test Credit Note Creation**
   - Send a `credit_note.created` webhook from Lago
   - Should create customer (if missing) and credit memo
   - Verify in QuickBooks

4. **Test Payment Recording**
   - Send an `invoice.payment_status_updated` webhook
   - Should record payment in QuickBooks

5. **Test Invoice Voiding**
   - Send an `invoice.voided` webhook
   - Should void the invoice in QuickBooks

---

## 🎯 Summary

**What you need to do:**
1. Click the **+** button in n8n's top menu → Select **Credentials**
2. Authorize the QuickBooks OAuth2 credential **once** in n8n Credentials panel
3. Configure the QB_REALM_ID, ITEM IDs, and TAX settings in the workflow nodes
4. Test the workflow with Lago webhooks

**Result:**
- All 14 QuickBooks HTTP nodes will work without prompting for credentials
- Automatic customer creation when processing invoices/credit notes
- Duplicate prevention for invoices and credit memos
- Tax override using Lago's calculated tax amounts
- Rate limiting with built-in Wait nodes

**Key Features:**
- **Tax Override**: Uses `TxnTaxDetail.TotalTax` with `minorversion=70` to apply Lago's exact tax amounts
- **Retry Logic**: All QB API calls have exponential backoff (max 5 retries)
- **Wait Nodes**: 1-second delays prevent rate limit errors
- **Duplicate Prevention**: Lookups before creation prevent duplicate documents
