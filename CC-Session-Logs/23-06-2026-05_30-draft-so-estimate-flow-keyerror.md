# Session Log: 23-06-2026 05:30 - Draft SO Estimate Flow + KeyError Debug

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, Odoo17, serial onchange, base_automation rule 81, automation_clear_on_serial_change, suitable_product_ids, helpdesk_stock cascade, draft SO estimate flow, action_fsm_validate, fsm_validate_auto_confirm, action_confirm, Estimation Sent to Customer, Estimation Approval Received, web_read KeyError 10, many2one_data, stage_id, Playwright diag-serial-onchange, git ported branch
**Projects:** helpdesk_repair_custom (Odoo 17) — RUG repair flow: serial onchange + SO estimate workflow
**Outcome:** Fixed serial-onchange live population (disabled rogue Studio automation rule 81) and implemented draft-SO estimate approval flow (FSM auto-confirm blocked, ticket stages advance on sent/sale). Both committed/pushed. Mid-debugging a `web_read KeyError: 10` (stage_id on helpdesk.ticket) when session was compressed — root cause NOT yet confirmed.

## Decisions Made
- **Disable rule 81 in module XML** (`automation_clear_on_serial_change`, active=False) rather than deleting it — it's a zombie Studio duplicate that wiped product_id on every serial change. Keeping the record but inactive preserves XML id references.
- **Two-layer guard for serial product**: (1) `onchange_product_id` override skips the helpdesk_stock cascade when a serial is set; (2) `_compute_suitable_product_ids` override injects the serial's product into the suitable set — belt-and-suspenders so the product survives even for partners with no outgoing delivery history.
- **Block FSM auto-confirm via context flag**: FSM's `action_fsm_validate` calls `so.action_confirm()` with no context, so the existing `fsm_create_sale_order` guard never fired on task validation. Added `action_fsm_validate` override injecting `fsm_validate_auto_confirm=True`, checked in `action_confirm`.
- **Hide Mark As Done on draft/sent repair SO**: enforce that the technician cannot complete the task before the customer confirms the estimate.

## Key Learnings
- **Studio automation rules run AFTER Python @api.onchange methods** and can silently undo them. The execution order for `x_studio_serial_no` change was: (1) our `_onchange_serial_no` sets product=Samsung TV, (2) rule 79 also sets it, (3) **rule 81 clears it to False**. The combined onchange response returned to the client had product_id=false.
- **`_onchange_methods` registration**: `model._onchange_methods.get('x_studio_serial_no')` listed our method PLUS two `base_automation_onchange` closures from base_automation — that's how I found the rogue rules. Query: `env['helpdesk.ticket']._onchange_methods`.
- **Finding automation rule code**: `base.automation` in Odoo 17 has `action_server_ids` (NOT `action_ids`/`child_ids`/`code`). Iterate `rule.action_server_ids` → each has `.state` ('code'/'object_write') and `.code`. The `ir_act_server` row shares the same id as the base_automation only sometimes; the DB join `base_automation JOIN ir_act_server ON ba.id = ias.id` gave a WRONG action (a vCard download). Use ORM `action_server_ids`.
- **Automation rules are registry-cached**: after toggling `active`, must `docker restart odoo17` for the onchange method list to refresh. A module `-u` also re-activates XML-defined rules unless the XML itself says `active=False`.
- **web_read KeyError on Many2one**: `web/models/models.py:127` `vals = many2one_data[values[field_name]]` raises KeyError when the stored FK value isn't in `co_records.web_read()` output. `co_records = self[field_name]` so it should always contain the value — a KeyError implies the value's record is filtered out (access rule, inactive, or company mismatch). For our case the field is `stage_id=10` on helpdesk.ticket; 21 tickets sit at stage 10, all team "Customer Care", and stage 10 IS in that team. Root cause unconfirmed at compression time.
- **The Playwright "H3" verdict is a false negative**: when product_id was already set before the onchange, Odoo omits it from the diff (no change), so the spec's `serverReturnedProduct` check fails even though the DOM correctly shows the value. Check the DOM value, not the onchange diff.

## Solutions & Fixes
- **Serial onchange fix** (committed `25c8e8b`):
  - `data/automation_rules.xml`: `automation_clear_on_serial_change` → `<field name="active">False</field>`.
  - `models/helpdesk_ticket.py`: added `onchange_product_id` (guard: `if self.x_studio_serial_no: return`) and `_compute_suitable_product_ids` override (`@api.depends('partner_id','x_studio_serial_no')`, injects `serial.product_id` into suitable set).
  - DB also patched live: `UPDATE base_automation SET active=false WHERE id=81;` then `docker restart odoo17`.
  - Verified via Playwright `diag-serial-onchange.spec.ts` (ticket 109): DOM shows product_id=Samsung TV 55in, sale_order_id=S00001.
- **Draft SO estimate flow** (committed `563147b`):
  - `models/project_task.py`: `action_fsm_validate` override → `self.with_context(fsm_validate_auto_confirm=True)`; `_compute_mark_as_done_buttons` hides button when `so.x_studio_is_repair_order and so.state in ('draft','sent')`.
  - `models/sale_order.py`: `action_confirm` now checks `fsm_create_sale_order OR fsm_validate_auto_confirm` to skip repair SOs.
  - The `write()` hook on sale.order (already present) advances ticket: state→sent ⇒ "Estimation Sent to Customer"; state→sale ⇒ "Estimation Approval Received" via `_advance_ticket_stage`.
  - Verified server-side simulation: draft stays draft on FSM confirm; sent→stage 9; sale→stage 10. ✅
- **Deploy pattern**: `docker exec odoo17 python3 /usr/bin/odoo --config /etc/odoo/odoo.conf -u helpdesk_repair_custom -d odoo17 --stop-after-init --no-http --xmlrpc-port 8070` then `docker restart odoo17`; health `curl -s http://localhost:8169/web/health`.

## Files Modified
- `data/automation_rules.xml`: disabled `automation_clear_on_serial_change` (rule 81).
- `models/helpdesk_ticket.py`: `onchange_product_id` cascade guard + `_compute_suitable_product_ids` override (serial product injection). (Debug logging was added then removed.)
- `models/project_task.py`: `action_fsm_validate` override (context flag); `_compute_mark_as_done_buttons` draft/sent guard.
- `models/sale_order.py`: `action_confirm` checks `fsm_validate_auto_confirm` flag too.
- Git: 2 commits on branch `ported` — `25c8e8b` (serial fix + prior flow changes), `563147b` (FSM auto-confirm block). Both pushed to `origin/ported` (github.com/Jinasena-Pvt-Ltd/helpdesk_repair_custom).

## Setup & Config
- Container `odoo17` (web `http://localhost:8169` via Traefik, external `http://45.76.146.91:8169`), DB container `db17` (DB `odoo17`). Login `odoo`/`admin` (uid 2).
- Module: `/opt/docker/odoo17/custom_addons/helpdesk_repair_custom` (bind → `/mnt/custom_addons`). Git branch `ported`.
- Enterprise addons at `/mnt/enterprise` (e.g. `helpdesk_stock/models/helpdesk_ticket.py`, `industry_fsm_sale/models/project_task.py`).
- psql: `docker exec db17 psql -U odoo -d odoo17` (note: helpdesk_ticket.name is varchar, helpdesk_stage.name is jsonb → use `->>'en_US'`).
- Playwright: `/opt/playwright_repair_tests`; run `BASE_URL=http://localhost:8169 npx playwright test tests/<spec> --project=chromium --no-deps --reporter=list --timeout=180000`.
- Stages (team Customer Care): 1 New, 6 Sent to Factory, 7 Received at Factory, 8 Diagnosis, 9 Estimation Sent to Customer, 10 Estimation Approval Received, 11 Advance Received, 12 Repair Started, 13 Repair Completed, 14 Sent to Sales Centre, 15 Received at Sales Centre, 16 Handed Over, 17 Cancelled.
- Onchange automation rules on helpdesk.ticket: 79 "Auto Select Product for RUG Repairs" (active, sets product from serial), 80 "Auto Populate Repair Location", 81 "...-33" (NOW INACTIVE, was clearing product).

## Pending Tasks
- **PRIMARY OPEN ISSUE: `web_read KeyError: 10`** on `helpdesk.ticket` form load (`web/models/models.py:127`, many2one_data lookup). Field is `stage_id` (value 10 = "Estimation Approval Received"). 21 tickets at stage 10, all in team Customer Care, stage 10 is in that team's stage list and is active — so the obvious causes are ruled out. NEXT STEPS: (a) monkey-patch `web_read` to log the exact `field_name` + `field_spec` that fails (the shallow traceback doesn't name the field — confirm it really is stage_id vs another m2o whose value happens to be 10); (b) check the field_spec `context`/`domain` the CLIENT sends for stage_id (Studio view may pass a context that filters stages); (c) check `ir.model.access`/record rules for helpdesk.stage under the actual logged-in (non-superuser) user — superuser tests passed, so a group-restricted rule is the prime suspect; (d) test by loading ticket 140 form in browser as the real user while tailing `docker logs odoo17`.
- **Test-data cleanup INCOMPLETE**: `/tmp/test_so_flow3.py` accidentally committed (it lacked a rollback) — it created SO **S00136** (state=sale, task_id=61) and pushed **ticket 138** to stage 10 with both estimation flags True. The cleanup script `/tmp/fix_test_data.py` FAILED at `so.unlink()` ("cannot delete a sent/confirmed SO — cancel first"). Still TODO: `so.action_cancel()` then `unlink()` for S00136, set `task 61.sale_order_id=False`, revert ticket 138 to Diagnosis stage and clear `x_studio_estimation_sent_stage_updated`/`x_studio_estimation_approved_stage_updated`. NOTE: this stray stage-10 ticket 138 may itself be irrelevant to the KeyError (other legit tickets are also at stage 10).
- Browser-verify the draft-SO estimate flow end-to-end (the server simulation passed, but no Playwright run yet).
- Re-run the full regression specs in `/opt/playwright_repair_tests/tests`.

## Errors & Workarounds
- **Rogue Studio rule wiping product_id** → disable rule 81 (XML active=False + DB update) + restart. Root cause found by listing `_onchange_methods['x_studio_serial_no']` and dumping `action_server_ids[].code`.
- **`base.automation` ORM attribute errors**: no `.state`, `.code`, `.action_ids`, `.child_ids`, `.on_change_fields` — correct names are `action_server_ids`, `on_change_field_ids`. The DB join to `ir_act_server` by shared id returned the wrong action; trust the ORM relation.
- **FSM guard never fired**: `fsm_create_sale_order` context only set during SO creation, not during `action_fsm_validate`'s confirm. Added separate `fsm_validate_auto_confirm` flag.
- **`so.unlink()` UserError** on confirmed/sent SO → must `action_cancel()` first (cleanup script needs fixing).
- **Playwright false-negative "H3"** → the onchange diff omits unchanged fields; assert on DOM value instead.
- **psql UNION type mismatch / `->>` on varchar** → helpdesk_ticket.name is plain varchar (no `->>'en_US'`), helpdesk_stage.name is jsonb (needs it). Don't UNION jsonb with varchar.

## Key Exchanges
- User: "Sale order through the task should be created in draft and then when sent by email is clicked the ticket should change to sent to customer and then when the sale order is confirmed the ticket will say estimate approved" → implemented FSM auto-confirm block + verified stage advances.
- User: "update the repo" → committed/pushed serial fix (`25c8e8b`).
- User pasted `web_read KeyError: 10` traceback → began debugging; ruled out obvious stage/team/access causes via superuser script; not resolved when `/compress` invoked.

## Custom Notes
None

---

## Quick Resume Context
Working in `helpdesk_repair_custom` (Odoo 17, container `odoo17`/`db17`, module `/opt/docker/odoo17/custom_addons/helpdesk_repair_custom`, git branch `ported`, web `http://localhost:8169`, login `odoo`/`admin`). Two features were completed and pushed this session: (1) serial-onchange now live-populates product/SO — fixed by disabling rogue Studio automation rule 81 (`automation_clear_on_serial_change`) plus `onchange_product_id`/`_compute_suitable_product_ids` overrides; (2) draft-SO estimate flow — FSM auto-confirm blocked via `fsm_validate_auto_confirm` context so repair SOs stay draft; ticket advances to "Estimation Sent to Customer" on SO state→sent and "Estimation Approval Received" on state→sale. OPEN: a `web_read KeyError: 10` (stage_id) on helpdesk.ticket form load — superuser tests can't reproduce, so suspect a group-restricted record rule / client field_spec context on helpdesk.stage; next step is to monkey-patch `web_read` to log the failing field_name and load ticket 140 as the real user while tailing logs. Also pending: clean up accidentally-committed test data (SO S00136, ticket 138 at stage 10) — must `action_cancel()` before `unlink()`.

---

## Raw Session Log

### Session start — /resume
User ran `/resume`. Loaded memory index + 3 prior session logs. Confirmed project state: helpdesk_repair_custom Odoo 17, serial-onchange live-population blocker open. Web at localhost:8169, login odoo/admin.

### Task 1: Fix serial onchange (continue)
- Read `models/helpdesk_ticket.py` around `onchange_product_id` (578) and `_onchange_serial_no` (587). Found prior unverified override.
- Read `helpdesk_stock/models/helpdesk_ticket.py`: `suitable_product_ids` computed from partner sale/picking history; `onchange_product_id` wipes product if not in suitable set; `write()` also clears it.
- First attempt: inject serial product into `suitable_product_ids` inside `_onchange_serial_no` → FAILED (computed field recomputes).
- Second attempt: override `_compute_suitable_product_ids` to always include serial product → still FAILED (browser product_id=false).
- Added debug logging to `_onchange_serial_no`, `_compute_suitable_product_ids`, `onchange_product_id`. Server-side `.new()` trace showed onchange returns product=Samsung TV correctly.
- Playwright `diag-serial-onchange.spec.ts` (ticket 109) showed: `_onchange_serial_no` sets product=Samsung TV (logged), then `_compute_suitable` re-runs with product_id=False — something wiped it between.
- Discovered our `onchange_product_id` override NEVER logged → not being called. Listed `_onchange_methods['x_studio_serial_no']` → found TWO `base_automation_onchange` closures.
- Queried `base_automation`: rules 79, 80, 81 on helpdesk.ticket on_change. Rules 79 & 81 watch x_studio_serial_no.
- Got `action_server_ids[].code`: Rule 79 sets product from serial (good); **Rule 81 ("...-33") clears product_id/sale_order_id/lot_id/sn_updated** — the culprit.
- Fix: `UPDATE base_automation SET active=false WHERE id=81;` + restart. Playwright then showed product_id=Samsung TV 55in, sale_order_id=S00001 ✅.
- Cleaned debug logging. Set `active=False` in `data/automation_rules.xml` so module `-u` won't re-enable rule 81. Redeployed, re-verified ✅.

### Task 2: update the repo
- `git status` on branch `ported`: 9 modified files + untracked CC-Session-Logs.
- Committed `25c8e8b` "Fix serial-onchange live population + repair flow changes" (9 files). Pushed to origin/ported.

### Task 3: Draft SO estimate flow
- User requested: SO created via task → draft; Send by Email → ticket "Sent to Customer"; SO confirmed → ticket "Estimate Approved".
- Read `sale_order.py`: `action_confirm` already had `fsm_create_sale_order` guard + `write()` hook advancing ticket on sent/sale. But all existing repair SOs were state=sale.
- Found FSM `action_fsm_validate` (industry_fsm_sale) calls `so.action_confirm()` with no context → guard never fired.
- Added `action_fsm_validate` override in `project_task.py` injecting `fsm_validate_auto_confirm=True`; updated `action_confirm` to check it; added Mark-As-Done hide for draft/sent repair SO.
- Deployed. Server simulation (`test_so_flow3.py`): created SO S00136 on task 61, FSM-confirm kept it draft ✅, state→sent advanced ticket 138 to "Estimation Sent to Customer" ✅, state→sale advanced to "Estimation Approval Received" ✅. (Script lacked rollback → committed test data.)
- Committed `563147b` "Block FSM auto-confirm on repair SOs; enforce estimate flow" (2 files). Pushed.

### Task 4: web_read KeyError: 10 (IN PROGRESS at compression)
- User pasted traceback: `web/models/models.py:127 vals = many2one_data[values[field_name]] KeyError: 10` on `helpdesk.ticket/web_read`.
- Identified record 10 = helpdesk_stage "Estimation Approval Received". 21 tickets at stage 10, all team Customer Care; stage 10 in that team & active.
- Ran multiple superuser scripts — could NOT reproduce the gap (stage 10 present in co_records). Checked other custom m2o fields for value 10: only lot_id had 1 hit (unrelated).
- Discovered test-data side effect: S00136 (sale), ticket 138 at stage 10; cleanup script failed on `so.unlink()` (must cancel first).
- Not resolved when user ran `/compress`.
