# Session Log: 26-05-2026 09:00 - validate-diagnosis-button

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, v15.0.1.15, Validate Diagnosis button, project.task, x_studio_diagnosis_validated, x_studio_repair_image_01, x_studio_repair_image_02, x_studio_diagnosis_ids, action_validate_diagnosis, UserError, Products smart icon, action_fsm_view_material, industry_fsm_sale, _compute_mark_as_done_buttons, readonly gate, odoo_repair_fresh, db 2
**Projects:** helpdesk_repair_custom on Odoo 15, db 2 = odoo_repair_fresh
**Outcome:** Added a Validate Diagnosis header button on project.task that requires at least one repair image and one diagnosis line; on success sets `x_studio_diagnosis_validated=True`, locks both the repair images and the diagnosis tree read-only, and reveals the upstream Products smart icon (`action_fsm_view_material`). Existing Mark-as-Done gate (all outgoing pickings done) kept untouched. v15.0.1.14 → v15.0.1.15.

## Decisions Made
- **"At least 1 repair image" = either x_studio_repair_image_01 OR x_studio_repair_image_02.** Reason: user explicitly chose "either slot counts" for flexibility. Validation uses `not (img_01 or img_02)`.
- **Button location: form header next to Mark as Done**, with `class="btn-primary"`. Reason: user chose this over notebook/smart-button-row placement; matches existing flow-button visual style.
- **One-way validation flag, not auto-reset compute.** Reason: user said "after the validate button is clicked user shouldn't be able to remove the images or edit the diagnosis lines" — implies hard lock, not a dynamic compute. Implemented as `Boolean(copy=False, default=False)` with no inverse path. Same pattern as `x_studio_valid_delivered_so2`.
- **Lock the diagnosis One2many via field-level `attrs="{'readonly': [...]}"`, not row-level attrs.** Reason: setting `readonly` on the field collapses to no add/edit/delete handles on the tree, which is the cleanest "frozen after validate" experience.
- **Warranty Details tab NOT locked.** Reason: user-specified scope was diagnosis lines + repair images only; warranty card/related-info stays editable.
- **Products smart icon gated via a SECOND view inherit, not by modifying the existing repair-tabs inherit.** Reason: separation of concerns — the existing record adds notebook pages, the new record only patches the upstream button's `attrs`. Easier to revert/refactor.
- **`industry_fsm_sale` added to manifest depends explicitly.** Reason: the new view inherits a node owned by that addon (`//button[@name='action_fsm_view_material']`). It was previously pulled transitively through `helpdesk_fsm`; declaring it directly enforces load order.
- **Mark-as-Done gate left untouched.** Reason: `_compute_mark_as_done_buttons` at `models/project_task.py:50-65` already hides both display flags until all outgoing pickings on the SO reach state='done'. User's restated requirement was identical to the existing implementation.

## Key Learnings
- **The Products stat button on project.task is owned by `industry_fsm_sale`, NOT `industry_fsm`** — file `/opt/odoo15/odoo/addons/industry_fsm_sale/views/project_task_views.xml:164-175`, button name `action_fsm_view_material`, counter `material_line_product_count`. The `industry_fsm` addon contributes Mark-as-Done but not the Products icon.
- **`xpath`-ing into a button declared by another addon requires that addon to be loaded first** — controlled via the manifest `depends` list. If only the transitive dependency exists (via `helpdesk_fsm`), load order is not guaranteed. Best practice: add explicit depends when xpath-ing a node from that addon.
- **Field-level `attrs="{'readonly': [...]}"` on a One2many automatically disables row add/edit/delete in `editable="bottom"` trees** — no need to also set `create="false"`/`edit="false"`/`delete="false"` on the inner `<tree>` tag. The two are equivalent for this use case.
- **Existing UserError style in this module is plain-string, no `_()` wrapper, `%`-formatted** — matched in `stock_picking.py:120-123`. Followed the same convention here.
- **The `force_save="True"` attribute on the diagnosis One2many is independent of `readonly`** — it controls whether the field is included in writes even when readonly. Leaving it in place is safe; the readonly gate fully blocks user interaction at the UI level.
- **`<sheet>` is the right XPath target for invisible-field stash** — adding `<field name="x_studio_diagnosis_validated" invisible="1"/>` inside `//sheet` makes it available to attrs evaluators on both header buttons (above sheet) and tab fields (inside sheet). Odoo 15 evaluates view attrs against any field in the form regardless of XML location.

## Solutions & Fixes

### 1. Field + button method on project.task
`models/project_task.py`:
```python
from odoo.exceptions import UserError  # new import

x_studio_diagnosis_validated = fields.Boolean(
    string='Diagnosis Validated', copy=False, default=False)

def action_validate_diagnosis(self):
    self.ensure_one()
    missing = []
    if not (self.x_studio_repair_image_01 or self.x_studio_repair_image_02):
        missing.append("- At least one Repair Image (slot 1 or slot 2)")
    if not self.x_studio_diagnosis_ids:
        missing.append("- At least one Repair Diagnosis line")
    if missing:
        raise UserError(
            "Please add the following before validating diagnosis:\n"
            + "\n".join(missing))
    self.x_studio_diagnosis_validated = True
```

### 2. Header button (visibility: not yet validated AND has ticket)
`views/project_task_views.xml` — into existing `view_task_form_repair_tabs`:
```xml
<xpath expr="//header" position="inside">
    <button name="action_validate_diagnosis"
            string="Validate Diagnosis"
            type="object"
            class="btn-primary"
            attrs="{'invisible': ['|',
                    ('x_studio_diagnosis_validated', '=', True),
                    ('helpdesk_ticket_id', '=', False)]}"/>
</xpath>
```
Also added `<field name="x_studio_diagnosis_validated" invisible="1"/>` inside `//sheet` next to the existing hidden `helpdesk_ticket_id`.

### 3. Readonly locks after validation
Repair Image tab fields and the diagnosis One2many — same attrs pattern:
```xml
attrs="{'readonly': [('x_studio_diagnosis_validated', '=', True)]}"
```
Applied to `x_studio_repair_image_01`, `x_studio_repair_image_02`, and `x_studio_diagnosis_ids` (Warranty Details untouched).

### 4. Products smart icon gate (separate view record)
`views/project_task_views.xml` — new record below the existing one:
```xml
<record id="view_task_form_products_gate" model="ir.ui.view">
    <field name="name">project.task.form.inherit.products.gate</field>
    <field name="model">project.task</field>
    <field name="inherit_id" ref="project.view_task_form2"/>
    <field name="arch" type="xml">
        <xpath expr="//button[@name='action_fsm_view_material']" position="attributes">
            <attribute name="attrs">{'invisible': ['|', '|',
                ('partner_id', '=', False),
                ('allow_material', '=', False),
                ('x_studio_diagnosis_validated', '=', False)]}</attribute>
        </xpath>
    </field>
</record>
```
Preserves upstream `partner_id`/`allow_material` gates; adds the new diagnosis-validated condition.

### 5. Manifest changes
- Added `'industry_fsm_sale'` to `depends` list (between `helpdesk_fsm` and `helpdesk_stock`).
- Bumped `version` from `15.0.1.14` to `15.0.1.15`.

### 6. Update + restart (clean)
```
sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin \
  -c /etc/odoo15.conf -d odoo_repair_fresh \
  --update=helpdesk_repair_custom --stop-after-init
# EXIT: 0
sudo systemctl restart odoo15 && sleep 5 && sudo systemctl is-active odoo15
# active
```

## Files Modified
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/__manifest__.py` — added `industry_fsm_sale` to depends; version 15.0.1.14 → 15.0.1.15.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/project_task.py` — added `UserError` import; added `x_studio_diagnosis_validated` Boolean field; added `action_validate_diagnosis()` method (between `_compute_x_studio_so_fully_paid` and `_compute_mark_as_done_buttons`).
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/views/project_task_views.xml` — added hidden `x_studio_diagnosis_validated` field in sheet; added header button via new `//header` xpath; added `readonly` attrs on `x_studio_repair_image_01`, `x_studio_repair_image_02`, and the diagnosis One2many; added second view record `view_task_form_products_gate` that xpaths `action_fsm_view_material` and replaces its `attrs`.
- `/root/.claude/plans/in-the-project-task-add-validated-snowflake.md` — plan file (kept for reference).

## Setup & Config
- **DB updated:** db 2 = `odoo_repair_fresh` only. db 1 (production) NOT yet touched — mirror after UI verification.
- **Service:** `odoo15.service` via systemd, active.
- **No schema migration concerns:** new Boolean field defaults to False, copy=False (won't get carried into duplicated tasks).

## Pending Tasks
- **End-to-end UI verification on db 2** (per plan §Verification):
  1. Open FSM task linked to a helpdesk ticket — confirm primary Validate Diagnosis button visible, Products smart icon hidden.
  2. Empty tabs → click button → UserError lists both missing items.
  3. Add only image → UserError lists missing diagnosis.
  4. Add only diagnosis → UserError lists missing image.
  5. Add both → click → button disappears; Products icon appears; image widgets + diagnosis tree visibly read-only.
  6. Reload form → state persists.
  7. Mark as Done still hidden until all outgoing deliveries done (regression).
  8. Non-FSM project.task (no helpdesk_ticket_id) → button hidden.
- **Mirror to db 1 (production)** after db 2 verification passes. Production may have a Studio version of the diagnosis tab — check for collisions before deploying.
- **Carry-over from previous session (25-05):** End-to-end UI walkthrough of the three-delivery / dispatch return flow was never marked verified. Still pending.

## Errors & Workarounds
- **First `--update` command run produced no visible output** in this session (Bash returned empty). Re-ran with explicit `echo "EXIT: $?"` appended — returned `EXIT: 0` confirming clean execution. No actual error; appears to have been a terminal-capture quirk on the first invocation. Worth knowing the pattern: when an Odoo update command shows no output, re-run with an explicit exit-code echo to disambiguate "silent success" from "stuck".
- **No Odoo errors during update or restart.** Module loaded cleanly; service came back active in <5s.

## Key Exchanges
- User stated requirement in one message: "In the project.task, add a button called validate diagnosis. the function of this button is to check if at least 1 repair image and one line of reapair diagnosis is added. if not a user error needs to popup reminding the user to add the following details. The product`s smart icon should be invisble until validation is done. The mark as done button should also be invisible till the deliveries in the sales order are confirmed".
- Two parallel Explore agents mapped the codebase: existing `_compute_mark_as_done_buttons` override already satisfies the Mark-as-Done gate; Products smart icon lives in `industry_fsm_sale`, not added by this module; Repair Image stored as two Binary fields directly on `project.task`; diagnosis is a One2many to `x_task_diagnosis`.
- Three clarifying questions asked via AskUserQuestion: image rule (chose: either slot), button location (chose: header), re-validation behavior — user answered the last with a directive instead of choosing an option: "After the validate button is clicked user shouldn't be able to remove the images or edit the diagnosis lines". This drove the readonly-lock design.
- Plan written to `/root/.claude/plans/in-the-project-task-add-validated-snowflake.md`, ExitPlanMode approved.
- Implementation: 4 edits across 3 files. Update clean, service active.

## Custom Notes
None

---

## Quick Resume Context
On `helpdesk_repair_custom` v15.0.1.15 on db 2 (`odoo_repair_fresh`). This session added a Validate Diagnosis gate to the FSM `project.task` form: a header button that requires ≥1 repair image (either x_studio_repair_image_01 or _02) and ≥1 `x_studio_diagnosis_ids` line, raises UserError listing what's missing, and on success sets `x_studio_diagnosis_validated=True`. That flag locks the repair images and diagnosis tree read-only (Warranty Details tab unaffected) and reveals the upstream Products smart icon (`action_fsm_view_material`, owned by `industry_fsm_sale` — now an explicit depend). Mark-as-Done gate (all outgoing pickings done) was left untouched since the existing `_compute_mark_as_done_buttons` override already implements it. Next: end-to-end UI walkthrough on db 2, then mirror to production db 1 along with the still-unverified 25-05 three-delivery / dispatch flow.
