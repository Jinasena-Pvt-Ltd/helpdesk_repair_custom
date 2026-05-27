# Session Log: 27-05-2026 05:01 - lock-diagnosis-tab-dropdowns

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, v15.0.1.22, project_task_views.xml, x_studio_diagnosis_ids, Repair Diagnosis tab, no_create, no_quick_create, options attribute, many2one dropdown, embedded one2many tree, x_studio_diagnosis_area, x_studio_diagnosis_code, x_studio_reason, x_studio_sub_reason, x_studio_resolution, x_studio_repair_stage, x_studio_condition, x_studio_symptom_area, x_studio_symptom_code, master-data lock, odoo_repair_fresh
**Projects:** helpdesk_repair_custom on Odoo 15, db 2 = odoo_repair_fresh
**Outcome:** Locked all 9 Many2one dropdowns in the embedded Repair Diagnosis tab (on `project.task` form) so users can only select pre-existing master-data records, not create new ones inline. Added `options="{'no_create': True, 'no_quick_create': True}"` to each m2o `<field>` in the inline tree. Module bumped 15.0.1.21 → 15.0.1.22, update clean, service active. Companion change to the prior session's master-data menu port — guarantees the new menus are the only path for creating lookup values.

## Decisions Made
- **Lock both create paths**, not just one. Used `{'no_create': True, 'no_quick_create': True}` (paired):
  - `no_create: True` hides "Create and edit…" link in the dropdown (which opens the full form popup)
  - `no_quick_create: True` hides the inline "Create '<typed text>'" option that appears when the user types a non-matching value
  Either flag alone leaves one create path open; both are needed to fully lock the dropdown to existing values.
- **Apply to all 9 lookup m2o fields** in the tree, even ones currently `invisible="1"` (`x_studio_condition`, `x_studio_symptom_area`, `x_studio_symptom_code`). Reason: those fields are toggleable via the column's `optional="show"` — a user could enable them and then create on-the-fly. Defense in depth.
- **Do NOT touch `x_studio_task_id`** — it's the inverse field of the One2many and is always invisible; its value is auto-set when a row is created on the parent task. No user-facing dropdown.
- **No view inheritance / no separate form view for the dialog**. The `no_create` change is on the *field declarations inside the embedded tree*, which is the right surface for editable="bottom" trees. No need to define a separate Form/dialog view for the rows.
- **No model-level constraint added**. The UI block is sufficient for the user's intent ("user shouldn't be able to create"). A `models.Model` create-time check would be defensive overkill — admin/portal/API paths legitimately need to create rows.

## Key Learnings
- **`no_create` ≠ `no_quick_create`** in Odoo 15 many2one widgets. `no_create` is the umbrella option that disables BOTH paths in most cases, but the inline "Create '...'" quick-create can still appear in some widget variants. Using both together is the belt-and-braces safe form. Verified pattern: `options="{'no_create': True, 'no_quick_create': True}"`.
- **`options` is a per-field attribute, not a per-record attribute.** It evaluates as a Python literal dict at view-parse time. Newlines inside the value are allowed in XML attribute syntax (escaping not required for our simple keys).
- **Editable trees inherit field options from the field XML, not from the parent record's form view.** That's why we set the options on each `<field>` inside `<tree editable="bottom">` directly, not on the parent `<field name="x_studio_diagnosis_ids">`.
- **`optional="show"` columns are still subject to all the same field options** when the user toggles them on. So locking only the visible ones would have left a backdoor.

## Solutions & Fixes

### Edit applied to `views/project_task_views.xml` (page "Repair Diagnosis")
Added `options="{'no_create': True, 'no_quick_create': True}"` to the 9 m2o fields inside the embedded `x_studio_diagnosis_ids` tree:

| Field | Target model | Visibility |
|---|---|---|
| `x_studio_condition` | `x_conditions` | invisible (toggleable) |
| `x_studio_symptom_area` | `x_symptom_areas` | invisible (toggleable) |
| `x_studio_symptom_code` | `x_symptom_codes` | invisible (toggleable) |
| `x_studio_diagnosis_area` | `x_diagnosis_areas` | visible |
| `x_studio_diagnosis_code` | `x_diagnosis_codes` | visible (also has cascading domain on `x_studio_diagnosis_area_1`) |
| `x_studio_reason` | `x_repair_reason` | visible |
| `x_studio_sub_reason` | `x_repair_sub_reason` | visible (also has cascading domain on `x_studio_reason_code`) |
| `x_studio_resolution` | `x_resolutions` | visible |
| `x_studio_repair_stage` | `x_repair_stages` | visible |

`x_studio_task_id` left untouched (auto-populated, invisible).

### Manifest bump
`'version': '15.0.1.21'` → `'15.0.1.22'` in `__manifest__.py`. No new data files; no model/security changes.

### Update + restart
```
sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin \
  -c /etc/odoo15.conf -d odoo_repair_fresh \
  --update=helpdesk_repair_custom --stop-after-init
# EXIT: 0

sudo systemctl restart odoo15 && sleep 5 && sudo systemctl is-active odoo15
# active
```

## Files Modified
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/views/project_task_views.xml` — added `options="{'no_create': True, 'no_quick_create': True}"` to 9 fields inside the `<tree editable="bottom">` block at lines 55-71 (page `studio_page_M5qFQ`, "Repair Diagnosis"). No other changes.
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/__manifest__.py` — `version` 15.0.1.21 → 15.0.1.22.

## Setup & Config
- **DB updated:** db 2 (`odoo_repair_fresh`) only. db 1 (`odoo`, production) NOT touched — production has Studio-authored versions of this view that would need separate decision-making.
- **Service:** `odoo15.service` via systemd, active after restart.
- **No new dependencies, security entries, or data files.**

## Pending Tasks
- **End-to-end UI verification on db 2**:
  - Open a Repair-type task (linked to a helpdesk ticket) → Repair Diagnosis tab
  - Type a non-matching value in each m2o dropdown — confirm NO "Create '...'" inline option appears
  - Hover the dropdown — confirm NO "Create and edit..." link in the footer
  - Selecting existing values still works normally
  - Cascading domains still functional (Diagnosis Code filtered by Area; Sub Reason filtered by Reason)
- **Production mirror (db 1)** of v15.0.1.20–.22 still deferred. Production has Studio-authored versions of both the master-data menus AND the embedded tab fields. Mirror strategy still undecided (overwrite Studio / use noupdate / migrate Studio records to claim module xml_ids).
- **Carry-over from prior sessions**: end-to-end UI verification of v15.0.1.13, .15, .17, .18, .19, .20, .21 still outstanding.

## Errors & Workarounds
- **None during this session.** Single edit, clean update (EXIT 0), no view-parsing errors, service came back active in <5s.
- **Plan mode re-entry message appeared automatically** when this session continued from the prior `/compress`. The user's actual command was `/compress` (a session-save meta-workflow), not a new planning task. Proceeded with `/compress` instead of editing the prior plan file, because the request is not a code-change task. The prior plan file (`/root/.claude/plans/there-is-a-menu-cozy-bengio.md`) covers the master-data menu port and is not relevant here.

## Key Exchanges
- User: "The user shouldn't be able to create new reasons from the repair diagnosis tab in task. It should only show the drop downs of the data added in the menu items in repair diagnosis"
- Interpreted requirement: lock the embedded m2o dropdowns on `project.task` form → Repair Diagnosis tab to existing values only. Applied `no_create + no_quick_create` to all 9 lookup m2os in the editable inline tree. One file edit, one manifest bump, one update + restart. Verified clean exit.

## Custom Notes
None

---

## Quick Resume Context
On `helpdesk_repair_custom` v15.0.1.22 on db 2 (`odoo_repair_fresh`). This session completes the master-data lockdown started in v15.0.1.21: the new "Repair Diagnosis" menu (Conditions, Symptom Areas/Codes, Diagnosis Areas/Codes, Repair Reason, Repair Reason - Customer, Repair Sub Reason, Resolutions, Repair Stages, Task Diagnosis) is now the only path for users to create lookup values. The embedded Repair Diagnosis tab on `project.task` (page `studio_page_M5qFQ`, inline tree on `x_studio_diagnosis_ids`) had `options="{'no_create': True, 'no_quick_create': True}"` added to all 9 Many2one fields, blocking both the "Create '...'" quick-create option and the "Create and edit..." popup link. Single file change in `views/project_task_views.xml`; manifest version bumped; module update clean; service active. UI walkthrough on db 2 still pending; production mirror still deferred.

---

## Raw Session Log

### User: The user shouldn't be able to create new reasons from the repair diagnosis tab in task. It should only show the drop downs of the data added in the menu items in repair diagnosis

**Assistant action:** Read the relevant tree block in `views/project_task_views.xml` (lines 51-73, page "Repair Diagnosis", embedded `<tree editable="bottom">` on `x_studio_diagnosis_ids`). Identified 9 Many2one fields needing the lock:
- `x_studio_condition`, `x_studio_symptom_area`, `x_studio_symptom_code` (invisible but toggleable via `optional="show"`)
- `x_studio_diagnosis_area`, `x_studio_diagnosis_code` (cascading domain), `x_studio_reason`, `x_studio_sub_reason` (cascading domain), `x_studio_resolution`, `x_studio_repair_stage` (visible)

`x_studio_task_id` was left alone (inverse field, auto-set, always invisible).

Applied a single Edit operation replacing the entire `<tree editable="bottom">…</tree>` block with the same content plus `options="{'no_create': True, 'no_quick_create': True}"` on each of the 9 m2o fields. Preserved the existing `required="1"`, `optional="show"`, `invisible="1"`, and cascading `domain="..."` attributes verbatim.

Bumped `__manifest__.py` `version` from `'15.0.1.21'` to `'15.0.1.22'`.

Ran:
```
sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin \
  -c /etc/odoo15.conf -d odoo_repair_fresh --update=helpdesk_repair_custom --stop-after-init
# EXIT: 0
sudo systemctl restart odoo15 && sleep 5 && sudo systemctl is-active odoo15
# active
```

Reported back: v15.0.1.22 shipped; both create paths blocked on all 9 dropdowns; users can only select from values entered via the Repair Diagnosis master-data menus.

### User: /compress
Running session log save workflow. Plan-mode re-entry message was automatic; this session log is not a planning artefact, so proceeded with the standard /compress flow rather than editing the prior plan file.
