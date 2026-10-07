'use strict';
/*
 * Backtesting — how accurate is the CURRENT forecast, as it is. Nothing in the app, the engine, the data or the
 * cloud is changed: the real app (src → app/index.html) runs on a temporary COPY of the branch's records, offline,
 * and for each test day D the page is made to know only the days before D:
 *     S.days ← days < D ;  relearn() (the real learnDow + learnProducts) ;  forecast(p, D) (the real one)
 * then compared with what was actually sold on D, and the page is put back as it was.
 *
 * Two result sets:
 *   STRICT       only days an import covered completely (imports[] complete — P0-1): a product's actual is its
 *                recorded sales, confirmed zeros included. Missing data never counts.
 *   PROVISIONAL  the older days (before coverage was recorded): only cells with recorded sales; a product not
 *                listed that day is missing, so zero-sale days are absent and the result is BIASED (labelled).
 * A product with no sale before D has no forecast of its own yet; it is counted apart, not scored.
 *
 *   node tools/backtest.js [--branch caneles-1] [--dev]   (default: the dev build in this folder)
 *   Results: reports/backtest-<branch>-<date>/  rows.csv, summary.json, summary.txt
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const BRANCH = arg('branch', 'caneles-1');
const DATA = path.join(process.env.APPDATA || '', 'daftar');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-backtest-'));
const PORT = 9300 + Math.floor(Math.random() * 600);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- a private copy of the shop's records (read only from the real folder) ----
function copyDir(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const f of fs.readdirSync(a)) {
    const s = path.join(a, f), t = path.join(b, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, t); else fs.copyFileSync(s, t);
  }
}
if (!fs.existsSync(path.join(DATA, 'branches', BRANCH, 'daftar.json'))) { console.error('no records for branch ' + BRANCH); process.exit(1); }
copyDir(path.join(DATA, 'branches'), path.join(PROFILE, 'branches'));
if (fs.existsSync(path.join(DATA, 'brands'))) copyDir(path.join(DATA, 'brands'), path.join(PROFILE, 'brands'));
fs.copyFileSync(path.join(DATA, 'workspace.json'), path.join(PROFILE, 'workspace.json'));
const realStamp = fs.statSync(path.join(DATA, 'branches', BRANCH, 'daftar.json')).mtimeMs;

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* booting */ }
    await sleep(500);
  }
  throw new Error('the app never exposed a debuggable page');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    const send = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
    ws.addEventListener('message', (ev) => { const msg = JSON.parse(ev.data); if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send,
      evaluate: async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate threw');
        return r.result.result.value;
      },
      close: () => ws.close()
    }));
  });
}
async function waitFor(cdp, expr, label, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if (await cdp.evaluate('!!(' + expr + ')')) return; } catch (e) { /* booting */ } await sleep(250); }
  throw new Error('timed out waiting for ' + label);
}

/*
 * Runs INSIDE the page, on the real engine. Every global the engine reads is put back afterwards.
 * Returns one row per (test day, product) with a recorded actual, and the cells set apart.
 */
// for comparison only, never picked on these days: how much the blend constant k and the score floor matter
const VARIANTS = [{ name: 'k=1', opt: { k: 1 } }, { name: 'k=5', opt: { k: 5 } }, { name: 'minScore=0.45', opt: { minScore: 0.45 } }];
const IN_PAGE = `(function(){
  var VARIANTS=${JSON.stringify(VARIANTS)};
  var full=S.days, keys=Object.keys(full).sort(), keepDow=S.dowIndex, keepModel=S.model;
  var rows=[], noHistory=[], skipped={missing:0};
  var mode=function(D){ var c=coverageOf(D); return c&&c.complete?"strict":"provisional" };
  try{
    for(var i=0;i<keys.length;i++){
      var D=keys[i], past={};
      for(var j=0;j<i;j++) past[keys[j]]=full[keys[j]];
      S.days=past; relearn();                                   // the real learning, on days before D only
      var dd=parseYmd(D), m=mode(D), rec=full[D];
      S.products.forEach(function(p){
        var e=rec.items?rec.items[p.id]:null;
        if(!hasSold(e)){ skipped.missing++; return }           // missing data: not an observation, never a zero
        var mo=S.model[p.id]||{n:0};
        if(!mo.n){ noHistory.push({date:D, product:p.name, actual:+e.sold}); return }
        var base=typeof forecastBase==="function"?forecastBase(p,dd):forecast(p,dd), row={date:D, mode:m, pid:p.id, product:p.name, forecast:base, actual:+e.sold,
                   dow:dd.getDay(), dom:dd.getDate(), histDays:i, prodObs:mo.n};
        if(typeof similarDays==="function"){                  // the same day, product and past: baseline vs + Similar Days
          var sd=similarDays(p,dd,base);
          row.sd=sd.final; row.lambda=sd.lambda; row.signal=sd.signal; row.neff=sd.neff; row.why=sd.why;
          row.sdDays=sd.days.map(function(x){return x.date+":"+(Math.round(x.qty*100)/100)+"@"+x.score.toFixed(2)}).join(" ");
          row.variants={};
          VARIANTS.forEach(function(v){ row.variants[v.name]=similarDays(p,dd,base,v.opt).final });
        }
        rows.push(row);
      });
    }
  } finally { S.days=full; S.dowIndex=keepDow; S.model=keepModel; relearn() }
  return JSON.stringify({rows:rows, noHistory:noHistory, skipped:skipped, days:keys.length, from:keys[0], to:keys[keys.length-1],
    products:S.products.length, events:S.events.map(function(e){return {name:e.name,from:e.from,to:e.to,mult:e.mult}}),
    imports:(S.imports||[]).length, settings:typeof SIMILAR_DAYS!=="undefined"?SIMILAR_DAYS:null});
})()`;

/* The leakage check: changing every day ON or AFTER D must not move the forecast for D. */
const LEAK = `(function(){
  var full=S.days, keys=Object.keys(full).sort(), out=[];
  try{
    [Math.floor(keys.length/2), keys.length-2].forEach(function(i){
      if(i<1||i>=keys.length) return;
      var D=keys[i], dd=parseYmd(D), run=function(days){ var past={}; keys.slice(0,i).forEach(function(k){past[k]=days[k]}); S.days=past; relearn();
        return S.products.map(function(p){return forecast(p,dd)})
          .concat(typeof similarDays==="function"?S.products.map(function(p){return similarDays(p,dd).final}):[]) };
      var a=run(full);
      var bent=JSON.parse(JSON.stringify(full)); keys.slice(i).forEach(function(k){ Object.keys(bent[k].items||{}).forEach(function(pid){ bent[k].items[pid].sold=(+bent[k].items[pid].sold||0)*10+7 }) });
      var b=run(bent);
      var g=true;
      if(typeof similarDays==="function"){
        // Similar Days' own guard: with D and every later day (bent) in memory, it must still read only days before D
        var past={}; keys.slice(0,i).forEach(function(k){past[k]=full[k]}); S.days=past; relearn();
        var bases=S.products.map(function(p){return forecastBase(p,dd)});
        var x=S.products.map(function(p,n){return similarDays(p,dd,bases[n]).final});
        S.days=bent; learnSimilar();
        var y=S.products.map(function(p,n){return similarDays(p,dd,bases[n]).final});
        g=x.every(function(v,n){return Math.abs(v-y[n])<1e-12});
      }
      out.push({date:D, same:a.every(function(x,n){return Math.abs(x-b[n])<1e-12}), sdGuard:g});
    });
  } finally { S.days=full; relearn() }
  return JSON.stringify(out);
})()`;

// ---- the numbers ----
const DOW = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const monthPos = d => d <= 10 ? '1–10 (بداية الشهر)' : d <= 20 ? '11–20 (منتصف الشهر)' : '21–آخره (نهاية الشهر)';
const payBand = d => d <= 5 ? '1–5 (بعد الراتب)' : d <= 10 ? '6–10' : d <= 15 ? '11–15' : d <= 20 ? '16–20' : d <= 24 ? '21–24 (قبل الراتب، ركود)' : d <= 26 ? '25–26' : '27–31 (الراتب)';
function metrics(list) {
  const n = list.length; if (!n) return { n: 0 };
  let sa = 0, sf = 0, se = 0, sb = 0, zeros = 0;
  list.forEach(r => { sa += r.actual; sf += r.forecast; se += Math.abs(r.forecast - r.actual); sb += r.forecast - r.actual; if (r.actual === 0) zeros++; });
  return { n, days: new Set(list.map(r => r.date)).size, products: new Set(list.map(r => r.pid)).size,
    actual: sa, forecast: sf, MAE: se / n, WAPE: sa > 0 ? se / sa : null, Bias: sa > 0 ? sb / sa : null, meanError: sb / n, actualZero: zeros };
}
function groupBy(list, f) { const g = {}; list.forEach(r => { const k = f(r); (g[k] = g[k] || []).push(r); }); const o = {}; Object.keys(g).forEach(k => { o[k] = metrics(g[k]); }); return o; }
const pct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
const num = v => v == null ? '—' : (Math.round(v * 100) / 100).toString();
function block(title, m) { return title + ': n=' + (m.n || 0) + (m.n ? ' · MAE ' + num(m.MAE) + ' · WAPE ' + pct(m.WAPE) + ' · Bias ' + pct(m.Bias) + ' · actual=0: ' + m.actualZero : ''); }

(async () => {
  console.log('backtest — branch ' + BRANCH + ', private copy in ' + PROFILE + '\n');
  const proc = spawn(ELECTRON, ['.', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT], { cwd: ROOT, stdio: 'ignore' });
  let cdp;
  try {
    cdp = await connect((await target()).webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await waitFor(cdp, 'window.S && window.S.ready && window.S.ws', 'the app');
    await cdp.evaluate(`openBranch(${JSON.stringify(BRANCH)}); 1`);
    await waitFor(cdp, `window.S.branchId===${JSON.stringify(BRANCH)} && window.S.ready && !window.S.demo`, 'the branch');
    await sleep(800);

    const leak = JSON.parse(await cdp.evaluate(LEAK));
    const res = JSON.parse(await cdp.evaluate(IN_PAGE));
    const sets = { strict: res.rows.filter(r => r.mode === 'strict'), provisional: res.rows.filter(r => r.mode === 'provisional') };

    const out = { branch: BRANCH, ranAt: new Date().toISOString(), record: { days: res.days, from: res.from, to: res.to, products: res.products, coverageRecords: res.imports },
      events: res.events, leakageCheck: leak, missingCellsSkipped: res.skipped.missing, noHistory: res.noHistory, sets: {} };
    for (const [k, list] of Object.entries(sets)) {
      out.sets[k] = {
        summary: metrics(list),
        perProduct: groupBy(list, r => r.product),
        byWeekday: groupBy(list, r => DOW[r.dow]),
        byMonthPosition: groupBy(list, r => monthPos(r.dom)),
        byPayBand: groupBy(list, r => payBand(r.dom)),
        byHistory: groupBy(list, r => r.histDays < 14 ? 'قبل 14 يوم سجلّ (نمط الأسبوع افتراضي 100%)' : 'بعد 14 يوم سجلّ (نمط مخلوط)')
      };
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const dir = path.join(ROOT, 'reports', 'backtest-' + BRANCH + '-' + stamp);
    fs.mkdirSync(dir, { recursive: true });
    const csv = ['mode,date,weekday,day_of_month,product,forecast,actual,abs_error,error,branch_history_days,product_observations,similar_forecast,similar_abs_error,lambda,signal,neff,similar_reason,similar_days']
      .concat(res.rows.map(r => [r.mode, r.date, DOW[r.dow], r.dom, '"' + r.product.replace(/"/g, '""') + '"', r.forecast.toFixed(3), r.actual,
        Math.abs(r.forecast - r.actual).toFixed(3), (r.forecast - r.actual).toFixed(3), r.histDays, r.prodObs,
        r.sd != null ? r.sd.toFixed(3) : '', r.sd != null ? Math.abs(r.sd - r.actual).toFixed(3) : '', r.lambda != null ? r.lambda.toFixed(3) : '',
        r.signal != null ? r.signal.toFixed(3) : '', r.neff != null ? r.neff.toFixed(2) : '', r.why || (r.sd != null ? 'used' : ''), '"' + (r.sdDays || '') + '"'].join(','))).join('\r\n');
    fs.writeFileSync(path.join(dir, 'rows.csv'), '﻿' + csv, 'utf8');

    const L = [];
    L.push('Backtest — ' + BRANCH + ' — ' + out.ranAt);
    L.push('Record: ' + res.days + ' days (' + res.from + ' → ' + res.to + '), ' + res.products + ' products, coverage records: ' + res.imports);
    L.push('Leakage check (days ≥ D changed ×10+7, forecast for D unchanged): ' + leak.map(x => x.date + ' ' + (x.same ? 'OK' : 'CHANGED') + ' / similar-days guard ' + (x.sdGuard ? 'OK' : 'LEAKS')).join(', '));
    // ---- Baseline vs Baseline + Similar Days: the same rows, so the same test days and products ----
    const cmpOf = (list, key) => {
      const pick = r => key === 'sd' ? r.sd : r.variants[key];
      const b = metrics(list), s = metrics(list.map(r => Object.assign({}, r, { forecast: pick(r) })));
      let better = 0, worse = 0, same = 0;
      list.forEach(r => { const d = Math.abs(pick(r) - r.actual) - Math.abs(r.forecast - r.actual); if (Math.abs(d) < 1e-9) same++; else if (d < 0) better++; else worse++; });
      return { baseline: b, similar: s, better, worse, unchanged: same };
    };
    const strictRows = res.rows.filter(r => r.mode === 'strict' && r.sd != null);
    if (strictRows.length) {
      const main = cmpOf(strictRows, 'sd');
      const perP = {};
      strictRows.forEach(r => { (perP[r.product] = perP[r.product] || []).push(r); });
      const pp = Object.entries(perP).map(([p, l]) => { const c = cmpOf(l, 'sd'); return { product: p, n: l.length, maeB: c.baseline.MAE, maeS: c.similar.MAE, delta: c.similar.MAE - c.baseline.MAE, better: c.better, worse: c.worse, active: l.filter(r => r.lambda > 0).length }; })
        .sort((a, b) => a.delta - b.delta);
      out.similarDays = { settings: res.settings, strict: main, perProduct: pp,
        active: strictRows.filter(r => r.lambda > 0).length, gated: strictRows.reduce((o, r) => { const k = r.why || 'used'; o[k] = (o[k] || 0) + 1; return o; }, {}),
        variants: Object.fromEntries(VARIANTS.map(v => [v.name, cmpOf(strictRows, v.name)])) };
      L.push('');
      L.push('=== BASELINE vs BASELINE + SIMILAR DAYS (STRICT rows, same days & products) ===');
      L.push('settings: ' + JSON.stringify(res.settings));
      L.push('rows: ' + strictRows.length + ' · Similar Days active (λ>0): ' + out.similarDays.active + ' · reasons: ' + JSON.stringify(out.similarDays.gated));
      L.push(block('Baseline     ', main.baseline));
      L.push(block('Similar Days ', main.similar));
      L.push('better: ' + main.better + ' · worse: ' + main.worse + ' · unchanged: ' + main.unchanged);
      L.push('-- per product (MAE change, best → worst)');
      pp.forEach(x => L.push('  ' + x.product + ': n=' + x.n + ' · active ' + x.active + ' · MAE ' + num(x.maeB) + ' → ' + num(x.maeS) + ' (' + (x.delta <= 0 ? '' : '+') + num(x.delta) + ') · better ' + x.better + ' / worse ' + x.worse));
      L.push('-- comparison only (not chosen on these days)');
      for (const v of VARIANTS) { const c = out.similarDays.variants[v.name]; L.push('  ' + v.name + ': MAE ' + num(c.similar.MAE) + ' · WAPE ' + pct(c.similar.WAPE) + ' · Bias ' + pct(c.similar.Bias) + ' · better ' + c.better + ' / worse ' + c.worse); }
    }
    L.push('Missing cells skipped (never counted as zero): ' + res.skipped.missing + ' · cells with no prior sale (not scored): ' + res.noHistory.length);
    for (const [k, s] of Object.entries(out.sets)) {
      L.push('');
      L.push('=== ' + (k === 'strict' ? 'STRICT (covered days only)' : 'PROVISIONAL (old days, recorded sales only — BIASED: zero days missing)') + ' ===');
      L.push(block('ALL', s.summary) + (s.summary.n ? ' · days ' + s.summary.days + ' · products ' + s.summary.products : ''));
      if (!s.summary.n) continue;
      L.push('-- per product (WAPE best → worst)');
      Object.entries(s.perProduct).sort((a, b) => (a[1].WAPE ?? 9) - (b[1].WAPE ?? 9)).forEach(([p, m]) => L.push('  ' + block(p, m)));
      for (const [t, g] of [['weekday', s.byWeekday], ['month position', s.byMonthPosition], ['pay band (PAY_CURVE)', s.byPayBand], ['branch history', s.byHistory]]) {
        L.push('-- by ' + t);
        Object.entries(g).forEach(([p, m]) => L.push('  ' + block(p, m)));
      }
    }
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(out, null, 1), 'utf8');
    fs.writeFileSync(path.join(dir, 'summary.txt'), L.join('\r\n'), 'utf8');
    console.log(L.join('\n'));
    console.log('\nreports in ' + dir);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* closing */ }
    proc.kill(); await sleep(800);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
    const now = fs.statSync(path.join(DATA, 'branches', BRANCH, 'daftar.json')).mtimeMs;
    console.log(now === realStamp ? 'real records untouched (same timestamp)' : 'WARNING: the real record file changed during the run');
  }
})().catch(e => { console.error('\nERROR: ' + (e && e.stack || e)); process.exit(1); });
