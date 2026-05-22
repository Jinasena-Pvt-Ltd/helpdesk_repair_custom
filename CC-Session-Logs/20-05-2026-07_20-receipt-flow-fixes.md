# Session Log: 20-05-2026 07:20 - receipt-flow-fixes

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, assign_to_me, Invalid fields Subject, name default, Receipt button, valid_return, valid_confirm_return, customer usage filter, Create Repair Serial, Create Repair Route, fake outgoing picking, x_studio_pick_id guard, two Return buttons, x_studio_repair_rug, default_x_studio_repair_rug, suggested_location_id, _onchange_picking_id_ticket_location, db 2, odoo_repair_fresh
**Projects:** helpdesk_repair_custom (db 2 / odoo_repair_fresh)
**Outcome:** Fixed four interrelated bugs in the helpdesk_repair_custom Receipt flow: (1) "Assign to Me" failing with "Invalid fields: Subject" on new tickets; (2) Receipt button hidden on ticket #7 because original outgoing delivery falsely marked valid_return=True; (3) Create Repair Serial/Route creating a spurious done outgoing transfer when a sale-order picking already existed; (4) Two "Return" buttons in the wizard popup and empty Suggested Return Location field.

## Decisions Made
- **`name` field default = `'New'`** instead of removing required constraint or adding default_name in form context — the field is required at the model level and DB level, and an empty string would fail. `'New'` satisfies both checks; the `on_create` automation immediately replaces it with the sequence number.
- **Filter `valid_return`/`valid_confirm_return` by `location_id.usage == 'customer'`** instead of excluding by picking_type or by picking ID — the semantic intent is "a return receipt FROM the customer," which is precisely `location_id.usage == 'customer'` regardless of picking type configuration.
- **Guard `if not record.x_studio_pick_id:` instead of removing the outgoing entirely** — for tickets with no sale order, the wizard still needs a 'done' reference picking to reverse. Only skip the fake outgoing when there's already a real sale-order delivery to use as reference.
- **Pass `default_x_studio_repair_rug` via base button context** instead of populating the flag in a wizard onchange — the flag is needed at button-render time so the custom Return button is hidden upfront for non-RUG tickets, not after a picking_id is chosen.
- **Populate both `x_studio_suggested_location_id` AND `_id_1`** in the same onchange that sets `location_id` — they're separate fields per-company but the onchange already has the virtual location, so do it in one place.

## Key Learnings
- **"Invalid fields: Subject" is a CLIENT-SIDE error**, not server-side. Generated in `/opt/odoo15/odoo/addons/web/static/src/legacy/js/views/basic/basic_controller.js:597` via `_notifyInvalidFields`. The label "Subject" comes from `fields['name'].string`. Triggered by `canBeSaved()` checking required fields before executing a button when the form is dirty — `name` was required but empty on new tickets because the view made it readonly without providing a default.
- **`picking_ids` on `helpdesk.ticket` is a Many2many (`helpdesk_ticket_stock_picking_rel`)** populated automatically by `helpdesk_stock`'s `create_returns()` override (it does `ticket_id.picking_ids |= picking_id` after the base wizard creates the return). The `x_studio_helpdesk_ticket_id` and `x_studio_created_from_help_ticket` Many2one fields on `stock.picking` are SEPARATE — they don't auto-populate `picking_ids`.
- **The stock return wizard requires `picking_id.state == 'done'`** — `stock_picking_return.py:50-51` raises `UserError("You may only return Done pickings.")`. That's why the Create Repair Serial/Route actions originally created a fake DONE outgoing — it's the only way the wizard can produce a return picking when there's no real sale-order delivery.
- **Studio-exported `'context'` attribute on a Char field doesn't set the field's default value.** `<attribute name="context">{'default_name': 'New'}</attribute>` on a `<field name="name">` is just per-field RPC context, not a form-level default. To set a default for the record being created, you need either a Python `default=` on the field or `default_name` in the action's window context.
- **Odoo domain prefix parsing**: `['|','|',...,A,B,C,'&',D,E]` is left-to-right Polish notation. Each `|`/`&` consumes the next 2 sub-expressions. For a chain of 7 `|` operators followed by 7 operands + `&` + 2 operands → `(A|B|C|D|E|F|G) | (D&E)`.

## Solutions & Fixes
- **Fix 1 — "Assign to Me" → "Invalid fields: Subject":** Override `name` in `helpdesk_ticket.py` with `default='New'`. The `act_automation_repair_seq` (on_create) immediately replaces 'New' with the sequence number via `if record.name: record.write({'name': seq})`.
- **Fix 2 — Receipt button hidden by original sale delivery:** Updated `_compute_x_studio_valid_return` and `_compute_x_studio_valid_confirm_return` to filter `picking_ids` by `line.location_id.usage == 'customer'`. The original outgoing (Production → Customers) has `location_id.usage = 'production'` so it's correctly excluded; only true return receipts (Customer → Virtual) count.
- **Fix 3 — Spurious outgoing from Create Repair Serial/Route:** Wrapped the picking/move/move_line creation block in both `action_create_repair_route` and `action_create_repair_serial` with `if not record.x_studio_pick_id:`. Tickets with a sale-order delivery skip the fake outgoing entirely; tickets with no prior delivery still get one (still needed as wizard reference).
- **Fix 4a — Two "Return" buttons in wizard:** Changed custom RUG Return button attrs in `stock_return_picking_views.xml` from `invisible: [ticket_id = False]` to `invisible: [ticket_id = False] OR [x_studio_repair_rug != True]`. Also added `'default_x_studio_repair_rug': x_studio_rug_repair` to the base Receipt button's context in `helpdesk_ticket_views.xml` so the flag propagates into the wizard.
- **Fix 4b — Empty Suggested Return Location:** Updated `_onchange_picking_id_ticket_location` in `stock_return_picking.py` to also set `self.x_studio_suggested_location_id = virtual_loc` and `self.x_studio_suggested_location_id_1 = virtual_loc` (both per-company variants).
- **Updated module v15.0.1.12 in db 2** via `sudo -u odoo15 .../odoo-bin -c /etc/odoo15.conf -d odoo_repair_fresh --update=helpdesk_repair_custom --stop-after-init` to push the XML data changes (server actions) into the DB; Python and view changes loaded via `sudo systemctl restart odoo15.service`.

## Files Modified
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/helpdesk_ticket.py`:
  - Added `name = fields.Char(string='Subject', default='New', required=True, index=True)` override
  - Updated `_compute_x_studio_valid_return` and `_compute_x_studio_valid_confirm_return` to filter by `line.location_id.usage == 'customer'`
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/stock_return_picking.py`:
  - Extended `_onchange_picking_id_ticket_location` to populate `x_studio_suggested_location_id` and `x_studio_suggested_location_id_1` alongside `location_id`
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/data/server_actions.xml`:
  - `action_create_repair_route` — wrapped fake outgoing creation in `if not record.x_studio_pick_id:`
  - `action_create_repair_serial` — same guard added
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/views/helpdesk_ticket_views.xml`:
  - Base Receipt button context now includes `'default_x_studio_repair_rug': x_studio_rug_repair`
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/views/stock_return_picking_views.xml`:
  - Custom RUG Return button attrs changed to `invisible: ['|', ['ticket_id','=',False], ['x_studio_repair_rug','!=',True]]`

## Setup & Config
- **DB targeted:** db 2 = `odoo_repair_fresh` (clean test DB). Production = db 1 (`odoo`).
- **Service:** `odoo15.service` (systemd). Restart via `sudo systemctl restart odoo15.service`; XML data file changes require `--update=helpdesk_repair_custom --stop-after-init`.
- **Postgres:** `sudo -u postgres psql -d odoo_repair_fresh -c "..."` (the `odoo15` OS user has no DB role).
- **Ticket #7 test state on db 2:** type=2 (Without Serial No), repair_serial_created=True, pick_id=9 (WH/OUT/00006 = original sale delivery, Production→Customers, done). Single entry in `helpdesk_ticket_stock_picking_rel`: (7, 9).

## Pending Tasks
- **UI verification on db 2 for all four fixes:**
  - New ticket → "Assign to Me" → no "Invalid fields" error, sequence assigned correctly
  - Ticket #7 → Receipt button now visible → clicking opens wizard with virtual location as Suggested Return Location → standard "Return" button creates Customer → Virtual receipt → only one Return button visible (custom hidden for non-RUG)
  - New "Without Serial No" ticket WITH a sale order → Create Repair Serial / Create Repair Route → no fake outgoing created
  - New "Without Serial No" ticket WITHOUT a sale order → Create Repair Serial / Create Repair Route → fake outgoing still created (existing behavior preserved)
  - RUG ticket → Receipt wizard still shows the custom RUG Return button (`default_x_studio_repair_rug=True` propagating)
- **Apply equivalent fixes to db 1 (production)** if/when these flows have the same bugs — likely all four since the original module was exported from db 1's Studio config.
- **Long-term consideration:** Replace the stock-return-wizard flow with a direct receipt server action (mirror of `action_rug_return_from_helpdesk`) for "Without Serial No" tickets. This would eliminate the need for the fake outgoing on no-sale-order tickets entirely. Not done now because the xpath indexing on the 3 `act_stock_return_picking` buttons in `helpdesk_ticket_views.xml` is fragile and reshuffling would risk regressions.
- **Memory: bump `project_helpdesk_repair_custom_module.md` version note from v15.0.1.12 → v15.0.1.13** after the next git tag (if user creates one for these fixes).

## Errors & Workarounds
- **`UserError('Return Location should be equal to Suggested Return Location.')`** — the RUG Return action validation always failed because `x_studio_suggested_location_id` was never populated in the wizard. Fixed by extending `_onchange_picking_id_ticket_location`.
- **Wizard requires picking state == 'done'** — discovered via `stock_picking_return.py:50-51`. This is the reason the fake outgoing exists; can't just create a draft reference.
- **`sudo -u odoo15 psql ...` denied** (same as last session) — worked around with `sudo -u postgres psql -d odoo_repair_fresh ...` and ignored the harmless "could not change directory to /opt/odoo15: Permission denied" warning.

## Key Exchanges
- User reported "error when assign to me button is clicked" with payload "Invalid fields: Subject" — traced through web client JS (`basic_controller.js:_notifyInvalidFields`) rather than server-side (which doesn't generate that exact string).
- User reported "Receipt button is supposed to appear before Send to Factory" on ticket #7 — discovered the original outgoing delivery (picking #9) was incorrectly counted by `valid_return`/`valid_confirm_return`. Fixed compute methods.
- User reported "two issues: transfer still being created on Create Serial, two Return buttons" — addressed with the `x_studio_pick_id` guard + custom Return button visibility fix + context flag propagation.
- User followed up "why is the suggested return location empty in the reverse transfer?" — the onchange only set `location_id`, never the suggested location fields. One-line fix.

## Custom Notes
None

---

## Quick Resume Context
Continuing work on `helpdesk_repair_custom` on db 2 (`odoo_repair_fresh`). Just landed four fixes covering the Receipt-flow chain: name default for the "Assign to Me" required-field bug; customer-usage filter on `valid_return`/`valid_confirm_return` so the original sale delivery doesn't falsely hide the Receipt button; `x_studio_pick_id` guard on Create Repair Serial/Route to skip the fake outgoing when a sale delivery already exists; and two wizard fixes (custom Return button hidden for non-RUG via `default_x_studio_repair_rug` context flag, and Suggested Return Location populated in the same onchange that sets location_id). Service restarted, module updated in db 2 to push XML server-action changes. Next: user verification of all four fixes in UI; eventual mirror to db 1 production.

---

## Raw Session Log

### User: /resume
Read CLAUDE.md attempt found no file; surfaced auto-memory + single existing session log (20-05-2026-06_28-product-id-clearing-bug-fix.md). Reported phase: helpdesk_repair_custom v15.0.1.12, last fix landed but UI-unverified. Listed next actions from prior session's pending tasks.

### User: There is a error when assign to me button is clicked on the ticket
Inspected `assign_ticket_to_self` in `helpdesk_ticket.py:673` (sets `self.user_id = self.env.user`, returns act_window) and `_sync_user_locations` (writes location fields). Checked recent Odoo log — only had stale restart errors. Asked user to reproduce and share the error.

### User: db 2, here's the error: Invalid fields: Subject
Grepped for "Invalid fields" — found only `.po` translations in odoo addons, no server-side raise. Located the client-side source in `/opt/odoo15/odoo/addons/web/static/src/legacy/js/views/basic/basic_controller.js:_notifyInvalidFields` (line 597) and `canBeSaved` (line 135). Confirmed "Subject" = `fields['name'].string` for the base `helpdesk.ticket` `name = fields.Char(string='Subject', required=True, ...)`.

Diagnosis: when a new ticket is opened, `name` is empty; the view makes the field readonly with `placeholder="New"` but provides no default value; clicking the "Assign to Me" button triggers an auto-save → `canBeSaved` → finds `name` empty + required → reports "Invalid fields: Subject."

Fix: Override `name` field in custom module with `default='New'`. The `act_automation_repair_seq` on_create automation guards on `if record.name:` (truthy 'New'), so it correctly replaces 'New' with the actual sequence number on create.

Restarted `odoo15.service`. Verified service active.

### User: in the ticket #7 before sent to factory the button receipt is suppose to appear that will create a transfer from customer to virtual location. check this and let me know
Queried ticket #7 state on db 2:
- `ticket_type_id=2` (Without Serial No)
- `stage_id=1` (New)
- `x_studio_normal_repair_without_serial_no=t`, `x_studio_repair_serial_created=t`
- `x_studio_virtual_location=18` (Repair/Ekala, usage=inventory)
- `x_studio_source_location=15` (Production, usage=production)
- `x_studio_pick_id=9`, `x_studio_picking_id=9`, `x_studio_sn_updated=t`
- Team's `use_product_returns=t`
- 1 active picking linked to ticket via `x_studio_helpdesk_ticket_id`

Picking #9 = WH/OUT/00006, type=2 (outgoing/Delivery Orders), state=done, location_id=15 (Production), location_dest_id=5 (Customers). This is the original sale delivery.

Read button visibility code in `helpdesk_ticket_views.xml` lines 497–532. Parsed the first Receipt button's invisible domain (`A | B | C | D | E | F | G | (H & I)`). For ticket #7, the only non-False condition was D = `x_studio_valid_return == True` — which was True because the compute counted the outgoing delivery.

Read `_compute_x_studio_valid_return` (`helpdesk_ticket.py:267`) and `_compute_x_studio_valid_confirm_return` (`:275`). Both iterate `picking_ids` and check state. Both treat the original outgoing as a return.

Found the M2M junction: `helpdesk_ticket_stock_picking_rel`. Confirmed ticket 7 has (7, 9) — picking #9 is in the M2M.

Fix: Added `line.location_id.usage == 'customer'` filter to both computes. The outgoing delivery has `location_id.usage = 'production'` so it's excluded; real return receipts (Customer → Virtual) will have `location_id.usage = 'customer'` and count correctly. Restarted service.

### User: [system reminder about task tracking; ignored as not applicable]

### User: two issues. theres still a transfer being created and done when he create seriel number button is clicked the transfer is from virtual to partner. there's also two buttons called return in the reverse transfer pop up when receipt is clicked
Investigated both:

**Issue 1 — fake outgoing from Create Repair Serial/Route:** Read `action_create_repair_route` (`server_actions.xml:137`) and `action_create_repair_serial` (`:199`). Both create a stock.picking + stock.move + stock.move.line with state='done', from `source_loc` to Customers, then write `x_studio_pick_id = prod_move.id` (overwriting any pre-existing sale-order picking). This was originally needed because the standard return wizard requires a 'done' picking to reverse (verified at `stock_picking_return.py:50-51`).

For ticket #7, `x_studio_pick_id = 9` from sale order is already a valid 'done' picking — no need to create a fake one. Wrapped the picking-creation block in both actions with `if not record.x_studio_pick_id:`. Tickets with no sale order still get the fake outgoing.

**Issue 2 — two "Return" buttons:** Read `stock_return_picking_views.xml`. Found the custom RUG Return button (`action_rug_return_from_helpdesk`) added after `create_returns` with `attrs invisible: [ticket_id = False]` — visible for ALL tickets with a ticket_id, not just RUG.

The base `helpdesk_stock` module's `create_returns()` override already links the standard return to `ticket_id.picking_ids` (line 30-37 of `/opt/odoo15/odoo/addons/helpdesk_stock/wizard/stock_picking_return.py`). So for non-RUG tickets, the standard Return button is fully sufficient.

Fix: Changed custom Return button attrs to `invisible: [ticket_id = False] OR [x_studio_repair_rug != True]`. Also added `'default_x_studio_repair_rug': x_studio_rug_repair` to the base Receipt button context in `helpdesk_ticket_views.xml:415-417` so the flag is propagated into the wizard at open time.

Restarted service, ran module update to apply XML data changes:
```
sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin -c /etc/odoo15.conf -d odoo_repair_fresh --update=helpdesk_repair_custom --stop-after-init
```
Verified `if not record.x_studio_pick_id` guard present in both server actions in DB.

### User: why is the suggested return location empty in the reverse transfer?
Read `stock_return_picking.py`. The `_onchange_picking_id_ticket_location` was setting only `self.location_id = virtual_loc` — never touching `x_studio_suggested_location_id` or `x_studio_suggested_location_id_1`. Those fields are displayed in the wizard and also used by the RUG Return action validation (`record.location_id.id != record.x_studio_suggested_location_id.id`).

Fix: extended the onchange to also set both suggested location fields (per-company variants) to the same virtual_loc. Restarted service. Verified active.

### User: /compress
This session log being written.
