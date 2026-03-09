# Item and Tax Mapping Configuration Guide

A practical guide for configuring and managing Lago-to-QuickBooks item and tax mappings at scale.

---

## Table of Contents

1. [Overview](#overview)
2. [Item Mapping Configuration](#item-mapping-configuration)
3. [Tax Mapping Configuration](#tax-mapping-configuration)
4. [Scaling Strategies](#scaling-strategies)
5. [Best Practices](#best-practices)
6. [Common Scenarios](#common-scenarios)
7. [Maintenance and Updates](#maintenance-and-updates)
8. [Troubleshooting](#troubleshooting)

---

## Overview

### Why Mapping Matters

The integration uses mapping configurations to translate Lago's billing codes to QuickBooks entities:

- **Item Mappings**: Map Lago item codes (e.g., `premium_plan`, `api_calls`) to QuickBooks Item IDs
- **Tax Mappings**: Configure tax code for accurate tax override
- **Discount Mappings**: Map discount codes to QuickBooks discount accounts (future use)

### Where Configuration Lives

All mappings are configured in the **Item Mappings Config** node in the n8n workflow:

```javascript
const MAPPINGS = {
  ITEM_MAPPINGS: { /* ... */ },
  QB_TAX_CODE_ID: '',
  DISCOUNT_MAPPINGS: { /* ... */ },
  // Fallbacks
  ITEM_FALLBACK_ID: '1',
  DISCOUNT_FALLBACK_ACCOUNT_ID: '1'
};
```

---

## Item Mapping Configuration

### Understanding Item Mapping

**What Gets Mapped:**
- Lago: `fee.item.code` (e.g., `"premium_plan"`, `"api_calls"`)
- QuickBooks: Item ID (e.g., `"5"`, `"12"`)

**Where It's Used:**
- Invoice line items
- Credit note line items

### Step 1: Identify Your QuickBooks Items

First, you need to find your QuickBooks Item IDs.

#### Method 1: QuickBooks API Explorer

1. Go to [QuickBooks API Explorer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/item)
2. Select your company
3. Run this query:

```sql
SELECT Id, Name, Type, Description FROM Item WHERE Active = true
```

**Example Result:**
```json
{
  "QueryResponse": {
    "Item": [
      { "Id": "1", "Name": "Services", "Type": "Service" },
      { "Id": "5", "Name": "Consulting Hours", "Type": "Service" },
      { "Id": "12", "Name": "API Usage", "Type": "Service" },
      { "Id": "23", "Name": "Storage", "Type": "Service" }
    ]
  }
}
```

#### Method 2: QuickBooks UI

1. Go to **Settings** → **Products and Services**
2. Click on each item
3. Look at the URL: `https://qbo.intuit.com/app/item?id=5` — the ID is `5`

### Step 2: List Your Lago Item Codes

Identify all item codes used in your Lago billing:

**Example Lago Items:**
- `startup_plan`
- `premium_plan`
- `enterprise_plan`
- `api_calls`
- `storage_gb`
- `bandwidth_gb`
- `support_hours`

### Step 3: Create the Mapping

Edit the **Item Mappings Config** node in n8n:

```javascript
const MAPPINGS = {
  ITEM_MAPPINGS: {
    // Subscription Plans
    'startup_plan': '5',        // Maps to "Consulting Hours"
    'premium_plan': '12',       // Maps to "API Usage"
    'enterprise_plan': '23',    // Maps to "Storage"

    // Usage-Based Charges
    'api_calls': '12',          // Maps to "API Usage"
    'storage_gb': '23',         // Maps to "Storage"
    'bandwidth_gb': '23',       // Maps to "Storage"
    'support_hours': '5',       // Maps to "Consulting Hours"
  },
  ITEM_FALLBACK_ID: '1',        // "Services" - used for unmapped items

  // ... other mappings
};
```

### Step 4: Configure Fallback

The `ITEM_FALLBACK_ID` is used when:
- An item code doesn't have a mapping
- An item code is `null` or missing

**Best Practice:** Set this to a generic "Services" or "Other" item in QuickBooks.

```javascript
ITEM_FALLBACK_ID: '1',  // ID of your generic "Services" item
```

### Example Scenarios

#### Scenario 1: Many Items Map to One QB Item

If you have multiple Lago items that should all appear as "Services" in QB:

```javascript
ITEM_MAPPINGS: {
  'basic_plan': '1',
  'pro_plan': '1',
  'enterprise_plan': '1',
  'api_usage': '1',
  'data_storage': '1',
},
ITEM_FALLBACK_ID: '1',
```

**Result:** Everything appears as the same item in QuickBooks. Good for simple accounting.

#### Scenario 2: Separate Items for Revenue Tracking

If you need to track revenue by product line:

```javascript
ITEM_MAPPINGS: {
  // SaaS Subscriptions → "SaaS Revenue" item
  'basic_plan': '10',
  'pro_plan': '10',
  'enterprise_plan': '10',

  // Usage Charges → "Usage Revenue" item
  'api_calls': '20',
  'storage_gb': '20',
  'bandwidth_gb': '20',

  // Professional Services → "Services Revenue" item
  'onboarding_fee': '30',
  'support_hours': '30',
},
ITEM_FALLBACK_ID: '10',  // Default to SaaS Revenue
```

**Result:** Revenue is categorized by product type in QuickBooks reports.

#### Scenario 3: Detailed Item Tracking

If you want one-to-one mapping for detailed tracking:

```javascript
ITEM_MAPPINGS: {
  'basic_plan': '101',          // "Basic Plan" item
  'pro_plan': '102',            // "Pro Plan" item
  'enterprise_plan': '103',     // "Enterprise Plan" item
  'api_calls': '201',           // "API Calls" item
  'storage_gb': '202',          // "Storage" item
  'bandwidth_gb': '203',        // "Bandwidth" item
  'support_hours': '301',       // "Support Hours" item
},
ITEM_FALLBACK_ID: '1',          // "Other Services"
```

**Result:** Maximum granularity in QuickBooks for revenue analysis.

---

## Tax Mapping Configuration

### Understanding Tax Override

The workflow uses Lago's calculated tax amounts instead of QuickBooks' automatic tax calculations. This ensures exact tax amounts from Lago appear in QuickBooks.

### How It Works

1. **Line-Level**: Each line item is marked as `TAX` (taxable) or `NON` (non-taxable)
2. **Transaction-Level**: The exact tax amount from Lago is set via `TxnTaxDetail.TotalTax`
3. **Tax Code Reference**: The transaction references a QB Tax Code via `QB_TAX_CODE_ID`

### Step 1: Find Your QuickBooks Tax Code ID

#### Method 1: API Explorer

Run this query in QuickBooks API Explorer:

```sql
SELECT * FROM TaxCode WHERE Active = true
```

**Example Result:**
```json
{
  "QueryResponse": {
    "TaxCode": [
      { "Id": "2", "Name": "TAX", "TaxCodeDescription": "Taxable" },
      { "Id": "3", "Name": "NON", "TaxCodeDescription": "Non-Taxable" },
      { "Id": "4", "Name": "Sales Tax", "TaxCodeDescription": "Sales Tax" }
    ]
  }
}
```

**Which ID to use?**
- Use the ID of a **taxable** tax code (often "TAX" or "Sales Tax")
- Common values: `"2"` or `"4"`
- **Do NOT use "NON"** (non-taxable code)

#### Method 2: QuickBooks Sandbox Test

If unsure, test with different IDs:

```javascript
QB_TAX_CODE_ID: '2',  // Try this first
```

Create a test invoice in Lago and check if tax appears correctly in QuickBooks.

### Step 2: Configure Tax Code ID

Edit the **Item Mappings Config** node:

```javascript
const MAPPINGS = {
  // ... item mappings ...

  QB_TAX_CODE_ID: '2',  // Your Tax Code ID

  // ... other mappings ...
};
```

### Step 3: Verify Tax Override Behavior

**Expected Behavior:**
1. Send Lago invoice with tax (e.g., $100 + $25 tax = $125 total)
2. Check QuickBooks invoice:
   - Line items: $100 (marked as TAX)
   - Tax line: Exactly $25 (from Lago, not QB calculation)
   - Total: $125

**If tax doesn't match:**
- Verify `QB_TAX_CODE_ID` is set and correct
- Check that invoice creation uses `?minorversion=70` (already configured in workflow)
- Ensure the Tax Code ID is for a taxable code, not "NON"

### Tax Scenarios

#### Scenario 1: Single Tax Rate (e.g., US Sales Tax)

```javascript
QB_TAX_CODE_ID: '2',  // Single "Sales Tax" code
```

All taxable items use this code. Lago calculates the exact tax amount.

#### Scenario 2: VAT (Multiple Rates)

If you have multiple VAT rates in Lago (e.g., standard 20%, reduced 5%):

```javascript
QB_TAX_CODE_ID: '2',  // Standard VAT code in QB
```

**Important:** The workflow currently uses a **single QB tax code** for all transactions. The exact tax amount from Lago is applied, so different rates are handled correctly by the amount, not by different tax codes.

**Advanced (Future Enhancement):** You could modify the workflow to map Lago tax codes to different QB tax codes:

```javascript
// Future: Map Lago tax codes to QB tax code IDs
TAX_CODE_MAPPINGS: {
  'vat_standard_20': '2',
  'vat_reduced_5': '3',
  'vat_zero': '4',
}
```

This would require modifying the `Transform Invoice` and `Transform Credit Note` nodes.

#### Scenario 3: No Tax / Tax-Exempt

If you don't charge tax:

```javascript
QB_TAX_CODE_ID: '',  // Leave empty
```

Line items will still be marked as `TAX` or `NON` based on Lago data, but no transaction-level tax override will be applied.

---

## Scaling Strategies

### Managing Large Item Catalogs

If you have 50+ item codes:

#### Strategy 1: Grouped Mapping

Group similar items to reduce complexity:

```javascript
ITEM_MAPPINGS: {
  // All subscription tiers → "Subscription Revenue" (ID: 10)
  'tier_1': '10',
  'tier_2': '10',
  'tier_3': '10',
  // ... 20 more tiers ...

  // All usage charges → "Usage Revenue" (ID: 20)
  'api_calls': '20',
  'requests': '20',
  'compute_hours': '20',
  // ... 30 more usage types ...
},
```

**Pros:**
- ✅ Simpler to maintain
- ✅ Cleaner QuickBooks reports (consolidated by category)

**Cons:**
- ❌ Less granular revenue tracking

#### Strategy 2: External Mapping File

For very large mappings (100+ items), maintain mappings externally:

**1. Create a JSON file** (`item-mappings.json`):

```json
{
  "startup_plan": "5",
  "premium_plan": "12",
  "enterprise_plan": "23",
  "api_calls_small": "20",
  "api_calls_medium": "20",
  "api_calls_large": "20",
  ... 94 more items ...
}
```

**2. Load it in the workflow:**

Modify the **Item Mappings Config** node:

```javascript
// Option A: Paste the entire mapping object
const MAPPINGS = {
  ITEM_MAPPINGS: {
    "startup_plan": "5",
    "premium_plan": "12",
    // ... paste all mappings ...
  },
  ITEM_FALLBACK_ID: '1',
};
```

Or use n8n's environment variables (n8n Cloud/Self-hosted):

```javascript
// Option B: Use environment variable
const itemMappingsJson = $env.ITEM_MAPPINGS_JSON || '{}';
const MAPPINGS = {
  ITEM_MAPPINGS: JSON.parse(itemMappingsJson),
  ITEM_FALLBACK_ID: '1',
};
```

Then set `ITEM_MAPPINGS_JSON` environment variable with the JSON string.

#### Strategy 3: Dynamic Mapping via Database

For enterprise scale (1000+ items), use n8n's database nodes:

**1. Store mappings in a database:**

| lago_item_code | qb_item_id | category |
|----------------|------------|----------|
| startup_plan | 5 | subscription |
| api_calls | 12 | usage |
| ... | ... | ... |

**2. Add a database lookup node** before "Map Lago Items to QB":
- Input: Lago item codes from fees
- Query: `SELECT qb_item_id FROM item_mappings WHERE lago_item_code = ?`
- Output: Mapped QB IDs

**3. Modify mapping logic** to use database results

**Pros:**
- ✅ Scalable to unlimited items
- ✅ Easy to update without modifying workflow
- ✅ Can manage via UI/admin panel

**Cons:**
- ❌ Requires external database setup
- ❌ Adds latency to workflow
- ❌ More complex architecture

### Handling New Items

When you add new items in Lago:

#### Option 1: Let Fallback Handle It

```javascript
ITEM_FALLBACK_ID: '1',  // Generic "Services" item
```

New Lago items automatically use the fallback item in QB. Review execution logs periodically to find unmapped items.

#### Option 2: Proactive Monitoring

Add logging in the **Map Lago Items to QB** node:

```javascript
// After mapping
const unmappedItems = [];
mappedLines.forEach(line => {
  if (line._lagoItemCode && !MAPPINGS.ITEM_MAPPINGS[line._lagoItemCode]) {
    unmappedItems.push(line._lagoItemCode);
  }
});

if (unmappedItems.length > 0) {
  console.warn('Unmapped items found:', unmappedItems);
}
```

Set up n8n error workflow to alert when unmapped items are detected.

---

## Best Practices

### 1. Use Consistent Naming

Keep item codes consistent between Lago and QuickBooks:

**Good:**
```javascript
// Lago: "premium_plan"  →  QB Item Name: "Premium Plan"
'premium_plan': '12',
```

**Confusing:**
```javascript
// Lago: "premium_plan"  →  QB Item Name: "Gold Subscription"
'premium_plan': '99',
```

### 2. Document Your Mappings

Add comments in the config:

```javascript
ITEM_MAPPINGS: {
  // Subscription Plans (QB Category: Recurring Revenue)
  'basic_monthly': '10',      // $29/month plan
  'pro_monthly': '11',        // $99/month plan
  'enterprise': '12',         // Custom pricing

  // Usage Charges (QB Category: Variable Revenue)
  'api_calls': '20',          // Per 1000 calls
  'storage_gb': '21',         // Per GB/month
},
```

### 3. Set Sensible Fallbacks

Choose a fallback that makes sense for most of your items:

```javascript
// If most items are services:
ITEM_FALLBACK_ID: '1',  // "Services"

// If most items are products:
ITEM_FALLBACK_ID: '50',  // "General Products"
```

### 4. Test Before Production

Always test mappings in QuickBooks Sandbox:

```javascript
QB_ENVIRONMENT: 'sandbox',  // Test here first
```

1. Create test invoices with all item types
2. Verify correct QB items are used
3. Check revenue categorization in QB reports
4. Then switch to production:

```javascript
QB_ENVIRONMENT: 'production',
```

### 5. Version Control Your Mappings

Keep a history of mapping changes:

```javascript
/*
 * Item Mappings - Version History
 *
 * v1.0 (2024-01-15): Initial mappings
 * v1.1 (2024-02-01): Added new premium tiers
 * v1.2 (2024-03-15): Consolidated usage items to single QB item
 */
const MAPPINGS = {
  // ...
};
```

---

## Common Scenarios

### Scenario: SaaS Company with Usage-Based Billing

**Lago Setup:**
- 3 subscription tiers: `basic`, `pro`, `enterprise`
- Usage charges: `api_calls`, `storage_gb`, `seats`
- One-time: `onboarding_fee`

**QuickBooks Setup:**
- Item 10: "Subscription Revenue"
- Item 20: "Usage Revenue"
- Item 30: "Professional Services"

**Mapping:**

```javascript
ITEM_MAPPINGS: {
  // All subscriptions → Subscription Revenue
  'basic': '10',
  'pro': '10',
  'enterprise': '10',

  // All usage → Usage Revenue
  'api_calls': '20',
  'storage_gb': '20',
  'seats': '20',

  // Services → Professional Services
  'onboarding_fee': '30',
},
ITEM_FALLBACK_ID: '10',  // Default to Subscription Revenue

QB_TAX_CODE_ID: '2',  // Sales tax applies to all
```

### Scenario: Multi-Region with Different Tax Rates

**Lago Setup:**
- Items: `hosting_us`, `hosting_eu`, `hosting_apac`
- Lago calculates region-specific tax

**QuickBooks Setup:**
- Item 10: "Cloud Hosting"
- Tax Code 2: "Sales Tax" (for exact amount override)

**Mapping:**

```javascript
ITEM_MAPPINGS: {
  'hosting_us': '10',    // Same QB item for all regions
  'hosting_eu': '10',
  'hosting_apac': '10',
},
ITEM_FALLBACK_ID: '10',

QB_TAX_CODE_ID: '2',     // Single tax code, exact amounts from Lago
```

**Why this works:** The tax amount comes from Lago's calculation, not QB's tax rate. Different regional rates are handled by Lago, QB just displays the exact amount.

### Scenario: Marketplace with Multiple Vendors

**Lago Setup:**
- Item codes include vendor: `vendor1_service_a`, `vendor2_service_b`
- 100+ vendors, 500+ item codes

**QuickBooks Setup:**
- Item 10: "Marketplace Sales - Vendor A"
- Item 11: "Marketplace Sales - Vendor B"
- Item 12: "Marketplace Sales - Other"

**Mapping Strategy:**

Option 1: Map by vendor prefix:

```javascript
// Group by vendor
ITEM_MAPPINGS: {
  'vendor1_service_a': '10',
  'vendor1_service_b': '10',
  'vendor1_service_c': '10',

  'vendor2_service_a': '11',
  'vendor2_service_b': '11',

  // ... etc
},
ITEM_FALLBACK_ID: '12',  // "Other"
```

Option 2: Use fallback for all, consolidate:

```javascript
ITEM_MAPPINGS: {},  // Empty - use fallback for everything
ITEM_FALLBACK_ID: '15',  // "Marketplace Sales - All"
```

---

## Maintenance and Updates

### Adding New Items

**Workflow:**

1. **Create item in Lago** (e.g., new plan `pro_plus`)
2. **Decide QB mapping:**
   - Reuse existing QB item? → Map to existing ID
   - Create new QB item? → Create in QB first, get ID
3. **Update mapping** in n8n:

```javascript
ITEM_MAPPINGS: {
  // ... existing mappings ...
  'pro_plus': '13',  // New mapping
},
```

4. **Test** with a test invoice
5. **Deploy** to production

### Updating Existing Mappings

**Example:** Change `premium_plan` from QB Item 12 to QB Item 15

**Steps:**

1. **Update mapping:**

```javascript
ITEM_MAPPINGS: {
  'premium_plan': '15',  // Changed from '12'
},
```

2. **Important:** This affects **new** invoices only. Historical invoices in QB remain unchanged.

3. **Test** to ensure new invoices use the correct item.

### Bulk Updates

For large-scale changes:

1. **Export current mapping** from n8n workflow
2. **Edit in spreadsheet** or text editor
3. **Generate new mapping object**
4. **Paste back** into workflow
5. **Test thoroughly** before deploying

---

## Troubleshooting

### Issue: Items Not Mapping Correctly

**Symptoms:** QB invoice shows wrong item or "Services" for all items

**Debug Steps:**

1. **Check Lago item code:**
   - View n8n execution log
   - Find the `Transform Invoice` node output
   - Look for `fee.item.code` value

2. **Verify mapping exists:**
   ```javascript
   ITEM_MAPPINGS: {
     'premium_plan': '12',  // Does this match Lago code exactly?
   }
   ```

3. **Check case sensitivity:**
   - Lago code: `premium_plan`
   - Mapping: `Premium_Plan` ❌ (doesn't match)

4. **Verify QB Item ID:**
   - Run `SELECT Id, Name FROM Item WHERE Id = '12'`
   - Ensure the item exists and is active

### Issue: Tax Amount Wrong in QuickBooks

**Symptoms:** Tax amount doesn't match Lago

**Debug Steps:**

1. **Check if `QB_TAX_CODE_ID` is configured:**
   ```javascript
   QB_TAX_CODE_ID: '',  // ❌ Empty - tax override won't work
   QB_TAX_CODE_ID: '2', // ✅ Configured
   ```

2. **Verify Tax Code ID is correct:**
   - Run `SELECT * FROM TaxCode WHERE Id = '2'`
   - Ensure it exists and is active

3. **Check API call uses minorversion=70:**
   - View n8n execution log for "Create Invoice in QB" node
   - URL should include `?minorversion=70`
   - This is already configured in the workflow

4. **Check Lago tax calculation:**
   - View `Transform Invoice` node output
   - Look for `TxnTaxDetail.TotalTax` value
   - Compare to Lago invoice `taxes_amount_cents / 100`

### Issue: Fallback Used Too Often

**Symptoms:** Most items use fallback instead of specific mappings

**Common Causes:**

1. **Typo in item codes:**
   ```javascript
   // Mapping
   'premium_plan': '12',

   // Lago sends
   'premium-plan'  // ❌ Dash instead of underscore
   ```

2. **New items not mapped yet:**
   - Review execution logs for unmapped codes
   - Add mappings for frequently seen codes

3. **Missing mappings:**
   - Audit your Lago items vs. mappings
   - Ensure all active items are mapped

---

## Summary Checklist

Before going to production:

- [ ] All QuickBooks Items created and IDs documented
- [ ] All active Lago item codes mapped or intentionally using fallback
- [ ] Fallback item configured and appropriate
- [ ] Tax Code ID configured (if using tax)
- [ ] Tax Code ID tested and verified
- [ ] Tested in QuickBooks Sandbox environment
- [ ] Reviewed QB reports to ensure revenue categorization is correct
- [ ] Documented mapping logic and version
- [ ] Set up monitoring for unmapped items
- [ ] Created process for adding new items

---

## Quick Reference

### Minimal Configuration

```javascript
const MAPPINGS = {
  ITEM_MAPPINGS: {},              // Empty - use fallback for all
  ITEM_FALLBACK_ID: '1',          // QB "Services" item
  QB_TAX_CODE_ID: '',             // No tax override
  DISCOUNT_MAPPINGS: {},
  DISCOUNT_FALLBACK_ACCOUNT_ID: '1'
};
```

### Typical SaaS Configuration

```javascript
const MAPPINGS = {
  ITEM_MAPPINGS: {
    'subscription': '10',         // Subscription Revenue
    'usage': '20',                // Usage Revenue
    'services': '30',             // Professional Services
  },
  ITEM_FALLBACK_ID: '10',         // Default to Subscription
  QB_TAX_CODE_ID: '2',            // Sales Tax
  DISCOUNT_MAPPINGS: {},
  DISCOUNT_FALLBACK_ACCOUNT_ID: '1'
};
```

### Enterprise Configuration

```javascript
const MAPPINGS = {
  ITEM_MAPPINGS: {
    // 50+ specific mappings for detailed tracking
    'plan_tier1': '101',
    'plan_tier2': '102',
    // ... etc
  },
  ITEM_FALLBACK_ID: '1',
  QB_TAX_CODE_ID: '2',
  DISCOUNT_MAPPINGS: {
    'early_bird': '201',
    'loyalty': '202',
  },
  DISCOUNT_FALLBACK_ACCOUNT_ID: '200'
};
```

---

For general data mapping reference, see [MAPPING.md](MAPPING.md).

For setup instructions, see [SETUP-GUIDE.md](SETUP-GUIDE.md).
