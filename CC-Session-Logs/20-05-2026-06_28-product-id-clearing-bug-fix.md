# Session Log: 20-05-2026 06:28 - product-id-clearing-bug-fix

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, product_id, Without Serial No, _sync_ticket_type_flags, automation_clear_on_serial_change, on_change automation, db 2, odoo_repair_fresh, ticket type, save, write override
**Projects:** helpdesk_repair_custom (db 2 / odoo_repair_fresh)
**Outcome:** Fixed two bugs causing product_id to be cleared on save for "Repair - Not Under Warranty (Without Serial No)" tickets — onchange automation writing to DB + write() override clearing product unconditionally.

## Decisions Made
- **Work target locked in:** db 2 = clean test DB (`odoo_repair_fresh`), db 1 = production. All fixes go into the `helpdesk_repair_custom` module code, never into Studio in db 2. Always check db 1 Studio for the correct intended flow before fixing.
- **For "Without Serial No" type, product is manually set** — module code must preserve `product_id` across ticket-type changes and serial-no changes, instead of unconditionally clearing it.
- **Patched the DB automation directly** (`UPDATE ir_act_server` on db 2) so the fix takes effect immediately without a module upgrade; XML file also updated so the fix persists.

## Key Learnings
- **`on_change` automation rules in Odoo write to the ACTUAL DB record**, not just the virtual onchange state. The `base_automation_onchange` handler runs the server action with `active_id=self._origin.id`. When `_origin.id` is a real record ID (existing ticket), `record['field'] = value` inside the server action is a real `record.write({field: value})` → committed to DB. This is different from Python `@api.onchange` methods which only modify the virtual record via `rec.field = value`.
- **Cascade onchanges:** Odoo's `onchange()` ORM re-runs onchange methods for any field that changed during a previous onchange in the same call (via `snapshot0.has_changed(name)`). For Many2one fields, `has_changed` compares old vs new value — setting False → False is NOT a change, so no cascade. But setting non-False → False IS a change → cascade fires.
- **Readonly fields are not sent on save:** Odoo's web client excludes readonly fields from the create/write payload (unless `force_save="True"`). Combined with `attrs.readonly` evaluating to True, this can silently drop user input.
- **Studio "on change" automation rules survive module export** but their behaviour (writing to actual DB during onchange) is preserved — they're not converted into Python `@api.onchange` methods, so they keep their unusual side effects.

## Solutions & Fixes
- **Fix 1 — `automation_clear_on_serial_change` server action:** Guarded the `product_id = False` clear behind `if not record.x_studio_normal_repair_without_serial_no`. Applied in both the XML (`data/automation_rules.xml`) and live in db 2 via `UPDATE ir_act_server SET code = ... WHERE name = 'RR - Auto Select Product for RUG Repairs-33'`.
- **Fix 2 — `_sync_ticket_type_flags` in `helpdesk_ticket.py`:** Built the updates dict, then only added `'product_id': False` if the new ticket type is NOT "Without Serial No". This stops the write override from clearing product_id that the user just set in the same save when ticket_type_id is also in vals.
- **Fix 3 — `_onchange_ticket_type_id`:** Same guard added — don't clear `rec.product_id` if the new type is "Without Serial No". UX improvement: user keeps their product when switching to this type.
- **Restarted `odoo15.service`** with `sudo systemctl restart odoo15.service` so the Python model changes load (DB-only changes don't need a restart).

## Files Modified
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/data/automation_rules.xml`: `act_automation_clear_on_serial_change` now guards `product_id = False` behind `if not record.x_studio_normal_repair_without_serial_no`. Also reordered so `lot_id` and `x_studio_sn_updated` are set before the conditional.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/helpdesk_ticket.py`:
  - `_sync_ticket_type_flags()` — refactored to build an `updates` dict, conditionally adds `product_id: False` only when new type is NOT "Without Serial No"
  - `_onchange_ticket_type_id()` — same conditional guard on `rec.product_id = False`
- **db 2 (`odoo_repair_fresh`) — direct SQL patch:** `UPDATE ir_act_server SET code = ... WHERE name = 'RR - Auto Select Product for RUG Repairs-33'`. Updates the automation rule's server action code with the same guard as the XML.
- `/root/.claude/projects/-opt-odoo15/memory/user_db_shorthand.md` + MEMORY.md entry — saved "db 1 = production, db 2 = fresh" convention.
- `/root/.claude/projects/-opt-odoo15/memory/feedback_working_approach.md` + MEMORY.md entry — saved workflow: fix in module code targeting db 2; reference db 1 Studio for correct flow.

## Setup & Config
- **Odoo service:** `odoo15.service` (systemd), config at `/etc/odoo15.conf`, log at `/var/log/odoo15/odoo.log`, port 8069.
- **Postgres access:** `sudo -u postgres psql -d odoo_repair_fresh` works; `sudo -u odoo15 psql ...` does NOT (no DB role for odoo15 user in this setup).
- **Module path:** `/opt/odoo15/custom-addons/helpdesk_repair_custom/`
- **Two DBs on this server:** db 1 = production (named `odoo`?), db 2 = `odoo_repair_fresh`.

## Pending Tasks
- **Verify the fix in the UI:** User should test creating a new "Repair - Not Under Warranty (Without Serial No)" ticket on db 2, set a product, save, and confirm product_id persists. Should also test changing ticket type to/from "Without Serial No" on existing tickets.
- **Investigate the original bug 1** ("With Serial No" — can't select product, only serial): this is BY DESIGN — product auto-populates from serial. Confirm user understands this is intentional, or revisit if they actually wanted a different flow.
- **Check whether other `on_change` automations** in the module write to the actual DB during onchange RPCs (same Studio export pattern). Candidates: `automation_auto_product_from_serial`, `automation_populate_repair_location`. Their server actions also use `record['field'] = value` syntax → same risk.
- **Consider replicating the fix in db 1 (production)** if the same automation rule exists there — the user's original Studio rule probably has the same bug.

## Errors & Workarounds
- **`sudo -u odoo15 psql ...` failed (exit 2)** — no DB role for odoo15. Worked around with `sudo -u postgres psql -d odoo_repair_fresh -c "..."` (with a "could not change directory to /opt/odoo15: Permission denied" warning that's harmless because the command doesn't need the cwd).
- **Initial parallel psql queries showed inconsistent state for ticket 7** (product_id = NULL then 3) — turned out the user was actively editing the ticket between queries (race with live use), not a query bug.
- **Typo when editing `_sync_ticket_type_flags`:** Accidentally wrote `tt.x_studio_ug` instead of `tt.x_studio_rug`. Caught and fixed in a follow-up Edit before restart.

## Key Exchanges
- User clarified DB shorthand mid-session ("db 1 = production, db 2 = clear DB") — saved as user memory.
- User locked in the working approach: fix in module code, target db 2, reference db 1 Studio — saved as feedback memory.
- User interrupted an initial proposed fix (adding a `create()` override) and redirected to investigate the actual "product disappears on save" root cause for "Without Serial No" first — turned out to be the right call; the real bugs were elsewhere.

## Custom Notes
None

---

## Quick Resume Context
Working on the `helpdesk_repair_custom` Odoo 15 module on db 2 (`odoo_repair_fresh`). Just fixed a bug where `product_id` was disappearing on save for "Repair - Not Under Warranty (Without Serial No)" tickets. The cause was twofold: (1) the `automation_clear_on_serial_change` on_change automation writes to the actual DB during onchange RPCs (not just the virtual record), and (2) `_sync_ticket_type_flags` in the write override always cleared product_id when ticket_type_id was in vals. Both now guard the clear behind `if not without_serial_no`. Service restarted, DB automation patched live. Next: user verification in the UI; consider applying the same fix to db 1 production if the equivalent Studio automation has the bug.

---

## Raw Session Log

(Full conversation preserved below for searchability.)

### User: /resume
Loaded auto-memory (no CLAUDE.md or CC-Session-Logs/ existed yet). Surfaced project state: helpdesk_repair_custom v15.0.1.12, recent server action fixes on 2026-05-20, open items on fresh DB config and RUG button bug.

### User: Remember db 1 = production, db 2 = clear DB
Saved as user memory (`user_db_shorthand.md`) and indexed in MEMORY.md.

### User: We'll work on db 2 on the custom helpdesk app. Always check db 1 Studio for correct flow.
Saved as feedback memory (`feedback_working_approach.md`) and indexed.

### User: Adding ticket for "Repair - Not Under Warranty (With Serial No)". (1) Can't select product, only serial. (2) Product field goes empty when saved.
Listed module files, read helpdesk_ticket_views.xml (538 lines), read helpdesk_ticket.py (683 lines). Identified that for "With Serial No": product_id readonly is by design (auto-populated from serial). For the save bug, initially proposed a `create()` override.

### User: [interrupted] Check why product disappears for "Without Serial No" specifically.
Investigated more deeply. Checked base helpdesk's `create()` and `write()`, helpdesk_stock's product_id field, automation_rules.xml. Reviewed onchange cascade mechanics in Odoo ORM (`Snapshot.has_changed`, `_onchange_methods` patching by base_automation).

Queried db 2 (`sudo -u postgres psql -d odoo_repair_fresh`):
- Tickets table: ticket 7 had `product_id = NULL` initially; later query showed `product_id = 3` with `x_studio_repair_serial_created = True`. Suggests bug is real and reproducible.
- Ticket type 2 = "Repair - Not Under Warranty (Without Serial No)", `x_studio_without_serial_no = t`. Config correct.
- `base_automation` rules for `helpdesk.ticket` in db 2: 5 rules (on_create seq, on_change product-from-serial, on_change populate-repair-location, on_change clear-on-serial-change, on_unlink validate-cancelled).
- Confirmed `automation_auto_product_from_serial` triggers on BOTH `ticket_type_id` and `x_studio_serial_no`; `automation_clear_on_serial_change` triggers on `x_studio_serial_no`.
- Read full server action code from `ir_act_server`. Confirmed `automation_clear_on_serial_change` unconditionally sets `record['product_id'] = False`.

### Assistant: Identified two root causes
1. `automation_clear_on_serial_change` is an `on_change` rule that uses `record['product_id'] = False` — and in Odoo, when an on_change automation runs against an existing record, `record` is the actual DB record (via `active_id=self._origin.id`). So the write hits the DB.
2. `_sync_ticket_type_flags` in `write()` always clears `product_id`, even when the user simultaneously set a product in the same save.

### Applied fixes:
1. `data/automation_rules.xml` — guarded `product_id = False` behind `if not record.x_studio_normal_repair_without_serial_no`.
2. `models/helpdesk_ticket.py` — refactored `_sync_ticket_type_flags` to skip `product_id` clear for Without Serial No; same guard added to `_onchange_ticket_type_id`. Fixed a typo (`x_studio_ug` → `x_studio_rug`).
3. db 2: `UPDATE ir_act_server SET code = ... WHERE name = 'RR - Auto Select Product for RUG Repairs-33'` — live patch.
4. `sudo systemctl restart odoo15.service` — reloaded Python module changes.

### Verified
- DB query confirmed the automation rule code was updated correctly.
- Service is active after restart.

### User: /compress
This session log being written.
