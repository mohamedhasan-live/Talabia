'use strict';
/*
 * Build the ONE app that holds every brand and branch.
 *
 *   node tools/build-unified.js [--no-package] [--no-install]
 *
 * Source   src/daftar.html        the page (artifact form, no doctype)
 * Brands   brands/*.json          colours, mark, default branch name, and the
 *                                 old stand-alone app's data folder to move in
 * Shell    app.json               program name, exe name, icon
 *
 * Writes app/index.html, brand.js and brands.js, packages dist/Daftar.exe,
 * installs it to %LOCALAPPDATA%\Programs\Daftar and puts one shortcut on the
 * Desktop in place of the two old ones. The old executables are left where
 * they are; their data folders are never touched.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const noPackage = process.argv.includes('--no-package');
const noInstall = process.argv.includes('--no-install');
const APP = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const SRC = path.join(ROOT, 'src', 'daftar.html');

/* ---------- brands ---------- */
const keys = fs.readdirSync(path.join(ROOT, 'brands')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
keys.sort((a, b) => {
  const ia = APP.brandOrder.indexOf(a), ib = APP.brandOrder.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});
const BRANDS = keys.map(k => JSON.parse(fs.readFileSync(path.join(ROOT, 'brands', k + '.json'), 'utf8')));
console.log('brands -> ' + BRANDS.map(b => b.productName).join(', '));

/* ---------- 1. the page ---------- */
let raw = fs.readFileSync(SRC, 'utf8');
function tokenBlock(vars, indent) {
  return Object.keys(vars).map(k => indent + '--' + k + ':' + vars[k] + ';').join('\n');
}
// one stylesheet request carrying every family any brand's mark uses
const families = new Set();
BRANDS.forEach(b => {
  const m = /family=([^&]+(?:&family=[^&]+)*)/.exec(b.fontsHref || '');
  if (m) m[1].split('&family=').forEach(f => families.add(f));
});
// the fonts ship inside the app (tools/vendor-fonts.js), so they look the same with no internet
const LOCAL_FONTS = fs.existsSync(path.join(ROOT, 'app', 'vendor', 'fonts', 'fonts.css'));
const fontsHref = LOCAL_FONTS ? 'vendor/fonts/fonts.css'
  : 'https://fonts.googleapis.com/css2?' + [...families].map(f => 'family=' + f).join('&') + '&display=swap';
const first = BRANDS[0];
const pageBrands = BRANDS.map(b => ({
  key: b.key, wordmark: b.wordmark, branch: b.branch, defaultTheme: b.defaultTheme || null,
  mark: b.mark, light: b.light, dark: b.dark, icon: b.icon
}));
const brandBlock = [
  '<!--BRAND-->',
  '<!-- ' + BRANDS.map(b => b.productName).join(' + ') + ' — one app, a branch list per brand.',
  '     The tokens below are the first brand\'s; the page swaps them for the open branch\'s brand. -->',
  '<link rel="stylesheet" href="' + fontsHref + '">',
  '<style id="brandTokens">',
  ':root{',
  tokenBlock(first.light, '  '),
  '  --mark-font:' + first.mark.font + ';',
  '  --mark-style:' + first.mark.style + '; --mark-weight:' + first.mark.weight +
    '; --mark-size:' + first.mark.size + '; --mark-spacing:' + first.mark.spacing + ';',
  '}',
  '@media (prefers-color-scheme: dark){',
  '  :root:not([data-theme="light"]){',
  tokenBlock(first.dark, '    '),
  '  }',
  '}',
  ':root[data-theme="dark"]{',
  tokenBlock(first.dark, '  '),
  '}',
  '</style>',
  '<script>window.BRANDS=' + JSON.stringify(pageBrands) + ';',
  'window.APP_NAME=' + JSON.stringify(APP.title) + ';',
  'window.APP_EXT=' + JSON.stringify(APP.productName) + ';',
  // the English dictionary (src/i18n-en.json): the page reads it only when the shop chooses English
  'window.I18N_EN=' + JSON.stringify(fs.existsSync(path.join(ROOT, 'src', 'i18n-en.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n-en.json'), 'utf8')) : {}).replace(/<\//g, '<\\/') + ';',
  'window.SECURITY_SQL=' + JSON.stringify(fs.readFileSync(path.join(ROOT, 'supabase-security.sql'), 'utf8')).replace(/<\//g, '<\\/') + ';',
  'window.BRAND=' + JSON.stringify({ key: first.key, wordmark: first.wordmark, title: APP.title,
    branch: first.branch, defaultTheme: first.defaultTheme || null }) + ';</script>',
  '<!--/BRAND-->'
].join('\n');
const bStart = raw.indexOf('<!--BRAND-->'), bEnd = raw.indexOf('<!--/BRAND-->');
if (bStart < 0 || bEnd < 0) { console.error('the source has no <!--BRAND--> block'); process.exit(1); }
raw = raw.slice(0, bStart) + brandBlock + raw.slice(bEnd + '<!--/BRAND-->'.length);

const split = raw.indexOf('<div class="app"');
if (split < 0) { console.error('could not find the page body marker'); process.exit(1); }
const RESET = `
:root{color-scheme:light}
*{-webkit-tap-highlight-color:transparent}
html,body{margin:0}
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fbfbfa}
img{max-width:100%}
[hidden]{display:none!important}
::selection{background:rgba(67,112,46,.22)}
`;
const doc = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${RESET}</style>
${raw.slice(0, split).trim()}
</head>
<body>
${raw.slice(split).trim()}
</body>
</html>
`;
/*
 * Content Security Policy. Only the page's own inline scripts run (each pinned
 * by its hash), plus the bundled spreadsheet reader; nothing the page could be
 * tricked into writing into itself — an onerror= attribute, a <script> from a
 * record, a remote script — is executed. The page never talks to the network
 * itself (the cloud goes through the main process), so connect-src is 'none'.
 */
const crypto = require('crypto');
const hashes = [...doc.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => "'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
const CSP = [
  "default-src 'none'",
  "script-src " + hashes.join(' ') + " 'self' file:",
  "style-src 'self' file: 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' file: https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');
const docCsp = doc.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + CSP + '">');
fs.mkdirSync(path.join(ROOT, 'app'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'app', 'index.html'), docCsp, 'utf8');
console.log('csp    -> ' + hashes.length + ' inline scripts pinned');
console.log('page   -> app/index.html (' + Math.round(Buffer.byteLength(doc) / 1024) + ' KB)');

/* ---------- 2. identity modules for the main process ---------- */
fs.writeFileSync(path.join(ROOT, 'brand.js'),
  '// generated by tools/build-unified.js — do not edit\n\'use strict\';\nmodule.exports = ' + JSON.stringify({
    key: APP.key, appName: APP.appName, productName: APP.productName,
    title: APP.title, wordmark: APP.wordmark, windowBg: APP.windowBg
  }, null, 2) + ';\n', 'utf8');
fs.writeFileSync(path.join(ROOT, 'brands.js'),
  '// generated by tools/build-unified.js — do not edit\n\'use strict\';\n' +
  '// appName is the OLD stand-alone app\'s data folder, moved in on first run.\n' +
  'module.exports = ' + JSON.stringify(BRANDS.map(b => ({
    key: b.key, appName: b.appName, productName: b.productName, wordmark: b.wordmark, branch: b.branch
  })), null, 2) + ';\n', 'utf8');
console.log('main   -> brand.js, brands.js');

/* ---------- 3. icon: an order sheet, one bar in each brand's colour ---------- */
const ICON = path.join(ROOT, 'build', 'icon-' + APP.key + '.ico');
(function drawIcon() {
  const SIZE = 256, px = Buffer.alloc(SIZE * SIZE * 4);
  function put(x, y, c, a) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4, na = a / 255, ia = 1 - na;
    px[i] = Math.round(c[0] * na + px[i] * ia); px[i + 1] = Math.round(c[1] * na + px[i + 1] * ia);
    px[i + 2] = Math.round(c[2] * na + px[i + 2] * ia); px[i + 3] = Math.min(255, px[i + 3] + a);
  }
  function roundRect(x0, y0, w, h, r, col) {
    for (let y = Math.floor(y0) - 1; y < y0 + h + 1; y++) for (let x = Math.floor(x0) - 1; x < x0 + w + 1; x++) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x0 + w - r), cy = Math.min(Math.max(y + 0.5, y0 + r), y0 + h - r);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = d <= r - 0.5 ? 1 : d >= r + 0.5 ? 0 : (r + 0.5 - d);
      if (a > 0) put(x, y, col, Math.round(255 * a));
    }
  }
  roundRect(8, 8, 240, 240, 52, APP.icon.bg);
  roundRect(62, 80, 132, 20, 10, APP.icon.bars[0]);
  roundRect(62, 124, 104, 20, 10, APP.icon.bars[1]);
  roundRect(62, 168, 68, 20, 10, APP.icon.bars[2]);
  function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); } return (crc ^ 0xFFFFFFFF) >>> 0; }
  function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) px.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  const dir = Buffer.alloc(6); dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  const ent = Buffer.alloc(16); ent.writeUInt16LE(1, 4); ent.writeUInt16LE(32, 6); ent.writeUInt32LE(png.length, 8); ent.writeUInt32LE(22, 12);
  fs.mkdirSync(path.dirname(ICON), { recursive: true });
  fs.writeFileSync(ICON, Buffer.concat([dir, ent, png]));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon-' + APP.key + '.png'), png);
})();
console.log('icon   -> build/icon-' + APP.key + '.ico');

// The spreadsheet reader ships with the app so an Odoo .xlsx imports with no internet.
const XLSX_FILE = path.join(ROOT, 'app', 'vendor', 'xlsx.js');
const XLSX_PKG = path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');
if ((!fs.existsSync(XLSX_FILE) || fs.statSync(XLSX_FILE).size < 300000) && fs.existsSync(XLSX_PKG)) {
  fs.mkdirSync(path.dirname(XLSX_FILE), { recursive: true });
  fs.copyFileSync(XLSX_PKG, XLSX_FILE);
  console.log('xlsx   -> app/vendor/xlsx.js (from node_modules/xlsx)');
}
if (!fs.existsSync(XLSX_FILE) || fs.statSync(XLSX_FILE).size < 300000) {
  console.error('app/vendor/xlsx.js is missing — run "npm install" so node_modules/xlsx exists, then build again');
  process.exit(1);
}

if (noPackage) { console.log('(assets only)'); process.exit(0); }

/* ---------- 4. package: a real Windows installer ---------- */
/*
 * NSIS, per user (no admin prompt): the owner picks the folder, gets a Desktop
 * and Start-menu shortcut, and an entry in "Apps & features" to uninstall.
 * Uninstalling never touches %APPDATA%\daftar, where the branches live.
 */
const env = Object.assign({}, process.env, {
  ELECTRON_BUILDER_CACHE: path.join(ROOT, '.cache'),
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
});
const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
if (!fs.existsSync(cli)) { console.error('electron-builder not found at ' + cli); process.exit(1); }
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const setupName = 'Talabia-Setup-' + PKG.version + '.exe';
const setup = path.join(ROOT, 'dist', setupName);
try { if (fs.existsSync(setup)) fs.unlinkSync(setup); } catch (e) { /* the builder will say so */ }
const r = spawnSync(process.execPath, [
  cli, '--win', 'nsis', '--x64',
  '-c.productName=' + APP.productName,
  '-c.win.icon=build/icon-' + APP.key + '.ico',
  '-c.nsis.installerIcon=build/icon-' + APP.key + '.ico',
  '-c.nsis.uninstallerIcon=build/icon-' + APP.key + '.ico',
  '-c.nsis.artifactName=' + setupName,
  '-c.extraMetadata.description=' + APP.productName,
  '-c.extraMetadata.name=' + APP.appName
], { cwd: ROOT, env, encoding: 'utf8' });
const log = (r.stdout || '') + (r.stderr || '');
if (r.error) { console.error('spawn failed: ' + r.error.message); process.exit(1); }
if (r.status !== 0 || !fs.existsSync(setup)) {
  console.error('electron-builder exited ' + r.status);
  console.error(log.split('\n').filter(Boolean).slice(-25).join('\n'));
  process.exit(1);
}
console.log('setup  -> dist/' + setupName + '  (' + (fs.statSync(setup).size / 1048576).toFixed(1) + ' MB)');
// a copy where it is easy to find and hand to another computer
const shelf = path.join(ROOT, 'installer');
fs.mkdirSync(shelf, { recursive: true });
for (const f of fs.readdirSync(shelf)) if (/^Talabia-Setup-.*\.exe$/.test(f) && f !== setupName) { try { fs.unlinkSync(path.join(shelf, f)); } catch (e) {} }
fs.copyFileSync(setup, path.join(shelf, setupName));
console.log('copy   -> installer\\' + setupName);

if (noInstall || process.platform !== 'win32') process.exit(0);

/* ---------- 5. install it here, silently, from that same installer ---------- */
const DESKTOP = (() => {
  const od = path.join(os.homedir(), 'OneDrive', 'Desktop');
  return fs.existsSync(od) ? od : path.join(os.homedir(), 'Desktop');
})();
// shortcuts from the portable builds; the installer makes its own
const oldNames = (APP.oldShortcuts || []).concat(BRANDS.map(b => (b.desktopName || b.exeName || '').replace(/\.exe$/i, '')));
for (const n of oldNames.concat([APP.shortcutName])) {
  const lnk = path.join(DESKTOP, n + '.lnk');
  if (n && fs.existsSync(lnk)) { try { fs.unlinkSync(lnk); console.log('  old shortcut removed: ' + n + '.lnk'); } catch (e) {} }
}
const inst = spawnSync(setup, ['/S'], { encoding: 'utf8', timeout: 300000 });
if (inst.status !== 0) {
  console.error('INSTALL FAILED (exit ' + inst.status + '). If Talabia is open, close it and run build.cmd again.');
  console.error('The installer is ready: installer\\' + setupName);
  process.exit(3);
}
const installed = path.join(process.env.LOCALAPPDATA, 'Programs', APP.appName, APP.productName + '.exe');
const alt = path.join(process.env.LOCALAPPDATA, 'Programs', APP.productName, APP.productName + '.exe');
const where = fs.existsSync(installed) ? installed : fs.existsSync(alt) ? alt : null;
console.log('install-> ' + (where || 'done (installer ran)'));
const lnkNow = fs.readdirSync(DESKTOP).filter(f => /talabia/i.test(f));
console.log('desktop-> ' + (lnkNow.join(', ') || '(no shortcut found — check the Start menu)'));
console.log('data   -> %APPDATA%\\' + APP.appName + '\\branches\\<branch>\\daftar.json');
