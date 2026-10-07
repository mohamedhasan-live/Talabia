'use strict';
/*
 * Bring the Odoo sales history into ONE branch through the app's own import —
 * the same name matching, aliases and per-day records as the Close-of-Day
 * import button — so it saves and syncs to the cloud exactly like a normal
 * import. Nothing is written into the JSON by hand.
 *
 *   node tools/import-odoo-history.js <folder or files...>            dry run: reports only
 *   node tools/import-odoo-history.js <folder or files...> --apply    imports
 *
 * Options:
 *   --branch=<text>   part of the branch name (default: النرجس)
 *   --brand=<key>     brand of that branch (default: caneles)
 *   --allow-unmatched apply a file even if some product names match nothing (they are left out and listed)
 *   --dmy / --mdy     settle an ambiguous d/m date column
 *
 * Rules:
 *   - The branch is found by brand + name; anything other than exactly one match stops the run.
 *   - Before anything is written, that branch is saved in the app's backup format
 *     (Settings → Data → restore) to C:\Users\moham\Talabia-backups\.
 *   - A day that already has recorded sales in the branch is NOT imported again; only missing days are added.
 *     "Already recorded" is decided once, before the first file, so several files that each cover part of a
 *     new day (split exports) add up; an identical file given twice is refused.
 *   - Rows without a readable date, and product names that match nothing, are listed, never guessed.
 *
 * It drives the INSTALLED app on this Windows account (its real data and cloud session), so Talabia must be
 * closed first; the script closes it gracefully if it is open.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const APPLY = flag('apply');
const BRANCH_TEXT = opt('branch', 'النرجس');
const BRAND = opt('brand', 'caneles');
const DATE_FMT = flag('mdy') ? 'mdy' : flag('dmy') ? 'dmy' : null;
const EXE = process.env.DAFTAR_EXE || 'C:\\Program Files\\Talabia\\Talabia.exe';
const BACKUP_DIR = opt('backup-dir', path.join(os.homedir(), 'Talabia-backups'));
const PORT = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- the files ---------- */
const inputs = args.filter(a => !a.startsWith('--'));
if (!inputs.length) { console.error('usage: node tools/import-odoo-history.js <folder or files...> [--apply]'); process.exit(2); }
let files = [];
for (const p of inputs) {
  if (!fs.existsSync(p)) { console.error('not found: ' + p); process.exit(2); }
  if (fs.statSync(p).isDirectory()) {
    for (const f of fs.readdirSync(p)) if (/\.(csv|xlsx|xlsm|xls)$/i.test(f) && !f.startsWith('~$')) files.push(path.join(p, f));
  } else files.push(p);
}
files.sort();
if (!files.length) { console.error('no .csv / .xlsx files in ' + inputs.join(', ')); process.exit(2); }
const seen = new Map();
files = files.filter(f => {
  const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (seen.has(h)) { console.log('SKIP (identical to ' + path.basename(seen.get(h)) + '): ' + path.basename(f)); return false; }
  seen.set(h, f); return true;
});

/*
 * Odoo's "POS orders report" (تقرير طلبات نقطة البيع) has no date column: a title line naming the shop,
 * "الفترة: من A إلى B", the export time, then the table. A one-day period IS the date of every row; a longer
 * period is a total that cannot be split by day (never spread — it is refused). Read here with the same
 * spreadsheet library the app bundles, so row numbers match the app's own reading.
 */
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
function scan(f) {
  if (!/\.(xlsx|xlsm|xls)$/i.test(f)) return { headerIdx: 0, period: null, title: '', sig: null };
  const wb = XLSX.read(fs.readFileSync(f), { type: 'buffer', cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' });
  let period = null, title = '', headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const line = rows[i].map(x => String(x)).join(' ').trim();
    const m = line.match(/الفترة\s*:?\s*من\s*(\d{4}-\d{2}-\d{2})\s*إلى\s*(\d{4}-\d{2}-\d{2})/);
    if (m) period = { from: m[1], to: m[2] };
    if (/تقرير/.test(line) && !title) title = line;
    const cells = rows[i].map(x => String(x).trim());
    if (cells.some(x => /^(اسم المنتج|المنتج|product)$/i.test(x)) && cells.some(x => /^(الكمية|quantity)$/i.test(x))) { headerIdx = i; break; }
  }
  return { headerIdx, period, title, sig: JSON.stringify(rows.slice(headerIdx)) };
}
const scans = {};
for (const f of files) scans[f] = scan(f);
// the same day exported twice: identical tables are one export; different tables must be settled by a person
const byDay = {};
for (const f of files) { const p = scans[f].period; if (p && p.from === p.to) (byDay[p.from] = byDay[p.from] || []).push(f); }
const dupSkip = new Set();
for (const d of Object.keys(byDay)) {
  const list = byDay[d];
  for (let i = 1; i < list.length; i++) {
    if (scans[list[i]].sig === scans[list[0]].sig) { dupSkip.add(list[i]); console.log('SKIP (same day ' + d + ', same table as ' + path.basename(list[0]) + '): ' + path.basename(list[i])); }
    else { console.error('STOPPED: two different exports for ' + d + ': ' + path.basename(list[0]) + ' and ' + path.basename(list[i]) + ' — which one is right?'); process.exit(4); }
  }
}
files = files.filter(f => !dupSkip.has(f));
const foreign = files.filter(f => scans[f].title && scans[f].title.indexOf(opt('branch', 'النرجس')) < 0);
if (foreign.length) { console.error('STOPPED: these files name another shop: ' + foreign.map(f => path.basename(f) + ' («' + scans[f].title + '»)').join(', ')); process.exit(4); }

/* ---------- the app ---------- */
function talabiaRunning() {
  try { return /Talabia\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Talabia.exe', '/NH'], { encoding: 'utf8' })); }
  catch (e) { return false; }
}
async function closeTalabia() {
  if (!talabiaRunning()) return;
  console.log('Talabia is open — closing it gracefully (its work is saved as it goes) …');
  try { execFileSync('taskkill', ['/IM', 'Talabia.exe'], { stdio: 'ignore' }); } catch (e) { /* already closing */ }
  for (let i = 0; i < 40 && talabiaRunning(); i++) await sleep(250);
  if (talabiaRunning()) { console.error('Talabia did not close. Close it yourself and run again.'); process.exit(3); }
}
async function target() {
  for (let i = 0; i < 120; i++) {
    try {
      const p = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch (e) { /* booting */ }
    await sleep(500);
  }
  throw new Error('the app never opened its page');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map(); const errors = [];
    const send = (method, params) => new Promise(res => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      const ev = async (e) => {
        const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate threw');
        return r.result.result.value;
      };
      resolve({ send, ev, errors, close: () => ws.close() });
    });
  });
}
async function waitFor(c, expr, label, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await c.ev('!!(' + expr + ')')) return true; await sleep(300); }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  console.log((APPLY ? 'IMPORT' : 'DRY RUN (nothing is written; add --apply to import)') + ' — ' + files.length + ' file(s)');
  // --profile=<dir> runs against a throwaway data folder (for trying the tool), never the shop's
  const PROFILE = opt('profile', null);
  if (!PROFILE) await closeTalabia();
  const proc = spawn(EXE, (PROFILE ? ['--user-data-dir=' + PROFILE] : []).concat(['--remote-debugging-port=' + PORT]), { stdio: 'ignore', detached: false });
  const c = await connect((await target()).webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  await waitFor(c, 'window.S && S.ready && S.ws && S.ws.branches && S.ws.branches.length', 'the app and its branches');
  if (PROFILE && await c.ev('S.demo === true')) { await c.ev('document.getElementById("adopt").click(); 1'); await waitFor(c, 'S.demo === false', 'the sample catalogue'); }

  // the cloud should have had its say before we compare against the record
  const cloudOn = await c.ev('!!(S.cloud && S.cloud.enabled)');
  if (cloudOn) {
    try { await waitFor(c, 'S.cloud && S.cloud.status === "ok" && !S.cloud.running', 'the first sync', 45000); }
    catch (e) { throw new Error('the cloud is not in sync (' + await c.ev('JSON.stringify(S.cloud && {status:S.cloud.status, running:S.cloud.running})') + ') — sign in / fix that first'); }
  }

  /* ---------- the one branch ---------- */
  const found = JSON.parse(await c.ev(`JSON.stringify(S.ws.branches.filter(function(b){
    return b.brand === ${JSON.stringify(BRAND)} && b.name.indexOf(${JSON.stringify(BRANCH_TEXT)}) >= 0 }).map(function(b){return {id:b.id, name:b.name}}))`));
  if (found.length !== 1) {
    const all = await c.ev('JSON.stringify(S.ws.branches.map(function(b){return b.brand+" / "+b.name+" ("+b.id+")"}))');
    throw new Error('expected exactly one ' + BRAND + ' branch containing "' + BRANCH_TEXT + '", found ' + found.length + ': ' + all);
  }
  const br = found[0];
  console.log('branch: ' + br.name + ' (' + br.id + ', ' + BRAND + ')');
  if (await c.ev('S.branchId') !== br.id) await c.ev(`openBranch(${JSON.stringify(br.id)}); 1`);
  await waitFor(c, `S.branchId === ${JSON.stringify(br.id)} && S.ready && !S.demo`, 'the branch to open');

  /* ---------- what is already recorded (decided once) ---------- */
  const recorded = JSON.parse(await c.ev(`JSON.stringify(Object.keys(S.days).filter(function(k){
    var it=S.days[k].items||{}; return Object.keys(it).some(function(p){return (+it[p].sold||0)>0}) }).sort())`));
  console.log('days already recorded in the branch: ' + recorded.length + (recorded.length ? ' (' + recorded[0] + ' … ' + recorded[recorded.length - 1] + ')' : ''));

  /* ---------- backup before anything is written ---------- */
  if (APPLY) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bf = path.join(BACKUP_DIR, 'talabia-' + br.id + '-before-odoo-import-' + stamp + '.json');
    const data = JSON.parse(await c.ev('JSON.stringify(payload())'));
    fs.writeFileSync(bf, JSON.stringify(data, null, 2), 'utf8');      // the same format as "save a copy to file"
    console.log('backup: ' + bf);
  }

  const tStart = new Date().toISOString();
  const report = [];
  const newDaysSeen = {};
  for (const f of files) {
    const name = path.basename(f);
    const b64 = fs.readFileSync(f).toString('base64');
    await c.ev(`(function(){ S.imp=null; S.tab="entry";
      var bin=atob(${JSON.stringify(b64)}), u=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
      startImport(new File([u], ${JSON.stringify(name)})); return 1 })()`);
    await waitFor(c, `S.imp && S.imp.fileName === ${JSON.stringify(name)}`, 'reading ' + name, 30000);
    const sc = scans[f];
    // the report's own header row (under the title, period and export-time lines) is the table's head
    if (sc.headerIdx > 0) await c.ev(`(function(){ var imp=S.imp; imp.rows=imp.rows.slice(${sc.headerIdx});
      imp.headers=imp.rows[0].map(function(h){return String(h==null?"":h).trim()}); imp.cols=detectCols(imp.headers); return 1 })()`);
    const day = sc.period && sc.period.from === sc.period.to ? sc.period.from : null;
    const head = JSON.parse(await c.ev('JSON.stringify({cols:S.imp.cols, headers:S.imp.headers, amb:S.imp.fmtAmbiguous, fmt:S.imp.dateFmt, rows:S.imp.rows.length-1})'));
    const r = { file: name, rows: head.rows, columns: {}, skippedRecorded: [], added: [], undated: 0, unmatched: [], guesses: [], applied: false, note: '' };
    ['product', 'date', 'qty', 'unit'].forEach(k => { r.columns[k] = head.cols[k] >= 0 ? head.headers[head.cols[k]] : null; });
    report.push(r);
    if (head.cols.product < 0 || head.cols.qty < 0) { r.note = 'no product/quantity column found — skipped'; continue; }
    if (sc.period && !day) { r.note = 'a total for ' + sc.period.from + ' … ' + sc.period.to + ' with no day in it — it cannot be split by day (never spread); skipped'; continue; }
    if (day) r.columns.date = '(the report\'s period: ' + day + ')';
    if (head.cols.date < 0 && !day) { r.note = 'no date column — Odoo export must have one line per product per day; skipped'; continue; }
    if (day && recorded.indexOf(day) >= 0) { r.skippedRecorded = [day]; r.note = 'nothing new to add'; continue; }
    if (head.amb && !DATE_FMT && !day) { r.note = 'dates could be d/m or m/d (no day above 12) — run again with --dmy or --mdy; skipped'; continue; }
    if (DATE_FMT) await c.ev(`S.imp.dateFmt=${JSON.stringify(DATE_FMT)}; 1`);

    // keep only the rows of days the branch has not recorded yet; never touch a recorded day
    const cut = JSON.parse(await c.ev(`(function(){
      var rec=${JSON.stringify(recorded)}, set={}; rec.forEach(function(d){set[d]=1});
      var imp=S.imp, dc=imp.cols.date, keep=[imp.rows[0]], skipped={}, day=${JSON.stringify(day)};
      if(day){
        // one day's report: every row is that day (a dated row for another day would be flagged by the scope)
        imp.scope="day"; imp.singleDate=day;
      }else{
        imp.rows.slice(1).forEach(function(r){
          var d=parseSheetDate(r[dc], imp.dateFmt);
          if(d&&set[d]){ skipped[d]=1; return }
          keep.push(r);
        });
        imp.rows=keep;
        var fr=fileDateRange(imp); imp.scope="period"; imp.from=fr?fr.from:null; imp.to=fr?fr.to:null;
      }
      imp.mode="add"; imp.modeChosen=true;
      imp.markClosed=true;                    // past days from Odoo are finished days
      var a=analyzeImport();
      return JSON.stringify({skipped:Object.keys(skipped).sort(), days:Object.keys(a.days).sort().map(function(d){return {d:d, products:a.days[d].items, qty:Math.round(a.days[d].qty*100)/100}}),
        undated:a.undated.length, noDate:a.noDate, future:a.future,
        unmatched:Object.keys(a.unmatched).map(function(k){return a.unmatched[k].name+" ("+Math.round(a.unmatched[k].qty*100)/100+")"}),
        guesses:Object.keys(a.guesses).map(function(k){var g=a.guesses[k], p=S.products.filter(function(x){return x.id===g.pid})[0]; return g.name+" → "+(p?p.name:g.pid)}),
        clash:a.clashDays, entries:a.entries.length, unitClash:Object.keys(a.unitClash).length});
    })()`));
    r.skippedRecorded = cut.skipped;
    r.added = cut.days;
    r.undated = cut.undated + cut.noDate;
    r.unmatched = cut.unmatched;
    r.guesses = cut.guesses;
    cut.days.forEach(x => { (newDaysSeen[x.d] = newDaysSeen[x.d] || []).push(name); });
    // a day this run added from an earlier file may get more products from this one; a day recorded before the run never
    const slipped = cut.clash.filter(d => recorded.indexOf(d) >= 0);
    if (slipped.length) { r.note = 'internal: recorded days slipped through (' + slipped.join(',') + ') — not applied'; continue; }
    if (cut.unitClash) r.note += 'unit column disagrees with a product\'s unit in ' + cut.unitClash + ' name(s) — check the app\'s unit; ';
    if (!cut.entries) { r.note += 'nothing new to add'; continue; }
    if (cut.unmatched.length && !flag('allow-unmatched')) { r.note += 'product names that match nothing — not applied (map them in the app, or run with --allow-unmatched)'; continue; }
    if (APPLY) {
      await c.ev('applyImport(); 1');
      await waitFor(c, '!S.imp', 'the import of ' + name, 30000);
      r.applied = true;
    }
  }
  await c.ev('S.imp=null; 1');

  if (APPLY && report.some(r => r.applied)) {
    await c.ev('flushSave(); 1');
    if (cloudOn) {
      await waitFor(c, `S.cloud && S.cloud.status==="ok" && !S.cloud.running && S.cloud.lastSync && S.cloud.lastSync > ${JSON.stringify(tStart)} && !(S.cloud.conflicts&&S.cloud.conflicts.length)`,
        'the cloud to take the import', 120000);
      console.log('cloud: in sync at ' + await c.ev('S.cloud.lastSync'));
    }
  }

  /* ---------- report ---------- */
  console.log('');
  for (const r of report) {
    console.log('== ' + r.file + '  (' + r.rows + ' rows; columns: product=' + r.columns.product + ', date=' + r.columns.date + ', qty=' + r.columns.qty + (r.columns.unit ? ', unit=' + r.columns.unit : '') + ')');
    if (r.skippedRecorded.length) console.log('   already recorded, skipped: ' + r.skippedRecorded.length + ' day(s): ' + r.skippedRecorded.join(', '));
    if (r.added.length) console.log('   ' + (r.applied ? 'ADDED' : 'would add') + ': ' + r.added.length + ' day(s): ' + r.added.map(x => x.d + ' [' + x.products + ' products, ' + x.qty + ']').join(', '));
    if (r.undated) console.log('   rows without a readable date (left out): ' + r.undated);
    if (r.guesses.length) console.log('   matched by reading the name (the app\'s usual smart match): ' + r.guesses.join(' | '));
    if (r.unmatched.length) console.log('   NO MATCH (left out): ' + r.unmatched.join(' | '));
    if (r.note) console.log('   note: ' + r.note);
  }
  const shared = Object.keys(newDaysSeen).filter(d => newDaysSeen[d].length > 1);
  if (shared.length) console.log('\nnote: ' + shared.length + ' new day(s) appear in more than one file; their rows ' + (APPLY ? 'were' : 'would be') + ' added together: ' + shared.join(', '));
  if (c.errors.length) console.log('\npage errors: ' + c.errors.join(' | '));
  fs.writeFileSync(path.join(os.tmpdir(), 'talabia-odoo-import-report.json'), JSON.stringify({ branch: br, apply: APPLY, recorded, report }, null, 2));

  await c.send('Browser.close').catch(() => {});
  c.close();
  setTimeout(() => { try { proc.kill(); } catch (e) {} process.exit(0); }, 1500);
})().catch(e => { console.error('\nSTOPPED: ' + (e && e.message || e)); process.exit(1); });
