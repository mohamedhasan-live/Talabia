'use strict';
/*
 * Two devices, one cloud: the sync rules end to end against a stand-in for
 * Supabase. First upload, a second device downloading everything, edits
 * travelling both ways, a new branch and a delete reaching the other device,
 * a clash where both changed, and the "table not created yet" state.
 *
 *   node tools/test-cloud.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeWorkspace } = require('../workspace');
const { makeCloud } = require('../cloud');
const { makeStore } = require('../store');
const { startMock } = require('./mock-supabase');
const { makeAuth } = require('../auth');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const BRANDS = [
  { key: 'caneles', appName: 'daftar-altalabiya', productName: 'CANELÉS', branch: 'فرع النرجس' },
  { key: 'chezzz', appName: 'daftar-chezzz', productName: 'CHEZZZ', branch: 'فرع تشيززز' }
];
const KEY = 'test-anon-key';
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rec = (n, b, p) => ({ v: 1, cfg: { branch: b }, products: Array.from({ length: n }, (_, i) => ({ id: p + i, name: 'صنف ' + i })),
  days: { '2026-09-20': { date: '2026-09-20', items: { [p + '0']: { sold: 3 } } } }, stock: {}, events: [], orders: {} });

(async () => {
  console.log('--- the table is not there yet ---');
  // a project with supabase-security.sql only (no roles yet): the roles and the
// server-side permission check are covered by test-guard, test-roles and test-cloud-app
let mock = await startMock({ key: KEY, withTable: false, withRoles: false });
  mock.addUser('owner@shop.sa', 'correct-horse');
  const signed = async (url) => { const a = makeAuth({ url, key: KEY, file: null }); const r = await a.signIn('owner@shop.sa', 'correct-horse'); if (!r.ok) throw new Error('sign in failed'); return a; };
  const authA = await signed(mock.url), authB = await signed(mock.url);
  const leg = tmp('cl-leg-');
  makeStore(path.join(leg, 'daftar-altalabiya')).save(rec(17, 'فرع النرجس', 'c'));
  makeStore(path.join(leg, 'daftar-chezzz')).save(rec(18, 'فرع تشيززز', 'z'));
  const wsA = makeWorkspace({ root: tmp('cl-a-'), brands: BRANDS, legacyRoot: leg });
  let updates = [];
  const A = makeCloud({ url: mock.url + '/rest/v1/', key: KEY, ws: wsA, brands: BRANDS, onUpdate: u => updates.push(u), auth: authA });
  let v = await A.sync();
  check('reports that setup is needed', v.status === 'setup', JSON.stringify(v));
  check('local data untouched meanwhile', wsA.load('caneles-1').data.products.length === 17);

  console.log('--- first upload ---');
  mock.createTable();
  v = await A.sync();
  check('sync ok', v.status === 'ok', JSON.stringify(v));
  check('both branches uploaded', mock.rows().size === 2);
  check('cloud row carries the whole record', mock.rows().get('caneles-1').data.products.length === 17);
  check('cloud row carries brand and name', mock.rows().get('chezzz-1').brand === 'chezzz' && mock.rows().get('chezzz-1').name === 'فرع تشيززز');
  check('agreed revision recorded', wsA.entries().every(e => e.cloudRev === e.rev));
  check('an update was published', updates.length >= 2);
  const callsBefore = mock.calls();
  await A.sync();
  check('nothing changed -> membership check + one listing call', mock.calls() - callsBefore === 2, mock.calls() - callsBefore);

  console.log('--- a second device (no old apps) downloads everything ---');
  const wsB = makeWorkspace({ root: tmp('cl-b-'), brands: BRANDS, legacyRoot: null });
  const B = makeCloud({ url: mock.url, key: KEY, ws: wsB, brands: BRANDS, auth: authB });
  v = await B.sync();
  check('B sync ok, no conflicts', v.status === 'ok' && v.conflicts.length === 0, JSON.stringify(v.conflicts));
  check('B has CANELÉS data', wsB.load('caneles-1').data && wsB.load('caneles-1').data.products.length === 17);
  check('B has CHEZZZ data', wsB.load('chezzz-1').data.products.length === 18);
  check('B keeps the history', Object.keys(wsB.load('caneles-1').data.days).length === 1);

  console.log('--- an edit on A reaches B ---');
  let d = wsA.load('caneles-1').data; d.days['2026-09-29'] = { date: '2026-09-29', items: { c1: { sold: 12 } } };
  let base = wsA.load('caneles-1').rev;
  check('save with the right base rev works', wsA.save('caneles-1', d, base).ok);
  await A.sync();
  check('cloud has the edit', mock.rows().get('caneles-1').data.days['2026-09-29'].items.c1.sold === 12);
  updates = [];
  const B2 = makeCloud({ url: mock.url, key: KEY, ws: wsB, brands: BRANDS, onUpdate: u => updates.push(u), auth: authB });
  await B2.sync();
  check('B pulled the edit', wsB.load('caneles-1').data.days['2026-09-29'].items.c1.sold === 12);
  check('B was told which branch changed', updates[0] && updates[0].changed.includes('caneles-1'), JSON.stringify(updates[0] && updates[0].changed));

  console.log('--- a stale save is refused ---');
  const stale = wsB.save('caneles-1', d, base);
  check('save on an old base rev refused', !stale.ok && stale.stale === true, JSON.stringify(stale));

  console.log('--- an edit on B reaches A ---');
  d = wsB.load('chezzz-1').data; d.products.push({ id: 'znew', name: 'جديد من ب' });
  wsB.save('chezzz-1', d, wsB.load('chezzz-1').rev);
  await B2.sync(); await A.sync();
  check('A pulled B\'s new item', wsA.load('chezzz-1').data.products.some(p => p.id === 'znew'));

  console.log('--- rename travels ---');
  wsA.rename('chezzz-1', 'تشيززز العليا');
  await A.sync(); await B2.sync();
  check('B sees the new name', wsB.snapshot().branches.find(b => b.id === 'chezzz-1').name === 'تشيززز العليا');
  check('B record name updated', wsB.load('chezzz-1').data.cfg.branch === 'تشيززز العليا');

  console.log('--- a branch added on B appears on A ---');
  const add = wsB.add({ brand: 'caneles', name: 'فرع الملقا', data: { products: rec(4, 'x', 'm').products } });
  await B2.sync(); await A.sync();
  check('A got the new branch', !!wsA.snapshot().branches.find(b => b.id === add.id && b.name === 'فرع الملقا'));
  check('with its items', wsA.load(add.id).data.products.length === 4);

  console.log('--- a delete on A reaches B ---');
  wsA.remove(add.id);
  await A.sync();
  check('cloud row marked deleted', mock.rows().get(add.id).deleted === true);
  await B2.sync();
  check('B removed it too', !wsB.snapshot().branches.find(b => b.id === add.id));
  check('B kept its data in trash', fs.readdirSync(wsB.trashDir).some(t => t.startsWith(add.id)));
  await A.sync();
  check('A does not bring it back', !wsA.snapshot().branches.find(b => b.id === add.id));

  console.log('--- both changed: the owner decides ---');
  d = wsA.load('caneles-1').data; d.products[0].name = 'اسم من أ'; wsA.save('caneles-1', d, wsA.load('caneles-1').rev);
  d = wsB.load('caneles-1').data; d.products[0].name = 'اسم من ب'; wsB.save('caneles-1', d, wsB.load('caneles-1').rev);
  await A.sync();
  v = await B2.sync();
  check('B reports a conflict', v.conflicts.length === 1 && v.conflicts[0].id === 'caneles-1', JSON.stringify(v.conflicts));
  check('nothing overwritten on B', wsB.load('caneles-1').data.products[0].name === 'اسم من ب');
  check('nothing overwritten in the cloud', mock.rows().get('caneles-1').data.products[0].name === 'اسم من أ');
  let r = await B2.resolve('caneles-1', 'local');
  check('keep this device: ok', r.ok, JSON.stringify(r));
  check('cloud now has B\'s copy', mock.rows().get('caneles-1').data.products[0].name === 'اسم من ب');
  v = await A.sync();
  check('A pulls it with no conflict', v.conflicts.length === 0 && wsA.load('caneles-1').data.products[0].name === 'اسم من ب');
  d = wsA.load('caneles-1').data; d.products[1].name = 'أ مرة ثانية'; wsA.save('caneles-1', d, wsA.load('caneles-1').rev);
  d = wsB.load('caneles-1').data; d.products[1].name = 'ب مرة ثانية'; wsB.save('caneles-1', d, wsB.load('caneles-1').rev);
  await A.sync(); v = await B2.sync();
  r = await B2.resolve('caneles-1', 'cloud');
  check('take the cloud: B gets A\'s copy', r.ok && wsB.load('caneles-1').data.products[1].name === 'أ مرة ثانية');
  v = await B2.sync();
  check('and the conflict is gone', v.conflicts.length === 0);

  console.log('--- offline ---');
  const dead = makeCloud({ url: 'http://127.0.0.1:1', key: KEY, ws: wsA, brands: BRANDS });
  v = await dead.sync();
  check('no connection -> offline, no throw', v.status === 'offline');
  const off = makeCloud({ url: '', key: '', ws: wsA, brands: BRANDS });
  check('no settings -> cloud off', (await off.sync()).status === 'off');

  console.log('--- a server that never answers ---');
  const http = require('http');
  const hang = http.createServer(() => { /* never replies */ });
  await new Promise(r => hang.listen(0, '127.0.0.1', r));
  const slow = makeCloud({ url: 'http://127.0.0.1:' + hang.address().port, key: KEY, ws: wsA, brands: BRANDS, timeoutMs: 1500 });
  const t0 = Date.now(); v = await slow.sync();
  check('hung connection -> offline within the time limit, not stuck', v.status === 'offline' && Date.now() - t0 < 5000 && !v.running, v.status + ' ' + (Date.now() - t0) + 'ms');
  hang.closeAllConnections(); hang.close();

  console.log('--- wrong key ---');
  const bad = makeCloud({ url: mock.url, key: 'nope', ws: wsA, brands: BRANDS });
  v = await bad.sync();
  check('bad key reported as an error, data untouched', v.status === 'offline' && /Invalid API key/.test(v.error), JSON.stringify(v));

  console.log('--- security: the key alone opens nothing ---');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  let res = await fetch(mock.url + '/rest/v1/daftar_branches?select=*', { headers: H });
  check('anon key alone reads nothing', (await res.json()).length === 0);
  res = await fetch(mock.url + '/rest/v1/daftar_branches', { method: 'POST', headers: H, body: JSON.stringify([{ id: 'evil', brand: 'caneles', name: 'x', rev: 1, data: { products: [] } }]) });
  check('anon key alone cannot write', !res.ok && !mock.rows().has('evil'), res.status);
  res = await fetch(mock.url + '/rest/v1/daftar_branches?id=eq.caneles-1', { method: 'DELETE', headers: H });
  check('anon key alone cannot delete', mock.rows().has('caneles-1'), res.status);
  const anonCloud = makeCloud({ url: mock.url, key: KEY, ws: wsA, brands: BRANDS, auth: makeAuth({ url: mock.url, key: KEY, file: null }) });
  v = await anonCloud.sync();
  check('app without sign-in asks to sign in, sends nothing', v.status === 'signin');

  console.log('--- security: a signed-up stranger is not a member ---');
  mock.addUser('stranger@x.com', 'pw12345678', false);
  const authX = makeAuth({ url: mock.url, key: KEY, file: null });
  check('stranger can sign in', (await authX.signIn('stranger@x.com', 'pw12345678')).ok);
  const wsX = makeWorkspace({ root: tmp('cl-x-'), brands: BRANDS, legacyRoot: leg });
  const X = makeCloud({ url: mock.url, key: KEY, ws: wsX, brands: BRANDS, auth: authX });
  const before = JSON.stringify([...mock.rows().entries()]);
  v = await X.sync();
  check('stranger is told they are not a member', v.status === 'notmember', v.status);
  check('stranger received no branch', wsX.load('caneles-1').data.products.length === 17 && !wsX.snapshot().branches.some(b => b.id === 'chezzz-olaya'));
  check('stranger changed nothing in the cloud', JSON.stringify([...mock.rows().entries()]) === before);
  const tokX = await authX.token();
  res = await fetch(mock.url + '/rest/v1/daftar_branches?select=*', { headers: Object.assign({}, H, { Authorization: 'Bearer ' + tokX }) });
  check('stranger reading directly gets nothing', (await res.json()).length === 0);

  console.log('--- security: sign-in rules ---');
  const authW = makeAuth({ url: mock.url, key: KEY, file: null });
  const w = await authW.signIn('owner@shop.sa', 'wrong');
  check('wrong password refused', !w.ok && w.reason === 'credentials');
  check('no session after a refused sign-in', !authW.state().signedIn);
  mock.expireAll();
  d = wsA.load('chezzz-1').data; d.products.push({ id: 'zexp', name: 'بعد انتهاء الجلسة' }); wsA.save('chezzz-1', d, wsA.load('chezzz-1').rev);
  v = await A.sync();
  check('expired token refreshed silently, sync still works', v.status === 'ok' && mock.rows().get('chezzz-1').data.products.some(p => p.id === 'zexp'));
  mock.removeMember('owner@shop.sa');
  v = await A.sync();
  check('a removed member loses access at once', v.status === 'notmember');
  await authA.signOut();
  v = await A.sync();
  check('after sign-out: sign in again', v.status === 'signin');

  console.log('--- sign-out is per device, and nothing else signs you out ---');
  mock.addUser('two@shop.sa', 'Two-devices-1', true, 'staff', []);
  const d1 = makeAuth({ url: mock.url, key: KEY, file: null }), d2 = makeAuth({ url: mock.url, key: KEY, file: null });
  await d1.signIn('two@shop.sa', 'Two-devices-1'); await d2.signIn('two@shop.sa', 'Two-devices-1');
  await d1.signOut();
  mock.expireAll();
  check('signing out on one device keeps the other signed in', !!(await d2.token()) && d2.state().signedIn);
  const d3 = makeAuth({ url: 'http://127.0.0.1:1', key: KEY, file: null });
  await d3.signIn('two@shop.sa', 'x');
  const dOff = makeAuth({ url: mock.url, key: KEY, file: null, fetchImpl: () => Promise.reject(new Error('offline')) });
  check('offline sign-in attempt just fails', !(await dOff.signIn('two@shop.sa', 'Two-devices-1')).ok);
  const d4 = makeAuth({ url: mock.url, key: KEY, file: null });
  await d4.signIn('two@shop.sa', 'Two-devices-1');
  let realFetch = globalThis.fetch, down = true;
  const d5 = makeAuth({ url: mock.url, key: KEY, file: null, fetchImpl: (u, o) => down ? Promise.reject(new Error('offline')) : realFetch(u, o) });
  await (async () => { down = false; await d5.signIn('two@shop.sa', 'Two-devices-1'); down = true; })();
  mock.expireAll(); d5.invalidate();
  check('offline refresh keeps the session', (await d5.token()) === null && d5.state().signedIn);
  down = false;
  check('back online: session works again without a password', !!(await d5.token()));
  check('email remembered after a sign-out', (await (async () => { await d4.signOut(); return d4.state().lastEmail; })()) === 'two@shop.sa');

  console.log('--- roles: the admin assigns branches, a staff device sees only those ---');
  const bossAuth = makeAuth({ url: mock.url, key: KEY, file: null });
  mock.addUser('boss@shop.sa', 'boss-pass-123', true, 'admin');
  check('admin signs in', (await bossAuth.signIn('boss@shop.sa', 'boss-pass-123')).ok);
  const wsBoss = makeWorkspace({ root: tmp('cl-boss-'), brands: BRANDS, legacyRoot: null });
  const BOSS = makeCloud({ url: mock.url, key: KEY, ws: wsBoss, brands: BRANDS, auth: bossAuth });
  v = await BOSS.sync();
  check('admin sees every branch', v.status === 'ok' && wsBoss.entries().length >= 2 && v.access.role === 'admin', JSON.stringify(v.access));
  let rr = await BOSS.rpc('talabia_admin_create_user', { p_email: 'nargis@shop.sa', p_password: 'Nargis-pass-1', p_role: 'staff', p_branches: ['chezzz-1'] });
  check('admin creates a staff account', rr.ok, JSON.stringify(rr));
  rr = await BOSS.rpc('talabia_admin_users', {});
  check('admin lists users', rr.ok && rr.data.some(u => u.email === 'nargis@shop.sa' && u.role === 'staff'));
  check('bad function names refused client-side', !(await BOSS.rpc('drop_everything', {})).ok);

  const staffAuth = makeAuth({ url: mock.url, key: KEY, file: null });
  check('staff signs in with the password the admin set', (await staffAuth.signIn('nargis@shop.sa', 'Nargis-pass-1')).ok);
  const leg2 = tmp('cl-leg2-');
  makeStore(path.join(leg2, 'daftar-altalabiya')).save(rec(3, 'فرع قديم', 'q'));
  const wsS = makeWorkspace({ root: tmp('cl-staff-'), brands: BRANDS, legacyRoot: leg2 });
  const STAFF = makeCloud({ url: mock.url, key: KEY, ws: wsS, brands: BRANDS, auth: staffAuth });
  v = await STAFF.sync();
  check('staff sync ok as staff', v.status === 'ok' && v.access.role === 'staff', JSON.stringify(v));
  check('staff device keeps only its branch', JSON.stringify(wsS.entries().map(e => e.id)) === '["chezzz-1"]', JSON.stringify(wsS.entries().map(e => e.id)));
  check('its data came down', wsS.load('chezzz-1').data.products.length > 0);
  check('the other brand\'s local copy left this computer', !fs.existsSync(path.join(wsS.branchesDir, 'caneles-1')));
  check('nothing from this device was uploaded as a new branch', !mock.rows().has('caneles-1') || mock.rows().get('caneles-1').data.products.length !== 3);
  d = wsS.load('chezzz-1').data; d.days['2026-09-30'] = { date: '2026-09-30', items: { z1: { sold: 7 } } };
  wsS.save('chezzz-1', d, wsS.load('chezzz-1').rev);
  v = await STAFF.sync();
  check('staff edit of its own branch reaches the cloud', mock.rows().get('chezzz-1').data.days['2026-09-30'].items.z1.sold === 7);
  rr = await STAFF.rpc('talabia_admin_users', {});
  check('staff cannot list users', !rr.ok);
  rr = await STAFF.rpc('talabia_admin_set_access', { p_user: 'x', p_role: 'admin', p_branches: [] });
  check('staff cannot promote itself', !rr.ok);

  console.log('--- roles: the admin changes the assignment ---');
  const nid = (await BOSS.rpc('talabia_admin_users', {})).data.find(u => u.email === 'nargis@shop.sa').user_id;
  rr = await BOSS.rpc('talabia_admin_set_access', { p_user: nid, p_role: 'staff', p_branches: ['caneles-1'] });
  v = await STAFF.sync();
  check('reassigned: the new branch arrives', wsS.entries().some(e => e.id === 'caneles-1') && wsS.load('caneles-1').data.products.length > 0);
  check('reassigned: the old branch leaves', !wsS.entries().some(e => e.id === 'chezzz-1'));
  rr = await BOSS.rpc('talabia_admin_set_access', { p_user: nid, p_role: 'staff', p_branches: [] });
  v = await STAFF.sync();
  check('no branches: nothing left on the device', wsS.entries().length === 0);
  const wsS2 = makeWorkspace({ root: wsS.root, brands: BRANDS, legacyRoot: null });
  check('an empty list survives a restart (no re-seeding)', wsS2.entries().length === 0);
  rr = await BOSS.rpc('talabia_admin_remove', { p_user: nid, p_delete_account: true });
  check('admin deletes the account', rr.ok);
  check('deleted account cannot sign in', !(await makeAuth({ url: mock.url, key: KEY, file: null }).signIn('nargis@shop.sa', 'Nargis-pass-1')).ok);
  const bossId = (await BOSS.rpc('talabia_admin_users', {})).data.find(u => u.me).user_id;
  mock.removeMember('owner@shop.sa');
  rr = await BOSS.rpc('talabia_admin_set_access', { p_user: bossId, p_role: 'staff', p_branches: [] });
  check('the last admin cannot demote itself', !rr.ok && /مدير/.test(rr.error), JSON.stringify(rr));

  await mock.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + (e.stack || e)); process.exit(1); });
