# Session Log: 05-06-2026 11:02 - rug-onchange-price-and-reject-guard

## Quick Reference (for AI scanning)
**Confidence keywords:** RUG, helpdesk_repair_custom, v15.0.1.39, v15.0.1.40, onchange, product_id_change, cost-price, selling-price, pricelist, re-estimate, reject, x_studio_rug_rejected, x_studio_rug_confirmed, x_studio_price_unit_original, sale_order_line, _onchange_product_id_rug_price, MRO, standard_price, odoo_repair_fresh, dispatch
**Projects:** helpdesk_repair_custom (Odoo 15 custom addon, /opt/odoo15/custom-addons/helpdesk_repair_custom), db 2 = odoo_repair_fresh
**Outcome:** Two bumps: v1.39 added a UI onchange so new lines on RUG-confirmed repair SOs show the cost price immediately (before saving, e.g. during re-estimate); v1.40 guarded both the onchange and the create() swap with `not x_studio_rug_rejected` so rejected RUG orders show/use only the selling price for new lines.

## Decisions Made
- **Fix the "price shows selling until save" issue with an `@api.onchange('product_id')` on `sale.order.line`**, not by changing the create() override — the create() swap stays as the server-side safety net for programmatic line creation; the onchange only makes the UI reflect what will be saved.
- **Rejection is detected via `x_studio_rug_rejected`, not by clearing `x_studio_rug_confirmed`** — `x_studio_rug_confirmed` is a related stored field from the ticket and is never cleared on rejection (only `x_studio_rug_approved` is cleared); so both swap sites needed an explicit `not order.x_studio_rug_rejected` guard rather than relying on the confirmed flag.
- **Same guard added in BOTH the onchange and create()** — keeping UI preview and server-side persistence behaviour identical.

## Key Learnings
- **Odoo onchange MRO order:** a subclass-defined `@api.onchange('product_id')` on `sale.order.line` runs AFTER the parent's standard `product_id_change` (base → subclass traversal). This lets the custom onchange capture the pricelist price that `product_id_change` just set (into `x_studio_price_unit_original`) and then overwrite `price_unit` with `standard_price` — the UI shows cost price immediately, before save.
- **Why the bug existed:** the v1.38 fix put the swap only in `SaleOrderLine.create()` (vals injection), which is invisible to the form until the record is saved — standard `product_id_change` sets the pricelist price in the UI in the meantime.
- **Post-rejection state of a RUG order:** `x_studio_rug_rejected=True`, `x_studio_rug_approved=False`, but `x_studio_rug_confirmed` still True (related from ticket). Existing line prices are restored from `x_studio_price_unit_original` by `action_reject_rug` (v1.38); new lines added after rejection were still being cost-swapped until v1.40.
- The onchange guards: skip if no product, skip if not (rug_confirmed AND is_repair_order), skip if rejected, skip if `x_studio_price_unit_original` already set (idempotent — don't double-swap).

## Solutions & Fixes

### 1. v15.0.1.39 — cost price shown in UI before save (re-estimate add-line case)
`models/sale_order_line.py` — new onchange:
```python
@api.onchange('product_id')
def _onchange_product_id_rug_price(self):
    if not self.product_id:
        return
    order = self.order_id
    if not (order.x_studio_rug_confirmed and order.x_studio_is_repair_order) \
            or order.x_studio_rug_rejected:
        return
    if self.x_studio_price_unit_original:
        return  # already swapped — don't overwrite
    self.x_studio_price_unit_original = self.price_unit
    self.price_unit = self.product_id.standard_price
```
(The `x_studio_rug_rejected` clause was added in v1.40.)

### 2. v15.0.1.40 — rejected RUG orders use only selling price for new lines
`models/sale_order_line.py::create()` — condition extended:
```python
if order.x_studio_rug_confirmed and order.x_studio_is_repair_order \
        and not order.x_studio_rug_rejected:
```
Combined with v1.38's restore-on-reject, the full reject behaviour is now: existing lines restored to pricelist price, new lines never swapped.

### 3. Deploy cycle (both versions, clean)
```bash
sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin \
  -c /etc/odoo15.conf -d odoo_repair_fresh \
  --update=helpdesk_repair_custom --stop-after-init 2>&1 | tail -5
sudo systemctl restart odoo15 && sleep 4 && sudo systemctl is-active odoo15  # → active
```

## Files Modified
- `models/sale_order_line.py`: added `_onchange_product_id_rug_price` (UI cost-price swap on product selection, v1.39); guarded onchange + `create()` swap with `not x_studio_rug_rejected` (v1.40).
- `__manifest__.py`: version 15.0.1.38 → .39 → .40.

---

## Quick Resume Context
On `helpdesk_repair_custom` v15.0.1.40, db 2 (`odoo_repair_fresh`). The RUG cost-price swap now has two layers: an `@api.onchange('product_id')` on sale.order.line that shows the cost price in the UI immediately when adding a line (runs after standard product_id_change via MRO), and the existing `create()` vals-injection as the server-side net. Both are skipped when `x_studio_rug_rejected` is True, so rejected RUG orders show and use only the selling/pricelist price (existing lines were already restored on reject by v1.38). Both versions deployed clean, service active. UI verification by the user still pending for: re-estimate add-line showing cost immediately, and post-reject new lines staying at selling price.

---

## Raw Session Log

### User (via /resume)
Ran `/resume` — loaded last 3 session logs (04-06 rug-price-swap-dispatch-fixes, 03-06 rug-config-payment-and-reject-price, 28-05 rug-flow-studio-to-module). No CLAUDE.md exists in the project. Context: module at v15.0.1.38, RUG flow on db 2 (odoo_repair_fresh), price swap in SaleOrderLine.create(), dispatch gated on RUG approval + posted invoice with RUG account updated.

### User
"When going through RUG flow. if the re estimate button is clicked on an approved sale order and another line is added that line item first shows the selling price and when the doc is saved it changes to cost price. it should show the cost price even before saving."

### Assistant
Read `models/sale_order_line.py` and `models/sale_order.py`. Root cause: the server-side `create()` override swaps `price_unit` to `standard_price` only on save; Odoo's standard `product_id_change` onchange sets the pricelist/selling price in the UI when a product is picked, and the form shows that until saved.

Fix (v15.0.1.39): added `_onchange_product_id_rug_price` (`@api.onchange('product_id')`) to `SaleOrderLine`. Subclass onchanges run after the parent's `product_id_change` (MRO base → subclass), so it captures the just-set pricelist price into `x_studio_price_unit_original` then sets `price_unit = product.standard_price`. Guards: product set, order is RUG-confirmed repair order, `x_studio_price_unit_original` not already set. `create()` override kept as server-side safety net. Bumped manifest to 15.0.1.39, updated module on odoo_repair_fresh, restarted odoo15 — active.

### User
"When the RUG approval is rejected it should show and use only the selling price"

### Assistant
Analysis: after `action_reject_rug`, `x_studio_rug_rejected=True` and `x_studio_rug_approved=False`, but `x_studio_rug_confirmed` (related from ticket) stays True — so both the new onchange and the `create()` swap would still cost-swap any new line added post-rejection. Existing lines were already restored from `x_studio_price_unit_original` by v1.38.

Fix (v15.0.1.40): added `or order.x_studio_rug_rejected: return` to the onchange guard and `and not order.x_studio_rug_rejected` to the `create()` condition in `models/sale_order_line.py`. Bumped manifest to 15.0.1.40, updated module, restarted service — active.

### User
Ran `/compress` — selected Key Learnings, Solutions & Fixes, Decisions Made, Files Modified; no custom notes; accepted topic name `rug-onchange-price-and-reject-guard`.
