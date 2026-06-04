# Session Log: 04-06-2026 11:00 - rug-price-swap-dispatch-fixes

## Quick Reference (for AI scanning)
**Confidence keywords:** RUG, price-swap, standard_price, cost-price, selling-price, dispatch-button, x_studio_so_fully_paid, x_studio_price_unit_original, sale_order_line, create-override, locked-order, automation-rule, odoo_repair_fresh, S00048, S00050, S00051, S00057, REPAIR/2026/02057, REPAIR/2026/02069, helpdesk_repair_custom, x_studio_rug_acc_updated
**Projects:** helpdesk_repair_custom (Odoo 15 custom addon, /opt/odoo15/custom-addons/helpdesk_repair_custom)
**Outcome:** Fixed the RUG cost-price swap (3 iterations, final fix in SaleOrderLine.create vals injection) and gated the Dispatch button on RUG approval + posted invoice with RUG account updated instead of registered payment.

## Decisions Made
- **Replaced `x_studio_quotation_type == 'Repair'` filter with `x_studio_is_repair_order`** in the RUG price-swap automation — `x_studio_quotation_type` was never set by any code, so the automation rule never fired. `x_studio_is_repair_order` is a stored computed field derived from `task_id.helpdesk_ticket_id` and always correct.
- **Moved price-swap logic from XML automation rule to Python** — removed the `on_create` `base.automation` rule entirely (deleted from `data/automation_rules.xml`) to avoid double-execution; logic now lives in `SaleOrderLine.create()` + a `SaleOrder.write()` backstop.
- **Price swap injected into `vals` BEFORE `super().create()`** (not a post-create `line.write()`) — a post-create write hits "It is forbidden to modify... Unit Price" UserError when the SO is locked (`done` state, e.g. during FSM Mark as Done).
- **Dispatch gate for RUG orders: RUG approved + invoice posted + RUG account updated** (user explicitly chose this over "RUG approved only") — ensures accounting completes before goods leave, but no payment registration required.
- **Working database is `odoo_repair_fresh` (referred to as "db 2")** — not `odoo` or `odoo15`. Same SO names (S00048 etc.) exist in multiple DBs with different data.

## Key Learnings
- **RUG price lifecycle:** RUG-confirmed repair SO lines are billed at cost (`standard_price`); the selling price is backed up to `x_studio_price_unit_original`. On `action_reject_rug` the selling price is restored from the backup; on `action_approve_rug` cost stays. The `if not x_studio_price_unit_original` guard ensures the swap runs once.
- **`on_create` automation rules can't see post-create writes:** `task_id` is linked to the SO *after* creation by the FSM flow, so `x_studio_is_repair_order` is False at create time and the filter fails. Then for S00051, `task_id` was set AT create time but lines are created after the header — so a SO-level `write()` hook also missed it. Line-level `create()` is the only reliable interception point.
- **Locked SOs (`state='done'`) reject `price_unit` writes** via Odoo's locked-order field protection — any post-create modification of order lines fails. Setting values in `vals_list` before `super().create()` bypasses this because it's part of record creation, not modification.
- **Dispatch button gate chain:** picking `x_studio_so_fully_paid` ← `any(task.x_studio_so_fully_paid or task.x_studio_end_quick_repair)` ← task compute summing `amount_total - amount_residual` over posted out_invoices. RUG flow never registers payment, so the gate never opened.
- **DB access on this server:** `su -c "psql -d odoo_repair_fresh -c \"...\"" odoo15` (peer auth as `odoo15` user). Odoo binary: `/opt/odoo15/myodoo15-venv/bin/python3 /opt/odoo15/odoo/odoo-bin -c /etc/odoo15.conf` (system python lacks PIL).

## Solutions & Fixes
1. **Automation rule never fired (S00048):** `x_studio_quotation_type` was NULL — changed filter/code to use `x_studio_is_repair_order`. (Later superseded.)
2. **Still not firing (S00050):** `task_id` written after create → added `SaleOrder.write()` hook calling `_apply_rug_price_swap()` when `task_id` in vals.
3. **Still not firing (S00051):** `task_id` set at create, lines created after header → added `SaleOrderLine.create()` override with post-create `line.write()` swap.
4. **Locked-order UserError on Mark as Done (S00057, REPAIR/2026/02069):** post-create write blocked on locked SO → final fix: inject `price_unit = standard_price` and `x_studio_price_unit_original` directly into `vals` before `super().create(vals_list)`:
```python
@api.model_create_multi
def create(self, vals_list):
    for vals in vals_list:
        order_id = vals.get('order_id')
        product_id = vals.get('product_id')
        if not order_id or not product_id or vals.get('x_studio_price_unit_original'):
            continue
        order = self.env['sale.order'].browse(order_id)
        if order.x_studio_rug_confirmed and order.x_studio_is_repair_order:
            product = self.env['product.product'].browse(product_id)
            vals['x_studio_price_unit_original'] = vals.get('price_unit', product.lst_price)
            vals['price_unit'] = product.standard_price
    return super().create(vals_list)
```
5. **Dispatch hidden for approved RUG:** added short-circuit in `project_task.py::_compute_x_studio_so_fully_paid`:
```python
if so.x_studio_rug_approved:
    rug_invoices = so.invoice_ids.filtered(
        lambda i: i.state == 'posted' and i.move_type == 'out_invoice')
    task.x_studio_so_fully_paid = bool(rug_invoices) and all(
        i.x_studio_rug_acc_updated for i in rug_invoices)
    continue
```
Plus `@api.depends` additions: `sale_order_id.x_studio_rug_approved`, `sale_order_id.invoice_ids.x_studio_rug_acc_updated`.

## Files Modified
- `models/sale_order_line.py`: Added `@api.model_create_multi create()` override — injects cost price + original-price backup into vals for RUG repair orders before record creation.
- `models/sale_order.py`: Added `_apply_rug_price_swap()` helper and `write()` hook (fires when `task_id` set) as backstop for edge cases where task linked after lines exist.
- `models/project_task.py`: `_compute_x_studio_so_fully_paid` — RUG-approved orders count as fully paid once invoice posted + `x_studio_rug_acc_updated`; extended depends.
- `data/automation_rules.xml`: Removed `act_automation_rug_so_price_swap` / `automation_rug_so_price_swap` records (replaced by Python); left a comment pointing to `sale_order.py`.

---

## Quick Resume Context
Working on the RUG (Repair Under Guarantee) flow in `helpdesk_repair_custom` on DB `odoo_repair_fresh`. The cost-price swap now happens reliably in `SaleOrderLine.create()` (vals injection, no locked-order errors), and the Dispatch button appears for RUG-approved orders once the invoice is posted with RUG account updated — no payment registration needed. Existing SOs S00048/S00050/S00051 in odoo_repair_fresh still have unswapped prices (created before fixes); user hasn't asked to backfill them. All changes restart-applied via `systemctl restart odoo15`; module update command: `su -c "/opt/odoo15/myodoo15-venv/bin/python3 /opt/odoo15/odoo/odoo-bin -c /etc/odoo15.conf -d odoo_repair_fresh -u helpdesk_repair_custom --stop-after-init" odoo15`.

---

## Raw Session Log

### User: what is the current configuration for the RUG reject and approve when it comes to the price of the items. where is cost used and where is the selling price

Claude explored the codebase and reported the RUG price flow:
- Two triggers swap price to cost: "Change Repair Type to RUG" server action (`server_actions.xml:376`) and an on_create automation rule (`automation_rules.xml:155`) filtered on `x_studio_rug_confirmed=True` + `x_studio_quotation_type='Repair'`.
- Both save selling price → `x_studio_price_unit_original`, set `price_unit = standard_price`.
- `action_approve_rug` (sale_order.py:55): no price change, cost stays.
- `action_reject_rug` (sale_order.py:62): restores `price_unit = x_studio_price_unit_original`.

### User: s00048 check this SO and see what price its showing

Claude found DB creds (peer auth, user odoo15), queried DB `odoo`: S00048 = done, Repair type, NOT RUG-confirmed; line BALL BEARING 6202-2RS at 2500.00, no original backup — no swap ever ran (correctly, since not RUG).

### User: is this the one your checking on db2? REPAIR/2026/02057 (#58) ... S00048

In DB `odoo`, S00048 was linked to REPAIR/2024/00017 (#881), and REPAIR/2026/02057 (#996) had no task/SO. Mismatch flagged.

### User: which db are you checking?

Claude: `odoo`. Available: odoo, odoo15, odoo_repair_fresh.

### User: check odoo_repair_fresh

In `odoo_repair_fresh`: REPAIR/2026/02057 (#58) → task 40 → S00048 (draft, RUG-confirmed). Line "Ball Baring" at 1190.00 (later seen as 1200), `x_studio_price_unit_original` empty → swap never ran despite RUG confirmed.

### User: why wasn't the automated rule triggered?

`x_studio_quotation_type` was NULL on S00048; the automation filter requires it = 'Repair'. Nothing in the code ever sets that field.

### User: Run the proper fix

Claude changed the automation rule (XML) to filter on `x_studio_is_repair_order` instead, updated module in odoo_repair_fresh (exit 0), verified rule updated in DB, restarted Odoo.

### User: S00050 check what the price is on this sales order in db 2

S00050: RUG-confirmed, is_repair_order=True, but line at 1190.00 with no backup — swap didn't run.

### User: This was created after the fix

Root cause #2: `task_id` is written AFTER SO creation, so `x_studio_is_repair_order` was False when on_create fired. Fix: added `_apply_rug_price_swap()` + `write()` hook on task_id in sale_order.py; removed the XML automation rule entirely; module updated + restart.

### User: If the type is RUG the item should show the cost price from the start and only change to selling price if the request for RUG approval is declined. Check the new sale order s00051. its still showing selling price

S00051 had task_id=43 set AT create time (write hook never fired) and lines created after header. Fix: `SaleOrderLine.create()` override (post-create line.write swap). Restart.

### User: S00057 / REPAIR/2026/02069 — Mark as Done error: "It is forbidden to modify the following fields in a locked order: Unit Price"

S00057 swap HAD run (cost 50, original 1190 saved) but the post-create `line.write()` failed on locked (done) orders. Final fix: inject prices into `vals` before `super().create()` — no post-create write. Restart. Confirmed working approach.

### User: In RUG approve flow there is no register payment, so the button dispatch should appear in the return without the payment being registered

(Plan mode.) Explored dispatch gate: button in `stock_picking_views.xml:47-56` requires picking `x_studio_so_fully_paid` ← task compute summing invoice payments. RUG never registers payment → gate never opens. Asked user: gate on RUG approval alone, or also require posted invoice + RUG account updated? **User chose: RUG approved + invoice posted.** Plan approved and implemented: short-circuit in `project_task.py::_compute_x_studio_so_fully_paid` returning True for RUG-approved SOs when all posted out_invoices have `x_studio_rug_acc_updated`; extended depends. Restarted Odoo.
