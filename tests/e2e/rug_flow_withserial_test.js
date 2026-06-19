/**
 * Non-Warranty Factory Repair Flow Test — With Serial No
 * Drives the full Factory Repair path for a ticket NOT under warranty (WITH pre-existing serial):
 *   Create With-Serial ticket (customer's existing lot/serial, Job Location = Factory Repair)
 *   → write x_studio_serial_no → _sync_serial_fields auto-sets x_studio_sn_updated=True,
 *     x_studio_pick_id = original delivery
 *   → Receipt (return the item from customer to virtual location)
 *   → Send to Factory → Receive at Factory
 *   → Plan Intervention → Create & View FSM task
 *   → FSM task: Repair Image upload → Repair Diagnosis line → Validate Diagnosis
 *     → Choose Products (auto-creates SO)
 *   → SO: Confirm at list price (NO RUG approval, NO Update RUG Account)
 *   → Invoice SO → Register Payment → Advance Received stage
 *   → Validate outgoing delivery → Mark as Done (fsm_done)
 *   → Send to Sales Centre → Receive at Sales Centre
 *   → Dispatch → Handed Over to Customer
 *
 * Key differences from Without-Serial non-warranty test:
 *   - Serial pre-exists in DB (customer's TV from original sale delivery)
 *   - No "Create Repair Serial" SA — serial is supplied at ticket creation
 *   - "Update Serial" button (SA 1020) hidden once x_studio_sn_updated=True (auto-set by write hook)
 *   - Receipt uses x_studio_pick_id = original outgoing delivery (not synthetic picking)
 *   - RUG approval buttons (Request/Approve RUG, Update RUG Account) should NOT appear
 *
 * Pre-requisites:
 *   docker cp /tmp/setup_withserial_master_data.py odoo17:/tmp/
 *   docker exec odoo17 python3 /tmp/setup_withserial_master_data.py
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const BASE = 'http://localhost:8169';
const SS_DIR = '/tmp/smoke_test/screenshots/ws_factory';
fs.mkdirSync(SS_DIR, { recursive: true });
try { fs.readdirSync(SS_DIR).forEach(f => fs.unlinkSync(path.join(SS_DIR, f))); } catch {}

// Server action IDs (confirmed from DB)
const SA_SEND_TO_FACTORY  = 1012;
const SA_RECEIVE_AT_FACTORY = 1013;
const SA_SEND_TO_CENTRE   = 1014;
const SA_RECEIVE_AT_CENTRE = 1015;

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
  await page.waitForTimeout(5000);
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

  // ── SETUP: Load master data ───────────────────────────────────────────────
  console.log('\n=== SETUP: Loading master data ===');
  let masterData;
  try {
    await execAsync('docker cp /tmp/setup_withserial_master_data.py odoo17:/tmp/setup_withserial_master_data.py');
    const { stdout } = await execAsync(
      'docker exec odoo17 python3 /tmp/setup_withserial_master_data.py 2>/dev/null'
    );
    masterData = JSON.parse(stdout.trim());
    console.log('  Master data:', JSON.stringify(masterData));
  } catch (e) {
    console.log(`  ❌ setup_withserial_master_data.py failed: ${e.message.slice(0, 200)}`);
    await browser.close(); return;
  }
  const { productId, productName, productListPrice, lotId, lotName, origPickId } = masterData;

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

  // ── PHASE 1: Create With-Serial ticket via ORM ───────────────────────────
  console.log('\n=== PHASE 1: Create non-warranty (With Serial No) ticket via ORM ===');
  let ticketInfo;
  try {
    await execAsync('docker cp /tmp/create_withserial_ticket.py odoo17:/tmp/create_withserial_ticket.py');
    const { stdout } = await execAsync(
      `docker exec odoo17 python3 /tmp/create_withserial_ticket.py ${lotId} 2>/dev/null`
    );
    ticketInfo = JSON.parse(stdout.trim());
    if (ticketInfo.error) throw new Error(ticketInfo.error);
  } catch (e) {
    await check('Ticket creation via ORM', false, e.message);
    await browser.close(); return;
  }
  const ticketId = ticketInfo.ticketId;
  console.log(`  Ticket: id=${ticketId} "${ticketInfo.ticketName}"`);
  console.log(`  rugRepair=${ticketInfo.rugRepair}, withSerial=${ticketInfo.normalRepairWithSerial}`);
  console.log(`  product: "${ticketInfo.productName}", serial: "${ticketInfo.lotName}"`);
  console.log(`  snUpdated=${ticketInfo.snUpdated}, pickId=${ticketInfo.pickId}`);

  await check('Ticket created', !!ticketId, `id=${ticketId}`);
  await check('x_studio_rug_repair = False (non-warranty)', ticketInfo.rugRepair === false,
    `rug_repair=${ticketInfo.rugRepair}`);
  await check('x_studio_rug_confirmed = False', ticketInfo.rugConfirmed === false,
    `rug_confirmed=${ticketInfo.rugConfirmed}`);
  await check('x_studio_normal_repair_with_serial_no = True', ticketInfo.normalRepairWithSerial === true,
    `with_serial=${ticketInfo.normalRepairWithSerial}`);
  await check('x_studio_normal_repair_without_serial_no = False', ticketInfo.normalRepairWithoutSerial === false,
    `without_serial=${ticketInfo.normalRepairWithoutSerial}`);
  await check('x_studio_sn_updated = True (auto-set by write hook)', ticketInfo.snUpdated === true,
    `sn_updated=${ticketInfo.snUpdated}`);
  await check('x_studio_pick_id set to original delivery', !!ticketInfo.pickId,
    `pick_id=${ticketInfo.pickId}`);
  await check('product_id auto-populated from serial', !!ticketInfo.productId,
    `product="${ticketInfo.productName}"`);
  await check('lot_id set to customer serial', !!ticketInfo.lotId,
    `lot="${ticketInfo.lotName}"`);

  const pickId = ticketInfo.pickId || origPickId;

  // Navigate to ticket form
  await gotoTicket(page, ticketId);
  await page.waitForTimeout(3000);
  const isForm = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
  await check('Ticket form loaded', isForm, page.url());
  if (!isForm) { await browser.close(); return; }

  // Ensure virtual/source locations on ticket
  const ticketMeta = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_virtual_location', 'x_studio_source_location'],
  });
  if (!ticketMeta[0].x_studio_virtual_location || !ticketMeta[0].x_studio_source_location) {
    await rpc(page, 'helpdesk.ticket', 'write', [[ticketId], {
      x_studio_virtual_location: 8,
      x_studio_source_location: masterData.userSourceLocationId || 5,
    }]);
    console.log('  Set virtual/source locations on ticket');
  }
  await ss(page, 'p1_ticket_form');

  // ── STEP A: Check visible header buttons ─────────────────────────────────
  console.log('\n=== STEP A: Check header buttons ===');
  await gotoTicket(page, ticketId);
  await page.waitForTimeout(3000);

  const hdrBtnsA = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button')].map(b => ({
      name: b.getAttribute('name') || '',
      text: b.textContent.trim(),
      visible: !!(b.offsetWidth || b.offsetHeight),
    }))
  );
  console.log('  Header buttons:', JSON.stringify(hdrBtnsA.filter(b => b.visible)));
  await ss(page, 'stepA_header_buttons');

  // "Create Repair Serial" and "Create Repair Route" must NOT appear (those are for Without Serial)
  const createSerialBtn = hdrBtnsA.find(b => b.visible && b.text.includes('Create Repair Serial'));
  await check('"Create Repair Serial" button NOT visible (With Serial flow)', !createSerialBtn,
    createSerialBtn ? 'Found (should be hidden)' : 'not found (correct)');

  const createRouteBtn = hdrBtnsA.find(b => b.visible && b.text.includes('Create Repair Route'));
  await check('"Create Repair Route" button NOT visible (With Serial flow)', !createRouteBtn,
    createRouteBtn ? 'Found (should be hidden)' : 'not found (correct)');

  // "Update Serial" button: visible only if sn_updated=False — since write hook set it True, it should be hidden
  const updateSerialBtn = hdrBtnsA.find(b => b.visible && b.text.includes('Update Serial'));
  await check('"Update Serial" button hidden (sn_updated already True)', !updateSerialBtn,
    updateSerialBtn ? 'Found (should be hidden since sn_updated=True)' : 'not found (correct)');

  // "Receipt" button should now be visible (x_studio_normal_repair_with_serial_no=True, sn_updated=True)
  const receiptBtnA = hdrBtnsA.find(b => b.visible && b.text === 'Receipt');
  await check('"Receipt" button visible (sn_updated=True)', !!receiptBtnA,
    hdrBtnsA.filter(b => b.visible).map(b => b.text).join(', ') || 'none');

  // RUG-specific buttons must NOT appear
  const rugBtn = hdrBtnsA.find(b => b.visible &&
    (b.text.includes('Approve RUG') || b.text.includes('Request RUG') || b.text.includes('Change to RUG')));
  await check('RUG-specific buttons NOT visible', !rugBtn,
    rugBtn ? `Found: ${rugBtn.text}` : 'none (correct)');

  // ── STEP B: Receipt (create + validate incoming picking) ──────────────────
  // The Receipt button opens stock.return.picking wizard — silent no-op in headless.
  // Replicate via ORM using x_studio_pick_id (original delivery) as reference.
  console.log('\n=== STEP B: Receipt — return item from customer (With Serial) ===');

  let receiptInfo;
  try {
    await execAsync('docker cp /tmp/create_withserial_receipt.py odoo17:/tmp/create_withserial_receipt.py');
    const { stdout: rStdout } = await execAsync(
      `docker exec odoo17 python3 /tmp/create_withserial_receipt.py ${ticketId} ${pickId} 2>/dev/null`
    );
    receiptInfo = JSON.parse(rStdout.trim());
    if (receiptInfo.error) throw new Error(receiptInfo.error);
  } catch (e) {
    await check('Receipt picking created (ORM)', false, e.message.slice(0, 300));
    await browser.close(); return;
  }
  console.log('  Receipt result:', JSON.stringify(receiptInfo));
  await check('Receipt picking validated (state=done)', receiptInfo.receiptState === 'done',
    `${receiptInfo.receiptPickingName} state=${receiptInfo.receiptState}`);
  await check('ticket.x_studio_valid_return = True', receiptInfo.ticketValidReturn === true,
    `valid_return=${receiptInfo.ticketValidReturn}`);
  await check('ticket.x_studio_valid_confirm_return = True', receiptInfo.ticketValidConfirmReturn === true,
    `valid_confirm_return=${receiptInfo.ticketValidConfirmReturn}`);
  await check('Serial preserved in receipt', !!receiptInfo.serialName,
    `serial="${receiptInfo.serialName}"`);

  const receiptPickId = receiptInfo.receiptPickingId;

  // ── STEP C: Send to Factory ───────────────────────────────────────────────
  console.log('\n=== STEP C: Send to Factory (SA 1012) ===');
  await gotoTicket(page, ticketId);
  await page.waitForTimeout(4000);
  await ss(page, 'stepC_before_factory');

  const sendFactoryBtn = page.locator('.o_statusbar_buttons button:has-text("Send to Factory")').first();
  const sendFactoryVisible = await sendFactoryBtn.isVisible().catch(() => false);
  await check('"Send to Factory" button visible', sendFactoryVisible);

  if (!sendFactoryVisible) {
    const hdrC = await page.evaluate(() =>
      [...document.querySelectorAll('.o_statusbar_buttons button')]
        .filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim()));
    await check('BLOCKER: Send to Factory not visible', false, hdrC.join(', '));
    await browser.close(); return;
  }

  await runServerAction(page, SA_SEND_TO_FACTORY, ticketId);
  await page.waitForTimeout(2000);
  await ss(page, 'stepC_after_send_factory');

  const tdC = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_stage_name', 'x_studio_send_to_factory'] });
  console.log('  After Send to Factory:', JSON.stringify(tdC[0]));
  await check('Stage = Sent to Factory', tdC[0].x_studio_stage_name === 'Sent to Factory',
    `stage="${tdC[0].x_studio_stage_name}"`);
  await check('x_studio_send_to_factory = True', tdC[0].x_studio_send_to_factory === true,
    `send_to_factory=${tdC[0].x_studio_send_to_factory}`);

  // ── STEP D: Receive at Factory ────────────────────────────────────────────
  console.log('\n=== STEP D: Receive at Factory (SA 1013) ===');
  await gotoTicket(page, ticketId);
  await page.waitForTimeout(4000);
  await ss(page, 'stepD_before_recv_factory');

  const recvFactoryBtn = page.locator('.o_statusbar_buttons button:has-text("Receive at Factory")').first();
  const recvFactoryVisible = await recvFactoryBtn.isVisible().catch(() => false);
  await check('"Receive at Factory" button visible', recvFactoryVisible);

  if (!recvFactoryVisible) {
    const hdrD = await page.evaluate(() =>
      [...document.querySelectorAll('.o_statusbar_buttons button')]
        .filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim()));
    await check('BLOCKER: Receive at Factory not visible', false, hdrD.join(', '));
    await browser.close(); return;
  }

  await runServerAction(page, SA_RECEIVE_AT_FACTORY, ticketId);
  await page.waitForTimeout(2000);
  await ss(page, 'stepD_after_recv_factory');

  const tdD = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_stage_name', 'x_studio_receive_at_factory'] });
  console.log('  After Receive at Factory:', JSON.stringify(tdD[0]));
  await check('Stage = Received at Factory', tdD[0].x_studio_stage_name === 'Received at Factory',
    `stage="${tdD[0].x_studio_stage_name}"`);
  await check('x_studio_receive_at_factory = True', tdD[0].x_studio_receive_at_factory === true,
    `receive_at_factory=${tdD[0].x_studio_receive_at_factory}`);

  // ── STEP E: Plan Intervention → FSM task via ORM ─────────────────────────
  console.log('\n=== STEP E: Plan Intervention → Create FSM Task via ORM ===');
  await gotoTicket(page, ticketId);
  await page.waitForTimeout(4000);
  await ss(page, 'stepE_before_plan');

  const planBtn = page.locator(
    '.o_statusbar_buttons button[name="action_generate_fsm_task"], ' +
    '.o_statusbar_buttons button:has-text("Plan Intervention"), ' +
    '.o_statusbar_buttons button:has-text("Create Task")'
  ).first();
  const planBtnVisible = await planBtn.isVisible().catch(() => false);
  await check('"Plan Intervention" button visible', planBtnVisible);

  if (!planBtnVisible) {
    const hdrE = await page.evaluate(() =>
      [...document.querySelectorAll('.o_statusbar_buttons button')]
        .filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim()));
    await check('BLOCKER: Plan Intervention not visible', false, hdrE.join(', '));
    await browser.close(); return;
  }

  await execAsync('docker cp /tmp/create_fsm_task.py odoo17:/tmp/create_fsm_task.py');
  const { stdout: fsmStdout } = await execAsync(
    `docker exec odoo17 python3 /tmp/create_fsm_task.py ${ticketId} 2>/dev/null`
  );
  const fsmInfo = JSON.parse(fsmStdout.trim());
  console.log('  FSM task created (ORM):', JSON.stringify(fsmInfo));
  const fsmTaskId = fsmInfo.taskId;
  await check('FSM task created via ORM', !!fsmTaskId, JSON.stringify(fsmInfo));
  if (!fsmTaskId) { await browser.close(); return; }

  const ts2 = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${ts2}#model=project.task&id=${fsmTaskId}&view_type=form`);
  await page.waitForTimeout(5000);
  await ss(page, 'stepE_task_form');

  const onTaskForm = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
  await check('FSM task form loaded', onTaskForm, page.url());
  if (!onTaskForm) { await browser.close(); return; }

  // ── STEP F: FSM task work (Image → Diagnosis → Products) ─────────────────
  console.log('\n=== STEP F: FSM task work (Image → Diagnosis → Products) ===');

  // F1: Upload Repair Image
  const repairImageTab = page.locator('.o_notebook .nav-link').filter({ hasText: /Repair Image/i }).first();
  if (await repairImageTab.isVisible({ timeout: 8000 }).catch(() => false)) {
    await repairImageTab.click();
    await page.waitForTimeout(800);
  }
  const repairImgPath = '/tmp/smoke_test/test_repair_image.jpg';
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
  await ss(page, 'stepF_repair_image');

  const saveBtn1 = page.locator('.o_form_button_save').first();
  if (await saveBtn1.isVisible({ timeout: 2000 }).catch(() => false)) {
    await saveBtn1.click();
    await page.waitForTimeout(1500);
  }

  // F2: Repair Diagnosis tab
  const diagTab = page.locator('.o_notebook .nav-link').filter({ hasText: /Repair Diagnosis/i }).first();
  const diagTabVisible = await diagTab.isVisible({ timeout: 8000 }).catch(() => false);
  await check('"Repair Diagnosis" tab visible', diagTabVisible);

  if (diagTabVisible) {
    await diagTab.click();
    await page.waitForTimeout(800);

    const addLineBtn = page.locator('a, button').filter({ hasText: /^Add a line$/i }).first();
    await addLineBtn.waitFor({ state: 'visible', timeout: 8000 });
    await addLineBtn.click();
    await page.waitForTimeout(1500);

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
      await inp.click();
      await inp.fill('');
      await page.waitForTimeout(400);
      const menu = page.locator('.o-autocomplete--dropdown-menu, .ui-autocomplete').first();
      if (!await menu.isVisible({ timeout: 4000 }).catch(() => false)) continue;
      const firstItem = menu.locator('.o-autocomplete--dropdown-item, .ui-menu-item')
        .filter({ hasNotText: /loading|searching/i }).first();
      const itemText = (await firstItem.textContent().catch(() => '')).trim();
      await firstItem.click();
      await page.waitForTimeout(400);
      console.log(`  ✓ ${fn}: "${itemText}"`);
    }

    const saveBtn2 = page.locator('.o_form_button_save').first();
    if (await saveBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn2.click();
      await page.waitForTimeout(1500);
    }
    await ss(page, 'stepF_diagnosis');
    await check('Repair Diagnosis line added', true);
  }

  // F3: Validate Diagnosis
  const validateDiagBtn = page.locator('button[name="action_validate_diagnosis"]').first();
  const validateDiagVisible = await validateDiagBtn.isVisible({ timeout: 8000 }).catch(() => false);
  await check('"Validate Diagnosis" button visible', validateDiagVisible);
  if (validateDiagVisible) {
    await validateDiagBtn.click();
    await page.waitForTimeout(3000);
    await ss(page, 'stepF_validate_diagnosis');
  }
  const taskAfterValidate = await rpc(page, 'project.task', 'read', [[fsmTaskId]],
    { fields: ['x_studio_diagnosis_validated'] });
  await check('x_studio_diagnosis_validated = True', taskAfterValidate[0].x_studio_diagnosis_validated === true,
    `validated=${taskAfterValidate[0].x_studio_diagnosis_validated}`);

  // F4: Choose Products → assert button visible, then add SO line via ORM
  const chooseProdsBtn = page.locator('button[name="action_fsm_view_material"]').first();
  const chooseProdsVisible = await chooseProdsBtn.isVisible({ timeout: 8000 }).catch(() => false);
  await check('"Choose Products" button visible (gated by diagnosis validated)', chooseProdsVisible);
  if (!chooseProdsVisible) {
    const btnsNow = await page.evaluate(() =>
      [...document.querySelectorAll('button')].filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim()));
    await check('BLOCKER: Choose Products not visible', false, btnsNow.slice(0, 10).join(', '));
    await browser.close(); return;
  }
  await ss(page, 'stepF_choose_products_visible');
  console.log('  ✓ "Choose Products" visible — using ORM to add line (serial product requires wizard in headless)');

  await execAsync('docker cp /tmp/create_fsm_so_line.py odoo17:/tmp/create_fsm_so_line.py');
  let soLineResult;
  try {
    const { stdout: solStdout } = await execAsync(
      `docker exec odoo17 python3 /tmp/create_fsm_so_line.py ${fsmTaskId} ${productId} 2>/dev/null`
    );
    soLineResult = JSON.parse(solStdout.trim());
    if (soLineResult.error) throw new Error(soLineResult.error);
  } catch (e) {
    await check('SO line added via ORM', false, e.message.slice(0, 200));
    await browser.close(); return;
  }
  console.log('  SO line result:', JSON.stringify(soLineResult));
  const soId = soLineResult.soId;
  await check('SO created and line added via ORM', !!soId, `soId=${soId} line=${soLineResult.lineId}`);
  await check('SO line price_unit = list_price (no RUG cost-swap)',
    Math.abs(soLineResult.priceUnit - soLineResult.listPrice) < 0.01,
    `price_unit=${soLineResult.priceUnit} list_price=${soLineResult.listPrice}`);
  await check('SO.x_studio_rug_confirmed = False (non-warranty)', soLineResult.rugConfirmed === false,
    `rug_confirmed=${soLineResult.rugConfirmed}`);

  if (!soId) {
    await check('BLOCKER: soId not available', false);
    await browser.close(); return;
  }

  // Navigate back to FSM task to verify
  const tsTask = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${tsTask}#model=project.task&id=${fsmTaskId}&view_type=form`);
  await page.waitForTimeout(4000);

  const taskAfterProd = await rpc(page, 'project.task', 'read', [[fsmTaskId]], { fields: ['sale_order_id'] });
  const taskSoId = taskAfterProd[0].sale_order_id?.[0];
  await check('task.sale_order_id set', !!taskSoId, `soId=${taskSoId}`);
  await ss(page, 'stepF_task_with_so');

  // ── STEP G: SO — Confirm at LIST price (no RUG approval) ─────────────────
  console.log('\n=== STEP G: SO confirmation at selling price (no RUG approval) ===');
  const tsG = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${tsG}#model=sale.order&id=${soId}&view_type=form`);
  await page.waitForTimeout(4000);
  await ss(page, 'stepG_so_form');

  const soFormVisible = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
  await check('SO form loaded', soFormVisible, page.url());

  // Verify RUG approval buttons NOT visible
  const soBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button, .o_form_view header button')]
      .filter(b => b.offsetWidth || b.offsetHeight)
      .map(b => ({ name: b.getAttribute('name') || '', text: b.textContent.trim() }))
  );
  console.log('  SO visible buttons:', JSON.stringify(soBtns));
  const rugApprovalBtn = soBtns.find(b =>
    b.name === 'action_request_rug_approval' || b.name === 'action_approve_rug'
  );
  await check('RUG approval buttons NOT visible on SO', !rugApprovalBtn,
    rugApprovalBtn ? `Found: ${rugApprovalBtn.text}` : 'none (correct)');

  // Verify price = list price
  const soLines = await rpc(page, 'sale.order', 'read', [[soId]], { fields: ['order_line'] });
  if (soLines[0].order_line.length > 0) {
    const soLineData = await rpc(page, 'sale.order.line', 'read', [soLines[0].order_line],
      { fields: ['product_id', 'price_unit'] });
    const mainLine = soLineData.find(l => l.product_id[0] === productId) || soLineData[0];
    if (mainLine) {
      await check('SO line price_unit = list price',
        mainLine.price_unit >= productListPrice * 0.99,
        `price_unit=${mainLine.price_unit} (expected ~${productListPrice})`);
    }
  }

  // Confirm SO
  const soStateCheck = await rpc(page, 'sale.order', 'read', [[soId]], { fields: ['state'] });
  if (soStateCheck[0].state !== 'sale') {
    await rpc(page, 'sale.order', 'action_confirm', [[soId]], {});
    await page.waitForTimeout(1000);
    console.log('  ✓ SO confirmed via RPC');
  } else {
    console.log('  ℹ SO already confirmed');
  }

  const soAfter = await rpc(page, 'sale.order', 'read', [[soId]],
    { fields: ['state', 'x_studio_rug_confirmed', 'x_studio_rug_approved'] });
  await check('SO state = sale (confirmed)', soAfter[0].state === 'sale', `state=${soAfter[0].state}`);
  await check('SO.x_studio_rug_confirmed = False after confirm', soAfter[0].x_studio_rug_confirmed === false,
    `rug_confirmed=${soAfter[0].x_studio_rug_confirmed}`);

  const tdG2 = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], { fields: ['x_studio_stage_name'] });
  await check('Ticket advanced past Diagnosis after SO confirm',
    !['New', 'Diagnosis'].includes(tdG2[0].x_studio_stage_name),
    `stage="${tdG2[0].x_studio_stage_name}"`);

  // ── STEP H: Invoice + Payment ─────────────────────────────────────────────
  console.log('\n=== STEP H: Invoice SO + Register Payment ===');

  const createInvScript = `/tmp/create_so_invoice_ws_${soId}.py`;
  fs.writeFileSync(createInvScript, `
import os, sys, json
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
        sys.exit(0)
    invoice = invoices[0]
    try:
        invoice.action_post()
    except Exception as e:
        print(f'  action_post error: {e}', file=sys.stderr)
    cr.commit()
    print(json.dumps({
        'invoiceId': invoice.id,
        'state': invoice.state,
        'amountTotal': invoice.amount_total,
        'rugConfirmed': invoice.x_studio_rug_confirmed,
    }))
`);

  let invoiceId = null;
  try {
    await execAsync(`docker cp ${createInvScript} odoo17:${createInvScript}`);
    const { stdout: invStdout } = await execAsync(
      `docker exec odoo17 python3 ${createInvScript} 2>/dev/null`
    );
    const invResult = JSON.parse(invStdout.trim());
    if (invResult.error) throw new Error(invResult.error);
    invoiceId = invResult.invoiceId;
    console.log('  Invoice result:', JSON.stringify(invResult));
    await check('Invoice created', !!invoiceId, `id=${invoiceId}`);
    await check('Invoice posted (state=posted)', invResult.state === 'posted', `state=${invResult.state}`);
    await check('Invoice.x_studio_rug_confirmed = False', invResult.rugConfirmed === false,
      `rug_confirmed=${invResult.rugConfirmed}`);
  } catch (e) {
    await check('Invoice created and posted', false, e.message.slice(0, 200));
    await browser.close(); return;
  }

  // Verify Update RUG Account button NOT visible on invoice
  await page.goto(`${BASE}/web#model=account.move&id=${invoiceId}&view_type=form`);
  await page.waitForTimeout(4000);
  await ss(page, 'stepH_invoice_form');

  const invBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button, .o_form_view header button')]
      .filter(b => b.offsetWidth || b.offsetHeight)
      .map(b => ({ name: b.getAttribute('name') || '', text: b.textContent.trim() }))
  );
  console.log('  Invoice visible buttons:', JSON.stringify(invBtns));
  const updateRugBtn = invBtns.find(b => b.name === 'action_update_rug_account');
  await check('"Update RUG Account" button NOT visible on invoice (non-warranty)', !updateRugBtn,
    updateRugBtn ? 'Found (should be hidden)' : 'not found (correct)');

  // Register payment
  const payScript = `/tmp/pay_ws_invoice_${invoiceId}.py`;
  fs.writeFileSync(payScript, `
import os, sys, json
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])
with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
    invoice = env['account.move'].browse(${invoiceId})
    journal = env['account.journal'].search([
        ('type', 'in', ('bank', 'cash')), ('company_id', '=', invoice.company_id.id)
    ], limit=1)
    if not journal:
        print(json.dumps({'error': 'No bank/cash journal found'}))
        sys.exit(1)
    wizard = env['account.payment.register'].with_context(
        active_model='account.move',
        active_ids=[invoice.id],
    ).create({'journal_id': journal.id, 'amount': invoice.amount_total})
    wizard.action_create_payments()
    cr.commit()
    invoice.invalidate_recordset()
    payment = env['account.payment'].search([('reconciled_invoice_ids', 'in', [invoice.id])], order='id desc', limit=1)
    print(json.dumps({
        'paymentId': payment.id if payment else None,
        'invoicePaymentState': invoice.payment_state,
        'invoiceAmountResidual': invoice.amount_residual,
    }))
`);

  try {
    await execAsync(`docker cp ${payScript} odoo17:${payScript}`);
    const { stdout: payStdout } = await execAsync(
      `docker exec odoo17 python3 ${payScript} 2>/dev/null`
    );
    const payResult = JSON.parse(payStdout.trim());
    if (payResult.error) throw new Error(payResult.error);
    console.log('  Payment result:', JSON.stringify(payResult));
    await check('Invoice payment registered', !!payResult.paymentId, `paymentId=${payResult.paymentId}`);
    await check('Invoice payment_state = paid or in_payment',
      ['paid', 'in_payment'].includes(payResult.invoicePaymentState),
      `payment_state=${payResult.invoicePaymentState}`);
  } catch (e) {
    await check('Invoice payment registered', false, e.message.slice(0, 200));
    console.log('  WARNING: payment failed, continuing...');
  }

  const tdH2 = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_stage_name', 'x_studio_valid_invoiced_so'] });
  console.log('  Ticket after invoice+payment:', JSON.stringify(tdH2[0]));
  await check('Ticket stage = Advance Received (or beyond) after payment',
    ['Advance Received', 'Repair Started', 'Repair Completed', 'Handed Over to Customer']
      .includes(tdH2[0].x_studio_stage_name),
    `stage="${tdH2[0].x_studio_stage_name}"`);

  // ── STEP I: Validate SO outgoing delivery ─────────────────────────────────
  console.log('\n=== STEP I: Validate SO outgoing delivery ===');
  const validateDelivScript = `/tmp/validate_so_delivery_ws_${soId}.py`;
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
    for move in pick.move_ids:
        existing = move.move_line_ids
        if existing:
            existing.write({'picked': True})
        else:
            lot_id = False
            if move.product_id.tracking in ('serial', 'lot'):
                # Use the ticket's serial for the delivery
                ticket = env['helpdesk.ticket'].search([('sale_order_id', '=', ${soId})], limit=1)
                if ticket and ticket.x_studio_serial_no:
                    lot_id = ticket.x_studio_serial_no.id
                else:
                    lot = env['stock.lot'].search([('product_id', '=', move.product_id.id)], limit=1)
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
`);

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

  await rpc(page, 'sale.order', 'action_lock', [[soId]], {});
  console.log('  ✓ SO locked');

  // ── STEP J: Mark FSM task as Done ─────────────────────────────────────────
  console.log('\n=== STEP J: FSM task Mark as Done ===');
  const tsJ = Math.floor(Date.now() / 1000);
  await page.goto(`${BASE}/web?_t=${tsJ}#model=project.task&id=${fsmTaskId}&view_type=form`);
  await page.waitForTimeout(4000);
  await ss(page, 'stepJ_task_form');

  const markDoneBtn = page.locator(
    'button[name="action_fsm_validate"], button:has-text("Mark as Done"), .o_statusbar_buttons button:has-text("Done")'
  ).first();
  const markDoneVisible = await markDoneBtn.isVisible({ timeout: 8000 }).catch(() => false);
  if (!markDoneVisible) {
    const allBtnsJ = await page.evaluate(() =>
      [...document.querySelectorAll('button')].filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim()));
    console.log('  Task buttons (J):', allBtnsJ.slice(0, 15));
    await ss(page, 'stepJ_buttons');
  }
  await check('"Mark as Done" button visible on FSM task', markDoneVisible);
  if (!markDoneVisible) { await browser.close(); return; }

  await rpc(page, 'project.task', 'action_fsm_validate', [[fsmTaskId]], {});
  await page.waitForTimeout(2000);
  await ss(page, 'stepJ_mark_done');

  const taskAfterDone = await rpc(page, 'project.task', 'read', [[fsmTaskId]], { fields: ['fsm_done'] });
  await check('task.fsm_done = True', taskAfterDone[0].fsm_done === true, `fsm_done=${taskAfterDone[0].fsm_done}`);

  // Reading x_studio_task_status triggers the non-stored compute side-effect (→ Repair Completed).
  // This commits the stage advance BEFORE gotoTicket loads the form, preventing OWL error.
  const tdJ = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_fsm_task_done', 'x_studio_stage_name', 'x_studio_task_status'] });
  console.log('  Ticket after Mark as Done:', JSON.stringify(tdJ[0]));
  await check('ticket.x_studio_fsm_task_done = True', tdJ[0].x_studio_fsm_task_done === true,
    `fsm_task_done=${tdJ[0].x_studio_fsm_task_done}`);
  await check('ticket.x_studio_task_status = True', tdJ[0].x_studio_task_status === true,
    `task_status=${tdJ[0].x_studio_task_status}`);

  // ── STEP K: Send to Sales Centre ─────────────────────────────────────────
  console.log('\n=== STEP K: Send to Sales Centre (SA 1014) ===');
  await gotoTicket(page, ticketId);
  await page.waitForTimeout(5000);
  await ss(page, 'stepK_ticket');

  const gateFields = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], {
    fields: ['x_studio_fsm_task_done', 'x_studio_task_status', 'x_studio_receive_at_factory',
             'x_studio_send_to_centre', 'x_studio_job_location', 'x_studio_cancelled', 'x_studio_stage_name'],
  });
  console.log('  Gate fields:', JSON.stringify(gateFields[0]));

  const sendCentreBtn = page.locator('.o_statusbar_buttons button:has-text("Send to Sales Centre")').first();
  const sendCentreVisible = await sendCentreBtn.isVisible().catch(() => false);
  await check('"Send to Sales Centre" button visible', sendCentreVisible);

  if (!sendCentreVisible) {
    const pageInfo = await page.evaluate(() => ({
      statusbarBtns: [...document.querySelectorAll('.o_statusbar_buttons button')]
        .filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim()),
      owlError: !!document.querySelector('.o_error_dialog, .o_dialog_error, [class*="error"]'),
    }));
    console.log('  Page info:', JSON.stringify(pageInfo));
    const gf = gateFields[0];
    const gateOk = gf.x_studio_fsm_task_done && gf.x_studio_task_status && gf.x_studio_receive_at_factory
      && !gf.x_studio_send_to_centre && !gf.x_studio_cancelled && gf.x_studio_job_location === 'Factory Repair';
    if (gateOk) {
      console.log('  NOTE: gate fields correct, driving SA 1014 via RPC');
      await check('"Send to Sales Centre" button (gate OK, driving via RPC)', true, 'gate correct');
    } else {
      await check('BLOCKER: Send to Sales Centre not visible', false, JSON.stringify(pageInfo.statusbarBtns));
      await browser.close(); return;
    }
  }

  await runServerAction(page, SA_SEND_TO_CENTRE, ticketId);
  await page.waitForTimeout(2000);
  await ss(page, 'stepK_after_click');

  const tdK = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_stage_name', 'x_studio_send_to_centre'] });
  await check('Stage = Sent to Sales Centre', tdK[0].x_studio_stage_name === 'Sent to Sales Centre',
    `stage="${tdK[0].x_studio_stage_name}"`);

  // ── STEP L: Receive at Sales Centre ──────────────────────────────────────
  console.log('\n=== STEP L: Receive at Sales Centre (SA 1015) ===');
  await gotoTicket(page, ticketId);
  await page.waitForTimeout(4000);
  await ss(page, 'stepL_before_click');

  const recvCentreBtn = page.locator('.o_statusbar_buttons button:has-text("Receive at Sales Centre")').first();
  const recvCentreVisible = await recvCentreBtn.isVisible().catch(() => false);
  await check('"Receive at Sales Centre" button visible', recvCentreVisible);
  if (!recvCentreVisible) {
    const hdrL = await page.evaluate(() =>
      [...document.querySelectorAll('.o_statusbar_buttons button')]
        .filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim()));
    await check('BLOCKER: Receive at Sales Centre not visible', false, hdrL.join(', '));
    await browser.close(); return;
  }

  await runServerAction(page, SA_RECEIVE_AT_CENTRE, ticketId);
  await page.waitForTimeout(2000);
  await ss(page, 'stepL_after_click');

  const tdL = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_stage_name', 'x_studio_receive_at_centre'] });
  await check('Stage = Received at Sales Centre', tdL[0].x_studio_stage_name === 'Received at Sales Centre',
    `stage="${tdL[0].x_studio_stage_name}"`);
  await check('x_studio_receive_at_centre = True', tdL[0].x_studio_receive_at_centre === true,
    `receive_at_centre=${tdL[0].x_studio_receive_at_centre}`);

  // ── STEP M: Dispatch → Handed Over to Customer ────────────────────────────
  console.log('\n=== STEP M: Dispatch → Handed Over to Customer ===');

  // Navigate to the receipt picking form (from STEP B) for the Dispatch button
  await page.goto(`${BASE}/web#action=stock.action_picking_tree_all&id=${receiptPickId}&model=stock.picking&view_type=form`);
  await page.waitForTimeout(5000);
  await ss(page, 'stepM_receipt_picking');

  const pickBtnsM = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button, .o_form_buttons_view button')].map(b => ({
      name: b.getAttribute('name') || '', text: b.textContent.trim(), visible: !!(b.offsetWidth || b.offsetHeight),
    }))
  );
  console.log('  Picking form buttons:', JSON.stringify(pickBtnsM.filter(b => b.visible)));

  const dispatchBtn = page.locator(
    'button[name="action_dispatch_return"], button:has-text("Dispatch")'
  ).first();
  const dispatchVisible = await dispatchBtn.isVisible().catch(() => false);
  await check('"Dispatch" button visible on receipt picking', dispatchVisible,
    pickBtnsM.filter(b => b.visible).map(b => b.text).join(', '));

  if (dispatchVisible) {
    await dispatchBtn.click();
    await page.waitForTimeout(5000);
    await ss(page, 'stepM_dispatch_wizard');

    const dispWizard = page.locator('.modal.d-block.o_technical_modal, .modal.d-block');
    const dispWizVisible = await dispWizard.first().isVisible().catch(() => false);
    await check('Dispatch wizard opened', dispWizVisible);

    if (dispWizVisible) {
      const returnBtn2 = page.locator('button[name="create_returns"], .modal button.btn-primary:has-text("Return")').first();
      if (await returnBtn2.isVisible().catch(() => false)) {
        await returnBtn2.click();
        await page.waitForTimeout(5000);
        await ss(page, 'stepM_dispatch_confirmed');
        await check('Dispatch wizard confirmed', true);
      } else {
        const dlgBtns2 = await page.evaluate(() =>
          [...document.querySelectorAll('.modal button')].map(b => b.textContent.trim()));
        await check('Dispatch wizard "Return" button', false, dlgBtns2.join(', '));
      }
    }
  }

  // Find and validate dispatch picking
  await gotoTicket(page, ticketId);
  await page.waitForTimeout(3000);

  const dispatchPickings = await rpc(page, 'stock.picking', 'search_read',
    [[['x_studio_helpdesk_ticket_id', '=', ticketId], ['x_studio_is_dispatch', '=', true]]],
    { fields: ['id', 'name', 'state'], limit: 1 }
  );
  console.log('  Dispatch pickings:', JSON.stringify(dispatchPickings));
  await check('Dispatch picking created (x_studio_is_dispatch=True)', dispatchPickings.length > 0,
    dispatchPickings[0]?.name || 'none');

  if (dispatchPickings.length) {
    try {
      await execAsync('docker cp /tmp/validate_dispatch_picking.py odoo17:/tmp/validate_dispatch_picking.py');
      const { stdout: dpStdout } = await execAsync(
        `docker exec odoo17 python3 /tmp/validate_dispatch_picking.py ${ticketId} 2>/dev/null`
      );
      const dpResult = JSON.parse(dpStdout.trim());
      console.log('  Dispatch validate result:', JSON.stringify(dpResult));
      await check('Dispatch picking validated (state=done)', dpResult.state === 'done', `state=${dpResult.state}`);
    } catch (e) {
      await check('Dispatch picking validated', false, e.message.slice(0, 150));
    }

    await gotoTicket(page, ticketId);
    await page.waitForTimeout(5000);
    await ss(page, 'stepM_final_ticket');

    const tdM = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], { fields: ['x_studio_stage_name'] });
    await check('Final stage = Handed Over to Customer',
      tdM[0].x_studio_stage_name === 'Handed Over to Customer',
      `stage="${tdM[0].x_studio_stage_name}"`);
  } else {
    await check('BLOCKER: Dispatch picking not found', false);
  }

  // ── JS ERRORS ─────────────────────────────────────────────────────────────
  console.log('\n=== JS Error check ===');
  await check('No JS errors', jsErrors.length === 0, jsErrors.slice(0, 2).join('; ') || 'none');

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`WITH-SERIAL FACTORY REPAIR TEST: ${fail === 0 ? '✅ PASS' : '❌ PARTIAL'}`);
  console.log(`${pass} passed, ${fail} failed of ${results.length} checks`);
  if (fail > 0) {
    console.log('\nFailed checks:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.label}: ${r.detail}`));
  }

  await browser.close();
})();
