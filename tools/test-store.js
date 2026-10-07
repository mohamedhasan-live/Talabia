'use strict';
/* Plain-node checks on the storage layer — no Electron needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeStore } = require('../store');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-test-'));
const store = makeStore(base);

console.log('storage tests in ' + base + '\n');

// 1. nothing saved yet
let r = store.load();
check('empty folder loads cleanly', r.ok === true && r.data === null, JSON.stringify(r));

// 2. a real day of trading round-trips
const day1 = {
  v: 1,
  cfg: { branch: 'فرع الرياض', orderDays: [0, 3], leadDays: 1, deliveryHour: 19, dayCfg: { '3': { lead: 1, hour: 19 } } },
  products: [{ id: 'p01', name: 'كيكة الشوكولاتة', unit: 'حبة', shelfLife: 5, packSize: 6, moq: 0, active: true },
             { id: 'p02', name: 'صوص السينابون', unit: 'كجم', shelfLife: 20, packSize: 1, moq: 0, active: true }],
  days: { '2026-09-22': { date: '2026-09-22', items: { p01: { sold: 31, waste: 2, stockout: false } }, closed: true } },
  stock: { p01: [{ qty: 14, expiry: '2026-09-26' }] },
  events: [{ id: 'e1', name: 'اليوم الوطني السعودي', kind: 'national', from: '2026-09-21', to: '2026-09-24', mult: 1.45 }],
  orders: {}
};
r = store.save(day1);
check('save reports success', r.ok === true, JSON.stringify(r));
check('file exists on disk', fs.existsSync(store.file));

r = store.load();
check('sales figure survives', r.data && r.data.days['2026-09-22'].items.p01.sold === 31);
check('waste figure survives', r.data && r.data.days['2026-09-22'].items.p01.waste === 2);
check('day stays closed', r.data && r.data.days['2026-09-22'].closed === true);
check('arabic text intact', r.data && r.data.products[0].name === 'كيكة الشوكولاتة');
check('units survive the round trip', r.data && r.data.products[0].unit === 'حبة' && r.data.products[1].unit === 'كجم');
check('per-day schedule intact', r.data && r.data.cfg.dayCfg['3'].hour === 19);
check('event intact', r.data && r.data.events[0].mult === 1.45);

// 3. a second day is added without losing the first
const day2 = JSON.parse(JSON.stringify(day1));
day2.days['2026-09-23'] = { date: '2026-09-23', items: { p01: { sold: 44, waste: 0, stockout: true } }, closed: true };
store.save(day2);
r = store.load();
check('both days present after second save', r.data && Object.keys(r.data.days).length === 2);
check('first day unchanged', r.data && r.data.days['2026-09-22'].items.p01.sold === 31);
check('stockout flag survives', r.data && r.data.days['2026-09-23'].items.p01.stockout === true);
check('previous generation kept as .bak', fs.existsSync(store.bak));

// 4. corrupt the live file: the backup must carry the shop through
fs.writeFileSync(store.file, '{ this is not json', 'utf8');
r = store.load();
check('recovers from a damaged file', r.ok === true && r.data !== null && r.recovered === true, JSON.stringify(r).slice(0, 120));
check('recovered copy still has day one', r.data && r.data.days['2026-09-22'].items.p01.sold === 31);

// 5. no .tmp left behind after a healthy write
store.save(day2);
check('no leftover .tmp file', !fs.existsSync(store.file + '.tmp'));

// 6. a year of trading stays fast and whole
const big = JSON.parse(JSON.stringify(day1));
big.days = {};
for (let i = 0; i < 365; i++) {
  const d = new Date(2026, 0, 1 + i);
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const items = {};
  for (let p = 1; p <= 14; p++) items['p' + String(p).padStart(2, '0')] = { sold: 10 + (i + p) % 40, waste: (i + p) % 5, stockout: (i + p) % 17 === 0 };
  big.days[key] = { date: key, items, closed: true };
}
const t0 = Date.now();
r = store.save(big);
const writeMs = Date.now() - t0;
const t1 = Date.now();
const back = store.load();
const readMs = Date.now() - t1;
check('a full year saves', r.ok === true, JSON.stringify(r));
check('a full year loads back whole', back.data && Object.keys(back.data.days).length === 365);
check('a random mid-year day is exact', back.data && back.data.days['2026-06-15'].items.p07.sold === big.days['2026-06-15'].items.p07.sold);
check('stays fast (write ' + writeMs + 'ms, read ' + readMs + 'ms)', writeMs < 1500 && readMs < 1500);
console.log('  ....  a year of records weighs ' + Math.round(r.bytes / 1024) + ' KB');

// 7. export writes a readable copy
const out = path.join(base, 'backup.json');
r = store.exportTo(out, big);
check('export writes a file', r.ok === true && fs.existsSync(out));
check('exported file parses', JSON.parse(fs.readFileSync(out, 'utf8')).days['2026-06-15'] != null);

fs.rmSync(base, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
