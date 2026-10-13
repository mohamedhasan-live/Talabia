'use strict';
/*
 * Backup and restore through the real app (signed in, cloud on): «احفظ نسخة إلى ملف»
 * writes the open branch to a file, «انسخ نسخة احتياطية» copies the same thing,
 * and «استعد من نسخة» brings it back — on screen, on disk and in the cloud. Also:
 * a file saved by Notepad (byte-order mark), a file that is not a backup, and a
 * backup from another branch (the confirmation says so).
 * The system file dialogs are replaced by DAFTAR_TEST_BACKUP_FILE (main.js).
 *
 *   node tools/test-backup.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeStore } = require('../store');
const { startMock } = require('./mock-supabase');
const { killOrphans } = require('./orphans');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const EXE = process.env.DAFTAR_EXE || null;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-bk-'));
const LEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-bk-leg-'));
const FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-bk-files-'));
const FILE = path.join(FILES, 'backup.json');
const PORT = 9300 + Math.floor(Math.random() * 90);
const KEY = 'test-key-' + Date.now();

let pass = 0, fail = 0; const pageErrors = []; let lastDialog = '';
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10);
const rec = (n, b, p) => {
  const products = Array.from({ length: n }, (_, i) => ({ id: p + i, name: 'صنف ' + p + i, unit: 'حبة', shelfLife: 5, packSize: 1, active: true }));
  const days = {};
  for (let k = 1; k <= 10; k++) { const d = new Date(); d.setDate(d.getDate() - k); const items = {}; products.forEach((x, i) => { items[x.id] = { sold: 3 + ((i + k) % 5), waste: k % 4 === 0 ? 1 : 0, stockout: false }; }); days[ymd(d)] = { date: ymd(d), items, closed: true }; }
  return { v: 1, cfg: { branch: b, orderDays: [0, 3] }, products, days, stock: {}, events: [], orders: {} };
};
makeStore(path.join(LEGACY, 'daftar-altalabiya')).save(rec(6, 'فرع النرجس', 'c'));
makeStore(path.join(LEGACY, 'daftar-chezzz')).save(rec(4, 'فرع تشيززز', 'z'));

async function target() {
  for (let i = 0; i < 80; i++) {
    try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find(t => t.type === 'page'); if (p) return p; } catch (e) {}
    await sleep(500);
  }
  throw new Error('no page');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 0; const w = new Map();
    const send = (m, p) => new Promise(r => { const n = ++id; w.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p || {} })); });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Page.javascriptDialogOpening') { lastDialog = m.params.message; send('Page.handleJavaScriptDialog', { accept: true }); }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', async () => {
      await send('Runtime.enable'); await send('Page.enable');
      resolve({ ev: async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
        if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result.value; },
        close: () => ws.close() });
    });
  });
}
async function waitFor(c, expr, label, ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await c.ev('!!(' + expr + ')')) return true; await sleep(250); }
  throw new Error('timed out waiting for ' + label);
}
const toastText = c => c.ev('document.getElementById("toast").firstElementChild.textContent');

(async () => {
  killOrphans(); process.on('exit', killOrphans);
  const mock = await startMock({ key: KEY });
  mock.addUser('owner@shop.sa', 'S3cure-pass');
  const env = Object.assign({}, process.env, { DAFTAR_LEGACY_ROOT: LEGACY, DAFTAR_CLOUD_URL: mock.url + '/rest/v1/', DAFTAR_CLOUD_KEY: KEY, DAFTAR_TEST_BACKUP_FILE: FILE });
  const args = ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  const proc = EXE ? spawn(EXE, args, { env }) : spawn(ELECTRON, ['.'].concat(args), { cwd: ROOT, env });
  const c = await connect((await target()).webSocketDebuggerUrl);

  console.log('--- the owner signs in ---');
  await waitFor(c, 'window.S && S.ready && S.branchId', 'the app to start', 90000);
  await c.ev('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await waitFor(c, '!document.getElementById("gate").hidden && !document.getElementById("gateForm").hidden', 'the sign-in screen');
  await c.ev('document.getElementById("gateEmail").value="owner@shop.sa";document.getElementById("gatePass").value="S3cure-pass";document.getElementById("gateBtn").click()');
  await waitFor(c, 'S.cloud && S.cloud.status==="ok" && document.getElementById("gate").hidden && S.branchId==="caneles-1" && S.products.length===6', 'the owner in CANELÉS');
  await waitFor(c, '(function(){var r=' + 'S.cloud' + '; return r && r.lastSync})()', 'a first sync');
  await sleep(1500);
  await c.ev('S.migratedSeen=true; S.migratedNote=[]; S.tab="setup"; render()');
  check('the three backup buttons are there', await c.ev('!!document.getElementById("saveAs") && !!document.getElementById("backup") && !!document.getElementById("restore")'));

  console.log('--- «احفظ نسخة إلى ملف» ---');
  await c.ev('document.getElementById("saveAs").click()');
  let t0 = Date.now(); while (Date.now() - t0 < 10000 && !fs.existsSync(FILE)) await sleep(200);
  check('the file is written', fs.existsSync(FILE));
  let saved = null; try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
  check('it is valid JSON', !!saved);
  check('with all 6 items', saved && saved.products.length === 6);
  check('and the whole sales record', saved && Object.keys(saved.days).length === 10);
  check('labelled with its branch', saved && saved.meta && saved.meta.branchId === 'caneles-1' && saved.meta.brand === 'caneles');
  check('the screen says it was saved', /حُفظت النسخة/.test(await toastText(c)));
  const origName = saved.products[0].name, origSold = saved.days[Object.keys(saved.days)[0]].items.c0.sold;

  console.log('--- «انسخ نسخة احتياطية» (clipboard) ---');
  await c.ev('window.__clip=null; navigator.clipboard.writeText=function(t){window.__clip=t;return Promise.resolve()}; document.getElementById("backup").click(); 1');
  await waitFor(c, 'window.__clip', 'the copied text');
  const clip = await c.ev('window.__clip');
  let clipD = null; try { clipD = JSON.parse(clip); } catch (e) {}
  check('the copied text is the same backup', clipD && clipD.products.length === 6 && Object.keys(clipD.days).length === 10 && clipD.meta.branchId === 'caneles-1');

  console.log('--- change the branch, then restore the file ---');
  const dayK = Object.keys(saved.days)[0];
  await c.ev(`(function(){ S.products[0].name="اسم بعد النسخة"; S.products.pop(); S.days[${JSON.stringify(dayK)}].items.c0.sold=999; saveLocal(); return 1 })()`);
  t0 = Date.now(); while (Date.now() - t0 < 20000) { const r = mock.rows().get('caneles-1'); if (r && r.data.products.length === 5) break; await sleep(300); }
  check('the change reached the cloud first', mock.rows().get('caneles-1').data.products.length === 5);
  lastDialog = '';
  await c.ev('document.getElementById("restore").click()');
  await waitFor(c, 'S.products.length===6', 'the restored items');
  check('it asks first', /سيستبدل هذا بيانات فرع/.test(lastDialog), lastDialog);
  check('and does not warn about another branch (same branch)', !/فرعٍ آخر/.test(lastDialog));
  check('items are back on screen', await c.ev('S.products.length') === 6 && await c.ev('S.products[0].name') === origName);
  check('the sales record is back', await c.ev(`S.days[${JSON.stringify(dayK)}].items.c0.sold`) === origSold);
  check('the screen says it was restored', /استُعيدت/.test(await toastText(c)));
  t0 = Date.now(); while (Date.now() - t0 < 20000) { const r = mock.rows().get('caneles-1'); if (r && r.data.products.length === 6 && r.data.products[0].name === origName) break; await sleep(300); }
  const cloudRow = mock.rows().get('caneles-1');
  check('the restore reached the cloud', cloudRow.data.products.length === 6 && cloudRow.data.products[0].name === origName && cloudRow.data.days[dayK].items.c0.sold === origSold);
  await sleep(800);
  const disk = await c.ev('Promise.resolve(BR.load("caneles-1")).then(function(r){return r&&r.ok?{n:r.data.products.length,name:r.data.products[0].name,sold:r.data.days[' + JSON.stringify(dayK) + '].items.c0.sold}:null})');
  check('and is on this computer\'s disk', disk && disk.n === 6 && disk.name === origName && disk.sold === origSold, JSON.stringify(disk));

  console.log('--- a backup saved by Notepad (byte-order mark) ---');
  await c.ev('S.products[0].name="قبل ملف المفكرة"; saveLocal(); 1');
  fs.writeFileSync(FILE, '﻿' + clip, 'utf8');
  await c.ev('document.getElementById("restore").click()');
  await waitFor(c, 'S.products[0].name===' + JSON.stringify(origName), 'the Notepad backup restored', 10000).catch(() => {});
  check('it restores', await c.ev('S.products[0].name') === origName, await toastText(c));

  console.log('--- a file that is not a backup ---');
  fs.writeFileSync(FILE, 'hello, not a backup', 'utf8');
  const before = await c.ev('JSON.stringify(S.products)');
  await c.ev('document.getElementById("restore").click()'); await sleep(800);
  check('it is refused with a clear message', /ليس نسخةً احتياطية صالحة|غير صالحة/.test(await toastText(c)), await toastText(c));
  check('and nothing changed', await c.ev('JSON.stringify(S.products)') === before);
  fs.writeFileSync(FILE, JSON.stringify({ hello: 1 }), 'utf8');
  await c.ev('document.getElementById("restore").click()'); await sleep(800);
  check('JSON that is not a backup is refused too', /غير صالحة/.test(await toastText(c)) && await c.ev('JSON.stringify(S.products)') === before, await toastText(c));

  console.log('--- a backup from another branch ---');
  await c.ev('openBranch("chezzz-1")'); await waitFor(c, 'S.branchId==="chezzz-1" && S.products.length===4', 'CHEZZZ');
  await c.ev('S.tab="setup"; render(); document.getElementById("saveAs").click()'); await sleep(1200);
  const chz = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  check('CHEZZZ saved its own backup', chz.meta.branchId === 'chezzz-1' && chz.products.length === 4);
  await c.ev('openBranch("caneles-1")'); await waitFor(c, 'S.branchId==="caneles-1" && S.products.length===6', 'back to CANELÉS');
  await c.ev('S.tab="setup"; render()');
  lastDialog = '';
  await c.ev('document.getElementById("restore").click()');
  await waitFor(c, 'S.products.length===4', 'the other branch\'s backup restored');
  check('the confirmation names the other branch', /فرعٍ آخر/.test(lastDialog) && /تشيززز|CHEZZZ/.test(lastDialog), lastDialog);
  check('the branch keeps its own name', await c.ev('S.cfg.branch') === 'فرع النرجس', await c.ev('S.cfg.branch'));

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  c.close(); proc.kill(); await mock.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + (e.stack || e)); process.exit(1); });
