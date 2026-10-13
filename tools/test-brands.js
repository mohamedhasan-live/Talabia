'use strict';
/*
 * Brands added by the shop (company.json): a new brand with its first branch, the parent company's name, both kept
 * after a restart; the built-in brands untouched. Throwaway profile, synthetic data only.
 *
 *   node tools/test-brands.js            (dev build)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeStore } = require('../store');
const { killOrphans } = require('./orphans');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const EXE = process.env.DAFTAR_EXE || null;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-brands-'));
const LEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-legacy-'));
let PORT = 9300 + Math.floor(Math.random() * 600);
const fileOf = id => path.join(PROFILE, 'branches', id, 'daftar.json');
const disk = id => JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));

let pass = 0, fail = 0;
const pageErrors = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* The page saves on a short debounce, which Chromium stretches while the test window is in
   the background — so wait until the file says what it should, rather than for a fixed time. */
async function untilDisk(fn, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if (fn()) return true; } catch (e) { /* not written yet */ } await sleep(200); }
  try { return !!fn(); } catch (e) { return false; }
}

/* the two old apps, as they sit on the shop's machine today */
const legacyRecord = (n, branch, prefix) => ({
  v: 1, cfg: { branch, orderDays: [0, 3], leadDays: 1, deliveryHour: 19, tendency: 60 },
  products: Array.from({ length: n }, (_, i) => ({ id: prefix + i, name: 'صنف ' + prefix + i, unit: 'حبة', shelfLife: 5, packSize: 1, moq: 0, active: true, aliases: ['alias ' + prefix + i] })),
  days: { '2026-09-20': { date: '2026-09-20', items: { [prefix + '0']: { sold: 7, waste: 1 } }, closed: true },
          '2026-09-21': { date: '2026-09-21', items: { [prefix + '0']: { sold: 5, waste: 0 } }, closed: true } },
  stock: {}, events: [{ id: 'e1', name: 'اليوم الوطني', kind: 'national', from: '2026-09-21', to: '2026-09-24', mult: 1.45 }], orders: {}
});
makeStore(path.join(LEGACY, 'daftar-altalabiya')).save(legacyRecord(16, 'فرع النرجس', 'c'));
makeStore(path.join(LEGACY, 'daftar-chezzz')).save(legacyRecord(18, 'فرع تشيززز', 'z'));

function launch() {
  const args = ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  const env = Object.assign({}, process.env, { DAFTAR_LEGACY_ROOT: LEGACY });
  return EXE ? spawn(EXE, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
             : spawn(ELECTRON, ['.'].concat(args), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch (e) { /* booting */ }
    await sleep(500);
  }
  throw new Error('the app never exposed a debuggable page');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map(a => a.value || a.description).join(' '));
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
      if (m.method === 'Log.entryAdded' && m.params.entry.source === 'security') pageErrors.push('CSP: ' + m.params.entry.text);
    });
    const send = (method, params) => new Promise(res => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', async () => {
      const ev = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate threw');
        return r.result.result.value;
      };
      await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
      resolve({ ev, close: () => ws.close() });
    });
  });
}
async function waitFor(c, expr, label, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await c.ev('!!(' + expr + ')')) return; await sleep(200); }
  throw new Error('timed out waiting for ' + label);
}

/** First launch of a freshly built exe can be slow (antivirus scan); wait longer and say why if it never comes up. */
async function bootWait(c, expr) {
  try { await waitFor(c, expr, 'the app to start', 90000); }
  catch (e) {
    let diag = '';
    try { diag = await c.ev('JSON.stringify({S:!!window.S, ready:!!(window.S&&S.ready), branch:window.S&&S.branchId, branches:window.S&&S.ws&&S.ws.branches&&S.ws.branches.length, desktop:!!window.desktop, url:location.href, text:(document.body&&document.body.innerText||"").slice(0,300)})'); } catch (x) { diag = 'page not answering: ' + x.message; }
    console.log('BOOT DIAGNOSTIC: ' + diag);
    console.log('PAGE ERRORS: ' + (typeof pageErrors !== 'undefined' ? pageErrors.join(' | ') : ''));
    throw e;
  }
}
const pick = (c, id) => c.ev(`(function(){var s=document.getElementById("branchPick");s.value=${JSON.stringify(id)};s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
const typeIn = (c, sel, val) => c.ev(`(function(){var el=document.querySelector(${JSON.stringify(sel)});el.value=${JSON.stringify(String(val))};el.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
const click = (c, sel) => c.ev(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.click();return true})()`);
const tok = (c, name) => c.ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);

(async () => {
  killOrphans(); process.on('exit', killOrphans);
  console.log('brands, profile ' + PROFILE + '\n');
  let proc = launch();
  let c = await connect((await target()).webSocketDebuggerUrl);
  await bootWait(c, 'window.S && S.ready && S.branchId');
  await c.ev('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');
  const before = JSON.parse(await c.ev('JSON.stringify({brands:BRANDS.map(function(b){return b.key}), branches:S.ws.branches.length, company:COMPANY, current:S.branchId, caneles:S.ws.branches.filter(function(b){return b.brand==="caneles"}).length})'));
  check('the built-in brands are there, and the company starts as Cake Village', before.brands.indexOf('caneles') >= 0 && before.brands.indexOf('chezzz') >= 0 && before.company === 'Cake Village', JSON.stringify(before));

  // the owner's two cards on «البراند والفروع»
  await c.ev('S.tab="branches"; render(); 1'); await sleep(300);
  check('«البراند والفروع» has «براند جديد» and «الشركة الأم»', await c.ev('!!document.querySelector(\'.paneSec[data-s="newbrand"]\') && !!document.querySelector(\'.paneSec[data-s="company"]\') && !!document.getElementById("nbAdd") && !!document.getElementById("coSave")'));

  // the company's name
  await c.ev('document.getElementById("coName").value="Test Holding"; document.getElementById("coSave").click(); 1'); await sleep(500);
  check('the company is renamed (shown in «حول التطبيق»)', await c.ev('COMPANY==="Test Holding" && /Test Holding/.test(aboutCard())'));

  await c.ev('PANES={branches:"newbrand"}; render(); 1'); await sleep(200);
  check('a new brand\'s look: a ready theme, its own colour, or its logo (no «like CANELÉS / CHEZZZ»)', await c.ev('document.querySelectorAll(".nbMode").length===3 && document.querySelectorAll(".nbPre").length===5 && !document.getElementById("nbLook") && !!document.getElementById("nbColor") && !!document.getElementById("nbLogo")'));
  check('…«ثيم بألواني» makes a day and a night theme from one colour, for the new brand', await c.ev('(function(){ saveCustomTheme("#1f6f5c","bzz"); var t=customTheme("bzz"), p=JSON.parse(localStorage.getItem("dq-pal-bzz")); localStorage.removeItem("dq-custom-bzz"); localStorage.removeItem("dq-pal-bzz"); return !!t&&!!t.light.accent&&!!t.dark.accent&&p.light==="custom"&&p.dark==="custom"&&contrast(t.light.accent,"#FFFFFF")>=4.5 })()'));
  // a new brand: refused without a name or with a taken one, then added
  const bad1 = JSON.parse(await c.ev('window.desktop.addBrand({wordmark:"  "}).then(function(r){return JSON.stringify(r)})'));
  const bad2 = JSON.parse(await c.ev('window.desktop.addBrand({wordmark:"chezzz"}).then(function(r){return JSON.stringify(r)})'));
  check('a brand needs a name, and not one already taken', !bad1.ok && !bad2.ok, JSON.stringify([bad1, bad2]));
  const add = JSON.parse(await c.ev('window.desktop.addBrand({wordmark:"CROWN", branch:"فرع الملقا", look:"chezzz"}).then(function(r){return JSON.stringify(r)})'));
  check('a new brand is added (CROWN, first branch «فرع الملقا», looks like CHEZZZ)', add.ok && /^b[a-z0-9]+$/.test(add.key) && add.restart, JSON.stringify(add));
  const file = JSON.parse(fs.readFileSync(path.join(PROFILE, 'company.json'), 'utf8'));
  check('…kept on this computer (company.json)', file.company === 'Test Holding' && file.brands.length === 1 && file.brands[0].wordmark === 'CROWN', JSON.stringify(file));

  // the restart (done here by the test, the app restarts itself for the shop)
  c.close(); proc.kill(); await sleep(1500);
  PORT = 9300 + Math.floor(Math.random() * 600);
  proc = launch();
  c = await connect((await target()).webSocketDebuggerUrl);
  await bootWait(c, 'window.S && S.ready && S.branchId');
  const after = JSON.parse(await c.ev(`JSON.stringify((function(){ var nb=BRANDS.filter(function(b){return b.key===${JSON.stringify(add.key)}})[0];
    var br=S.ws.branches.filter(function(b){return b.brand===${JSON.stringify(add.key)}});
    return {brand:!!nb, word:nb&&nb.wordmark, look:nb&&nb.look, hasPalette:!!(nb&&nb.dark&&nb.dark.accent), branches:br.map(function(b){return b.name}), total:S.ws.branches.length, company:COMPANY} })())`));
  check('after the restart CROWN is a brand like the others, with its colours', after.brand && after.word === 'CROWN' && after.look === 'chezzz' && after.hasPalette, JSON.stringify(after));
  check('…and its first branch «فرع الملقا» was created', after.branches.length === 1 && after.branches[0] === 'فرع الملقا' && after.total === before.branches + 1, JSON.stringify(after));
  check('…the company name stayed', after.company === 'Test Holding', after.company);

  // open the new brand's branch: its name under «Talabia», its own empty products
  const bid = await c.ev(`S.ws.branches.filter(function(b){return b.brand===${JSON.stringify(add.key)}})[0].id`);
  await pick(c, bid);
  await waitFor(c, `S.branchId===${JSON.stringify(bid)} && S.ready`, 'the new branch to open', 30000); await sleep(600);
  const open = JSON.parse(await c.ev('JSON.stringify({word:document.getElementById("wordmark").textContent, brand:curBrandKey(), products:S.products.length, title:document.title})'));
  check('opening it shows «CROWN» under Talabia, as its own brand', open.word === 'CROWN' && open.brand === add.key, JSON.stringify(open));
  // a second branch for the new brand, the usual way
  await c.ev('S.tab="branches"; render(); 1'); await sleep(300);
  const add2 = JSON.parse(await c.ev(`window.desktop.addBranch({brand:${JSON.stringify(add.key)}, name:"فرع النخيل"}).then(function(r){return JSON.stringify({ok:r&&r.ok})})`));
  check('the new brand takes more branches like any brand', add2.ok, JSON.stringify(add2));
  // the built-in brands are untouched
  const built = JSON.parse(await c.ev('JSON.stringify(BRANDS.filter(function(b){return !b.custom}).map(function(b){return b.key}))'));
  check('CANELÉS and CHEZZZ are untouched', built.indexOf('caneles') >= 0 && built.indexOf('chezzz') >= 0 && built.length === 2, JSON.stringify(built));

  // deleting a brand the shop added: the built-in ones refuse; CROWN goes with its branches (to the trash folder)
  await c.ev('S.tab="branches"; PANES={branches:"newbrand"}; render(); 1'); await sleep(300);
  check('the brand card itself has «احذف البراند» (an added brand only)', await c.ev('PANES={branches:""}; render(); !!document.querySelector(".brandcard .delBrand") && document.querySelectorAll(".brandcard .delBrand").length===1'));
  await c.ev('PANES={branches:"newbrand"}; render(); 1');
  check('«البراندات المضافة» lists CROWN with «احذف البراند»', await c.ev(`!!document.querySelector('.delBrand[data-key=${JSON.stringify(add.key)}]') && !document.querySelector('.delBrand[data-key="caneles"]')`));
  const refuse = JSON.parse(await c.ev('window.desktop.removeBrand("chezzz").then(function(r){return JSON.stringify(r)})'));
  check('a built-in brand cannot be deleted', !refuse.ok, JSON.stringify(refuse));
  await pick(c, before.current || (await c.ev('S.ws.branches.filter(function(b){return b.brand==="caneles"})[0].id')));
  await sleep(600);
  const del = JSON.parse(await c.ev(`window.desktop.removeBrand(${JSON.stringify(add.key)}).then(function(r){return JSON.stringify(r)})`));
  const file2 = JSON.parse(fs.readFileSync(path.join(PROFILE, 'company.json'), 'utf8'));
  const trash = fs.existsSync(path.join(PROFILE, 'branches-trash')) ? fs.readdirSync(path.join(PROFILE, 'branches-trash')) : (fs.existsSync(path.join(PROFILE, 'trash')) ? fs.readdirSync(path.join(PROFILE, 'trash')) : []);
  check('CROWN is deleted with its 2 branches, their data moved aside (not erased)', del.ok && del.branches === 2 && file2.brands.length === 0 && (del.moved || []).filter(Boolean).length === 2 && (del.moved || []).every(function(p){ return !p || fs.existsSync(p) }), JSON.stringify({del, file2, trash}));
  c.close(); proc.kill(); await sleep(1500);
  PORT = 9300 + Math.floor(Math.random() * 600);
  proc = launch();
  c = await connect((await target()).webSocketDebuggerUrl);
  await bootWait(c, 'window.S && S.ready && S.branchId');
  const gone = JSON.parse(await c.ev(`JSON.stringify({brand:BRANDS.some(function(b){return b.key===${JSON.stringify(add.key)}}), total:S.ws.branches.length, caneles:S.ws.branches.filter(function(b){return b.brand==="caneles"}).length})`));
  check('after the restart CROWN is gone, and no branch slipped into another brand', !gone.brand && gone.total === before.branches && gone.caneles === before.caneles, JSON.stringify(gone));

  // «المحذوفات»: CROWN is listed, and comes back with its two branches
  const del2 = JSON.parse(await c.ev('JSON.stringify(BRANDS_DELETED)'));
  check('«المحذوفات» remembers the deleted brand (with its branches)', del2.length === 1 && del2[0].wordmark === 'CROWN' && del2[0].branches === 2, JSON.stringify(del2));
  await c.ev('S.tab="branches"; PANES={branches:"brtrash"}; render(); 1'); await sleep(400);
  check('…shown on «البراند والفروع» → «المحذوفات» with «استرجاع البراند»', await c.ev('!!document.querySelector("#brTrashTable .brandRestore")'));
  const rb = JSON.parse(await c.ev(`window.desktop.restoreBrand(${JSON.stringify(add.key)}).then(function(r){return JSON.stringify(r)})`));
  check('«استرجاع البراند» puts it back (the app restarts)', rb.ok && rb.restart, JSON.stringify(rb));
  c.close(); proc.kill(); await sleep(1500);
  PORT = 9300 + Math.floor(Math.random() * 600);
  proc = launch();
  c = await connect((await target()).webSocketDebuggerUrl);
  await bootWait(c, 'window.S && S.ready && S.branchId');
  const back = JSON.parse(await c.ev(`JSON.stringify({brand:BRANDS.some(function(b){return b.key===${JSON.stringify(add.key)}}), branches:S.ws.branches.filter(function(b){return b.brand===${JSON.stringify(add.key)}}).map(function(b){return b.name}).sort(), deleted:BRANDS_DELETED.length, trash:(S.ws.trash||[]).length})`));
  check('…after the restart CROWN is back with both its branches, and «المحذوفات» is empty again', back.brand && back.branches.length === 2 && back.branches.indexOf('فرع الملقا') >= 0 && back.deleted === 0, JSON.stringify(back));

  // pausing: a branch, then a brand — hidden from the picker, nothing deleted, back with «تنشيط»
  await c.ev('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} window.confirm=function(){return true}; 1');
  const bid2 = await c.ev(`S.ws.branches.filter(function(b){return b.brand===${JSON.stringify(add.key)}})[0].id`);
  await c.ev('S.tab="branches"; PANES={branches:""}; render(); 1'); await sleep(300);
  await c.ev(`(function(){ var x=document.querySelector('.brPauseT[data-id="${bid2}"]'); x.checked=!x.checked; x.dispatchEvent(new Event('change',{bubbles:true})); return 1 })()`); await sleep(800);
  const p1 = JSON.parse(await c.ev(`JSON.stringify({paused:!!S.ws.branches.filter(function(b){return b.id===${JSON.stringify(bid2)}})[0].paused, inPicker:!!document.querySelector('#branchPick option[value="${bid2}"]'), row:!!document.querySelector('.brrow.paused[data-id="${bid2}"]')})`));
  check('the «يعمل / موقوف» switch hides a branch from the picker and keeps it (dimmed) on «البراند والفروع»', p1.paused && !p1.inPicker && p1.row, JSON.stringify(p1));
  await c.ev(`(function(){ var x=document.querySelector('.brPauseT[data-id="${bid2}"]'); x.checked=!x.checked; x.dispatchEvent(new Event('change',{bubbles:true})); return 1 })()`); await sleep(800);
  check('…switching it on brings it back', await c.ev(`!S.ws.branches.filter(function(b){return b.id===${JSON.stringify(bid2)}})[0].paused && !!document.querySelector('#branchPick option[value="${bid2}"]')`));
  await c.ev(`(function(){ var x=document.querySelector('.brandPauseT[data-key="chezzz"]'); x.checked=!x.checked; x.dispatchEvent(new Event('change',{bubbles:true})); return 1 })()`); await sleep(800);
  const p2 = JSON.parse(await c.ev('JSON.stringify({paused:BRANDS_PAUSED, group:!!document.querySelector(\'#branchPick optgroup[label="CHEZZZ"]\'), file:null})'));
  const cf = JSON.parse(fs.readFileSync(path.join(PROFILE, 'company.json'), 'utf8'));
  check('a brand can be paused too (even a built-in one): its branches leave the picker, kept on this computer', p2.paused.indexOf('chezzz') >= 0 && !p2.group && (cf.paused || []).indexOf('chezzz') >= 0, JSON.stringify({p2, cf: cf.paused}));
  await c.ev(`(function(){ var x=document.querySelector('.brandPauseT[data-key="chezzz"]'); x.checked=!x.checked; x.dispatchEvent(new Event('change',{bubbles:true})); return 1 })()`); await sleep(800);
  check('…and brought back', await c.ev('BRANDS_PAUSED.indexOf("chezzz")<0 && !!document.querySelector(\'#branchPick optgroup[label="CHEZZZ"]\')'));
  // a deleted branch comes back from «المحذوفات» with its data
  const before3 = await c.ev(`S.ws.branches.filter(function(b){return b.brand===${JSON.stringify(add.key)}}).length`);
  const rm = JSON.parse(await c.ev(`window.desktop.removeBranch(${JSON.stringify(bid2)}).then(function(r){return JSON.stringify({ok:r.ok})})`));
  const tl = JSON.parse(await c.ev('window.desktop.branchTrash().then(function(r){return JSON.stringify(r.list.map(function(t){return t.id}))})'));
  const rs = JSON.parse(await c.ev(`window.desktop.restoreBranch(${JSON.stringify(bid2)}).then(function(r){return JSON.stringify({ok:r.ok, n:r.ws&&r.ws.branches.filter(function(b){return b.brand===${JSON.stringify(add.key)}}).length})})`));
  check('a deleted branch is in «المحذوفات» and «استرجاع» brings it back', rm.ok && tl.indexOf(bid2) >= 0 && rs.ok && rs.n === before3, JSON.stringify({rm, tl, rs}));

  c.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); fs.rmSync(LEGACY, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
