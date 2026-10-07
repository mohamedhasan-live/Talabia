'use strict';
/*
 * P0-1 — the import record («imports») travels with the branch: a device uploads it, another downloads it,
 * and sync works on a project that has NOT run supabase-coverage.sql. With that file run, a role without
 * «entry.import» cannot change the record; without it, the server does not stop such a change (stated, not hidden).
 *
 *   node tools/test-coverage-sync.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeWorkspace } = require('../workspace');
const { makeCloud } = require('../cloud');
const { startMock } = require('./mock-supabase');
const { makeAuth } = require('../auth');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const BRANDS = [{ key: 'caneles', appName: 'daftar-altalabiya', productName: 'CANELÉS', branch: 'فرع النرجس' }];
const KEY = 'test-anon-key';
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const COVER = { id: 'i1', at: '2026-10-01T10:00:00.000Z', by: 'owner', file: 'pos.xlsx', title: 'تقرير طلبات نقطة البيع: كانوليه النرجس',
  from: '2026-09-21', to: '2026-09-21', complete: true, reason: '', mode: 'replace', rows: 2, qty: 7, zeros: 1 };
const record = () => ({ v: 1, cfg: { branch: 'فرع النرجس' }, products: [{ id: 'a', name: 'أ' }, { id: 'b', name: 'ب' }],
  days: { '2026-09-21': { date: '2026-09-21', items: { a: { sold: 7 }, b: { sold: 0 } } } }, stock: {}, events: [], orders: {}, imports: [COVER] });

async function signed(url, email, pw) { const a = makeAuth({ url, key: KEY, file: null }); const r = await a.signIn(email, pw); if (!r.ok) throw new Error('sign in failed'); return a; }

async function run(withImportsGuard) {
  console.log('\n--- ' + (withImportsGuard ? 'with' : 'WITHOUT') + ' supabase-coverage.sql ---');
  const mock = await startMock({ key: KEY, withImportsGuard });
  mock.addUser('owner@shop.sa', 'correct-horse');
  mock.addUser('staff@shop.sa', 'staff-pass-1', true, 'user', ['caneles-1']);
  mock.member('staff@shop.sa').roleId = 'staff';                    // daily close only: no «entry.import»
  const owner = await signed(mock.url, 'owner@shop.sa', 'correct-horse');

  const wsA = makeWorkspace({ root: tmp('cv-a-'), brands: BRANDS });
  wsA.save('caneles-1', record(), wsA.load('caneles-1').rev);
  const A = makeCloud({ url: mock.url + '/rest/v1/', key: KEY, ws: wsA, brands: BRANDS, onUpdate: () => {}, auth: owner });
  let v = await A.sync();
  check('sync ok', v.status === 'ok', JSON.stringify(v));
  const row = mock.rows().get('caneles-1');
  check('the cloud row carries the import record', row && Array.isArray(row.data.imports) && row.data.imports[0].id === 'i1', row && JSON.stringify(row.data.imports));
  check('…and the confirmed zero (sold:0) as recorded', row && row.data.days['2026-09-21'].items.b.sold === 0);

  const wsB = makeWorkspace({ root: tmp('cv-b-'), brands: BRANDS });
  const B = makeCloud({ url: mock.url + '/rest/v1/', key: KEY, ws: wsB, brands: BRANDS, onUpdate: () => {}, auth: await signed(mock.url, 'owner@shop.sa', 'correct-horse') });
  v = await B.sync();
  const got = wsB.load('caneles-1');
  check('a second device downloads the import record', got && got.data && Array.isArray(got.data.imports) && got.data.imports.length === 1 && got.data.imports[0].complete === true, got && JSON.stringify(got.data && got.data.imports));

  // a role without «entry.import» changes the record directly against the server
  const staff = await signed(mock.url, 'staff@shop.sa', 'staff-pass-1');
  const tok = await staff.token();
  const data = JSON.parse(JSON.stringify(row.data)); data.imports[0].complete = false;
  const res = await fetch(mock.url + '/rest/v1/daftar_branches?id=eq.caneles-1', { method: 'PATCH',
    headers: { apikey: KEY, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ data, rev: (row.rev || 1) + 1 }) });
  if (withImportsGuard) check('with the SQL: a role without «entry.import» cannot change the import record', res.status === 403, res.status);
  else check('without the SQL: the server does not stop that change (the record is unprotected server-side)', res.status === 200, res.status);
  await mock.close();
}

(async () => {
  await run(false);
  await run(true);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
