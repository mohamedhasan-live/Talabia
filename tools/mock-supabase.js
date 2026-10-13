'use strict';
/*
 * A small stand-in for Supabase: the REST API (PostgREST) for daftar_branches
 * and daftar_members, the sign-in API (GoTrue), and the row-level security the
 * real project enforces:
 *   - the anon key alone reads nothing and writes nothing;
 *   - a signed-in user who is not in daftar_members sees an empty table and
 *     cannot write (exactly what Postgres RLS does);
 *   - a member can do everything.
 * It can also start without the tables, and issue short-lived tokens so the
 * refresh path is exercised.
 */
const http = require('http');
const crypto = require('crypto');

/*
 * The same check as private.talabia_edit_violation in supabase-roles.sql, step
 * for step: what changed in a branch record must be allowed by the role. Values
 * are compared by meaning — the defaults the app fills in on load are not edits.
 */
const tp = (p, k) => !!(p && p[k] === true);
const tnum = (v, d) => { if (v === null || v === undefined) return d; const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN); return Number.isFinite(n) ? n : d; };
const tobj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
const tarr = v => Array.isArray(v) ? v : [];
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach(k => { o[k] = sortKeys(v[k]); }); return o; } return v; }
function tnProducts(j) { const o = {}; tarr(j).forEach(p => { if (p && typeof p === 'object' && 'id' in p) o[p.id] = { name: p.name == null ? '' : String(p.name), unit: p.unit ? String(p.unit) : 'حبة', shelfLife: tnum(p.shelfLife, 5), packSize: tnum(p.packSize, 1), moq: tnum(p.moq, 0), active: p.active !== false, aliases: tarr(p.aliases) }; }); return o; }
function tnDays(j) {
  const o = {};
  Object.entries(tobj(j)).forEach(([k, v]) => {
    if (!v || typeof v !== 'object') return;
    const items = {};
    Object.entries(tobj(v.items)).forEach(([ik, iv]) => {
      if (!iv || typeof iv !== 'object') return;
      const x = { sold: tnum(iv.sold, 0), waste: tnum(iv.waste, 0), lost: tnum(iv.lost, 0), stockout: iv.stockout === true };
      if (x.sold || x.waste || x.lost || x.stockout) items[ik] = x;
    });
    const closed = v.closed === true;
    if (closed || Object.keys(items).length) o[k] = { closed, items };
  });
  return o;
}
function tnStock(j) { const o = {}; Object.entries(tobj(j)).forEach(([k, v]) => { const l = tarr(v).filter(x => x && typeof x === 'object').map(x => ({ qty: tnum(x.qty, 0), expiry: x.expiry === undefined ? null : x.expiry })); if (l.length) o[k] = l; }); return o; }
function tnOrders(j) { const o = {}; Object.entries(tobj(j)).forEach(([k, v]) => { if (!v || typeof v !== 'object') return; const items = {}; Object.entries(tobj(v.items)).forEach(([ik, iv]) => { if (iv && typeof iv === 'object') items[ik] = { suggested: tnum(iv.suggested, 0), ordered: tnum(iv.ordered, 0) }; }); o[k] = { status: v.status == null ? '' : String(v.status), items }; }); return o; }
function tnEvents(j) { const o = {}; tarr(j).forEach(e => { if (e && typeof e === 'object' && 'id' in e) o[e.id] = { name: e.name == null ? '' : String(e.name), kind: e.kind || 'other', from: e.from === undefined ? null : e.from, to: e.to === undefined ? null : e.to, mult: tnum(e.mult, 1) }; }); return o; }
function tnSchedule(c) {
  const days = [...new Set(tarr(c.orderDays).map(d => Math.trunc(tnum(d, -1))).filter(x => x >= 0 && x <= 6))].sort((a, b) => a - b);
  const dayCfg = {};
  Object.entries(tobj(c.dayCfg)).forEach(([k, v]) => { if (!v || typeof v !== 'object') return; const x = {}; if ('lead' in v) x.lead = tnum(v.lead, 0); if ('hour' in v) x.hour = tnum(v.hour, 0); if (Object.keys(x).length) dayCfg[k] = x; });
  return { orderDays: days.length ? days : [0, 3], leadDays: tnum(c.leadDays, 1), deliveryHour: tnum(c.deliveryHour, 19),
           afterShare: (c.afterShare === null || c.afterShare === undefined || c.afterShare === '') ? null : tnum(c.afterShare, null),
           horizonBuffer: tnum(c.horizonBuffer, 0.95), dayCfg };
}
function tnTracking(c) { return { trackWaste: c.trackWaste === undefined ? true : c.trackWaste === true, trackStockout: c.trackStockout === undefined ? true : c.trackStockout === true, trackPacking: c.trackPacking === true, trackStock: c.trackStock === true, showShelfInClose: c.showShelfInClose === true }; }
function editViolation(o, n, p) {
  o = tobj(o); n = tobj(n);
  if (tp(p, 'data.import')) return null;
  const op = tnProducts(o.products), np = tnProducts(n.products);
  for (const k of Object.keys(np)) if (!(k in op) && !(tp(p, 'items.add') || tp(p, 'entry.import'))) return 'إضافة صنف';
  for (const k of Object.keys(op)) if (!(k in np) && !tp(p, 'items.delete')) return 'حذف صنف';
  for (const k of Object.keys(op)) {
    if (!(k in np) || same(op[k], np[k])) continue;
    const a = Object.assign({}, op[k]), b = Object.assign({}, np[k]); delete a.aliases; delete b.aliases;
    if (!same(a, b)) { if (!tp(p, 'items.edit')) return 'تعديل صنف'; }
    else if (!(tp(p, 'items.edit') || tp(p, 'entry.import'))) return 'تعديل الأسماء البديلة لصنف';
  }
  const od = tnDays(o.days), nd = tnDays(n.days);
  for (const k of new Set(Object.keys(od).concat(Object.keys(nd)))) {
    const a = od[k] || null, b = nd[k] || null;
    if (same(a, b)) continue;
    if ((a ? a.closed : false) !== (b ? b.closed : false) && !(tp(p, 'entry.close') || tp(p, 'entry.import'))) return 'إقفال اليوم أو فتحه';
    if (!same(a ? a.items : {}, b ? b.items : {}) && !(tp(p, 'entry.record') || tp(p, 'entry.import'))) return 'تسجيل المبيعات';
  }
  if (!same(tnStock(o.stock), tnStock(n.stock)) && !tp(p, 'order.stock')) return 'الجرد';
  if (!same(tnOrders(o.orders), tnOrders(n.orders)) && !tp(p, 'order.save')) return 'اعتماد الطلبية';
  if (!same(tnEvents(o.events), tnEvents(n.events)) && !tp(p, 'setup.events')) return 'المناسبات';
  if (!same(tnSchedule(tobj(o.cfg)), tnSchedule(tobj(n.cfg))) && !tp(p, 'setup.schedule')) return 'جدول الطلب';
  if (!same(tnTracking(tobj(o.cfg)), tnTracking(tobj(n.cfg))) && !tp(p, 'setup.tracking')) return 'ما يُسجَّل يومياً';
  if (tnum(tobj(o.cfg).tendency, 50) !== tnum(tobj(n.cfg).tendency, 50) && !tp(p, 'setup.tendency')) return 'ميل النظام';
  return null;
}

function startMock({ key, withTable = true, tokenTtl = 3600, withRoles = true, withCatalog = false, withImportsGuard = false } = {}) {
  const rows = new Map();
  const catalogs = new Map();       // supabase-recipes.sql: public.talabia_brand_catalog, one row per brand
  let hasCatalog = withCatalog;
  let hasTable = withTable;
  let calls = 0;
  const users = new Map();          // email -> { id, password }
  const members = new Map();        // user id -> { role, branches, owner, roleId, active }  (private.talabia_users)
  // supabase-roles.sql: the owner's roles and the activity log (withRoles:false = an older project)
  const roles = new Map([
    ['manager', { name: 'مدير فرع', perms: { 'view.order': true, 'view.entry': true, 'view.items': true, 'view.stats': true, 'order.save': true, 'order.adjust': true, 'entry.record': true, 'entry.close': true, 'items.add': true, 'items.edit': true, 'data.export': true } }],
    ['staff', { name: 'موظف', perms: { 'view.order': true, 'view.entry': true, 'order.adjust': true, 'entry.record': true, 'entry.close': true } }]
  ]);
  const activity = [];
  const access = new Map();         // token -> { uid, exp }
  const refresh = new Map();        // token -> uid

  const filters = q => {
    const out = [];
    for (const [k, v] of q) {
      if (k === 'select' || k === 'limit') continue;
      const m = /^eq\.(.*)$/.exec(v);
      if (m) out.push([k, m[1]]);
    }
    return out;
  };
  const match = (row, fs) => fs.every(([k, v]) => String(row[k]) === v);
  const pick = (row, sel) => {
    if (!sel || sel === '*') return JSON.parse(JSON.stringify(row));
    const o = {}; sel.split(',').forEach(c => { o[c] = row[c]; }); return JSON.parse(JSON.stringify(o));
  };
  function issue(uid) {
    const a = 'at-' + crypto.randomBytes(8).toString('hex'), r = 'rt-' + crypto.randomBytes(8).toString('hex');
    access.set(a, { uid, exp: Date.now() + tokenTtl * 1000, refresh: r }); refresh.set(r, uid);
    const email = [...users.entries()].find(([, u]) => u.id === uid)[0];
    return { access_token: a, refresh_token: r, expires_in: tokenTtl, token_type: 'bearer', user: { id: uid, email } };
  }

  const server = http.createServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.headers.apikey !== key) return send(401, { message: 'Invalid API key' });
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const data = body ? JSON.parse(body) : null;

      /* ---- GoTrue ---- */
      if (u.pathname === '/auth/v1/token') {
        const g = u.searchParams.get('grant_type');
        if (g === 'password') {
          const usr = users.get(String(data.email || '').toLowerCase());
          if (!usr || usr.password !== data.password) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
          const mm = members.get(usr.id);
          if (mm && mm.active === false) return send(400, { error_code: 'user_banned', error_description: 'User is banned' });
          return send(200, issue(usr.id));
        }
        if (g === 'refresh_token') {
          const uid = refresh.get(data.refresh_token);
          if (!uid) return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
          refresh.delete(data.refresh_token);
          return send(200, issue(uid));
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      if (u.pathname === '/auth/v1/logout') {
        const t = (req.headers.authorization || '').replace(/^Bearer /, '');
        const a = access.get(t); access.delete(t);
        // scope=global (Supabase's default) ends every session of the user; scope=local only this one
        if (a && u.searchParams.get('scope') !== 'local') {
          for (const [r, uid] of refresh) if (uid === a.uid) refresh.delete(r);
          for (const [k, v] of access) if (v.uid === a.uid) access.delete(k);
        } else if (a && a.refresh) refresh.delete(a.refresh);
        return send(204);
      }

      /* ---- who is asking ---- */
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      let uid = null;
      if (bearer && bearer !== key) {
        const a = access.get(bearer);
        if (!a) return send(401, { code: 'PGRST301', message: 'JWT invalid' });
        if (Date.now() > a.exp) return send(401, { code: 'PGRST301', message: 'JWT expired' });
        uid = a.uid;
      }
      const raw = uid ? members.get(uid) : null;
      const isMember = !!(raw && raw.active !== false);          // a disabled account sees nothing
      const me = isMember ? raw : null;
      const isAdmin = !!(me && me.role === 'admin');
      const can = id => !!(me && (me.role === 'admin' || me.branches.includes(id)));

      if (!hasTable) return send(404, { code: 'PGRST205', message: "Could not find the table 'public.daftar_branches'" });

      if (u.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = u.pathname.slice('/rest/v1/rpc/'.length);
        if (!uid) return send(401, { code: '42501', message: 'permission denied for function ' + fn });
        const a = data || {};
        const err = m => send(400, { code: 'P0001', message: m });
        if (fn === 'talabia_me') {
          if (raw && raw.active === false) return send(200, { member: false, disabled: true });
          if (!me) return send(200, { member: false });
          const out = { member: true, role: me.role, branches: me.branches.slice() };
          if (withRoles) {
            const r = me.roleId ? roles.get(me.roleId) : null;
            Object.assign(out, { owner: me.role === 'admin', name: me.name || null, role_id: me.roleId || null, role_name: r ? r.name : null, perms: r ? Object.assign({}, r.perms) : {} });
          }
          return send(200, out);
        }
        if (fn === 'talabia_am_i_member') return send(200, !!isMember);
        if (fn === 'talabia_log') {
          if (!withRoles) return send(404, { code: 'PGRST202', message: 'no function' });
          if (!isMember) return send(200, 0);
          const email = [...users.entries()].find(([, x]) => x.id === uid)[0];      // written by the server, not the caller
          (a.p_items || []).slice(0, 100).forEach(it => activity.unshift({ at: it.at, email, branch: it.branch || '', action: it.action || '', detail: it.detail || '' }));
          return send(200, (a.p_items || []).length);
        }
        // talabia_branch_create: a branch from an account whose role has «branches.add», assigned to it
        if (fn === 'talabia_branch_create' && withRoles) {
          const rl = me && me.roleId ? roles.get(me.roleId) : null;
          if (!isAdmin && !(rl && rl.perms && rl.perms['branches.add'] === true)) return send(403, { code: '42501', message: 'غير مسموح: «إنشاء الفروع» ليس من صلاحيات دورك' });
          const r = a.p_row || {};
          if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(String(r.id || ''))) return err('معرّف الفرع غير صالح');
          if (!String(r.name || '').trim()) return err('اسم الفرع غير صالح');
          if (![...rows.values()].some(x => x.brand === r.brand)) return err('البراند غير معروف');
          if (rows.has(r.id)) return err('يوجد فرعٌ بهذا المعرّف');
          rows.set(r.id, { id: r.id, brand: r.brand, name: String(r.name).trim(), rev: Math.max(1, +r.rev || 1), updated_at: new Date().toISOString(), deleted: false, device: r.device || null, data: r.data });
          if (!isAdmin && !me.branches.includes(r.id)) me.branches.push(r.id);
          return send(200, r.id);
        }
        if (!fn.startsWith('talabia_admin_')) return send(404, { code: 'PGRST202', message: 'no function' });
        // delegated control-panel rights (supabase-roles.sql): a role with admin.users / admin.roles / admin.log, never over the owner,
        // never over itself, never over an owner-appointed (sensitive) role, never granting anything sensitive, never clearing the log
        const myPerms = (withRoles && me && me.roleId && roles.get(me.roleId)) ? roles.get(me.roleId).perms || {} : {};
        const UMB = { usr: 'admin.users', role: 'admin.roles', log: 'admin.log' };
        const perm = p => isAdmin || myPerms[p] === true || myPerms[UMB[p.split('.')[0]]] === true;
        const sens = pr => Object.keys(pr || {}).some(k => pr[k] === true && (/^(admin|usr|role|log|data)\./.test(k) || k === 'branches.delete'));
        const roleSens = id => !!(id && roles.get(id) && sens(roles.get(id).perms));
        const adm = pr => Object.keys(pr || {}).some(k => pr[k] === true && /^(admin|usr|role|log)\./.test(k));
        const roleAdm = id => !!(id && roles.get(id) && adm(roles.get(id).perms));
        const sensKeys = pr => Object.keys(pr || {}).filter(k => pr[k] === true && (/^(admin|usr|role|log|data)\./.test(k) || k === 'branches.delete')).sort().join();
        const guardTarget = id => { if (isAdmin) return null; const m = members.get(id); if (m && m.role === 'admin') return 'حساب المالك لا يُمَسّ'; if (id === uid) return 'لا تستطيع تعديل حسابك أو صلاحياتك بنفسك'; if (m && roleAdm(m.roleId)) return 'هذا الحساب مديرٌ مفوَّض مثلك — يعدّله المالك وحده'; return null; };
        if (withRoles && !isAdmin) {
          const need = { talabia_admin_users: ['usr.view'], talabia_admin_create_member: ['usr.add'], talabia_admin_set_member: ['usr.edit'], talabia_admin_set_active: ['usr.stop'],
            talabia_admin_set_password: ['usr.pass'], talabia_admin_remove: ['usr.delete'], talabia_admin_roles: ['role.view', 'usr.add', 'usr.edit'],
            talabia_admin_save_role: [a.p_id && roles.has(a.p_id) ? 'role.edit' : 'role.add'], talabia_admin_delete_role: ['role.delete'], talabia_admin_activity: ['log.view'] }[fn];
          if (!need || !need.some(perm)) return err('غير مسموح');
          if (/set_member|set_active|set_password|remove/.test(fn)) { const g = guardTarget(a.p_user); if (g) return err(g); }
          if (fn === 'talabia_admin_create_member' && roleSens(a.p_role_id)) return err('لا تستطيع منح دورٍ فيه صلاحيات حسّاسة');
          if (fn === 'talabia_admin_set_member' && roleSens(a.p_role_id) && (members.get(a.p_user) || {}).roleId !== a.p_role_id) return err('لا تستطيع منح دورٍ فيه صلاحيات حسّاسة');
          if (fn === 'talabia_admin_create_member') { const ex = users.get(String(a.p_email || '').trim().toLowerCase()); if (ex && members.has(ex.id)) { const g = guardTarget(ex.id); if (g) return err(g); } }
          if (fn === 'talabia_admin_save_role') { if (a.p_id && me.roleId === a.p_id) return err('لا تستطيع تعديل دورك أنت'); if (roleAdm(a.p_id)) return err('هذا دور مديرٍ مفوَّض — يعدّله المالك وحده');
            if (sensKeys(a.p_perms) !== sensKeys(a.p_id && roles.get(a.p_id) ? roles.get(a.p_id).perms : {})) return err('لا تستطيع منح صلاحيات حسّاسة أو نزعها (البيانات، الصلاحيات الإدارية، حذف الفروع)'); }
          if (fn === 'talabia_admin_delete_role' && (roleAdm(a.p_id) || me.roleId === a.p_id)) return err('لا تستطيع حذف هذا الدور');
        } else if (!isAdmin) return err('غير مسموح');
        if (withRoles) {
          const emailOf2 = id => ([...users.entries()].find(([, x]) => x.id === id) || [])[0];
          const owner = id => { const m = members.get(id); return !!(m && m.role === 'admin'); };
          // display name: optional, ≤60, unique (case-insensitive) — as in supabase-roles.sql
          const nameOf = v => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, 60) : null; };
          const nameTaken = (nm, self) => !!nm && [...members.entries()].some(([k, v]) => k !== self && v.name && v.name.toLowerCase() === nm.toLowerCase());
          if (fn === 'talabia_admin_users') return send(200, [...members.entries()].map(([id, v]) => ({ user_id: id, email: emailOf2(id), name: v.name || null, role: v.role, owner: v.role === 'admin', role_id: v.roleId || null, active: v.active !== false, branches: v.branches.slice(), last_sign_in: null, me: id === uid })));
          if (fn === 'talabia_admin_create_member') {
            const em = String(a.p_email || '').trim().toLowerCase();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err('البريد غير صحيح');
            if (a.p_role_id && !roles.has(a.p_role_id)) return err('الدور غير موجود');
            let usr = users.get(em);
            if (usr && owner(usr.id)) return err('هذا حساب المالك');
            const nm = nameOf(a.p_name);
            if (nameTaken(nm, usr && usr.id)) return err('يوجد مستخدم بنفس الاسم');
            if (!usr) { if (!a.p_password || String(a.p_password).length < 8) return err('كلمة المرور 8 أحرف على الأقل'); usr = { id: crypto.randomUUID(), password: a.p_password }; users.set(em, usr); }
            const prev = members.get(usr.id);
            members.set(usr.id, { role: 'staff', branches: (a.p_branches || []).slice(), roleId: a.p_role_id || null, active: true, name: nm || (prev && prev.name) || null });
            return send(200, usr.id);
          }
          if (fn === 'talabia_admin_set_member') {
            if (owner(a.p_user)) return err('حساب المالك لا يُقيَّد');
            const m = members.get(a.p_user); if (!m) return err('المستخدم غير موجود');
            if (a.p_role_id && !roles.has(a.p_role_id)) return err('الدور غير موجود');
            const nm = nameOf(a.p_name);
            if (nameTaken(nm, a.p_user)) return err('يوجد مستخدم بنفس الاسم');
            Object.assign(m, { role: 'staff', roleId: a.p_role_id || null, branches: (a.p_branches || []).slice(), name: nm || m.name || null }); return send(200, null);
          }
          if (fn === 'talabia_admin_set_active') {
            if (owner(a.p_user)) return err('حساب المالك لا يُوقَف');
            const m = members.get(a.p_user); if (!m) return err('المستخدم غير موجود');
            m.active = a.p_active !== false;
            if (!m.active) { for (const [r, id] of refresh) if (id === a.p_user) refresh.delete(r); for (const [k, v] of access) if (v.uid === a.p_user) access.delete(k); }
            return send(200, null);
          }
          if (fn === 'talabia_admin_roles') return send(200, [...roles.entries()].map(([id, r]) => ({ id, name: r.name, perms: Object.assign({}, r.perms), users: [...members.values()].filter(m => m.roleId === id).length })));
          if (fn === 'talabia_admin_save_role') {
            const nm = String(a.p_name || '').trim(); if (!nm) return err('اكتب اسم الدور');
            const id = a.p_id || ('r-' + crypto.randomBytes(5).toString('hex'));
            if ([...roles.entries()].some(([k, r]) => k !== id && r.name.toLowerCase() === nm.toLowerCase())) return err('يوجد دور بنفس الاسم');
            roles.set(id, { name: nm, perms: Object.assign({}, a.p_perms || {}) }); return send(200, id);
          }
          if (fn === 'talabia_admin_delete_role') {
            const n = [...members.values()].filter(m => m.roleId === a.p_id).length;
            if (n) return err('هذا الدور لـ ' + n + ' مستخدم — انقلهم لدور آخر أولاً');
            roles.delete(a.p_id); return send(200, null);
          }
          if (fn === 'talabia_admin_activity') return send(200, activity.filter(x => !a.p_email || x.email === String(a.p_email).toLowerCase()).slice(0, a.p_limit || 300));
          if (fn === 'talabia_admin_clear_activity') { activity.length = 0; return send(200, null); }
        }
        const adminsAfter = (user, role) => [...members.entries()].filter(([k, v]) => v.role === 'admin' && k !== user).length + (role === 'admin' ? 1 : 0);
        const emailOf = id => ([...users.entries()].find(([, x]) => x.id === id) || [])[0];
        if (fn === 'talabia_admin_users') return send(200, [...members.entries()].map(([id, v]) => ({ user_id: id, email: emailOf(id), role: v.role, branches: v.branches.slice(), last_sign_in: null, me: id === uid })));
        if (fn === 'talabia_admin_create_user') {
          const em = String(a.p_email || '').trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err('البريد غير صحيح');
          let usr = users.get(em);
          if (!usr) { if (!a.p_password || String(a.p_password).length < 8) return err('كلمة المرور 8 أحرف على الأقل'); usr = { id: crypto.randomUUID(), password: a.p_password }; users.set(em, usr); }
          members.set(usr.id, { role: a.p_role === 'admin' ? 'admin' : 'staff', branches: (a.p_branches || []).slice() });
          return send(200, usr.id);
        }
        if (fn === 'talabia_admin_set_access') {
          if (!members.has(a.p_user)) return err('المستخدم غير موجود');
          if (adminsAfter(a.p_user, a.p_role) < 1) return err('لا بدّ من مديرٍ واحدٍ على الأقل');
          members.set(a.p_user, { role: a.p_role, branches: (a.p_branches || []).slice() }); return send(200, null);
        }
        if (fn === 'talabia_admin_set_password') {
          if (!a.p_password || String(a.p_password).length < 8) return err('كلمة المرور 8 أحرف على الأقل');
          const e = emailOf(a.p_user); if (!e || !members.has(a.p_user)) return err('المستخدم غير موجود');
          users.get(e).password = a.p_password; return send(200, null);
        }
        if (fn === 'talabia_admin_remove') {
          if (adminsAfter(a.p_user, 'staff') < 1) return err('لا بدّ من مديرٍ واحدٍ على الأقل');
          members.delete(a.p_user);
          if (a.p_delete_account) { const e = emailOf(a.p_user); if (e) users.delete(e); }
          return send(200, null);
        }
        return send(404, { code: 'PGRST202', message: 'no function' });
      }
      /* ---- public.talabia_brand_catalog, with the policies of supabase-recipes.sql ---- */
      if (u.pathname === '/rest/v1/talabia_brand_catalog') {
        if (!hasCatalog) return send(404, { code: 'PGRST205', message: "Could not find the table 'public.talabia_brand_catalog'" });
        const canBrand = b => isAdmin || [...rows.values()].some(r => r.brand === b && !r.deleted && can(r.id));
        const rl = withRoles && me && me.roleId ? roles.get(me.roleId) : null;
        const perm = k => !!(rl && rl.perms && rl.perms[k] === true);
        const canRecipes = b => isAdmin || (canBrand(b) && (perm('items.edit') || perm('recipes.edit')));
        const cfs = filters(u.searchParams), csel = u.searchParams.get('select');
        const rep = /return=representation/.test(req.headers.prefer || '');
        if (req.method === 'GET') return send(200, [...catalogs.values()].filter(r => isMember && canBrand(r.brand) && match(r, cfs)).map(r => pick(r, csel)));
        if (!uid || !isMember) return send(req.method === 'POST' ? 403 : 200, req.method === 'POST' ? { code: '42501', message: 'new row violates row-level security policy' } : []);
        if (req.method === 'POST') {
          const list = Array.isArray(data) ? data : [data];
          for (const r of list) {
            if (!canRecipes(r.brand)) return send(403, { code: '42501', message: 'new row violates row-level security policy for table "talabia_brand_catalog"' });
            if (catalogs.has(r.brand)) return send(409, { code: '23505', message: 'duplicate key' });
          }
          list.forEach(r => catalogs.set(r.brand, JSON.parse(JSON.stringify(r))));
          return send(201, rep ? list : undefined);
        }
        if (req.method === 'PATCH') {
          // RLS «using»: a row this account may not change is simply not there for it
          const hit = [...catalogs.values()].filter(r => canRecipes(r.brand) && match(r, cfs));
          for (const r of hit) if ('brand' in data && data.brand !== r.brand) return send(403, { code: '42501', message: 'غير مسموح: براند الوصفات لا يتغيّر' });
          hit.forEach(r => Object.assign(r, JSON.parse(JSON.stringify(data))));
          return send(200, rep ? hit.map(r => pick(r)) : undefined);
        }
        if (req.method === 'DELETE') { if (isAdmin) [...catalogs.values()].filter(r => match(r, cfs)).forEach(r => catalogs.delete(r.brand)); return send(204); }
        return send(405, { message: 'method' });
      }
      if (u.pathname !== '/rest/v1/daftar_branches') return send(404, { code: 'PGRST205', message: 'no such table' });

      const fs = filters(u.searchParams);
      const sel = u.searchParams.get('select');
      const wantRep = /return=representation/.test(req.headers.prefer || '');
      if (req.method === 'GET') return send(200, [...rows.values()].filter(r => can(r.id) && match(r, fs)).map(r => pick(r, sel)));
      if (!uid) return send(401, { code: '42501', message: 'permission denied for table daftar_branches' });
      if (!isMember) {
        if (req.method === 'POST') return send(403, { code: '42501', message: 'new row violates row-level security policy' });
        return send(wantRep ? 200 : 204, wantRep ? [] : undefined);      // RLS: nothing visible to change
      }
      if (req.method === 'POST') {
        if (!isAdmin) return send(403, { code: '42501', message: 'new row violates row-level security policy' });
        const list = Array.isArray(data) ? data : [data];
        for (const r of list) if (rows.has(r.id)) return send(409, { code: '23505', message: 'duplicate key' });
        list.forEach(r => rows.set(r.id, Object.assign({ deleted: false }, r)));
        return send(201, wantRep ? list : undefined);
      }
      if (req.method === 'PATCH') {
        const hit = [...rows.values()].filter(r => can(r.id) && match(r, fs));
        if (!isAdmin) for (const r of hit) {
          for (const k of ['id', 'brand', 'deleted']) if (k in data && data[k] !== r[k]) return send(400, { code: 'P0001', message: 'غير مسموح: تعديل الفرع نفسه للمالك فقط' });
          // talabia_guard_branch: the name changes only with «branches.edit»
          if ('name' in data && data.name !== r.name) {
            const rl = withRoles && me.roleId ? roles.get(me.roleId) : null;
            if (!(rl && rl.perms && rl.perms['branches.edit'] === true)) return send(403, { code: '42501', message: 'غير مسموح: «تعديل الفروع» ليس من صلاحيات دورك' });
          }
          // talabia_guard_perms: the role must allow everything that changed in the record
          if (withRoles && 'data' in data) {
            const rl = me.roleId ? roles.get(me.roleId) : null;
            const bad = editViolation(r.data, data.data, rl ? rl.perms : {});
            if (bad) return send(403, { code: '42501', message: 'غير مسموح: «' + bad + '» ليس من صلاحيات دورك' });
          }
          // supabase-coverage.sql (talabia_guard_imports), only when the project has run it: the import record
          // changes only with «entry.import» (or a restore, «data.import»)
          if (withImportsGuard && withRoles && 'data' in data && !same(tarr(tobj(r.data).imports), tarr(tobj(data.data).imports))) {
            const rl = me.roleId ? roles.get(me.roleId) : null;
            if (!(tp(rl && rl.perms, 'entry.import') || tp(rl && rl.perms, 'data.import'))) return send(403, { code: '42501', message: 'غير مسموح: «سجلّ الاستيراد» ليس من صلاحيات دورك' });
          }
        }
        hit.forEach(r => Object.assign(r, data));
        return send(200, wantRep ? hit.map(r => pick(r)) : undefined);
      }
      if (req.method === 'DELETE') {
        if (isAdmin) [...rows.values()].filter(r => match(r, fs)).forEach(r => rows.delete(r.id));
        return send(204);
      }
      send(405, { message: 'method' });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({
      url: 'http://127.0.0.1:' + server.address().port,
      rows: () => rows,
      createTable: () => { hasTable = true; },
      createCatalogTable: () => { hasCatalog = true; },
      catalogs: () => catalogs,
      addUser: (email, password, member = true, role = 'admin', branches = []) => {
        const id = crypto.randomUUID(); users.set(email.toLowerCase(), { id, password });
        if (member) members.set(id, { role, branches: branches.slice() }); return id;
      },
      removeMember: (email) => { const u = users.get(email.toLowerCase()); if (u) members.delete(u.id); },
      member: (email) => { const u = users.get(email.toLowerCase()); return u ? members.get(u.id) : null; },
      roles: () => roles,
      activity: () => activity,
      expireAll: () => { for (const a of access.values()) a.exp = 0; },
      calls: () => calls,
      close: () => new Promise(r => server.close(r))
    });
  }));
}

module.exports = { startMock, editViolation };
