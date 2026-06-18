/**
 * RUG End-to-End Flow Test
 * Tests: Repair Under Warranty (RUG) — Centre Repair flow
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8169';
const SS_DIR = '/tmp/smoke_test/screenshots/rug';
fs.mkdirSync(SS_DIR, { recursive: true });
try { fs.readdirSync(SS_DIR).forEach(f => fs.unlinkSync(path.join(SS_DIR, f))); } catch {}

let sc = 0;
const results = [];

async function ss(page, name) {
  const p = path.join(SS_DIR, `${String(++sc).padStart(2,'0')}_${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}
async function check(label, cond, detail='') {
  const ok = typeof cond === 'function' ? await cond() : cond;
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  return ok;
}

// Fill a many2one/many2many input and pick the first matching option
async function selectField(page, fieldName, searchText, optionText) {
  const input = page.locator(`[name="${fieldName}"] input`).first();
  await input.fill(searchText);
  await page.waitForTimeout(1800);
  const optLoc = optionText
    ? page.locator(`.o-autocomplete--dropdown-item:has-text("${optionText}")`).first()
    : page.locator('.o-autocomplete--dropdown-item').first();
  const visible = await optLoc.isVisible().catch(() => false);
  if (visible) {
    await optLoc.click();
    await page.waitForTimeout(1000);
    return true;
  }
  return false;
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
  await check('Login succeeds', !page.url().includes('/login'), page.url());

  // ── STEP 1: Open new ticket form ──
  console.log('\n=== STEP 1: Open new ticket form ===');
  await page.goto(BASE + '/web#action=180&model=helpdesk.ticket&view_type=form');
  await page.waitForTimeout(5000);
  const isForm = await page.locator('.o_form_view .o_form_sheet').isVisible().catch(() => false);
  await check('New ticket form opened (full form)', isForm, page.url());
  if (!isForm) { await browser.close(); return; }
  await ss(page, 'step1_new_form');

  // ── STEP 2: Assign to Me FIRST (before filling fields) ──
  console.log('\n=== STEP 2: Assign to Me ===');

  // The button should be visible when user_id is not set
  const assignBtn = page.locator('button[name="assign_ticket_to_self"]');
  const assignVisible = await assignBtn.isVisible().catch(() => false);
  await check('Assign to Me button visible on blank ticket', assignVisible);

  if (assignVisible) {
    await assignBtn.click();
    await page.waitForTimeout(5000); // form reloads
    await ss(page, 'step2_after_assign');
    const userVal = await page.locator('[name="user_id"] input').inputValue().catch(() => '');
    await check('User assigned after Assign to Me', !!userVal, userVal || 'empty');
    // Button should disappear (user_id is now set to current user)
    const assignGone = !(await assignBtn.isVisible().catch(() => false));
    await check('Assign to Me button hidden after assignment', assignGone);
  }

  // ── STEP 3: Set Helpdesk Team ──
  console.log('\n=== STEP 3: Set Team ===');
  const teamInput = page.locator('[name="team_id"] input');
  const currentTeam = await teamInput.inputValue().catch(() => '');
  if (!currentTeam) {
    const ok = await selectField(page, 'team_id', 'Customer', 'Customer Care');
    await check('Team set to Customer Care', ok);
  } else {
    await check('Team already set', true, currentTeam);
  }

  // ── STEP 4: Set Ticket Type = RUG ──
  console.log('\n=== STEP 4: Set Ticket Type (RUG) ===');
  const ttOk = await selectField(page, 'ticket_type_id', 'Repair - Under', 'Repair - Under Warranty (RUG)');
  await check('Ticket Type set to RUG', ttOk);
  await page.waitForTimeout(2000); // onchange triggers

  // Check RUG indicator appeared
  const rugIndicator = await page.locator('[name="x_studio_rug_repair"]').isVisible().catch(() => false);
  await check('x_studio_rug_repair indicator visible', rugIndicator);
  await ss(page, 'step4_ticket_type_rug');

  // ── STEP 5: Fill remaining fields ──
  console.log('\n=== STEP 5: Fill repair details ===');

  // Customer
  const custOk = await selectField(page, 'partner_id', 'Test Customer', 'Test Customer RUG');
  await check('Customer set', custOk);

  // Serial Number
  const snFieldVisible = await page.locator('[name="x_studio_serial_no"]').isVisible().catch(() => false);
  if (snFieldVisible) {
    const snOk = await selectField(page, 'x_studio_serial_no', 'SN-RUG', 'SN-RUG-TEST-001');
    await check('Serial Number set', snOk);
  } else {
    await check('Serial Number field visible', false, 'Field not visible');
  }
  await page.waitForTimeout(1000);

  // Product: for RUG, auto-filled from serial onchange and readonly (no input).
  // Will verify after save when the form reloads with DB data.
  await page.waitForTimeout(500);

  // Repair Reason
  const reasonOk = await selectField(page, 'x_studio_repair_reason', 'Screen', 'Screen Defect');
  await check('Repair Reason set', reasonOk);

  // Return Receipt Location
  const rrLocOk = await selectField(page, 'x_studio_return_receipt_location', 'WH', null);
  await check('Return Receipt Location set', rrLocOk);

  // Job Location = Centre Repair
  const jobLocEl = page.locator('[name="x_studio_job_location"]');
  const jobLocCount = await jobLocEl.count();
  if (jobLocCount > 0) {
    // Try clicking the widget to open selection
    await jobLocEl.click();
    await page.waitForTimeout(500);
    const centreOpt = page.locator('.o-autocomplete--dropdown-item:has-text("Centre Repair"), option:has-text("Centre Repair")').first();
    if (await centreOpt.isVisible().catch(() => false)) {
      await centreOpt.click();
      await check('Job Location = Centre Repair', true);
    } else {
      // try select element
      const sel = page.locator('[name="x_studio_job_location"] select');
      if (await sel.count() > 0) {
        await sel.selectOption({ label: 'Centre Repair' });
        await check('Job Location = Centre Repair', true);
      } else {
        await check('Job Location = Centre Repair', false, 'option not found');
      }
    }
  } else {
    await check('Job Location field in form', false, 'not in DOM');
  }

  await ss(page, 'step5_fields_filled');

  // ── STEP 6: Save the ticket ──
  console.log('\n=== STEP 6: Save ===');
  // Click save if dirty
  const saveBtn = page.locator('.o_form_button_save');
  if (await saveBtn.isVisible().catch(() => false)) {
    await saveBtn.click();
    await page.waitForTimeout(4000);
  }
  const saveError = await page.locator('.o_error_dialog').isVisible().catch(() => false);
  await check('Ticket saved without error', !saveError);
  await ss(page, 'step6_saved');

  // Get ticket name
  const ticketRef = await page.locator('[name="name"] span').first().textContent().catch(() => '');
  console.log(`  Ticket: ${ticketRef.trim()}`);
  await check('Ticket has sequence number', !!ticketRef.trim(), ticketRef.trim() || 'empty');

  // ── STEP 7: Verify state after save ──
  console.log('\n=== STEP 7: Verify ticket state ===');
  const stageText = await page.locator('.o_statusbar_status .o_arrow_button_current span').first().textContent().catch(() => '');
  await check('Stage is New', stageText.trim() === 'New', `stage="${stageText.trim()}"`);

  // Product should now be filled (set by onchange from serial number, saved to DB)
  const productVal = await page.evaluate(() => {
    const el = document.querySelector('[name="product_id"]');
    if (!el) return '';
    const input = el.querySelector('input');
    if (input) return input.value;
    // readonly field — text content
    return el.textContent.replace(/\s+/g, ' ').trim();
  });
  await check('Product filled from serial onchange', !!productVal.replace(/internal link/i,'').trim(),
    productVal.replace(/internal link/i,'').trim() || 'empty');

  const repairLocVal = await page.evaluate(() => {
    const el = document.querySelector('[name="x_studio_repair_location"]');
    return el ? el.textContent.trim() : '';
  });
  await check('Repair Location auto-filled', !!repairLocVal, repairLocVal || 'empty');

  // Check which header buttons are visible
  const hdrBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.o_statusbar_buttons button')].map(b => b.textContent.trim()).filter(t => t)
  );
  console.log('  Header buttons:', hdrBtns);

  // ── STEP 8: Warranty card upload (RUG requirement) ──
  console.log('\n=== STEP 8: Warranty Card field check ===');
  // List visible tabs for diagnostics
  const visibleTabs = await page.evaluate(() =>
    [...document.querySelectorAll('.o_notebook .nav-link')].map(t => t.textContent.trim())
  );
  console.log('  Visible tabs:', visibleTabs);

  // Warranty card is on the "Warranty Details" notebook tab — click it to activate
  const warrantyTab = page.locator('.o_notebook .nav-link:has-text("Warranty Details")').first();
  if (await warrantyTab.isVisible().catch(() => false)) {
    await warrantyTab.click({ force: true });
    await page.waitForTimeout(2000);
    // Image fields in Odoo 17 render with a fixed height (90px from options); check count
    const warrantyCount = await page.locator('[name="x_studio_warranty_card"]').count().catch(() => 0);
    const warrantyH = await page.evaluate(() => {
      const el = document.querySelector('[name="x_studio_warranty_card"]');
      if (!el) return -1;
      return el.getBoundingClientRect().height;
    });
    console.log(`  warranty_card: count=${warrantyCount}, height=${warrantyH}`);
    await check('Warranty card field present on Warranty Details tab', warrantyCount > 0 && warrantyH >= 0,
      `count=${warrantyCount} height=${warrantyH}`);
  } else {
    const inDOM = await page.locator('[name="x_studio_warranty_card"]').count() > 0;
    await check('Warranty card field in DOM', inDOM);
  }
  await ss(page, 'step8_warranty');

  // ── STEP 9: Check Receipt/Create Repair Serial button ──
  console.log('\n=== STEP 9: Expected first action button (Create Repair Serial / Receipt) ===');
  // For RUG with serial: the first action is "Update Serial" to link the serial to the product
  // then "Receipt" to accept the item from customer
  // OR "Create Repair Serial" for normal repairs
  const updateSerialVisible = hdrBtns.some(t => t.includes('Update Serial'));
  const receiptVisible = hdrBtns.some(t => t === 'Receipt');
  const createRepairSerialVisible = hdrBtns.some(t => t.includes('Create Repair'));
  console.log(`  Update Serial: ${updateSerialVisible}`);
  console.log(`  Receipt: ${receiptVisible}`);
  console.log(`  Create Repair Serial/Route: ${createRepairSerialVisible}`);
  await check('Action buttons present in header', hdrBtns.length > 0, hdrBtns.join(', ') || 'none');

  // ── JS ERRORS ──
  console.log('\n=== JS Error check ===');
  await check('No JS errors', jsErrors.length === 0, jsErrors.slice(0, 2).join('; ') || 'none');

  // ── SUMMARY ──
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`RUG FLOW TEST: ${fail === 0 ? '✅ PASS' : '❌ PARTIAL'}`);
  console.log(`${pass} passed, ${fail} failed of ${results.length} checks`);
  if (fail > 0) {
    console.log('\nFailed checks:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.label}: ${r.detail}`));
  }

  await browser.close();
})();
