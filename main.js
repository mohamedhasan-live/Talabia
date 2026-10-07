'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { makeWorkspace } = require('./workspace');
const { makeCloud } = require('./cloud');
const { makeAuth } = require('./auth');
const { makeCatalogs } = require('./catalog');
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
const ws = makeWorkspace({ root: app.getPath('userData'), brands: BRANDS, legacyRoot });
// each brand's materials, offers and recipes (catalog.js), beside the branches
const catalogs = makeCatalogs({ root: app.getPath('userData'), brands: BRANDS });

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

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 820,
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
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // Open filling the screen: this is a working sheet, and the extra width goes
  // into the order rows and tables rather than a wider margin.
  win.once('ready-to-show', () => { win.maximize(); win.show(); });

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
ipcMain.handle('admin:call', async (_e, op, o) => {
  if (!isAdmin()) return { ok: false, error: 'هذا الإجراء للمدير فقط' };
  const d = ADMIN_OPS[op];
  if (!d) return { ok: false, error: 'bad op' };
  const r = await cloud.rpc(d[0], d[1](o || {}));
  if (r.ok && !/^(users|roles|activity)$/.test(op)) cloud.soon(500);     // our own access may have changed
  return r;
});
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
