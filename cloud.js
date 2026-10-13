'use strict';
/*
 * Local first, cloud second. Every save lands on this computer's disk at once
 * (workspace.js); this module then carries each branch to Supabase and brings
 * other devices' changes back. Without internet the app works exactly as
 * before and catches up when the connection returns.
 *
 * One row per branch in public.daftar_branches:
 *   id, brand, name, rev, updated_at, deleted, device, data (the whole record)
 *
 * Who is newer is decided by revision numbers, never by clocks:
 *   L = this device's rev, R = the cloud's rev, B = the rev both last agreed on
 *   L=B, R=B  nothing to do          L>B, R=B  push (only if the cloud is still at B)
 *   L=B, R>B  pull                   L>B, R>B  both changed: ask the owner
 * A push is conditional (PATCH … where rev = B), so two devices pushing at the
 * same moment cannot silently overwrite one another.
 */

const TABLE = 'daftar_branches';
const LIST_COLS = 'id,brand,name,rev,deleted,updated_at,device';
/*
 * The brands' operational catalogues (catalog.js): one row per brand in
 * public.talabia_brand_catalog (supabase-recipes.sql). Until the owner runs that
 * script the table is missing: the catalogue then lives on this computer alone,
 * the page says so, and the branches sync exactly as before.
 */
const CAT_TABLE = 'talabia_brand_catalog';

function makeCloud({ url, key, ws, brands, fetchImpl, onUpdate, log, auth, timeoutMs, logStore, catalogs }) {
  const TIMEOUT = timeoutMs || 20000;
  const doFetch = fetchImpl || globalThis.fetch;
  const base = String(url || '').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const enabled = !!(base && key);
  const brandKeys = new Set((brands || []).map(b => b.key));
  const say = log || (() => {});
  const state = { enabled, status: enabled ? 'idle' : 'off', lastSync: null, error: null, conflicts: [], pending: 0,
                  catalog: enabled && catalogs ? 'idle' : 'off', catalogNote: null };
  let running = null, again = false, timer = null, poll = null;

  // The anon key only identifies the project. The table answers signed-in
  // members alone, so every request carries the member's own access token.
  let bearer = null;
  const headers = extra => Object.assign({
    apikey: key, Authorization: 'Bearer ' + (bearer || key), 'Content-Type': 'application/json'
  }, extra || {});
  const endpoint = (q, table) => base + '/rest/v1/' + (table || TABLE) + (q ? '?' + q : '');

  async function call(method, q, body, extra, table, retried) {
    // never wait forever: a hung connection becomes "offline" and is retried
    const res = await doFetch(endpoint(q, table), {
      method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT)
    });
    // an access token that expired between checks: refresh once and try again
    if (res.status === 401 && auth && !retried) {
      auth.invalidate();
      bearer = await auth.token();
      if (bearer) return call(method, q, body, extra, table, true);
    }
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    if (!res.ok) {
      const err = new Error((json && (json.message || json.hint)) || ('HTTP ' + res.status));
      err.status = res.status; err.code = json && json.code;
      throw err;
    }
    return json;
  }
  const enc = encodeURIComponent;

  function rowFrom(snap, device) {
    return { id: snap.id, brand: snap.brand, name: snap.name, rev: snap.rev,
             updated_at: new Date().toISOString(), deleted: false, device, data: snap.data };
  }

  async function push(id, B, remoteExists, force) {
    const snap = ws.snapshotFor(id);                 // rev and record read together
    if (!snap) return false;
    const row = rowFrom(snap, ws.deviceId());
    try {
      if (!remoteExists) {
        await call('POST', '', [row], { Prefer: 'return=minimal' });
      } else {
        const cond = force ? 'id=eq.' + enc(id) : 'id=eq.' + enc(id) + '&rev=eq.' + B;
        const out = await call('PATCH', cond, row, { Prefer: 'return=representation' });
        if (!Array.isArray(out) || !out.length) return false;   // someone else pushed first
      }
    } catch (e) {
      /*
       * The database refused an edit this account's role does not allow
       * (supabase-roles.sql, talabia_guard_perms). The screens never offer such
       * an edit, so it came from a tampered copy: the cloud's copy comes back
       * here, the edit is dropped, and syncing carries on instead of retrying forever.
       */
      if (e.code === '42501' && /صلاحيات/.test(e.message || '') && remoteExists) {
        say('refused: ' + id + ' — ' + e.message);
        state.refused = { id, message: e.message, at: new Date().toISOString() };
        await pull(id, snap.rev);
        refusedNow.add(id);
        return false;
      }
      throw e;
    }
    ws.markSynced(id, snap.rev);
    return true;
  }
  const refusedNow = new Set();

  async function pull(id, expectRev) {
    const rows = await call('GET', 'id=eq.' + enc(id) + '&select=*');
    if (!rows || !rows.length) return false;
    const r = ws.applyRemote(rows[0], expectRev);
    return r.ok ? { isNew: !!r.isNew } : false;
  }

  async function once() {
    const changed = new Set();
    let remote;
    if (auth) {
      bearer = await auth.token();
      if (!bearer) { state.status = 'signin'; state.error = null; return changed; }
      try {
        // RLS answers a non-member with an empty list, not an error, so ask
        // plainly. The allow-list itself lives in a private schema the API
        // cannot see; this function only answers yes or no for the caller.
        let me;
        try { me = await call('POST', '', {}, undefined, 'rpc/talabia_me'); }
        catch (e) {
          // the first security script had no roles: its single member is the owner
          if (e.code !== 'PGRST202' && e.status !== 404) throw e;
          const ok = await call('POST', '', {}, undefined, 'rpc/talabia_am_i_member');
          me = ok === true ? { member: true, role: 'admin', branches: [] } : { member: false };
        }
        if (!me || me.member !== true) {
          ws.setAccess(null); state.status = me && me.disabled === true ? 'disabled' : 'notmember'; state.error = null;
          return changed;
        }
        const st = auth.state();
        ws.setAccess({ role: me.role, branches: me.branches || [], email: st.email,
                       owner: me.owner === true, roleName: me.role_name || null, perms: me.perms || null, name: me.name || null, roleId: me.role_id || null });
        await flushLog();
      } catch (e) {
        if (e.status === 404 || e.code === '42P01' || e.code === 'PGRST202' || e.code === 'PGRST205') { state.status = 'setup'; state.error = 'أمر الأمان لم يُشغَّل بعد في Supabase'; }
        else if (e.status === 401) { state.status = 'signin'; state.error = null; }
        else { state.status = 'offline'; state.error = e.message; }
        return changed;
      }
    }
    try {
      remote = await call('GET', 'select=' + LIST_COLS);
    } catch (e) {
      // PostgREST says 42P01 / PGRST205 when the table is not there yet
      if (e.status === 404 || e.code === '42P01' || e.code === 'PGRST205') {
        state.status = 'setup'; state.error = 'جدول daftar_branches غير موجود في Supabase بعد';
      } else {
        state.status = 'offline'; state.error = e.message;
      }
      return changed;
    }
    const byId = new Map();
    (remote || []).forEach(r => byId.set(r.id, r));
    const acc = ws.access();
    const staff = !!auth && (!acc || acc.role !== 'admin');
    const allowed = new Set(acc ? acc.branches : []);

    // a branch this account created here (its role has «branches.add»): the server adds it and
    // assigns it to the account (supabase-roles.sql, talabia_branch_create)
    if (staff && acc && acc.perms && acc.perms['branches.add'] === true) {
      for (const e of ws.entries()) {
        if (allowed.has(e.id) || byId.has(e.id) || !e.hasFile || e.cloudRev) continue;
        const snap = ws.snapshotFor(e.id);
        if (!snap) continue;
        try {
          await call('POST', '', { p_row: rowFrom(snap, ws.deviceId()) }, undefined, 'rpc/talabia_branch_create');
        } catch (err) {
          if (err.status >= 400 && err.status < 500 && err.status !== 401) { say('create refused: ' + e.id + ' — ' + err.message); continue; }
          throw err;                                 // offline or signed out: keep the branch, try again later
        }
        ws.markSynced(e.id, snap.rev);
        allowed.add(e.id);
        byId.set(e.id, { id: e.id, brand: snap.brand, name: snap.name, rev: snap.rev, deleted: false });
      }
    }

    // a regular account keeps only the branches it was given; the rest leave this computer
    if (staff) {
      for (const e of ws.entries()) if (!allowed.has(e.id)) { ws.forget(e.id); changed.add(e.id); }
      for (const id of ws.tombstones()) ws.clearTombstone(id);      // deleting is the admin's
    }

    // deletes made here reach the cloud first
    for (const id of ws.tombstones()) {
      const R = byId.get(id);
      if (R && !R.deleted) {
        await call('PATCH', 'id=eq.' + enc(id), { deleted: true, updated_at: new Date().toISOString(), device: ws.deviceId() },
          { Prefer: 'return=minimal' });
        R.deleted = true;
      }
      ws.clearTombstone(id);
    }

    const conflicts = [];
    for (const e of ws.entries()) {
      const R = byId.get(e.id), L = e.rev, B = e.cloudRev;
      if (!R) {
        if (e.hasFile && !staff) { if (await push(e.id, B, false)) state.pending++; }
        continue;
      }
      if (R.deleted) {
        if (!e.hasFile || L === B || staff) {
          if (staff) { ws.forget(e.id); changed.add(e.id); }
          else if (ws.entries().length > 1) { ws.remove(e.id, { fromCloud: true }); changed.add(e.id); }
        } else {
          await push(e.id, B, true, true);          // edited here after the delete: keep it
        }
        continue;
      }
      if (!e.hasFile) { if (await pull(e.id, L)) changed.add(e.id); continue; }
      if (+R.rev === B && L === B) continue;
      if (+R.rev === B && L > B) { await push(e.id, B, true); continue; }
      if (L === B && +R.rev > B) { if (await pull(e.id, L)) changed.add(e.id); continue; }
      if (+R.rev === L && B === 0) {                // same rev on both, never agreed: e.g. first run
        conflicts.push({ id: e.id, name: e.name, brand: e.brand, localRev: L, cloudRev: +R.rev, device: R.device, at: R.updated_at });
        continue;
      }
      if (+R.rev < B) { await push(e.id, B, true, true); continue; }   // the cloud was reset
      conflicts.push({ id: e.id, name: e.name, brand: e.brand, localRev: L, cloudRev: +R.rev, device: R.device, at: R.updated_at });
    }

    // branches another device created
    const local = new Set(ws.entries().map(e => e.id));
    for (const R of remote || []) {
      if (R.deleted || local.has(R.id) || !brandKeys.has(R.brand) || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(R.id)) continue;
      if (ws.tombstones().includes(R.id)) continue;
      if (await pull(R.id)) changed.add(R.id);
    }

    state.conflicts = conflicts;
    // the catalogues never hold the branches back: whatever happens to them, the branches are in sync
    try { await syncCatalogs(staff, acc, changed); }
    catch (e) { state.catalog = 'offline'; say('catalog: ' + e.message); }
    state.status = 'ok'; state.error = null; state.lastSync = new Date().toISOString();
    refusedNow.forEach(id => changed.add(id)); refusedNow.clear();     // the page reopens the restored branch
    return changed;
  }

  /*
   * Each brand's catalogue, by the same revision rule as a branch. Who may write
   * it: the owner, or an account whose role has «items.edit» or «recipes.edit»
   * (the database checks the same). Anyone else only reads. When both sides
   * changed, the cloud's copy wins and this computer's is kept aside in a file
   * next to it — never silently lost.
   */
  async function syncCatalogs(staff, acc, changed) {
    if (!catalogs) return;
    const perms = (acc && acc.perms) || {};
    const canEdit = !staff || (acc && acc.perms == null) || perms['items.edit'] === true || perms['recipes.edit'] === true;
    let remote;
    try { remote = await call('GET', 'select=brand,rev,updated_at', undefined, undefined, CAT_TABLE); }
    catch (e) {
      if (e.status === 404 || e.code === '42P01' || e.code === 'PGRST205') { state.catalog = 'setup'; return; }
      throw e;
    }
    const byBrand = new Map((remote || []).map(r => [r.brand, r]));
    const row = (snap) => ({ brand: snap.brand, rev: snap.rev, updated_at: new Date().toISOString(), device: ws.deviceId(), data: snap.data });
    const pullOne = async (brand, aside) => {
      const rows = await call('GET', 'brand=eq.' + enc(brand) + '&select=*', undefined, undefined, CAT_TABLE);
      if (!rows || !rows.length) return false;
      const r = catalogs.applyRemote(rows[0], aside);
      if (r.ok) changed.add('catalog:' + brand);
      return r.ok;
    };
    let note = null;
    for (const e of catalogs.entries()) {
      const R = byBrand.get(e.brand);
      try {
        if (!R) {
          if (e.has && canEdit) {
            const snap = catalogs.snapshotFor(e.brand);
            await call('POST', '', [row(snap)], { Prefer: 'return=minimal' }, CAT_TABLE);
            catalogs.markSynced(e.brand, snap.rev);
          }
          continue;
        }
        const L = e.rev, B = e.cloudRev, Rr = +R.rev;
        if (!e.has) { await pullOne(e.brand, false); continue; }
        if (Rr === B && L === B) continue;
        if (L === B && Rr > B) { await pullOne(e.brand, false); continue; }
        if (Rr === B && L > B && canEdit) {
          const snap = catalogs.snapshotFor(e.brand);
          const out = await call('PATCH', 'brand=eq.' + enc(e.brand) + '&rev=eq.' + B, row(snap), { Prefer: 'return=representation' }, CAT_TABLE);
          if (Array.isArray(out) && out.length) catalogs.markSynced(e.brand, snap.rev);
          continue;                                   // someone else pushed first: the next round sorts it out
        }
        if (Rr === B && L > B) { await pullOne(e.brand, true); note = 'refused'; continue; }   // not this account's to change
        // both changed: the cloud's copy wins, this computer's goes aside
        await pullOne(e.brand, true); note = 'conflict';
      } catch (err) {
        if (err.status === 401) throw err;
        say('catalog ' + e.brand + ': ' + err.message);        // one brand's trouble does not stop the others
      }
    }
    state.catalog = 'ok'; state.catalogNote = note;
  }

  function publish(changed) {
    if (onUpdate) onUpdate(Object.assign(view(), { changed: [...(changed || [])], ws: ws.snapshot() }));
  }
  function view() {
    const refused = state.refused || null; state.refused = null;      // said once
    const catalogNote = state.catalogNote; state.catalogNote = null;  // said once
    return { enabled: state.enabled, status: state.status, lastSync: state.lastSync, error: state.error,
             conflicts: state.conflicts.slice(), running: !!running, access: ws.access(), refused,
             catalog: state.catalog, catalogNote };
  }

  /*
   * The activity log (who did what, when, in which branch). Entries wait in a
   * small queue, kept on disk by the caller so a closed or offline app loses
   * nothing, and go up with the next sync. The server writes the account's email
   * itself; nothing here can claim to be someone else.
   */
  const LOG_MAX = 1000;
  let logQueue = (logStore && logStore.load()) || [];
  function queueLog(items) {
    const clean = (Array.isArray(items) ? items : []).slice(0, 100).map(x => ({
      at: typeof x.at === 'string' ? x.at.slice(0, 40) : new Date().toISOString(),
      branch: typeof x.branch === 'string' ? x.branch.slice(0, 48) : '',
      action: typeof x.action === 'string' ? x.action.slice(0, 32) : '',
      detail: typeof x.detail === 'string' ? x.detail.slice(0, 300) : ''
    })).filter(x => x.action);
    if (!clean.length) return { ok: true, queued: logQueue.length };
    logQueue = logQueue.concat(clean).slice(-LOG_MAX);
    if (logStore) logStore.save(logQueue);
    soon(4000);
    return { ok: true, queued: logQueue.length };
  }
  async function flushLog() {
    while (logQueue.length) {
      const batch = logQueue.slice(0, 100);
      try { await call('POST', '', { p_items: batch }, undefined, 'rpc/talabia_log'); }
      catch (e) {
        // an older project without the log: drop the queue rather than grow it forever
        if (e.code === 'PGRST202' || e.status === 404) { logQueue = []; if (logStore) logStore.save(logQueue); }
        return;
      }
      logQueue = logQueue.slice(batch.length);
      if (logStore) logStore.save(logQueue);
    }
  }

  /** The admin's user-management calls. The database checks the caller is an admin. */
  async function rpc(fn, args) {
    if (!enabled) return { ok: false, error: 'السحاب غير مفعّل' };
    if (!/^talabia_admin_[a-z_]+$/.test(fn)) return { ok: false, error: 'bad call' };
    if (auth) { bearer = await auth.token(); if (!bearer) return { ok: false, error: 'سجّل الدخول أوّلاً' }; }
    try { return { ok: true, data: await call('POST', '', args || {}, undefined, 'rpc/' + fn) }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  async function sync() {
    if (!enabled) return view();
    if (running) { again = true; return running; }
    running = (async () => {
      let changed = new Set();
      try {
        do { again = false; const c = await once(); c.forEach(x => changed.add(x)); } while (again);
      } catch (e) {
        state.status = 'offline'; state.error = e.message; say('sync: ' + e.message);
      } finally {
        running = null;
      }
      publish(changed);
      return view();
    })();
    return running;
  }

  /** The owner's answer to a conflict: keep this device's copy, or take the cloud's. */
  async function resolve(id, which) {
    if (!enabled) return { ok: false, error: 'cloud off' };
    if (auth) { bearer = await auth.token(); if (!bearer) return { ok: false, error: 'سجّل الدخول أوّلاً' }; }
    try {
      const rows = await call('GET', 'id=eq.' + enc(id) + '&select=' + LIST_COLS);
      const R = rows && rows[0];
      if (which === 'cloud') {
        if (!R) return { ok: false, error: 'not in the cloud' };
        const r = await pull(id);
        if (!r) return { ok: false, error: 'could not read the cloud copy' };
        state.conflicts = state.conflicts.filter(c => c.id !== id);
        publish([id]);
        return { ok: true };
      }
      ws.bumpTo(id, Math.max(R ? +R.rev : 0, 0) + 1);
      await push(id, 0, !!R, true);
      state.conflicts = state.conflicts.filter(c => c.id !== id);
      publish([]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function soon(ms) {
    if (!enabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; sync(); }, ms == null ? 2500 : ms);
  }
  function start(everyMs) {
    if (!enabled) return;
    sync();
    poll = setInterval(sync, everyMs || 60000);
  }
  function stop() { if (timer) clearTimeout(timer); if (poll) clearInterval(poll); }

  /** Before an account signs out: its unsent entries must never go up under the next account. */
  function clearLog() { logQueue = []; if (logStore) logStore.save(logQueue); }

  return { sync, soon, start, stop, resolve, view, rpc, enabled, log: queueLog, clearLog };
}

module.exports = { makeCloud, TABLE };
