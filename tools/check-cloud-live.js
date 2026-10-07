'use strict';
/*
 * Check the real Supabase project in cloud.json from the outside, the way a
 * stranger holding only the program (and so the anon key) would see it:
 *   - can the anon key read any branch?        it must not
 *   - can the anon key write or delete a row?  it must not
 * Also reports whether the tables exist. It never needs a password.
 *
 *   node tools/check-cloud-live.js
 */
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cloud.json'), 'utf8'));
const base = cfg.url.replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + '/rest/v1/';
const H = { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey, 'Content-Type': 'application/json' };
const probe = 'selftest-' + Date.now().toString(36);

(async () => {
  console.log('project: ' + cfg.url);
  let bad = 0;
  let res = await fetch(base + 'daftar_branches?select=id', { headers: H });
  let text = await res.text();
  if (res.status === 404 || /PGRST205|42P01/.test(text)) { console.log('TABLE daftar_branches MISSING — run the SQL from Settings > مكان التخزين'); process.exit(2); }
  const readable = res.ok ? JSON.parse(text).length : 0;
  console.log('anon read   : ' + (res.ok ? readable + ' row(s) visible' : 'refused (HTTP ' + res.status + ')') + (readable ? '   <-- OPEN TO ANYONE' : '   OK'));
  if (readable) bad++;

  res = await fetch(base + 'daftar_branches', { method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, H),
    body: JSON.stringify([{ id: probe, brand: 'selftest', name: 'selftest', rev: 1, deleted: true, device: 'security-check', data: { products: [] } }]) });
  const wrote = res.ok;
  console.log('anon write  : ' + (wrote ? 'ACCEPTED   <-- OPEN TO ANYONE' : 'refused (HTTP ' + res.status + ')   OK'));
  if (wrote) { bad++; await fetch(base + 'daftar_branches?id=eq.' + probe, { method: 'DELETE', headers: H }); }

  res = await fetch(base + 'rpc/talabia_am_i_member', { method: 'POST', headers: H, body: '{}' });
  text = await res.text();
  if (res.status === 404 || /PGRST202|42883/.test(text)) { console.log('security SQL: NOT RUN YET — run supabase-security.sql'); bad++; }
  else console.log('member check: ' + (res.ok ? 'anon allowed to call it   <-- run supabase-security.sql again' : 'anon refused (HTTP ' + res.status + ')   OK'));
  if (res.ok) bad++;

  console.log(bad ? 'SECURITY: NOT LOCKED — run the SQL in Settings > مكان التخزين' : 'SECURITY: locked — only signed-in members can reach the data');
  process.exit(0);
})().catch(e => { console.log('CANNOT REACH: ' + e.message); process.exit(1); });
