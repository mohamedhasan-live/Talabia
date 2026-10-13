'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, session, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { makeWorkspace } = require('./workspace');
const { makeCloud } = require('./cloud');
const { makeAuth } = require('./auth');
const { makeCatalogs } = require('./catalog');
const { makeAi } = require('./ai');
const AnthropicSdk = require('@anthropic-ai/sdk');
const BRAND = require('./brand');
const BRANDS = require('./brands');

/*
 * One program for every brand and branch. Each branch keeps its own record in
 * its own folder under the workspace (see workspace.js); the brand decides the
 * colours and the mark the page wears while that branch is open.
 */
app.setName(BRAND.appName);
// Numbers are written 0-9 everywhere. On an Arabic Windows the page's own
// number and date fields would otherwise inherit Arabic-Indic digits (٦٧,
// ٠٤/١٠/٢٠٢٦) from the system locale; en-GB keeps day/month order. The page's
// text stays Arabic and right-to-left — this only changes the browser locale.
app.commandLine.appendSwitch('lang', 'en-GB');
// An explicit --user-data-dir always wins, so a test run can never be pointed
// at a real shop's records by accident.
const pinned = !process.argv.some(a => a.startsWith('--user-data-dir'));
if (pinned) app.setPath('userData', path.join(app.getPath('appData'), BRAND.appName));
// The two stand-alone apps' records are moved in on first run. A test run
// never reads the real ones unless it names a folder of its own on purpose.
const legacyRoot = pinned ? app.getPath('appData') : (process.env.DAFTAR_LEGACY_ROOT || null);
/*
 * The shop's own brands (added from «البراند والفروع») and the parent company's name live in company.json in the
 * data folder. Each added brand wears the look of a built-in one (its colours and wordmark style) under its own
 * name, and joins the brand list here, before the branches, the catalogues and the cloud read it.
 */
const companyFile = path.join(app.getPath('userData'), 'company.json');
const BRAND_KEY = /^[a-z][a-z0-9]{1,23}$/;
const companyCfg = (() => {
  const c = readJson(companyFile) || {};
  return { company: typeof c.company === 'string' && c.company.trim() ? c.company.trim().slice(0, 80) : 'Cake Village',
           brands: Array.isArray(c.brands) ? c.brands.filter(b => b && BRAND_KEY.test(String(b.key))) : [],
           paused: Array.isArray(c.paused) ? c.paused.filter(k => BRAND_KEY.test(String(k))) : [],
           deleted: Array.isArray(c.deleted) ? c.deleted.filter(b => b && BRAND_KEY.test(String(b.key))).slice(0, 50) : [] };
})();
function saveCompany() {
  const tmp = companyFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(companyCfg, null, 1));
  fs.renameSync(tmp, companyFile);
}
function fullBrand(c) {
  const base = BRANDS.find(b => b.key === c.look && !b.custom) || BRANDS.find(b => !b.custom) || BRANDS[0];
  const copy = JSON.parse(JSON.stringify(base));
  return Object.assign(copy, { key: c.key, wordmark: c.wordmark, productName: c.wordmark, branch: c.branch || c.wordmark,
    appName: null, custom: true, look: base.key });
}
companyCfg.brands.forEach(c => { if (!BRANDS.some(b => b.key === c.key)) BRANDS.push(fullBrand(c)); });
const ws = makeWorkspace({ root: app.getPath('userData'), brands: BRANDS, legacyRoot });
// each brand's materials, offers and recipes (catalog.js), beside the branches
const catalogs = makeCatalogs({ root: app.getPath('userData'), brands: BRANDS });
(function firstBranches() {
  let changed = false;
  companyCfg.brands.forEach(c => {
    if (!c.firstBranch) return;
    try {
      const has = ws.entries().some(b => b.brand === c.key);
      if (!has) ws.add({ brand: c.key, name: c.firstBranch });
    } catch (e) { /* tried again next start */ return; }
    delete c.firstBranch; changed = true;
  });
  // a brand put back from «المحذوفات»: its branches come back from the trash folder now that the brand exists again
  companyCfg.brands.forEach(c => {
    if (!Array.isArray(c.restoreBranches)) return;
    c.restoreBranches.forEach(id => { try { ws.restore(id); } catch (e) { /* left in the trash */ } });
    delete c.restoreBranches; changed = true;
  });
  if (changed) try { saveCompany(); } catch (e) {}
})();

/*
 * Cloud settings: cloud.json beside the program (built in), overridden by a
 * cloud.json in the data folder. A test run only talks to a cloud it names
 * itself (DAFTAR_CLOUD_URL), never to the shop's real project.
 */
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
const userCloudFile = path.join(app.getPath('userData'), 'cloud.json');
let cloudCfg = null;
if (pinned) cloudCfg = readJson(userCloudFile) || readJson(path.join(__dirname, 'cloud.json'));
else if (process.env.DAFTAR_CLOUD_URL) cloudCfg = { mode: 'cloud', url: process.env.DAFTAR_CLOUD_URL, anonKey: process.env.DAFTAR_CLOUD_KEY, pollSeconds: 5 };
cloudCfg = Object.assign({ mode: 'cloud', url: '', anonKey: '', pollSeconds: 60 }, cloudCfg || {});

/*
 * Only a real Supabase project address is accepted in the shipped app, so a
 * changed setting can never send a password or the shop's records to some
 * other server. (A test run names its own local stand-in.)
 */
const normUrl = u => String(u || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const urlAllowed = u => pinned ? /^https:\/\/[a-z0-9-]{10,40}\.supabase\.co$/.test(u) : /^https?:\/\//.test(u);
const sessionFile = path.join(app.getPath('userData'), 'cloud-session.bin');

/*
 * Every call to Supabase goes through Chromium's network stack (net.fetch), the
 * same one a browser uses: it follows the Windows proxy settings and trusts the
 * Windows certificate store, as ExpiryTrack does. Node's own fetch ignores both,
 * so behind a proxy or a filtering network it fails with a bare "fetch failed".
 * The underlying cause is kept in the message so a failure says what went wrong.
 */
async function netFetch(url, opts) {
  try { return await net.fetch(url, opts); }
  catch (e) {
    const c = e && e.cause;
    const why = (c && (c.code || c.message)) || (e && e.message) || String(e);
    const err = new Error(/abort|timeout/i.test(String(why)) ? 'انتهت مهلة الاتّصال بالخادم' : 'تعذّر الوصول إلى الخادم (' + why + ')');
    err.cause = e;
    throw err;
  }
}

function buildAuth() {
  return makeAuth({ url: cloudCfg.url, key: cloudCfg.anonKey, file: sessionFile, safeStorage, fetchImpl: netFetch });
}
let auth = buildAuth();
// the activity log waits here while offline, so closing the app loses nothing
const logFile = path.join(app.getPath('userData'), 'activity-queue.json');
const logStore = {
  load: () => { const q = readJson(logFile); return Array.isArray(q) ? q : []; },
  save: (q) => { try { fs.writeFileSync(logFile, JSON.stringify(q), 'utf8'); } catch (e) { /* best effort */ } }
};
function buildCloud() {
  const on = cloudCfg.mode !== 'local' && urlAllowed(normUrl(cloudCfg.url));
  return makeCloud({
    url: on ? cloudCfg.url : '', key: on ? cloudCfg.anonKey : '', ws, brands: BRANDS, auth, fetchImpl: netFetch, logStore, catalogs,
    onUpdate: (u) => { if (win && !win.isDestroyed()) win.webContents.send('cloud:update', u); }
  });
}
let cloud = buildCloud();
const maskKey = k => k ? k.slice(0, 6) + '…' + k.slice(-4) : '';
function cloudSettings() {
  return { mode: cloudCfg.mode, url: cloudCfg.url || '', hasKey: !!cloudCfg.anonKey, keyHint: maskKey(cloudCfg.anonKey), auth: auth.state() };
}
/** Try a project without adopting it: reachable, key accepted, tables present. */
async function testCloud(url, key) {
  const base = normUrl(url);
  if (!urlAllowed(base)) return { ok: false, reason: 'url' };
  if (!key) return { ok: false, reason: 'key' };
  // A key given in the form is only tried against its own project; the saved
  // session belongs to the saved project and is used only there.
  const same = base === normUrl(cloudCfg.url);
  const tok = same ? await auth.token() : null;
  try {
    const res = await netFetch(base + '/rest/v1/daftar_branches?select=id,deleted', { headers: { apikey: key, Authorization: 'Bearer ' + (tok || key) }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (res.status === 404 || /PGRST205|42P01/.test(text)) return { ok: false, reason: 'table' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: tok ? 'auth' : 'signin', error: text.slice(0, 160) };
    if (!res.ok) return { ok: false, reason: 'http', error: 'HTTP ' + res.status };
    if (!tok) return { ok: true, rows: null, signin: true };
    const rows = JSON.parse(text).filter(r => !r.deleted);
    return { ok: true, rows: rows.length };
  } catch (e) { return { ok: false, reason: 'net', error: String(e.message || e) }; }
}

let win = null;

// One Talabia at a time (per profile): pressing «فتح» again brings the open window forward instead of starting a
// second copy that would wait on the first one's files. A test run has its own --user-data-dir, so its own lock.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); if (!win.isVisible()) win.show(); win.focus(); }
    else if (app.isReady()) createWindow();
  });
}

/** A window's opacity from one value to another, eased (ease-out), in about ms milliseconds. */
function fadeWin(w, from, to, ms, done) {
  const t0 = Date.now();
  const step = () => {
    if (!w || w.isDestroyed()) return;
    const k = Math.min(1, (Date.now() - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    w.setOpacity(from + (to - from) * e);
    if (k < 1) setTimeout(step, 12); else if (done) done();
  };
  step();
}

function createWindow() {
  // A test run (its own --user-data-dir) works out of sight: off the screen, not in the taskbar, never taking the
  // focus from what the owner has open, and not throttled for being in the background. DAFTAR_SHOW=1 shows it.
  // The shop's own launch (no --user-data-dir) is untouched.
  const hiddenRun = !pinned && process.env.DAFTAR_SHOW !== '1';
  // The shop's window is laid out at the full size of the screen it opens on, out of sight, so that showing and
  // maximising it changes nothing: no small window that jumps to full size (a white half and a black half).
  let wa = null; try { wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; } catch (e) {}
  win = new BrowserWindow({
    width: !hiddenRun && wa ? wa.width : 1120,
    height: !hiddenRun && wa ? wa.height : 820,
    ...(!hiddenRun && wa ? { x: wa.x, y: wa.y } : {}),
    ...(hiddenRun ? { x: -32000, y: -32000, skipTaskbar: true } : {}),
    minWidth: 380,
    minHeight: 520,
    backgroundColor: BRAND.windowBg,
    show: false,
    title: BRAND.wordmark,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: !hiddenRun
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // Open filling the screen: this is a working sheet, and the extra width goes
  // into the order rows and tables rather than a wider margin.
  // Shown once, when the page has painted its own colours (it says so), or after 4 s at the latest.
  let shown = false;
  const reveal = () => {
    if (shown || !win || win.isDestroyed()) return; shown = true;
    if (hiddenRun) { win.showInactive(); try { win.webContents.send('app:shown'); } catch (e) {} return; }
    // full size while still invisible (opacity 0), a moment for the page to repaint at that size, then a soft fade in —
    // no white frame, no jump from a smaller window
    win.setOpacity(0); win.maximize(); if (!win.isVisible()) win.show();
    setTimeout(() => { if (win && !win.isDestroyed()) fadeWin(win, 0, 1, 340); }, 180);
    try { win.webContents.send('app:shown'); } catch (e) {}
    setTimeout(warmPrint, 2500);          // the print path, made ready in the background once the app is up
  };
  ipcMain.removeAllListeners('app:painted');
  ipcMain.on('app:painted', (e) => { if (win && e.sender === win.webContents) reveal(); });
  win.once('ready-to-show', reveal);
  // Closing the main window closes Talabia entirely: a print preview or a page being laid out never keeps it alive
  // in the background (which would hold its files and make the next «فتح» slow).
  // Closing fades the window out first (≈140 ms), then closes it the normal way, so the page still finishes its
  // saves; if the page keeps the window open, it comes back fully.
  let closing = false;
  win.on('close', (e) => {
    if (closing || hiddenRun || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    e.preventDefault(); closing = true;
    const w = win;
    fadeWin(w, w.getOpacity(), 0, 140, () => { if (w.isDestroyed()) return; w.close(); setTimeout(() => { if (!w.isDestroyed()) { closing = false; w.setOpacity(1); } }, 600); });
  });
  win.on('closed', () => {
    win = null;
    BrowserWindow.getAllWindows().forEach((w) => { try { if (!w.isDestroyed()) w.destroy(); } catch (e) {} });
    if (process.platform !== 'darwin') app.quit();
  });

  // The window only ever shows the app's own page. A link to the web opens in
  // the real browser; anything else (another local file, a custom protocol
  // such as ms-settings:, a script URL) goes nowhere.
  const external = (url) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); external(url); });
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } };

/*
 * Every channel answers the app's own page and nothing else: a call from any
 * other frame or document (an injected iframe, a page navigated to by mistake)
 * is refused before it reaches the handler.
 */
const PAGE = 'file://' + path.join(__dirname, 'app', 'index.html').replace(/\\/g, '/').replace(/^\/?/, '/');
function trusted(e) {
  try {
    if (!win || e.sender !== win.webContents) return false;
    const f = e.senderFrame;
    if (!f || f.parent) return false;
    return decodeURI(f.url.split(/[?#]/)[0]).toLowerCase() === decodeURI(PAGE).toLowerCase();
  } catch (x) { return false; }
}
const _handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (ch, fn) => _handle(ch, (e, ...a) => trusted(e) ? fn(e, ...a) : { ok: false, error: 'refused' });

ipcMain.handle('ws:state', safe(() => Object.assign(ws.state(), { pinned, version: app.getVersion() })));
// the page asks once, as it starts: the shop's own brands (dressed like the built-in ones) and the company's name
ipcMain.on('brands:sync', (e) => {
  e.returnValue = trusted(e) ? { company: companyCfg.company, brands: BRANDS.filter(b => b.custom), paused: companyCfg.paused.slice(),
    deleted: companyCfg.deleted.map(b => ({ key: b.key, wordmark: b.wordmark, at: b.at, branches: (b.branches || []).length })) } : { company: '', brands: [], paused: [], deleted: [] };
});
ipcMain.handle('data:load', safe((_e, id) => Object.assign(ws.load(id), { pinned })));
// the language switch: the same page again (navigation to anything else stays refused)
ipcMain.handle('page:reload', safe(() => { if (win) win.webContents.reload(); return { ok: true }; }));
/*
 * Only an admin account manages branches, storage and users. The database
 * enforces this on its side too; refusing here keeps a regular account's own
 * copy tidy and its screens honest.
 */
// With the cloud off (a purely local app) the owner of this computer is the admin.
const isAdmin = () => { if (!cloud.enabled) return true; const a = ws.access(); return !!(a && a.role === 'admin'); };
const adminOnly = (fn) => (...a) => isAdmin() ? fn(...a) : { ok: false, error: 'هذا الإجراء للمدير فقط' };
// a permission the owner opened for this account's role (as the server said, never the page)
const canDo = (perm) => { if (isAdmin()) return true; const a = ws.access(); return !!(a && a.perms && a.perms[perm] === true); };
const permOnly = (perm, fn) => (...a) => canDo(perm) ? fn(...a) : { ok: false, error: 'ليست لديك صلاحية لهذا الإجراء — راجع المالك' };

// every change is on disk first; the cloud follows a moment later
const andSync = (fn) => (...a) => { const r = fn(...a); if (r && r.ok) cloud.soon(); return r; };
ipcMain.handle('data:save', safe(andSync((_e, data, id, baseRev) => ws.save(id, data, baseRev))));
// a new brand (the owner): its name, the built-in brand whose look it wears, its first branch — applied on restart
ipcMain.handle('brand:add', safe(adminOnly((_e, o) => {
  o = o || {};
  const word = String(o.wordmark || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!word) return { ok: false, error: 'اكتب اسم البراند' };
  if (BRANDS.some(b => String(b.wordmark).toLowerCase() === word.toLowerCase())) return { ok: false, error: 'يوجد براند بهذا الاسم' };
  const look = BRANDS.some(b => b.key === o.look && !b.custom) ? o.look : BRANDS[0].key;
  let key = 'b' + Date.now().toString(36);
  while (BRANDS.some(b => b.key === key || key.startsWith(b.key + '-') || b.key.startsWith(key))) key = 'b' + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
  const first = String(o.branch || '').replace(/\s+/g, ' ').trim().slice(0, 60) || ('فرع ' + word);
  companyCfg.brands.push({ key, wordmark: word, look, branch: first, firstBranch: first, addedAt: new Date().toISOString() });
  saveCompany();
  return { ok: true, key, restart: true };
})));
// delete a brand the shop added (the built-in ones stay): its branches go to the branches' trash folder (as a branch
// delete does, so nothing is lost on disk and other devices hear of it), then the brand leaves company.json
ipcMain.handle('brand:remove', safe(adminOnly(andSync((_e, key) => {
  const c = companyCfg.brands.find(b => b.key === key);
  if (!c) return { ok: false, error: 'هذا البراند من البراندات الأساسية ولا يُحذف' };
  if (BRANDS.filter(b => b.key !== key).length < 1) return { ok: false, error: 'لا يُحذف آخر براند' };
  const mine = ws.entries().filter(b => b.brand === key);
  if (ws.entries().length - mine.length < 1) return { ok: false, error: 'لا يُحذف آخر فرع في التطبيق' };
  const moved = [];
  for (const b of mine) { const r = ws.remove(b.id); if (!r.ok) return { ok: false, error: r.error }; moved.push(r.movedTo); }
  companyCfg.brands = companyCfg.brands.filter(b => b.key !== key);
  companyCfg.paused = companyCfg.paused.filter(k => k !== key);
  // remembered in «المحذوفات», with its branches, so it can be put back
  companyCfg.deleted = [Object.assign({}, c, { at: new Date().toISOString(), branches: mine.map(b => b.id) })].concat(companyCfg.deleted.filter(b => b.key !== key)).slice(0, 50);
  saveCompany();
  return { ok: true, branches: mine.length, moved, restart: true };
}))));
// put a deleted brand back (its branches return on the restart, from the trash folder)
ipcMain.handle('brand:restore', safe(adminOnly((_e, key) => {
  const d = companyCfg.deleted.find(b => b.key === key);
  if (!d) return { ok: false, error: 'لا يوجد في المحذوفات' };
  if (companyCfg.brands.some(b => b.key === key)) return { ok: false, error: 'البراند موجود' };
  const back = Object.assign({}, d, { restoreBranches: d.branches || [] });
  delete back.at; delete back.branches; delete back.firstBranch;
  companyCfg.brands.push(back);
  companyCfg.deleted = companyCfg.deleted.filter(b => b.key !== key);
  saveCompany();
  return { ok: true, restart: true };
})));
// pause a brand (its branches leave the picker; nothing is deleted) or bring it back — built-in brands too
ipcMain.handle('brand:pause', safe(adminOnly((_e, key, on) => {
  if (!BRANDS.some(b => b.key === key)) return { ok: false, error: 'unknown brand' };
  if (on && BRANDS.filter(b => b.key !== key && companyCfg.paused.indexOf(b.key) < 0).length < 1) return { ok: false, error: 'لا يُوقف آخر براند نشط' };
  companyCfg.paused = companyCfg.paused.filter(k => k !== key).concat(on ? [key] : []);
  saveCompany();
  return { ok: true, paused: companyCfg.paused.slice() };
})));
// the parent company's name (shown in «حول التطبيق»)
ipcMain.handle('company:set', safe(adminOnly((_e, name) => {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!n) return { ok: false, error: 'اكتب اسم الشركة' };
  companyCfg.company = n; saveCompany();
  return { ok: true, company: n };
})));
// a restart so a new brand joins everything at once (the page saves first)
ipcMain.handle('app:restart', safe(adminOnly(() => { setTimeout(() => { app.relaunch(); app.exit(0); }, 400); return { ok: true }; })));
// creating and renaming branches: the owner, or an account whose role the owner gave it to
ipcMain.handle('branch:add', safe(permOnly('branches.add', andSync((_e, o) => ws.add(o || {})))));
ipcMain.handle('branch:rename', safe(permOnly('branches.edit', andSync((_e, id, name) => ws.rename(id, name)))));
ipcMain.handle('branch:current', safe((_e, id) => ws.setCurrent(id)));
// a brand's catalogue: any account reads it; the owner or a role with «items.edit» / «recipes.edit» changes it
const canRecipes = () => canDo('items.edit') || canDo('recipes.edit') || (() => { const a = ws.access(); return !!(a && a.perms == null); })();
ipcMain.handle('catalog:load', safe((_e, brand) => catalogs.load(brand)));
ipcMain.handle('catalog:save', safe((_e, brand, data, baseRev) => {
  if (!canRecipes()) return { ok: false, error: 'ليست لديك صلاحية لهذا الإجراء — راجع المالك' };
  const r = catalogs.save(brand, data, baseRev);
  if (r && r.ok) cloud.soon();
  return r;
}));
ipcMain.handle('branch:remove', safe(adminOnly(andSync((_e, id) => ws.remove(id)))));
ipcMain.handle('branch:restore', safe(adminOnly(andSync((_e, id) => ws.restore(id)))));
ipcMain.handle('branch:pause', safe(adminOnly((_e, id, on) => ws.setPaused(id, !!on))));
ipcMain.handle('branch:trash', safe(() => ({ ok: true, list: ws.trashList() })));
const ADMIN_OPS = {
  users: ['talabia_admin_users', () => ({})],
  create: ['talabia_admin_create_user', o => ({ p_email: String(o.email || ''), p_password: String(o.password || ''), p_role: o.role === 'admin' ? 'admin' : 'staff', p_branches: (o.branches || []).filter(ws.validId) })],
  access: ['talabia_admin_set_access', o => ({ p_user: String(o.user || ''), p_role: o.role === 'admin' ? 'admin' : 'staff', p_branches: (o.branches || []).filter(ws.validId) })],
  password: ['talabia_admin_set_password', o => ({ p_user: String(o.user || ''), p_password: String(o.password || '') })],
  remove: ['talabia_admin_remove', o => ({ p_user: String(o.user || ''), p_delete_account: o.deleteAccount === true })],
  // the owner's control panel (supabase-roles.sql)
  createMember: ['talabia_admin_create_member', o => ({ p_email: String(o.email || ''), p_password: String(o.password || ''), p_role_id: o.roleId ? String(o.roleId) : null, p_branches: (o.branches || []).filter(ws.validId), p_name: o.name ? String(o.name).trim().slice(0, 60) || null : null })],
  setMember: ['talabia_admin_set_member', o => ({ p_user: String(o.user || ''), p_role_id: o.roleId ? String(o.roleId) : null, p_branches: (o.branches || []).filter(ws.validId), p_name: o.name ? String(o.name).trim().slice(0, 60) || null : null })],
  setActive: ['talabia_admin_set_active', o => ({ p_user: String(o.user || ''), p_active: o.active !== false })],
  roles: ['talabia_admin_roles', () => ({})],
  saveRole: ['talabia_admin_save_role', o => ({ p_id: o.id ? String(o.id) : null, p_name: String(o.name || ''), p_perms: (o.perms && typeof o.perms === 'object') ? o.perms : {} })],
  deleteRole: ['talabia_admin_delete_role', o => ({ p_id: String(o.id || '') })],
  activity: ['talabia_admin_activity', o => ({ p_limit: Math.min(1000, Math.max(1, +o.limit || 300)), p_email: o.email ? String(o.email) : null })],
  clearActivity: ['talabia_admin_clear_activity', () => ({})]
};
ipcMain.handle('activity:log', (_e, items) => cloud.log(items));
// which control-panel right each call needs when the account is not the owner (the server checks again, and decides)
const ADMIN_PERM = { users: 'usr.view', createMember: 'usr.add', setMember: 'usr.edit', setActive: 'usr.stop', password: 'usr.pass', remove: 'usr.delete',
  roles: ['role.view', 'usr.add', 'usr.edit'], saveRole: ['role.add', 'role.edit'], deleteRole: 'role.delete', activity: 'log.view' };
const UMBRELLA = { usr: 'admin.users', role: 'admin.roles', log: 'admin.log' };     // the earlier all-in-one rights still count
const mayAdmin = (op) => {
  if (isAdmin()) return true;
  const a = ws.access(), need = ADMIN_PERM[op];
  if (!a || !a.perms || !need) return false;
  return [].concat(need).some(p => a.perms[p] === true || a.perms[UMBRELLA[p.split('.')[0]]] === true);
};
ipcMain.handle('admin:call', async (_e, op, o) => {
  if (!mayAdmin(op)) return { ok: false, error: 'هذا الإجراء للمدير فقط' };
  const d = ADMIN_OPS[op];
  if (!d) return { ok: false, error: 'bad op' };
  const r = await cloud.rpc(d[0], d[1](o || {}));
  if (r.ok && !/^(users|roles|activity)$/.test(op)) cloud.soon(500);     // our own access may have changed
  return r;
});
/*
 * The AI explanation layer (ai.js): off until the owner stores a key; reads the page's calculated context only.
 * A test run talks to the stand-in it names (DAFTAR_AI_BASE_URL), never to Anthropic.
 */
const ai = makeAi({ file: path.join(app.getPath('userData'), 'ai-key.bin'), safeStorage, Anthropic: AnthropicSdk.default || AnthropicSdk,
  fetchImpl: (...a) => net.fetch(...a), baseURL: !pinned && process.env.DAFTAR_AI_BASE_URL ? process.env.DAFTAR_AI_BASE_URL : undefined });
ipcMain.handle('ai:state', safe(() => ai.state()));
ipcMain.handle('ai:setKey', safe(adminOnly((_e, key) => ai.setKey(key))));
ipcMain.handle('ai:ask', async (_e, o) => { try { return await ai.ask(o || {}); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } });
ipcMain.handle('cloud:state', () => cloud.view());
ipcMain.handle('cloud:settings', () => cloudSettings());
ipcMain.handle('cloud:test', (_e, o) => testCloud((o && o.url) || cloudCfg.url, (o && o.key) || cloudCfg.anonKey));
ipcMain.handle('auth:signin', async (_e, email, password) => {
  if (cloudCfg.mode === 'local' || !urlAllowed(normUrl(cloudCfg.url))) return { ok: false, reason: 'url' };
  const r = await auth.signIn(email, password);
  if (r.ok) cloud.sync();
  return Object.assign(r, { settings: cloudSettings() });
});
ipcMain.handle('auth:signout', async () => {
  // this account's last actions go up first (a few seconds at most), then the queue is emptied
  try { await Promise.race([cloud.sync(), new Promise(r => setTimeout(r, 6000))]); } catch (e) { /* offline */ }
  cloud.clearLog();
  await auth.signOut();
  ws.setAccess(null);
  cloud.sync();
  return { ok: true, settings: cloudSettings() };
});
ipcMain.handle('cloud:configure', safe(adminOnly((_e, o) => {
  o = o || {};
  const next = Object.assign({}, cloudCfg);
  if (o.mode === 'local' || o.mode === 'cloud') next.mode = o.mode;
  if (typeof o.url === 'string' && o.url.trim()) {
    const u = normUrl(o.url);
    if (!urlAllowed(u)) return { ok: false, error: 'الرابط يجب أن يكون رابط مشروع Supabase (https://….supabase.co)' };
    next.url = u;
  }
  if (typeof o.key === 'string' && o.key.trim()) {
    if (!/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(o.key.trim()) && !/^sb_publishable_/.test(o.key.trim()) && pinned) return { ok: false, error: 'المفتاح لا يشبه مفتاح anon' };
    next.anonKey = o.key.trim();
  }
  const projectChanged = next.url !== cloudCfg.url || next.anonKey !== cloudCfg.anonKey;
  if (pinned) {
    try { fs.mkdirSync(path.dirname(userCloudFile), { recursive: true }); fs.writeFileSync(userCloudFile, JSON.stringify(next, null, 2), 'utf8'); }
    catch (e) { return { ok: false, error: 'could not save the settings: ' + e.message }; }
  }
  cloudCfg = next;
  cloud.stop();
  // a session belongs to one project: moving to another means signing in there
  if (projectChanged) { auth.signOut(); auth = buildAuth(); }
  cloud = buildCloud();
  cloud.start((cloudCfg.pollSeconds || 60) * 1000);
  if (!cloud.enabled && win && !win.isDestroyed()) win.webContents.send('cloud:update', Object.assign(cloud.view(), { changed: [], ws: ws.snapshot() }));
  return { ok: true, settings: cloudSettings() };
})));
ipcMain.handle('cloud:sync', () => cloud.sync());
ipcMain.handle('cloud:resolve', (_e, id, which) => cloud.resolve(id, which === 'cloud' ? 'cloud' : 'local'));
ipcMain.handle('branch:stats', safe(() => ws.stats()));
ipcMain.handle('legacy:adopt', safe((_e, id) => ws.legacyAdopt(id)));
ipcMain.handle('legacy:dismiss', safe((_e, id) => ws.legacyDismiss(id)));

// «اطبع» / «احفظ PDF»: the page sends a finished, self-contained document (no scripts run in it); it is laid out in a
// hidden window and either sent to the system print dialog or written to a PDF the user places.
let PRINT_PAGE = null, PRINT_VIEW = null, PRINT_TMP = null, PRINTING = false;
function printPage() {
  if (PRINT_PAGE && !PRINT_PAGE.isDestroyed()) return PRINT_PAGE;
  PRINT_PAGE = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  return PRINT_PAGE;
}
function previewBounds() {
  const b = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0, width: 1200, height: 900 };
  const W = Math.min(980, Math.max(700, b.width - 120)), H = Math.min(900, Math.max(600, b.height - 80));
  return { width: W, height: H, x: Math.round(b.x + (b.width - W) / 2), y: Math.round(b.y + (b.height - H) / 2) };
}
let PRINT_READY = null;
function printView() {
  if (PRINT_VIEW && !PRINT_VIEW.isDestroyed()) return PRINT_VIEW;
  PRINT_VIEW = new BrowserWindow(Object.assign(previewBounds(), { show: false, paintWhenInitiallyHidden: true, backgroundColor: BRAND.windowBg, title: 'طباعة — Talabia',
    autoHideMenuBar: true, minWidth: 700, minHeight: 520,
    webPreferences: { preload: path.join(__dirname, 'app', 'print-preload.js'), plugins: true, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } }));
  PRINT_VIEW.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  PRINT_VIEW.webContents.on('will-navigate', (e) => e.preventDefault());
  PRINT_READY = PRINT_VIEW.loadFile(path.join(__dirname, 'app', 'print.html'));
  // closing it only hides it (with a fade): it stays ready for the next print (the app's own close destroys it)
  PRINT_VIEW.on('close', (e) => { if (win && !win.isDestroyed()) { e.preventDefault(); hidePrintView(); } });
  return PRINT_VIEW;
}
function hidePrintView() {
  const pv = PRINT_VIEW; if (!pv || pv.isDestroyed() || !pv.isVisible()) return;
  fadeWin(pv, pv.getOpacity(), 0, 200, () => { if (!pv.isDestroyed()) { pv.hide(); pv.setOpacity(1); } });
}
const PAPERS = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid'], MARGINS = ['default', 'none', 'printableArea'];
function cleanRanges(r) {
  if (!Array.isArray(r) || !r.length || r.length > 50) return null;
  const out = r.map((x) => ({ from: Math.max(0, Math.round(+x.from)), to: Math.max(0, Math.round(+x.to)) })).filter((x) => isFinite(x.from) && isFinite(x.to) && x.to >= x.from);
  return out.length ? out : null;
}
/** One print job in a fresh hidden page; never waited on, so the next print always answers. */
async function printJob(html, opts) {
  const job = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await job.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const direct = typeof opts.deviceName === 'string' && opts.deviceName && !opts.system;
  const po = { silent: !!direct, printBackground: opts.printBackground !== false, landscape: !!opts.landscape, copies: Math.max(1, Math.min(99, Math.round(+opts.copies || 1))) };
  if (direct) po.deviceName = opts.deviceName;
  if (PAPERS.indexOf(opts.pageSize) >= 0) po.pageSize = opts.pageSize;
  if (opts.color === false) po.color = false;
  if (MARGINS.indexOf(opts.marginType) >= 0) po.margins = { marginType: opts.marginType };
  if (+opts.scale > 0 && +opts.scale !== 100) po.scaleFactor = Math.max(10, Math.min(200, Math.round(+opts.scale)));
  if (['simplex', 'shortEdge', 'longEdge'].indexOf(opts.duplexMode) >= 0) po.duplexMode = opts.duplexMode;
  if ([1, 2, 4, 6, 9, 16].indexOf(+opts.pagesPerSheet) >= 0 && +opts.pagesPerSheet > 1) po.pagesPerSheet = +opts.pagesPerSheet;
  if (typeof opts.collate === 'boolean') po.collate = opts.collate;
  const pr = cleanRanges(opts.pageRanges); if (pr) po.pageRanges = pr;
  const bye = () => { if (!job.isDestroyed()) job.destroy(); };
  const guard = setTimeout(bye, 10 * 60 * 1000);
  try { job.webContents.print(po, () => { clearTimeout(guard); setTimeout(bye, 1500); }); }
  catch (e) { clearTimeout(guard); bye(); return { ok: false, error: String(e.message || e) }; }
  return { ok: true, printed: true, dialog: !direct };
}
// The print window's own channels answer only the print window's own page (the app page's channels stay as they are).
const PRINT_PAGE_URL = 'file://' + path.join(__dirname, 'app', 'print.html').replace(/\\/g, '/').replace(/^\/?/, '/');
function printTrusted(e) {
  try {
    if (!PRINT_VIEW || PRINT_VIEW.isDestroyed() || e.sender !== PRINT_VIEW.webContents) return false;
    const f = e.senderFrame; if (!f || f.parent) return false;
    return decodeURI(f.url.split(/[?#]/)[0]).toLowerCase() === decodeURI(PRINT_PAGE_URL).toLowerCase();
  } catch (x) { return false; }
}
_handle('printwin:printers', async (e) => {
  if (!printTrusted(e)) return { ok: false, list: [], error: 'refused' };
  try {
    const list = await e.sender.getPrintersAsync();
    return { ok: true, list: list.map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: !!p.isDefault })) };
  } catch (err) { return { ok: false, list: [], error: String(err.message || err) }; }
});
let PREVIEW_FILES = [];
_handle('printwin:render', async (e, html, opts) => {
  if (!printTrusted(e)) return { ok: false, error: 'refused' };
  if (typeof html !== 'string' || html.length > 2000000) return { ok: false, error: 'bad document' };
  opts = opts && typeof opts === 'object' ? opts : {};
  try {
    const pg = printPage();
    await pg.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const po = { printBackground: opts.printBackground !== false, landscape: !!opts.landscape, pageSize: PAPERS.indexOf(opts.pageSize) >= 0 ? opts.pageSize : 'A4' };
    if (MARGINS.indexOf(opts.marginType) >= 0) po.margins = { marginType: opts.marginType };
    if (+opts.scale > 0) po.scale = Math.max(0.1, Math.min(2, +opts.scale / 100));
    const pr = cleanRanges(opts.pageRanges); if (pr) po.pageRanges = pr.map((x) => (x.from + 1) + '-' + (x.to + 1)).join(',');
    let buf;
    try { buf = await pg.webContents.printToPDF(po); }
    catch (err) { if (po.pageRanges) { return { ok: false, error: 'الصفحات خارج الورقة' }; } throw err; }
    const file = path.join(app.getPath('temp'), 'talabia-preview-' + Date.now() + '.pdf');
    fs.writeFileSync(file, buf);
    PREVIEW_FILES.push(file);
    while (PREVIEW_FILES.length > 3) { try { fs.unlinkSync(PREVIEW_FILES.shift()); } catch (x) {} }
    return { ok: true, url: require('url').pathToFileURL(file).href };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
// «إعدادات أكثر»: the sheet opened in Microsoft Edge, whose print window shows a full preview with every Windows
// setting. A temporary page (the sheet + one line that opens the print window) — nothing of the app goes with it.
_handle('printwin:system', async (e, html, opts) => {
  if (!printTrusted(e)) return { ok: false, error: 'refused' };
  if (typeof html !== 'string' || html.length > 2000000) return { ok: false, error: 'bad document' };
  opts = opts && typeof opts === 'object' ? opts : {};
  try {
    let page = html;
    if (opts.landscape) page = page.replace('</style>', '@page{size:landscape}</style>');
    page = page.replace('</body>', '<script>addEventListener("load",function(){setTimeout(function(){window.print()},350)})</script></body>');
    const file = path.join(app.getPath('temp'), 'talabia-print-' + Date.now() + '.html');
    fs.writeFileSync(file, page, 'utf8');
    setTimeout(() => { try { fs.unlinkSync(file); } catch (x) {} }, 30 * 60 * 1000);
    const url = require('url').pathToFileURL(file).href;
    const edges = [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                   path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')];
    const edge = edges.filter((p) => { try { return fs.existsSync(p); } catch (x) { return false; } })[0];
    if (edge) { require('child_process').spawn(edge, ['--new-window', url], { detached: true, stdio: 'ignore' }).unref(); return { ok: true, edge: true }; }
    await shell.openExternal(url);           // no Edge: the default browser, same page
    return { ok: true, edge: false };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
// «إضافة طابعة»: Windows' own printers page (the print window refreshes its list when it comes back into focus)
_handle('printwin:addPrinter', async (e) => {
  if (!printTrusted(e)) return { ok: false, error: 'refused' };
  try { await shell.openExternal('ms-settings:printers'); return { ok: true }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
_handle('print:now', async (e, html, opts) => {
  if (!printTrusted(e)) return { ok: false, error: 'refused' };
  if (typeof html !== 'string' || html.length > 2000000) return { ok: false, error: 'bad document' };
  try { return await printJob(html, opts && typeof opts === 'object' ? opts : {}); } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.on('print:close', (e) => { if (printTrusted(e)) hidePrintView(); });
async function layoutPdf(html) {
  const pg = printPage();
  await pg.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return pg.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
}
/** In the background, once: the layout page and the preview window (with its PDF viewer) loaded and hidden. */
async function warmPrint() {
  try {
    if (!win || win.isDestroyed()) return;
    await layoutPdf('<!doctype html><html dir="rtl"><body style="font-family:Segoe UI,Tahoma"> </body></html>');
    printView(); await PRINT_READY;            // the print window, its page loaded and hidden — the first «طباعة» opens at once
  } catch (e) { /* warming is a courtesy: printing still works without it */ }
}
// «طباعة» / «حفظ»: the page sends a finished, self-contained document (no scripts run in it). It is laid out in the
// hidden page; «حفظ» writes the PDF where the user chooses, «طباعة» shows it in the ready preview window to print from.
ipcMain.handle('print:printers', async () => {
  try {
    const wc = (win && !win.isDestroyed() ? win : printPage()).webContents;
    const list = await wc.getPrintersAsync();
    return { ok: true, list: list.map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: !!p.isDefault })) };
  } catch (e) { return { ok: false, list: [], error: String(e.message || e) }; }
});
ipcMain.handle('doc:out', async (_e, html, how, name, opts) => {
  opts = opts && typeof opts === 'object' ? opts : {};
  if (typeof html !== 'string' || html.length > 2000000) return { ok: false, error: 'bad document' };
  try {
    if (how === 'pdf') {
      const safeName = String(name || 'Talabia').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
      const res = process.env.DAFTAR_TEST_PDF_FILE ? { canceled: false, filePath: process.env.DAFTAR_TEST_PDF_FILE }
        : await dialog.showSaveDialog(win, { title: 'حفظ PDF', defaultPath: path.join(app.getPath('documents'), safeName + '.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
      const buf = await layoutPdf(html);
      fs.writeFileSync(res.filePath, buf);
      if (!process.env.DAFTAR_TEST_PDF_FILE) shell.showItemInFolder(res.filePath);
      return { ok: true, path: res.filePath };
    }
    if (process.env.DAFTAR_TEST_PDF_FILE) { const buf = await layoutPdf(html); return { ok: true, printed: true, bytes: buf.length, preview: !opts.deviceName && !opts.system }; }
    // «طباعة»: the sheet in its own preview window (ready in the background), shown with a calm fade; the user prints
    // from it. Closing it only hides it, so the next «طباعة» opens it again at once — as often as wanted.
    if (!opts.deviceName && !opts.system) {
      const pv = printView(); await PRINT_READY;
      if (!pv.isVisible()) { pv.setBounds(previewBounds()); pv.setOpacity(0); }
      pv.webContents.send('print:doc', { html, title: String(name || '').replace(/-/g, ' '), lang: opts.lang === 'en' ? 'en' : 'ar' });
      if (!pv.isVisible()) { pv.show(); fadeWin(pv, 0, 1, 300); }
      pv.focus();
      return { ok: true, preview: true };
    }
    return await printJob(html, opts);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('data:export', async (_e, data, hint) => {
  if (!canDo('data.export')) return { ok: false, error: 'ليست لديك صلاحية تصدير نسخة' };
  const stamp = new Date().toISOString().slice(0, 10);
  const tag = /^[a-z0-9-]{1,48}$/.test(hint || '') ? hint + '-' : '';
  // tools/test-backup.js names the file instead of clicking the system dialog
  const res = process.env.DAFTAR_TEST_BACKUP_FILE ? { canceled: false, filePath: process.env.DAFTAR_TEST_BACKUP_FILE }
    : await dialog.showSaveDialog(win, {
    title: 'حفظ نسخة احتياطية',
    defaultPath: path.join(app.getPath('documents'), `daftar-${tag}${stamp}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Electron has no window.prompt, so restoring a backup goes through a real
// file picker rather than a pasted blob of text.
ipcMain.handle('data:import', async () => {
  if (!canDo('data.import')) return { ok: false, error: 'ليست لديك صلاحية استيراد نسخة' };
  const res = process.env.DAFTAR_TEST_BACKUP_FILE ? { canceled: false, filePaths: [process.env.DAFTAR_TEST_BACKUP_FILE] }
    : await dialog.showOpenDialog(win, {
    title: 'استعادة نسخة احتياطية',
    properties: ['openFile'],
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
  try {
    // a backup pasted into Notepad and saved may start with a byte-order mark; JSON.parse refuses it
    const text = fs.readFileSync(res.filePaths[0], 'utf8').replace(/^﻿/, '').trim();
    const data = JSON.parse(text);
    return { ok: true, data, path: res.filePaths[0] };
  } catch (e) {
    return { ok: false, error: 'الملف ليس نسخةً احتياطية صالحة (تعذّرت قراءته)' };
  }
});

ipcMain.handle('data:reveal', safe((_e, id) => {
  if (!isAdmin()) return { ok: false, error: 'هذا الإجراء للمدير فقط' };
  if (id && ws.validId(id)) {
    const f = ws.fileOf(id);
    if (fs.existsSync(f)) { shell.showItemInFolder(f); return { ok: true }; }
    fs.mkdirSync(ws.dirOf(id), { recursive: true });
    shell.openPath(ws.dirOf(id));
    return { ok: true };
  }
  shell.openPath(ws.root);
  return { ok: true };
}));

app.whenReady().then(() => {
  // Test runs on a Linux box without a keyring still exercise the saved-session
  // path; the shipped Windows app always uses real DPAPI encryption.
  if (!pinned && process.platform === 'linux' && safeStorage.setUsePlainTextEncryption) safeStorage.setUsePlainTextEncryption(true);
  // the page never needs the camera, microphone, location, notifications…
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
  // first sync once the page is up, then on a steady beat
  win.webContents.once('did-finish-load', () => cloud.start(((cloudCfg && cloudCfg.pollSeconds) || 60) * 1000));
});
app.on('before-quit', () => cloud.stop());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
