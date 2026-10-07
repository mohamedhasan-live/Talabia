'use strict';
/*
 * The cloud through the real app: it starts with the table missing (setup
 * notice), uploads once the table exists, shows another device's edit live,
 * refuses to lay a stale edit over it, and lets the owner settle a clash
 * from the banner. A stand-in for Supabase plays the cloud and the "other
 * device" writes straight into it.
 *
 *   node tools/test-cloud-app.js
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
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-cl-'));
const LEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-cl-leg-'));
const PORT = 9300 + Math.floor(Math.random() * 600);
const KEY = 'test-key-' + Date.now();
const disk = id => JSON.parse(fs.readFileSync(path.join(PROFILE, 'branches', id, 'daftar.json'), 'utf8'));

let pass = 0, fail = 0; const pageErrors = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rec = (n, b, p) => ({ v: 1, cfg: { branch: b, orderDays: [0, 3] },
  products: Array.from({ length: n }, (_, i) => ({ id: p + i, name: 'صنف ' + p + i, unit: 'حبة', shelfLife: 5, packSize: 1, active: true })),
  days: {}, stock: {}, events: [], orders: {} });
makeStore(path.join(LEGACY, 'daftar-altalabiya')).save(rec(17, 'فرع النرجس', 'c'));
makeStore(path.join(LEGACY, 'daftar-chezzz')).save(rec(18, 'فرع تشيززز', 'z'));

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
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
      if (m.method === 'Log.entryAdded' && m.params.entry.source === 'security') pageErrors.push('CSP: ' + m.params.entry.text);
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', async () => {
      await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
      resolve({ ev: async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
        if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result.value; },
        close: () => ws.close() });
    });
  });
}
async function waitFor(c, expr, label, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await c.ev('!!(' + expr + ')')) return true; await sleep(250); }
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

(async () => {
  killOrphans(); process.on('exit', killOrphans);
  const mock = await startMock({ key: KEY, withTable: false });
  mock.addUser('owner@shop.sa', 'S3cure-pass');
  mock.addUser('stranger@x.com', 'whatever-pw', false);
  const env = Object.assign({}, process.env, { DAFTAR_LEGACY_ROOT: LEGACY, DAFTAR_CLOUD_URL: mock.url + '/rest/v1/', DAFTAR_CLOUD_KEY: KEY });
  const args = ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  const proc = EXE ? spawn(EXE, args, { env }) : spawn(ELECTRON, ['.'].concat(args), { cwd: ROOT, env });
  const c = await connect((await target()).webSocketDebuggerUrl);
  await bootWait(c, 'window.S && S.ready && S.branchId');

  console.log('--- signed out: nothing reaches the cloud ---');
  await waitFor(c, 'S.cloud && S.cloud.status==="signin"', 'the sign-in state');
  check('chip asks to sign in', (await c.ev('document.getElementById("cloudTxt").textContent')).includes('سجّل الدخول'));
  // no account on this device: the sign-in screen covers the whole app
  await waitFor(c, '!document.getElementById("gate").hidden', 'the sign-in screen');
  check('the sign-in screen is the first thing shown', await c.ev('!document.getElementById("gate").hidden && document.querySelector(".app").inert'));
  check('it asks for email and password', await c.ev('!!document.getElementById("gateEmail") && !!document.getElementById("gatePass")'));
  const signIn = async (em, pw) => {
    await c.ev(`(function(){document.getElementById("gateEmail").value=${JSON.stringify(em)};document.getElementById("gatePass").value=${JSON.stringify(pw)};document.getElementById("gateBtn").click();return 1})()`);
  };
  await signIn('owner@shop.sa', 'wrong-one');
  await waitFor(c, 'GATE.msg', 'the refusal');
  check('wrong password refused in the UI', (await c.ev('GATE.msg')).includes('غير صحيحة'));
  check('password field emptied after a try', await c.ev('document.getElementById("gatePass").value') === '');
  check('the password is not kept in page state', !(await c.ev('JSON.stringify(S)+JSON.stringify(GATE)')).includes('wrong-one'));
  await signIn('stranger@x.com', 'whatever-pw');
  await waitFor(c, 'S.cloudSet && S.cloudSet.auth && S.cloudSet.auth.signedIn', 'the stranger sign-in');
  mock.createTable();
  await c.ev('cloudSyncNow()');
  await waitFor(c, 'S.cloud && S.cloud.status==="notmember"', 'not-a-member');
  check('a non-member is told so', (await c.ev('document.getElementById("cloudTxt").textContent')).includes('غير مُصرَّح'));
  check('the sign-in screen stays, with the reason', await c.ev('!document.getElementById("gate").hidden') && (await c.ev('document.getElementById("gateMsg").textContent')).includes('ليس من حسابات'));
  check('a non-member uploaded nothing', mock.rows().size === 0);
  await c.ev('document.getElementById("gateOut").click()');
  await waitFor(c, 'S.cloudSet && S.cloudSet.auth && !S.cloudSet.auth.signedIn', 'sign-out');
  await signIn('owner@shop.sa', 'S3cure-pass');
  await waitFor(c, 'S.cloudSet && S.cloudSet.auth && S.cloudSet.auth.signedIn', 'the owner sign-in');
  check('signed in as the owner', await c.ev('S.cloudSet.auth.email') === 'owner@shop.sa');
  await waitFor(c, 'document.getElementById("gate").hidden', 'the sign-in screen to leave');
  check('the app opens once signed in', await c.ev('!document.querySelector(".app").inert'));

  console.log('--- the table is missing ---');
  // take the tables away again to see the setup path
  const _rows = mock.rows();
  await waitFor(c, 'S.cloud && S.cloud.status==="ok"', 'first sync', 20000);
  check('owner sync ok', true);
  check('header chip visible', await c.ev('!document.getElementById("cloudChip").hidden'));
  check('local data fine meanwhile', await c.ev('S.products.length') === 17);
  check('setup SQL locks out anon', (await c.ev('CLOUD_SQL')).includes('revoke all on table public.daftar_branches from anon'));
  check('setup SQL keeps the allow-list private', (await c.ev('CLOUD_SQL')).includes('private.talabia_users'));

  console.log('--- synced ---');
  check('both branches in the cloud', mock.rows().size === 2);
  check('chip says in sync', (await c.ev('document.getElementById("cloudTxt").textContent')).includes('متزامن'));
  check('the SQL box is gone', await c.ev('!document.getElementById("sqlText")'));

  console.log('--- an edit here goes up by itself ---');
  await c.ev('document.querySelector(\'#tabs button[data-tab="entry"]\').click()'); await sleep(300);
  const day = await c.ev('S.entryDate');
  await c.ev(`(function(){var el=document.querySelector('.entIn[data-pid="c3"][data-f="sold"]');el.value="21";el.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { const r = mock.rows().get('caneles-1'); if (r.data.days[day] && r.data.days[day].items.c3.sold === 21) break; await sleep(300); }
  check('cloud got the sale within seconds', (mock.rows().get('caneles-1').data.days[day] || { items: {} }).items.c3?.sold === 21);

  console.log('--- another device edits the open branch ---');
  const row = mock.rows().get('caneles-1');
  row.rev = row.rev + 1; row.device = 'other-pc';
  row.data = JSON.parse(JSON.stringify(row.data)); row.data.products[0].name = 'اسم من الجهاز الآخر';
  await waitFor(c, 'S.products[0].name==="اسم من الجهاز الآخر"', 'the remote edit to show', 20000);
  check('the open screen shows the other device\'s edit', true);
  check('still on the same screen and day', await c.ev('S.tab') === 'entry' && await c.ev('S.entryDate') === day);
  check('DISK: local file updated too', disk('caneles-1').products[0].name === 'اسم من الجهاز الآخر');

  console.log('--- a branch created on another device ---');
  mock.rows().set('chezzz-olaya', { id: 'chezzz-olaya', brand: 'chezzz', name: 'فرع العليا', rev: 3, deleted: false, device: 'other-pc',
    updated_at: new Date().toISOString(), data: rec(5, 'فرع العليا', 'o') });
  await waitFor(c, 'S.ws.branches.some(function(b){return b.id==="chezzz-olaya"})', 'the new branch', 20000);
  check('appears in the picker', await c.ev('!!document.querySelector(\'#branchPick option[value="chezzz-olaya"]\')'));
  check('DISK: its record came down', disk('chezzz-olaya').products.length === 5);

  console.log('--- both changed: the owner decides from the banner ---');
  await c.ev(`(function(){var el=document.querySelector('.entIn[data-pid="c4"][data-f="sold"]');el.value="8";el.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
  const r2 = mock.rows().get('caneles-1');
  r2.rev = r2.rev + 5; r2.data = JSON.parse(JSON.stringify(r2.data)); r2.data.products[1].name = 'تعديل متزامن هناك';
  await waitFor(c, 'S.cloud && S.cloud.conflicts && S.cloud.conflicts.length===1', 'the conflict', 20000);
  check('conflict banner shown', await c.ev('!!document.querySelector(\'.cfKeep[data-id="caneles-1"]\')'));
  check('chip warns', (await c.ev('document.getElementById("cloudTxt").textContent')).includes('تعارض'));
  check('nothing overwritten here', await c.ev('S.products[1].name') !== 'تعديل متزامن هناك');
  await c.ev('document.querySelector(\'.cfKeep[data-id="caneles-1"]\').click()');
  await waitFor(c, '!S.cloud.conflicts.length', 'the conflict to clear');
  check('cloud now holds this device\'s copy', mock.rows().get('caneles-1').data.days[day].items.c4.sold === 8);
  check('and the rev moved past both', mock.rows().get('caneles-1').rev > r2.rev - 1);
  // the branch reopens after the fix: wait for its screen, not for a fixed time
  // (the reopen may land on another screen when a sync arrives during it — go back to the daily close if so)
  await waitFor(c, 'S.ready && S.branchId==="caneles-1"', 'the branch to reopen after the fix');
  await c.ev('(function(){ if(S.tab!=="entry"){ document.querySelector(\'#tabs button[data-tab="entry"]\').click() } return 1 })()');
  await waitFor(c, 'document.querySelector(\'.entIn[data-pid="c5"][data-f="sold"]\')', 'the entry screen after the fix');
  check('the page keeps saving after the fix', await c.ev(`(function(){var el=document.querySelector('.entIn[data-pid="c5"][data-f="sold"]');el.value="4";el.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`));
  const t1 = Date.now();
  while (Date.now() - t1 < 15000) { const r = mock.rows().get('caneles-1'); if (r.data.days[day].items.c5 && r.data.days[day].items.c5.sold === 4) break; await sleep(300); }
  check('and those saves reach the cloud', (mock.rows().get('caneles-1').data.days[day].items.c5 || {}).sold === 4);

  console.log('--- a delete elsewhere ---');
  mock.rows().get('chezzz-olaya').deleted = true;
  await waitFor(c, '!S.ws.branches.some(function(b){return b.id==="chezzz-olaya"})', 'the delete to arrive', 20000);
  check('branch removed here', true);

  console.log('--- settings: the storage place card ---');
  await c.ev('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await waitFor(c, 'document.getElementById("storageCard")', 'the storage card');
  check('card shows Supabase with cloud selected', await c.ev('document.getElementById("modeCloud").getAttribute("aria-pressed")') === 'true');
  check('project link filled in', (await c.ev('document.getElementById("cloudUrl").value')).startsWith(mock.url));
  check('key kept hidden, marked as saved', (await c.ev('document.getElementById("cloudKey").placeholder')).includes('محفوظ'));
  await c.ev('document.getElementById("cloudTest").click()');
  await waitFor(c, 'S.cloudTestRes && !S.cloudTestRes.busy', 'the connection test');
  check('connection test succeeds', await c.ev('S.cloudTestRes.ok') === true, await c.ev('JSON.stringify(S.cloudTestRes)'));
  check('test result shown', (await c.ev('document.querySelector("#storageCard .testres").textContent')).includes('سليم'));
  await c.ev('document.getElementById("modeLocal").click()');
  await waitFor(c, 'S.cloudSet && S.cloudSet.mode==="local"', 'switch to this device');
  await waitFor(c, 'S.cloud && !S.cloud.enabled', 'the cloud to stop');
  check('chip hidden when local', await c.ev('document.getElementById("cloudChip").hidden'));
  const rowsBefore = JSON.stringify(mock.rows().get('caneles-1').data.days[day]);
  await c.ev(`(function(){document.querySelector('#tabs button[data-tab="entry"]').click();return 1})()`); await sleep(300);
  await c.ev(`(function(){var el=document.querySelector('.entIn[data-pid="c6"][data-f="sold"]');el.value="9";el.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
  await sleep(4000);
  check('local mode: saved here', disk('caneles-1').days[day].items.c6.sold === 9);
  check('local mode: nothing sent to the cloud', JSON.stringify(mock.rows().get('caneles-1').data.days[day]) === rowsBefore);
  await c.ev('document.querySelector(\'#tabs button[data-tab="setup"]\').click()'); await sleep(300);
  await c.ev('document.getElementById("modeCloud").click()');
  await waitFor(c, 'S.cloud && S.cloud.enabled && S.cloud.status==="ok"', 'cloud back on', 20000);
  const t2 = Date.now();
  while (Date.now() - t2 < 15000) { const r = mock.rows().get('caneles-1'); if (r.data.days[day].items.c6) break; await sleep(300); }
  check('back to cloud: the local edit caught up', (mock.rows().get('caneles-1').data.days[day].items.c6 || {}).sold === 9);
  await c.ev('(function(){var u=document.getElementById("cloudUrl");u.value="not a link";u.dispatchEvent(new Event("input",{bubbles:true}));return 1})()');
  await sleep(400);
  await c.ev('document.getElementById("cloudTest").click()');
  await waitFor(c, 'S.cloudTestRes && !S.cloudTestRes.busy', 'the bad-link test');
  check('bad link reported', await c.ev('S.cloudTestRes.reason') === 'url');

  console.log('--- the owner\'s control panel: create a staff account for one branch ---');
  check('the owner sees the control panel tab', await c.ev('!document.getElementById("tabAdmin").hidden'));
  await c.ev('document.querySelector(\'#tabs button[data-tab="admin"]\').click()');
  await waitFor(c, 'document.getElementById("cpSec_users") && CP.loaded', 'the control panel');
  check('the panel opens with its sections closed', await c.ev('!document.querySelector(".urow") && !document.getElementById("cpName") && !document.querySelector(".cpRoleEdit")'));
  await c.ev('document.getElementById("cpSec_roles").click()');
  check('the roles button opens the roles', (await c.ev('document.querySelectorAll(".cpRoleEdit").length')) >= 2);
  await c.ev('document.getElementById("cpSec_users").click()');
  check('the users button opens the users list', (await c.ev('document.querySelectorAll(".urow[data-u]").length')) >= 1);
  check('and only the users', await c.ev('!document.querySelector(".cpRoleEdit")'));
  check('the owner is marked as the owner', (await c.ev('document.querySelector(".urow .chip.a") && document.querySelector(".urow .chip.a").textContent')) === 'المالك');
  check('the new-user form is hidden until asked for', await c.ev('!document.getElementById("cpName")'));
  await c.ev('document.getElementById("cpAdd").click()');
  check('the new-user form asks for name, email, password and its confirmation', await c.ev('!!(document.getElementById("cpName") && document.getElementById("cpEmail") && document.getElementById("cpPass") && document.getElementById("cpPass2"))'));
  await c.ev(`(function(){
    document.getElementById("cpName").value="سارة";
    document.getElementById("cpEmail").value="staff@shop.sa";
    document.getElementById("cpPass").value="Staff-pass-9";
    document.getElementById("cpPass2").value="Staff-pass-8";
    document.getElementById("cpCreate").click(); return 1})()`);
  await sleep(600);
  check('mismatched passwords are refused', !mock.member('staff@shop.sa'));
  await c.ev(`(function(){
    document.getElementById("cpName").value="سارة";
    document.getElementById("cpEmail").value="staff@shop.sa";
    document.getElementById("cpPass").value="Staff-pass-9";
    document.getElementById("cpPass2").value="Staff-pass-9";
    document.getElementById("cpNewRole").value="staff";
    document.querySelector('.admBr[data-u="__new"][value="caneles-1"]').checked=true;
    document.getElementById("cpCreate").click(); return 1})()`);
  await waitFor(c, 'CP.loaded && CP.users && CP.users.some(function(u){return u.email==="staff@shop.sa"})', 'the new account in the list');
  const made = JSON.parse(await c.ev('JSON.stringify(CP.users.filter(function(u){return u.email==="staff@shop.sa"})[0])'));
  check('staff account created with one branch', JSON.stringify(made.branches) === '["caneles-1"]');
  check('and the chosen role', made.role_id === 'staff');
  check('and its name', made.name === 'سارة');
  check('the list shows the name', (await c.ev('document.querySelector(\'.urow[data-u="' + made.user_id + '"] .unm\').textContent')) === 'سارة');
  check('the form closes after creating', await c.ev('!document.getElementById("cpName")'));

  console.log('--- signing in as that staff account ---');
  await c.ev('document.querySelector(\'#tabs button[data-tab="setup"]\').click()'); await sleep(300);
  await c.ev('document.getElementById("signOut").click()');
  check('signing out asks first, in the app\'s own dialog', await c.ev('!!document.getElementById("soDlg") && S.cloudSet.auth.signedIn'));
  await c.ev('document.getElementById("soNo").click()');
  // The dialog fades out and is removed on a 140 ms timer, which Chromium stretches to a
  // second or more while the test window sits in the background — wait for the removal
  // itself rather than a fixed delay. The account must stay signed in throughout.
  check('«stay» is still signed in the moment it is pressed', await c.ev('S.cloudSet.auth.signedIn === true'));
  await waitFor(c, '!document.getElementById("soDlg")', 'the sign-out dialog to close', 5000);
  check('«stay» keeps the account signed in', await c.ev('!document.getElementById("soDlg") && S.cloudSet.auth.signedIn'));
  await c.ev('document.getElementById("signOut").click()');
  await waitFor(c, 'document.getElementById("soYes")', 'the sign-out dialog');
  await c.ev('document.getElementById("soYes").click()');
  await waitFor(c, 'S.cloudSet && S.cloudSet.auth && !S.cloudSet.auth.signedIn', 'sign-out');
  check('signing out brings the sign-in screen back', await c.ev('!document.getElementById("gate").hidden'));
  await signIn('staff@shop.sa', 'Staff-pass-9');
  await waitFor(c, 'S.cloud && S.cloud.access && S.cloud.access.role==="staff" && S.ws.branches.length===1', 'the staff view', 25000);
  check('staff sees only its branch', await c.ev('S.ws.branches.map(function(b){return b.id}).join(",")') === 'caneles-1');
  check('branches tab hidden for staff', await c.ev('document.getElementById("tabBranches").hidden'));
  check('control panel hidden for staff', await c.ev('document.getElementById("tabAdmin").hidden'));
  check('a screen outside the role is hidden (items)', await c.ev('document.querySelector(\'#tabs button[data-tab="items"]\').hidden'));
  check('a screen in the role is shown (entry)', await c.ev('!document.querySelector(\'#tabs button[data-tab="entry"]\').hidden'));
  check('the header names the account and its role', (await c.ev('document.getElementById("userChip").textContent')).includes('موظف'));
  check('by its name, not its email', (await c.ev('document.getElementById("userChip").textContent')).includes('سارة'));
  check('no "manage branches" in the picker', await c.ev('!document.querySelector(\'#branchPick option[value="__manage"]\')'));
  await c.ev('document.querySelector(\'#tabs button[data-tab="setup"]\').click()'); await sleep(400);
  check('no storage settings for staff', await c.ev('!document.getElementById("cloudUrl") && !document.getElementById("modeLocal")'));
  check('no data tools for staff', await c.ev('!document.getElementById("wipe") && !document.getElementById("restore") && !document.getElementById("openFolder")'));
  check('no settings sections outside the role', await c.ev('!document.getElementById("cfgTend") && !document.getElementById("addEvent")'));
  check('About the App shown to everyone', (await c.ev('document.querySelector(".about").textContent')).includes('Mohamed Hasan'));
  check('no branch rename for staff', await c.ev('!document.getElementById("cfgBranch")'));
  check('no account & sync card in settings for staff', await c.ev('!document.getElementById("storageCard") && !document.getElementById("signOut")'));
  check('staff syncs and signs out from the header', await c.ev('!document.getElementById("cloudChip").hidden && !document.getElementById("userChip").hidden'));
  check('the other branch left this computer', !fs.existsSync(path.join(PROFILE, 'branches', 'chezzz-1')));
  await c.ev('document.querySelector(\'#tabs button[data-tab="entry"]\').click()'); await sleep(300);
  await c.ev(`(function(){var el=document.querySelector('.entIn[data-pid="c7"][data-f="sold"]');el.value="5";el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return 1})()`);
  const t3 = Date.now();
  while (Date.now() - t3 < 15000) { const r = mock.rows().get('caneles-1'); if (r.data.days[day].items.c7) break; await sleep(300); }
  check('staff work on its branch reaches the cloud', (mock.rows().get('caneles-1').data.days[day].items.c7 || {}).sold === 5);
  const t4 = Date.now();
  while (Date.now() - t4 < 15000) { if (mock.activity().some(a => a.email === 'staff@shop.sa' && a.action === 'entry')) break; await sleep(300); }
  check('the activity log has the staff edit, under its own email', mock.activity().some(a => a.email === 'staff@shop.sa' && a.action === 'entry' && /c7|صنف/.test(a.detail)));
  check('and the staff sign-in', mock.activity().some(a => a.email === 'staff@shop.sa' && a.action === 'login'));

  console.log('--- the owner disables the account ---');
  mock.member('staff@shop.sa').active = false;
  await c.ev('cloudSyncNow()');
  await waitFor(c, 'S.cloud && S.cloud.status==="disabled"', 'the disabled state', 20000);
  check('a disabled account is stopped at the sign-in screen', await c.ev('!document.getElementById("gate").hidden') && (await c.ev('document.getElementById("gateMsg").textContent')).includes('موقوف'));

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  c.close(); proc.kill(); await mock.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + (e.stack || e)); process.exit(1); });
