'use strict';
/*
 * The smart import, with the exact shape of Odoo's "POS orders report" (تقرير طلبات نقطة البيع):
 * a title, "الفترة: من … إلى …", the export time, then the table — product names that carry a
 * [POS-…] code, an English half and a repeated second line.
 *
 *   - the table head and the report's day are found on their own
 *   - a name never seen before is offered as a NEW product under a clean name the shop can edit,
 *     link to an existing product, or skip — never dropped silently
 *   - sales for a switched-off product are recorded AND flagged, with a button to switch it back on
 *   - the Odoo code links a product for good: a renamed cell still lands on it
 *   - the Products tab shows on/off plainly and the aliases readably, without losing any match
 *
 *   node tools/test-smart-import.js            (dev build)
 *   DAFTAR_EXE=...\Talabia.exe node tools/test-smart-import.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-smart-'));
const DATA_FILE = path.join(PROFILE, 'branches', 'caneles-1', 'daftar.json');
const PORT = 9300 + Math.floor(Math.random() * 600);
const EXE = process.env.DAFTAR_EXE || null;

let pass = 0, fail = 0;
const pageErrors = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function launch() {
  const args = EXE ? ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT]
                   : ['.', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  return spawn(EXE || ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* still booting */ }
    await sleep(500);
  }
  throw new Error('the app never exposed a debuggable page');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    const send = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push('exception: ' + (d.exception && d.exception.description || d.text));
      }
      if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate threw');
        return r.result.result.value;
      };
      resolve({ send, evaluate, close: () => ws.close() });
    });
  });
}
async function waitFor(cdp, expr, label, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cdp.evaluate('!!(' + expr + ')')) return true;
    await sleep(150);
  }
  throw new Error('timed out waiting for ' + label);
}
const { killOrphans } = require('./orphans');

// the 26 Sep report, cell for cell
const REPORT_26 = [
  ['تقرير طلبات نقطة البيع: CANELÈS Al Narjis | كانوليه النرجس', '', '', '', '', ''],
  ['الفترة: من 2026-09-26 إلى 2026-09-26', '', '', '', '', ''],
  ['تاريخ التصدير: 2026-10-02 03:50:39', '', '', '', '', ''],
  ['م', 'كود المنتج', 'اسم المنتج', 'الكمية', 'وحدة القياس', 'عدد الطلبات'],
  ['1', 'POS-CN-022', '[POS-CN-022] Chocolate Bites | شوكليت بايتس\n[POS-CN-022] Chocolate Bites', '4.00', 'حبة', '4.00'],
  ['2', 'POS-CN-021', '[POS-CN-021] Honey Bites | هني بايتس\n[POS-CN-021] Honey Bites', '4.00', 'حبة', '4.00'],
  ['3', 'POS-CN-009', '[POS-CN-009] Blcak Coffee Box | بلاك كوفي', '1.00', 'حبة', '1.00'],
  ['4', 'POS-CN-017', '[POS-CN-017] Saudi coffee | قهوة سعودية\n[POS-CN-017] Saudi coffee', '1.00', 'حبة', '1.00'],
  ['5', 'POS-CN-007', '[POS-CN-007] Ice Cream Bites | ايسكريم بايتس\n[POS-CN-007] Ice Cream Bites', '1.00', 'حبة', '1.00'],
  ['', '', 'الإجمالي:', '11.00', '', '']
];

async function openReport(cdp, rows, name) {
  const ok = await cdp.evaluate(`(async function(){
    var X = await loadXLSX(), wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(${JSON.stringify(rows)}), "المنتجات");
    var out = X.write(wb, {bookType:"xlsx", type:"array"});
    window.S.imp = null;
    startImport(new File([out], ${JSON.stringify(name)}));
    return "ok";
  })()`);
  await waitFor(cdp, `window.S.imp && window.S.imp.fileName === ${JSON.stringify(name)} && document.getElementById("impScope")`, 'the import screen for ' + name);
  return ok;
}
const pid = (cdp, n) => cdp.evaluate(`(window.S.products.filter(function(p){return p.name===${JSON.stringify(n)}})[0]||{}).id||null`);

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('smart import test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await targets()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('document.getElementById("fresh").click()');
  await waitFor(cdp, 'window.S.demo === false', 'an empty branch');
  // the shop's own catalogue: four products by their plain names; the two coffees switched off
  await cdp.evaluate(`(function(){
    [["شوكليت بايتس",true],["هني بايتس",true],["بلاك كوفي",false],["قهوة سعودية",false]].forEach(function(x,i){
      var p={id:"s"+i, name:x[0], unit:"حبة", shelfLife:4, packSize:1, moq:0, active:x[1], aliases:[]};
      window.S.products.push(p); saveProduct(p);
    });
    relearn(); return 1 })()`);
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click()');
  await sleep(300);

  console.log('--- the report is read on its own ---');
  await openReport(cdp, REPORT_26, 'report-26.xlsx');
  const head = JSON.parse(await cdp.evaluate('JSON.stringify({h:S.imp.headers, c:S.imp.cols, scope:S.imp.scope, day:S.imp.singleDate})'));
  check('finds the table under the title lines (product = اسم المنتج, qty = الكمية)',
    head.h[head.c.product] === 'اسم المنتج' && head.h[head.c.qty] === 'الكمية', JSON.stringify(head));
  check('reads the day from «الفترة: من 2026-09-26 إلى 2026-09-26»', head.scope === 'day' && head.day === '2026-09-26', JSON.stringify(head));
  check('and says so on the screen', await cdp.evaluate('document.getElementById("impScope").innerText.indexOf("قُرئ هذا اليوم من رأس التقرير") >= 0'));

  console.log('\n--- a name never seen is a new product, not a dropped row ---');
  let a = JSON.parse(await cdp.evaluate(`(function(){var a=analyzeImport(); return JSON.stringify({
    entries:a.entries.length, unmatched:Object.keys(a.unmatched).map(function(k){return a.unmatched[k].name}),
    inactive:a.inactive.map(function(x){return x.name}), summary:a.summary, noQty:a.noQty})})()`));
  check('the four known products match (coffee included)', a.entries === 4, JSON.stringify(a));
  check('only ايسكريم بايتس is new', a.unmatched.length === 1 && /ايسكريم بايتس/.test(a.unmatched[0]), JSON.stringify(a.unmatched));
  check('the total line is not a product', a.summary >= 1, JSON.stringify(a));
  const sug = await cdp.evaluate('(document.querySelector("#impNewTable .impNewName")||{}).value');
  check('the screen offers it as a new product under a clean name (' + sug + ')', sug === 'ايسكريم بايتس' &&
    await cdp.evaluate('!!document.getElementById("impNewAsk") && document.querySelector("#impNewTable .impMap").value === "__auto"'));

  // skip it, then take the skip back
  await cdp.evaluate('(function(){var s=document.querySelector("#impNewTable .impMap"); s.value="__skip"; s.dispatchEvent(new Event("change",{bubbles:true})); return 1})()');
  await sleep(300);
  check('a skipped name stays on the list, so the skip can be undone',
    await cdp.evaluate('document.querySelectorAll("#impNewTable tbody tr").length === 1 && document.querySelector("#impNewTable .impMap").value === "__skip"'));
  await cdp.evaluate('(function(){var s=document.querySelector("#impNewTable .impMap"); s.value="__auto"; s.dispatchEvent(new Event("change",{bubbles:true})); return 1})()');
  await sleep(300);
  // the shop edits the suggested name
  await cdp.evaluate('(function(){var el=document.querySelector("#impNewTable .impNewName"); el.value="آيسكريم بايتس"; el.dispatchEvent(new Event("input",{bubbles:true})); return 1})()');

  console.log('\n--- switched-off products ---');
  check('sales for switched-off products are flagged (' + a.inactive.join('، ') + ')',
    a.inactive.length === 2 && await cdp.evaluate('document.getElementById("impInactive").innerText.indexOf("بلاك كوفي") >= 0'), JSON.stringify(a.inactive));
  await cdp.evaluate('document.getElementById("impActivate").click()');
  await waitFor(cdp, 'window.S.products.filter(function(p){return p.active===false}).length === 0', 'the coffees to switch on');
  check('«فعّلها» switches them back on', true);
  check('the edited name survived the redraw', await cdp.evaluate('document.querySelector("#impNewTable .impNewName").value') === 'آيسكريم بايتس');

  await waitFor(cdp, '!document.getElementById("impApply").disabled', 'apply');
  check('the button says a product will be added', /استورد/.test(await cdp.evaluate('document.getElementById("impApply").innerText')));
  await cdp.evaluate('document.getElementById("impApply").click()');
  await waitFor(cdp, '!window.S.imp', 'the import');
  const ice = await pid(cdp, 'آيسكريم بايتس');
  const day = JSON.parse(await cdp.evaluate('JSON.stringify(window.S.days["2026-09-26"])'));
  const tot = Object.values(day.items).reduce((s, e) => s + e.sold, 0);
  check('every row is saved: 11 pieces over 5 products', tot === 11 && Object.keys(day.items).length === 5, JSON.stringify(day.items));
  check('the new product exists under the edited name', !!ice && day.items[ice] && day.items[ice].sold === 1);
  check('…and remembers its Odoo code', await cdp.evaluate(`(window.S.products.filter(function(p){return p.id===${JSON.stringify(ice)}})[0].aliases||[]).indexOf("pos cn 007") >= 0`));
  check('the coffees keep their sales', day.items.s2.sold === 1 && day.items.s3.sold === 1, JSON.stringify(day.items));
  check('known products learned their codes too', await cdp.evaluate('window.S.products.filter(function(p){return p.id==="s3"})[0].aliases.indexOf("pos cn 017") >= 0'));
  await sleep(1200);
  const disk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('DISK: the day and the new product are written', disk.days['2026-09-26'] && disk.products.some(p => p.name === 'آيسكريم بايتس'));

  console.log('\n--- a report for another branch is flagged ---');
  check('a report naming the open branch raises no warning', true);
  const elsewhere = REPORT_26.map(r => r.slice());
  elsewhere[0][0] = 'تقرير طلبات نقطة البيع: CANELÈS Al Yasmin | كانوليه الياسمين';
  elsewhere[1][0] = 'الفترة: من 2026-09-28 إلى 2026-09-28';
  await openReport(cdp, elsewhere, 'report-yasmin.xlsx');
  check('a report naming another branch is flagged before saving', await cdp.evaluate('!!document.getElementById("impBranchWarn") && document.getElementById("impBranchWarn").innerText.indexOf("الياسمين") >= 0'));
  await cdp.evaluate('document.getElementById("impCancel2").click()');
  await waitFor(cdp, '!window.S.imp', 'cancel');
  await openReport(cdp, REPORT_26, 'report-26-again.xlsx');
  check('the right branch\'s report is not flagged', !(await cdp.evaluate('!!document.getElementById("impBranchWarn")')));
  await cdp.evaluate('document.getElementById("impCancel2").click()');
  await waitFor(cdp, '!window.S.imp', 'cancel');

  console.log('\n--- the code links a product for good ---');
  const renamed = REPORT_26.map(r => r.slice());
  renamed[1][0] = 'الفترة: من 2026-09-27 إلى 2026-09-27';
  renamed[7][2] = '[POS-CN-017] Arabic coffee | قهوة عربية';           // Odoo renamed it
  renamed[8][2] = '[POS-CN-007] Ice cream | ايس كريم';                  // and this one
  await openReport(cdp, renamed, 'report-27.xlsx');
  a = JSON.parse(await cdp.evaluate(`(function(){var a=analyzeImport(); return JSON.stringify({entries:a.entries.map(function(e){return e.pid+":"+e.how}), unmatched:Object.keys(a.unmatched).length})})()`));
  check('a renamed cell still lands on its product by code', a.unmatched === 0 && a.entries.indexOf('s3:code') >= 0 && a.entries.indexOf(ice + ':code') >= 0, JSON.stringify(a));
  await cdp.evaluate('document.getElementById("impCancel2").click()');
  await waitFor(cdp, '!window.S.imp', 'cancel');

  console.log('\n--- the Products tab ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="items"]\').click()');
  await waitFor(cdp, 'document.querySelector(".itAct")', 'the on/off switches');
  const row = JSON.parse(await cdp.evaluate(`(function(){var tr=document.querySelector('tr[data-pid="s3"]');
    return JSON.stringify({alias: tr.querySelector('.itIn[data-f="aliases"]').value, chips: tr.innerText, on: tr.querySelector(".itAct").checked})})()`));
  check('the Odoo code shows as its own chip (POS-CN-017)', /POS-CN-017/.test(row.chips), row.chips);
  check('the alias field shows readable names, not machine text', !/pos cn/.test(row.alias) && /saudi coffee/.test(row.alias), row.alias);
  check('a product on sale shows «يُباع» and a ticked switch', row.on && /يُباع/.test(row.chips), JSON.stringify(row));
  await cdp.evaluate('(function(){var c=document.querySelector(\'tr[data-pid="s3"] .itAct\'); c.checked=false; c.dispatchEvent(new Event("change",{bubbles:true})); return 1})()');
  await waitFor(cdp, 'window.S.products.filter(function(p){return p.id==="s3"})[0].active === false', 'switching it off');
  check('switching off shows «متوقف»', await cdp.evaluate('document.querySelector(\'tr[data-pid="s3"]\').innerText.indexOf("متوقف") >= 0'));
  // editing the readable names keeps the code and the machine copies
  const before = await cdp.evaluate('window.S.products.filter(function(p){return p.id==="s3"})[0].aliases.length');
  await cdp.evaluate(`(function(){var el=document.querySelector('tr[data-pid="s3"] .itIn[data-f="aliases"]');
    el.value = el.value + "، قهوة الضيافة"; el.dispatchEvent(new Event("input",{bubbles:true})); return 1})()`);
  await sleep(300);
  const al = JSON.parse(await cdp.evaluate('JSON.stringify(window.S.products.filter(function(p){return p.id==="s3"})[0].aliases)'));
  check('adding a name keeps every match the product had (' + before + ' → ' + al.length + ')',
    al.length === before + 1 && al.indexOf('saudi coffee') >= 0 && al.indexOf('pos cn 017') >= 0 && al.indexOf(await cdp.evaluate('normName("قهوة الضيافة")')) >= 0, JSON.stringify(al));

  // erasing a name never leaves the product nameless
  await cdp.evaluate(`(function(){var el=document.querySelector('tr[data-pid="s0"] .itIn[data-f="name"]'); el.focus();
    el.value="شو"; el.dispatchEvent(new Event("input",{bubbles:true}));
    el.value=""; el.dispatchEvent(new Event("input",{bubbles:true})); return 1})()`);
  check('an emptied name is not saved while typing', await cdp.evaluate('window.S.products.filter(function(p){return p.id==="s0"})[0].name') === 'شو');
  await cdp.evaluate(`(function(){var el=document.querySelector('tr[data-pid="s0"] .itIn[data-f="name"]'); el.dispatchEvent(new Event("change",{bubbles:true})); return 1})()`);
  await sleep(300);
  check('…and leaving it empty puts the name back', await cdp.evaluate(`document.querySelector('tr[data-pid="s0"] .itIn[data-f="name"]').value`) === 'شو' &&
    await cdp.evaluate('window.S.products.filter(function(p){return p.id==="s0"})[0].name') === 'شو');

  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
