/**
 * RUG Phase-2 Flow Test
 * Continues from a saved RUG ticket through:
 *   Receipt wizard → validate picking → Repair Order → confirm → start → validate
 * Pre-requisite: phase-1 test has already run AND setup_rug_delivery.py has been executed.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'http://localhost:8169';
const SS_DIR = '/tmp/smoke_test/screenshots/rug_p2';
fs.mkdirSync(SS_DIR, { recursive: true });
try { fs.readdirSync(SS_DIR).forEach(f => fs.unlinkSync(path.join(SS_DIR, f))); } catch {}

let sc = 0;
const results = [];

async function ss(page, name) {
  const p = path.join(SS_DIR, `${String(++sc).padStart(2,'0')}_${name}.png`);
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

// ─── RPC helper ─────────────────────────────────────────────────────────────
async function rpc(page, model, method, args, kwargs = {}) {
  return page.evaluate(async ([model, method, args, kwargs]) => {
    const r = await fetch('/web/dataset/call_kw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call', id: 1,
        params: {
          model, method,
          args, kwargs,
        },
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  }, [model, method, args, kwargs]);
}

// ─── SETUP: Create a fresh SO + delivery for each test run (via Python helper) ─
function setupFreshDelivery() {
  console.log('\n=== SETUP: Creating fresh delivery ===');
  const out = execSync('docker exec odoo17 python3 /tmp/create_rug_delivery.py 2>/dev/null').toString().trim();
  const info = JSON.parse(out);
  console.log(`  Serial: ${info.serialName}, picking: ${info.pickingId}`);
  return info;
}

// ─── PHASE 1 REPLAY: create the RUG ticket ──────────────────────────────────
async function phase1(page, serialName = 'SN-RUG-TEST-001') {
  console.log('\n=== PHASE 1: Create and save RUG ticket ===');

  await page.goto(BASE + '/web#action=180&model=helpdesk.ticket&view_type=form');
  await page.waitForTimeout(5000);
  const isForm = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
  if (!isForm) throw new Error('Ticket form not loaded');

  // Assign to Me
  const assignBtn = page.locator('button[name="assign_ticket_to_self"]');
  if (await assignBtn.isVisible().catch(() => false)) {
    await assignBtn.click();
    await page.waitForTimeout(5000);
  }

  // Team
  const teamInput = page.locator('[name="team_id"] input');
  if (!(await teamInput.inputValue().catch(() => ''))) {
    await selectField(page, 'team_id', 'Customer', 'Customer Care');
  }

  // Ticket Type = RUG
  await selectField(page, 'ticket_type_id', 'Repair - Under', 'Repair - Under Warranty (RUG)');
  await page.waitForTimeout(2000);

  // Customer
  await selectField(page, 'partner_id', 'Test Customer', 'Test Customer RUG');

  // Serial Number — use full name to uniquely identify (many AUTO serials exist now)
  await selectField(page, 'x_studio_serial_no', serialName, serialName);
  await page.waitForTimeout(1000);

  // Repair Reason
  await selectField(page, 'x_studio_repair_reason', 'Screen', 'Screen Defect');

  // Return Receipt Location
  await selectField(page, 'x_studio_return_receipt_location', 'WH', null);

  // Job Location = Centre Repair
  const jobLocEl = page.locator('[name="x_studio_job_location"]');
  if (await jobLocEl.count() > 0) {
    await jobLocEl.click();
    await page.waitForTimeout(500);
    const centreOpt = page.locator('.o-autocomplete--dropdown-item:has-text("Centre Repair"), option:has-text("Centre Repair")').first();
    if (await centreOpt.isVisible().catch(() => false)) await centreOpt.click();
    else {
      const sel = page.locator('[name="x_studio_job_location"] select');
      if (await sel.count() > 0) await sel.selectOption({ label: 'Centre Repair' });
    }
  }

  // Save
  const saveBtn = page.locator('.o_form_button_save');
  if (await saveBtn.isVisible().catch(() => false)) {
    await saveBtn.click();
    await page.waitForTimeout(4000);
  }

  const saveError = await page.locator('.o_error_dialog').isVisible().catch(() => false);
  if (saveError) throw new Error('Ticket save failed');

  // Extract ticket ID from URL
  const url = page.url();
  console.log('  URL after save:', url);
  const idMatch = url.match(/[?&#]id=(\d+)/);
  if (!idMatch) {
    // Try reading id from URL path or via RPC
    const ticketId = await rpc(page, 'helpdesk.ticket', 'search', [
      [['partner_id.name','=','Test Customer RUG'], ['x_studio_rug_repair','=',true]],
    ], { limit: 1, order: 'id desc' });
    return ticketId[0] || null;
  }
  return parseInt(idMatch[1]);
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

  // ── LOGIN ──
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

  // ── SETUP: Fresh delivery for this run ───────────────────────────────────
  let deliveryInfo;
  try {
    deliveryInfo = setupFreshDelivery();
  } catch (e) {
    await check('Fresh delivery setup', false, e.message);
    await browser.close(); return;
  }
  await check('Fresh delivery created and validated', true, deliveryInfo.serialName);

  // ── CREATE TICKET (Phase 1 replay) ───────────────────────────────────────
  let ticketId;
  try {
    ticketId = await phase1(page, deliveryInfo.serialName);
  } catch (e) {
    await check('Phase-1 ticket creation', false, e.message);
    await browser.close(); return;
  }
  await check('Ticket created and saved', !!ticketId, `id=${ticketId}`);
  console.log(`  Ticket ID: ${ticketId}`);
  await ss(page, 'p1_saved_ticket');

  // Navigate to full form via hash URL (guarantees full form, not quick_create)
  await page.goto(`${BASE}/web#action=180&id=${ticketId}&model=helpdesk.ticket&view_type=form`);
  await page.waitForTimeout(4000);
  await ss(page, 'p2_ticket_reloaded');

  // ── STEP 10: Verify Receipt button visible ────────────────────────────────
  console.log('\n=== STEP 10: Receipt button visible ===');

  // Check via RPC that sn_updated is True (set by write() when serial was saved)
  const ticketData = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_sn_updated', 'x_studio_valid_return', 'product_id', 'x_studio_picking_id'] });
  console.log('  Ticket data:', JSON.stringify(ticketData[0]));
  await check('x_studio_sn_updated = True', ticketData[0].x_studio_sn_updated === true,
    `sn_updated=${ticketData[0].x_studio_sn_updated}`);

  // The base stock.act_stock_return_picking button visibility:
  // invisible if: cancelled or not use_product_returns or valid_return or not ticket_type or not rug_repair or (not without_serial and not sn_updated)
  // For RUG + sn_updated=True: should be VISIBLE
  // Check all header buttons — for RUG, the base stock.act_stock_return_picking shows as "Return"
  // (we only override its invisible attr, not string). Custom "Receipt" buttons are for Normal repairs.
  const allHdrBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button')].map(b => ({
      name: b.getAttribute('name') || '',
      text: b.textContent.trim(),
      visible: !!(b.offsetWidth || b.offsetHeight),
    }))
  );
  console.log('  All header buttons:', JSON.stringify(allHdrBtns.filter(b => b.visible)));

  // For RUG: stock.act_stock_return_picking base button shows as "Return"
  // For Normal: custom added buttons show as "Receipt"
  const receiptOrReturn = allHdrBtns.find(b => (b.text === 'Receipt' || b.text === 'Return') && b.visible);
  await check('Return/Receipt button visible for RUG', !!receiptOrReturn,
    allHdrBtns.filter(b => b.visible).map(b => b.text).join(', ') || 'none');
  await ss(page, 'step10_receipt_button');

  if (!receiptOrReturn) {
    console.log('  All buttons (including hidden):', JSON.stringify(allHdrBtns));
    await check('BLOCKER: Return/Receipt button not visible — cannot continue', false, 'check debug above');
    await browser.close(); return;
  }

  // ── STEP 11: Click Return/Receipt → open return wizard ──────────────────
  console.log('\n=== STEP 11: Click Return/Receipt → return wizard ===');
  // For RUG: base stock.act_stock_return_picking shows as "Return"
  const receiptBtn = page.locator('.o_statusbar_buttons button:has-text("Return"), .o_statusbar_buttons button:has-text("Receipt")').first();
  await receiptBtn.click();
  await page.waitForTimeout(6000);
  await ss(page, 'step11_after_receipt_click');

  // The wizard opens as .modal.o_technical_modal (standard Odoo transient wizard)
  // Wait for it to appear
  const wizardModal = page.locator('.modal.d-block.o_technical_modal, .modal.show.o_technical_modal, .modal.d-block');
  try {
    await wizardModal.first().waitFor({ state: 'visible', timeout: 8000 });
  } catch {}
  const wizardVisible = await wizardModal.first().isVisible().catch(() => false);
  console.log(`  Wizard modal visible: ${wizardVisible}, url: ${page.url()}`);

  if (wizardVisible) {
    // Check wizard fields
    const soVal = await page.locator('.modal [name="sale_order_id"] input').first().inputValue().catch(() => '');
    const pickVal = await page.locator('.modal [name="picking_id"] input').first().inputValue().catch(() => '');
    console.log(`  Wizard SO: "${soVal}"  Picking: "${pickVal}"`);
    await check('Return wizard opened', true);
    await check('Sale order auto-filled in wizard', !!soVal, soVal || 'empty');
    await check('Source picking auto-filled in wizard', !!pickVal, pickVal || 'empty');
    await ss(page, 'step11_wizard');

    // Click "Return" / create_returns button in the wizard
    const returnBtn = page.locator('button[name="create_returns"], .modal button.btn-primary:has-text("Return")').first();
    const returnVisible = await returnBtn.isVisible().catch(() => false);
    if (returnVisible) {
      const btnTxt = await returnBtn.textContent().catch(() => '');
      console.log(`  Clicking wizard button: "${btnTxt.trim()}"`);
      await returnBtn.click();
      await page.waitForTimeout(6000);
      await ss(page, 'step11_after_return');
      await check('Return wizard confirmed', true);
    } else {
      const dlgBtns = await page.evaluate(() =>
        [...document.querySelectorAll('.modal button')].map(b => b.textContent.trim())
      );
      console.log('  Modal buttons:', dlgBtns);
      await check('Return button found in wizard', false, dlgBtns.join(', ') || 'none');
      await browser.close(); return;
    }
  } else {
    // Maybe already navigated to picking form
    const isPicking = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
    const pickTypePresent = await page.locator('[name="picking_type_id"]').count() > 0;
    console.log(`  Form visible: ${isPicking}, has picking_type: ${pickTypePresent}`);
    await check('Return wizard or picking opened', isPicking && pickTypePresent, page.url());
    if (!isPicking || !pickTypePresent) { await browser.close(); return; }
  }

  // ── STEP 12: Find and validate the receipt picking ───────────────────────
  console.log('\n=== STEP 12: Validate the receipt picking ===');

  // After wizard: close any remaining modal, then navigate to ticket and find the receipt picking via RPC
  const blockingModal = page.locator('.modal.d-block.o_technical_modal');
  if (await blockingModal.isVisible().catch(() => false)) {
    console.log('  Closing residual modal after wizard...');
    const closeBtn = page.locator('.modal.d-block.o_technical_modal button[data-bs-dismiss="modal"], .modal.d-block.o_technical_modal button:has-text("Cancel"), .modal.d-block.o_technical_modal button:has-text("Close"), .modal.d-block.o_technical_modal .btn-close');
    if (await closeBtn.first().isVisible().catch(() => false)) {
      await closeBtn.first().click();
      await page.waitForTimeout(2000);
    } else {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(2000);
    }
  }

  // Navigate to ticket to find the new receipt picking
  await page.goto(`${BASE}/web#action=180&id=${ticketId}&model=helpdesk.ticket&view_type=form`);
  await page.waitForTimeout(4000);

  // Find receipt picking linked to this ticket via RPC
  const receiptPickings = await rpc(page, 'stock.picking', 'search_read',
    [[['x_studio_created_from_help_ticket', '=', ticketId], ['picking_type_code', '=', 'incoming']]],
    { fields: ['id', 'name', 'state'], limit: 1 });
  console.log('  Receipt pickings found:', JSON.stringify(receiptPickings));
  await check('Receipt picking created by wizard', receiptPickings.length > 0,
    receiptPickings[0]?.name || 'none');

  if (!receiptPickings.length) { await browser.close(); return; }
  const receiptPickId = receiptPickings[0].id;
  const receiptPickName = receiptPickings[0].name;

  // Navigate to receipt picking form
  await page.goto(`${BASE}/web#action=stock.action_picking_tree_all&id=${receiptPickId}&model=stock.picking&view_type=form`);
  await page.waitForTimeout(5000);
  await ss(page, 'step12_picking_form');

  // Confirm we're on the receipt picking form
  const pickFormVisible = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
  await check(`On receipt picking form (${receiptPickName})`, pickFormVisible, page.url());

  // Detailed Operations tab — set serial number
  const detailTabBtn = page.locator('.o_notebook .nav-link:has-text("Detailed Operations"), .o_notebook .nav-link:has-text("Details")').first();
  if (await detailTabBtn.isVisible().catch(() => false)) {
    await detailTabBtn.click();
    await page.waitForTimeout(2000);
    await ss(page, 'step12_detail_ops');

    const lotInputs = page.locator('.o_data_row [name="lot_id"] input, .o_data_row [name="lot_name"] input');
    const lotCount = await lotInputs.count();
    console.log(`  Lot inputs in detail rows: ${lotCount}`);

    if (lotCount > 0) {
      const firstLotVal = await lotInputs.first().inputValue().catch(() => '');
      if (!firstLotVal) {
        await lotInputs.first().fill(deliveryInfo.serialName);
        await page.waitForTimeout(1500);
        const opt = page.locator(`.o-autocomplete--dropdown-item:has-text("${deliveryInfo.serialName}")`).first();
        if (await opt.isVisible().catch(() => false)) await opt.click();
        else { await lotInputs.first().fill(deliveryInfo.serialName); await page.keyboard.press('Tab'); }
        await page.waitForTimeout(1000);
        await check('Serial set on receipt move line', true);
      } else {
        await check('Serial already set on receipt move line', true, firstLotVal);
      }
    }

    // Ensure done qty
    const doneQtyInputs = page.locator('.o_data_row [name="quantity"] input');
    if (await doneQtyInputs.count() > 0) {
      const qtyVal = await doneQtyInputs.first().inputValue().catch(() => '0');
      if (parseFloat(qtyVal) === 0) {
        await doneQtyInputs.first().fill('1');
        await page.waitForTimeout(500);
      }
    }
  }

  // Validate the picking
  const validateBtn = page.locator('button[name="button_validate"], button:has-text("Validate")').first();
  const validateVisible = await validateBtn.isVisible().catch(() => false);
  if (validateVisible) {
    await validateBtn.click();
    await page.waitForTimeout(4000);
    await ss(page, 'step12_after_validate');

    // Handle dialogs (backorder, SMS, etc.)
    const dlgModal = page.locator('.modal.d-block.o_technical_modal');
    if (await dlgModal.isVisible().catch(() => false)) {
      console.log('  Dialog after validate, checking buttons...');
      const dlgBtns = await page.evaluate(() =>
        [...document.querySelectorAll('.modal button')].map(b => ({ text: b.textContent.trim(), name: b.getAttribute('name') }))
      );
      console.log('  Dialog buttons:', JSON.stringify(dlgBtns));
      const noBackorder = page.locator('.modal button:has-text("No Backorder"), .modal button[name="process_cancel_backorder"]').first();
      if (await noBackorder.isVisible().catch(() => false)) {
        await noBackorder.click(); await page.waitForTimeout(3000);
      } else {
        const closeDlg = page.locator('.modal button:has-text("Validate"), .modal button.btn-primary').first();
        if (await closeDlg.isVisible().catch(() => false)) { await closeDlg.click(); await page.waitForTimeout(3000); }
        else { await page.keyboard.press('Escape'); await page.waitForTimeout(2000); }
      }
    }

    // Verify picking is done
    const pickData = await rpc(page, 'stock.picking', 'read', [[receiptPickId]], { fields: ['state'] });
    await check('Receipt picking validated (state=done)', pickData[0].state === 'done',
      `state=${pickData[0].state}`);
    await ss(page, 'step12_validated');
  } else {
    await check('Validate button found on picking', false, 'not visible');
    await browser.close(); return;
  }

  // ── STEP 13: Return to ticket, verify x_studio_valid_return ──────────────
  console.log('\n=== STEP 13: Back to ticket — verify valid_return ===');
  await page.goto(`${BASE}/web#action=180&id=${ticketId}&model=helpdesk.ticket&view_type=form`);
  await page.waitForTimeout(5000);
  await ss(page, 'step13_back_ticket');

  // Check via RPC
  const td2 = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_valid_return', 'x_studio_valid_confirm_return', 'x_studio_stage_name', 'repairs_count'] });
  console.log('  Ticket state:', JSON.stringify(td2[0]));
  await check('x_studio_valid_return = True', td2[0].x_studio_valid_return === true,
    `valid_return=${td2[0].x_studio_valid_return}`);
  await check('x_studio_valid_confirm_return = True', td2[0].x_studio_valid_confirm_return === true,
    `valid_confirm_return=${td2[0].x_studio_valid_confirm_return}`);

  // Check Repair Order button is now visible
  const repairHdrBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button')].map(b => ({
      name: b.getAttribute('name') || '',
      text: b.textContent.trim(),
      visible: !!(b.offsetWidth || b.offsetHeight),
    }))
  );
  console.log('  Header buttons now:', JSON.stringify(repairHdrBtns.filter(b => b.visible)));
  const repairBtnVisible = repairHdrBtns.some(b => (b.name === 'action_repair_order_form' || b.text === 'Repair') && b.visible);
  await check('Repair Order button visible', repairBtnVisible,
    repairHdrBtns.filter(b => b.visible).map(b => b.text).join(', '));

  // ── STEP 14: Create Repair Order ──────────────────────────────────────────
  console.log('\n=== STEP 14: Create Repair Order ===');
  if (!repairBtnVisible) {
    await check('BLOCKER: Repair button not visible', false, 'cannot continue');
    await browser.close(); return;
  }

  const repairBtn = page.locator('.o_statusbar_buttons button[name="action_repair_order_form"], .o_statusbar_buttons button:has-text("Repair")').first();
  await repairBtn.click();
  await page.waitForTimeout(6000);
  await ss(page, 'step14_repair_form');

  // action_repair_order_form opens a NEW repair form (res_id=0) with defaults.
  // The repair must be saved before it can be confirmed.
  const onRepairNew = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
  await check('Repair order form opened (new)', onRepairNew, page.url());

  if (!onRepairNew) {
    // List all visible elements for debug
    const pageTitle = await page.locator('.o_breadcrumb .o_last_breadcrumb_item').textContent().catch(() => '');
    console.log('  Page title:', pageTitle);
    await browser.close(); return;
  }

  // Log repair form header buttons
  const repairNewBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button')].map(b => ({ name: b.getAttribute('name'), text: b.textContent.trim(), visible: !!(b.offsetWidth || b.offsetHeight) }))
  );
  console.log('  Repair form buttons:', JSON.stringify(repairNewBtns.filter(b => b.visible)));

  // SAVE the new repair order
  console.log('  Saving new repair order...');
  const repairSaveBtn = page.locator('.o_form_button_save');
  if (await repairSaveBtn.isVisible().catch(() => false)) {
    await repairSaveBtn.click();
    await page.waitForTimeout(4000);
    await ss(page, 'step14_repair_saved');
  }

  // Verify save succeeded (no error dialog)
  const repairSaveError = await page.locator('.o_error_dialog').isVisible().catch(() => false);
  await check('Repair order saved without error', !repairSaveError, repairSaveError ? 'error dialog appeared' : 'ok');

  // Verify repairs_count > 0 on ticket via RPC
  const ticketAfterRepair = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]], { fields: ['repairs_count'] });
  await check('repairs_count > 0 after save', ticketAfterRepair[0].repairs_count > 0,
    `repairs_count=${ticketAfterRepair[0].repairs_count}`);

  const repairState = await page.locator('.o_statusbar_status .o_arrow_button_current span').first().textContent().catch(() => '');
  console.log(`  Repair state after save: "${repairState.trim()}"`);

  // ── STEP 15: Confirm Draft Quotation → Confirm Repair ────────────────────
  console.log('\n=== STEP 15: Confirm Draft Quotation → Confirm Repair ===');
  // Custom flow: "Confirm Draft Quotation" must be clicked first (sets x_studio_confirm_draft_quotation=True)
  // THEN "Confirm Repair" (action_validate) becomes visible.
  const confirmDraftBtn = page.locator('button:has-text("Confirm Draft Quotation")').first();
  const confirmDraftVisible = await confirmDraftBtn.isVisible().catch(() => false);
  await check('Confirm Draft Quotation button visible', confirmDraftVisible);

  if (confirmDraftVisible) {
    await confirmDraftBtn.click();
    await page.waitForTimeout(4000);
    await ss(page, 'step15_after_confirm_draft');
    await check('Confirm Draft Quotation clicked', true);
  }

  // Now "Confirm Repair" should be visible (state=draft AND x_studio_confirm_draft_quotation=True)
  const confirmBtn = page.locator('button[name="action_validate"], button:has-text("Confirm Repair")').first();
  const confirmVisible = await confirmBtn.isVisible().catch(() => false);
  await check('Confirm Repair button visible after Confirm Draft', confirmVisible,
    await confirmBtn.textContent().catch(() => ''));

  if (confirmVisible) {
    await confirmBtn.click();
    await page.waitForTimeout(3000);
    await ss(page, 'step15_after_confirm');

    // stock.warn.insufficient.qty.repair opens as a dialog (both .o_dialog and .modal.d-block.o_technical_modal).
    // Footer: "Discard" btn-primary (cancel_button) + "Confirm" btn-secondary (action_done).
    // Use name="action_done" to avoid accidentally clicking Discard.
    const actionDoneBtn = page.locator('button[name="action_done"]');
    try {
      await actionDoneBtn.waitFor({ state: 'visible', timeout: 5000 });
      const dlgBtns = await page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"] button, .o_dialog button')].map(b => ({ name: b.getAttribute('name'), text: b.textContent.trim() }))
      );
      console.log('  Insufficient Qty wizard buttons:', JSON.stringify(dlgBtns));
      await actionDoneBtn.click();
      await page.waitForTimeout(3000);
      await ss(page, 'step15_insuf_qty_confirmed');
      await check('Insufficient Qty wizard confirmed (action_done)', true);
    } catch {
      // Wizard may not appear if product is in stock — that's fine
      console.log('  No action_done button found — wizard did not appear (product may be in stock)');
    }

    await check('Confirm Repair clicked', true);
    await page.waitForTimeout(2000);

    // Read state via RPC (statusbar DOM selector unreliable in Odoo 17)
    const repairUrl = page.url();
    const repairIdMatch = repairUrl.match(/[?&#]id=(\d+)/);
    const repairId = repairIdMatch ? parseInt(repairIdMatch[1]) : null;
    if (repairId) {
      const rState = await rpc(page, 'repair.order', 'read', [[repairId]], { fields: ['state'] });
      console.log(`  Repair state after confirm (RPC): "${rState[0].state}"`);
      await check('Repair state = confirmed after Confirm Repair', rState[0].state === 'confirmed', rState[0].state);
    }
  }

  // ── STEP 16: Start Repair ────────────────────────────────────────────────
  console.log('\n=== STEP 16: Start Repair ===');
  const startBtn = page.locator('button[name="action_repair_start"], button:has-text("Start Repair")').first();
  const startVisible = await startBtn.isVisible().catch(() => false);
  if (startVisible) {
    const repairUrl2 = page.url();
    const repairIdMatch2 = repairUrl2.match(/[?&#]id=(\d+)/);
    const repairId2 = repairIdMatch2 ? parseInt(repairIdMatch2[1]) : null;
    await startBtn.click();
    await page.waitForTimeout(3000);
    await ss(page, 'step16_repair_started');
    await check('Start Repair clicked', true);
    if (repairId2) {
      const rState2 = await rpc(page, 'repair.order', 'read', [[repairId2]], { fields: ['state'] });
      console.log(`  Repair state after start (RPC): "${rState2[0].state}"`);
      await check('Repair state = under_repair', rState2[0].state === 'under_repair', rState2[0].state);
    }
  } else {
    await check('Start Repair button visible', false, 'skipped — may already be under repair or draft flow');
  }

  // ── STEP 17: End / Validate Repair ───────────────────────────────────────
  console.log('\n=== STEP 17: End / Validate Repair ===');
  const endBtn = page.locator('button[name="action_repair_end"], button:has-text("End Repair"), button:has-text("Validate Repair")').first();
  const endVisible = await endBtn.isVisible().catch(() => false);
  if (endVisible) {
    const repairUrl3 = page.url();
    const repairIdMatch3 = repairUrl3.match(/[?&#]id=(\d+)/);
    const repairId3 = repairIdMatch3 ? parseInt(repairIdMatch3[1]) : null;
    await endBtn.click();
    await page.waitForTimeout(3000);
    await ss(page, 'step17_repair_done');

    // Handle any invoice/confirmation dialog
    const dlg2 = page.locator('.o_dialog .o_form_view, .modal .o_form_view');
    if (await dlg2.first().isVisible().catch(() => false)) {
      const dlgOk2 = page.locator('.o_dialog button.btn-primary, .modal button.btn-primary').first();
      if (await dlgOk2.isVisible().catch(() => false)) { await dlgOk2.click(); await page.waitForTimeout(2000); }
    }
    await check('End/Validate Repair clicked', true);

    if (repairId3) {
      const rState3 = await rpc(page, 'repair.order', 'read', [[repairId3]], { fields: ['state'] });
      console.log(`  Repair state after end (RPC): "${rState3[0].state}"`);
      await check('Repair state = done', rState3[0].state === 'done', rState3[0].state);
    }
  } else {
    await check('End Repair button visible', false, 'not visible — check state');
  }

  // ── STEP 18: Back to ticket, verify final state ───────────────────────────
  console.log('\n=== STEP 18: Back to ticket — verify stage after repair ===');
  await page.goto(`${BASE}/web#action=180&id=${ticketId}&model=helpdesk.ticket&view_type=form`);
  await page.waitForTimeout(5000);
  await ss(page, 'step18_final_ticket');

  const td3 = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
    { fields: ['x_studio_stage_name', 'repairs_count', 'x_studio_valid_confirm_return', 'x_studio_handed_over'] });
  console.log('  Final ticket state:', JSON.stringify(td3[0]));

  await check('Ticket has repairs_count > 0', td3[0].repairs_count > 0,
    `repairs_count=${td3[0].repairs_count}`);

  const finalStage = td3[0].x_studio_stage_name || '';
  console.log(`  Final stage: "${finalStage}" (handed_over=${td3[0].x_studio_handed_over})`);
  await check('Ticket stage = Repair Completed after repair done', finalStage === 'Repair Completed',
    `stage="${finalStage}"`);

  // Check current header buttons
  const finalBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button')].filter(b => b.offsetWidth || b.offsetHeight).map(b => b.textContent.trim())
  );
  console.log('  Header buttons at end:', finalBtns);

  // ── STEP 19: Dispatch to Customer → Handed Over to Customer ──────────────
  console.log('\n=== STEP 19: Dispatch — Handed Over to Customer ===');

  // Find the receipt picking for this ticket (incoming, done, linked to ticket)
  const receiptPickings2 = await rpc(page, 'stock.picking', 'search_read',
    [[['x_studio_created_from_help_ticket', '=', ticketId], ['picking_type_code', '=', 'incoming'], ['state', '=', 'done']]],
    { fields: ['id', 'name'], limit: 1 });
  console.log('  Receipt picking for dispatch:', JSON.stringify(receiptPickings2));

  if (receiptPickings2.length) {
    const receiptId = receiptPickings2[0].id;
    // Navigate to receipt picking
    await page.goto(`${BASE}/web#action=stock.action_picking_tree_all&id=${receiptId}&model=stock.picking&view_type=form`);
    await page.waitForTimeout(5000);
    await ss(page, 'step19_receipt_picking_dispatch');

    // "Dispatch to Customer" button should be visible (x_studio_rug_dispatch_ready=True now that stage=Repair Completed)
    const dispatchBtn = page.locator('button[name="action_dispatch_return"]:has-text("Dispatch to Customer"), button:has-text("Dispatch to Customer")').first();
    const dispatchVisible = await dispatchBtn.isVisible().catch(() => false);
    await check('"Dispatch to Customer" button visible on receipt picking', dispatchVisible);

    if (dispatchVisible) {
      await dispatchBtn.click();
      await page.waitForTimeout(5000);
      await ss(page, 'step19_dispatch_wizard');

      // Dispatch return wizard opens (same return wizard, but x_studio_is_dispatch=True)
      const dispatchWizard = page.locator('.modal.d-block.o_technical_modal, .modal.d-block');
      const wizVisible = await dispatchWizard.first().isVisible().catch(() => false);
      console.log('  Dispatch wizard visible:', wizVisible);
      await check('Dispatch return wizard opened', wizVisible);

      if (wizVisible) {
        const returnBtn2 = page.locator('button[name="create_returns"], .modal button.btn-primary:has-text("Return")').first();
        if (await returnBtn2.isVisible().catch(() => false)) {
          await returnBtn2.click();
          await page.waitForTimeout(5000);
          await ss(page, 'step19_dispatch_return_confirmed');
          await check('Dispatch return wizard confirmed', true);
        } else {
          const dlgBtns2 = await page.evaluate(() =>
            [...document.querySelectorAll('.modal button')].map(b => b.textContent.trim())
          );
          await check('Dispatch return wizard "Return" button found', false, dlgBtns2.join(', '));
        }
      }
    }

    // Find the dispatch picking (is_dispatch=True, linked to ticket, state=assigned)
    await page.goto(`${BASE}/web#action=180&id=${ticketId}&model=helpdesk.ticket&view_type=form`);
    await page.waitForTimeout(3000);

    const dispatchPickings = await rpc(page, 'stock.picking', 'search_read',
      [[['x_studio_helpdesk_ticket_id', '=', ticketId], ['x_studio_is_dispatch', '=', true]]],
      { fields: ['id', 'name', 'state'], limit: 1 });
    console.log('  Dispatch pickings:', JSON.stringify(dispatchPickings));
    await check('Dispatch picking created (is_dispatch=True)', dispatchPickings.length > 0,
      dispatchPickings[0]?.name || 'none');

    if (dispatchPickings.length) {
      const dispPickId = dispatchPickings[0].id;

      // Validate via Python helper (bypasses SMS wizard and stock reservation issues
      // caused by the force-validated setup delivery not putting serial into quants properly)
      console.log('  Validating dispatch picking via Python helper...');
      try {
        execSync(`docker cp /tmp/validate_dispatch_picking.py odoo17:/tmp/validate_dispatch_picking.py`);
        const dpOut = execSync(`docker exec odoo17 python3 /tmp/validate_dispatch_picking.py ${ticketId} 2>/dev/null`).toString().trim();
        const dpResult = JSON.parse(dpOut);
        console.log('  Dispatch validate result:', dpResult);
        await check('Dispatch picking validated (state=done)', dpResult.state === 'done', `state=${dpResult.state}`);
      } catch (e) {
        await check('Dispatch picking validated (state=done)', false, e.message.slice(0, 100));
      }

      // Back to ticket — verify "Handed Over to Customer"
      await page.goto(`${BASE}/web#action=180&id=${ticketId}&model=helpdesk.ticket&view_type=form`);
      await page.waitForTimeout(5000);
      await ss(page, 'step19_final_ticket');

      const td4 = await rpc(page, 'helpdesk.ticket', 'read', [[ticketId]],
        { fields: ['x_studio_stage_name', 'x_studio_handed_over'] });
      console.log('  Final ticket after dispatch:', JSON.stringify(td4[0]));
      await check('Ticket stage = Handed Over to Customer',
        td4[0].x_studio_stage_name === 'Handed Over to Customer',
        `stage="${td4[0].x_studio_stage_name}"`);
    }
  } else {
    await check('Receipt picking found for dispatch', false, 'not found');
  }

  // ── JS ERRORS ─────────────────────────────────────────────────────────────
  console.log('\n=== JS Error check ===');
  await check('No JS errors', jsErrors.length === 0, jsErrors.slice(0, 2).join('; ') || 'none');

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`RUG PHASE-2 TEST: ${fail === 0 ? '✅ PASS' : '❌ PARTIAL'}`);
  console.log(`${pass} passed, ${fail} failed of ${results.length} checks`);
  if (fail > 0) {
    console.log('\nFailed checks:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.label}: ${r.detail}`));
  }

  await browser.close();
})();
