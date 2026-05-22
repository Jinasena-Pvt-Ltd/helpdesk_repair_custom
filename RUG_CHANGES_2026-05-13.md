# RUG Repair — Investigation & Changes (2026-05-13)

## 1. RUG Account Update Button — Fixed ✅ (2026-05-13)

### What it does
Button **"RR - RUG Account Update in SI"** (server action ID 2176) on customer invoices is intended to replace the income account on RUG repair invoices with the configured RUG account from `x_repair_accounts`.

### Bug
The search that finds the invoice lines to update is wrong:

```python
# BROKEN — journal default account (400000) is never used on invoice lines
lines = env['account.move.line'].search([
    ('move_id', '=', record.id),
    ('account_id', '=', record.journal_id.default_account_id.id)
])
```

- `journal.default_account_id` = account 21 (Product Sales / 400000)
- Actual income lines on invoices use account 1211 (SALES / MI001)
- Search returns **0 lines** → nothing changes
- `x_studio_rug_acc_updated = True` still gets set, masking the failure

### Secondary Issue
The button is clicked on **posted** invoices. Odoo blocks direct writes to `account.move.line` on posted entries.

### Fix Applied (server action 2176 updated directly in DB)

Two changes were made to the server action code:

**1. Fixed line search** — replaced `journal.default_account_id` with an income account type filter:
```python
# BEFORE (broken)
lines = env['account.move.line'].search([
    ('move_id', '=', record.id),
    ('account_id', '=', record.journal_id.default_account_id.id)
])

# AFTER (fixed)
lines = env['account.move.line'].search([
    ('move_id', '=', record.id),
    ('account_id.user_type_id.internal_group', '=', 'income')
])
```

**2. Added draft/re-post handling** for posted invoices:
```python
if record.x_studio_rug_confirmed == True:
    company_id = env.context.get('allowed_company_ids', [env.user.company_id.id])[0]
    company = env['res.company'].browse(company_id)

    rug_account = env['x_repair_accounts'].search([('x_studio_company_id', '=', company.id)], limit=1)
    if not rug_account or not rug_account.x_studio_rug_account:
        raise UserError('RUG Account must be Specified in Repair Accounts')

    lines = env['account.move.line'].search([
        ('move_id', '=', record.id),
        ('account_id.user_type_id.internal_group', '=', 'income')
    ])

    if lines:
        was_posted = record.state == 'posted'
        if was_posted:
            record.button_draft()
        for line in lines:
            line.write({'account_id': rug_account.x_studio_rug_account.id})
        if was_posted:
            record.action_post()

    record.write({'x_studio_rug_acc_updated': True})
```

---

## 2. RUG Cost Price Swap — New Automation Created

### Context
When a repair is classified as RUG (Repair Under Warranty), SO line prices should be replaced with the product's average cost (`standard_price`), and the original sales price saved to `x_studio_price_unit_original`.

### Existing Mechanisms (both had gaps)

| Mechanism | Where | Trigger | Problem |
|---|---|---|---|
| `RR - Sales Price For RUG Items` (automation 193) | `sale.order.line` `on_create` | Filter: state=draft AND rug_confirmed=True | Fails — SO lines are created when state is already 'done'; also `x_studio_rug_confirmed` (a related stored field) may not be True at filter evaluation time |
| `RR - Change Repair Type to RUG` (actions 2159 / 3109) | `helpdesk.ticket` manual button | Clicked when converting a normal repair to RUG | Never fires for tickets **created directly** as RUG type — no conversion step happens |

### Gap Found
Tickets 972 / 973 / 974 (SOs S02048 / S02050 / S02053) were created directly as type "Repair - Under Warranty - RUG". Neither mechanism ran. SO lines retained the sales price (1,650) instead of the cost price (200).

Creation order confirmed:
```
Ticket created → ~1-2 hrs → FSM Task created → ~5 min → SO + Lines created
```

### Fix Applied — New Automation (ID: 393)

**Name:** `RR - Auto Swap Price to Cost on RUG SO Creation`  
**Server Action ID:** 3121  
**Base Automation ID:** 393  
**Model:** `sale.order`  
**Trigger:** `on_create`  
**Filter:** `x_studio_rug_confirmed = True AND x_studio_quotation_type = Repair`

```python
if record.x_studio_rug_confirmed == True and record.x_studio_quotation_type == 'Repair':
    for line in record.order_line:
        if not line.x_studio_price_unit_original:
            original_price = line.price_unit
            cost_price = line.product_id.standard_price
            line.write({
                'price_unit': cost_price,
                'x_studio_price_unit_original': original_price,
            })
```

**Why `on_create` on `sale.order` (not on the line):**
- At SO `on_create`, all lines already exist and are accessible via `record.order_line`
- The SO's own `x_studio_rug_confirmed` is definitely set at this point
- Avoids timing issues with related stored fields on individual lines
- SO is created 1–2 hours after the ticket, so hooking on ticket creation is too early

**Guard:** `if not line.x_studio_price_unit_original` prevents double-swapping if the button was also clicked manually.

---

## Existing Records Reference

| Name | Type | ID | Model |
|---|---|---|---|
| RR - RUG Account Update in SI | Server Action | 2176 | account.move |
| RR - Validate RUG in Customer Invoice | Server Action | 2331 | account.move |
| RR - Sales Price For RUG Items | Automation | 193 | sale.order.line |
| RR - Change Repair Type to RUG | Server Action | 2159 / 3109 | helpdesk.ticket |
| RR - Auto Swap Price to Cost on RUG SO Creation | Automation | **393** ✅ | sale.order |
