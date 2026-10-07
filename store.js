'use strict';
const path = require('path');
const fs = require('fs');

/*
 * One JSON file holds everything. Two properties matter for a shop that will
 * run this twice a week for years:
 *
 *  - A write is atomic. The new content goes to a .tmp file, is flushed to the
 *    disk, and only then renamed over the real one. A crash or a power cut
 *    during a write leaves the previous file untouched, never a half-written one.
 *  - There is always a second copy. The outgoing file is kept as .bak, so a
 *    file damaged outside this app still leaves one good generation to fall
 *    back to.
 */
function makeStore(baseDir, opts) {
  // Defaults keep the original layout: <base>/data/daftar.json. The branch
  // workspace reuses the same guarantees for its own files by naming them.
  const o = Object.assign({ sub: 'data', name: 'daftar' }, opts || {});
  const dir = o.sub ? path.join(baseDir, o.sub) : baseDir;
  const file = path.join(dir, o.name + '.json');
  const bak = path.join(dir, o.name + '.bak.json');
  const tmp = file + '.tmp';

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function readFrom(f) {
    if (!fs.existsSync(f)) return null;
    const raw = fs.readFileSync(f, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  }

  function load() {
    let firstError = null;
    for (const f of [file, bak]) {
      try {
        const data = readFrom(f);
        if (data) return { ok: true, data, path: file, recovered: f === bak };
      } catch (e) {
        if (!firstError) firstError = e;
      }
    }
    if (firstError) return { ok: false, error: String(firstError.message || firstError), path: file };
    return { ok: true, data: null, path: file };
  }

  function save(data) {
    try {
      ensureDir();
      const text = JSON.stringify(data);
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, bak);
      } catch (e) { /* a missing backup must never block the real save */ }
      fs.renameSync(tmp, file);
      return { ok: true, path: file, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  function exportTo(target, data) {
    try {
      fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  return { dir, file, bak, load, save, exportTo, ensureDir };
}

module.exports = { makeStore };
