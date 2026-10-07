'use strict';
/*
 * P0-1 — sales data semantics: actual sales, confirmed zero, missing data.
 *   - a recorded 0 is a confirmed zero and counts in averages; a day with no sales figure is missing and does not
 *   - a wider date range creates no zero days; a product absent from a file is not made zero
 *   - the daily close: waste or a stockout tick alone leaves sales missing; a typed 0 is a confirmed zero; emptying the box is missing again
 *   - the import: a quantity written as 0 for a known product is a confirmed zero; a blank cell, an unknown name or a guessed name with 0 are not
 *
 *   node tools/test-zero-missing.js            (dev build)
 *   DAFTAR_EXE=...\Talabia.exe node tools/test-zero-missing.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-zero-'));
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

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('zero vs missing test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');

  // fixed days well before the sample record, so nothing else lands on them
  const D = await cdp.evaluate(`JSON.stringify([0,1,2,3,4,5,6,7,8,9,10,11,12,13].map(function(i){return ymd(addDays(today(),-200+i))}))`).then(JSON.parse);
  const before = JSON.parse(await cdp.evaluate('JSON.stringify({days:Object.keys(S.days).length, cells:Object.keys(S.days).reduce(function(s,k){return s+Object.keys(S.days[k].items||{}).length},0)})'));

  console.log('--- the semantics: 5, confirmed 0, missing, 7 ---');
  await cdp.evaluate(`(function(){
    var p={id:"zz",name:"صنف اختبار الصفر",shelfLife:5,packSize:1,moq:0,active:true,unit:"حبة"};
    S.products.push(p); saveProduct(p);
    var D=${J(D)};
    ensureDay(D[0]).items.zz={sold:5,waste:0,stockout:false}; saveDay(D[0]);
    ensureDay(D[1]).items.zz={sold:0,waste:0,stockout:false}; saveDay(D[1]);   // confirmed zero
    ensureDay(D[2]).items.p01={sold:9,waste:0,stockout:false}; saveDay(D[2]);  // the day has data, but not for zz: missing for zz
    ensureDay(D[3]).items.zz={sold:7,waste:0,stockout:false}; saveDay(D[3]);
    relearn(); return 1 })()`);
  const r1 = JSON.parse(await cdp.evaluate(`(function(){var p=S.products.filter(function(x){return x.id==="zz"})[0];
    var r=productReport(p,{from:${J(D[0])},to:${J(D[3])}}); return JSON.stringify({n:r.nDays,total:r.total,avg:r.dailyAvg,dates:r.series.map(function(x){return x.date}),qty:r.series.map(function(x){return x.qty})})})()`));
  check('a confirmed zero day is represented as 0', r1.qty.length === 3 && r1.qty[1] === 0, J(r1));
  check('a day with no figure for the product stays missing (not in its series)', r1.dates.indexOf(D[2]) < 0, J(r1.dates));
  check('average = (5 + 0 + 7) / 3 = 4, not / 4', Math.abs(r1.avg - 4) < 1e-9 && r1.n === 3, J(r1));

  console.log('\n--- a wider range creates no zero days ---');
  const r2 = JSON.parse(await cdp.evaluate(`(function(){var p=S.products.filter(function(x){return x.id==="zz"})[0];
    var r=productReport(p,{from:${J(D[0])},to:${J(D[9])}}); return JSON.stringify({n:r.nDays,avg:r.dailyAvg,days:Object.keys(S.days).filter(function(k){return k>=${J(D[4])}&&k<=${J(D[9])}}).length})})()`));
  check('selecting 10 days with data on 4 still gives 3 observations and average 4', r2.n === 3 && Math.abs(r2.avg - 4) < 1e-9, J(r2));
  check('…and no records were created for the uncovered days', r2.days === 0, J(r2));
  const pr = JSON.parse(await cdp.evaluate(`JSON.stringify((function(){var R=periodReport({from:${J(D[0])},to:${J(D[9])}}); return {days:R.days, keys:R.dayKeys}})())`));
  check('the period report counts only the 4 days that hold sales (D1–D4)', pr.days === 4, J(pr));

  console.log('\n--- the model learns from observations only ---');
  const m1 = JSON.parse(await cdp.evaluate('JSON.stringify(S.model.zz)'));
  check('the product model saw 3 observations (5, 0, 7)', m1 && m1.n === 3, J(m1));

  console.log('\n--- the daily close ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click(); 1');
  await waitFor(cdp, 'window.S.tab==="entry"', 'the close screen');
  await cdp.evaluate(`(function(){ S.entryDate=${J(D[5])}; render(); return 1 })()`);
  await waitFor(cdp, `window.S.entryDate===${J(D[5])}`, 'the day to open');
  await sleep(300);
  const typeInto = async (field, value) => {
    await cdp.evaluate(`(function(){ var i=document.querySelector('.entIn[data-pid="zz"][data-f="${field}"]'); i.value=${J(value)}; i.dispatchEvent(new Event("input",{bubbles:true})); i.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`);
    await sleep(500);
  };
  const hasWaste = await cdp.evaluate('!!document.querySelector(\'.entIn[data-pid="zz"][data-f="waste"]\')');
  if (hasWaste) {
    await typeInto('waste', '2');
    const w = JSON.parse(await cdp.evaluate(`JSON.stringify(S.days[${J(D[5])}].items.zz||null)`));
    check('waste typed alone: the waste is kept and sales stay missing (no sold:0)', w && w.waste === 2 && !('sold' in w), J(w));
    check('…so that day is not an observation', !(await cdp.evaluate(`hasSold(S.days[${J(D[5])}].items.zz)`)));
    check('…and the close still counts the product as not recorded', (await cdp.evaluate(`(function(){var e=S.days[${J(D[5])}].items.zz;return !e||e.sold==null||e.sold===""})()`)) === true);
  } else console.log('  (waste column off in this profile — skipped)');
  const hasChk = await cdp.evaluate('!!document.querySelector(\'.entChk[data-pid="zz"]\')');
  if (hasChk) {
    await cdp.evaluate(`(function(){ var c=document.querySelector('.entChk[data-pid="zz"]'); c.click(); return 1 })()`);
    await sleep(400);
    const c = JSON.parse(await cdp.evaluate(`JSON.stringify(S.days[${J(D[5])}].items.zz||null)`));
    check('a stockout tick alone does not create sold:0', c && c.stockout === true && !('sold' in c), J(c));
    await cdp.evaluate(`(function(){ var c=document.querySelector('.entChk[data-pid="zz"]'); c.click(); return 1 })()`);
    await sleep(300);
  }
  await typeInto('sold', '0');
  const z = JSON.parse(await cdp.evaluate(`JSON.stringify(S.days[${J(D[5])}].items.zz)`));
  check('a typed 0 is a confirmed zero (sold === 0)', z && z.sold === 0, J(z));
  check('…and it is an observation', await cdp.evaluate(`hasSold(S.days[${J(D[5])}].items.zz)`));
  await typeInto('sold', '');
  const e2 = JSON.parse(await cdp.evaluate(`JSON.stringify(S.days[${J(D[5])}].items.zz)`));
  check('emptying the box makes it missing again (no sold)', e2 && !('sold' in e2), J(e2));
  await typeInto('sold', '3');
  check('a typed 3 is recorded as 3', await cdp.evaluate(`S.days[${J(D[5])}].items.zz.sold===3`));

  console.log('\n--- the import ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click(); 1');
  const pname = await cdp.evaluate('S.products.filter(function(x){return x.id==="p01"})[0].name');
  const csv = 'Date,Product,Quantity\n' +
    D[7] + ',صنف اختبار الصفر,0\n' +            // known product, written 0 -> confirmed zero
    D[7] + ',' + pname + ',4\n' +              // known product, sold
    D[8] + ',صنف اختبار الصفر,\n' +             // blank quantity -> stays out
    D[8] + ',صنف لا يعرفه التطبيق,0\n' +         // unknown name with 0 -> no product, nothing recorded
    D[8] + ',' + pname + ',2\n';
  await cdp.evaluate(`(function(){ startImport(new File([${J(csv)}], "zero.csv", {type:"text/csv"})); return 1 })()`);
  await waitFor(cdp, 'window.S.imp && window.S.imp.rows', 'the import screen');
  const nProdsBefore = await cdp.evaluate('S.products.length');
  await cdp.evaluate('applyImport(); 1');
  await sleep(600);
  const imp = JSON.parse(await cdp.evaluate(`JSON.stringify({d7:S.days[${J(D[7])}]&&S.days[${J(D[7])}].items, d8:S.days[${J(D[8])}]&&S.days[${J(D[8])}].items, n:S.products.length, unknown:S.products.some(function(p){return p.name==="صنف لا يعرفه التطبيق"})})`));
  check('a quantity written 0 for a known product lands as a confirmed zero', imp.d7 && imp.d7.zz && imp.d7.zz.sold === 0, J(imp.d7));
  check('a sold quantity lands as before', imp.d7 && imp.d7.p01 && imp.d7.p01.sold === 4, J(imp.d7));
  check('a blank quantity cell is not read as zero (no record)', imp.d8 && !imp.d8.zz, J(imp.d8));
  check('an unknown name with 0 creates no product', !imp.unknown && imp.n === nProdsBefore, J(imp));
  check('a product absent from the file gets no record on that day (stays missing)', imp.d8 && Object.keys(imp.d8).length === 1 && imp.d8.p01, J(imp.d8));

  console.log('\n--- coverage: a full-day Odoo report for this branch ---');
  const branchName = await cdp.evaluate('(S.multi&&curBranch())?curBranch().name:S.cfg.branch');
  const report = (day, title, rows) => 'تقرير طلبات نقطة البيع: ' + title + ',,,,,\n' +
    'الفترة: من ' + day + ' إلى ' + day + ',,,,,\n' + 'تاريخ التصدير: ' + day + ' 03:22:02,,,,,\n' +
    'م,كود المنتج,اسم المنتج,الكمية,وحدة القياس,عدد الطلبات\n' +
    rows.map((r, i) => (i + 1) + ',,' + r[0] + ',' + r[1] + ',حبة,' + r[1]).join('\n') + '\n,,الإجمالي:,' + rows.reduce((s, r) => s + (+r[1] || 0), 0) + ',,\n';
  const importReport = async (csv, mode) => {
    await cdp.evaluate(`(function(){ startImport(new File([${J(csv)}], "pos.csv", {type:"text/csv"})); return 1 })()`);
    await waitFor(cdp, 'window.S.imp && window.S.imp.rows', 'the import screen');
    await cdp.evaluate(`(function(){ if(${J(mode || '')}){ S.imp.mode=${J(mode || 'replace')}; S.imp.modeChosen=true } applyImport(); return 1 })()`);
    await sleep(500);
  };
  // one product switched off before the import: it must get nothing
  await cdp.evaluate('(function(){ var p=S.products.filter(function(x){return x.id==="p12"})[0]; p.active=false; saveProduct(p); return 1 })()');
  const nActive = await cdp.evaluate('S.products.filter(function(p){return p.active!==false}).length');
  await importReport(report(D[4], 'CANELÈS | ' + branchName, [[pname, 6]]));
  const c4 = JSON.parse(await cdp.evaluate(`JSON.stringify({items:S.days[${J(D[4])}].items, cov:coverageOf(${J(D[4])})})`));
  check('the import is recorded as covering its day, complete', c4.cov && c4.cov.complete === true && c4.cov.from === D[4] && c4.cov.to === D[4], J(c4.cov));
  check('the listed product keeps its sale', c4.items.p01 && c4.items.p01.sold === 6, J(c4.items.p01));
  check('an active product the report does not list is a confirmed zero (sold:0)', c4.items.zz && c4.items.zz.sold === 0, J(c4.items.zz));
  check('every active product got a figure that day (sold or 0)', Object.keys(c4.items).filter(k => c4.items[k].sold != null).length === nActive, Object.keys(c4.items).length + ' / ' + nActive);
  check('a paused product gets nothing', !c4.items.p12, J(c4.items.p12));
  check('the record names the file, the period and how many zeros it wrote', c4.cov.file === 'pos.csv' && c4.cov.zeros === nActive - 1 && c4.cov.rows === 1, J(c4.cov));

  const avg5 = JSON.parse(await cdp.evaluate(`(function(){var p=S.products.filter(function(x){return x.id==="zz"})[0]; var r=productReport(p,{from:${J(D[0])},to:${J(D[4])}}); return JSON.stringify({n:r.nDays,avg:r.dailyAvg})})()`));
  check('averages now count the confirmed zero: 5, 0, missing, 7, 0 → 12/4 = 3', avg5.n === 4 && Math.abs(avg5.avg - 3) < 1e-9, J(avg5));

  console.log('\n--- what does NOT prove zeros ---');
  await importReport(report(D[6], 'CANELÈS | فرع آخر تماماً', [[pname, 2]]));
  const c6 = JSON.parse(await cdp.evaluate(`JSON.stringify({items:S.days[${J(D[6])}].items, cov:coverageOf(${J(D[6])})})`));
  check('a report naming another branch: its sales land, nothing else becomes zero', c6.items.p01 && c6.items.p01.sold === 2 && Object.keys(c6.items).length === 1, J(c6.items));
  check('…and its record says incomplete (branch)', c6.cov && c6.cov.complete === false && c6.cov.reason === 'branch', J(c6.cov));
  await importReport(report(D[10], 'CANELÈS | ' + branchName, [[pname, 3], ['صنف اختبار الصفر', '']]));
  const c10 = JSON.parse(await cdp.evaluate(`JSON.stringify({items:S.days[${J(D[10])}].items, cov:coverageOf(${J(D[10])})})`));
  check('a report with a row it could not read (blank quantity) proves no zeros', c10.items.p01 && Object.keys(c10.items).length === 1 && c10.cov.complete === false && c10.cov.reason === 'rows', J(c10));
  check('a day with no file has no record and no coverage (missing)', await cdp.evaluate(`!S.days[${J(D[11])}] && coverageOf(${J(D[11])})===null`));
  const wide = JSON.parse(await cdp.evaluate(`(function(){var p=S.products.filter(function(x){return x.id==="zz"})[0]; var r=productReport(p,{from:${J(D[9])},to:${J(D[13])}}); return JSON.stringify({n:r.nDays, made:[${J(D[11])},${J(D[12])},${J(D[13])}].filter(function(k){return !!S.days[k]}).length})})()`));
  check('a wide range over uncovered days creates nothing and counts nothing for the product', wide.n === 0 && wide.made === 0, J(wide));

  console.log('\n--- replace vs add on a day that already holds sales ---');
  await importReport(report(D[0], 'CANELÈS | ' + branchName, [[pname, 1]]), 'add');
  check('«add»: a sale the day already holds is kept (5 stays 5)', await cdp.evaluate(`S.days[${J(D[0])}].items.zz.sold===5`));
  await importReport(report(D[0], 'CANELÈS | ' + branchName, [[pname, 1]]), 'replace');
  check('«replace»: the file is the whole day — a product it does not list becomes 0', await cdp.evaluate(`S.days[${J(D[0])}].items.zz.sold===0`));
  check('…and the listed product is the file\'s figure', await cdp.evaluate(`S.days[${J(D[0])}].items.p01.sold===1`));
  check('every import is kept in the record, newest last', await cdp.evaluate('S.imports.length===6 && S.imports[S.imports.length-1].mode==="replace"'), await cdp.evaluate('JSON.stringify(S.imports.map(function(x){return [x.from,x.complete,x.reason,x.mode]}))'));

  console.log('\n--- the record survives a save and a reload of the branch ---');
  await sleep(1500);
  const disk = await cdp.evaluate('(function(){ var d=sanitizeRecord(JSON.parse(JSON.stringify(payload()))); return JSON.stringify({n:d.imports.length, first:d.imports[0]}) })()');
  const dd = JSON.parse(disk);
  check('the import record passes the record check (sanitizeRecord) intact', dd.n === 6 && dd.first.complete === false && dd.first.reason === 'no-period', disk);

  console.log('\n--- nothing else was touched ---');
  const after = JSON.parse(await cdp.evaluate('JSON.stringify({days:Object.keys(S.days).length, cells:Object.keys(S.days).reduce(function(s,k){return s+Object.keys(S.days[k].items||{}).length},0)})'));
  check('the sample record is all still there (only the test days were added)', after.days === before.days + 10 && after.cells >= before.cells, J({ before, after }));

  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
