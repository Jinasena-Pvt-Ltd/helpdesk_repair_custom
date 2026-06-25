# Session Log: 19-06-2026 07:56 - rug-fsm-delivery-lock-fix

## Quick Reference (for AI scanning)
**Confidence keywords:** odoo17, helpdesk_repair_custom, FSM, sale_order, action_confirm, action_lock, fsm_create_sale_order, _action_launch_stock_rule, industry_fsm_stock, _inverse_fsm_quantity, delivery, picking, REPAIR/2026/02089, REPAIR/2026/02090, S00103, S00105, Handed Over to Customer, x_studio_so_fully_paid, x_studio_is_dispatch, Without Serial No, serial creation
**Projects:** helpdesk_repair_custom (Odoo 15→17 port), container `odoo17`, DB `odoo17`, web `http://localhost:8169`, login `odoo`/`admin` (uid=2)
**Outcome:** Diagnosed why FSM repair SOs created no delivery (SO auto-locked on confirm) and fixed it with a context guard; explained why ticket 02090 was stuck (no invoice → dispatch gate); created 5 fresh test serials with validated deliveries; documented the Without-Serial repair flow.

## Key Learnings
- **FSM SO auto-lock breaks procurement.** `industry_fsm_stock._fsm_create_sale_order()` creates an *empty* SO and immediately calls `action_confirm()` (with context `fsm_create_sale_order=True`). The custom `sale_order.action_confirm()` override then called `action_lock()` on repair orders (`x_studio_is_repair_order=True`). A locked SO makes `sale_stock._action_launch_stock_rule()` skip procurement entirely (`if line.order_id.locked: continue`). So products added afterward via the FSM catalog never generate a delivery.
- **`_inverse_fsm_quantity` sets `qty_delivered` directly** for `service_type='manual'` products (true even for storable `type='product'`), masking the missing delivery — `qty_delivered=1.0` with `move_ids=[]`.
- **Dispatch → "Handed Over to Customer" gate.** Stage advance fires in `stock_picking._handle_dispatch_handover()` only when a picking with `x_studio_is_dispatch=True` reaches `state='done'`. That dispatch picking is created by the "Dispatch" button, which is gated (view `stock_picking_views.xml:51`) on `state='done' AND x_studio_location_is_customer AND x_studio_helpdesk_ticket_id AND x_studio_so_fully_paid AND NOT x_studio_dispatch_done AND x_studio_ticket_factory_repair AND x_studio_ticket_received_at_sales`.
- **`x_studio_so_fully_paid` chain:** picking ← FSM task `x_studio_so_fully_paid` ← SO needs `x_studio_rug_approved=True` AND a posted invoice with `x_studio_rug_acc_updated=True`. No invoice = gate stays closed.
- **REPAIR/2026/0XXXX names are FSM task / helpdesk ticket names, not repair.order names** (repair.order uses `WH/RO/000NN`).
- RPC `read` of nonexistent fields aborts the whole call — `x_studio_rug_acc_updated`/`x_studio_rug_rejected`/`x_studio_so_dispatched` do NOT exist on `helpdesk.ticket` (they live on `account.move`/`sale.order`). Use ORM via `docker exec` to introspect `_fields`.
- odoo15 XML-RPC is only reachable via container IP (172.19.0.3 / 172.20.0.4), DB `odoo15`, user `admin`/`admin`; not relevant to this work.

## Solutions & Fixes
- **The fix** (`models/sale_order.py`, `action_confirm`): guard the auto-lock so it's skipped during FSM SO creation:
```python
def action_confirm(self):
    for order in self:
        order._check_resupply_warehouse_stock()
    res = super().action_confirm()
    # Skip auto-lock when confirming the empty SO created by industry_fsm_stock so that
    # products added via the FSM catalog afterward can still trigger _action_launch_stock_rule.
    # A locked SO causes that method to skip procurement entirely (locked check at line 1).
    if not self.env.context.get('fsm_create_sale_order'):
        repair_orders = self.filtered('x_studio_is_repair_order')
        if repair_orders:
            repair_orders.action_lock()
    return res
```
- **Verified** after `docker restart odoo17`: simulating product add on a fresh repair FSM task produced `locked=False`, delivery `WH/OUT/00099`, and procurement group `S00104`.
- **Created 5 test serials** by running `/tmp/create_rug_delivery.py` 5× in the container — each makes a fresh `SN-RUG-AUTO-0NN` serial, puts qty 1 in WH/Stock, confirms a SO, and validates the outgoing delivery to "Test Customer RUG":
  - SN-RUG-AUTO-072 → WH/OUT/00101 (pick 172)
  - SN-RUG-AUTO-073 → WH/OUT/00102 (pick 173)
  - SN-RUG-AUTO-074 → WH/OUT/00103 (pick 174)
  - SN-RUG-AUTO-075 → WH/OUT/00104 (pick 175)
  - SN-RUG-AUTO-076 → WH/OUT/00105 (pick 176)
  - All confirmed: quant at customer location + delivery state=done. Product = "Samsung TV 55in" (id=4); customer = "Test Customer RUG" (id=8).

## Files Modified
- `models/sale_order.py`: added `fsm_create_sale_order` context guard around the `action_lock()` call in `action_confirm()` (the delivery-lock fix). Not yet committed.

## Errors & Workarounds
- **No delivery on REPAIR/2026/02089 / S00103:** SO was locked at confirm because `x_studio_is_repair_order=True` → procurement skipped. Fixed by the context guard above.
- **Ticket REPAIR/2026/02090 stuck at "Received at Sales Centre":** its FSM SO **S00105** has `x_studio_rug_approved=True` but **no invoice**, so `x_studio_so_fully_paid=False` → the "Dispatch" button on picking `WH/RETN/00046` (the customer→stock receipt, `location_is_customer=True`) is hidden → no dispatch picking → handover never fires. Resolution path: create+post invoice on S00105 → click "Update RUG Account" → Dispatch on WH/RETN/00046 → validate → ticket auto-advances to "Handed Over to Customer". (Not yet executed.)
- ORM heredoc via `docker exec ... python3 - <<EOF` sometimes produced no output; reliable form is `docker exec odoo17 bash -c "python3 << 'PYEOF' ... PYEOF"` with `flush=True` on prints.

## Pending Tasks
- **Complete 02090 handover** (optional): invoice S00105 → post → Update RUG Account → Dispatch WH/RETN/00046 → validate dispatch picking.
- **Commit the sale_order.py fix** to the `ported` branch (Jinasena-Pvt-Ltd/helpdesk_repair_custom) when ready.
- Consider re-running the 58-check factory E2E suite to confirm the lock fix didn't regress (the test currently locks the SO manually later in STEP E).

## Custom Notes
None

---

## Quick Resume Context
We fixed the FSM repair delivery bug: `sale_order.action_confirm()` was locking the SO right after `industry_fsm_stock` confirmed the empty FSM SO, which blocked `_action_launch_stock_rule` so no delivery was ever created. The fix adds `if not self.env.context.get('fsm_create_sale_order')` around the `action_lock()` call — verified working (delivery WH/OUT/00099 generated). Separately, ticket 02090 is stuck because its SO S00105 has no posted+RUG-updated invoice, so the dispatch gate (`x_studio_so_fully_paid`) is closed. Also created 5 ready-to-use test serials SN-RUG-AUTO-072..076 (deliveries WH/OUT/00101..00105). The fix is NOT yet committed.

---

## Raw Session Log

**User:** Why was there no delivery created on this REPAIR/2026/02089 / S00103?

**Assistant:** Investigated. `REPAIR/2026/02089` is FSM task id=34 (also helpdesk ticket 92), not a repair.order. S00103 (id=103) was auto-created from that task, state=sale, but `picking_ids=[]`, no procurement group, SO line 117 had `qty_delivered=1.0` yet `move_ids=[]`. Traced through `industry_fsm_sale`/`industry_fsm_stock` (both installed) and the custom module. Root cause: `S00103.x_studio_is_repair_order=True` and `locked=True`. The custom `sale_order.action_confirm()` calls `action_lock()` on repair orders; `industry_fsm_stock._fsm_create_sale_order()` confirms the empty SO first, so it gets locked, and when the product is later added via the catalog (`_inverse_fsm_quantity` → `sale.order.line.create` → `_action_launch_stock_rule`), the `line.order_id.locked` check skips procurement → no delivery. `_inverse_fsm_quantity` also sets `qty_delivered` directly for `service_type='manual'` products, masking it. Proposed a context-guard fix.

**User:** yes (apply the fix)

**Assistant:** Edited `models/sale_order.py` `action_confirm()` to wrap the repair-order `action_lock()` in `if not self.env.context.get('fsm_create_sale_order')`. Restarted odoo17. Verified by simulating a product add on a fresh repair FSM task: `locked=False`, delivery `WH/OUT/00099` created, procurement group `S00104`. Fix confirmed working.

**User:** REPAIR/2026/02090 why is this ticket not moving to handed over to customer stage?

**Assistant:** Ticket 93, stage "Received at Sales Centre". `x_studio_handed_over` is just a computed boolean (repairs_count>1), not the stage driver. Real driver: `stock_picking._handle_dispatch_handover()` advances to "Handed Over to Customer" only when a `x_studio_is_dispatch=True` picking hits state=done. That dispatch picking comes from the "Dispatch" button on receipt picking `WH/RETN/00046` (customer→stock, `location_is_customer=True`), which is gated on `x_studio_so_fully_paid`. That flag is False because the FSM SO **S00105** (rug_approved=True) has **no invoice**. So: create+post invoice on S00105 → Update RUG Account → Dispatch button appears on WH/RETN/00046 → validate → handover fires.

**User:** Create + validate fresh outgoing delivery for serial and give a few serials to test

**Assistant:** Inspected available serials (product "Samsung TV 55in" id=4, customer "Test Customer RUG" id=8). Ran `/tmp/create_rug_delivery.py` 5× → created SN-RUG-AUTO-072..076 with validated outgoing deliveries WH/OUT/00101..00105 (picks 172–176). Verified each has a quant at the customer location and delivery state=done.

**User:** Can you give me the flow for Repair - Not Under Warranty (Without Serial No)

**Assistant:** Used an Explore agent to map the module. Provided the full ordered stage flow (New → [Create Repair Route/Serial] → Send/Receive Factory → Diagnosis → Estimation Sent → Estimation Approval → Advance Received → Repair Started → Repair Completed → Send/Receive Sales Centre → Dispatch → Handed Over to Customer), with which transitions are manual buttons vs. auto (SO state, invoice payment, delivery validation), plus the key differences for Without-Serial (manual product entry, `sale_order_id` forced False, serial optionally generated via `action_create_repair_serial`/`action_create_repair_route`, 50% payment gate applies for non-RUG, dispatch gate conditions).

**User:** /compress
