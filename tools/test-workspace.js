'use strict';
/*
 * The branch workspace on its own, no Electron: first-run migration from the
 * two stand-alone apps, isolation between branches, delete-to-trash, recovery
 * from a lost workspace.json, and the old-app resync rules.
 *
 *   node tools/test-workspace.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeWorkspace } = require('../workspace');
const { makeStore } = require('../store');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const BRANDS = [
  { key: 'caneles', appName: 'daftar-altalabiya', productName: 'CANELÉS', branch: 'فرع النرجس' },
  { key: 'chezzz', appName: 'daftar-chezzz', productName: 'CHEZZZ', branch: 'فرع تشيززز' }
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-ws-'));
const rec = (n, branch) => ({
  v: 1, cfg: { branch, orderDays: [0, 3] },
  products: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'صنف ' + i, shelfLife: 5 })),
  days: { '2026-09-20': { date: '2026-09-20', items: { p0: { sold: 4 } }, closed: true } },
  stock: {}, events: [], orders: {}
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('--- first run with both old apps present ---');
  const legacy = tmp();
  makeStore(path.join(legacy, 'daftar-altalabiya')).save(rec(16, 'فرع النرجس'));
  makeStore(path.join(legacy, 'daftar-chezzz')).save(rec(18, 'فرع تشيززز'));
  const oldCanBefore = fs.readFileSync(path.join(legacy, 'daftar-altalabiya', 'data', 'daftar.json'), 'utf8');

  const root = tmp();
  let w = makeWorkspace({ root, brands: BRANDS, legacyRoot: legacy });
  let st = w.state();
  check('two branches created', st.ws.branches.length === 2, JSON.stringify(st.ws.branches));
  check('CANELÉS branch keeps its name', st.ws.branches[0].name === 'فرع النرجس' && st.ws.branches[0].brand === 'caneles');
  check('CHEZZZ branch keeps its name', st.ws.branches[1].name === 'فرع تشيززز' && st.ws.branches[1].brand === 'chezzz');
  check('both records reported as moved in', st.migrated.length === 2);
  check('CANELÉS items carried over (16)', w.load('caneles-1').data.products.length === 16);
  check('CHEZZZ items carried over (18)', w.load('chezzz-1').data.products.length === 18);
  check('history carried over', Object.keys(w.load('caneles-1').data.days).length === 1);
  check('old file left untouched', fs.readFileSync(path.join(legacy, 'daftar-altalabiya', 'data', 'daftar.json'), 'utf8') === oldCanBefore);
  check('record stamped with its branch', w.load('chezzz-1').data.meta.branchId === 'chezzz-1' && w.load('chezzz-1').data.meta.brand === 'chezzz');
  check('workspace.json written', fs.existsSync(path.join(root, 'workspace.json')));

  console.log('--- a second start does not migrate again ---');
  makeStore(path.join(legacy, 'daftar-altalabiya')).save(rec(3, 'x'));
  // pretend the old file predates the copy so the resync rule stays quiet here
  const oldF = path.join(legacy, 'daftar-altalabiya', 'data', 'daftar.json');
  const past = new Date(Date.now() - 3600e3); fs.utimesSync(oldF, past, past);
  w = makeWorkspace({ root, brands: BRANDS, legacyRoot: legacy });
  st = w.state();
  check('no re-migration on second start', st.migrated.length === 0 && w.load('caneles-1').data.products.length === 16);

  console.log('--- branches are independent ---');
  const add = w.add({ brand: 'caneles', name: 'فرع الملقا', data: { products: rec(2).products, cfg: { orderDays: [2, 3] } } });
  check('new branch added', add.ok && /^caneles-/.test(add.id), JSON.stringify(add));
  const r1 = w.load(add.id);
  check('new branch has its own items', r1.data.products.length === 2);
  check('new branch starts with no history', Object.keys(r1.data.days).length === 0);
  check('new branch name written into its cfg', r1.data.cfg.branch === 'فرع الملقا');
  const d = r1.data; d.days['2026-09-28'] = { date: '2026-09-28', items: { p0: { sold: 9 } } };
  const sv = w.save(add.id, d);
  check('save succeeds and bumps the revision', sv.ok && sv.rev === 2, JSON.stringify(sv));
  check('other branch of the same brand unchanged', Object.keys(w.load('caneles-1').data.days).length === 1);
  check('other brand unchanged', w.load('chezzz-1').data.products.length === 18);
  check('separate folders on disk', w.fileOf(add.id) !== w.fileOf('caneles-1') && fs.existsSync(w.fileOf(add.id)));
  check('unknown brand refused', !w.add({ brand: 'nope', name: 'x' }).ok);
  check('empty name refused', !w.add({ brand: 'chezzz', name: '  ' }).ok);
  check('path-like id refused on load', !w.load('../caneles-1').ok);
  check('saving to an unknown branch refused', !w.save('ghost-1', rec(1)).ok);
  check('non-record refused', !w.save(add.id, { hello: 1 }).ok);

  console.log('--- rename and current ---');
  w.rename(add.id, '  فرع   الملقا الجديد ');
  check('rename trims and collapses spaces', w.state().ws.branches.find(b => b.id === add.id).name === 'فرع الملقا الجديد');
  w.setCurrent(add.id);
  check('current branch remembered across starts', makeWorkspace({ root, brands: BRANDS }).state().ws.current === add.id);

  console.log('--- stats ---');
  const stats = w.stats().stats;
  check('stats count items and days', stats['caneles-1'].products === 16 && stats[add.id].days === 1, JSON.stringify(stats));

  console.log('--- delete moves to trash ---');
  const rm = w.remove(add.id);
  check('branch removed from the list', rm.ok && !rm.ws.branches.some(b => b.id === add.id));
  check('its folder moved into trash, not erased', rm.movedTo && fs.existsSync(path.join(rm.movedTo, 'daftar.json')));
  check('current falls back to the same brand', rm.ws.current === 'caneles-1', rm.ws.current);
  w.remove('chezzz-1');
  check('last branch cannot be removed', !w.remove('caneles-1').ok);

  console.log('--- lost workspace.json is rebuilt from the folders ---');
  const root2 = tmp();
  let w2 = makeWorkspace({ root: root2, brands: BRANDS, legacyRoot: legacy });
  const a2 = w2.add({ brand: 'chezzz', name: 'فرع العليا', data: { products: rec(5).products } });
  fs.unlinkSync(path.join(root2, 'workspace.json'));
  fs.unlinkSync(path.join(root2, 'workspace.bak.json'));
  w2 = makeWorkspace({ root: root2, brands: BRANDS, legacyRoot: legacy });
  st = w2.state();
  check('rebuilt, not re-seeded', st.rebuilt === true && st.migrated.length === 0);
  check('rebuilt branch keeps name and brand', st.ws.branches.some(b => b.id === a2.id && b.name === 'فرع العليا' && b.brand === 'chezzz'));
  check('rebuilt branch keeps its items', w2.load(a2.id).data.products.length === 5);

  console.log('--- fresh install, no old apps ---');
  const w3 = makeWorkspace({ root: tmp(), brands: BRANDS, legacyRoot: null });
  st = w3.state();
  check('one empty branch per brand', st.ws.branches.length === 2 && st.migrated.length === 0);
  check('no file until something is saved', w3.load('caneles-1').data === null);

  console.log('--- the old app saves after the move ---');
  const leg4 = tmp(), root4 = tmp();
  makeStore(path.join(leg4, 'daftar-altalabiya')).save(rec(4, 'فرع النرجس'));
  let w4 = makeWorkspace({ root: root4, brands: [BRANDS[0]], legacyRoot: leg4 });
  await sleep(2600);
  makeStore(path.join(leg4, 'daftar-altalabiya')).save(rec(6, 'فرع النرجس'));
  w4 = makeWorkspace({ root: root4, brands: [BRANDS[0]], legacyRoot: leg4 });
  st = w4.state();
  check('untouched branch takes the newer old-app record', st.resynced.includes('caneles-1') && w4.load('caneles-1').data.products.length === 6, JSON.stringify(st.resynced));

  const d4 = w4.load('caneles-1').data; d4.products.push({ id: 'z', name: 'z' }); w4.save('caneles-1', d4);
  await sleep(1100);
  makeStore(path.join(leg4, 'daftar-altalabiya')).save(rec(8, 'فرع النرجس'));
  w4 = makeWorkspace({ root: root4, brands: [BRANDS[0]], legacyRoot: leg4 });
  st = w4.state();
  check('both changed: reported, not overwritten', st.legacyNewer.length === 1 && w4.load('caneles-1').data.products.length === 7, JSON.stringify(st.legacyNewer));
  w4.legacyDismiss('caneles-1');
  check('dismiss stops the report', w4.state().legacyNewer.length === 0);
  await sleep(1100);
  makeStore(path.join(leg4, 'daftar-altalabiya')).save(rec(9, 'فرع النرجس'));
  const ad = w4.legacyAdopt('caneles-1');
  check('adopting takes the old app record', ad.ok && w4.load('caneles-1').data.products.length === 9);
  check('adopting keeps the branch name', w4.load('caneles-1').data.cfg.branch === 'فرع النرجس');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + (e.stack || e)); process.exit(1); });
