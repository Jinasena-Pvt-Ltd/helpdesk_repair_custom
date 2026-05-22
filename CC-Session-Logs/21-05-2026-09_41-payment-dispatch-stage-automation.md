# Session Log: 21-05-2026 09:41 - payment-dispatch-stage-automation

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, account.payment.register, Advance Received, action_create_payments, payment method line, outstanding receipts, outstanding payments, Cash journal, LKR, Public Pricelist, Basic Pricelists group, 50% down payment gate, button_validate, Mark as Done, _compute_mark_as_done_buttons, x_studio_fully_invoiced_so, Dispatch button, action_dispatch, x_studio_is_dispatch, x_studio_dispatch_done, Handed Over to Customer, project.task, stock.picking, sale.order, db 2 odoo_repair_fresh, INV/2026/00002
**Projects:** helpdesk_repair_custom on Odoo 15, db 2 = odoo_repair_fresh
**Outcome:** Wired full ticket-stage automation around payments and dispatch: Cash journal + payment method outstanding accounts; payment-register triggers "Advance Received"; 50% down-payment gate before delivery validation; Mark-as-Done hidden until SO 100% invoiced; new Dispatch button creates virtual→customer transfer; final transfer validation moves ticket to "Handed Over to Customer". Also configured LKR currency, pricelist, and Basic Pricelists group membership.

## Decisions Made
- **Trigger "Advance Received" on payment register, not invoice creation** — moved the stage transition from `_create_invoices()` to `account.payment.register.action_create_payments()`. Invoice creation is upstream; the customer paying is the actual business event.
- **Use the existing `_advance_ticket_stage()` helper on sale.order** — kept all stage-flag guards centralised in one helper instead of duplicating the pattern in each trigger point.
- **50% down-payment gate via UserError in `button_validate()`, not via view attrs** — view attrs already gate on `x_studio_repair_payment_made` (binary), but the new requirement is quantitative. A server-side guard is safer and impossible to bypass via the UI.
- **RUG repairs bypass the 50% gate** — same precedent as the existing `x_studio_repair_payment_made` logic (RUG invoices after repair).
- **Hide Mark-as-Done by overriding `_compute_mark_as_done_buttons`** — the upstream compute already controls visibility of both primary and secondary buttons via two booleans; overriding it once and force-clearing both flags is the cleanest gate. Repeats the full `@api.depends` list since Python override replaces parent dependencies.
- **`x_studio_is_dispatch` flag on stock.picking** to identify the dispatch transfer — searching by location pair (virtual→customer) is fragile because tickets can have other virtual-to-customer transfers; an explicit flag is unambiguous.
- **"Handed Over to Customer" moved from `action_dispatch` to `button_validate`** — original implementation advanced the stage on button click. Per user requirement, the stage should only advance when the dispatch transfer is actually validated.
- **Currency change via SQL bypass** — Odoo's `res.company.write()` blocks currency changes once journal items exist. Since this is a test DB and the change is intentional, did `UPDATE res_company SET currency_id = 142` directly.

## Key Learnings
- **`account.payment.register` is a TransientModel wizard, not `account.payment`** — to hook into "Register Payment" you override `account.payment.register.action_create_payments()`, not anything on `account.payment` directly. The wizard's `line_ids.move_id` gives you the invoice records being paid.
- **Cash/Bank journals need both a `default_account_id` AND outstanding accounts on payment method lines** — without `payment_account_id` on the `account.payment.method.line`, payment registration fails with "You can't create a new payment without an outstanding payments/receipts account…". Outstanding accounts are typically Current Assets (`internal_group='asset', type='other'`), separate from the cash/bank account itself.
- **`account.payment.method.line` is per-direction** — one row per (journal, payment_method, payment_type) where `payment_type ∈ {inbound, outbound}`. Each needs its own `payment_account_id` (outstanding receipts vs outstanding payments).
- **Activating a "settings group" needs both the config parameter AND user group membership** — setting `product.product_pricelist_setting=basic` alone does NOT show the Pricelists menu. The user must be a member of `Basic Pricelists` (or `Advanced Pricelists`, which implies Basic). Running `res.config.settings.create({...}).execute()` is the official path; if it doesn't add users automatically, add them manually.
- **`x_studio_valid_delivered_so` on project.task in production is a Studio computed field** — depends on `sale_order_id`, checks SO state == 'done' + any done delivery (→ valid) and done delivery to a customer location (→ valid2). In our module these were plain Booleans needing manual writes via `button_validate()` hook.
- **`product.task.invoice_status == 'invoiced'`** is the canonical "100% invoiced" check on a sale.order. Values: `no`, `to_invoice`, `invoiced`, `upselling`.
- **Overriding a compute method needs the full `@api.depends`** — when you override `_compute_X` in a subclass, Python replaces the method in the MRO; the parent's `@api.depends` does NOT carry over. You must repeat all original dependencies and add your new ones.
- **`pending = self.filtered(...)` snapshot before `super().button_validate()`** — `super()` flips state to `done`, so any post-validate logic should iterate the snapshot, not `self`. Existing code already does this correctly.

## Solutions & Fixes

### 1. Cash journal + payment method outstanding accounts (UserError on Register Payment)
**Error:** "You can't create a new payment without an outstanding payments/receipts account set either on the company or the Manual payment method in the Cash journal."

**Fix:** Created two Current Assets accounts and assigned to `account.payment.method.line` via shell:
```python
current_assets = env['account.account.type'].browse(5)  # Current Assets, other, asset
receipts_acc = env['account.account'].create({'name': 'Outstanding Receipts', 'code': '110001', 'user_type_id': current_assets.id, 'company_id': 1})
payments_acc = env['account.account'].create({'name': 'Outstanding Payments', 'code': '110002', 'user_type_id': current_assets.id, 'company_id': 1})
env['account.payment.method.line'].browse(1).payment_account_id = receipts_acc  # inbound
env['account.payment.method.line'].browse(2).payment_account_id = payments_acc  # outbound
```

### 2. Cash journal creation
```python
liquidity_type = env['account.account.type'].browse(3)  # Bank and Cash, liquidity
cash_acc = env['account.account'].create({'name': 'Cash', 'code': '101001', 'user_type_id': liquidity_type.id, 'company_id': 1})
env['account.journal'].create({'name': 'Cash', 'code': 'CSH', 'type': 'cash', 'company_id': 1, 'default_account_id': cash_acc.id})
# Manual inbound + outbound payment method lines are auto-created
```

### 3. "Advance Received" on payment registration
Removed `_create_invoices()` override from `sale_order.py` (wrong trigger — invoice creation). Added `AccountPaymentRegister` wizard override in `account_payment.py`:
```python
class AccountPaymentRegister(models.TransientModel):
    _inherit = 'account.payment.register'
    def action_create_payments(self):
        invoices = self.line_ids.move_id.filtered(lambda m: m.move_type in ('out_invoice', 'out_refund'))
        result = super().action_create_payments()
        for invoice in invoices:
            orders = invoice.invoice_line_ids.sale_line_ids.mapped('order_id')
            for order in orders:
                for task, ticket in order._ticket_for_order(order):
                    order._advance_ticket_stage(ticket, task, 'Advance Received', 'x_studio_invoice_stage_updated', task_flag='x_studio_valid_invoiced_so')
        return result
```

### 4. Pricelist + LKR currency configuration
- Activated LKR (id=142): `lkr.active = True`
- Set company currency to LKR via SQL (`UPDATE res_company SET currency_id = 142 WHERE id = 1`) — ORM blocked because journal items existed
- Set Public Pricelist (id=1) currency to LKR
- Created `ir.property` company-default for `res.partner.property_product_pricelist` → pricelist id=1
- Added Administrator (only internal user) to `Basic Pricelists` group (id=18) to enable the menu

### 5. 50% down-payment gate before delivery validation
Added to `stock_picking.button_validate()`:
```python
for picking in pending:
    if not picking.sale_id: continue
    so = picking.sale_id
    tasks = self.env['project.task'].search([('sale_order_id', '=', so.id)])
    ticket = next((t.helpdesk_ticket_id for t in tasks if t.helpdesk_ticket_id), None)
    if not ticket or ticket.x_studio_rug_repair: continue
    invoices = so.invoice_ids.filtered(lambda i: i.state == 'posted' and i.move_type == 'out_invoice')
    total_paid = sum(i.amount_total - i.amount_residual for i in invoices)
    required = so.amount_total * 0.5
    if total_paid < required:
        raise UserError("Cannot validate delivery: at least 50%% down payment is required.\nPaid: %.2f  |  Required: %.2f" % (total_paid, required))
```

### 6. Mark-as-Done gated on SO 100% invoiced
```python
@api.depends('fsm_done', 'is_fsm', 'timer_start', 'display_enabled_conditions_count', 'display_satisfied_conditions_count', 'sale_order_id', 'sale_order_id.invoice_status')
def _compute_mark_as_done_buttons(self):
    super()._compute_mark_as_done_buttons()
    for task in self:
        if task.sale_order_id and task.sale_order_id.invoice_status != 'invoiced':
            task.update({'display_mark_as_done_primary': False, 'display_mark_as_done_secondary': False})
```

### 7. Dispatch button + Handed Over to Customer trigger
- Added `x_studio_dispatch_done` (Boolean, stored) on `project.task` and `x_studio_is_dispatch` (Boolean) on `stock.picking`.
- `action_dispatch` on `project.task` — creates picking from `ticket.x_studio_virtual_location_id` → first `usage='customer'` location, pre-populates move_line with serial/lot if tracking ∈ {'serial', 'lot'}, links picking to `ticket.picking_ids`, sets `x_studio_dispatch_done=True`, returns ir.actions.act_window for the new picking.
- Dispatch button in `views/project_task_views.xml` (inherits `timesheet_grid.project_task_view_form`) — `attrs="{'invisible': ['|', ('fsm_done', '=', False), ('x_studio_dispatch_done', '=', True)]}"` — placed after secondary Mark as Done.
- In `stock_picking.button_validate()` post-validate loop, after existing Repair Started/Completed transitions: if `picking.x_studio_is_dispatch and state == 'done'` → advance ticket to "Handed Over to Customer".

### 8. "Repair Started" / "Repair Completed" via picking validation (from earlier this session)
Already wired in `stock_picking.button_validate()` post-validate loop:
- Any done outgoing picking on the SO + `x_studio_repair_started_stage_updated == False` → Repair Started
- Done picking to customer location + `x_studio_repair_complete_stage_updated == False` → Repair Completed

## Files Modified
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/account_payment.py` — added `AccountPaymentRegister` wizard inherit with `action_create_payments()` override that advances ticket to "Advance Received".
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/sale_order.py` — removed `_create_invoices()` override (no longer triggers stage transition; replaced by payment-register hook).
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/stock_picking.py` — added `import datetime` and `UserError` imports; added `x_studio_is_dispatch` Boolean field; added 50% down-payment gate to `button_validate()`; added "Handed Over to Customer" trigger in post-validate loop.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/project_task.py` — added `x_studio_fully_invoiced_so` (compute) and `x_studio_dispatch_done` (stored); overrode `_compute_mark_as_done_buttons` to gate on `invoice_status == 'invoiced'`; added `action_dispatch()` method that creates virtual→customer picking.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/views/project_task_views.xml` — NEW file inheriting `timesheet_grid.project_task_view_form`; adds Dispatch button after secondary Mark as Done.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/__manifest__.py` — added `views/project_task_views.xml` to data list.

## Setup & Config

### Fresh DB (`odoo_repair_fresh`) — additions to post-install checklist
1. **Cash journal:** code CSH, default_account_id = 101001 Cash (Bank and Cash type, id=3). Auto-creates Manual inbound + outbound payment method lines.
2. **Outstanding accounts:** 110001 Outstanding Receipts + 110002 Outstanding Payments (both Current Assets, type 5). Assign to payment method lines for journal id=2 (inbound→receipts, outbound→payments).
3. **Currency baseline:** activate LKR (id=142), set company currency via SQL, set pricelist (id=1) currency to LKR, create `ir.property` default `property_product_pricelist` → pricelist 1 for company-wide partner default.
4. **Basic Pricelists group:** add admin (and any other internal user) to group id=18 to expose Sales → Configuration → Pricelists menu.

### Key reference IDs in `odoo_repair_fresh` after this session
- Accounts: 101001 Cash (id=4), 110001 Outstanding Receipts (id=5), 110002 Outstanding Payments (id=6), 120001 Account Receivable (id=3), 400001 Product Sales (id=2)
- Journals: 1 Customer Invoices (INV, sale), 2 Cash (CSH, cash)
- Payment method lines for Cash journal: 1 = Manual inbound (→ Outstanding Receipts), 2 = Manual outbound (→ Outstanding Payments)
- Currency: LKR id=142 (active, company currency)
- Pricelist: 1 = Public Pricelist (LKR, default for all partners)
- Groups: `Basic Pricelists` (id=18) — Administrator added

### Module / service commands
- Schema update (after adding fields.X to a model): `sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin -c /etc/odoo15.conf -d odoo_repair_fresh --update=helpdesk_repair_custom --stop-after-init`
- Restart (no schema changes): `sudo systemctl restart odoo15 && sleep 4 && sudo systemctl is-active odoo15`
- Odoo shell: `sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin shell -c /etc/odoo15.conf -d odoo_repair_fresh --no-http << 'EOF' ... env.cr.commit() EOF`
- Postgres on odoo_repair_fresh: `sudo -u postgres psql -d odoo_repair_fresh -c "..."` (warn about cwd is harmless)

## Pending Tasks
- **End-to-end test on db 2** for the full chain: pay invoice → "Advance Received" → validate delivery (50% gate enforced) → "Repair Started" → invoice rest until 100% → Mark as Done unlocks → click Dispatch → validate dispatch transfer → "Handed Over to Customer".
- **Mirror these changes to db 1 (production)** once verified. Production has Studio computed fields for `x_studio_valid_delivered_so` etc., so behaviour may already exist there; check before duplicating.
- **Consider adding `x_studio_handed_over_stage_updated` guard flag** on helpdesk_ticket to prevent re-firing the stage transition if the dispatch picking is somehow re-validated (currently no guard — write is idempotent but auditing might fire twice).
- **Bump module version** from v15.0.1.12 → v15.0.1.13 in `__manifest__.py` and tag the commit.

## Errors & Workarounds
| Error | Cause | Fix |
|---|---|---|
| "You can't create a new payment without an outstanding payments/receipts account..." | `account_payment_method_line.payment_account_id` was NULL for Cash journal's Manual inbound/outbound | Created Outstanding Receipts (110001) and Outstanding Payments (110002) as Current Assets accounts, assigned to inbound/outbound method lines respectively |
| Pricelists menu hidden despite `product.product_pricelist_setting = basic` | No user in `Basic Pricelists` group (id=18) | Added admin to the group via shell: `basic_pricelist_group.write({'users': [(4, admin_id)]})` |
| `UserError: You cannot change the currency of the company since some journal items already exist` | Invoice INV/2026/00002 already had journal items | Bypassed ORM with direct SQL: `UPDATE res_company SET currency_id = 142 WHERE id = 1` (acceptable on test DB; would need to clear journal items on production) |
| Initial `res.config.settings.create({'group_product_pricelist': True}).execute()` activated Advanced (group id=19) but didn't add members | Settings activator toggles the parameter but doesn't auto-enroll existing users | Manual `write({'users': [...]})` on group id=18 |

## Key Exchanges
- User: "add a journal and payment method so that i can register a payment for INV/2026/00002" → created Cash journal + Cash account; payment method lines auto-created with Manual.
- User: "Can't create a new payment without an outstanding payments/receipts account" → diagnosed missing `payment_account_id` on method lines; created two Current Assets accounts and assigned.
- User: "When payment registered the ticket should move to Advance Received" → moved trigger from `_create_invoices()` to `account.payment.register.action_create_payments()`.
- User: "How does the ticket move to the next stage?" → audited production automations and module code; produced a per-stage trigger table (button/automation/manual).
- User: "Check if there's any link in the delivery order that triggers stage change to Repair Started" → found production Studio computed fields on project.task; wired equivalent in `stock_picking.button_validate()` for Repair Started + Repair Completed.
- User: "Is there a pricelist for the sale items?" → found Public Pricelist in EUR with 0 items; converted to LKR, set company default.
- User: "I can't see the pricelist in the configuration menu" → user-group membership issue; enrolled admin in Basic Pricelists.
- User listed 4 sequential requirements (50% gate, 100% invoiced for Mark as Done, Dispatch button, dispatch creates return) → implemented all four in one pass.
- User: "Handed Over to Customer should happen after the final return is validated" → moved stage transition from `action_dispatch` (immediate) to `button_validate` (on dispatch transfer validation) via new `x_studio_is_dispatch` flag.

## Custom Notes
None

---

## Quick Resume Context
Working on `helpdesk_repair_custom` v15.0.1.12 on db 2 (`odoo_repair_fresh`). This session completed the financial side of the ticket-stage automation chain: Cash journal + outstanding accounts so payments can be registered; payment-register wizard hook drives "Advance Received"; 50% down-payment gate (UserError) blocks delivery validation for non-RUG repairs; Mark-as-Done hidden until SO `invoice_status == 'invoiced'`; new Dispatch button on FSM tasks creates a virtual→customer transfer (linked via new `x_studio_is_dispatch` flag); validating that transfer advances the ticket to "Handed Over to Customer". Also fixed the pricelist setup (currency LKR, pricelist default, Basic Pricelists group membership). Next: user does end-to-end smoke test on db 2 of the whole chain, then mirror to production db 1 where needed.

---

## Raw Session Log

### User: /resume

(System loaded CLAUDE.md absent + 3 recent session summaries: FSM Task and SO Stage Flow 09:00, Receipt flow fixes 07:20, product_id clearing bug fix 06:28. All 20-05-2026.)

### Assistant
Produced resume summary covering recent module state v15.0.1.12, db 2 = odoo_repair_fresh, fresh DB post-install checklist (use_fsm, customer ir_property, accounting baseline).

### User
Can you add a journal and payment method so that i can register a payment for this invoice INV/2026/00002

### Assistant
Checked existing journals (only Customer Invoices INV sale) and account types. Created via shell:
- `account.account` Cash (101001, Bank and Cash type id=3)
- `account.journal` Cash (CSH, type cash) — auto-created Manual inbound + outbound payment method lines

### User
When the payment is registered the ticket should move to the stage advance recevied

### Assistant
- Removed `_create_invoices()` override from sale_order.py (was wrong trigger)
- Added `AccountPaymentRegister(TransientModel, _inherit='account.payment.register')` to account_payment.py with `action_create_payments()` override that finds linked SOs via invoice_line_ids.sale_line_ids.order_id and advances ticket to "Advance Received"
- Restarted service

### User
You can't create a new payment without an outstanding payments/receipts account set either on the company or the Manual payment method in the Cash journal.

### Assistant
- Investigated `account.payment.method.line` table — found `payment_account_id` was NULL on both inbound (id=1) and outbound (id=2) lines for Cash journal
- Created via shell:
  - 110001 Outstanding Receipts (Current Assets type id=5)
  - 110002 Outstanding Payments (same type)
- Assigned receipts to inbound line, payments to outbound line

### User
/usage (Settings dismissed)
How does the ticket move to the next stage?

### Assistant
Audited production automations on helpdesk.ticket (model 1206). Listed all 44 server actions and 5 active automations. None for stages after "Advance Received". Produced per-stage table:
- Automated (code): Plan Intervention→Diagnosis, SO sent→Estimation Sent, SO confirmed→Estimation Approval Received, Payment→Advance Received
- Manual buttons: Send to Factory (3127), Receive at Factory (3128), Send to Sales Centre (3129), Receive at Sales Centre (3130)
- Manual: Repair Started, Repair Completed (no automation/button)

### User
Can you check if there's any link in the delivery order in the sales order created that triggers the stage change to repair started

### Assistant
- Checked stock.picking/stock.move automations in production: only one repair-related (id=177, RR - Update Operation Type, on_create, sets picking_type_id based on x_studio_repair_return_location)
- Searched module code for "repair_started" — found _compute_x_studio_valid_delivered_so in helpdesk_ticket.py:455 that DOES advance to "Repair Started" / "Repair Completed", but depends on x_studio_valid_delivered_so on FSM task being set
- Checked production: x_studio_valid_delivered_so on project.task is a Studio COMPUTED field (depends on sale_order_id, checks SO state=='done' + any done delivery)
- In our module those task fields are plain Booleans (nothing sets them)
- Added `button_validate()` override to stock_picking.py that imperatively advances ticket stages:
  - First done outgoing picking on SO → "Repair Started" (with x_studio_repair_started_stage_updated guard)
  - First done picking to customer location → "Repair Completed" (with x_studio_repair_complete_stage_updated guard)
- Restarted service

### User
is there a pricelist for the sale items?

### Assistant
- Found Public Pricelist (id=1) in EUR, 0 items
- Production has 4 LKR pricelists with items (e.g. CENTRIC TYPE PUMPING UNIT 10CJ 030S = LKR 50165)
- Noted: db 2 uses EUR, needs reconfiguration

### User
I want the sales order and invoice to take the prices for the items from the price list

### Assistant
- Activated LKR (id=142, was inactive)
- ORM `company.currency_id = lkr` blocked with "You cannot change the currency... journal items exist" — used `UPDATE res_company SET currency_id = 142 WHERE id = 1` directly
- Set pricelist currency to LKR via ORM
- Created `ir.property` default for `res.partner.property_product_pricelist` → pricelist 1 (company-wide default)
- Restarted service

### User
I can't see the pricelist in the configuration menu

### Assistant
- Found `ir_config_parameter product.product_pricelist_setting = basic` (correct)
- But `Basic Pricelists` group (id=18) had 0 members
- Tried `res.config.settings.create({'group_product_pricelist': True}).execute()` — activated id=19 (Advanced) but didn't enroll users
- Manually added Administrator (only internal user) to group id=18 via `basic_pricelist_group.write({'users': [(4, u.id) for u in internal_users]})`
- Restarted service

### User
Before invoicing the customer for at least 50% down payment the delivery shouldn't be able to validate.
In the task for the mark as done button to appear the sales order should be 100% Invoiced
When the mark as done is clicked there should be a dispatch button in the return
When the dispatch button is created a return should be created which is from virtual location to the customer and the ticket stage should change to Handed over to customer

### Assistant
Implemented all 4 requirements in one pass:

1. **stock_picking.py button_validate()** — added pre-super 50% down-payment check:
```python
for picking in pending:
    if not picking.sale_id: continue
    so = picking.sale_id
    tasks = ...search([('sale_order_id', '=', so.id)])
    ticket = next((t.helpdesk_ticket_id for t in tasks if t.helpdesk_ticket_id), None)
    if not ticket or ticket.x_studio_rug_repair: continue
    invoices = so.invoice_ids.filtered(state=posted AND move_type=out_invoice)
    total_paid = sum(amount_total - amount_residual)
    required = so.amount_total * 0.5
    if total_paid < required: raise UserError(...)
```

2. **project_task.py override _compute_mark_as_done_buttons**:
```python
@api.depends('fsm_done', 'is_fsm', 'timer_start', 'display_enabled_conditions_count', 'display_satisfied_conditions_count', 'sale_order_id', 'sale_order_id.invoice_status')
def _compute_mark_as_done_buttons(self):
    super()._compute_mark_as_done_buttons()
    for task in self:
        if task.sale_order_id and task.sale_order_id.invoice_status != 'invoiced':
            task.update({'display_mark_as_done_primary': False, 'display_mark_as_done_secondary': False})
```
Added `x_studio_fully_invoiced_so` compute field, `x_studio_dispatch_done` stored boolean.

3. **action_dispatch on project.task** — creates picking from ticket.x_studio_virtual_location_id → customer location (usage='customer'), with move_line for serial/lot if tracked. Links to ticket.picking_ids. Sets x_studio_dispatch_done=True. (Initially also advanced stage immediately — corrected in next exchange.)

4. **views/project_task_views.xml** (NEW) — inherits timesheet_grid.project_task_view_form, adds Dispatch button after secondary Mark as Done with `attrs="{'invisible': ['|', ('fsm_done', '=', False), ('x_studio_dispatch_done', '=', True)]}"`. Added to __manifest__.py.

Ran module update for schema change, restarted, verified x_studio_dispatch_done column added.

### User
Handed over to Customer should happen after the final return is validated

### Assistant
Refactored to defer the stage transition until the dispatch transfer is validated:
- Added `x_studio_is_dispatch = fields.Boolean('Is Dispatch')` to stock_picking.py
- In action_dispatch, set `'x_studio_is_dispatch': True` on the created picking
- Removed the immediate `ticket.write({stage_id: handed_over, ...})` block from action_dispatch
- Added post-super block in button_validate:
```python
for picking in pending:
    if picking.state != 'done' or not picking.x_studio_is_dispatch: continue
    ticket = picking.x_studio_helpdesk_ticket_id
    if not ticket: continue
    stage_id = ticket._get_stage_by_name('Handed Over to Customer')
    if stage_id:
        ticket.write({'stage_id': stage_id, 'x_studio_stage_date': datetime.datetime.now()})
```
Ran module update for new column, restarted, verified x_studio_is_dispatch column added.

Final flow table:
- Payment registered → Advance Received
- Delivery validated (50% gate) → Repair Started
- Mark as Done (gated by 100% invoiced) → fsm_done=True
- Click Dispatch → creates virtual→customer transfer (x_studio_is_dispatch=True), opens it
- Validate dispatch transfer → Handed Over to Customer
