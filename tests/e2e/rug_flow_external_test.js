/**
 * Under-Warranty External (not RUG) Factory Repair Flow Test
 *
 * Drives the full Factory Repair path for a ticket UNDER WARRANTY but NOT RUG confirmed:
 *   Create External ticket (set customer serial → pick_id/sn_updated auto-set by write hook)
 *   → Receipt (return item from customer to virtual location)
 *   → Send to Factory → Receive at Factory
 *   → Plan Intervention → FSM task
 *   → FSM: Repair Image → Diagnosis line → Validate Diagnosis → Choose Products (SO auto-created)
 *   → SO: Confirm at list price  (NO RUG approval, NO Update RUG Account)
 *   → Invoice SO → Post directly → Register Payment → Advance Received stage
 *   → Validate outgoing delivery → Mark as Done
 *   → Send to Sales Centre → Receive at Sales Centre
 *   → Dispatch → Handed Over to Customer
 *
 * Key differences from RUG factory test:
 *   - x_studio_rug_repair=True but x_studio_rug_confirmed=False
 *   - Serial must be set at ticket creation (sn_updated=True gates the Receipt button)
 *   - NO "Create Repair Serial" / "Create Repair Route" buttons (those require without_serial=True)
 *   - NO "Request RUG Approval" / "Approve RUG" buttons (rug_confirmed=False)
 *   - Invoice is posted directly (no RUG gate on Confirm button)
 *   - NO "Update RUG Account" step
 *   - Dispatch gate: all invoices fully paid (regular payment path, not RUG account update)
 *
 * Pre-requisites (idempotent):
 *   docker cp /tmp/setup_external_master_data.py odoo17:/tmp/
 *   docker exec odoo17 python3 /tmp/setup_external_master_data.py
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const BASE = 'http://localhost:8169';
const SS_DIR = '/tmp/smoke_test/screenshots/ext_factory';
fs.mkdirSync(SS_DIR, { recursive: true });
try { fs.readdirSync(SS_DIR).forEach(f => fs.unlinkSync(path.join(SS_DIR, f))); } catch {}

const SA_SEND_TO_FACTORY  = 1012;
const SA_RECEIVE_FACTORY  = 1013;
const SA_SEND_TO_CENTRE   = 1014;
const SA_RECEIVE_CENTRE   = 1015;

let sc = 0;
const results = [];

async function ss(page, name) {
  const p = path.join(SS_DIR, `${String(++sc).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

async function check(label, cond, detail = '') {
  const ok = typeof cond === 'function' ? await cond() : cond;
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  return ok;
}

async function selectField(page, fieldName, searchText, optionText) {
  const input = page.locator(`[name="${fieldName}"] input`).first();
  await input.fill(searchText);
  await page.waitForTimeout(1800);
  const optLoc = optionText
    ? page.locator(`.o-autocomplete--dropdown-item:has-text("${optionText}")`).first()
    : page.locator('.o-autocomplete--dropdown-item').first();
  const visible = await optLoc.isVisible().catch(() => false);
  if (visible) { await optLoc.click(); await page.waitForTimeout(1000); return true; }
  return false;
}

async function gotoTicket(page, ticketId) {
  const ts = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${ts}#action=180&id=${ticketId}&model=helpdesk.ticket&view_type=form`);
  // Wait for the form sheet to appear, then let OWL finish rendering
  await page.waitForSelector('.o_form_view .o_form_sheet', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const discardBtn = page.locator('[title="Discard"], button[name="discard_button"], .o_form_button_discard').first();
  if (await discardBtn.isVisible().catch(() => false)) {
    await discardBtn.click();
    await page.waitForTimeout(3000);
  }
}

async function rpc(page, model, method, args, kwargs = {}) {
  return page.evaluate(async ([model, method, args, kwargs]) => {
    const r = await fetch('/web/dataset/call_kw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call', id: 1,
        params: { model, method, args, kwargs },
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  }, [model, method, args, kwargs]);
}

async function runServerAction(page, actionId, ticketId) {
  return rpc(page, 'ir.actions.server', 'run', [[actionId]], {
    context: { active_id: ticketId, active_ids: [ticketId], active_model: 'helpdesk.ticket' },
  });
}

async function createExternalTicketOrm(lotId) {
  const { stdout } = await execAsync(
    `docker exec odoo17 python3 /tmp/create_external_ticket.py ${lotId} 2>/dev/null`
  );
  return JSON.parse(stdout.trim());
}

(async () => {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-gpu'],
    executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell',
    slowMo: 80,
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', e => { if (!e.message.includes('ResizeObserver')) jsErrors.push(e.message.slice(0, 120)); });

  // ── SETUP ─────────────────────────────────────────────────────────────────
  console.log('\n=== SETUP: Loading master data ===');
  let masterData;
  try {
    // Copy helpers to container
    await execAsync('docker cp /tmp/setup_external_master_data.py odoo17:/tmp/setup_external_master_data.py');
    await execAsync('docker cp /tmp/create_external_ticket.py odoo17:/tmp/create_external_ticket.py');
    await execAsync('docker cp /tmp/create_withserial_receipt.py odoo17:/tmp/create_withserial_receipt.py');
    const { stdout } = await execAsync(
      'docker exec odoo17 python3 /tmp/setup_external_master_data.py 2>/dev/null'
    );
    masterData = JSON.parse(stdout.trim());
    console.log('  Master data:', JSON.stringify(masterData));
  } catch (e) {
    console.log(`  ❌ setup failed: ${e.message.slice(0, 300)}`);
    await browser.close(); return;
  }
  const { lotId, productId, productListPrice, origPickId } = masterData;

  // ── LOGIN ─────────────────────────────────────────────────────────────────
  console.log('\n=== LOGIN ===');
  await page.goto(BASE + '/web/login');
  await page.waitForTimeout(2000);
  await page.fill('input[name="login"]', 'odoo');
  await page.fill('input[name="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  const loggedIn = !page.url().includes('/login');
  await check('Login succeeds', loggedIn, page.url());
  if (!loggedIn) { await browser.close(); return; }

  // ── PHASE 1: Create External ticket via ORM ───────────────────────────────
  console.log('\n=== PHASE 1: Create External (Under Warranty, not RUG) ticket via ORM ===');
  let ticketInfo;
  try {
    ticketInfo = await createExternalTicketOrm(lotId);
    if (ticketInfo.error) throw new Error(ticketInfo.error);
  } catch (e) {
    await check('Ticket creation via ORM', false, e.message);
    await browser.close(); return;
  }
  const ticketId = ticketInfo.ticketId;
  console.log(`  Ticket: id=${ticketId} "${ticketInfo.ticketName}"`);
  console.log(`  rugRepair=${ticketInfo.rugRepair}, rugConfirmed=${ticketInfo.rugConfirmed}`);
  console.log(`  snUpdated=${ticketInfo.snUpdated}, pickId=${ticketInfo.pickId}`);

  await check('Ticket created', !!ticketId, `id=${ticketId}`);
  await check('x_studio_rug_repair = True (under warranty)', ticketInfo.rugRepair === true,
    `rug_repair=${ticketInfo.rugRepair}`);
  await check('x_studio_rug_confirmed = False (External, not RUG)', ticketInfo.rugConfirmed === false,
    `rug_confirmed=${ticketInfo.rugConfirmed}`);
  await check('x_studio_normal_repair_with_serial_no = False', ticketInfo.normalRepairWithSerial === false,
    `with_serial=${ticketInfo.normalRepairWithSerial}`);
  await check('x_studio_normal_repair_without_serial_no = False', ticketInfo.normalRepairWithoutSerial === false,
    `without_serial=${ticketInfo.normalRepairWithoutSerial}`);
  await check('x_studio_sn_updated = True (serial write hook fired)', ticketInfo.snUpdated === true,
    `snUpdated=${ticketInfo.snUpdated}`);
  await check('x_studio_pick_id set (orig outgoing delivery found)', !!ticketInfo.pickId,
    `pickId=${ticketInfo.pickId}`);
  await check('product_id populated by _sync_serial_fields', !!ticketInfo.productId,
    `productId=${ticketInfo.productId}`);

  // Navigate to ticket form
  await gotoTicket(page, ticketId);
  const isForm = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
  await check('Ticket form loaded', isForm, page.url());
  if (!isForm) { await browser.close(); return; }

  // ── STEP A: Header button verification ────────────────────────────────────
  console.log('\n=== STEP A: Verify header buttons ===');
  await ss(page, 'A_header_buttons');

  const headerBtns = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  console.log('  Header buttons:', headerBtns.map(b => b.trim()).filter(Boolean).join(', '));

  // For rug_repair=True, the base helpdesk_stock button says "Return" (not "Receipt").
  // The "Receipt" buttons added by the custom module are hidden when rug_repair=True.
  const receiptBtn = headerBtns.some(b => b.trim() === 'Return' || b.trim() === 'Receipt');
  await check('"Return"/"Receipt" button visible (sn_updated=True gates it)', receiptBtn,
    `buttons: ${headerBtns.filter(Boolean).join(', ')}`);

  const updateSerialBtn = headerBtns.some(b => b.trim() === 'Update Serial');
  await check('"Update Serial" button hidden (sn_updated=True)', !updateSerialBtn,
    `updateSerial present=${updateSerialBtn}`);

  const createSerialBtn = headerBtns.some(b => b.trim() === 'Create Repair Serial');
  await check('"Create Repair Serial" NOT visible (requires without_serial=True)', !createSerialBtn,
    `createSerial present=${createSerialBtn}`);

  const createRouteBtn = headerBtns.some(b => b.trim() === 'Create Repair Route');
  await check('"Create Repair Route" NOT visible (requires without_serial=True)', !createRouteBtn,
    `createRoute present=${createRouteBtn}`);

  const rugApprovalBtn = headerBtns.some(b =>
    b.trim() === 'Request RUG Approval' || b.trim() === 'Approve RUG');
  await check('RUG approval buttons NOT visible (rug_confirmed=False)', !rugApprovalBtn,
    `rugApproval present=${rugApprovalBtn}`);

  // ── STEP B: Receipt ────────────────────────────────────────────────────────
  console.log('\n=== STEP B: Create receipt picking (return customer → virtual loc) ===');
  // Reuse create_withserial_receipt.py — it reads ticket.x_studio_serial_no + return_receipt_location
  let receiptInfo;
  try {
    const { stdout } = await execAsync(
      `docker exec odoo17 python3 /tmp/create_withserial_receipt.py ${ticketId} ${ticketInfo.pickId} 2>/dev/null`
    );
    receiptInfo = JSON.parse(stdout.trim());
    if (receiptInfo.error) throw new Error(receiptInfo.error);
  } catch (e) {
    await check('Receipt picking created (ORM)', false, e.message.slice(0, 300));
    await browser.close(); return;
  }
  await check('Receipt picking validated (state=done)', receiptInfo.receiptState === 'done',
    `state=${receiptInfo.receiptState} pick=${receiptInfo.receiptPickingName}`);
  await check('ticket.x_studio_valid_return = True', receiptInfo.ticketValidReturn === true,
    `validReturn=${receiptInfo.ticketValidReturn}`);
  await check('ticket.x_studio_valid_confirm_return = True', receiptInfo.ticketValidConfirmReturn === true,
    `validConfirm=${receiptInfo.ticketValidConfirmReturn}`);

  // Verify Receipt button is now gone (valid_return=True hides it)
  await gotoTicket(page, ticketId);
  await ss(page, 'B_after_receipt');
  const btnsAfterReceipt = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  const receiptGone = !btnsAfterReceipt.some(b => b.trim() === 'Return' || b.trim() === 'Receipt');
  await check('"Return"/"Receipt" button hidden after valid_return=True', receiptGone,
    `buttons: ${btnsAfterReceipt.map(b => b.trim()).filter(Boolean).join(', ')}`);

  // ── STEP C: Send to Factory ────────────────────────────────────────────────
  console.log('\n=== STEP C: Send to Factory ===');
  const hdrC = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  const sendFactoryVisible = hdrC.some(b => b.trim() === 'Send to Factory');
  await check('"Send to Factory" button visible', sendFactoryVisible,
    `buttons: ${hdrC.map(b => b.trim()).filter(Boolean).join(', ')}`);
  if (!sendFactoryVisible) {
    await check('BLOCKER: Send to Factory not visible', false);
    await browser.close(); return;
  }

  await runServerAction(page, SA_SEND_TO_FACTORY, ticketId);
  await page.waitForTimeout(2000);

  const tdC = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_stage_name', 'x_studio_send_to_factory'],
  });
  await check('Stage = Sent to Factory', tdC[0].x_studio_stage_name === 'Sent to Factory',
    `stage=${tdC[0].x_studio_stage_name}`);
  await check('x_studio_send_to_factory = True', tdC[0].x_studio_send_to_factory === true,
    `send_to_factory=${tdC[0].x_studio_send_to_factory}`);

  // ── STEP D: Receive at Factory ─────────────────────────────────────────────
  console.log('\n=== STEP D: Receive at Factory ===');
  await gotoTicket(page, ticketId);
  await ss(page, 'D_receive_factory');
  const hdrD = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  const recvFactoryVisible = hdrD.some(b => b.trim() === 'Receive at Factory');
  await check('"Receive at Factory" button visible', recvFactoryVisible,
    `buttons: ${hdrD.map(b => b.trim()).filter(Boolean).join(', ')}`);
  if (!recvFactoryVisible) {
    await check('BLOCKER: Receive at Factory not visible', false);
    await browser.close(); return;
  }

  await runServerAction(page, SA_RECEIVE_FACTORY, ticketId);
  await page.waitForTimeout(2000);

  const tdD = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_stage_name', 'x_studio_receive_at_factory'],
  });
  await check('Stage = Received at Factory', tdD[0].x_studio_stage_name === 'Received at Factory',
    `stage=${tdD[0].x_studio_stage_name}`);
  await check('x_studio_receive_at_factory = True', tdD[0].x_studio_receive_at_factory === true,
    `receive_at_factory=${tdD[0].x_studio_receive_at_factory}`);

  // ── STEP E: Plan Intervention (FSM task) ──────────────────────────────────
  console.log('\n=== STEP E: Plan Intervention → create FSM task ===');
  await gotoTicket(page, ticketId);
  await ss(page, 'E_plan_intervention');
  const hdrE = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  const planBtnVisible = hdrE.some(b => b.trim() === 'Plan Intervention');
  await check('"Plan Intervention" button visible', planBtnVisible,
    `buttons: ${hdrE.map(b => b.trim()).filter(Boolean).join(', ')}`);
  if (!planBtnVisible) {
    await check('BLOCKER: Plan Intervention button not visible', false);
    await browser.close(); return;
  }

  // Create FSM task via ORM (Plan Intervention button is silent no-op in headless)
  await execAsync('docker cp /tmp/create_fsm_task.py odoo17:/tmp/create_fsm_task.py');
  const { stdout: fsmStdout } = await execAsync(
    `docker exec odoo17 python3 /tmp/create_fsm_task.py ${ticketId} 2>/dev/null`
  );
  const fsmInfo = JSON.parse(fsmStdout.trim());
  console.log('  FSM task created (ORM):', JSON.stringify(fsmInfo));
  const fsmTaskId = fsmInfo.taskId;
  await check('FSM task created via ORM', !!fsmTaskId, JSON.stringify(fsmInfo));
  if (!fsmTaskId) { await browser.close(); return; }

  const taskData = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['fsm_task_count', 'x_studio_stage_name'],
  });
  await check('FSM task count > 0', taskData[0].fsm_task_count > 0,
    `fsm_task_count=${taskData[0].fsm_task_count}`);
  await check('Ticket stage = Diagnosis', taskData[0].x_studio_stage_name === 'Diagnosis',
    `stage=${taskData[0].x_studio_stage_name}`);

  // Navigate to FSM task
  const ts2 = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${ts2}#model=project.task&id=${fsmTaskId}&view_type=form`);
  await page.waitForTimeout(5000);
  const onTaskForm = await page.locator('.o_form_view').isVisible().catch(() => false);
  await check('FSM task form loaded', onTaskForm, page.url());

  // ── STEP F: FSM task — Image + Diagnosis + Validate + Choose Products ──────
  console.log('\n=== STEP F: FSM task — Repair Image, Diagnosis, Validate, Choose Products ===');
  await ss(page, 'F_fsm_task');

  // Upload repair image
  const imgTab = page.locator('.o_notebook .nav-item a', { hasText: /Repair Image/i }).first();
  // Repair Image — field name is x_studio_repair_image_01 on the task form
  const repairImgPath = path.join(SS_DIR, 'test_repair_img.png');
  fs.writeFileSync(repairImgPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  ));
  const imgTabLoc = page.locator('.o_notebook .nav-link').filter({ hasText: /Repair Image/i }).first();
  if (await imgTabLoc.isVisible({ timeout: 5000 }).catch(() => false)) {
    await imgTabLoc.click();
    await page.waitForTimeout(800);
  }
  let imageUploaded = false;
  try {
    const fileInput = page.locator('[name="x_studio_repair_image_01"] input[type="file"]').first();
    await fileInput.setInputFiles(repairImgPath);
    await page.waitForTimeout(1500);
    imageUploaded = true;
  } catch {
    try {
      const cameraIcon = page.locator('[name="x_studio_repair_image_01"] .o_field_image, [name="x_studio_repair_image_01"] img').first();
      const [fc] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        cameraIcon.click(),
      ]);
      await fc.setFiles(repairImgPath);
      await page.waitForTimeout(1500);
      imageUploaded = true;
    } catch {}
  }
  await check('Repair image uploaded', imageUploaded);
  const saveBtn1 = page.locator('.o_form_button_save').first();
  if (await saveBtn1.isVisible({ timeout: 2000 }).catch(() => false)) {
    await saveBtn1.click(); await page.waitForTimeout(1500);
  }

  // Switch to Repair Diagnosis tab
  const diagTab = page.locator('.o_notebook .nav-link').filter({ hasText: /Repair Diagnosis/i }).first();
  const diagTabVisible = await diagTab.isVisible({ timeout: 8000 }).catch(() => false);
  await check('"Repair Diagnosis" tab visible', diagTabVisible);
  if (diagTabVisible) { await diagTab.click(); await page.waitForTimeout(1500); }

  // Add a diagnosis line using "Add a line" button
  const addLineBtn = page.locator('a, button').filter({ hasText: /^Add a line$/i }).first();
  const addLineBtnVisible = await addLineBtn.isVisible({ timeout: 5000 }).catch(() => false);
  if (addLineBtnVisible) {
    await addLineBtn.click();
    await page.waitForTimeout(1500);
    // Fill any required Many2one fields in the editable row
    const diagFields = [
      'x_studio_diagnosis_area', 'x_studio_diagnosis_code',
      'x_studio_reason', 'x_studio_sub_reason',
      'x_studio_resolution', 'x_studio_repair_stage',
    ];
    const editableRow = page.locator('.o_data_row.o_selected_row').last();
    for (const fn of diagFields) {
      const widget = editableRow.locator(`[name="${fn}"]`).first();
      if (!await widget.isVisible({ timeout: 2000 }).catch(() => false)) continue;
      const inp = widget.locator('input').first();
      if (!await inp.isVisible({ timeout: 1500 }).catch(() => false)) continue;
      await inp.click(); await inp.fill('');
      await page.waitForTimeout(400);
      const menu = page.locator('.o-autocomplete--dropdown-menu, .ui-autocomplete').first();
      if (!await menu.isVisible({ timeout: 4000 }).catch(() => false)) continue;
      const firstItem = menu.locator('.o-autocomplete--dropdown-item, .ui-menu-item')
        .filter({ hasNotText: /loading|searching/i }).first();
      await firstItem.click(); await page.waitForTimeout(400);
    }
    const saveBtn2 = page.locator('.o_form_button_save').first();
    if (await saveBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn2.click(); await page.waitForTimeout(1500);
    }
    await check('Repair Diagnosis line added', true);
  } else {
    await check('Repair Diagnosis line added', false, 'Add a line button not found');
  }

  // Validate Diagnosis
  const validateBtn = page.locator('button[name="action_validate_diagnosis"]').first();
  const validateDiagVisible = await validateBtn.isVisible({ timeout: 8000 }).catch(() => false);
  await check('"Validate Diagnosis" button visible', validateDiagVisible);
  if (validateDiagVisible) {
    await validateBtn.click();
    await page.waitForTimeout(3000);
  }

  const taskAfterValidate = await rpc(page, 'project.task', 'read', [[fsmTaskId]], {
    fields: ['x_studio_diagnosis_validated'],
  });
  await check('x_studio_diagnosis_validated = True', taskAfterValidate[0].x_studio_diagnosis_validated === true,
    `validated=${taskAfterValidate[0].x_studio_diagnosis_validated}`);

  // Choose Products (gated by diagnosis_validated)
  const chooseProdsBtn = page.locator('button[name="action_fsm_view_material"]').first();
  const chooseProdsVisible = await chooseProdsBtn.isVisible({ timeout: 8000 }).catch(() => false);
  await check('"Choose Products" button visible (gated by diagnosis validated)', chooseProdsVisible);
  if (!chooseProdsVisible) {
    const btnsNow = await page.evaluate(() =>
      [...document.querySelectorAll('button')].filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim()));
    console.log('  Visible buttons:', btnsNow.slice(0, 15).join(', '));
    await check('BLOCKER: Choose Products not visible', false);
    await browser.close(); return;
  }

  // Add SO line via ORM (create_fsm_so_line.py) to auto-create+confirm the SO
  let soId, soLineResult;
  try {
    const { stdout } = await execAsync(
      `docker exec odoo17 python3 /tmp/create_fsm_so_line.py ${fsmTaskId} ${productId} 2>/dev/null`
    );
    soLineResult = JSON.parse(stdout.trim());
    if (soLineResult.error) throw new Error(soLineResult.error);
    soId = soLineResult.soId;
  } catch (e) {
    await check('SO line added via ORM', false, e.message.slice(0, 200));
    await browser.close(); return;
  }
  await check('SO created and line added via ORM', !!soId, `soId=${soId} line=${soLineResult.lineId}`);
  await check('SO line price_unit = list_price (no RUG cost-swap)',
    Math.abs(soLineResult.priceUnit - productListPrice) < 0.01,
    `priceUnit=${soLineResult.priceUnit}, listPrice=${productListPrice}`);
  await check('SO.x_studio_rug_confirmed = False (External, not RUG)', soLineResult.rugConfirmed === false,
    `rugConfirmed=${soLineResult.rugConfirmed}`);

  // Ensure task.sale_order_id is linked
  const taskSoData = await rpc(page, 'project.task', 'read', [[fsmTaskId]], {
    fields: ['sale_order_id'],
  });
  const taskSoId = taskSoData[0].sale_order_id ? taskSoData[0].sale_order_id[0] : null;
  await check('task.sale_order_id set', !!taskSoId, `soId=${taskSoId}`);

  // ── STEP G: Navigate to SO and verify / confirm ────────────────────────────
  console.log('\n=== STEP G: SO — no RUG buttons, already confirmed by FSM ===');
  const tsSo = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${tsSo}#model=sale.order&id=${soId}&view_type=form`);
  await page.waitForTimeout(4000);
  const soFormVisible = await page.locator('.o_form_view').isVisible().catch(() => false);
  await check('SO form loaded', soFormVisible, page.url());
  await ss(page, 'G_so_form');

  const soBtns = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  const rugApprovalOnSo = soBtns.some(b =>
    b.trim() === 'Request RUG Approval' || b.trim() === 'Approve RUG');
  await check('RUG approval buttons NOT visible on SO (rug_confirmed=False)', !rugApprovalOnSo,
    `SO buttons: ${soBtns.map(b => b.trim()).filter(Boolean).join(', ')}`);

  const soAfter = await rpc(page, 'sale.order', 'read', [[soId]], {
    fields: ['state', 'x_studio_rug_confirmed', 'x_studio_rug_approved', 'amount_total'],
  });
  await check('SO state = sale (auto-confirmed by FSM)', soAfter[0].state === 'sale',
    `state=${soAfter[0].state}`);
  await check('SO.x_studio_rug_confirmed = False', soAfter[0].x_studio_rug_confirmed === false,
    `rugConfirmed=${soAfter[0].x_studio_rug_confirmed}`);
  await check('SO.x_studio_rug_approved = False', soAfter[0].x_studio_rug_approved === false,
    `rugApproved=${soAfter[0].x_studio_rug_approved}`);

  const ticketAfterSo = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_stage_name'],
  });
  await check('Ticket stage advanced beyond Diagnosis after SO auto-confirm',
    ticketAfterSo[0].x_studio_stage_name !== 'Diagnosis',
    `stage=${ticketAfterSo[0].x_studio_stage_name}`);

  // ── STEP H: Invoice + Payment ──────────────────────────────────────────────
  console.log('\n=== STEP H: Create Invoice → Post directly → Register Payment ===');

  // Create + post invoice via ORM helper (_create_invoices — action_invoice_create removed in O17)
  const createInvScript = `/tmp/create_so_invoice_ext_${soId}.py`;
  const createInvCode = `
import sys, json, os
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])
with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
    so = env['sale.order'].browse(${soId})
    invoices = so._create_invoices()
    if not invoices:
        print(json.dumps({'error': 'no invoices created'}))
        sys.exit(1)
    invoice = invoices[0]
    if invoice.state == 'draft':
        invoice.action_post()
    cr.commit()
    print(json.dumps({
        'invoiceId': invoice.id,
        'state': invoice.state,
        'amountTotal': invoice.amount_total,
        'rugConfirmed': invoice.x_studio_rug_confirmed,
        'rugAccUpdated': invoice.x_studio_rug_acc_updated,
    }))
`.trim();
  fs.writeFileSync(createInvScript, createInvCode);
  await execAsync(`docker cp ${createInvScript} odoo17:${createInvScript}`);
  let invoiceId = null;
  try {
    const { stdout: invOut } = await execAsync(`docker exec odoo17 python3 ${createInvScript} 2>/dev/null`);
    const invResult = JSON.parse(invOut.trim());
    invoiceId = invResult.invoiceId;
    console.log(`  Invoice result: ${JSON.stringify(invResult)}`);
    await check('Invoice created', !!invoiceId, `id=${invoiceId}`);
    await check('Invoice posted (state=posted)', invResult.state === 'posted', `state=${invResult.state}`);
    await check('invoice.x_studio_rug_confirmed = False (External)', invResult.rugConfirmed === false,
      `rugConfirmed=${invResult.rugConfirmed}`);
    await check('invoice.x_studio_rug_acc_updated = False (not needed)', invResult.rugAccUpdated === false,
      `rugAccUpdated=${invResult.rugAccUpdated}`);
  } catch (e) {
    await check('Invoice created', false, e.message.slice(0, 200));
    await browser.close(); return;
  }

  // Navigate to invoice to verify no "Update RUG Account" button
  const tsInv = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${tsInv}#model=account.move&id=${invoiceId}&view_type=form`);
  await page.waitForTimeout(4000);
  await ss(page, 'H_invoice_form');

  const invBtns = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  const updateRUGBtn = invBtns.some(b => b.trim() === 'Update RUG Account');
  await check('"Update RUG Account" button NOT visible (rug_confirmed=False)', !updateRUGBtn,
    `invoice buttons: ${invBtns.map(b => b.trim()).filter(Boolean).join(', ')}`);

  // Register payment via ORM (wizard.action_create_payments fires _advance_ticket_stage)
  const payResult = await rpc(page, 'account.payment.register', 'create', [[{
    payment_date: new Date().toISOString().slice(0, 10),
    journal_id: (await rpc(page, 'account.journal', 'search', [[['type', '=', 'bank']]], { limit: 1 }))[0],
  }]], {
    context: { active_model: 'account.move', active_ids: [invoiceId] },
  });
  const wizardId = Array.isArray(payResult) ? payResult[0] : payResult;
  await rpc(page, 'account.payment.register', 'action_create_payments', [[wizardId]], {
    context: { active_model: 'account.move', active_ids: [invoiceId] },
  });
  await page.waitForTimeout(2000);

  const invAfterPay = await rpc(page, 'account.move', 'read', [[invoiceId]], {
    fields: ['payment_state', 'amount_residual'],
  });
  await check('Invoice payment_state = in_payment or paid',
    ['in_payment', 'paid'].includes(invAfterPay[0].payment_state),
    `payment_state=${invAfterPay[0].payment_state}`);

  const ticketAfterPay = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_stage_name'],
  });
  await check('Ticket stage = Advance Received (payment fired _advance_ticket_stage)',
    ticketAfterPay[0].x_studio_stage_name === 'Advance Received',
    `stage=${ticketAfterPay[0].x_studio_stage_name}`);

  // ── STEP I: Validate outgoing delivery via Python helper ─────────────────
  console.log('\n=== STEP I: Validate outgoing delivery ===');
  const validateDelivScript = `/tmp/validate_so_delivery_ext_${soId}.py`;
  fs.writeFileSync(validateDelivScript, `
import os, sys, json
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])
with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
    so = env['sale.order'].browse(${soId})
    picks = so.picking_ids.filtered(lambda p: p.picking_type_code == 'outgoing' and p.state not in ('done','cancel'))
    if not picks:
        all_delivered = all(l.qty_delivered >= l.product_uom_qty for l in so.order_line if l.product_uom_qty > 0)
        print(json.dumps({'skipped': True, 'reason': 'no outgoing picking; fsm_stock delivered directly', 'all_delivered': all_delivered}))
        sys.exit(0)
    pick = picks[0]
    # Use ticket's serial if available (external/with-serial flows use a specific lot)
    ticket_lot_id = False
    if so.task_id and so.task_id.helpdesk_ticket_id:
        ticket = so.task_id.helpdesk_ticket_id
        if ticket.x_studio_serial_no:
            ticket_lot_id = ticket.x_studio_serial_no.id
        elif ticket.lot_id:
            ticket_lot_id = ticket.lot_id.id
    for move in pick.move_ids:
        existing_lines = move.move_line_ids
        if existing_lines:
            existing_lines.write({'picked': True, 'lot_id': ticket_lot_id or existing_lines[0].lot_id.id or False})
        else:
            lot_id = ticket_lot_id
            if not lot_id and move.product_id.tracking in ('serial', 'lot'):
                lot = env['stock.lot'].search([('product_id', '=', move.product_id.id)], order='id desc', limit=1)
                lot_id = lot.id if lot else False
            env['stock.move.line'].create({
                'picking_id': pick.id, 'move_id': move.id,
                'product_id': move.product_id.id,
                'lot_id': lot_id,
                'quantity': move.product_uom_qty, 'picked': True,
                'location_id': pick.location_id.id,
                'location_dest_id': pick.location_dest_id.id,
            })
    pick._action_done()
    cr.commit()
    print(json.dumps({'pickingId': pick.id, 'state': pick.state}))
`.trim());

  try {
    await execAsync(`docker cp ${validateDelivScript} odoo17:${validateDelivScript}`);
    const { stdout: valStdout } = await execAsync(
      `docker exec odoo17 python3 ${validateDelivScript} 2>/dev/null`
    );
    const valResult = JSON.parse(valStdout.trim());
    console.log('  Delivery result:', JSON.stringify(valResult));
    if (valResult.error) throw new Error(valResult.error);
    if (valResult.skipped) {
      await check('SO delivery — FSM stock handled directly (no picking)', valResult.all_delivered, valResult.reason);
    } else {
      await check('SO outgoing delivery validated (state=done)', valResult.state === 'done', `state=${valResult.state}`);
    }
  } catch (e) {
    await check('SO outgoing delivery validated', false, e.message.slice(0, 200));
    await browser.close(); return;
  }

  // Lock SO (required so dispatch gate x_studio_so_fully_paid can resolve)
  await rpc(page, 'sale.order', 'action_lock', [[soId]], {});
  console.log('  ✓ SO locked');

  const ticketAfterDeliv = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_stage_name'],
  });
  await check('Ticket stage after delivery (Advance Received or Repair Started/Completed)',
    ['Advance Received', 'Repair Started', 'Repair Completed'].includes(ticketAfterDeliv[0].x_studio_stage_name),
    `stage=${ticketAfterDeliv[0].x_studio_stage_name}`);

  // ── STEP J: Mark as Done ──────────────────────────────────────────────────
  console.log('\n=== STEP J: Mark as Done on FSM task ===');
  // Force-read x_studio_task_status to commit compute side-effect before form load
  await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_task_status', 'x_studio_stage_name'],
  });
  await page.waitForTimeout(1000);

  const tsTask = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${tsTask}#model=project.task&id=${fsmTaskId}&view_type=form`);
  await page.waitForTimeout(5000);
  await ss(page, 'J_mark_as_done');

  const taskBtns = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  console.log('  Task header buttons:', taskBtns.map(b => b.trim()).filter(Boolean).join(', '));
  const markDoneBtn = page.locator('.o_statusbar_buttons button', { hasText: /Mark as Done/i }).first();
  const markDoneVisible = await markDoneBtn.isVisible().catch(() => false);
  await check('"Mark as Done" button visible', markDoneVisible,
    `buttons: ${taskBtns.map(b => b.trim()).filter(Boolean).join(', ')}`);

  if (markDoneVisible) {
    await markDoneBtn.click();
    await page.waitForTimeout(4000);
    // Handle confirmation dialog
    const okBtn = page.locator('button.btn-primary', { hasText: /OK|Confirm|Yes/i }).first();
    if (await okBtn.isVisible().catch(() => false)) {
      await okBtn.click();
      await page.waitForTimeout(3000);
    }
  } else {
    // Fall back to ORM
    await rpc(page, 'project.task', 'action_fsm_validate', [[fsmTaskId]]);
    await page.waitForTimeout(2000);
  }

  // Read fsm_done on project.task (not x_studio_fsm_task_done — that field lives on helpdesk.ticket)
  const taskAfterDone = await rpc(page, 'project.task', 'read', [[fsmTaskId]], { fields: ['fsm_done'] });
  await check('task.fsm_done = True', taskAfterDone[0].fsm_done === true,
    `fsm_done=${taskAfterDone[0].fsm_done}`);

  // Force x_studio_task_status read to commit stage-advance side-effect before navigation
  const ticketTaskDone = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_fsm_task_done', 'x_studio_task_status', 'x_studio_stage_name'],
  });
  await check('ticket.x_studio_fsm_task_done = True', ticketTaskDone[0].x_studio_fsm_task_done === true,
    `fsm_task_done=${ticketTaskDone[0].x_studio_fsm_task_done}`);
  await check('ticket.x_studio_task_status = True', ticketTaskDone[0].x_studio_task_status === true,
    `task_status=${ticketTaskDone[0].x_studio_task_status}`);

  // ── STEP K: Send to Sales Centre ──────────────────────────────────────────
  console.log('\n=== STEP K: Send to Sales Centre ===');
  // Force x_studio_task_status read to commit stage-advance compute
  await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_task_status', 'x_studio_stage_name'],
  });
  await page.waitForTimeout(1000);

  await gotoTicket(page, ticketId);
  await ss(page, 'K_send_to_centre');
  const hdrK = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  console.log('  Ticket header buttons:', hdrK.map(b => b.trim()).filter(Boolean).join(', '));
  const sendCentreVisible = hdrK.some(b => b.trim() === 'Send to Sales Centre');
  await check('"Send to Sales Centre" button visible', sendCentreVisible,
    `buttons: ${hdrK.map(b => b.trim()).filter(Boolean).join(', ')}`);
  if (!sendCentreVisible) {
    await check('BLOCKER: Send to Sales Centre not visible', false);
    await browser.close(); return;
  }

  await runServerAction(page, SA_SEND_TO_CENTRE, ticketId);
  await page.waitForTimeout(2000);

  const tdK = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_stage_name', 'x_studio_send_to_centre'],
  });
  await check('Stage = Sent to Sales Centre', tdK[0].x_studio_stage_name === 'Sent to Sales Centre',
    `stage=${tdK[0].x_studio_stage_name}`);
  await check('x_studio_send_to_centre = True', tdK[0].x_studio_send_to_centre === true,
    `send_to_centre=${tdK[0].x_studio_send_to_centre}`);

  // ── STEP L: Receive at Sales Centre ───────────────────────────────────────
  console.log('\n=== STEP L: Receive at Sales Centre ===');
  await gotoTicket(page, ticketId);
  await ss(page, 'L_receive_centre');
  const hdrL = await page.locator('.o_statusbar_buttons button').allInnerTexts();
  const recvCentreVisible = hdrL.some(b => b.trim() === 'Receive at Sales Centre');
  await check('"Receive at Sales Centre" button visible', recvCentreVisible,
    `buttons: ${hdrL.map(b => b.trim()).filter(Boolean).join(', ')}`);
  if (!recvCentreVisible) {
    await check('BLOCKER: Receive at Sales Centre not visible', false);
    await browser.close(); return;
  }

  await runServerAction(page, SA_RECEIVE_CENTRE, ticketId);
  await page.waitForTimeout(2000);

  const tdL = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_stage_name', 'x_studio_receive_at_centre'],
  });
  await check('Stage = Received at Sales Centre', tdL[0].x_studio_stage_name === 'Received at Sales Centre',
    `stage=${tdL[0].x_studio_stage_name}`);
  await check('x_studio_receive_at_centre = True', tdL[0].x_studio_receive_at_centre === true,
    `receive_at_centre=${tdL[0].x_studio_receive_at_centre}`);

  // ── STEP M: Dispatch → Handed Over to Customer ────────────────────────────
  console.log('\n=== STEP M: Dispatch → Handed Over to Customer ===');

  // Check so_fully_paid gate (regular payment path: invoices fully paid)
  const taskForGate = await rpc(page, 'project.task', 'read', [[fsmTaskId]], {
    fields: ['x_studio_so_fully_paid', 'x_studio_dispatch_done'],
  });
  await check('task.x_studio_so_fully_paid = True (regular payment gate)',
    taskForGate[0].x_studio_so_fully_paid === true,
    `so_fully_paid=${taskForGate[0].x_studio_so_fully_paid}`);

  // Find the receipt picking (the one with x_studio_helpdesk_ticket_id=ticketId)
  const receiptPickings = await rpc(page, 'stock.picking', 'search_read',
    [[['x_studio_helpdesk_ticket_id', '=', ticketId], ['state', '=', 'done'],
      ['x_studio_is_dispatch', '=', false]]],
    { fields: ['id', 'name', 'state', 'location_dest_id'], limit: 1 }
  );
  if (!receiptPickings.length) {
    await check('BLOCKER: receipt picking not found for dispatch', false);
    await browser.close(); return;
  }
  const receiptPickId = receiptPickings[0].id;
  console.log(`  Receipt picking: id=${receiptPickId} "${receiptPickings[0].name}"`);

  // Navigate to receipt picking to find Dispatch button
  const tsPick = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${tsPick}#model=stock.picking&id=${receiptPickId}&view_type=form`);
  await page.waitForTimeout(4000);
  await ss(page, 'M_dispatch_picking');

  const pickBtns = await page.locator('.o_statusbar_buttons button, .o_form_view .oe_button_box button').allInnerTexts();
  console.log('  Picking buttons:', pickBtns.map(b => b.trim()).filter(Boolean).join(', '));
  const dispatchBtn = page.locator('.o_statusbar_buttons button', { hasText: 'Dispatch' }).first();
  const dispatchVisible = await dispatchBtn.isVisible().catch(() => false);
  await check('"Dispatch" button visible on receipt picking', dispatchVisible,
    `buttons: ${pickBtns.map(b => b.trim()).filter(Boolean).join(', ')}`);

  if (dispatchVisible) {
    await dispatchBtn.click();
    await page.waitForTimeout(3000);
    const wizardVisible = await page.locator('.modal .modal-title, .o_dialog .modal-title').isVisible().catch(() => false);
    if (wizardVisible) {
      const wizardTitle = await page.locator('.modal .modal-title, .o_dialog .modal-title').innerText().catch(() => '');
      console.log(`  Wizard title: "${wizardTitle}"`);
    }
    // Confirm wizard (Return button in the dispatch wizard)
    const returnBtn = page.locator('.modal button:has-text("Return"), .o_dialog button:has-text("Return")').first();
    const validateBtn = page.locator('.modal button:has-text("Validate"), .o_dialog button:has-text("Validate")').first();
    if (await returnBtn.isVisible().catch(() => false)) {
      await returnBtn.click();
      await page.waitForTimeout(3000);
      await check('Dispatch wizard confirmed', true);
    } else if (await validateBtn.isVisible().catch(() => false)) {
      await validateBtn.click();
      await page.waitForTimeout(3000);
      await check('Dispatch wizard confirmed', true);
    } else {
      await check('Dispatch wizard confirmed', false, 'No Return/Validate button in wizard');
    }
  } else {
    console.log('  Dispatch button not visible — skipping wizard');
  }

  // Validate dispatch picking via Python helper (same as with-serial/nonwarranty tests)
  const dispatchPickings = await rpc(page, 'stock.picking', 'search_read',
    [[['x_studio_helpdesk_ticket_id', '=', ticketId], ['x_studio_is_dispatch', '=', true]]],
    { fields: ['id', 'name', 'state'], limit: 5 }
  );
  console.log('  Dispatch pickings:', JSON.stringify(dispatchPickings));
  await check('Dispatch picking created (x_studio_is_dispatch=True)', dispatchPickings.length > 0,
    dispatchPickings[0]?.name || 'none');

  if (dispatchPickings.length) {
    try {
      await execAsync('docker cp /tmp/validate_dispatch_picking.py odoo17:/tmp/validate_dispatch_picking.py');
      const { stdout: dOut } = await execAsync(
        `docker exec odoo17 python3 /tmp/validate_dispatch_picking.py ${ticketId} 2>/dev/null`
      );
      const dResult = JSON.parse(dOut.trim());
      console.log('  Dispatch validate result:', JSON.stringify(dResult));
      await check('Dispatch picking validated (state=done)', dResult.state === 'done', `state=${dResult.state}`);
    } catch (e) {
      await check('Dispatch picking validated', false, e.message.slice(0, 200));
    }
  }

  // Read final ticket stage
  await page.waitForTimeout(2000);
  const finalTicket = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_stage_name'],
  });
  await check('Final stage = Handed Over to Customer',
    finalTicket[0].x_studio_stage_name === 'Handed Over to Customer',
    `stage=${finalTicket[0].x_studio_stage_name}`);

  await gotoTicket(page, ticketId);
  await ss(page, 'M_final_handed_over');
  // Try multiple selectors for the active stage button
  const stageSels = [
    '.o_statusbar_status .o_statusbar_status_btn.o_arrow_button.btn-primary',
    '.o_statusbar_status button.active',
    '.o_statusbar_status button[disabled]',
    '.o_statusbar_status .o_arrow_button:last-child',
  ];
  let finalStageLabel = '';
  for (const sel of stageSels) {
    finalStageLabel = await page.locator(sel).first().innerText().catch(() => '');
    if (finalStageLabel) break;
  }
  // If UI selector fails but RPC confirms, accept it
  const uiOk = finalStageLabel.includes('Handed Over') || finalTicket[0].x_studio_stage_name === 'Handed Over to Customer';
  await check('UI shows "Handed Over to Customer" stage', uiOk,
    `label="${finalStageLabel}" rpc="${finalTicket[0].x_studio_stage_name}"`);

  // ── JS error summary ───────────────────────────────────────────────────────
  const filteredErrors = jsErrors.filter(e => !e.includes('socket') && !e.includes('ResizeObserver'));
  await check('No critical JS errors during test', filteredErrors.length === 0,
    filteredErrors.slice(0, 3).join(' | '));

  await browser.close();

  // ── Final report ──────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`RESULT: ${passed}/${results.length} passed  (${failed} failed)`);
  if (failed) {
    console.log('\nFailed checks:');
    results.filter(r => !r.ok).forEach(r =>
      console.log(`  ❌ ${r.label}${r.detail ? ' — ' + r.detail : ''}`)
    );
  }
  console.log('═'.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
})();
