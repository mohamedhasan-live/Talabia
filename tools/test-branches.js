'use strict';
/*
 * End-to-end for brands and branches, through the real Electron app and its
 * real UI: moving the two old apps' records in, switching branch and brand,
 * adding a branch from a sibling's catalogue, renaming, deleting to trash, and
 * — the point of it all — proving on disk that one branch's entries never
 * land in another's file, even when the switch comes mid-save.
 *
 *   node tools/test-branches.js            (dev build)
 *   $env:DAFTAR_EXE="...\Daftar.exe"; node tools/test-branches.js
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
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-br-'));
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
  console.log('branches end-to-end, profile ' + PROFILE + '\n');
  console.log('--- first start: the two old apps move in ---');
  let proc = launch();
  let c = await connect((await target()).webSocketDebuggerUrl);
  await bootWait(c, 'window.S && S.ready && S.branchId');
  check('one app, two brands', await c.ev('BRANDS.length') === 2);
  check('app name shown inside', await c.ev('document.getElementById("appName").textContent') === 'Talabia');
  check('workspace has two branches', await c.ev('S.ws.branches.length') === 2);
  check('opens on CANELÉS — فرع النرجس', await c.ev('S.branchId') === 'caneles-1' && await c.ev('S.cfg.branch') === 'فرع النرجس');
  check('CANELÉS catalogue moved in (16)', await c.ev('S.products.length') === 16);
  check('CANELÉS history moved in', await c.ev('Object.keys(S.days).length') === 2);
  check('real data, not the demo', await c.ev('S.demo') === false);
  check('move-in notice shown', await c.ev('!!document.getElementById("migOk")'));
  check('header shows the branch picker', await c.ev('!document.getElementById("branchPick").hidden'));
  check('picker groups branches by brand', await c.ev('document.querySelectorAll("#branchPick optgroup").length') === 2);
  check('branches tab is visible', await c.ev('!document.getElementById("tabBranches").hidden'));
  check('wordmark is CANELÉS', await c.ev('document.getElementById("wordmark").textContent') === 'CANELÉS');
  check('window title names brand and branch', await c.ev('document.title') === 'Talabia — CANELÉS · فرع النرجس');
  const canAccent = await tok(c, '--accent');
  await click(c, '#migOk'); await sleep(200);
  check('notice dismissed', !(await c.ev('!!document.getElementById("migOk")')));
  check('old files untouched', JSON.parse(fs.readFileSync(path.join(LEGACY, 'daftar-altalabiya', 'data', 'daftar.json'), 'utf8')).products.length === 16);

  console.log('--- switch brand ---');
  await pick(c, 'chezzz-1');
  await waitFor(c, 'S.branchId==="chezzz-1" && S.products.length===18', 'CHEZZZ to open');
  check('CHEZZZ catalogue (18)', await c.ev('S.products.length') === 18);
  check('wordmark is CHEZZZ', await c.ev('document.getElementById("wordmark").textContent') === 'CHEZZZ');
  // both brands share the calm plum accent now (the owner asked for no yellow), so compare with CHEZZZ's own brand file
  const chz = require(path.join(__dirname, '..', 'brands', 'chezzz.json'));
  check('colours follow the brand', (await tok(c, '--accent')).toUpperCase() === chz.dark.accent.toUpperCase() && (await tok(c, '--calm')).toUpperCase() === chz.dark.calm.toUpperCase(), await tok(c, '--accent') + ' / ' + canAccent);
  check('CHEZZZ opens dark by default', await c.ev('document.documentElement.getAttribute("data-theme")') === 'dark');
  check('products belong to CHEZZZ', await c.ev('S.products[0].id') === 'z0');

  console.log('--- a switch in the middle of a save never crosses branches ---');
  await click(c, '#tabs button[data-tab="entry"]'); await sleep(300);
  const day = await c.ev('S.entryDate');
  await typeIn(c, '.entIn[data-pid="z1"][data-f="sold"]', 33);
  await pick(c, 'caneles-1');            // before the 500 ms save timer fires
  await waitFor(c, 'S.branchId==="caneles-1" && S.products.length===16', 'CANELÉS to reopen');
  check('DISK: CHEZZZ got its entry', await untilDisk(() => disk('chezzz-1').days[day].items.z1.sold === 33), JSON.stringify(disk('chezzz-1').days[day]));
  await sleep(1200);                     // and nothing lands in CANELÉS after it either
  check('DISK: CANELÉS did not', !disk('caneles-1').days[day]);
  check('CANELÉS in memory has no CHEZZZ entry', await c.ev(`!S.days[${JSON.stringify(day)}]`));
  check('CANELÉS light theme restored', await c.ev('document.documentElement.getAttribute("data-theme")') !== 'dark');
  check('screen state reset on switch', await c.ev('Object.keys(S.overrides).length===0 && S.imp==null'));

  console.log('--- add a branch from a sibling ---');
  await click(c, '#tabs button[data-tab="branches"]');
  await waitFor(c, 'document.getElementById("newName-caneles")', 'the branches screen');
  await waitFor(c, 'S.branchStats && S.branchStats["chezzz-1"]', 'branch counts');
  check('counts shown for the other branch', (await c.ev('document.querySelector(\'.brrow[data-id="chezzz-1"] .meta\').textContent')).includes('18'));
  check('copy defaults to the same brand', await c.ev('document.getElementById("newFrom-caneles").value') === 'caneles-1');
  await c.ev('document.getElementById("newName-caneles").value="فرع الملقا"');
  await click(c, '.brAdd[data-brand="caneles"]');
  await waitFor(c, 'S.ws.branches.length===3', 'the new branch');
  const newId = await c.ev('S.ws.branches[2].id');
  check('new id is under the brand', /^caneles-/.test(newId), newId);
  check('new branch listed under CANELÉS', await c.ev(`!!document.querySelector('.brandcard[data-brand="caneles"] .brrow[data-id="${newId}"]')`));
  const nd = disk(newId);
  check('DISK: catalogue copied (16)', nd.products.length === 16);
  check('DISK: aliases copied', nd.products[0].aliases && nd.products[0].aliases[0] === 'alias c0');
  check('DISK: settings copied', nd.cfg.tendency === 60 && JSON.stringify(nd.cfg.orderDays) === '[0,3]');
  check('DISK: no history copied', Object.keys(nd.days).length === 0);
  check('DISK: no stock or orders copied', Object.keys(nd.stock).length === 0 && Object.keys(nd.orders).length === 0);
  check('DISK: own name in its settings', nd.cfg.branch === 'فرع الملقا');
  check('DISK: stamped with its id', nd.meta && nd.meta.branchId === newId && nd.meta.brand === 'caneles');
  await c.ev('document.getElementById("newName-caneles").value="فرع الملقا"');
  await click(c, '.brAdd[data-brand="caneles"]'); await sleep(500);
  check('duplicate name refused', await c.ev('S.ws.branches.length') === 3);
  await c.ev('document.getElementById("newName-chezzz").value="فرع العليا"; document.getElementById("newFrom-chezzz").value=""');
  await click(c, '.brAdd[data-brand="chezzz"]');
  await waitFor(c, 'S.ws.branches.length===4', 'the empty branch');
  const emptyId = await c.ev('S.ws.branches[3].id');
  check('DISK: empty branch starts with no items', disk(emptyId).products.length === 0);

  console.log('--- work in the new branch ---');
  await click(c, `.brOpen[data-id="${newId}"]`);
  await waitFor(c, `S.branchId===${JSON.stringify(newId)} && S.ready`, 'the new branch to open');
  check('header now shows the new branch', await c.ev('document.getElementById("branchPick").value') === newId);
  check('opens on the order screen', await c.ev('S.tab') === 'order');
  await click(c, '#tabs button[data-tab="entry"]'); await sleep(300);
  await typeIn(c, '.entIn[data-pid="c2"][data-f="sold"]', 11);
  check('DISK: new branch got its entry', await untilDisk(() => disk(newId).days[day].items.c2.sold === 11),
    JSON.stringify((disk(newId).days || {})[day]));
  check('DISK: sibling untouched', !disk('caneles-1').days[day]);
  check('DISK: other brand untouched', !(disk('chezzz-1').days[day].items.c2));

  console.log('--- rename ---');
  await click(c, '#tabs button[data-tab="setup"]'); await sleep(300);
  await typeIn(c, '#cfgBranch', 'فرع الملقا ٢');
  await sleep(1300);
  check('header picker renamed', await c.ev(`document.querySelector('#branchPick option[value="${newId}"]').textContent`) === 'فرع الملقا ٢');
  check('title renamed', await c.ev('document.title') === 'Talabia — CANELÉS · فرع الملقا ٢');
  const wsFile = () => JSON.parse(fs.readFileSync(path.join(PROFILE, 'workspace.json'), 'utf8'));
  check('DISK: workspace renamed', await untilDisk(() => wsFile().branches.find(b => b.id === newId).name === 'فرع الملقا ٢'),
    JSON.stringify(wsFile().branches.find(b => b.id === newId)));
  check('DISK: branch settings renamed', await untilDisk(() => disk(newId).cfg.branch === 'فرع الملقا ٢'), disk(newId).cfg.branch);

  console.log('--- the record survives a restart ---');
  // the packaged exe runs from a child it unpacked; a fresh port can never
  // reach the old instance, and the orphan sweep ends it
  c.close(); proc.kill(); killOrphans(); await sleep(2500);
  PORT += 1;
  proc = launch();
  c = await connect((await target()).webSocketDebuggerUrl);
  await bootWait(c, 'window.S && S.ready && S.branchId');
  check('reopens on the last branch', await c.ev('S.branchId') === newId);
  check('its entry came back', await c.ev(`S.days[${JSON.stringify(day)}].items.c2.sold`) === 11);
  check('no move-in notice the second time', !(await c.ev('!!document.getElementById("migOk")')));
  check('still four branches', await c.ev('S.ws.branches.length') === 4);

  console.log('--- delete ---');
  await click(c, '#tabs button[data-tab="branches"]');
  await waitFor(c, `document.querySelector('.brDel[data-id="${newId}"]')`, 'the delete button');
  await click(c, `.brDel[data-id="${newId}"]`);
  await waitFor(c, 'S.ws.branches.length===3', 'the delete');
  await waitFor(c, 'S.branchId==="caneles-1" && S.products.length===16', 'fallback to the sibling');
  check('fell back to the same brand', await c.ev('S.branchId') === 'caneles-1');
  check('DISK: folder gone from branches', !fs.existsSync(path.join(PROFILE, 'branches', newId)));
  const trash = fs.existsSync(path.join(PROFILE, 'trash')) ? fs.readdirSync(path.join(PROFILE, 'trash')) : [];
  check('DISK: moved to trash with its data', trash.some(t => t.startsWith(newId) && fs.existsSync(path.join(PROFILE, 'trash', t, 'daftar.json'))), trash.join(','));

  console.log('--- wipe touches one branch only ---');
  await click(c, '#tabs button[data-tab="setup"]'); await sleep(300);
  await pick(c, emptyId);
  await waitFor(c, `S.branchId===${JSON.stringify(emptyId)}`, 'the empty branch');
  await click(c, '#wipe'); await sleep(1200);
  check('DISK: other branches kept their items', disk('caneles-1').products.length === 16 && disk('chezzz-1').products.length === 18);

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  c.close(); proc.kill();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + (e.stack || e)); process.exit(1); });
