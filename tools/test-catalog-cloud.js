'use strict';
/*
 * The brands' catalogues (materials, links, offers, recipes) between devices and the cloud, against the
 * stand-in for Supabase with the policies of supabase-recipes.sql:
 *   - before the script is run: the catalogue stays on the computer, the branches sync as always
 *   - first upload, a second device receiving it, an edit travelling, both sides changing
 *   - who reads: only accounts that see a branch of that brand (CHEZZZ staff never see CANELÉS recipes)
 *   - who writes: the owner, or a role with «items.edit» / «recipes.edit»; anyone else is refused by the
 *     database and gets the cloud's copy back, never a silent overwrite
 *
 *   node tools/test-catalog-cloud.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeWorkspace } = require('../workspace');
const { makeCloud } = require('../cloud');
const { makeCatalogs } = require('../catalog');
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
const rec = (n, b, p) => ({ v: 1, cfg: { branch: b }, products: Array.from({ length: n }, (_, i) => ({ id: p + i, name: 'صنف ' + i })), days: {}, stock: {}, events: [], orders: {} });
const CAT = (tag) => ({ v: 1, items: [{ id: 'm1', name: 'صوص ' + tag, unit: 'جم', active: true }], links: {}, bundles: {},
  recipes: { 'n:سينابون كبير': { active: true, lines: [{ item: 'm1', qty: 40, unit: 'جم' }] } }, branches: {} });

(async () => {
  const mock = await startMock({ key: KEY, withCatalog: false });
  mock.addUser('owner@shop.sa', 'owner-pass-1');
  const signed = async (email, pw) => { const a = makeAuth({ url: mock.url, key: KEY, file: null }); const r = await a.signIn(email, pw); if (!r.ok) throw new Error('sign in failed: ' + email); return a; };
  const leg = tmp('cc-leg-');
  makeStore(path.join(leg, 'daftar-altalabiya')).save(rec(3, 'فرع النرجس', 'c'));
  makeStore(path.join(leg, 'daftar-chezzz')).save(rec(3, 'فرع تشيززز', 'z'));
  const device = (legacy) => {
    const root = tmp('cc-dev-');
    const ws = makeWorkspace({ root, brands: BRANDS, legacyRoot: legacy || null });
    const catalogs = makeCatalogs({ root, brands: BRANDS });
    return { root, ws, catalogs };
  };

  console.log('--- before supabase-recipes.sql is run ---');
  const A = device(leg);
  const authA = await signed('owner@shop.sa', 'owner-pass-1');
  const cloudA = makeCloud({ url: mock.url, key: KEY, ws: A.ws, brands: BRANDS, auth: authA, catalogs: A.catalogs });
  check('a catalogue saves on the computer', A.catalogs.save('caneles', CAT('A'), 0).ok);
  let v = await cloudA.sync();
  check('the branches still sync', v.status === 'ok' && mock.rows().size === 2, JSON.stringify(v));
  check('the catalogue is reported as needing the script', v.catalog === 'setup', v.catalog);
  check('and stays on this computer', A.catalogs.load('caneles').data.items[0].name === 'صوص A');

  console.log('\n--- after the script ---');
  mock.createCatalogTable();
  v = await cloudA.sync();
  check('the catalogue goes up', v.catalog === 'ok' && mock.catalogs().has('caneles'), v.catalog);
  check('only the brand that has one', !mock.catalogs().has('chezzz'));
  check('the cloud row carries the recipe', mock.catalogs().get('caneles').data.recipes['n:سينابون كبير'].lines[0].qty === 40);
  check('agreed revision recorded', A.catalogs.entries().find(e => e.brand === 'caneles').cloudRev === 1);

  console.log('\n--- a second device ---');
  const B = device(null);
  const authB = await signed('owner@shop.sa', 'owner-pass-1');
  let updates = [];
  const cloudB = makeCloud({ url: mock.url, key: KEY, ws: B.ws, brands: BRANDS, auth: authB, catalogs: B.catalogs, onUpdate: u => updates.push(u) });
  await cloudB.sync();
  check('B receives the catalogue', (B.catalogs.load('caneles').data || {}).items && B.catalogs.load('caneles').data.items[0].name === 'صوص A');
  check('the page is told which brand changed', updates.some(u => u.changed.includes('catalog:caneles')), JSON.stringify(updates.map(u => u.changed)));

  console.log('\n--- an edit travels ---');
  let d = B.catalogs.load('caneles').data; d.recipes['n:سينابون كبير'].lines[0].qty = 45;
  check('B saves on top of what it read', B.catalogs.save('caneles', d, B.catalogs.load('caneles').rev).ok);
  check('a stale save is refused', B.catalogs.save('caneles', d, 0).stale === true);
  await cloudB.sync(); await cloudA.sync();
  check('A has the edit', A.catalogs.load('caneles').data.recipes['n:سينابون كبير'].lines[0].qty === 45);

  console.log('\n--- both changed ---');
  d = A.catalogs.load('caneles').data; d.items[0].name = 'صوص A2'; A.catalogs.save('caneles', d, A.catalogs.load('caneles').rev);
  d = B.catalogs.load('caneles').data; d.items[0].name = 'صوص B2'; B.catalogs.save('caneles', d, B.catalogs.load('caneles').rev);
  await cloudB.sync();
  const toldA = [];
  const cloudA2 = makeCloud({ url: mock.url, key: KEY, ws: A.ws, brands: BRANDS, auth: authA, catalogs: A.catalogs, onUpdate: u => toldA.push(u) });
  await cloudA2.sync();
  check('the cloud copy wins on the late device', A.catalogs.load('caneles').data.items[0].name === 'صوص B2');
  check('the page is told it was a clash', toldA.some(u => u.catalogNote === 'conflict'), JSON.stringify(toldA.map(u => u.catalogNote)));
  const aside = fs.readdirSync(path.join(A.root, 'brands')).filter(f => /^caneles-local-.*\.json$/.test(f));
  check('and this computer\'s copy is kept aside, not lost', aside.length === 1 &&
    JSON.parse(fs.readFileSync(path.join(A.root, 'brands', aside[0]), 'utf8')).data.items[0].name === 'صوص A2', aside.join(','));

  console.log('\n--- who reads, who writes ---');
  // a CHEZZZ account: it must never see CANELÉS recipes
  mock.addUser('chz@shop.sa', 'staff-pass-1', true, 'staff', ['chezzz-1']);
  const C = device(null);
  const cloudC = makeCloud({ url: mock.url, key: KEY, ws: C.ws, brands: BRANDS, auth: await signed('chz@shop.sa', 'staff-pass-1'), catalogs: C.catalogs });
  await cloudC.sync();
  check('a CHEZZZ account does not receive CANELÉS recipes', !C.catalogs.load('caneles').data);
  // a CANELÉS account without «items.edit»: reads, cannot write
  mock.addUser('can@shop.sa', 'staff-pass-2', true, 'staff', ['caneles-1']);
  mock.member('can@shop.sa').roleId = 'staff';
  const D = device(null);
  const cloudD = makeCloud({ url: mock.url, key: KEY, ws: D.ws, brands: BRANDS, auth: await signed('can@shop.sa', 'staff-pass-2'), catalogs: D.catalogs });
  await cloudD.sync();
  check('a CANELÉS account reads its brand\'s recipes', (D.catalogs.load('caneles').data || {}).items && D.catalogs.load('caneles').data.items[0].name === 'صوص B2');
  d = D.catalogs.load('caneles').data; d.items[0].name = 'تلاعب'; D.catalogs.save('caneles', d, D.catalogs.load('caneles').rev);
  await cloudD.sync();
  check('an account without the permission cannot change the cloud', mock.catalogs().get('caneles').data.items[0].name === 'صوص B2');
  check('and gets the cloud copy back', D.catalogs.load('caneles').data.items[0].name === 'صوص B2');
  // the same account with «items.edit» in its role
  mock.member('can@shop.sa').roleId = 'manager';
  d = D.catalogs.load('caneles').data; d.items[0].name = 'صوص المدير'; D.catalogs.save('caneles', d, D.catalogs.load('caneles').rev);
  await cloudD.sync();
  check('a role with «items.edit» can change it', mock.catalogs().get('caneles').data.items[0].name === 'صوص المدير');
  // nobody can move a catalogue to another brand
  d = D.catalogs.load('caneles').data;
  check('a catalogue never changes brand (the file always carries its own)', D.catalogs.save('caneles', Object.assign({}, d, { brand: 'chezzz' }), D.catalogs.load('caneles').rev).ok &&
    D.catalogs.load('caneles').data.brand === 'caneles');
  check('an unknown brand is refused', D.catalogs.save('other', d, 0).ok === false);

  await mock.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
