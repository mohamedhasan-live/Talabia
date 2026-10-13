'use strict';
/*
 * The branch workspace: which brands exist, which branches sit under each, and
 * where every branch keeps its own record.
 *
 *   <root>/workspace.json            the list of branches (+ .bak)
 *   <root>/branches/<id>/daftar.json one branch's whole record (+ .bak)
 *   <root>/trash/<id>-<stamp>/       a deleted branch, moved aside, never erased
 *
 * Every file goes through store.js, so each write is atomic and keeps a
 * previous generation. A branch never reads or writes another branch's file:
 * isolation is by folder, not by a filter inside one shared file.
 *
 * Cloud-ready by shape: each branch is one self-contained document with a
 * stable id, a revision counter and an updatedAt stamp (in the workspace entry
 * and inside the document's `meta`). A sync provider needs exactly that to push
 * a changed branch and to tell which side is newer. No provider is wired in;
 * `ws.sync` holds its settings when one is added.
 *
 * First run moves in the two stand-alone apps' records, read-only: the old
 * files are copied, never moved or changed, so the old apps still open.
 */
const fs = require('fs');
const path = require('path');
const { makeStore } = require('./store');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const now = () => new Date().toISOString();

function makeWorkspace({ root, brands, legacyRoot }) {
  if (!root) throw new Error('workspace root is required');
  if (!Array.isArray(brands) || !brands.length) throw new Error('at least one brand is required');

  const wsStore = makeStore(root, { sub: '', name: 'workspace' });
  const branchesDir = path.join(root, 'branches');
  const trashDir = path.join(root, 'trash');
  const brandKeys = brands.map(b => b.key);
  let ws = null;
  const notes = { migrated: [], resynced: [], rebuilt: false, errors: [] };

  function validId(id) { return typeof id === 'string' && ID_RE.test(id); }
  function branchStore(id) {
    if (!validId(id)) throw new Error('invalid branch id: ' + id);
    return makeStore(branchesDir, { sub: id, name: 'daftar' });
  }
  function brandOf(key) { return brands.find(b => b.key === key) || null; }
  function find(id) { return ws.branches.find(b => b.id === id) || null; }
  function brandFromId(id) {
    const k = brandKeys.find(k => id === k || id.startsWith(k + '-'));
    return k || brandKeys[0];
  }
  function newId(brand) {
    let id;
    do { id = brand + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
    while (find(id));
    return id;
  }
  function cleanName(n, fallback) {
    const s = String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 60);
    return s || fallback;
  }
  function persist() {
    const r = wsStore.save(ws);
    if (!r.ok) notes.errors.push('workspace: ' + r.error);
    return r;
  }
  function fileMtime(f) { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } }

  /** The old stand-alone app's file for a brand, if there is one. */
  function legacyStore(brand) {
    if (!legacyRoot || !brand || !brand.appName) return null;
    return makeStore(path.join(legacyRoot, brand.appName));
  }
  function readLegacy(brand) {
    const s = legacyStore(brand);
    if (!s) return null;
    const r = s.load();
    if (r.ok && r.data && Array.isArray(r.data.products)) {
      return { data: r.data, file: s.file, mtimeMs: fileMtime(r.recovered ? s.bak : s.file) };
    }
    return null;
  }

  /** Stamp a record with who it belongs to before it touches the disk. */
  function stamp(id, data, entry) {
    const out = Object.assign({}, data);
    out.meta = Object.assign({}, data.meta || {}, {
      branchId: id,
      brand: entry ? entry.brand : brandFromId(id),
      rev: entry ? entry.rev : 1,
      updatedAt: entry ? entry.updatedAt : now()
    });
    return out;
  }

  function normalize(w) {
    const out = { v: 1, branches: [], current: null, sync: w.sync || { provider: null },
      // «المحذوفات»: deleted branches, with the folder their data was moved to, so they can be put back
      trash: (Array.isArray(w.trash) ? w.trash : []).filter(t => t && validId(t.id)).slice(0, 200) };
    const seen = new Set();
    (Array.isArray(w.branches) ? w.branches : []).forEach(b => {
      if (!b || !validId(b.id) || seen.has(b.id)) return;
      seen.add(b.id);
      const brand = brandKeys.includes(b.brand) ? b.brand : brandFromId(b.id);
      out.branches.push(Object.assign({}, b, {
        brand,
        name: cleanName(b.name, (brandOf(brand) || {}).branch || b.id),
        rev: +b.rev || 1,
        updatedAt: b.updatedAt || b.createdAt || now()
      }));
    });
    out.current = out.branches.some(b => b.id === w.current) ? w.current
      : (out.branches[0] ? out.branches[0].id : null);
    return out;
  }

  /** workspace.json is gone or unreadable but branch folders exist: rebuild from them. */
  function rebuildFromDisk() {
    if (!fs.existsSync(branchesDir)) return null;
    const ids = fs.readdirSync(branchesDir).filter(validId).sort();
    const branches = [];
    ids.forEach(id => {
      const r = branchStore(id).load();
      if (!r.ok || !r.data) return;
      const m = r.data.meta || {};
      const brand = brandKeys.includes(m.brand) ? m.brand : brandFromId(id);
      branches.push({
        id, brand,
        name: cleanName(r.data.cfg && r.data.cfg.branch, (brandOf(brand) || {}).branch || id),
        createdAt: m.updatedAt || now(), rev: +m.rev || 1, updatedAt: m.updatedAt || now()
      });
    });
    return branches.length ? { v: 1, branches, current: branches[0].id } : null;
  }

  /** First run: one branch per brand, each carrying the old app's record when it exists. */
  function seed() {
    const w = { v: 1, branches: [], current: null, sync: { provider: null } };
    let firstWithData = null;
    brands.forEach(b => {
      const id = b.key + '-1';
      const entry = { id, brand: b.key, name: b.branch || b.productName || b.key,
                      createdAt: now(), rev: 1, updatedAt: now() };
      const legacy = readLegacy(b);
      if (legacy) {
        if (legacy.data.cfg && legacy.data.cfg.branch) entry.name = cleanName(legacy.data.cfg.branch, entry.name);
        const res = branchStore(id).save(stamp(id, legacy.data, entry));
        if (res.ok) {
          entry.legacy = { file: legacy.file, mtimeMs: legacy.mtimeMs, copiedAt: Date.now(), rev: entry.rev };
          notes.migrated.push({ id, brand: b.key, from: legacy.file,
            products: legacy.data.products.length, days: Object.keys(legacy.data.days || {}).length });
          if (!firstWithData) firstWithData = id;
        } else {
          notes.errors.push('migrate ' + b.key + ': ' + res.error);
        }
      }
      w.branches.push(entry);
    });
    w.current = firstWithData || w.branches[0].id;
    return w;
  }

  /*
   * The old app may still be open after the move. If it saved since, and this
   * branch has not been touched here since the copy, take the newer record
   * silently. If both sides changed, say so and let the owner choose.
   */
  function checkLegacy() {
    const conflicts = [];
    let changed = false;
    ws.branches.forEach(entry => {
      if (!entry.legacy || entry.legacy.dismissed) return;
      const lm = fileMtime(entry.legacy.file);
      if (!lm || lm <= entry.legacy.mtimeMs + 1) return;
      // untouched here = no save since the copy, told by the revision counter
      // rather than by clocks, which a quick save can tie
      const untouched = +entry.rev === +entry.legacy.rev;
      if (untouched) {
        const legacy = readLegacy(brandOf(entry.brand));
        if (legacy && adoptLegacyData(entry, legacy).ok) { notes.resynced.push(entry.id); changed = true; }
      } else {
        conflicts.push({ id: entry.id, brand: entry.brand, name: entry.name, legacyMtimeMs: lm });
      }
    });
    if (changed) persist();
    return conflicts;
  }
  function adoptLegacyData(entry, legacy) {
    entry.rev = (+entry.rev || 1) + 1;
    entry.updatedAt = now();
    const data = Object.assign({}, legacy.data, { cfg: Object.assign({}, legacy.data.cfg || {}, { branch: entry.name }) });
    const res = branchStore(entry.id).save(stamp(entry.id, data, entry));
    if (res.ok) entry.legacy = { file: legacy.file, mtimeMs: legacy.mtimeMs, copiedAt: Date.now(), rev: entry.rev };
    return res;
  }

  function init() {
    const r = wsStore.load();
    // an empty list is legitimate once an account has been told it holds no branches
    if (r.ok && r.data && Array.isArray(r.data.branches) && (r.data.branches.length || (r.data.sync && r.data.sync.access))) {
      ws = normalize(r.data);
      if (r.recovered) persist();
      return;
    }
    const rebuilt = rebuildFromDisk();
    if (rebuilt) { ws = normalize(rebuilt); notes.rebuilt = true; persist(); return; }
    ws = normalize(seed());
    persist();
  }
  init();

  function snapshot() { return JSON.parse(JSON.stringify(ws)); }

  return {
    root, branchesDir, trashDir, validId,
    fileOf: id => branchStore(id).file,
    dirOf: id => branchStore(id).dir,

    state() {
      const conflicts = checkLegacy();
      return { ok: true, ws: snapshot(), root, migrated: notes.migrated, resynced: notes.resynced,
               rebuilt: notes.rebuilt, errors: notes.errors.slice(), legacyNewer: conflicts };
    },

    load(id) {
      id = id || ws.current;
      const entry = find(id);
      if (!entry) return { ok: false, error: 'unknown branch: ' + id };
      const s = branchStore(id);
      return Object.assign(s.load(), { id, rev: entry.rev });
    },

    /*
     * baseRev, when given, is the revision the page loaded. If the branch moved
     * on underneath it (a newer copy pulled from the cloud), the write is
     * refused rather than laid over the newer record.
     */
    save(id, data, baseRev) {
      const entry = find(id);
      if (!entry) return { ok: false, error: 'unknown branch: ' + id };
      if (!data || typeof data !== 'object' || !Array.isArray(data.products)) return { ok: false, error: 'not a branch record' };
      if (baseRev != null && +baseRev !== +entry.rev) return { ok: false, stale: true, rev: entry.rev, error: 'the branch changed elsewhere' };
      entry.rev = (+entry.rev || 1) + 1;
      entry.updatedAt = now();
      const res = branchStore(id).save(stamp(id, data, entry));
      if (res.ok) persist();
      return Object.assign(res, { rev: entry.rev, updatedAt: entry.updatedAt });
    },

    add({ brand, name, data }) {
      if (!brandKeys.includes(brand)) return { ok: false, error: 'unknown brand: ' + brand };
      const nm = cleanName(name, '');
      if (!nm) return { ok: false, error: 'the branch needs a name' };
      const id = newId(brand);
      const entry = { id, brand, name: nm, createdAt: now(), rev: 1, updatedAt: now() };
      const rec = Object.assign({ v: 1, cfg: {}, products: [], days: {}, stock: {}, events: [], orders: {} }, data || {});
      rec.cfg = Object.assign({}, rec.cfg, { branch: nm });
      const res = branchStore(id).save(stamp(id, rec, entry));
      if (!res.ok) return res;
      ws.branches.push(entry);
      persist();
      return { ok: true, id, ws: snapshot() };
    },

    rename(id, name) {
      const entry = find(id);
      if (!entry) return { ok: false, error: 'unknown branch: ' + id };
      const nm = cleanName(name, entry.name);
      if (nm === entry.name) return { ok: true, ws: snapshot(), rev: entry.rev };
      entry.name = nm;
      // a rename is a change like any other, so it travels to the cloud
      entry.rev = (+entry.rev || 1) + 1;
      entry.updatedAt = now();
      const st = branchStore(id), r = st.load();
      if (r.ok && r.data) {
        const d = r.data; d.cfg = Object.assign({}, d.cfg || {}, { branch: nm });
        st.save(stamp(id, d, entry));
      }
      persist();
      return { ok: true, ws: snapshot(), rev: entry.rev };
    },

    setCurrent(id) {
      if (!find(id)) return { ok: false, error: 'unknown branch: ' + id };
      if (ws.current !== id) { ws.current = id; persist(); }
      return { ok: true, ws: snapshot() };
    },

    /** Deleting moves the folder into trash/; nothing is erased from the disk. */
    remove(id, opts) {
      const entry = find(id);
      if (!entry) return { ok: false, error: 'unknown branch: ' + id };
      if (ws.branches.length <= 1) return { ok: false, error: 'last branch' };
      const src = path.join(branchesDir, id);
      let movedTo = null;
      if (fs.existsSync(src)) {
        fs.mkdirSync(trashDir, { recursive: true });
        movedTo = path.join(trashDir, id + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
        try { fs.renameSync(src, movedTo); }
        catch (e) { return { ok: false, error: 'could not move the branch folder: ' + e.message }; }
      }
      ws.branches = ws.branches.filter(b => b.id !== id);
      if (ws.current === id) {
        const sameBrand = ws.branches.find(b => b.brand === entry.brand && !b.paused) || ws.branches.find(b => b.brand === entry.brand);
        ws.current = (sameBrand || ws.branches.find(b => !b.paused) || ws.branches[0]).id;
      }
      ws.trash = [{ id, brand: entry.brand, name: entry.name, at: now(), folder: movedTo, rev: +entry.rev || 1 }]
        .concat((ws.trash || []).filter(t => t.id !== id)).slice(0, 200);
      // remembered until the cloud has been told, so the delete reaches other devices
      if (!opts || !opts.fromCloud) {
        ws.sync.deleted = (ws.sync.deleted || []).filter(x => x !== id).concat(id);
      }
      persist();
      return { ok: true, ws: snapshot(), movedTo };
    },

    /** Put a deleted branch back: its folder returns, it rejoins its brand, and the cloud hears it is alive again. */
    restore(id) {
      const t = (ws.trash || []).find(x => x.id === id);
      if (!t) return { ok: false, error: 'لا يوجد في المحذوفات' };
      if (find(id)) return { ok: false, error: 'الفرع موجود بالفعل' };
      if (!brandKeys.includes(t.brand)) return { ok: false, error: 'brand', brand: t.brand };
      const dst = path.join(branchesDir, id);
      if (t.folder && fs.existsSync(t.folder) && !fs.existsSync(dst)) {
        try { fs.mkdirSync(branchesDir, { recursive: true }); fs.renameSync(t.folder, dst); }
        catch (e) { return { ok: false, error: 'could not move the folder back: ' + e.message }; }
      }
      ws.branches.push({ id, brand: t.brand, name: cleanName(t.name, id), createdAt: now(), rev: (+t.rev || 1) + 1, updatedAt: now() });
      ws.trash = ws.trash.filter(x => x.id !== id);
      ws.sync.deleted = (ws.sync.deleted || []).filter(x => x !== id);
      persist();
      return { ok: true, ws: snapshot() };
    },
    trashList() { return (ws.trash || []).slice(); },
    /** Pause a branch (hidden from the picker, every record kept) or bring it back. */
    setPaused(id, on) {
      const entry = find(id);
      if (!entry) return { ok: false, error: 'unknown branch: ' + id };
      if (on && !ws.branches.some(b => b.id !== id && !b.paused)) return { ok: false, error: 'لا يُوقف آخر فرع نشط' };
      if (on) entry.paused = true; else delete entry.paused;
      if (on && ws.current === id) {
        const same = ws.branches.find(b => b.brand === entry.brand && !b.paused);
        ws.current = (same || ws.branches.find(b => !b.paused)).id;
      }
      persist();
      return { ok: true, ws: snapshot() };
    },

    /* ---------- what the cloud sync needs ---------- */
    deviceId() {
      if (!ws.sync.deviceId) { ws.sync.deviceId = 'd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); persist(); }
      return ws.sync.deviceId;
    },
    entries() {
      return ws.branches.map(b => ({ id: b.id, brand: b.brand, name: b.name, rev: +b.rev || 1,
        cloudRev: +b.cloudRev || 0, hasFile: fs.existsSync(branchStore(b.id).file) }));
    },
    /** The rev and the record read together, in one synchronous step, so they always match. */
    snapshotFor(id) {
      const entry = find(id);
      if (!entry) return null;
      const r = branchStore(id).load();
      if (!r.ok || !r.data) return null;
      return { id, brand: entry.brand, name: entry.name, rev: +entry.rev || 1, updatedAt: entry.updatedAt, data: r.data };
    },
    markSynced(id, rev) {
      const entry = find(id);
      if (!entry) return false;
      entry.cloudRev = +rev;
      persist();
      return true;
    },
    /** Raise the local revision past both copies before a deliberate overwrite of the cloud. */
    bumpTo(id, rev) {
      const entry = find(id);
      if (!entry) return null;
      entry.rev = Math.max(+rev, (+entry.rev || 1) + 1);
      entry.updatedAt = now();
      const st = branchStore(id), r = st.load();
      if (r.ok && r.data) st.save(stamp(id, r.data, entry));
      persist();
      return entry.rev;
    },
    /** Take the cloud's copy of a branch, creating the branch here if this device lacks it. */
    applyRemote(row, expectRev) {
      if (!row || !validId(row.id) || !brandKeys.includes(row.brand)) return { ok: false, error: 'bad row' };
      if (!row.data || !Array.isArray(row.data.products)) return { ok: false, error: 'bad record' };
      let entry = find(row.id);
      if (entry && expectRev != null && +entry.rev !== +expectRev) return { ok: false, moved: true };
      const isNew = !entry;
      if (isNew) {
        entry = { id: row.id, brand: row.brand, name: cleanName(row.name, row.id), createdAt: now(), rev: +row.rev || 1, updatedAt: now() };
      }
      entry.brand = row.brand;
      entry.name = cleanName(row.name, entry.name);
      entry.rev = +row.rev || 1;
      entry.cloudRev = entry.rev;
      entry.updatedAt = row.updated_at || now();
      const d = Object.assign({}, row.data);
      d.cfg = Object.assign({}, d.cfg || {}, { branch: entry.name });
      const res = branchStore(row.id).save(stamp(row.id, d, entry));
      if (!res.ok) return res;
      if (isNew) ws.branches.push(entry);
      ws.sync.deleted = (ws.sync.deleted || []).filter(x => x !== row.id);
      persist();
      return { ok: true, isNew };
    },
    tombstones() { return (ws.sync.deleted || []).slice(); },
    /** What the signed-in account may see, as the cloud last said; null when signed out. */
    access() { return ws.sync.access ? JSON.parse(JSON.stringify(ws.sync.access)) : null; },
    setAccess(a) {
      // owner/perms/roleName come from talabia_me (supabase-roles.sql); absent on an older project
      // null = a project without roles (supabase-roles.sql not run yet): the app behaves as it did before
      let perms = null;
      if (a && a.perms && typeof a.perms === 'object') {
        perms = {};
        for (const k of Object.keys(a.perms)) if (/^[a-z]+\.[a-z]+$/.test(k) && a.perms[k] === true) perms[k] = true;
      }
      const next = a ? { role: a.role === 'admin' ? 'admin' : 'staff', branches: (a.branches || []).filter(validId), email: a.email || null,
                         owner: a.owner === true, roleName: typeof a.roleName === 'string' ? a.roleName.slice(0, 60) : null, perms,
                         name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : null,
                         roleId: typeof a.roleId === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(a.roleId) ? a.roleId : null } : null;
      if (JSON.stringify(next) === JSON.stringify(ws.sync.access || null)) return;
      if (next) ws.sync.access = next; else delete ws.sync.access;
      persist();
    },
    /**
     * Drop a branch this account may no longer see: its folder is removed from
     * this computer (the cloud keeps the master copy) and no delete is sent.
     */
    forget(id) {
      const entry = find(id);
      if (!entry) return false;
      try { fs.rmSync(path.join(branchesDir, id), { recursive: true, force: true }); } catch (e) { /* best effort */ }
      ws.branches = ws.branches.filter(b => b.id !== id);
      ws.sync.deleted = (ws.sync.deleted || []).filter(x => x !== id);
      if (ws.current === id) {
        const same = ws.branches.find(b => b.brand === entry.brand);
        ws.current = same ? same.id : (ws.branches[0] ? ws.branches[0].id : null);
      }
      persist();
      return true;
    },
    clearTombstone(id) { ws.sync.deleted = (ws.sync.deleted || []).filter(x => x !== id); persist(); },
    snapshot,

    /** Item and day counts for the branch list, read straight off each file. */
    stats() {
      const out = {};
      ws.branches.forEach(b => {
        const s = branchStore(b.id);
        let products = 0, days = 0, bytes = 0;
        try {
          const r = s.load();
          if (r.ok && r.data) {
            products = (r.data.products || []).length;
            days = Object.keys(r.data.days || {}).length;
          }
          bytes = fs.existsSync(s.file) ? fs.statSync(s.file).size : 0;
        } catch (e) { /* an unreadable file shows as empty, never blocks the list */ }
        out[b.id] = { products, days, bytes, hasFile: bytes > 0, updatedAt: b.updatedAt, rev: b.rev };
      });
      return { ok: true, stats: out };
    },

    legacyAdopt(id) {
      const entry = find(id);
      if (!entry || !entry.legacy) return { ok: false, error: 'no old app for this branch' };
      const legacy = readLegacy(brandOf(entry.brand));
      if (!legacy) return { ok: false, error: 'the old app file cannot be read' };
      const res = adoptLegacyData(entry, legacy);
      if (res.ok) persist();
      return Object.assign(res, { ws: snapshot() });
    },
    legacyDismiss(id) {
      const entry = find(id);
      if (!entry || !entry.legacy) return { ok: false, error: 'no old app for this branch' };
      entry.legacy.mtimeMs = fileMtime(entry.legacy.file) || entry.legacy.mtimeMs;
      persist();
      return { ok: true, ws: snapshot() };
    }
  };
}

module.exports = { makeWorkspace, ID_RE };
