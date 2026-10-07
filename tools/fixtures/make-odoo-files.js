'use strict';
/*
 * A stand-in Odoo CSV export. Product names deliberately do NOT match the app's
 * spelling — ta-marbuta vs ha, alef maqsura, different dash and spacing — which
 * is exactly what a real export looks like beside a hand-typed catalogue.
 * (The .xlsx case is built and read inside the app itself, where the real
 * spreadsheet reader lives.)
 */
const fs = require('fs');
const path = require('path');

const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = (back) => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate() - back); };

const LINES = [
  'كيكة الشوكولاته - قطعة',       // p01, ta-marbuta and dash differ
  'تشيز كيك توت — قطعة',          // p02, exact
  'كيكة الفستق الحلبى — قطعة',    // p03, alef maqsura
  'براونيز - قطعة',               // p09
  'كوكيز بالشوكولاتة — قطعة',     // p10
  'ميلك شيك فراولة'               // not in the catalogue at all
];

const rows = [['Order Reference', 'Date', 'Product', 'Quantity', 'Unit Price']];
[2, 1].forEach((back, di) => {
  LINES.forEach((name, i) => {
    rows.push(['SO' + (1000 + di * 10 + i), ymd(day(back)), name, String(12 + i * 3 + di * 2), '22.00']);
  });
  // one product twice in a day, as a split order: the import must sum them
  rows.push(['SO' + (1099 + di), ymd(day(back)), LINES[0], '5', '22.00']);
  // the junk rows Odoo leaves behind: a bare Total, and the Arabic totals line
  // that carries a REAL quantity — the one that used to become a product
  rows.push(['', '', 'Total', '', '']);
  rows.push(['', '', 'الإجمالي:', '145', '']);
});

const csv = '﻿' + rows.map(r => r.map(c => /[",]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\r\n');
fs.writeFileSync(path.join(__dirname, 'odoo-sales.csv'), csv, 'utf8');

const meta = { days: [ymd(day(2)), ymd(day(1))], names: LINES };
fs.writeFileSync(path.join(__dirname, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
console.log('csv  -> tools/fixtures/odoo-sales.csv  (' + (rows.length - 1) + ' rows, days ' + meta.days.join(' + ') + ')');
