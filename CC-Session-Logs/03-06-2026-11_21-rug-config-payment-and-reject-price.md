# Session Log: 03-06-2026 11:21 - rug-config-payment-and-reject-price

## Quick Reference (for AI scanning)
**Confidence keywords:** helpdesk_repair_custom, v15.0.1.36, v15.0.1.37, v15.0.1.38, RUG, Update RUG Account, Register Payment, Reject RUG, x_repair_accounts, x_studio_company_id, x_studio_rug_account, action_update_rug_account, action_reject_rug, payment_state, in_payment, stale payment_state, _compute_payment_state, x_studio_price_unit_original, price_unit, pricelist restore, INV/2026/00030, RG006, account_move.py, sale_order.py, repair_accounts.py, account_move_views.xml, db 2 = odoo_repair_fresh
**Projects:** helpdesk_repair_custom on Odoo 15, db 2 = odoo_repair_fresh, db 1 = odoo (production, untouched)
**Outcome:** Three bumps fixing RUG-flow follow-ups after the v1.32 port. v1.36 fixed the "RUG Account must be Specified in Repair Accounts" UserError (missing company default on `x_repair_accounts.x_studio_company_id` + company-less fallback in the button's search + data fix). v1.37 fixed Register Payment missing on INV/2026/00030 (stale `payment_state='in_payment'` after the draft→post cycle, plus an incorrect RUG clause in our v1.32 Register Payment attrs that production never had — removed). v1.38 made Reject RUG restore line prices from `x_studio_price_unit_original` (pricelist price) instead of leaving cost prices.

## Decisions Made
- **v1.36 fix = field default + search fallback + data fix, keep the view readonly.** Production Studio's `x_studio_company_id` had a company default that the 1:1 port dropped; restored it as `default=lambda self: self.env.company`. User chose to ALSO add a company-less fallback search in `action_update_rug_account` (search company-specific first, then `x_studio_company_id = False`) — slight divergence from production's strict search, accepted for robustness on fresh DBs.
- **Deleted the duplicate `RUG` x_repair_accounts record (id 2)** created by the user on 03-06 as a failed workaround; fixed company on the original `Repair Accounts - JLD` (id 1) instead. User picked "Fix JLD, delete RUG".
- **Data fix done via one-off SQL, not module code** — instance config data, not module-owned.
- **v1.37: removed the RUG clause from Register Payment attrs entirely** rather than tweaking it. Verified against production db 1: the production Register Payment button is bone-stock Odoo with NO RUG conditions — the `rug_confirmed AND rug_acc_updated → hide` clause added in v1.32 ("Gap B") was simply wrong, not a faithful port.
- **v1.37: recompute payment_state in code AND reset the stale row via SQL.** Added `self._compute_payment_state()` after `action_post()` inside `action_update_rug_account` so future invoices don't go stale; the already-stale INV/2026/00030 was reset `in_payment → not_paid` by direct UPDATE.
- **v1.38: restore-on-reject reads `x_studio_price_unit_original`,** the field where the on-create price-swap automation stashed the original pricelist price before overwriting `price_unit` with cost. Guard `if line.x_studio_price_unit_original:` skips lines the automation never touched. No new fields, no automation changes — one loop in `action_reject_rug`.

## Key Learnings
- **Studio field defaults are silently dropped by 1:1 ports** — same class of bug as the v1.28 "Studio automation gap". Production's `x_studio_company_id` records were populated only because Studio's field definition carried a company default; the module field had none, and the form view renders the field `readonly="1"`, so users could not even self-serve a fix. Any ported `x_studio_*` many2one to res.company should be suspected of having had `default=lambda self: self.env.company` in Studio.
- **`button_draft()` → write → `action_post()` cycles can leave `payment_state` stale.** `button_draft()` tears down reconciliation, but after re-posting, the stored compute `payment_state` was left at `'in_payment'` with zero payments/reconciliations on the receivable line. Explicit `self._compute_payment_state()` after `action_post()` fixes it. Diagnostic signature: `payment_state='in_payment'` but `account_partial_reconcile` has no rows for the move and the receivable line has `reconciled=f, payment_id=NULL`.
- **Always verify "matches prod" claims against db 1 before trusting v1.32 view attrs.** The v1.32 commit comment claimed the Register Payment RUG gate "matches prod" — querying `ir_ui_view` on db 1 (`arch_db ILIKE '%action_register_payment%'`) showed production has no such customization. The port introduced behaviour production never had.
- **The RUG price-swap is reversible by design**: the on-create automation (`automation_rug_so_price_swap`) stores the pricelist price in `x_studio_price_unit_original` before writing cost into `price_unit`, and only swaps lines where the original field is empty (idempotent). Rejection restoring from that field closes the loop.
- **psql column quirks this session:** `account_payment` has no `name`, `state` or `date` columns in this schema (those live on the related `account_move`); `cd` permission-denied noise from `/opt/odoo15/custom-addons/helpdesk_repair_custom` as postgres user is harmless.

## Solutions & Fixes

### 1. v15.0.1.36 — "RUG Account must be Specified in Repair Accounts"
Root cause: `action_update_rug_account` searches `[('x_studio_company_id','=',company.id)]` but both db-2 `x_repair_accounts` records had NULL company (no field default; view field readonly).

- `models/repair_accounts.py` — `x_studio_company_id` now has `default=lambda self: self.env.company`.
- `models/account_move.py` — fallback search added:
```python
rug_account_rec = self.env['x_repair_accounts'].search(
    [('x_studio_company_id', '=', company.id)], limit=1)
if not rug_account_rec:
    rug_account_rec = self.env['x_repair_accounts'].search(
        [('x_studio_company_id', '=', False)], limit=1)
```
- Data fix (db 2):
```sql
UPDATE x_repair_accounts SET x_studio_company_id = 1 WHERE id = 1;  -- JLD
DELETE FROM x_repair_accounts WHERE id = 2;                          -- duplicate 'RUG'
```
RUG account on db 2 = account id 1 (`RG006 R.U.G. - REPAIRS`), matching production JLD's account 1361 (same code RG006).

### 2. v15.0.1.37 — Register Payment missing on INV/2026/00030 (two stacked causes)
- **Stale payment_state:** invoice 61 was `posted`, `amount_residual=100.00`, receivable line unreconciled, no payments — yet `payment_state='in_payment'` (left over from the draft→post cycle in Update RUG Account). Standard Odoo attrs hide Register Payment unless `payment_state in ('not_paid','partial')`.
  - Code: added `self._compute_payment_state()` after `self.action_post()` in `action_update_rug_account`.
  - Data: `UPDATE account_move SET payment_state = 'not_paid' WHERE id = 61 AND payment_state = 'in_payment';`
- **Wrong v1.32 attrs:** removed the whole "Gap B" xpath from `views/account_move_views.xml` that hid Register Payment when `x_studio_rug_confirmed AND x_studio_rug_acc_updated` — production has no such gate (verified via db 1 `ir_ui_view` query).

### 3. v15.0.1.38 — Reject RUG restores pricelist prices
`models/sale_order.py` — `action_reject_rug` now ends with:
```python
for line in order.order_line:
    if line.x_studio_price_unit_original:
        line.price_unit = line.x_studio_price_unit_original
```
Reverses the on-create swap (cost ← pricelist) for rejected RUG orders.

### 4. Deploy cycle used for each version (EXIT 0 each time)
```bash
sudo -u odoo15 /opt/odoo15/myodoo15-venv/bin/python /opt/odoo15/odoo/odoo-bin \
  -c /etc/odoo15.conf -d odoo_repair_fresh \
  --update=helpdesk_repair_custom --stop-after-init 2>&1 | tail -5
sudo systemctl restart odoo15 && sleep 5 && sudo systemctl is-active odoo15
```

### 5. Diagnostic queries that cracked the cases
```sql
-- v1.36: records exist but no company
SELECT * FROM x_repair_accounts;  -- both rows x_studio_company_id NULL

-- v1.37: stale in_payment with no reconciliation
SELECT id, name, payment_state, state, amount_residual FROM account_move WHERE name='INV/2026/00030';
SELECT aml.id, aa.code, aml.debit, aml.credit, aml.reconciled, aml.payment_id
FROM account_move_line aml JOIN account_account aa ON aa.id=aml.account_id WHERE aml.move_id=61;
SELECT * FROM account_partial_reconcile apr
JOIN account_move_line adm ON adm.id=apr.debit_move_id
JOIN account_move_line acm ON acm.id=apr.credit_move_id
WHERE adm.move_id=61 OR acm.move_id=61;  -- 0 rows

-- v1.37: prove production has no RUG gate on Register Payment
SELECT id, name, arch_db FROM ir_ui_view
WHERE model='account.move' AND arch_db ILIKE '%action_register_payment%';  -- on db 1
```

## Files Modified
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/repair_accounts.py` — `x_studio_company_id` gained `default=lambda self: self.env.company`. (v1.36)
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/account_move.py` — `action_update_rug_account`: company-less fallback search (v1.36); `self._compute_payment_state()` after re-post (v1.37).
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/views/account_move_views.xml` — removed the "Gap B" Register Payment attrs override entirely (v1.37).
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/models/sale_order.py` — `action_reject_rug` restores `price_unit` from `x_studio_price_unit_original` (v1.38).
- `/opt/odoo15/custom-addons/helpdesk_repair_custom/__manifest__.py` — version 15.0.1.35 → .36 → .37 → .38.
- `/root/.claude/plans/when-clicking-the-button-breezy-beaver.md` — plan for the v1.36 fix.

## Setup & Config
- **DB**: db 2 (`odoo_repair_fresh`) only; db 1 (`odoo`, production) read-only for comparison queries.
- **One-off SQL applied to db 2**: x_repair_accounts company fix + duplicate delete; account_move 61 payment_state reset. Neither is module-owned data.
- **db 2 single company**: id 1 "My Company". RUG account: id 1 `RG006 R.U.G. - REPAIRS`.
- **Service**: `odoo15.service`; venv `/opt/odoo15/myodoo15-venv/`; config `/etc/odoo15.conf`.

## Pending Tasks
- **UI verification of all three fixes on db 2**: (1) Update RUG Account button works without error; (2) Register Payment visible on INV/2026/00030 after refresh; (3) Reject RUG restores pricelist prices on order lines.
- **Watch the `automation_validate_rug_invoice` automation** (`data/automation_rules.xml:174-199`): it deliberately sets `payment_state='in_payment'` on RUG invoices (posted + acc_updated + SO done). This may be the actual origin of invoice 61's `in_payment` rather than the draft→post cycle — if `in_payment` reappears on RUG invoices after the automation fires, the automation and the restored Register Payment button are in tension and need reconciling (is RUG invoice supposed to be paid normally, or auto-settled?).
- **Carry-over**: full RUG UI walkthrough of v1.32 features; production mirror (db 1) of v1.13–.38 incl. Studio record deactivation list; session logs for the 02-06 (v1.34 SO lock/re-estimate) and 03-06-morning (v1.35) sessions were never written (only git/changelog records exist).
- **`x_studio_rug_rejected` is never reset** — `action_reject_rug` sets it True but no path clears it (asymmetric with ticket sync, which only clears `x_studio_rug_approved`). If a re-request-after-reject flow is needed, this flag needs a reset path.

## Errors & Workarounds
- **`UserError('RUG Account must be Specified in Repair Accounts')`** — not missing config as documented in the v1.32 session, but NULL `x_studio_company_id` on records that did exist; user couldn't fix via UI because the form field is readonly. Fixed in v1.36 (default + fallback + SQL).
- **Register Payment invisible on INV/2026/00030** — two stacked causes (stale `payment_state` + erroneous v1.32 attrs clause). Both fixed in v1.37.
- **psql column surprises**: `account_payment.name/state/date` don't exist as columns in this schema (live on related move); harmless `could not change directory` noise when running psql as postgres from this cwd.
- **No module-update errors** — three updates (v1.36, v1.37, v1.38) all EXIT 0, service active after each restart.

## Key Exchanges
- User: "When clicking the button Update RUG account I get an error RUG Account must be Specified in Repair Accounts" — plan mode; diagnosed NULL company on both x_repair_accounts records (user had even created a "RUG" record that morning as a workaround that couldn't work). Plan approved: default + fallback + data fix. v1.36.
- User: "inv/2026/00030 check why the register payment button isn't appearing" — diagnosed stale `payment_state='in_payment'` (no payments, no reconciliation) AND discovered the v1.32 "Gap B" attrs clause doesn't exist in production. Both fixed. v1.37.
- User: "When the Request RUG Approval is rejected. Then the price should be taken from the pricelist instead of the cost." — `action_reject_rug` now restores `price_unit` from `x_studio_price_unit_original`. v1.38.

## Custom Notes
None

---

## Quick Resume Context
On `helpdesk_repair_custom` v15.0.1.38 on db 2 (`odoo_repair_fresh`). Three RUG-flow fixes today: v1.36 fixed the "RUG Account must be Specified" UserError (company default on `x_repair_accounts.x_studio_company_id`, company-less fallback search in `action_update_rug_account`, SQL data fix + duplicate record delete); v1.37 fixed Register Payment hidden on INV/2026/00030 (added `_compute_payment_state()` after the draft→post cycle, reset the stale row, and removed the v1.32 "Gap B" Register Payment attrs that production never had); v1.38 made `action_reject_rug` restore line `price_unit` from `x_studio_price_unit_original` (the pricelist price stashed by the on-create cost swap). All three deployed clean (EXIT 0). Open tension to watch: the `automation_validate_rug_invoice` automation force-sets `payment_state='in_payment'` on completed RUG invoices, which may conflict with the restored Register Payment behaviour. UI verification of all three fixes pending; production mirror still deferred.

---

## Raw Session Log

### Session start (03-06-2026, ~10:40)

**User:** `/resume` (slash command)

**Claude:** Loaded context: no CLAUDE.md found; read last 3 session summaries (28-05 send-to-sales-and-cancelled-so-fixes, 28-05 rug-flow-studio-to-module, 28-05 tested-ok-mark-as-done-and-dispatch-fix). Flagged a gap: session logs end 28-05 but git shows v1.34 (02-06, SO lock/re-estimate/unlock) and v1.35 (03-06, "1:1 reproduction", account_move_views edits) with no session logs. Module at v15.0.1.35. Listed ready-to items: backfill logs, UI verification, RUG pre-deploy config, production mirror.

**User:** "When clicking the button Update RUG account I get an error RUG Account must be Specified in Repair Accounts" (plan mode active)

**Claude:** Investigated read-only:
- Read `models/account_move.py` — `action_update_rug_account` raises the UserError when `self.env['x_repair_accounts'].search([('x_studio_company_id','=',company.id)], limit=1)` finds nothing or the record has no `x_studio_rug_account`.
- psql db 2: TWO x_repair_accounts records exist — id 1 "Repair Accounts - JLD" (2026-05-18) and id 2 "RUG" (created 2026-06-03 08:09, user's workaround attempt); BOTH have `x_studio_company_id = NULL`, both point to account 1.
- psql db 1 (production): records have company 1 and 2 set; accounts 1361 (RG006, company 1) and 3117 (72050010, company 2).
- db 2 account 1 = `RG006 R.U.G. - REPAIRS` — correct, matches production JLD by code.
- Read `views/repair_accounts_views.xml` — Company field rendered `readonly="1" force_save="True"`; user cannot set it in UI.
- Read `models/repair_accounts.py` — `x_studio_company_id` has NO default; production Studio field had one (hence populated rows there). The 1:1 port dropped it.
- AskUserQuestion: (1) Fix JLD + delete duplicate RUG record → chosen; (2) add company-less fallback search → chosen YES.
- Wrote plan, ExitPlanMode approved.

**Implementation (v15.0.1.36):**
- `models/repair_accounts.py`: `x_studio_company_id = fields.Many2one('res.company', string='Company', default=lambda self: self.env.company)`
- `models/account_move.py`: fallback search for `x_studio_company_id = False` when company-specific search is empty.
- `__manifest__.py`: 15.0.1.35 → 15.0.1.36.
- SQL: `UPDATE x_repair_accounts SET x_studio_company_id = 1 WHERE id = 1; DELETE FROM x_repair_accounts WHERE id = 2;` → verified single row (JLD, account 1, company 1).
- Module update EXIT 0; `systemctl restart odoo15` → active.

**User:** "inv/2026/00030 check why the register payment button isn't appearing on thsi invoice"

**Claude:** Diagnosed:
- psql: invoice id 61, `state=posted`, `move_type=out_invoice`, `amount_total=100.00`, `amount_residual=100.00`, rug_confirmed=t, rug_acc_updated=t, SO S00042 state=done, **`payment_state='in_payment'`**.
- Journal items: line 144 credit 100 on RG006 (income, already swapped), line 145 debit 100 on 120001 (receivable) — `reconciled=f`, `payment_id=NULL`, `full_reconcile_id=NULL`.
- `account_partial_reconcile`: 0 rows touching move 61. No payments exist → `in_payment` is stale (left from the `button_draft()`→`action_post()` cycle in Update RUG Account, which doesn't re-flush the stored compute).
- Checked our view `views/account_move_views.xml` — v1.32 "Gap B" attrs hid Register Payment when `rug_confirmed AND rug_acc_updated`.
- Checked production db 1 `ir_ui_view`: NO RUG customization on Register Payment anywhere — only stock Odoo attrs. The v1.32 clause was wrong.

**Implementation (v15.0.1.37):**
- `views/account_move_views.xml`: removed the entire Gap B xpath (Register Payment attrs override).
- `models/account_move.py`: added `self._compute_payment_state()` after `self.action_post()` in `action_update_rug_account`.
- `__manifest__.py`: → 15.0.1.37.
- SQL: `UPDATE account_move SET payment_state='not_paid' WHERE id=61 AND payment_state='in_payment';` (1 row)
- Module update EXIT 0; restart → active.

**User:** "When the Request RUG Approval is rejected. Then the price should be taken from the pricelist instead of the cost."

**Claude:** Explore agent mapped the RUG flow:
- `action_reject_rug` (sale_order.py:62-68) sets rejected=True, approved=False, syncs ticket.
- On-create automation `automation_rug_so_price_swap` (automation_rules.xml:146-170): on RUG repair SO creation, for each line without `x_studio_price_unit_original`, stores original `price_unit` there and writes `product_id.standard_price` (cost) into `price_unit`.
- `x_studio_price_unit_original` (sale_order_line.py:10-11) = the stashed pricelist price.

**Implementation (v15.0.1.38):**
- `models/sale_order.py` `action_reject_rug` gained:
```python
for line in order.order_line:
    if line.x_studio_price_unit_original:
        line.price_unit = line.x_studio_price_unit_original
```
- `__manifest__.py`: → 15.0.1.38.
- Module update EXIT 0; restart → active.

**User:** `/compress` → this session log.

### Versions shipped this session
| Version | Fix |
|---|---|
| 15.0.1.36 | RUG Account UserError: company default + fallback search + data fix |
| 15.0.1.37 | Register Payment: stale payment_state recompute + removed wrong v1.32 attrs |
| 15.0.1.38 | Reject RUG restores pricelist price from x_studio_price_unit_original |

### Key SQL state changes on db 2
- `x_repair_accounts`: id 1 (JLD) company set to 1; id 2 (RUG duplicate) deleted.
- `account_move` id 61 (INV/2026/00030): payment_state in_payment → not_paid.
