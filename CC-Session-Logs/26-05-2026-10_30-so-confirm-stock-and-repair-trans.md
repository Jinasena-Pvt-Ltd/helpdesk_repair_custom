# Session Log: 26-05-2026 10:30 - so-confirm-stock-and-repair-trans

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, v15.0.1.16, v15.0.1.17, v15.0.1.18, v15.0.1.19, project.task, _compute_mark_as_done_buttons, x_studio_diagnosis_validated, sale.order, action_confirm, resupply_wh_ids, free_qty, stock.picking, x_studio_created_from_help_ticket, x_studio_helpdesk_ticket_id, x_studio_pick_id, stock.return.picking, create_returns, copy=False, server_actions.xml, Create Repair Route, Create Repair Serial, ticket 26, REPAIR/2026/02025, odoo_repair_fresh, db 2, Repair Trans smart button
**Projects:** helpdesk_repair_custom on Odoo 15, db 2 = odoo_repair_fresh
**Outcome:** Three sequential fixes across v15.0.1.17–v15.0.1.19: (1) hardened Mark-as-Done gate so it no longer reappears after Validate Diagnosis; (2) added SO `action_confirm` override that blocks confirm with UserError when the resupply warehouse has insufficient `free_qty`; (3) fixed "Repair Trans." smart button counting the Create-Repair-Route reference picking — now correctly shows 2 (partner↔virtual) instead of 3.

## Decisions Made
- **Mark-as-Done gate**: dropped `not x_studio_diagnosis_validated` from elif branch; gate is now "repair task → require SO with all outgoing pickings done". Trade-off accepted: labor-only repairs (no SO ever) have Mark-as-Done permanently hidden.
- **SO stock check hook point**: `sale.order.action_confirm()` (block at confirm, raise UserError, no state change). Cleaner than gating `button_validate` on pickings because Odoo's "Validate" vocabulary for SO = Confirm; also intercepts the chained call from `industry_fsm_sale.project_task.action_fsm_validate`.
- **Stock metric**: `product.product.free_qty` (on-hand minus reserved). Most conservative — refuses to over-promise the same stock.
- **No resupply configured** (`resupply_wh_ids` empty): skip the check. Nothing to gate against.
- **Aggregate per product across SOLs**: same product on two lines is summed before comparing against pooled stock (prevents double-counting).
- **Sum free_qty across multiple resupply warehouses** (permissive aggregate).
- **Storable products only**: services/consumables skipped.
- **No RUG carve-out** for the stock check.
- **Repair Trans count fix**: stop tagging the Create-Repair-Route reference picking with `x_studio_created_from_help_ticket`. Reference picking keeps `x_studio_helpdesk_ticket_id` (traceability) but is invisible to the count.
- **`copy=False` on `x_studio_created_from_help_ticket`**: prevents `stock.return.picking._create_returns` (which copies the parent picking) from propagating the tag through the return chain.
- **Generalize `create_returns` override**: tag all wizard-created return pickings (not just dispatch returns) with both ticket fields.
- **Backfill**: ran SQL on db 2 to clear the stale tag from existing reference pickings (24 rows affected).

## Key Learnings
- **`sale.order.warehouse_id` provenance**: filled by `_default_warehouse_id` → `res.users._get_default_warehouse_id` → `property_warehouse_id` (company-dependent). `industry_fsm_sale._fsm_create_sale_order` does NOT set warehouse explicitly; relies on `onchange_user_id`. (`/opt/odoo15/odoo/addons/sale_stock/models/sale_order.py:21-39, 164-167`).
- **"Resupply warehouse" semantics**: standard Odoo `stock.warehouse.resupply_wh_ids` / `resupply_route_ids` mechanism (`/opt/odoo15/odoo/addons/stock/models/stock_warehouse.py:83-88`). When WH A has `resupply_wh_ids=[B]`, an auto-route creates an inter-WH transfer B→A on SO confirm. The module does NOT configure resupply itself — it relies on standard Odoo config.
- **`stock.return.picking._create_returns` copies the parent**: `new_picking = self.picking_id.copy(...)` at `/opt/odoo15/odoo/addons/stock/wizard/stock_picking_return.py:131`. Any Many2one custom field on stock.picking without `copy=False` propagates through the return chain. This was the silent mechanism poisoning the Repair Trans count.
- **Two distinct ticket-fields on stock.picking** in this module: `x_studio_created_from_help_ticket` (drives the "Repair Trans." smart-button count and the `action_repair_trans` window action), and `x_studio_helpdesk_ticket_id` (drives `button_validate` gates, RUG payment gates, dispatch logic). They are NOT the same thing — different fields, different purposes.
- **Action_repair_trans default context** sets `default_x_studio_created_from_help_ticket: active_id` — so any picking created from within that smart-button view inherits the tag. The smart-button count compute is non-stored, so cache invalidation is automatic on form reopen.
- **Mark-as-Done compute layering**: the upstream `_compute_mark_as_done_buttons` in `industry_fsm` writes `display_mark_as_done_primary/secondary`. Override calls `super()` then conditionally forces both flags to False. Use `task.update({...})` to set both atomically.

## Solutions & Fixes

### 1. v15.0.1.17 — Tighten Mark-as-Done gate
`models/project_task.py`:
```python
@api.depends(
    'fsm_done', 'is_fsm', 'timer_start',
    'display_enabled_conditions_count', 'display_satisfied_conditions_count',
    'sale_order_id', 'sale_order_id.picking_ids', 'sale_order_id.picking_ids.state',
    'helpdesk_ticket_id',
)
def _compute_mark_as_done_buttons(self):
    super()._compute_mark_as_done_buttons()
    for task in self:
        hide = False
        if task.sale_order_id:
            so = task.sale_order_id
            outgoing = so.picking_ids.filtered(lambda p: p.picking_type_code == 'outgoing')
            if not outgoing or not all(p.state == 'done' for p in outgoing):
                hide = True
        elif task.helpdesk_ticket_id:
            # Repair task with no SO yet — hide until materials are added
            # and the SO+deliveries gate above takes over.
            hide = True
        if hide:
            task.update({
                'display_mark_as_done_primary': False,
                'display_mark_as_done_secondary': False,
            })
```
Changes vs v15.0.1.16: `elif task.helpdesk_ticket_id and not task.x_studio_diagnosis_validated:` → `elif task.helpdesk_ticket_id:`. Removed `'x_studio_diagnosis_validated'` from `@api.depends`.

### 2. v15.0.1.18 — SO confirm stock check
`models/sale_order.py` (additions):
```python
from collections import defaultdict
from odoo.exceptions import UserError

def action_confirm(self):
    for order in self:
        order._check_resupply_warehouse_stock()
    return super().action_confirm()

def _check_resupply_warehouse_stock(self):
    self.ensure_one()
    if self.state not in ('draft', 'sent'):
        return
    resupply_whs = self.warehouse_id.resupply_wh_ids
    if not resupply_whs:
        return
    locations = resupply_whs.mapped('lot_stock_id')
    needed = defaultdict(float)
    for line in self.order_line:
        if line.display_type or line.product_id.type != 'product':
            continue
        remaining = line.product_uom_qty - line.qty_delivered
        if remaining <= 0:
            continue
        qty_in_product_uom = line.product_uom._compute_quantity(
            remaining, line.product_id.uom_id)
        needed[line.product_id] += qty_in_product_uom
    if not needed:
        return
    products = self.env['product.product'].browse([p.id for p in needed])
    available = {p.id: 0.0 for p in products}
    for loc in locations:
        for p in products.with_context(location=loc.id):
            available[p.id] += p.free_qty
    shortages = []
    for product, required in needed.items():
        have = available.get(product.id, 0.0)
        if have + 1e-6 < required:
            shortages.append(
                "- %s: need %s %s, available %s %s in %s" % (
                    product.display_name,
                    required, product.uom_id.name,
                    have, product.uom_id.name,
                    ', '.join(resupply_whs.mapped('name'))))
    if shortages:
        raise UserError(
            "Cannot confirm %s: insufficient stock in the resupply "
            "warehouse for the following products:\n%s\n\n"
            "Please replenish the resupply warehouse and try again."
            % (self.name, "\n".join(shortages)))
```

### 3. v15.0.1.19 — Fix "Repair Trans." over-count

**a) `data/server_actions.xml`** — remove `x_studio_created_from_help_ticket` from BOTH reference-picking create dicts (line 176 in `RR - Auto Create Repair Route` and line 241 in `RR - Auto Create Repair Serial`). Keep `x_studio_helpdesk_ticket_id`.

**b) `models/stock_picking.py`** — make tag non-copyable:
```python
x_studio_created_from_help_ticket = fields.Many2one(
    'helpdesk.ticket', string='Created from Help Ticket',
    ondelete='set null', copy=False)
```

**c) `models/stock_return_picking.py`** — generalize `create_returns`:
```python
def create_returns(self):
    result = super().create_returns()
    new_picking = self.env['stock.picking'].browse(result.get('res_id'))
    ticket = self.ticket_id
    if new_picking and ticket:
        new_picking.x_studio_created_from_help_ticket = ticket.id
        new_picking.x_studio_helpdesk_ticket_id = ticket.id
        if self.x_studio_is_dispatch:
            new_picking.x_studio_is_dispatch = True
            task = self.env['project.task'].search(
                [('helpdesk_ticket_id', '=', ticket.id)], limit=1)
            if task:
                task.x_studio_dispatch_done = True
    return result
```

**d) Backfill SQL on db 2:**
```sql
UPDATE stock_picking sp
   SET x_studio_created_from_help_ticket = NULL
  FROM helpdesk_ticket t
 WHERE t.x_studio_pick_id = sp.id
   AND sp.x_studio_created_from_help_ticket = t.id;
-- UPDATE 24
```

### 4. Update + restart cycle (used for each version bump)
```
sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin \
  -c /etc/odoo15.conf -d odoo_repair_fresh \
  --update=helpdesk_repair_custom --stop-after-init
# EXIT: 0 each time
sudo systemctl restart odoo15 && sleep 5 && sudo systemctl is-active odoo15
# active
```

### 5. Verification queries used
```sql
-- Find all pickings linked to a ticket via either ticket-field
SELECT p.id, p.name, pt.code, p.state,
       p.x_studio_created_from_help_ticket AS repair_trans_tag,
       p.x_studio_helpdesk_ticket_id AS ticket_link
FROM stock_picking p
LEFT JOIN stock_picking_type pt ON pt.id = p.picking_type_id
WHERE p.x_studio_helpdesk_ticket_id = 26
ORDER BY p.id;

-- Trace return chain via origin_returned_move_id
SELECT p.id, p.name, p.origin, sm.origin_returned_move_id
FROM stock_picking p
LEFT JOIN stock_move sm ON sm.picking_id = p.id
WHERE p.x_studio_created_from_help_ticket = 26 OR p.x_studio_helpdesk_ticket_id = 26
ORDER BY p.id, sm.id;
```

## Files Modified
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/__manifest__.py` — version 15.0.1.16 → 15.0.1.17 → 15.0.1.18 → 15.0.1.19 (three bumps).
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/project_task.py` — `_compute_mark_as_done_buttons` simplified; removed `x_studio_diagnosis_validated` dependency.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/sale_order.py` — added imports (`defaultdict`, `UserError`), added `action_confirm` override + `_check_resupply_warehouse_stock` helper.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/stock_picking.py` — added `copy=False` to `x_studio_created_from_help_ticket` field.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/stock_return_picking.py` — generalized `create_returns` override to tag all wizard-created return pickings, not just dispatch.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/data/server_actions.xml` — removed `x_studio_created_from_help_ticket` from reference-picking create dict in both `RR - Auto Create Repair Route` (line 176) and `RR - Auto Create Repair Serial` (line 241).
- `/root/.claude/plans/in-the-project-task-add-validated-snowflake.md` — rewritten three times to cover each fix (Mark-as-Done gate, SO stock check, Repair Trans count).

## Setup & Config
- **Module updates applied to db 2** (`odoo_repair_fresh`) only. db 1 (production) NOT mirrored yet.
- **Backfill SQL run on db 2**: 24 rows updated — existing reference pickings cleared of `x_studio_created_from_help_ticket`.
- **Service:** `odoo15.service` via systemd, active after each restart.
- **Test ticket on db 2**: `helpdesk_ticket.id = 26` = `REPAIR/2026/02025`, type "Repair - Not Under Warranty (Without Serial No)", `partner_id=1`, `source_loc=15` (Virtual/Production), `virtual_loc=18` (Repair/Ekala), `return_receipt_loc=8`.
- **Three pickings on ticket 26 (post-fix)**: WH/OUT/00024 (outgoing, ref, tag=NULL), WH/RET/00020 (incoming, Receipt, tag=26), WH/RET/00021 (incoming, Dispatch Return, tag=26).

## Pending Tasks
- **Mirror v15.0.1.17 + v15.0.1.18 + v15.0.1.19 to db 1 (production)** after end-to-end UI verification on db 2. Don't forget the backfill SQL on db 1 too.
- **End-to-end UI verification on db 2** for:
  - Mark-as-Done gate: fresh "Without Serial No" → validate diagnosis → still hidden until SO + deliveries done.
  - SO confirm: with zero stock in resupply WH → UserError with shortage list; top up → confirms cleanly.
  - Repair Trans: open ticket 26 — badge should now read 2 not 3.
  - New ticket end-to-end: badge starts at 0 → 1 after first Receipt → 2 after dispatch Receipt.
- **Production db Studio collisions**: production may have Studio versions of `_compute_mark_as_done_buttons`, `sale_order` overrides, or stock-picking tagging — check before deploying.
- **Carry-over from earlier sessions** (still pending):
  - 25-05 three-delivery / dispatch return flow walkthrough.
  - 26-05 09:00 (validate-diagnosis-button) end-to-end UI walkthrough still unverified.

## Errors & Workarounds
- **psql cwd error**: running `sudo -u postgres psql` from `/opt/odoo15/custom-addons/helpdesk_repair_custom` produced `could not change directory to ...: Permission denied`. Workaround: `cd /tmp && sudo -u postgres psql ...`. The query still ran, but the message is noisy; cd-to-/tmp suppresses it.
- **Schema discovery quirks**: in db 2, `helpdesk_ticket` does NOT have `x_studio_ticket_type_id_real` (production-only Studio field). Use base field `ticket_type_id` instead. Similarly `x_studio_dispatched` / `x_studio_received` don't exist on db 2 — used `x_studio_repair_serial_created` and other actual columns.
- **`ir_actions_server` vs `ir_act_server`**: Odoo 15 PostgreSQL table is `ir_act_server` (no plural-actions prefix). First query failed; switched to `ir_act_server`. Similarly the table doesn't have a `name` column directly — `name` lives on `ir_act_server` (alias `ias.name`), not on `base_automation`.

## Custom Notes
None

---

## Quick Resume Context
On `helpdesk_repair_custom` v15.0.1.19 on db 2 (`odoo_repair_fresh`). This session applied three sequential fixes: (1) v15.0.1.17 tightened Mark-as-Done so it stays hidden even after Validate Diagnosis until the SO has all outgoing pickings done; (2) v15.0.1.18 added a `sale.order.action_confirm()` gate that raises UserError when the SO's resupply warehouse (`warehouse_id.resupply_wh_ids`) lacks `free_qty` for any storable line; (3) v15.0.1.19 stopped tagging the Create-Repair-Route reference picking with `x_studio_created_from_help_ticket` (added `copy=False` to the field, generalized `stock.return.picking.create_returns` to tag all wizard returns), so the "Repair Trans." smart button correctly shows 2 partner↔virtual transfers instead of 3. Backfill SQL on db 2 cleared 24 stale tags. db 1 (production) still pending mirror — verify Studio collisions first.
