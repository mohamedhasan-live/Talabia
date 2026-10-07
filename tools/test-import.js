'use strict';
/*
 * The import scope, end to end through the real app: a file read as ONE DAY or
 * as a PERIOD, rows outside the scope flagged and never saved, rows without a
 * date never lumped onto a day or spread over many (the shop places each one),
 * the per-day summary shown before saving, and replace-or-add asked outright
 * whenever the file reaches a day that already has sales.
 *
 *   node tools/test-import.js            (dev build)
 *   DAFTAR_EXE=...\Talabia.exe node tools/test-import.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-import-'));
const DATA_FILE = path.join(PROFILE, 'branches', 'caneles-1', 'daftar.json');
const PORT = 9300 + Math.floor(Math.random() * 600);
const EXE = process.env.DAFTAR_EXE || null;

let pass = 0, fail = 0;
const pageErrors = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function launch() {
  const args = EXE
    ? ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT]
    : ['.', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  return spawn(EXE || ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* still booting */ }
    await sleep(500);
  }
  throw new Error('the app never exposed a debuggable page');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push('exception: ' + (d.exception && d.exception.description || d.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        pageErrors.push('console.error: ' + msg.params.args.map(a => a.value || a.description).join(' '));
      }
      if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    });
    const send = (method, params) => new Promise((res) => {
      const n = ++id; waiting.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate threw');
        return r.result.result.value;
      };
      resolve({ send, evaluate, close: () => ws.close() });
    });
  });
}
async function waitFor(cdp, expr, label, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cdp.evaluate('!!(' + expr + ')')) return true;
    await sleep(200);
  }
  throw new Error('timed out waiting for ' + label);
}
const { killOrphans } = require('./orphans');

/* ---------- the files ---------- */
const CAKE = 'كيكة الشوكولاتة - قطعة', CHEESE = 'تشيز كيك توت — قطعة';
function csv(rows) { return '﻿' + rows.map(r => r.join(',')).join('\n') + '\n'; }
// five days in May (outside the sample record), one row in April, two rows with no date
const PERIOD_FILE = csv([
  ['Date', 'Product', 'Quantity'],
  ['2026-05-01', CAKE, 10], ['2026-05-01', CHEESE, 4],
  ['2026-05-02', CAKE, 11],
  ['2026-05-03', CAKE, 12], ['2026-05-03', CHEESE, 6],
  ['2026-05-04', CAKE, 13],
  ['2026-05-05', CAKE, 14],
  ['2026-04-20', CAKE, 50],          // before the period the shop will choose
  ['', CAKE, 7],                     // no date
  ['', CHEESE, 3]                    // no date
]);
// one day: undated rows go on it, the same-day row too, the other days are flagged
const DAY_FILE = csv([
  ['Date', 'Product', 'Quantity'],
  ['', CAKE, 8], ['', CHEESE, 2],
  ['2026-05-10', CAKE, 1],
  ['2026-05-11', CAKE, 30], ['2026-05-12', CHEESE, 40]
]);
const NODATE_FILE = csv([['Product', 'Quantity'], [CAKE, 9], [CHEESE, 5]]);

function open(cdp, text, name) {
  return cdp.evaluate(`(function(){
    var f = new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, {type:"text/csv"});
    window.S.imp = null; startImport(f); return true;
  })()`);
}
function setInput(cdp, selector, value) {
  return cdp.evaluate(`(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("input", {bubbles:true})); return true;
  })()`);
}
const analysis = (cdp) => cdp.evaluate(`(function(){
  var a = analyzeImport();
  var days = {}; Object.keys(a.days).forEach(function(d){ days[d] = Math.round(a.days[d].qty*10)/10 });
  return JSON.stringify({scope:a.scope, days:days, entries:a.entries.length,
    outside:a.outside.map(function(o){return {date:o.date, rows:o.rows, qty:o.qty}}),
    undated:a.undated.map(function(u){return {row:u.row, qty:u.qty, date:u.date, placed:u.placed}}),
    clash:a.clashDays, needMode:importNeedsMode(a)});
})()`).then(JSON.parse);
const sold = (cdp, d, pid) => cdp.evaluate(`(function(){var r=window.S.days[${JSON.stringify(d)}];return r&&r.items[${JSON.stringify(pid)}]?r.items[${JSON.stringify(pid)}].sold:null})()`);

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('import scope test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await targets()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false && window.S.products.length > 0', 'the sample catalogue');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click()');
  await sleep(400);

  /* ---------- a period ---------- */
  console.log('--- a dated file opens as a period ---');
  await open(cdp, PERIOD_FILE, 'may.csv');
  await waitFor(cdp, 'window.S.imp && document.getElementById("impScope")', 'the import screen');
  let a = await analysis(cdp);
  check('a dated file opens as a period over its own dates (' + a.scope.from + ' → ' + a.scope.to + ')',
    a.scope.kind === 'period' && a.scope.from === '2026-04-20' && a.scope.to === '2026-05-05', JSON.stringify(a.scope));

  await setInput(cdp, '#impFrom', '2026-05-01');
  await waitFor(cdp, 'window.S.imp.from === "2026-05-01"', 'the new start');
  await setInput(cdp, '#impTo', '2026-05-05');
  await waitFor(cdp, 'window.S.imp.to === "2026-05-05"', 'the new end');
  a = await analysis(cdp);
  check('dated rows land on their own days (5 days)', JSON.stringify(Object.keys(a.days).sort()) ===
    JSON.stringify(['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05']), JSON.stringify(a.days));
  check('two products on one day are kept apart and summed per day (1 May = 14)', a.days['2026-05-01'] === 14, JSON.stringify(a.days));
  check('a row before the period is flagged', a.outside.length === 1 && a.outside[0].date === '2026-04-20' && a.outside[0].qty === 50, JSON.stringify(a.outside));
  check('the screen lists it as not to be saved', await cdp.evaluate('!!document.getElementById("impOutside")'));
  check('rows with no date are listed, not placed', a.undated.length === 2 && a.undated.every(u => !u.placed), JSON.stringify(a.undated));
  check('…and are not lumped onto any day (5 May still 14)', a.days['2026-05-05'] === 14, JSON.stringify(a.days));
  check('the screen asks the shop to place each undated row', await cdp.evaluate('document.querySelectorAll(".impUndated").length === 2'));

  const summary = JSON.parse(await cdp.evaluate(`(function(){
    var t = document.getElementById("impDays");
    return JSON.stringify({rows: t ? t.querySelectorAll("tbody tr").length : 0,
      first: t ? t.querySelector("tbody tr").innerText : "", foot: t && t.tFoot ? t.tFoot.innerText : ""});
  })()`));
  check('per-day summary before saving: one line per day (' + summary.rows + ')', summary.rows === 5, JSON.stringify(summary));
  check('each line shows its date, product count and quantity', /2026-05-01/.test(summary.first) && /\b2\b/.test(summary.first) && /14/.test(summary.first), summary.first);
  check('the summary has a total line', /5 يوماً/.test(summary.foot) && /\b70\b/.test(summary.foot), summary.foot);
  check('new days: no replace/add question, apply is live',
    !(await cdp.evaluate('!!document.getElementById("impModeAsk")')) && !a.needMode &&
    await cdp.evaluate('!document.getElementById("impApply").disabled'));

  // place one undated row inside the period, try the other outside it
  const rows = a.undated.map(u => u.row);
  await setInput(cdp, '#impU' + rows[0], '2026-05-03');
  await waitFor(cdp, 'window.S.imp.undated[' + rows[0] + '] === "2026-05-03"', 'the first placement');
  await cdp.evaluate('window.S.imp.undated[' + rows[1] + '] = "2026-04-01"; render(); true');
  a = await analysis(cdp);
  check('a placed row joins its day (3 May = 12+6+7 = 25)', a.days['2026-05-03'] === 25, JSON.stringify(a.days));
  check('a row placed outside the period stays out', a.undated.find(u => u.row === rows[1]).placed === false &&
    !a.days['2026-04-01'], JSON.stringify(a.undated));

  await cdp.evaluate('document.getElementById("impApply").click()');
  await waitFor(cdp, '!window.S.imp', 'the import to finish');
  check('saved: 1 May cake 10, cheesecake 4', (await sold(cdp, '2026-05-01', 'p01')) === 10 && (await sold(cdp, '2026-05-01', 'p02')) === 4);
  check('saved: the placed row on 3 May (12+7 = 19)', (await sold(cdp, '2026-05-03', 'p01')) === 19);
  check('not saved: the row outside the period', !(await cdp.evaluate('!!window.S.days["2026-04-20"]')));
  check('not saved: the row left without a day', !(await cdp.evaluate('!!window.S.days["2026-04-01"]')) &&
    (await sold(cdp, '2026-05-03', 'p02')) === 6);
  await sleep(1500);
  let disk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('DISK: the five May days written', ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05'].every(d => disk.days[d]) &&
    disk.days['2026-05-05'].items.p01.sold === 14 && !disk.days['2026-04-20'], Object.keys(disk.days).filter(k => k < '2026-06').join(','));

  /* ---------- the same days again: replace or add is asked ---------- */
  console.log('\n--- the same days again ---');
  await open(cdp, PERIOD_FILE, 'may-again.csv');
  await waitFor(cdp, 'window.S.imp && document.getElementById("impScope")', 'the second import');
  await setInput(cdp, '#impFrom', '2026-05-01');
  await waitFor(cdp, 'window.S.imp.from === "2026-05-01"', 'the start');
  a = await analysis(cdp);
  check('the days that already have sales are named (' + a.clash.length + ')', a.clash.length === 5, JSON.stringify(a.clash));
  check('the question is on screen and apply is held', await cdp.evaluate('!!document.getElementById("impModeAsk") && document.getElementById("impApply").disabled'));
  check('those days are marked on the summary', await cdp.evaluate('document.getElementById("impDays").innerText.indexOf("اختر أدناه") >= 0'));
  await cdp.evaluate('applyImport(); true');
  check('even a direct save is refused until the shop chooses', (await sold(cdp, '2026-05-01', 'p01')) === 10 && await cdp.evaluate('!!window.S.imp'));
  await cdp.evaluate('document.getElementById("impModeAdd").click()');
  await waitFor(cdp, '!document.getElementById("impApply").disabled', 'apply after choosing add');
  await cdp.evaluate('document.getElementById("impApply").click()');
  await waitFor(cdp, '!window.S.imp', 'the add import');
  check('add: 1 May cake 10 + 10 = 20', (await sold(cdp, '2026-05-01', 'p01')) === 20);

  await open(cdp, PERIOD_FILE, 'may-replace.csv');
  await waitFor(cdp, 'window.S.imp && document.getElementById("impScope")', 'the third import');
  await setInput(cdp, '#impFrom', '2026-05-01');
  await waitFor(cdp, 'window.S.imp.from === "2026-05-01"', 'the start');
  await cdp.evaluate('document.getElementById("impModeRep").click()');
  await waitFor(cdp, '!document.getElementById("impApply").disabled', 'apply after choosing replace');
  await cdp.evaluate('document.getElementById("impApply").click()');
  await waitFor(cdp, '!window.S.imp', 'the replace import');
  check('replace: back to 10', (await sold(cdp, '2026-05-01', 'p01')) === 10);
  check('replace puts 3 May back to the file (cake 12, cheesecake 6)', (await sold(cdp, '2026-05-03', 'p01')) === 12 &&
    (await sold(cdp, '2026-05-03', 'p02')) === 6);

  /* ---------- one day ---------- */
  console.log('\n--- one day ---');
  await open(cdp, DAY_FILE, 'day.csv');
  await waitFor(cdp, 'window.S.imp && document.getElementById("impScope")', 'the day import');
  await cdp.evaluate('document.getElementById("impScopeDay").click()');
  await waitFor(cdp, 'window.S.imp.scope === "day" && document.getElementById("impSingleDate")', 'the day picker');
  await setInput(cdp, '#impSingleDate', '2026-05-10');
  await waitFor(cdp, 'window.S.imp.singleDate === "2026-05-10"', 'the day');
  await sleep(500);
  a = await analysis(cdp);
  check('only the chosen day is written', JSON.stringify(Object.keys(a.days)) === '["2026-05-10"]', JSON.stringify(a.days));
  check('undated rows and the same-day row land on it (8+2+1 = 11)', a.days['2026-05-10'] === 11, JSON.stringify(a.days));
  check('rows dated on other days are flagged', a.outside.length === 2 && a.outside.map(o => o.date).join() === '2026-05-11,2026-05-12', JSON.stringify(a.outside));
  check('…and shown as not to be saved', await cdp.evaluate('!!document.getElementById("impOutside")'));
  check('no undated list in single-day mode', a.undated.length === 0);
  check('a new day: no replace/add question', a.clash.length === 0 && !a.needMode, JSON.stringify(a.clash));
  await waitFor(cdp, 'document.getElementById("impApply") && !document.getElementById("impApply").disabled', 'apply for the day');
  await cdp.evaluate('document.getElementById("impApply").click()');
  await waitFor(cdp, '!window.S.imp', 'the day import to finish');
  check('saved on 10 May: cake 9, cheesecake 2', (await sold(cdp, '2026-05-10', 'p01')) === 9 && (await sold(cdp, '2026-05-10', 'p02')) === 2);
  check('not saved: 11 and 12 May', !(await cdp.evaluate('!!window.S.days["2026-05-11"] || !!window.S.days["2026-05-12"]')));

  /* ---------- a file with no date column ---------- */
  console.log('\n--- no date column ---');
  await open(cdp, NODATE_FILE, 'totals.csv');
  await waitFor(cdp, 'window.S.imp && document.getElementById("impScope")', 'the undated import');
  a = await analysis(cdp);
  check('a file with no date column opens as one day', a.scope.kind === 'day');
  // as a period, nothing may be placed until the shop places it
  await cdp.evaluate('document.getElementById("impScopePeriod").click()');
  await waitFor(cdp, 'window.S.imp.scope === "period" && document.getElementById("impUndated")', 'the period view');
  a = await analysis(cdp);
  check('as a period, every row waits for a day and nothing is saved', a.entries === 0 && a.undated.length === 2 &&
    await cdp.evaluate('document.getElementById("impApply").disabled'), JSON.stringify(a));
  await setInput(cdp, '#impFrom', '2026-05-15');
  await waitFor(cdp, 'window.S.imp.from === "2026-05-15"', 'the start');
  await setInput(cdp, '#impTo', '2026-05-20');
  await waitFor(cdp, 'window.S.imp.to === "2026-05-20"', 'the end');
  await setInput(cdp, '#impUndatedAll', '2026-05-16');
  await waitFor(cdp, 'Object.keys(window.S.imp.undated).length === 2', 'all rows placed');
  a = await analysis(cdp);
  check('"place all on one day" places every row there (9+5 = 14)', JSON.stringify(a.days) === '{"2026-05-16":14}', JSON.stringify(a.days));
  await cdp.evaluate('document.getElementById("impUndatedClear").click()');
  await waitFor(cdp, 'Object.keys(window.S.imp.undated).length === 0', 'the rows cleared');
  check('"leave all" takes them back out', (await analysis(cdp)).entries === 0);
  await cdp.evaluate('document.getElementById("impCancel2").click()');
  await waitFor(cdp, '!window.S.imp', 'cancel');
  check('cancel saves nothing', !(await cdp.evaluate('!!window.S.days["2026-05-16"]')));

  /* ---------- date formats: only a real d/m ambiguity asks ---------- */
  console.log('\n--- date formats ---');
  const fmtCase = async (rows, name) => {
    await open(cdp, csv(rows), name);
    await waitFor(cdp, 'window.S.imp && window.S.imp.fileName === ' + JSON.stringify(name) + ' && document.getElementById("impScope")', name);
    const r = JSON.parse(await cdp.evaluate('JSON.stringify({amb: window.S.imp.fmtAmbiguous, fmt: window.S.imp.dateFmt, ask: !!document.getElementById("impFmtDmy"), days: Object.keys(analyzeImport().days)})'));
    await cdp.evaluate('document.getElementById("impCancel2").click()');
    await waitFor(cdp, '!window.S.imp', 'cancel');
    return r;
  };
  let fc = await fmtCase([['Date', 'Product', 'Quantity'], ['2026-05-01', CAKE, 1], ['2026-05-02', CAKE, 1]], 'iso.csv');
  check('yyyy-mm-dd never asks day/month vs month/day', fc.amb === false && fc.ask === false && fc.days.join() === '2026-05-01,2026-05-02', JSON.stringify(fc));
  fc = await fmtCase([['Date', 'Product', 'Quantity'], ['2026/05/01 10:30:00', CAKE, 1]], 'iso-time.csv');
  check('yyyy/mm/dd with a time never asks either', fc.amb === false && fc.ask === false && fc.days.join() === '2026-05-01', JSON.stringify(fc));
  fc = await fmtCase([['Date', 'Product', 'Quantity'], ['01/02/2026', CAKE, 1], ['03/04/2026', CAKE, 1]], 'ambiguous.csv');
  check('01/02/2026 with nothing over 12 still asks', fc.amb === true && fc.ask === true, JSON.stringify(fc));
  fc = await fmtCase([['Date', 'Product', 'Quantity'], ['25/04/2026', CAKE, 1], ['03/04/2026', CAKE, 1]], 'dmy.csv');
  check('a day over 12 settles it as day/month', fc.amb === false && fc.fmt === 'dmy' && fc.ask === false && fc.days.sort().join() === '2026-04-03,2026-04-25', JSON.stringify(fc));

  /* ---------- the wording on the analysis and order screens ---------- */
  console.log('\n--- wording ---');
  const words = JSON.parse(await cdp.evaluate(`(function(){
    var keep = window.S.days, out = {};
    var p = activeProducts()[0];
    out.detail = renderProductDetail(productReport(p, {from:"2026-05-01", to:"2026-05-05"}));
    var few = {}; ["2026-05-01","2026-05-02","2026-05-03"].forEach(function(k){ few[k] = keep[k] });
    window.S.days = few; relearn(); out.few = renderOrder();
    window.S.days = {}; relearn(); out.none = renderOrder();
    window.S.days = keep; relearn();
    return JSON.stringify(out);
  })()`));
  check('the 7-day trend says it shows after 9 days', words.detail.indexOf('يظهر بعد 9 أيام') >= 0 && words.detail.indexOf('يحتاج') < 0);
  check('the 4-week trend says it shows after 30 days', words.detail.indexOf('يظهر بعد 30 يوماً') >= 0 && words.detail.indexOf('يحتاج') < 0);
  check('a short record reads as an early estimate, not a block', words.few.indexOf('تقديرٌ مبكّر') >= 0 &&
    words.few.indexOf('المقترح يعمل الآن') >= 0 && words.few.indexOf('لم يبدأ بعد') < 0);
  check('an empty record points to the import', words.none.indexOf('لا سجلّ بعد') >= 0 && words.none.indexOf('استورد') >= 0);

  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
