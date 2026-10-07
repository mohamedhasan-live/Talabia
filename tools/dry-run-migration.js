'use strict';
/*
 * What would the first start move in? Reads the two old apps' real records
 * (read-only) into a throwaway folder and prints what it found. Touches
 * neither the old files nor the new app's own folder.
 *
 *   node tools/dry-run-migration.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeWorkspace } = require('../workspace');
const BRANDS = require('../brands');

const legacyRoot = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-dry-'));
const before = {};
BRANDS.forEach(b => {
  const f = path.join(legacyRoot, b.appName, 'data', 'daftar.json');
  before[b.key] = fs.existsSync(f) ? fs.statSync(f).mtimeMs : null;
});
const ws = makeWorkspace({ root, brands: BRANDS, legacyRoot });
const st = ws.state();
console.log('old data folder: ' + legacyRoot);
st.ws.branches.forEach(b => {
  const r = ws.load(b.id);
  const d = r.data;
  console.log('  ' + b.brand.padEnd(8) + ' ' + b.id.padEnd(10) + ' ' + b.name + '  ->  ' +
    (d ? d.products.length + ' items, ' + Object.keys(d.days || {}).length + ' days' : 'no old record (starts empty)'));
});
let untouched = true;
BRANDS.forEach(b => {
  const f = path.join(legacyRoot, b.appName, 'data', 'daftar.json');
  const now = fs.existsSync(f) ? fs.statSync(f).mtimeMs : null;
  if (now !== before[b.key]) untouched = false;
});
console.log('old files untouched: ' + (untouched ? 'YES' : 'NO'));
fs.rmSync(root, { recursive: true, force: true });
process.exit(untouched ? 0 : 1);
