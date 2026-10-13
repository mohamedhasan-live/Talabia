'use strict';
/*
 * Similar Days - the second opinion inside forecast(), on the real page with synthetic days (a throwaway profile):
 *   - a covered day (complete import) with an active product absent = a confirmed 0 and a candidate
 *   - a day with no import, or an incomplete one, is missing data: never a candidate
 *   - only days strictly before the target day (and before today); later days in memory change nothing
 *   - the same weekday or nothing; an occasion's days only for an occasion, never for an ordinary day
 *   - the weighted signal and lambda = Neff/(Neff+k) against an independent calculation
 *   - fewer than 2 similar days, or too few observations: lambda = 0 and the current forecast unchanged
 *   - forecast() is forecastBase() while SIMILAR_DAYS.on is false, and the blend when it is on
 *
 *   node tools/test-similar.js            (dev build)
 *   DAFTAR_EXE=...Talabia.exe node tools/test-similar.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-similar-'));
const PORT = 9300 + Math.floor(Math.random() * 600);
const EXE = process.env.DAFTAR_EXE || null;

let pass = 0, fail = 0;
const pageErrors = [], dialogs = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + String(detail).slice(0, 400) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function launch() {
  const args = EXE ? ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT]
                   : ['.', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  return spawn(EXE || ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}
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
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') { const d = msg.params.exceptionDetails; pageErrors.push(d.exception && d.exception.description || d.text); }
      if (msg.method === 'Page.javascriptDialogOpening') { dialogs.push(msg.params.message); send('Page.handleJavaScriptDialog', { accept: true }); }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      const evaluate = async (expression) => {
        const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
          sleep(20000).then(() => { throw new Error('the page stopped answering: ' + expression.slice(0, 80)); })]);
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate threw');
        return r.result.result.value;
      };
      resolve({ send, evaluate, close: () => ws.close() });
    });
  });
}
async function waitFor(cdp, expr, label, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if (await cdp.evaluate('!!(' + expr + ')')) return true; } catch (e) { /* reloading */ } await sleep(200); }
  throw new Error('timed out waiting for ' + label);
}
const { killOrphans } = require('./orphans');
const J = JSON.stringify;

// an independent copy of the score, from the stated rule (not from the page)
const W = { dow: 0.45, pay: 0.25, month: 0.15, recency: 0.15 };
const P = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const phase = d => { const x = d.getDate(); return x >= 27 ? x - 27 : x + new Date(d.getFullYear(), d.getMonth(), 0).getDate() - 27; };
const part = d => d.getDate() <= 10 ? 0 : d.getDate() <= 20 ? 1 : 2;
function score(t, c) {
  const T = P(t), C = P(c); let dp = Math.abs(phase(T) - phase(C)); dp = Math.min(dp, Math.max(0, 30 - dp));
  return W.dow * (T.getDay() === C.getDay() ? 1 : 0) + W.month * (part(T) === part(C) ? 1 : 0) + W.pay * Math.max(0, 1 - dp / 10)
    + W.recency * Math.exp(-Math.round((T - C) / 864e5) / 21);
}

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('similar days test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');

  // Fri 2026-08-28 is the target: day 28 (payday), end of the month. In memory only — nothing is saved.
  const T = '2026-08-28';
  await cdp.evaluate(`(function(){
    window.__keep={days:S.days, imports:S.imports, events:S.events, products:S.products, on:SIMILAR_DAYS.on};
    var it=function(o){var r={};Object.keys(o).forEach(function(k){r[k]={sold:o[k],waste:0,stockout:false}});return r};
    S.products=[{id:"X",name:"صنف X",shelfLife:5,packSize:1,moq:0,active:true,unit:"حبة"},
                {id:"Y",name:"صنف Y موقوف",shelfLife:5,packSize:1,moq:0,active:false,unit:"حبة"}];
    S.days={
      "2026-07-31":{date:"2026-07-31",items:it({})},          // Fri, covered, X absent: confirmed 0
      "2026-08-14":{date:"2026-08-14",items:it({X:3})},       // Fri, covered, mid-month, far from payday
      "2026-08-21":{date:"2026-08-21",items:it({X:6,Y:4})},   // Fri, covered
      "2026-08-24":{date:"2026-08-24",items:it({X:1})},       // Mon, import incomplete: missing
      "2026-08-25":{date:"2026-08-25",items:it({X:40})},      // Tue, no import at all: missing
      "2026-08-26":{date:"2026-08-26",items:it({X:2})},       // Wed, covered
      "2026-08-27":{date:"2026-08-27",items:it({X:50})},      // Thu, covered, same payday & month, the day before
      "2026-08-28":{date:"2026-08-28",items:it({X:99})},      // the target itself
      "2026-09-04":{date:"2026-09-04",items:it({X:99})}       // a later Friday
    };
    var cov=function(d,c){return {id:"i"+d,from:d,to:d,complete:c,mode:"replace"}};
    S.imports=["2026-07-31","2026-08-14","2026-08-21","2026-08-26","2026-08-27","2026-08-28","2026-09-04"].map(function(d){return cov(d,true)})
      .concat([cov("2026-08-24",false)]);
    S.events=[]; SIMILAR_DAYS.on=false; relearn(); return 1 })()`);
  const sd = async (pid, day, opt) => JSON.parse(await cdp.evaluate(`JSON.stringify((function(){ var p=S.products.filter(function(x){return x.id===${J(pid)}})[0];
    var r=similarDays(p,parseYmd(${J(day)}),null,${J(opt || {})}); r.dates=r.days.map(function(x){return x.date}); r.qty=r.days.map(function(x){return x.qty}); return r })())`));

  console.log('--- which days are candidates ---');
  const a = await sd('X', T);
  check('the two similar Fridays are used: 21/8 and 31/7', J(a.dates.slice().sort()) === J(['2026-07-31', '2026-08-21']), J(a.dates));
  check('a covered day with the active product absent counts as a confirmed 0', a.qty[a.dates.indexOf('2026-07-31')] === 0, J(a.days));
  check('the target day itself (99) is never used', a.dates.indexOf(T) < 0);
  check('a later day (4/9, 99) is never used, though it is in memory', a.dates.indexOf('2026-09-04') < 0);
  check('a day with no import (25/8) is missing data, not a candidate', a.dates.indexOf('2026-08-25') < 0);
  check('a day whose import was incomplete (24/8) is missing data, not a candidate', a.dates.indexOf('2026-08-24') < 0);
  check('Thursday 27/8 (same payday and month, one day earlier) is not a similar day for a Friday', a.dates.indexOf('2026-08-27') < 0);
  check('Friday 14/8 (mid-month, far from payday) falls under the floor', a.dates.indexOf('2026-08-14') < 0 && score(T, '2026-08-14') < 0.55, score(T, '2026-08-14'));

  console.log('\n--- the weighted signal and lambda ---');
  const s1 = score(T, '2026-08-21'), s2 = score(T, '2026-07-31');
  const sig = (s1 * 6 + s2 * 0) / (s1 + s2), neff = (s1 + s2) ** 2 / (s1 * s1 + s2 * s2), lam = neff / (neff + 3);
  check('scores match the stated weights (45/25/15/15)', Math.abs(a.days[a.dates.indexOf('2026-08-21')].score - s1) < 1e-9 && Math.abs(a.days[a.dates.indexOf('2026-07-31')].score - s2) < 1e-9, J([s1, s2, a.days]));
  check('signal = score-weighted average of the actual sales', Math.abs(a.signal - sig) < 1e-9, J([a.signal, sig]));
  check('lambda = Neff / (Neff + 3)', Math.abs(a.lambda - lam) < 1e-9 && Math.abs(a.neff - neff) < 1e-9, J([a.lambda, lam, a.neff, neff]));
  check('final = (1 - lambda) x current forecast + lambda x signal', Math.abs(a.final - ((1 - lam) * a.base + lam * sig)) < 1e-9 && a.base > 0, J(a));
  const base = await cdp.evaluate(`forecastBase(S.products[0],parseYmd(${J(T)}))`);
  check('the current forecast inside it is forecastBase, untouched', Math.abs(a.base - base) < 1e-12, J([a.base, base]));

  console.log('\n--- fewer than 2 similar days: the current forecast stands ---');
  const one = await sd('X', '2026-09-02');            // Wed: one covered Wednesday before it (26/8)
  check('one similar day: lambda = 0, final = current forecast', one.dates.length === 1 && one.lambda === 0 && one.final === one.base && one.why === 'too-few-similar-days', J(one));
  const none = await sd('X', '2026-09-01');           // Tue: the only Tuesday (25/8) has no import
  check('no similar day: lambda = 0, final = current forecast', none.dates.length === 0 && none.lambda === 0 && none.final === none.base, J(none));
  const few = await sd('X', T, { minObs: 99 });
  check('too few observations of the product: lambda = 0, final = current forecast', few.lambda === 0 && few.final === few.base && few.why === 'few-observations', J(few));

  console.log('\n--- a switched-off product absent from a file is not a zero ---');
  const y = await sd('Y', T);
  check('product Y (inactive): 31/7 not used as 0; only 21/8 where it sold', J(y.dates) === J(['2026-08-21']), J(y.dates));

  console.log('\n--- occasions ---');
  await cdp.evaluate(`S.events=[{id:"ev",name:"مناسبة",kind:"national",from:"2026-08-21",to:"2026-08-21",mult:1.45}]; relearn(); 1`);
  const ord = await sd('X', T);
  check('an ordinary day never borrows an occasion day (21/8 left out)', ord.dates.indexOf('2026-08-21') < 0, J(ord.dates));
  await cdp.evaluate(`S.events=[{id:"ev",name:"مناسبة",kind:"national",from:"2026-08-21",to:"2026-08-21",mult:1.45},{id:"ev2",name:"مناسبة",kind:"national",from:"2026-08-28",to:"2026-08-28",mult:1.45}]; relearn(); 1`);
  const evd = await sd('X', T);
  check('a day on an occasion looks at that kind of occasion only (21/8 in, 31/7 out)', J(evd.dates) === J(['2026-08-21']), J(evd.dates));
  await cdp.evaluate('S.events=[]; relearn(); 1');

  console.log('\n--- no leakage ---');
  await cdp.evaluate(`(function(){ S.days["2026-08-28"].items.X.sold=5000; S.days["2026-09-04"].items.X.sold=7000; return 1 })()`);
  const lk = await sd('X', T);
  check('changing the target day and a later day leaves Similar Days for the target unchanged', Math.abs(lk.signal - a.signal) < 1e-12 && Math.abs(lk.lambda - a.lambda) < 1e-12, J([lk.signal, a.signal]));
  const todayKey = await cdp.evaluate('ymd(today())');
  await cdp.evaluate(`(function(){ var t=ymd(today()); S.days[t]={date:t,items:{X:{sold:777,waste:0,stockout:false}}}; S.imports.push({id:"it",from:t,to:t,complete:true,mode:"replace"}); relearn(); return 1 })()`);
  const nextWeek = await cdp.evaluate('ymd(addDays(today(),7))');
  const tw = await sd('X', nextWeek);
  check('today (not over yet) is never a similar day, even when covered', tw.dates.indexOf(todayKey) < 0, J(tw.dates));

  console.log('\n--- forecast() ---');
  const f0 = JSON.parse(await cdp.evaluate(`JSON.stringify((function(){ var p=S.products[0], d=parseYmd(${J(T)}); SIMILAR_DAYS.on=false; var off=[forecast(p,d),forecastBase(p,d)];
    SIMILAR_DAYS.on=true; var on=[forecast(p,d),similarDays(p,d).final]; SIMILAR_DAYS.on=false; return {off:off,on:on} })())`));
  check('switched off: forecast() = the current forecast exactly', f0.off[0] === f0.off[1], J(f0));
  check('switched on: forecast() = the blend', Math.abs(f0.on[0] - f0.on[1]) < 1e-12 && f0.on[0] !== f0.off[0], J(f0));
  check('SIMILAR_DAYS.on ships false (nothing changes until the backtest is approved)', await cdp.evaluate('window.__keep.on===false'));

  await cdp.evaluate('(function(){ var k=window.__keep; S.days=k.days; S.imports=k.imports; S.events=k.events; S.products=k.products; SIMILAR_DAYS.on=k.on; relearn(); return 1 })()');
  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
