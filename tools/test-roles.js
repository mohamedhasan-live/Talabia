'use strict';
/*
 * The owner's control panel through the real app: the owner builds a role
 * that may edit items but not add or delete them, gives it to an account, and
 * that account sees exactly that — the screens and buttons it was given, no
 * more. A hidden button clicked by script is refused too, and the main
 * process refuses what the role lacks even when the page is bypassed.
 *
 *   node tools/test-roles.js
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
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-roles-'));
const LEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-roles-leg-'));
const PORT = 9900 + Math.floor(Math.random() * 90);
const KEY = 'test-key-' + Date.now();

let pass = 0, fail = 0; const pageErrors = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rec = (n, b, p) => ({ v: 1, cfg: { branch: b, orderDays: [0, 3] },
  products: Array.from({ length: n }, (_, i) => ({ id: p + i, name: 'صنف ' + p + i, unit: 'حبة', shelfLife: 5, packSize: 1, active: true })),
  days: {}, stock: {}, events: [], orders: {} });
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
async function waitFor(c, expr, label, ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await c.ev('!!(' + expr + ')')) return true; await sleep(250); }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  killOrphans(); process.on('exit', killOrphans);
  const mock = await startMock({ key: KEY });
  mock.addUser('owner@shop.sa', 'S3cure-pass');
  const env = Object.assign({}, process.env, { DAFTAR_LEGACY_ROOT: LEGACY, DAFTAR_CLOUD_URL: mock.url + '/rest/v1/', DAFTAR_CLOUD_KEY: KEY });
  const args = ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  const proc = EXE ? spawn(EXE, args, { env }) : spawn(ELECTRON, ['.'].concat(args), { cwd: ROOT, env });
  const c = await connect((await target()).webSocketDebuggerUrl);
  const signIn = async (em, pw) => {
    await waitFor(c, '!document.getElementById("gate").hidden && !document.getElementById("gateForm").hidden', 'the sign-in screen');
    await c.ev(`(function(){document.getElementById("gateEmail").value=${JSON.stringify(em)};document.getElementById("gatePass").value=${JSON.stringify(pw)};document.getElementById("gateBtn").click();return 1})()`);
  };

  console.log('--- the owner signs in ---');
  await waitFor(c, 'window.S && S.ready && S.branchId', 'the app to start', 90000);
  await c.ev('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await signIn('owner@shop.sa', 'S3cure-pass');
  await waitFor(c, 'S.cloud && S.cloud.status==="ok" && document.getElementById("gate").hidden', 'the owner to be in');
  check('the owner sees every screen', await c.ev('Array.prototype.every.call(document.querySelectorAll("#tabs button[data-tab]:not(#tabBranches):not(#tabAdmin)"),function(b){return !b.hidden})'));

  console.log('--- the owner builds a role: edit items, not add or delete ---');
  await c.ev('document.querySelector(\'#tabs button[data-tab="admin"]\').click()');
  await waitFor(c, 'CP.loaded && document.getElementById("cpSec_roles")', 'the control panel');
  await c.ev('document.getElementById("cpSec_roles").click()');
  await waitFor(c, 'document.getElementById("cpRoleNew")', 'the roles section');
  await c.ev('document.getElementById("cpRoleNew").click()');
  await waitFor(c, 'document.getElementById("cpRoleName")', 'the role editor');
  await c.ev(`(function(){
    var n=document.getElementById("cpRoleName"); n.value="محرّر أصناف"; n.dispatchEvent(new Event("input",{bubbles:true}));
    var e=document.querySelector('.cpPerm[value="items.edit"]'); e.checked=true; e.dispatchEvent(new Event("change",{bubbles:true}));
    var x=document.querySelector('.cpPerm[value="data.export"]'); x.checked=true; x.dispatchEvent(new Event("change",{bubbles:true}));
    return 1})()`);
  check('ticking an action ticks its screen', await c.ev('document.querySelector(\'.cpPerm[value="view.items"]\').checked'));
  await c.ev(`(function(){var v=document.querySelector('.cpPerm[value="view.items"]'); v.checked=false; v.dispatchEvent(new Event("change",{bubbles:true})); return 1})()`);
  check('unticking a screen unticks its actions', await c.ev('!document.querySelector(\'.cpPerm[value="items.edit"]\').checked'));
  await c.ev(`(function(){var e=document.querySelector('.cpPerm[value="items.edit"]'); e.checked=true; e.dispatchEvent(new Event("change",{bubbles:true})); document.getElementById("cpRoleSave").click(); return 1})()`);
  await waitFor(c, 'CP.loaded && CP.roles.some(function(r){return r.name==="محرّر أصناف"})', 'the new role');
  const role = [...mock.roles().entries()].find(([, r]) => r.name === 'محرّر أصناف');
  check('the role is saved on the server', !!role);
  check('with exactly what was ticked', role && JSON.stringify(Object.keys(role[1].perms).sort()) === JSON.stringify(['data.export', 'items.edit', 'view.items']));

  console.log('--- an account with that role, on one branch ---');
  await c.ev('document.getElementById("cpSec_users").click()');
  await c.ev('document.getElementById("cpAdd").click()');
  await c.ev(`(function(){
    document.getElementById("cpName").value="خالد";
    document.getElementById("cpEmail").value="editor@shop.sa"; document.getElementById("cpPass").value="Editor-pass-9"; document.getElementById("cpPass2").value="Editor-pass-9";
    document.getElementById("cpNewRole").value=${JSON.stringify(role ? role[0] : '')};
    document.querySelector('.admBr[data-u="__new"][value="chezzz-1"]').checked=true;
    document.getElementById("cpCreate").click(); return 1})()`);
  await waitFor(c, 'CP.loaded && CP.users && CP.users.some(function(u){return u.email==="editor@shop.sa"})', 'the account');
  check('the account carries the role', mock.member('editor@shop.sa') && mock.member('editor@shop.sa').roleId === (role && role[0]));
  check('and the name', mock.member('editor@shop.sa').name === 'خالد');

  console.log('--- names: unique, and the owner can rename ---');
  await c.ev('document.getElementById("cpAdd").click()');
  await c.ev(`(function(){
    document.getElementById("cpName").value="خالد";
    document.getElementById("cpEmail").value="other@shop.sa"; document.getElementById("cpPass").value="Other-pass-99"; document.getElementById("cpPass2").value="Other-pass-99";
    document.getElementById("cpCreate").click(); return 1})()`);
  await sleep(600);
  check('a second account with the same name is refused', !mock.member('other@shop.sa'));
  const edUid = await c.ev('CP.users.filter(function(u){return u.email==="editor@shop.sa"})[0].user_id');
  check('a user\'s editor is closed until «تعديل» is pressed', await c.ev(`!document.querySelector('.cpName[data-u="${edUid}"]')`));
  await c.ev(`document.querySelector('.cpOpen[data-u="${edUid}"]').click()`);
  await c.ev(`(function(){var i=document.querySelector('.cpName[data-u="${edUid}"]'); i.value="خالد أحمد"; i.dispatchEvent(new Event("input",{bubbles:true}));
    document.querySelector('.cpSave[data-u="${edUid}"]').click(); return 1})()`);
  await waitFor(c, 'CP.loaded && CP.users.some(function(u){return u.name==="خالد أحمد"})', 'the rename');
  check('renaming keeps the role', mock.member('editor@shop.sa').roleId === (role && role[0]) && mock.member('editor@shop.sa').name === 'خالد أحمد');
  const dup = await c.ev(`window.desktop.admin("createMember",{name:"خالد أحمد",email:"other@shop.sa",password:"Other-pass-99",roleId:null,branches:[]})`);
  check('the server also refuses a duplicate name (page check bypassed)', dup && !dup.ok && /بنفس الاسم/.test(dup.error || '') && !mock.member('other@shop.sa'), dup && dup.error);

  console.log('--- that account signs in on this device ---');
  await c.ev('doSignOut()');
  await signIn('editor@shop.sa', 'Editor-pass-9');
  await waitFor(c, 'S.cloud && S.cloud.access && S.cloud.access.email==="editor@shop.sa" && S.ws.branches.length===1 && S.branchId==="chezzz-1"', 'the editor view');
  const shown = await c.ev('Array.prototype.filter.call(document.querySelectorAll("#tabs button[data-tab]"),function(b){return !b.hidden}).map(function(b){return b.dataset.tab}).join(",")');
  // the materials-and-recipes screen sits with the products: it follows «view.items»
  check('only the items screen (with its recipes) and settings are shown', shown === 'items,recipes,setup', shown);
  check('it opens on the screen it may see', await c.ev('S.tab') === 'items');
  check('item fields are editable', await c.ev('document.querySelectorAll(".itIn").length>0 && !document.querySelector(".itIn").disabled'));
  check('the delete buttons are hidden', await c.ev('Array.prototype.every.call(document.querySelectorAll(".delItem"),function(b){return b.hidden})'));
  check('the add button is hidden', await c.ev('!document.getElementById("addItem") || document.getElementById("addItem").hidden'));
  const before = await c.ev('S.products.length');
  await c.ev('document.querySelector(".delItem").click()'); await sleep(400);
  check('a hidden delete clicked by script is refused', await c.ev('S.products.length') === before);
  await c.ev('S.tab="order";render()');
  check('a screen outside the role cannot be forced open', await c.ev('S.tab') !== 'order');
  await c.ev('S.tab="setup";render()');
  check('backup export is offered (in the role)', await c.ev('!!document.getElementById("saveAs") || !!document.getElementById("backup")'));
  check('backup import is not (outside the role)', await c.ev('!document.getElementById("restore")'));
  check('About the App at the bottom', (await c.ev('document.querySelector(".about").textContent')).includes('Order Planning System'));

  console.log('--- the main process refuses what the role lacks, even with the page bypassed ---');
  const imp = await c.ev('window.desktop.importFile().then(function(r){return JSON.stringify(r)})');
  check('import refused by the main process', /صلاحية/.test(imp), imp);
  const adm = await c.ev('window.desktop.admin("users").then(function(r){return JSON.stringify(r)})');
  check('the owner\'s panel calls are refused', /للمدير فقط|غير مسموح/.test(adm), adm);
  const addB = await c.ev('window.desktop.addBranch({brand:"chezzz",name:"فرع مزيّف"}).then(function(r){return JSON.stringify(r)})');
  check('adding a branch is refused', /صلاحية|للمدير فقط/.test(addB), addB);
  const renB = await c.ev('window.desktop.renameBranch("chezzz-1","اسم مزيّف").then(function(r){return JSON.stringify(r)})');
  check('renaming a branch is refused (no «تعديل الفروع»)', /صلاحية|للمدير فقط/.test(renB) && mock.rows().get('chezzz-1').name !== 'اسم مزيّف', renB);
  check('no branches screen without the branch permissions', await c.ev('document.getElementById("tabBranches").hidden'));

  console.log('--- the database itself enforces the role (supabase-roles.sql, talabia_guard_perms) ---');
  await c.ev('S.tab="items";render()');
  await c.ev(`(function(){var el=document.querySelector('.itIn[data-f="name"]'); el.value="اسم عدّله المحرّر"; el.dispatchEvent(new Event("input",{bubbles:true})); return 1})()`);
  let t0 = Date.now();
  while (Date.now() - t0 < 15000) { if (mock.rows().get('chezzz-1').data.products.some(p => p.name === 'اسم عدّله المحرّر')) break; await sleep(300); }
  check('an edit inside the role reaches the cloud', mock.rows().get('chezzz-1').data.products.some(p => p.name === 'اسم عدّله المحرّر'));
  // a tampered copy: record a sale (outside the role) straight into the page's data, bypassing every screen
  const dayKey = await c.ev('S.entryDate');
  await c.ev(`(function(){ ensureItem(S.entryDate,"z1").sold=99; saveLocal(); return 1 })()`);
  t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (!(await c.ev('!!(S.days[S.entryDate]&&S.days[S.entryDate].items.z1&&S.days[S.entryDate].items.z1.sold===99)'))) break; await sleep(300); }
  const cloudDay = (mock.rows().get('chezzz-1').data.days || {})[dayKey];
  check('the database refused the sale outside the role', !(cloudDay && cloudDay.items && cloudDay.items.z1 && cloudDay.items.z1.sold === 99));
  check('and this device took the cloud copy back', await c.ev('!(S.days[S.entryDate]&&S.days[S.entryDate].items.z1&&S.days[S.entryDate].items.z1.sold===99)'));
  check('the earlier allowed edit is still there', await c.ev('S.products.some(function(p){return p.name==="اسم عدّله المحرّر"})'));
  await sleep(1500);
  check('syncing carries on afterwards', await c.ev('S.cloud.status') === 'ok', await c.ev('S.cloud.status+" "+S.cloud.error'));

  console.log('--- the owner changes the role: the account follows within a sync ---');
  role[1].perms['items.delete'] = true;
  await c.ev('cloudSyncNow()');
  await waitFor(c, 'S.cloud.access.perms && S.cloud.access.perms["items.delete"]===true', 'the new permission');
  await c.ev('S.tab="items";render()');
  check('the delete buttons appear', await c.ev('document.querySelectorAll(".delItem").length>0 && !document.querySelector(".delItem").hidden'));

  console.log('--- branch permissions: the owner opens «إنشاء فرع» and «تعديل الفروع» for the role ---');
  role[1].perms['branches.add'] = true; role[1].perms['branches.edit'] = true;
  await c.ev('cloudSyncNow()');
  await waitFor(c, 'S.cloud.access.perms && S.cloud.access.perms["branches.add"]===true && S.cloud.access.perms["branches.edit"]===true', 'the branch permissions');
  await c.ev('render()');
  check('the branches screen appears', await c.ev('!document.getElementById("tabBranches").hidden'));
  await c.ev('S.tab="branches"; render(); loadBranchStats()'); await sleep(500);
  check('it lists only this account\'s branch', await c.ev('document.querySelectorAll(".brrow").length') === 1);
  check('no delete buttons (deleting stays the owner\'s)', await c.ev('!document.querySelector(".brDel")'));
  check('no owner-only parts (users, data folder)', await c.ev('!document.getElementById("cloudUrl") && !/مجلّد بيانات الفروع/.test(document.getElementById("view").textContent)'));
  check('the add field is offered and enabled', await c.ev('!!document.getElementById("newName-chezzz") && !document.getElementById("newName-chezzz").disabled'));
  // create a branch through the screen
  await c.ev(`(function(){var i=document.getElementById("newName-chezzz"); i.focus(); i.value="فرع الملقا"; document.querySelector('.brAdd[data-brand="chezzz"]').click(); return 1})()`);
  await waitFor(c, 'S.ws.branches.length===2', 'the new branch on this computer');
  t0 = Date.now(); let made = null;
  while (Date.now() - t0 < 20000) { made = [...mock.rows().values()].find(r => r.name === 'فرع الملقا'); if (made) break; await c.ev('cloudSyncNow()'); await sleep(500); }
  check('the new branch reached the cloud', !!made && made.brand === 'chezzz');
  check('and the server assigned it to this account', !!made && mock.member('editor@shop.sa').branches.includes(made.id));
  check('the add field is empty again', await c.ev('(document.getElementById("newName-chezzz")||{}).value===""'));
  await c.ev('cloudSyncNow()'); await sleep(1500);
  check('it stays on this computer after syncing', await c.ev('S.ws.branches.length') === 2, await c.ev('S.ws.branches.map(function(b){return b.name}).join(",")'));
  // rename a branch through the screen
  await c.ev('S.tab="branches"; render()');
  await c.ev(`(function(){var i=document.querySelector('.brName[data-id="chezzz-1"]'); i.value="فرع تشيززز الجديد"; i.dispatchEvent(new Event("input",{bubbles:true})); return 1})()`);
  t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (mock.rows().get('chezzz-1').name === 'فرع تشيززز الجديد') break; await sleep(400); }
  check('the new name reached the cloud', mock.rows().get('chezzz-1').name === 'فرع تشيززز الجديد', mock.rows().get('chezzz-1').name);
  const delB = await c.ev('window.desktop.removeBranch("chezzz-1").then(function(r){return JSON.stringify(r)})');
  check('deleting a branch is still refused', /للمدير فقط/.test(delB) && !mock.rows().get('chezzz-1').deleted, delB);

  console.log('--- delegated control-panel rights: everything the owner allows, nothing over the owner ---');
  role[1].perms['admin.users'] = true; role[1].perms['admin.roles'] = true; role[1].perms['admin.log'] = true;
  await c.ev('cloudSyncNow()');
  await waitFor(c, 'S.cloud.access.perms && S.cloud.access.perms["admin.users"]===true && S.cloud.access.perms["admin.log"]===true', 'the delegated rights');
  check('the control panel opens for a role given «إدارة المستخدمين»', await c.ev('!document.getElementById("tabAdmin").hidden'));
  const ul = JSON.parse(await c.ev('window.desktop.admin("users").then(function(r){return JSON.stringify(r)})'));
  check('…it lists the accounts', ul.ok && ul.data.length >= 2, JSON.stringify(ul).slice(0, 200));
  const ownerId = ul.data.filter(function(u){ return u.owner })[0].user_id, meId = ul.data.filter(function(u){ return u.me })[0].user_id;
  const r1 = JSON.parse(await c.ev(`window.desktop.admin("setActive",{user:${JSON.stringify(ownerId)},active:false}).then(function(r){return JSON.stringify(r)})`));
  const r2 = JSON.parse(await c.ev(`window.desktop.admin("setMember",{user:${JSON.stringify(ownerId)},roleId:null,branches:[]}).then(function(r){return JSON.stringify(r)})`));
  check('it can never stop or change the owner\'s account', !r1.ok && !r2.ok && mock.member('owner@shop.sa').active !== false, JSON.stringify([r1.error, r2.error]));
  const r3 = JSON.parse(await c.ev(`window.desktop.admin("setMember",{user:${JSON.stringify(meId)},roleId:null,branches:["chezzz-1","caneles-1"]}).then(function(r){return JSON.stringify(r)})`));
  const r4 = JSON.parse(await c.ev(`window.desktop.admin("saveRole",{id:${JSON.stringify(role[0])},name:"محرّر",perms:{"view.items":true,"view.order":true}}).then(function(r){return JSON.stringify(r)})`));
  check('…nor change its own account or its own role (no giving itself rights)', !r3.ok && !r4.ok && mock.member('editor@shop.sa').branches.length >= 1 && role[1].perms['admin.users'] === true, JSON.stringify([r3.error, r4.error]));
  const r5 = JSON.parse(await c.ev('window.desktop.admin("saveRole",{name:"مصدّر",perms:{"view.items":true,"data.export":true}}).then(function(r){return JSON.stringify(r)})'));
  const r6 = JSON.parse(await c.ev('window.desktop.admin("saveRole",{name:"مشرف ثانٍ",perms:{"admin.users":true}}).then(function(r){return JSON.stringify(r)})'));
  check('…nor create a role with anything sensitive (data, the control panel itself)', !r5.ok && !r6.ok, JSON.stringify([r5.error, r6.error]));
  const r7 = JSON.parse(await c.ev('window.desktop.admin("saveRole",{name:"كاشير",perms:{"view.entry":true,"entry.record":true}}).then(function(r){return JSON.stringify(r)})'));
  check('…but it creates ordinary roles freely', r7.ok && !!r7.data, JSON.stringify(r7));
  const r8 = JSON.parse(await c.ev(`window.desktop.admin("createMember",{name:"منى",email:"cash@shop.sa",password:"Cash-pass-99",roleId:${JSON.stringify(role[0])},branches:["chezzz-1"]}).then(function(r){return JSON.stringify(r)})`));
  const r9 = JSON.parse(await c.ev(`window.desktop.admin("createMember",{name:"منى",email:"cash@shop.sa",password:"Cash-pass-99",roleId:${JSON.stringify(r7.data)},branches:["chezzz-1"]}).then(function(r){return JSON.stringify(r)})`));
  check('…and accounts with them — never with a sensitive role', !r8.ok && r9.ok && mock.member('cash@shop.sa') && mock.member('cash@shop.sa').roleId === r7.data, JSON.stringify([r8.error, r9.ok]));
  const r10 = JSON.parse(await c.ev('window.desktop.admin("activity",{limit:20}).then(function(r){return JSON.stringify({ok:r.ok})})'));
  const r11 = JSON.parse(await c.ev('window.desktop.admin("clearActivity").then(function(r){return JSON.stringify(r)})'));
  check('the log: it may read it, never clear it', r10.ok && !r11.ok, JSON.stringify([r10, r11.error]));
  await c.ev('S.tab="admin"; CP.loaded=false; cpLoad(); 1'); await sleep(1200);
  await c.ev('CP.sec="roles"; CP.edit={perms:{}}; render(); 1'); await sleep(300);
  check('on screen: the sensitive rights are locked in the role editor, and there is no «مسح السجلّ»', await c.ev('document.querySelector(\'.cpPerm[value="data.export"]\').disabled && document.querySelector(\'.cpPerm[value="usr.view"]\').disabled && document.querySelector(\'.cpPerm[value="role.edit"]\').disabled && !document.querySelector(\'.cpPerm[value="items.edit"]\').disabled') && await c.ev('CP.edit=null; CP.sec="log"; render(); !document.getElementById("cpActClear")'));
  check('…and the owner\'s row and its own row have no «تعديل»', await c.ev(`CP.sec="users"; render(); !document.querySelector('.cpOpen[data-u=${JSON.stringify(ownerId)}]') && !document.querySelector('.cpOpen[data-u=${JSON.stringify(meId)}]')`));

  console.log('--- the owner\'s roles and accounts are the delegate\'s to manage — the sensitive rights stay as the owner set them ---');
  mock.roles().set('mgr-owner', { name: 'مدير فرع (من المالك)', perms: { 'view.order': true, 'view.items': true, 'data.export': true } });
  const e1 = JSON.parse(await c.ev('window.desktop.admin("saveRole",{id:"mgr-owner",name:"مدير فرع (من المالك)",perms:{"view.order":true,"view.items":true,"view.stats":true,"data.export":true}}).then(function(r){return JSON.stringify(r)})'));
  check('a role the owner made (with «تصدير نسخة») can be edited by the delegate…', e1.ok && mock.roles().get('mgr-owner').perms['view.stats'] === true, JSON.stringify(e1));
  const e2 = JSON.parse(await c.ev('window.desktop.admin("saveRole",{id:"mgr-owner",name:"مدير فرع (من المالك)",perms:{"view.order":true,"view.items":true}}).then(function(r){return JSON.stringify(r)})'));
  const e3 = JSON.parse(await c.ev('window.desktop.admin("saveRole",{id:"mgr-owner",name:"مدير فرع (من المالك)",perms:{"view.order":true,"data.export":true,"data.import":true}}).then(function(r){return JSON.stringify(r)})'));
  check('…but its sensitive rights cannot be removed or added', !e2.ok && !e3.ok && mock.roles().get('mgr-owner').perms['data.export'] === true && !mock.roles().get('mgr-owner').perms['data.import'], JSON.stringify([e2.error, e3.error]));
  const cashId0 = (JSON.parse(await c.ev('window.desktop.admin("users").then(function(r){return JSON.stringify(r)})')).data.filter(function(u){ return u.email === 'cash@shop.sa' })[0] || {}).user_id;
  mock.member('cash@shop.sa').roleId = 'mgr-owner';
  const e4 = JSON.parse(await c.ev(`window.desktop.admin("setMember",{user:${JSON.stringify(cashId0)},name:"منى علي",roleId:"mgr-owner",branches:["chezzz-1"]}).then(function(r){return JSON.stringify(r)})`));
  check('an account the owner gave such a role is still the delegate\'s to edit (name, branches), keeping its role', e4.ok && mock.member('cash@shop.sa').name === 'منى علي', JSON.stringify(e4));
  await c.ev('S.tab="admin"; CP.loaded=false; cpLoad(); 1'); await sleep(1200);
  await c.ev('CP.sec="roles"; render(); 1'); await sleep(200);
  check('on screen: «تعديل الصلاحيات» on the owner\'s role, none on the delegate\'s own', await c.ev(`!!document.querySelector('.cpRoleEdit[data-r="mgr-owner"]') && !document.querySelector('.cpRoleEdit[data-r=${JSON.stringify(role[0])}]')`));

  console.log('--- the control-panel rights, part by part ---');
  await c.ev('S.tab="admin"; CP.sec=null; render(); 1'); await sleep(200);
  await c.ev('document.getElementById("cpSec_roles").click(); 1'); await sleep(300);
  check('a delegated account opens the panel\'s sections by pressing them', await c.ev('CP.sec==="roles" && !!document.querySelector(".cp-panel")'));
  ['admin.users', 'admin.roles', 'admin.log'].forEach(function(k){ delete role[1].perms[k] });
  role[1].perms['usr.view'] = true; role[1].perms['usr.stop'] = true; role[1].perms['log.view'] = true;
  await c.ev('cloudSyncNow()');
  await waitFor(c, 'S.cloud.access.perms && S.cloud.access.perms["usr.stop"]===true && !S.cloud.access.perms["admin.users"]', 'the parts');
  const g1 = JSON.parse(await c.ev('window.desktop.admin("users").then(function(r){return JSON.stringify({ok:r.ok})})'));
  const cash = mock.member('cash@shop.sa');
  const cashId = (JSON.parse(await c.ev('window.desktop.admin("users").then(function(r){return JSON.stringify(r)})')).data.filter(function(u){ return u.email === 'cash@shop.sa' })[0] || {}).user_id;
  const g2 = JSON.parse(await c.ev(`window.desktop.admin("setActive",{user:${JSON.stringify(cashId)},active:false}).then(function(r){return JSON.stringify(r)})`));
  const g3 = JSON.parse(await c.ev(`window.desktop.admin("setMember",{user:${JSON.stringify(cashId)},roleId:null,branches:[]}).then(function(r){return JSON.stringify(r)})`));
  const g4 = JSON.parse(await c.ev('window.desktop.admin("saveRole",{name:"دور ممنوع",perms:{"view.items":true}}).then(function(r){return JSON.stringify(r)})'));
  const g5 = JSON.parse(await c.ev(`window.desktop.admin("password",{user:${JSON.stringify(cashId)},password:"Other-pass-77"}).then(function(r){return JSON.stringify(r)})`));
  check('each part works alone: «عرض» and «إيقاف وتفعيل» given — so it lists and stops accounts…', g1.ok && g2.ok && mock.member('cash@shop.sa').active === false, JSON.stringify([g1, g2]));
  check('…but cannot edit an account, change a password or create a role (not given)', !g3.ok && !g5.ok && !g4.ok, JSON.stringify([g3.error, g5.error, g4.error]));
  await c.ev('S.tab="admin"; CP.loaded=false; cpLoad(); 1'); await sleep(1200);
  await c.ev('CP.sec="users"; render(); 1'); await sleep(200);
  check('on screen: no «+ إضافة مستخدم» and no roles section without their parts', await c.ev('!document.getElementById("cpAdd") && !document.getElementById("cpSec_roles") && !!document.getElementById("cpSec_log")'));

  console.log('--- the settings, section by section ---');
  await c.ev('S.tab="setup"; render(); 1'); await sleep(200);
  const st0 = await c.ev('["theme","ui","market","general"].filter(function(k){ return !!document.querySelector(".paneSec[data-g=setup][data-s="+k+"]") }).join()');
  check('without their rights, no «المظهر والألوان», «تخصيص الواجهة», «السوق والدولة» or «عام»', st0 === '', st0);
  role[1].perms['setup.look'] = true; role[1].perms['setup.ui'] = true;
  await c.ev('cloudSyncNow()');
  await waitFor(c, 'S.cloud.access.perms && S.cloud.access.perms["setup.look"]===true', 'the settings rights');
  await c.ev('S.tab="setup"; render(); 1'); await sleep(200);
  const st1 = await c.ev('["theme","ui","market","general"].filter(function(k){ return !!document.querySelector(".paneSec[data-g=setup][data-s="+k+"]") }).join()');
  check('…given «المظهر والألوان» and «تخصيص الواجهة», exactly those appear', st1 === 'ui,theme' || st1 === 'theme,ui', st1);

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  c.close(); proc.kill(); await mock.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + (e.stack || e)); process.exit(1); });
