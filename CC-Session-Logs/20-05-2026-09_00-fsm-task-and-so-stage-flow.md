# Session Log: 20-05-2026 09:00 - FSM Task and SO Stage Flow

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, FSM, Plan Intervention, sale.order, project.task, ticket stage automation, Studio fields, use_fsm, action_confirm, _create_invoices, write override, account journals, fresh DB config, odoo_repair_fresh, ticket #11, REPAIR/2026/02010
**Projects:** helpdesk_repair_custom on Odoo 15, db 2 = odoo_repair_fresh
**Outcome:** Wired Plan Intervention button to set ticket stages on FSM task creation, SO state changes, and invoice creation; added missing Studio fields on sale.order and project.task; configured FSM, sales journal, customer location property on fresh DB.

## Solutions & Fixes

### 1. "Plan Intervention" button hidden on ticket #11
- Root cause: `helpdesk_team.use_fsm = NULL` on team id=1 in db 2 (production has it `True`)
- Fix: `UPDATE helpdesk_team SET use_fsm = true WHERE id = 1;` on `odoo_repair_fresh`
- Button comes from `helpdesk_fsm/views/helpdesk_views.xml`, requires `use_fsm=True` AND user in `industry_fsm.group_fsm_user`
- admin already had Field Service User group (id=69)

### 2. Missing `sale.order.x_studio_re_estimate_count` (CacheMiss → AttributeError)
- Read in `_compute_x_studio_re_estimate_count` and `_compute_x_studio_re_estimate_status` (helpdesk_ticket.py:328, 335)
- Field exists on sale.order in production (Studio), missing from db 2 schema
- Fix: added `x_studio_re_estimate_count = fields.Integer(...)` to `sale_order.py`, then `-u helpdesk_repair_custom`

### 3. Missing `sale.order.x_studio_rug_rejected` + 8 fields on `project.task` (CacheMiss → AttributeError)
- Read in `_compute_x_studio_rug_approval_status` and several FSM-task computes
- Added to `sale_order.py`: `x_studio_rug_rejected = fields.Boolean(...)`
- Created new file `models/project_task.py` defining 8 Studio fields used by ticket computes:
  - `x_studio_end_quick_repair`, `x_studio_fully_invoiced_so`, `x_studio_valid_invoiced_so`, `x_studio_valid_confirm_so`, `x_studio_valid_confirm2_so`, `x_studio_valid_delivered_so`, `x_studio_valid_delivered_so2` (Boolean)
  - `x_studio_material_availability` (Selection: Material Not Ready / Material Ready)
- Registered file in `models/__init__.py`
- Ran `--update=helpdesk_repair_custom` then `systemctl restart odoo15`

### 4. SO confirmation: "No rule has been found to replenish in Physical Locations/Inter-warehouse transit"
- Cause: per-partner `ir_property` override for `res.partner,1` (company partner) pointed `property_stock_customer` at `stock.location,13` (Inter-warehouse transit) instead of `stock.location,5` (Customers)
- Fix:
  ```sql
  UPDATE ir_property SET value_reference = 'stock.location,5'
  WHERE name = 'property_stock_customer' AND value_reference LIKE '%,13';
  ```
- No restart needed (ir_property is read at runtime)

### 5. Ticket stage automation on FSM/SO events
Three transitions wired up:

**Plan Intervention → Diagnosis** (new file `helpdesk_fsm_task_wizard.py`):
```python
class CreateFsmTask(models.TransientModel):
    _inherit = 'helpdesk.create.fsm.task'
    def action_generate_task(self):
        task = super().action_generate_task()
        ticket = self.helpdesk_ticket_id
        stage_id = ticket._get_stage_by_name('Diagnosis')
        if stage_id:
            ticket.write({'stage_id': stage_id, 'x_studio_stage_date': datetime.datetime.now()})
        return task
```
The wizard model is `helpdesk.create.fsm.task` at `/opt/odoo15/odoo/addons/helpdesk_fsm/wizard/create_task.py`; both `action_generate_task` and `action_generate_and_view_task` go through it (the latter calls `action_generate_task`).

**SO sent / SO confirmed / Invoice created** (rewritten `sale_order.py`):
- `write()` override detects `state` transitions: `sent` → "Estimation Sent to Customer", `sale` → "Estimation Approval Received"
- `_create_invoices()` override → "Advance Received"
- Helper methods `_ticket_for_order(order)` and `_advance_ticket_stage(ticket, task, stage_name, flag, task_flag)`
- Each transition guarded by an existing `x_studio_*_stage_updated` Boolean on helpdesk.ticket so it only fires once
- Also sets the corresponding `project.task` Boolean (`x_studio_valid_confirm_so`, `x_studio_valid_confirm2_so`, `x_studio_valid_invoiced_so`) to keep stored fields in sync with module computes

### 6. Invoice creation: "No journal could be found in company My Company for any of those types: sale"
- Cause: fresh DB has no chart of accounts installed — zero `account.journal` rows, only one `account.account` (custom RG006)
- Fix via Odoo shell:
  ```python
  income_type = env['account.account.type'].browse(13)  # Income, internal_group=income
  receivable_type = env['account.account.type'].search([('type','=','receivable')], limit=1)
  income_acc = env['account.account'].create({'name':'Product Sales','code':'400001','user_type_id':income_type.id,'company_id':1})
  recv_acc = env['account.account'].create({'name':'Account Receivable','code':'120001','user_type_id':receivable_type.id,'company_id':1,'reconcile':True})
  env['account.journal'].create({'name':'Customer Invoices','code':'INV','type':'sale','company_id':1,'default_account_id':income_acc.id})
  ```
- Receivable account also written as `property_account_receivable_id` company-wide via SQL on ir_property
- No restart needed

## Files Modified

- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/sale_order.py` — added `x_studio_rug_rejected`, `x_studio_re_estimate_count` fields; added `write()` and `_create_invoices()` overrides with helper methods `_ticket_for_order` and `_advance_ticket_stage` for ticket stage automation
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/project_task.py` — NEW file; inherits `project.task` and defines 8 Studio fields (`x_studio_end_quick_repair`, `x_studio_fully_invoiced_so`, `x_studio_valid_invoiced_so`, `x_studio_valid_confirm_so`, `x_studio_valid_confirm2_so`, `x_studio_valid_delivered_so`, `x_studio_valid_delivered_so2`, `x_studio_material_availability`)
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/helpdesk_fsm_task_wizard.py` — NEW file; inherits `helpdesk.create.fsm.task` wizard, advances ticket to Diagnosis on task creation
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/__init__.py` — registered `project_task` and `helpdesk_fsm_task_wizard`
- `/root/.claude/projects/-opt-odoo15/memory/project_fresh_db_config.md` — added sections for use_fsm setting and accounting journals; clarified ir_property fix

## Setup & Config

### Fresh DB (odoo_repair_fresh) post-install checklist additions
1. `UPDATE helpdesk_team SET use_fsm = true WHERE id = 1;` — enables Plan Intervention button
2. `UPDATE ir_property SET value_reference = 'stock.location,5' WHERE name = 'property_stock_customer' AND value_reference LIKE '%,13';` — fixes SO confirmation routing
3. Create accounting baseline via Odoo shell — sale journal "Customer Invoices" (code INV) + income account 400001 + receivable account 120001 + company-wide property_account_receivable_id

### Module commands
- Update Python field schema after adding `fields.X(...)` to models: `sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin -c /etc/odoo15.conf -d odoo_repair_fresh --update=helpdesk_repair_custom --stop-after-init`
- Restart only (no schema changes): `sudo systemctl restart odoo15 && sleep 3 && sudo systemctl is-active odoo15`
- Odoo shell pattern: `sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin shell -c /etc/odoo15.conf -d odoo_repair_fresh --no-http << 'EOF' ... env.cr.commit() EOF`

### Key reference IDs in odoo_repair_fresh
- helpdesk_team id=1: "Customer Care - Repair"
- helpdesk stages by name: New(1), In Progress(2), Sent to Factory(5), Solved(3), Received at Factory(6), Diagnosis(7), Estimation Sent to Customer(8), Estimation Approval Received(9), Advance Received(10), Repair Started(11), Repair Completed(12), Sent to Sales Centre(13), Received at Sales Centre(14), Handed Over to Customer(15), Cancelled(4)
- stock.location: Customers(5), Inter-warehouse transit(13)
- account types: Income(13), Receivable(1)
- Field Service User group id=69 (admin already member)

## Errors & Workarounds

| Error | Cause | Fix |
|---|---|---|
| "Invalid fields: Subject" on Assign to Me (prior session) | `name` required but empty on new ticket | Added `default='New'` to `name` override |
| Plan Intervention not shown on ticket #11 | `use_fsm` NULL on team | `UPDATE helpdesk_team SET use_fsm = true WHERE id = 1` |
| `AttributeError: 'sale.order' object has no attribute 'x_studio_re_estimate_count'` | Studio field on sale.order missing in db 2 | Added field in `sale_order.py`, ran module update |
| `AttributeError: 'sale.order' object has no attribute 'x_studio_rug_rejected'` (+ 8 missing project.task fields) | Studio fields missing in db 2 | Added to `sale_order.py`, created `project_task.py`, module update |
| "No rule has been found to replenish in Physical Locations/Inter-warehouse transit" on SO confirm | Per-partner `ir_property` for res.partner,1 pointed to transit location | `UPDATE ir_property` to stock.location,5 |
| "No journal could be found in company My Company for any of those types: sale" | No chart of accounts in fresh DB | Created sale journal + income + receivable accounts via shell |
| `account.account.type.type 'income'` not valid | Wrong enum: `type='income'` doesn't exist (only `other`, `receivable`, etc.); income is in `internal_group` | Used existing account type id=13 (Income, internal_group=income) |

---

## Quick Resume Context
Working on `helpdesk_repair_custom` v15.0.1.12+ on db 2 (`odoo_repair_fresh`). This session wired automatic ticket stage transitions on FSM task creation (→ Diagnosis) and SO lifecycle events: `state→'sent'` (→ Estimation Sent to Customer), `state→'sale'` (→ Estimation Approval Received), and invoice creation (→ Advance Received), all guarded by existing `x_studio_*_stage_updated` flags. Also added many missing Studio fields on `sale.order` and a new `project.task` model file for fields the existing ticket computes reference. Several fresh-DB data fixes applied (FSM toggle on team, customer location ir_property, full accounting baseline). User should next test the end-to-end flow on ticket #11: Plan Intervention → add products → send SO quote → confirm SO → create invoice, watching stage transitions at each step.

---

## Raw Session Log

### User
the ticket REPAIR/2026/02010 (#11) is suppose to show the button plan intervention

### Assistant
Investigated — "Plan Intervention" is the `action_generate_fsm_task` button defined in `helpdesk_fsm/views/helpdesk_views.xml`. Visible only when `use_fsm = True` on the ticket's team AND user has `industry_fsm.group_fsm_user`. In production db `odoo`, team id=1 has `use_fsm=true`; in fresh DB it was NULL. Fixed with `UPDATE helpdesk_team SET use_fsm = true WHERE id = 1`. admin user already had the FSM group. No restart needed; updated `project_fresh_db_config.md` memory to capture this checklist item.

### User
getting this error when the task is created
`AttributeError: 'sale.order' object has no attribute 'x_studio_re_estimate_count'`
(triggered in helpdesk_ticket.py:335 `_compute_x_studio_re_estimate_status`)

### Assistant
Studio field present on `sale.order` in production but missing from db 2. Added `x_studio_re_estimate_count = fields.Integer(string='Re-estimate Count')` to `models/sale_order.py` alongside the other two Studio fields already there. Ran `-u helpdesk_repair_custom`, restarted service. Column created and visible in schema.

### User
getting this when trying to open a ticket
`AttributeError: 'sale.order' object has no attribute 'x_studio_rug_rejected'`
(in `_compute_x_studio_rug_approval_status` at line 263)

### Assistant
Scanned the ticket compute methods for all Studio field accesses on `sale.order` and `project.task` (via `fsm_task_ids`). Compared to production schema. Findings:
- 1 missing on sale.order: `x_studio_rug_rejected` (Boolean)
- 8 missing on project.task: `x_studio_end_quick_repair`, `x_studio_fully_invoiced_so`, `x_studio_valid_invoiced_so`, `x_studio_valid_confirm_so`, `x_studio_valid_confirm2_so`, `x_studio_valid_delivered_so`, `x_studio_valid_delivered_so2` (all Boolean), `x_studio_material_availability` (Selection: Material Not Ready / Material Ready)

Added `x_studio_rug_rejected` to `sale_order.py`. Created new file `models/project_task.py` with all 8 Studio fields. Registered it in `models/__init__.py`. Ran `-u helpdesk_repair_custom`, restarted service. All 10 columns confirmed created.

### User
getting this when confirming a sales order
"No rule has been found to replenish '[02BB 023] Ball Baring' in 'Physical Locations/Inter-warehouse transit'."

### Assistant
Recognised as the known fresh-DB config issue but more precise this time. Investigation:
- Two `ir_property` rows for `property_stock_customer`: id=3 (default → stock.location,5 Customers), id=4 (per-partner override for `res.partner,1` → stock.location,13 Inter-warehouse transit)
- Fix: `UPDATE ir_property SET value_reference = 'stock.location,5' WHERE id = 4;` (or filter by `value_reference LIKE '%,13'`)
- Updated memory file to note this is a per-partner override on the company partner, not a global setting

### User
when the button plan intervention the ticket stage should be diagnosis. after adding the product in the task and confirming the sales order the stage should be estimate sent to customer

### Assistant
Investigated `action_generate_fsm_task` → opens `helpdesk.create.fsm.task` wizard whose `action_generate_task()` creates the `project.task`. Stage change should happen at task creation, not button click.

Created `models/helpdesk_fsm_task_wizard.py` inheriting `helpdesk.create.fsm.task`:
```python
def action_generate_task(self):
    task = super().action_generate_task()
    ticket = self.helpdesk_ticket_id
    stage_id = ticket._get_stage_by_name('Diagnosis')
    if stage_id:
        ticket.write({'stage_id': stage_id, 'x_studio_stage_date': datetime.datetime.now()})
    return task
```

For SO confirmation → "Estimation Sent to Customer", added `action_confirm()` override on `sale.order` that finds linked FSM tasks, walks to `helpdesk_ticket_id`, sets stage with `x_studio_estimation_sent_stage_updated` guard. Registered both files in `__init__.py`, restarted (no schema change).

### User
When the SO is in sent quotation the ticket should be estimate sent to customer. when the SO is confirmed it should be estimate approval received. when a partial invoice is created it should be advance recevied

### Assistant
Three separate triggers — refactored `sale_order.py`:
- Replaced `action_confirm` override with a `write()` override that detects state transitions (`sent` and `sale`)
- Added `_create_invoices()` override for the invoice trigger
- Added helpers `_ticket_for_order(order)` and `_advance_ticket_stage(ticket, task, stage_name, flag, task_flag=None)`

Mapping:
| SO event | Stage | Guard flag | Task flag |
|---|---|---|---|
| state→sent | Estimation Sent to Customer | x_studio_estimation_sent_stage_updated | x_studio_valid_confirm_so |
| state→sale | Estimation Approval Received | x_studio_estimation_approved_stage_updated | x_studio_valid_confirm2_so |
| _create_invoices | Advance Received | x_studio_invoice_stage_updated | x_studio_valid_invoiced_so |

`write()` catches state changes regardless of trigger (button, wizard, API). Restarted (no schema change).

### User
when trying to create an invocie
"No journal could be found in company My Company for any of those types: sale"

### Assistant
Fresh DB has no chart of accounts at all — no journals, only 1 custom account. Created the minimum via Odoo shell:
- Income account 400001 (user_type_id=13 Income)
- Receivable account 120001 (reconcile=True, type=receivable)
- Sale journal "Customer Invoices" (code INV, default_account_id=income)
- Receivable account also written as company-wide `property_account_receivable_id` ir_property

First attempt failed with `Wrong value for account.account.type.type: 'income'` — `type` is a fixed enum (other/receivable/payable/liquidity), income is in `internal_group`. Used existing account type id=13 instead of creating a new one. Updated memory with this section.

### User
/compress

### Assistant
[This session log generated and saved here.]
