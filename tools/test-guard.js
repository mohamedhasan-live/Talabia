'use strict';
/*
 * The server-side permission check (private.talabia_edit_violation in
 * supabase-roles.sql; the same steps in mock-supabase.js editViolation):
 * every change to a branch record must be allowed by the role, and the
 * defaults the app fills in on load must never count as an edit.
 *
 *   node tools/test-guard.js
 */
const { editViolation } = require('./mock-supabase');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  <- ' + detail : '')); }
}
const clone = o => JSON.parse(JSON.stringify(o));
const perms = (...k) => Object.fromEntries(k.map(x => [x, true]));

// a record as the owner's device wrote it: sparse, the way the page leaves things
const base = {
  v: 1, savedAt: '2026-10-01T10:00:00Z', meta: { branchId: 'caneles-1', rev: 4 },
  cfg: { branch: 'فرع النرجس', orderDays: [0, 3], leadDays: 1, deliveryHour: 19, dayCfg: {}, tendency: 50 },
  products: [
    { id: 'p1', name: 'كيك', shelfLife: 5 },                          // no unit, packSize, moq, active
    { id: 'p2', name: 'صوص', unit: 'كجم', shelfLife: 7, packSize: 1, moq: 0, active: true, aliases: ['sauce'] }
  ],
  days: { '2026-09-30': { date: '2026-09-30', items: { p1: { sold: 4 } }, closed: true } },
  stock: { p1: [] },
  events: [{ id: 'e1', name: 'رمضان', kind: 'ramadan', from: '2027-02-01', to: '2027-03-01', mult: 1.3 }],
  orders: {}
};
// the same record after the staff device loaded it: every default filled in
const loaded = clone(base);
loaded.cfg = Object.assign({ trackWaste: true, trackStockout: true, trackPacking: false, trackStock: false, showShelfInClose: false, afterShare: null, horizonBuffer: 0.95 }, loaded.cfg);
loaded.products[0] = Object.assign({ unit: 'حبة', packSize: 1, moq: 0, active: true, aliases: [] }, loaded.products[0]);
loaded.days['2026-09-30'].items.p1 = { sold: 4, waste: 0, lost: 0, stockout: false };
loaded.days['2026-10-01'] = { date: '2026-10-01', items: { p2: { sold: 0, waste: 0, lost: 0, stockout: false } }, closed: false };
loaded.stock = {};
loaded.savedAt = '2026-10-01T11:00:00Z'; loaded.meta.rev = 5;

console.log('--- defaults are not edits ---');
check('a loaded-and-saved record with nothing changed passes a role with no permissions', editViolation(base, loaded, {}) === null, editViolation(base, loaded, {}));
check('and the other way round', editViolation(loaded, base, {}) === null);
check('bookkeeping fields (savedAt, meta) are not edits', editViolation(base, Object.assign(clone(base), { savedAt: 'x', meta: { rev: 99 } }), {}) === null);
check('the branch name in cfg is not a role edit (the row name is guarded separately)', editViolation(base, (() => { const r = clone(base); r.cfg.branch = 'آخر'; return r; })(), {}) === null);
check('order of order-days does not matter', editViolation(base, (() => { const r = clone(base); r.cfg.orderDays = [3, 0]; return r; })(), {}) === null);
check('a number saved as text is the same number', editViolation(base, (() => { const r = clone(base); r.products[0].shelfLife = '5'; return r; })(), {}) === null);

console.log('--- the day close ---');
const sale = clone(loaded); sale.days['2026-10-01'].items.p2.sold = 3;
check('recording a sale needs entry.record', editViolation(loaded, sale, {}) === 'تسجيل المبيعات');
check('allowed with entry.record', editViolation(loaded, sale, perms('entry.record')) === null);
check('allowed by an Odoo import', editViolation(loaded, sale, perms('entry.import')) === null);
const closing = clone(loaded); closing.days['2026-09-30'].closed = false;
check('opening a closed day needs entry.close', editViolation(loaded, closing, perms('entry.record')) === 'إقفال اليوم أو فتحه');
check('allowed with entry.close', editViolation(loaded, closing, perms('entry.close')) === null);
const wiped = clone(loaded); delete wiped.days['2026-09-30'];
check('erasing a day of sales is refused without entry.record', editViolation(loaded, wiped, perms('entry.close')) !== null);

console.log('--- items ---');
const added = clone(loaded); added.products.push({ id: 'p3', name: 'جديد', shelfLife: 5 });
check('adding an item needs items.add', editViolation(loaded, added, perms('items.edit')) === 'إضافة صنف');
check('allowed with items.add', editViolation(loaded, added, perms('items.add')) === null);
check('an import may create items', editViolation(loaded, added, perms('entry.import')) === null);
const removed = clone(loaded); removed.products.splice(0, 1);
check('deleting an item needs items.delete', editViolation(loaded, removed, perms('items.edit', 'items.add')) === 'حذف صنف');
check('allowed with items.delete', editViolation(loaded, removed, perms('items.delete')) === null);
const renamed = clone(loaded); renamed.products[1].shelfLife = 10;
check('changing shelf life needs items.edit', editViolation(loaded, renamed, perms('entry.import')) === 'تعديل صنف');
check('allowed with items.edit', editViolation(loaded, renamed, perms('items.edit')) === null);
const aliased = clone(loaded); aliased.products[1].aliases = ['sauce', 'SAUCE 1KG'];
check('an import may learn a new alias', editViolation(loaded, aliased, perms('entry.import')) === null);
check('but not without import or edit', editViolation(loaded, aliased, perms('entry.record')) === 'تعديل الأسماء البديلة لصنف');

console.log('--- the order screen ---');
const counted = clone(loaded); counted.stock.p1 = [{ qty: 6, expiry: '2026-10-05' }];
check('the shelf count needs order.stock', editViolation(loaded, counted, perms('order.save')) === 'الجرد');
check('allowed with order.stock', editViolation(loaded, counted, perms('order.stock')) === null);
const ordered = clone(loaded); ordered.orders['2026-10-04'] = { date: '2026-10-04', items: { p1: { suggested: 8, ordered: 10 } }, status: 'placed' };
check('confirming an order needs order.save', editViolation(loaded, ordered, perms('order.adjust', 'order.stock')) === 'اعتماد الطلبية');
check('allowed with order.save', editViolation(loaded, ordered, perms('order.save')) === null);

console.log('--- settings ---');
const days = clone(loaded); days.cfg.orderDays = [0, 2, 3];
check('order days need setup.schedule', editViolation(loaded, days, perms('setup.tracking')) === 'جدول الطلب');
check('allowed with setup.schedule', editViolation(loaded, days, perms('setup.schedule')) === null);
const hour = clone(loaded); hour.cfg.dayCfg = { 3: { hour: 17 } };
check('a per-day delivery hour needs setup.schedule', editViolation(loaded, hour, {}) === 'جدول الطلب');
const track = clone(loaded); track.cfg.trackWaste = false;
check('the waste column needs setup.tracking', editViolation(loaded, track, perms('setup.schedule')) === 'ما يُسجَّل يومياً');
check('allowed with setup.tracking', editViolation(loaded, track, perms('setup.tracking')) === null);
const tend = clone(loaded); tend.cfg.tendency = 70;
check('the tendency needs setup.tendency', editViolation(loaded, tend, {}) === 'ميل النظام');
check('allowed with setup.tendency', editViolation(loaded, tend, perms('setup.tendency')) === null);
const ev = clone(loaded); ev.events[0].mult = 1.6;
check('an occasion needs setup.events', editViolation(loaded, ev, {}) === 'المناسبات');
check('allowed with setup.events', editViolation(loaded, ev, perms('setup.events')) === null);

console.log('--- restore ---');
const everything = clone(loaded); everything.products = []; everything.days = {}; everything.cfg.tendency = 0;
check('a restore (data.import) may replace the whole record', editViolation(loaded, everything, perms('data.import')) === null);
check('without it the same change is refused', editViolation(loaded, everything, perms('entry.record', 'items.edit')) !== null);
check('several changes: refused if any one is outside the role', editViolation(loaded, Object.assign(clone(sale), { orders: ordered.orders }), perms('entry.record')) === 'اعتماد الطلبية');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
