'use strict';
/*
 * The operational catalogue of a brand: its materials and operational items,
 * the links from sales products to operational items, its offers (bundles) and
 * its recipes, with optional per-branch overrides. One file per brand:
 *
 *   %APPDATA%\daftar\brands\<brand>.json   { rev, cloudRev, updatedAt, data }
 *
 * A brand's catalogue never touches another brand's: CANELÉS and CHEZZZ each
 * have their own file, their own cloud row, their own revision counter.
 * Revisions work like a branch's (see cloud.js): rev counts local saves,
 * cloudRev is the last revision both sides agreed on.
 */
const path = require('path');
const { makeStore } = require('./store');

const MAX_BYTES = 2000000;

function makeCatalogs({ root, brands }) {
  const keys = new Set((brands || []).map(b => b.key));
  const stores = new Map();
  const valid = b => typeof b === 'string' && keys.has(b);
  function store(brand) {
    if (!stores.has(brand)) stores.set(brand, makeStore(path.join(root, 'brands'), { sub: '', name: brand }));
    return stores.get(brand);
  }
  function read(brand) {
    const r = store(brand).load();
    const f = r.ok && r.data && typeof r.data === 'object' ? r.data : null;
    return f ? { rev: +f.rev || 0, cloudRev: +f.cloudRev || 0, updatedAt: f.updatedAt || null, data: f.data || null } : { rev: 0, cloudRev: 0, updatedAt: null, data: null };
  }
  function write(brand, rec) { return store(brand).save(rec); }

  function load(brand) {
    if (!valid(brand)) return { ok: false, error: 'unknown brand' };
    const f = read(brand);
    return { ok: true, brand, rev: f.rev, data: f.data };
  }
  /** A save from the page. baseRev is the revision the page last read; a newer one on disk means it is stale. */
  function save(brand, data, baseRev) {
    if (!valid(brand)) return { ok: false, error: 'unknown brand' };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'bad data' };
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_BYTES) return { ok: false, error: 'too large' };
    const f = read(brand);
    if (baseRev != null && +baseRev !== f.rev) return { ok: false, stale: true, rev: f.rev, data: f.data };
    const rec = { rev: f.rev + 1, cloudRev: f.cloudRev, updatedAt: new Date().toISOString(), data: Object.assign({}, data, { brand }) };
    const r = write(brand, rec);
    return r.ok ? { ok: true, brand, rev: rec.rev } : r;
  }
  function entries() {
    return [...keys].map(brand => { const f = read(brand); return { brand, rev: f.rev, cloudRev: f.cloudRev, has: !!f.data }; });
  }
  function snapshotFor(brand) { const f = read(brand); return f.data ? { brand, rev: f.rev, data: f.data } : null; }
  function markSynced(brand, rev) { const f = read(brand); if (!f.data) return; f.cloudRev = rev; if (f.rev < rev) f.rev = rev; write(brand, f); }
  /** Take the cloud's copy. A local edit the cloud never saw is kept aside first, never lost. */
  function applyRemote(row, keepLocalAside) {
    if (!valid(row.brand)) return { ok: false };
    const f = read(row.brand);
    if (keepLocalAside && f.data) {
      makeStore(path.join(root, 'brands'), { sub: '', name: row.brand + '-local-' + new Date().toISOString().replace(/[:.]/g, '-') }).save(f);
    }
    const rec = { rev: +row.rev || 1, cloudRev: +row.rev || 1, updatedAt: row.updated_at || new Date().toISOString(), data: Object.assign({}, row.data || {}, { brand: row.brand }) };
    const w = write(row.brand, rec);
    return w.ok ? { ok: true } : w;
  }
  return { load, save, entries, snapshotFor, markSynced, applyRemote, valid };
}

module.exports = { makeCatalogs };
