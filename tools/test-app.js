'use strict';
/*
 * End-to-end: launch the real Electron app against a throwaway profile, drive
 * its actual UI over the DevTools protocol, then kill it and start it again to
 * prove the day's record came back off the disk. Also collects every console
 * error and uncaught exception the page throws while it runs.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-e2e-'));
// The combined app keeps each branch in its own folder; a fresh profile opens
// on the first brand's first branch.
const DATA_FILE = path.join(PROFILE, 'branches', 'caneles-1', 'daftar.json');
// A fresh port each run, so a lingering process from a previous run can never
// be mistaken for this one's app.
const PORT = 9300 + Math.floor(Math.random() * 600);

let pass = 0, fail = 0;
const pageErrors = [];
const dialogs = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + String(detail).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DOW_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const DOWN = (i) => (i == null ? '—' : DOW_AR[i]);

// DAFTAR_EXE points the same suite at the packaged executable instead of the
// dev build, so what ships is what was tested.
const EXE = process.env.DAFTAR_EXE || null;
function launch() {
  const args = EXE
    ? ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT]
    : ['.', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  return spawn(EXE || ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await res.json();
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
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      const send = (method, params) => new Promise((res) => {
        const n = ++id;
        waiting.set(n, res);
        ws.send(JSON.stringify({ id: n, method, params: params || {} }));
      });
      // Accept every confirm() the app raises, so a modal never stalls the run.
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method === 'Page.javascriptDialogOpening') {
          dialogs.push(m.params.type + ': ' + m.params.message);
          send('Page.handleJavaScriptDialog', { accept: true });
        }
      });
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) {
          throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate threw');
        }
        return r.result.result.value;
      };
      resolve({ send, evaluate, close: () => ws.close() });
    });
  });
}

/** Open Settings, wait for the switch to exist, then flip it. */
async function setToggle(cdp, id, on) {
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await waitFor(cdp, 'document.getElementById(' + JSON.stringify(id) + ')', 'the ' + id + ' switch');
  await cdp.evaluate(`(function(){
    var c = document.getElementById(${JSON.stringify(id)});
    c.checked = ${on ? 'true' : 'false'};
    c.dispatchEvent(new Event("change", {bubbles:true}));
    return true;
  })()`);
  await waitFor(cdp, `window.S.cfg && ${JSON.stringify(id)} !== null`, 'the change to settle');
  await sleep(400);
}

async function waitFor(cdp, expr, label, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cdp.evaluate('!!(' + expr + ')')) return true;
    await sleep(250);
  }
  throw new Error('timed out waiting for ' + label);
}

/* Clear any app left running by an earlier run — dozens of orphans starve the
   machine and make the next run look like a product failure. */
const { killOrphans } = require('./orphans');

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('end-to-end test, profile ' + PROFILE + '\n');
  console.log('--- first run: enter a day of sales ---');

  let proc = launch();
  const stderr = [];
  proc.stderr.on('data', d => stderr.push(d.toString()));

  let page = await targets();
  let cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  await waitFor(cdp, 'window.S && window.S.ready', 'the app to finish booting');
  check('app boots', true);
  check('desktop bridge is present', await cdp.evaluate('!!window.desktop'));
  check('app knows it is on the desktop', await cdp.evaluate('window.S.desktop === true'));
  check('data file path is reported', typeof (await cdp.evaluate('window.S.dataPath')) === 'string');
  check('opens on the demo (nothing saved yet)', await cdp.evaluate('window.S.demo === true'));

  // adopt the sample catalogue, exactly as a first-time user would
  await cdp.evaluate('document.getElementById("adopt").click()');
  await sleep(1500);
  check('demo adopted, now live data', await cdp.evaluate('window.S.demo === false'));
  check('catalogue loaded', (await cdp.evaluate('window.S.products.length')) === 15);
  check('data file written to disk', fs.existsSync(DATA_FILE), DATA_FILE);

  // record a day of trading through the real inputs
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click()');
  await sleep(600);
  const theDay = await cdp.evaluate('window.S.entryDate');
  check('daily-closing screen opens', typeof theDay === 'string' && theDay.length === 10);

  await cdp.evaluate(`(function(){
    function type(pid, field, val){
      var el = document.querySelector('.entIn[data-pid="'+pid+'"][data-f="'+field+'"]');
      el.value = String(val);
      el.dispatchEvent(new Event('input', {bubbles:true}));
    }
    type('p01','sold',37); type('p01','waste',3);
    type('p02','sold',24); type('p02','waste',0);
    var chk = document.querySelector('.entChk[data-pid="p02"]');
    chk.checked = true; chk.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`);
  await sleep(2000);

  check('sold figure held in memory', (await cdp.evaluate(`window.S.days[window.S.entryDate].items.p01.sold`)) === 37);
  check('waste figure held in memory', (await cdp.evaluate(`window.S.days[window.S.entryDate].items.p01.waste`)) === 3);
  check('stockout flag held in memory', (await cdp.evaluate(`window.S.days[window.S.entryDate].items.p02.stockout`)) === true);

  // close the day
  await cdp.evaluate('document.getElementById("closeDay").click()');
  await sleep(1500);
  check('day marked closed', (await cdp.evaluate(`window.S.days[window.S.entryDate].closed`)) === true);

  // and check the disk itself, not the app's own word for it
  let onDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('DISK: sold figure written', onDisk.days[theDay].items.p01.sold === 37, JSON.stringify(onDisk.days[theDay] || {}).slice(0, 200));
  check('DISK: waste figure written', onDisk.days[theDay].items.p01.waste === 3);
  check('DISK: stockout flag written', onDisk.days[theDay].items.p02.stockout === true);
  check('DISK: closed flag written', onDisk.days[theDay].closed === true);
  check('DISK: nine weeks of history written', Object.keys(onDisk.days).length > 60, Object.keys(onDisk.days).length);

  // change the schedule to three order days with different arrival times
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await sleep(600);
  await cdp.evaluate('document.querySelector(\'.dayToggle[data-d="5"]\').click()');
  await sleep(800);
  check('third order day accepted', (await cdp.evaluate('JSON.stringify(window.S.cfg.orderDays)')) === '[0,3,5]');
  await cdp.evaluate(`(function(){
    var sel = document.querySelector('.dcIn[data-d="5"][data-f="hour"]');
    sel.value = '14'; sel.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  await sleep(1200);
  check('per-day arrival hour accepted', (await cdp.evaluate('window.S.cfg.dayCfg["5"].hour')) === 14);

  const spans = await cdp.evaluate(`JSON.stringify(window.S.cfg.orderDays.map(function(dow){
    var d = new Date(); var g=0;
    while(d.getDay()!==dow && g++<8){ d = new Date(d.getFullYear(), d.getMonth(), d.getDate()+1); }
    return Math.round(coverageWindow(d).span*100)/100;
  }))`);
  check('three order days give three shorter windows (' + spans + ')', JSON.parse(spans).every(s => s > 0.5 && s < 4));

  await sleep(1200);
  onDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('DISK: new schedule written', JSON.stringify(onDisk.cfg.orderDays) === '[0,3,5]');
  check('DISK: per-day hour written', onDisk.cfg.dayCfg['5'].hour === 14);

  /* ---------- importing an Odoo export ---------- */
  console.log('');
  const fixCsv = fs.readFileSync(path.join(__dirname, 'fixtures', 'odoo-sales.csv'), 'utf8');
  const fixMeta = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'meta.json'), 'utf8'));

  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click()');
  await sleep(500);

  // hand the app the CSV exactly as a file-picker would
  await cdp.evaluate(`(function(){
    var f = new File([${JSON.stringify(fixCsv)}], "odoo-sales.csv", {type:"text/csv"});
    startImport(f); return true;
  })()`);
  await waitFor(cdp, 'window.S.imp', 'the import screen');
  check('CSV opens the import screen', true);

  const cols = JSON.parse(await cdp.evaluate('JSON.stringify(window.S.imp.cols)'));
  const heads = JSON.parse(await cdp.evaluate('JSON.stringify(window.S.imp.headers)'));
  check('finds the Product column', heads[cols.product] === 'Product', JSON.stringify({ cols, heads }));
  check('finds the Date column', heads[cols.date] === 'Date');
  check('finds the Quantity column', heads[cols.qty] === 'Quantity');

  let an = JSON.parse(await cdp.evaluate(`(function(){
    var a = analyzeImport();
    return JSON.stringify({
      days: Object.keys(a.days).sort(),
      unmatched: Object.keys(a.unmatched).length,
      unmatchedNames: Object.keys(a.unmatched).map(function(k){return a.unmatched[k].name}),
      entries: a.entries.length, noQty: a.noQty, noDate: a.noDate, summary: a.summary
    });
  })()`));
  check('spreads rows over both days', JSON.stringify(an.days) === JSON.stringify(fixMeta.days), JSON.stringify(an.days));
  check('matches the ta-marbuta spelling', !an.unmatchedNames.some(n => n.indexOf('الشوكولاته') >= 0), JSON.stringify(an.unmatchedNames));
  check('matches the alef-maqsura spelling', !an.unmatchedNames.some(n => n.indexOf('الحلبى') >= 0), JSON.stringify(an.unmatchedNames));
  check('flags only the genuinely unknown product', an.unmatched === 1 && /ميلك شيك/.test(an.unmatchedNames[0]), JSON.stringify(an.unmatchedNames));
  check('skips the Total junk row', an.noQty + an.summary >= 2, 'noQty=' + an.noQty + ' summary=' + an.summary);
  check('the Arabic totals line never becomes a product', an.summary >= 2 &&
    !an.unmatchedNames.some(n => /الإجمالي|Total/i.test(n)), 'summary=' + an.summary + ' ' + JSON.stringify(an.unmatchedNames));

  // map the unknown name onto an existing product, the way the shop would
  await cdp.evaluate(`(function(){
    var sel = document.querySelector('.impMap');
    sel.value = 'p05';
    sel.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`);
  await sleep(700);
  an = JSON.parse(await cdp.evaluate('JSON.stringify({u:Object.keys(analyzeImport().unmatched).length})'));
  check('hand-mapping clears the last unknown', an.u === 0);

  const before = JSON.parse(await cdp.evaluate(`JSON.stringify(window.S.days["${fixMeta.days[0]}"] ? window.S.days["${fixMeta.days[0]}"].items.p01 : null)`));
  // the sample record already has sales on these days, so the app asks replace-or-add first
  await waitFor(cdp, 'document.getElementById("impModeAsk") && document.getElementById("impModeRep")', 'the replace-or-add question');
  check('a file over recorded days holds the save until replace/add is chosen',
    await cdp.evaluate('!!document.getElementById("impModeAsk") && document.getElementById("impApply").disabled'));
  await cdp.evaluate('document.getElementById("impModeRep").click()');
  // wait for the re-render rather than assuming it has landed
  await waitFor(cdp, 'document.getElementById("impApply") && !document.getElementById("impApply").disabled',
    'the apply button to become live');
  check('the import screen offers a live apply button', true);
  await cdp.evaluate('document.getElementById("impApply").click()');
  await sleep(2000);
  check('import screen closes when done', !(await cdp.evaluate('!!window.S.imp')));

  // first product appears twice in the file (12 + 5) and must be summed
  const p01 = await cdp.evaluate(`window.S.days["${fixMeta.days[0]}"].items.p01.sold`);
  check('split order lines are summed (12+5=17, got ' + p01 + ')', p01 === 17, JSON.stringify(before));
  check('second day imported too', (await cdp.evaluate(`window.S.days["${fixMeta.days[1]}"].items.p01.sold`)) === 19);
  check('hand-mapped product received its quantity', (await cdp.evaluate(`window.S.days["${fixMeta.days[0]}"].items.p05.sold`)) === 27);

  await sleep(1200);
  onDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('DISK: imported sales written', onDisk.days[fixMeta.days[0]].items.p01.sold === 17);
  check('DISK: the learned alias was remembered', (onDisk.products.find(p => p.id === 'p05').aliases || []).length > 0,
    JSON.stringify(onDisk.products.find(p => p.id === 'p05')));

  // second import of the same file: the remembered alias means zero manual work
  await cdp.evaluate(`(function(){
    var f = new File([${JSON.stringify(fixCsv)}], "odoo-sales.csv", {type:"text/csv"});
    startImport(f); return true;
  })()`);
  await waitFor(cdp, 'window.S.imp', 'the second import');
  const second = JSON.parse(await cdp.evaluate('JSON.stringify({u:Object.keys(analyzeImport().unmatched).length})'));
  check('re-importing needs no mapping at all', second.u === 0);

  // replace mode must not double the figures
  await cdp.evaluate('document.getElementById("impModeRep").click()');
  await waitFor(cdp, '!document.getElementById("impApply").disabled', 'the apply button after choosing replace');
  await cdp.evaluate('document.getElementById("impApply").click()');
  await sleep(2000);
  check('replace mode does not double up (still 17)', (await cdp.evaluate(`window.S.days["${fixMeta.days[0]}"].items.p01.sold`)) === 17);

  /* ---------- XLSX, read by the real vendored library ---------- */
  const xlsxOk = await cdp.evaluate(`(async function(){
    try{
      var X = await loadXLSX();
      var rows = [["المرجع","التاريخ","المنتج","الكمية"],
                  ["SO1","01/02/2026","تشيز كيك توت — قطعة",9]];
      var wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), "Sheet1");
      var out = X.write(wb, {bookType:"xlsx", type:"array"});
      var f = new File([out], "odoo.xlsx", {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      startImport(f);
      return "ok";
    }catch(e){ return "ERR " + (e && e.message); }
  })()`);
  check('spreadsheet reader loads offline from the app', xlsxOk === 'ok', xlsxOk);
  await waitFor(cdp, 'window.S.imp && window.S.imp.fileName === "odoo.xlsx"', 'the xlsx import screen');
  const xh = JSON.parse(await cdp.evaluate('JSON.stringify({c:window.S.imp.cols, h:window.S.imp.headers, fmt:window.S.imp.dateFmt})'));
  check('finds the Arabic headers', xh.h[xh.c.product] === 'المنتج' && xh.h[xh.c.qty] === 'الكمية' && xh.h[xh.c.date] === 'التاريخ', JSON.stringify(xh));
  const xd = JSON.parse(await cdp.evaluate('JSON.stringify(Object.keys(analyzeImport().days))'));
  check('reads a d/m/Y date as 1 Feb 2026 (' + xd + ')', xd[0] === '2026-02-01', JSON.stringify(xd) + ' fmt=' + xh.fmt);
  await cdp.evaluate('document.getElementById("impCancel2").click()');
  await sleep(400);
  check('cancel leaves the record untouched', !(await cdp.evaluate('!!window.S.days["2026-02-01"]')));

  /* ---------- the two optional columns ---------- */
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await sleep(600);
  await cdp.evaluate(`(function(){
    var c = document.getElementById("cfgWaste"); c.checked = false;
    c.dispatchEvent(new Event("change", {bubbles:true})); return true;
  })()`);
  await sleep(600);
  check('waste tracking can be switched off', (await cdp.evaluate('window.S.cfg.trackWaste')) === false);
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click()');
  await sleep(600);
  check('waste column disappears from the daily close',
    !(await cdp.evaluate('!!document.querySelector(\'.entIn[data-f="waste"]\')')));
  check('sold column stays', (await cdp.evaluate('!!document.querySelector(\'.entIn[data-f="sold"]\')')));
  check('stockout tick stays while its own switch is on', (await cdp.evaluate('!!document.querySelector(".entChk")')));
  check('waste already recorded is not lost',
    (await cdp.evaluate(`window.S.days["${theDay}"].items.p01.waste`)) === 3);
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await sleep(500);
  await cdp.evaluate(`(function(){
    var c = document.getElementById("cfgWaste"); c.checked = true;
    c.dispatchEvent(new Event("change", {bubbles:true})); return true;
  })()`);
  await sleep(800);
  check('and switching it back on restores the column', (await cdp.evaluate('window.S.cfg.trackWaste')) === true);

  /* ---------- the analysis screen ---------- */
  console.log('');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="stats"]\').click()');
  await sleep(900);

  const R = JSON.parse(await cdp.evaluate(`(function(){
    var r = periodReport(null);
    return JSON.stringify({
      days:r.days, totalQty:Math.round(r.totalQty), dailyAvg:Math.round(r.dailyAvg*10)/10,
      soldProducts:r.soldProducts, productCount:r.productCount, thin:r.thin,
      conf:r.conf.label, confScore:Math.round(r.conf.score*100),
      trend7:r.trend7.dir, trend28:r.trend28.dir, vol:r.vol.band,
      weekdayAvg:r.weekday.avg.map(function(v){return v==null?null:Math.round(v*10)/10}),
      bestDow:r.weekday.best && r.weekday.best.i, worstDow:r.weekday.worst && r.weekday.worst.i,
      topSeller:r.ranked[0].p.name, topTotal:Math.round(r.ranked[0].total)
    });
  })()`));
  check('period report totals the record (' + R.totalQty + ' over ' + R.days + ' days)', R.days > 55 && R.totalQty > 0, JSON.stringify(R));
  check('daily average is total over days', Math.abs(R.dailyAvg - R.totalQty / R.days) < 0.5, R.dailyAvg + ' vs ' + (R.totalQty / R.days));
  check('counts products that sold (' + R.soldProducts + '/' + R.productCount + ')', R.soldProducts > 0 && R.soldProducts <= R.productCount);
  check('reports a confidence level (' + R.conf + ' ' + R.confScore + '%)', ['ضعيف', 'متوسّط', 'جيّد'].includes(R.conf));
  check('reports an overall trend (7d ' + R.trend7 + ', 28d ' + R.trend28 + ')', ['up', 'down', 'flat'].includes(R.trend7));
  check('reports branch volatility (' + R.vol + ')', ['low', 'mid', 'high'].includes(R.vol));
  check('has an average for all seven weekdays', R.weekdayAvg.every(v => v !== null), JSON.stringify(R.weekdayAvg));
  check('Thursday or Friday is the strongest day (' + DOWN(R.bestDow) + ')', R.bestDow === 4 || R.bestDow === 5,
    'best=' + R.bestDow + ' avgs=' + JSON.stringify(R.weekdayAvg));
  check('the weakest day is not a weekend peak (' + DOWN(R.worstDow) + ')', R.worstDow !== 4 && R.worstDow !== 5);

  const P = JSON.parse(await cdp.evaluate(`(function(){
    var p = window.S.products.filter(function(x){return x.active!==false})[0];
    var r = productReport(p, null);
    return JSON.stringify({
      name:r.p.name, nDays:r.nDays, total:Math.round(r.total),
      dailyAvg:Math.round(r.dailyAvg*10)/10,
      wdAvg:r.weekday.avg.map(function(v){return v==null?null:Math.round(v*10)/10}),
      best:r.weekday.best && r.weekday.best.i, worst:r.weekday.worst && r.weekday.worst.i,
      trend7:r.trend7.dir, trend7pct:r.trend7.pct===null?null:Math.round(r.trend7.pct*100),
      trend28:r.trend28.dir, volBand:r.vol.band, cv:Math.round(r.vol.cv*100),
      conf:r.conf.label, thin:r.thin,
      expected:Math.round(r.plan.expected*10)/10, suggested:r.plan.suggested,
      reasonLen:orderReason(r).length
    });
  })()`));
  check('per-product: total and day count', P.total > 0 && P.nDays > 30, JSON.stringify(P));
  check('per-product: average for each weekday', P.wdAvg.every(v => v !== null), JSON.stringify(P.wdAvg));
  check('per-product: names a best and a worst day (' + DOWN(P.best) + ' / ' + DOWN(P.worst) + ')', P.best !== null && P.worst !== null && P.best !== P.worst);
  check('per-product: best day really is the highest average',
    P.wdAvg[P.best] === Math.max(...P.wdAvg), P.best + ' ' + JSON.stringify(P.wdAvg));
  check('per-product: 7-day trend with a percentage (' + P.trend7 + ' ' + P.trend7pct + '%)', P.trend7pct !== null);
  check('per-product: 4-week trend (' + P.trend28 + ')', ['up', 'down', 'flat'].includes(P.trend28));
  check('per-product: volatility band and CV (' + P.volBand + ' ' + P.cv + '%)', ['low', 'mid', 'high'].includes(P.volBand));
  check('per-product: confidence (' + P.conf + ')', ['ضعيف', 'متوسّط', 'جيّد'].includes(P.conf));
  check('per-product: expected consumption and target quantity', P.expected > 0 && P.suggested >= 0);
  check('per-product: explains the quantity in a sentence (' + P.reasonLen + ' chars)', P.reasonLen > 80);

  // volatility must actually separate a steady product from a swinging one
  const volCheck = JSON.parse(await cdp.evaluate(`(function(){
    function band(arr){
      var s = arr.map(function(q,i){return {qty:q, d:new Date(2026,0,1+i)}});
      return volatilityOf(s).band;
    }
    return JSON.stringify({steady:band([18,19,20,18,19,20,18,19]), swingy:band([5,40,8,35,6,38,7,36])});
  })()`));
  check('volatility separates 18-19-20 from 5-40-8-35 (' + volCheck.steady + ' vs ' + volCheck.swingy + ')',
    volCheck.steady === 'low' && volCheck.swingy === 'high', JSON.stringify(volCheck));

  // events measured against the fortnight before them
  const ER = JSON.parse(await cdp.evaluate(`JSON.stringify(window.S.events.map(function(e){
    var r = eventReport(e);
    return r && {name:r.ev.name, kind:r.kind.label, duringDays:r.duringDays,
      duringAvg:r.duringAvg===null?null:Math.round(r.duringAvg), beforeAvg:r.beforeAvg===null?null:Math.round(r.beforeAvg),
      pct:r.pct===null?null:Math.round(r.pct*100),
      net:r.observed===null?null:Math.round((r.observed-1)*100), applied:r.applied};
  }).filter(Boolean))`));
  const nat = ER.find(e => /الوطني/.test(e.name));
  check('event report measures the National Day window', nat && nat.duringDays > 0, JSON.stringify(ER));
  check('event report gives a raw before/after comparison', nat && nat.pct !== null, JSON.stringify(nat));
  // The raw figure buries the lift under the end-of-month dip; the net figure
  // strips the weekday and salary effects and must recover the real +45%.
  check('net effect recovers the real lift (+' + (nat && nat.net) + '% vs raw ' + (nat && nat.pct) + '%)',
    nat && nat.net !== null && nat.net > 20, JSON.stringify(nat));
  check('event report says whether it is applied to the forecast', nat && nat.applied === true);

  // the screen itself
  const statsUi = JSON.parse(await cdp.evaluate(`(function(){
    var v = document.getElementById("view").innerText;
    return JSON.stringify({
      period: v.indexOf("ملخّص الفترة") >= 0,
      dayAnalysis: v.indexOf("تحليل الأيام") >= 0,
      events: v.indexOf("تحليل المناسبات") >= 0,
      perProduct: v.indexOf("تحليل كلّ صنف") >= 0,
      legacyWaste: v.indexOf("الهدر والنفاد") >= 0,
      legacyTop: v.indexOf("الأكثر مبيعاً") >= 0,
      legacyIndex: v.indexOf("مؤشّر أيام الأسبوع") >= 0,
      rows: document.querySelectorAll(".statRow").length,
      periodBtns: document.querySelectorAll(".statPeriod").length
    });
  })()`));
  check('screen shows the period summary', statsUi.period, JSON.stringify(statsUi));
  check('screen shows the weekday analysis', statsUi.dayAnalysis);
  check('screen shows the events analysis', statsUi.events);
  check('screen shows the per-product table (' + statsUi.rows + ' rows)', statsUi.perProduct && statsUi.rows > 5);
  check('the original waste/stockout analysis is still there', statsUi.legacyWaste, JSON.stringify(statsUi));
  check('the original best-seller ranking is still there', statsUi.legacyTop);
  check('the original weekday index chart is still there', statsUi.legacyIndex);
  check('period buttons are present (' + statsUi.periodBtns + ')', statsUi.periodBtns === 4);

  // period switching narrows the window
  await cdp.evaluate('document.querySelector(\'.statPeriod[data-p="7"]\').click()');
  await sleep(900);
  const seven = JSON.parse(await cdp.evaluate('JSON.stringify({days:periodReport(7).days, sel:window.S.statPeriod})'));
  check('switching to 7 days narrows the window (' + seven.days + ' days)', seven.days <= 7 && seven.sel === 7, JSON.stringify(seven));
  await cdp.evaluate('document.querySelector(\'.statPeriod[data-p="0"]\').click()');
  await sleep(700);

  /* ---------- a range the shop chooses itself ---------- */
  const bounds = JSON.parse(await cdp.evaluate('JSON.stringify(Object.keys(window.S.days).sort())'));
  const from = bounds[10], to = bounds[20];        // an arbitrary slice of the record
  await cdp.evaluate(`(function(){
    var f = document.getElementById("statFrom"); f.value = ${JSON.stringify(from)};
    f.dispatchEvent(new Event("input", {bubbles:true}));
    var t = document.getElementById("statTo"); t.value = ${JSON.stringify(to)};
    t.dispatchEvent(new Event("input", {bubbles:true}));
    return true;
  })()`);
  await waitFor(cdp, 'window.S.statFrom && window.S.statTo && document.getElementById("statClear")',
    'the custom range to register and redraw');
  const cust = JSON.parse(await cdp.evaluate(`(function(){
    var r = periodReport(statRange());
    return JSON.stringify({from:window.S.statFrom, to:window.S.statTo, days:r.days,
      first:r.dayKeys[0], last:r.dayKeys[r.dayKeys.length-1],
      clearBtn: !!document.getElementById("statClear"),
      quickHighlighted: document.querySelectorAll(".statPeriod.primary").length});
  })()`));
  check('a custom range is honoured (' + cust.first + ' → ' + cust.last + ', ' + cust.days + ' days)',
    cust.first === from && cust.last === to && cust.days === 11, JSON.stringify(cust));
  check('the screen offers to clear the custom range', cust.clearBtn, JSON.stringify(cust));
  check('no quick button stays highlighted while a range is set', cust.quickHighlighted === 0, JSON.stringify(cust));

  // one end alone is enough
  await cdp.evaluate(`(function(){
    var t = document.getElementById("statTo"); t.value = "";
    t.dispatchEvent(new Event("input", {bubbles:true})); return true;
  })()`);
  await waitFor(cdp, '!window.S.statTo && window.S.statFrom', 'the open-ended range');
  const openEnded = JSON.parse(await cdp.evaluate(`(function(){
    var r = periodReport(statRange());
    return JSON.stringify({days:r.days, first:r.dayKeys[0], last:r.dayKeys[r.dayKeys.length-1]});
  })()`));
  check('"from" alone runs to the end of the record (' + openEnded.days + ' days)',
    openEnded.first === from && openEnded.last === bounds[bounds.length - 1], JSON.stringify(openEnded));

  // dates entered back to front still work
  const flipped = JSON.parse(await cdp.evaluate(`JSON.stringify(normRange({from:${JSON.stringify(to)}, to:${JSON.stringify(from)}}))`));
  check('a reversed range is corrected, not broken', flipped.from === from && flipped.to === to, JSON.stringify(flipped));

  // and clearing it returns to the quick buttons
  await cdp.evaluate('document.getElementById("statClear").click()');
  await waitFor(cdp, '!window.S.statFrom && !window.S.statTo', 'the range to clear');
  check('clearing the range restores the whole record',
    !(await cdp.evaluate('!!(window.S.statFrom || window.S.statTo)')) &&
    (await cdp.evaluate('periodReport(statRange()).days')) === bounds.length);

  // opening one product
  await cdp.evaluate('document.querySelector(".statRow").click()');
  let detailReady = false;
  for (let i = 0; i < 40 && !detailReady; i++) {
    await sleep(250);
    detailReady = await cdp.evaluate('!!document.getElementById("statClose")');
  }
  if (!detailReady) {
    console.log('  ....  detail diagnostics: ' + await cdp.evaluate(`(function(){
      var ids = periodReport(window.S.statPeriod||null).reports.map(function(r){return r.p.id});
      var threw = null;
      try { var sel = periodReport(window.S.statPeriod||null).reports.filter(function(r){return r.p.id===window.S.statProduct})[0];
            renderProductDetail(sel); } catch (e) { threw = e.message; }
      return JSON.stringify({sel: window.S.statProduct, inReports: ids.indexOf(window.S.statProduct)>=0,
        nReports: ids.length, threw: threw, tab: window.S.tab});
    })()`));
  }
  const detail = JSON.parse(await cdp.evaluate(`(function(){
    var v = document.getElementById("view").innerText;
    return JSON.stringify({
      open: !!window.S.statProduct,
      reason: v.indexOf("سبب الكمية") >= 0,
      target: v.indexOf("الكمية المستهدفة") >= 0,
      consumption: v.indexOf("الاستهلاك المتوقَّع") >= 0,
      weekdays: v.indexOf("متوسّط كلّ يوم من أيام الأسبوع") >= 0,
      close: !!document.getElementById("statClose")
    });
  })()`));
  check('clicking a product opens its detail', detail.open && detail.close, JSON.stringify(detail));
  check('detail shows expected consumption and target quantity', detail.consumption && detail.target);
  check('detail explains why that quantity', detail.reason);
  check('detail shows the weekday breakdown', detail.weekdays);
  await cdp.evaluate('document.getElementById("statClose").click()');
  await sleep(500);
  check('detail closes again', !(await cdp.evaluate('!!window.S.statProduct')));

  /* ---------- units of measure ---------- */
  console.log('');
  const units = JSON.parse(await cdp.evaluate(`(function(){
    var keep = window.S.products.slice();
    var piece = {id:"u-piece", name:"شوكليت بايتس", unit:"حبة", shelfLife:5, packSize:1, moq:0, active:true, aliases:[]};
    var kilo  = {id:"u-kilo",  name:"صوص السينابون", unit:"كجم", shelfLife:20, packSize:1, moq:0, active:true, aliases:[]};
    var blank = {id:"u-blank", name:"بلا وحدة", shelfLife:5, packSize:1, moq:0, active:true, aliases:[]};
    window.S.products = [piece, kilo, blank];
    var res = {
      pieceUnit: unitOf(piece), kiloUnit: unitOf(kilo), defaultUnit: unitOf(blank),
      pieceCountable: isCountable(piece), kiloCountable: isCountable(kilo),
      pieceRound: qtyRound(piece, 2.53), kiloRound: qtyRound(kilo, 2.53),
      grouped: fmtTotals(totalsByUnit([{p:piece,v:980},{p:kilo,v:23.5},{p:piece,v:20}])),
      common: commonUnit([piece, kilo]), commonSame: commonUnit([piece, piece])
    };
    window.S.products = keep;
    return JSON.stringify(res);
  })()`));
  check('a product keeps the unit it was given (' + units.pieceUnit + ' / ' + units.kiloUnit + ')',
    units.pieceUnit === 'حبة' && units.kiloUnit === 'كجم', JSON.stringify(units));
  check('a product with no unit falls back to حبة', units.defaultUnit === 'حبة');
  check('حبة counts, كجم weighs', units.pieceCountable === true && units.kiloCountable === false);
  check('2.53 rounds to ' + units.pieceRound + ' حبة but stays ' + units.kiloRound + ' كجم',
    units.pieceRound === 3 && units.kiloRound === 2.5, JSON.stringify(units));
  check('totals group by unit instead of adding (' + units.grouped + ')',
    /1,000 حبة/.test(units.grouped) && /23.5 كجم/.test(units.grouped), units.grouped);
  check('mixed units report no common unit', units.common === null && units.commonSame === 'حبة');

  // and the order engine must respect it end to end
  const kiloOrder = JSON.parse(await cdp.evaluate(`(function(){
    var p = window.S.products.filter(function(x){return unitOf(x) === "كجم"})[0];
    if (!p) return JSON.stringify({skipped:true});
    var d = isOrderDay(today()) ? today() : nextOrderDay(today());
    var pl = planFor(p, d);
    return JSON.stringify({name:p.name, unit:unitOf(p), suggested:pl.suggested,
      isWhole: Math.abs(pl.suggested - Math.round(pl.suggested)) < 1e-9,
      reason: orderReason(productReport(p, null))});
  })()`));
  if (!kiloOrder.skipped) {
    check('a kilo product is ordered in كجم (' + kiloOrder.suggested + ')', kiloOrder.unit === 'كجم');
    check('and its reason sentence speaks كجم, not قطعة',
      kiloOrder.reason.indexOf('كجم') >= 0 && kiloOrder.reason.indexOf('قطعة') < 0,
      kiloOrder.reason.slice(0, 160));
  }

  // a sheet that carries its own unit column
  const imported = JSON.parse(await cdp.evaluate(`(function(){
    var keepP = JSON.parse(JSON.stringify(window.S.products));
    var keepD = JSON.parse(JSON.stringify(window.S.days));
    var kilo  = {id:"imp-kilo",  name:"صوص السينابون", unit:"كجم", shelfLife:20, packSize:1, moq:0, active:true, aliases:[]};
    var piece = {id:"imp-piece", name:"كيكة تمر",      unit:"حبة", shelfLife:5,  packSize:1, moq:0, active:true, aliases:[]};
    window.S.products = [kilo, piece];
    var d = ymd(addDays(today(), -2));
    window.S.imp = {
      rows: [
        ["المنتج","الكمية","وحدة القياس","التاريخ"],
        ["[POS-CH-070] Cinnamon Sauce | صوص السينابون", "3.4", "كجم", d],
        ["[POS-CH-071] Date Cake | كيكة تمر",           "12",  "كجم", d],   // sheet disagrees
        ["[POS-CH-072] Unknown Thing | حاجة مجهولة",    "7",   "كجم", d]
      ],
      cols: {product:0, qty:1, unit:2, date:3},
      dateFmt: "ymd", singleDate: null, mapping: {}, mode: "replace", markClosed: false
    };
    var a = analyzeImport();
    var clash = Object.keys(a.unitClash).map(function(k){
      return {name:a.unitClash[k].name, sheet:a.unitClash[k].sheet, app:a.unitClash[k].app};
    });
    var unmatchedUnit = Object.keys(a.unmatched).map(function(k){ return a.unmatched[k].unit });
    applyImport();
    var slot = window.S.days[d] && window.S.days[d].items["imp-kilo"];
    var res = {rows:a.entries.length, clash:clash, unmatchedUnit:unmatchedUnit,
               kiloSold: slot ? slot.sold : null};
    window.S.products = keepP; window.S.days = keepD; window.S.imp = null;
    return JSON.stringify(res);
  })()`));
  check('the import reads the sheet\'s وحدة القياس column', imported.rows === 2, JSON.stringify(imported));
  check('3.4 كجم is stored as 3.4, not 3', imported.kiloSold === 3.4, JSON.stringify(imported));
  check('a sheet unit that contradicts the product is flagged, not added blindly',
    imported.clash.length === 1 && imported.clash[0].name.indexOf('كيكة تمر') >= 0 &&
    imported.clash[0].sheet === 'كجم' && imported.clash[0].app === 'حبة', JSON.stringify(imported.clash));
  check('an unknown product carries the sheet\'s unit into its new record',
    imported.unmatchedUnit.length === 1 && imported.unmatchedUnit[0] === 'كجم', JSON.stringify(imported));

  /* ---------- reading a product name out of an Odoo cell ---------- */
  console.log('');
  const smart = JSON.parse(await cdp.evaluate(`(function(){
    // the shop's own example, verbatim
    var cell = "[POS-CH-036] Mini Basbousa | ميني بسبوسة \\n[POS-CH-036] Mini Basbousa";
    var made = {id:"tst-basbousa", name:"ميني بسبوسة", shelfLife:5, packSize:1, moq:0, active:true, aliases:[]};
    window.S.products.push(made);
    var hit = matchProductDetail(cell);

    // two products that differ only by a trailing number must not be confused
    var a = {id:"tst-cin16", name:"سينامون بولز 16", shelfLife:5, packSize:1, moq:0, active:true, aliases:[]};
    var b = {id:"tst-cin28", name:"سينامون بولز 28", shelfLife:5, packSize:1, moq:0, active:true, aliases:[]};
    window.S.products.push(a, b);
    var h16 = matchProductDetail("[POS-CH-021] Cinnamon Balls 16 | سينامون بولز 16");
    var h28 = matchProductDetail("[POS-CH-043] Cinnamon Balls 28 | سينامون بولز 28");

    // a cell naming nothing we know stays unmatched rather than guessing wildly
    var none = matchProductDetail("[POS-CH-099] Something Else | شيء غير معروف تماما");

    // cleaning the name for a product created from the sheet
    var cleaned = cleanImportName(cell);

    var res = {hit:hit, h16:h16, h28:h28, none:none, cleaned:cleaned};
    window.S.products = window.S.products.filter(function(p){ return p.id.indexOf("tst-") !== 0 });
    return JSON.stringify(res);
  })()`));
  check('reads "ميني بسبوسة" out of the full Odoo cell (' + smart.hit.how + ')',
    smart.hit.id === 'tst-basbousa' && smart.hit.how === 'inside', JSON.stringify(smart.hit));
  check('tells سينامون بولز 16 from 28', smart.h16.id === 'tst-cin16' && smart.h28.id === 'tst-cin28',
    JSON.stringify([smart.h16, smart.h28]));
  check('an unknown product stays unmatched rather than mis-assigned', smart.none.id === null,
    JSON.stringify(smart.none));
  check('a name made from a sheet is cleaned to "' + smart.cleaned + '"', smart.cleaned === 'ميني بسبوسة', smart.cleaned);

  // The rule is general, not a special case for one product: a whole catalogue
  // of names the app has never seen, each wrapped the way Odoo writes it, with
  // no aliases and nothing imported beforehand.
  const general = JSON.parse(await cdp.evaluate(`(function(){
    var names = ["كوكيز لوتس","تشيز كيك بستاشيو","كيكة عسل","دونات محشوة نوتيلا",
                 "بسكويت زبدة الفول السوداني","كب كيك فانيلا","مافن بلوبيري","رول قرفة صغير"];
    var keep = window.S.products;
    window.S.products = names.map(function(n,i){
      return {id:"gen"+i, name:n, shelfLife:5, packSize:1, moq:0, active:true, aliases:[]};
    });
    var res = names.map(function(n,i){
      var code = "POS-XX-" + (100+i);
      var eng = "Product " + (i+1) + " Long English Description";
      var cell = "["+code+"] "+eng+" | "+n+"\\n["+code+"] "+eng;
      var r = matchProductDetail(cell);
      return {name:n, ok: r.id === "gen"+i};
    });
    window.S.products = keep;
    return JSON.stringify({total:res.length, ok:res.filter(function(r){return r.ok}).length,
      failed:res.filter(function(r){return !r.ok}).map(function(r){return r.name})});
  })()`));
  check('the rule holds for products never seen before (' + general.ok + '/' + general.total + ')',
    general.ok === general.total, JSON.stringify(general.failed));

  /* ---------- renaming never costs a match ---------- */
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="items"]\').click()');
  await waitFor(cdp, '!!document.querySelector(\'.itIn[data-f="name"]\')', 'the items table');
  const renamed = JSON.parse(await cdp.evaluate(`(function(){
    var el = document.querySelector('.itIn[data-f="name"]');
    var pid = el.dataset.id;
    var before = el.value;
    el.dispatchEvent(new Event("focusin", {bubbles:true}));
    el.value = "اسم جديد تماما";
    el.dispatchEvent(new Event("input", {bubbles:true}));
    el.dispatchEvent(new Event("change", {bubbles:true}));
    var p = window.S.products.filter(function(x){return x.id===pid})[0];
    var stillFound = matchProductDetail(before);
    return JSON.stringify({pid:pid, before:before, now:p.name,
      aliases:p.aliases||[], stillFound:stillFound});
  })()`));
  check('the product takes the new name (' + renamed.now + ')', renamed.now === 'اسم جديد تماما', JSON.stringify(renamed));
  check('its old name is kept as an alias', renamed.aliases.length > 0, JSON.stringify(renamed.aliases));
  check('and a sheet written the old way still matches it',
    renamed.stillFound.id === renamed.pid, JSON.stringify(renamed.stillFound));

  /* ---------- the shelf-life column on the daily close ---------- */
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click()');
  await sleep(900);
  const shelfHidden = await cdp.evaluate('document.querySelector("#view table thead").innerText.indexOf("الصلاحية") >= 0');
  check('the shelf-life column is hidden on the daily close by default', !shelfHidden);
  await setToggle(cdp, 'cfgShelfCol', true);
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click()');
  await waitFor(cdp, 'document.querySelector("#view table thead").innerText.indexOf("الصلاحية") >= 0',
    'the shelf-life column to appear');
  check('switching it on brings it back', true);
  await setToggle(cdp, 'cfgShelfCol', false);

  /* ---------- columns line up with their headers ---------- */
  console.log('');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="stats"]\').click()');
  await waitFor(cdp, 'document.querySelectorAll("table td.n").length > 3', 'the analysis tables');
  const align = JSON.parse(await cdp.evaluate(`(function(){
    // For each table, compare the right edge of a numeric cell's text with the
    // right edge of its own header — in RTL both must sit on the same line.
    var worst = 0, checked = 0, sample = null;
    document.querySelectorAll("table").forEach(function(t){
      var ths = t.querySelectorAll("thead th");
      var row = t.querySelector("tbody tr");
      if (!row || !ths.length) return;
      var tds = row.children;
      for (var i = 0; i < ths.length && i < tds.length; i++) {
        var td = tds[i];
        if (!td.classList.contains("n")) continue;
        if (!td.textContent.trim()) continue;
        var a = ths[i].getBoundingClientRect(), b = td.getBoundingClientRect();
        // same column box, so compare the inner text edges via a range
        var r = document.createRange(); r.selectNodeContents(td);
        var tr = r.getBoundingClientRect();
        var hr = document.createRange(); hr.selectNodeContents(ths[i]);
        var hb = hr.getBoundingClientRect();
        if (!tr.width || !hb.width) continue;
        var gap = Math.abs(tr.right - hb.right);
        checked++;
        if (gap > worst) { worst = gap; sample = {header: ths[i].textContent.trim(), value: td.textContent.trim(), gap: Math.round(gap)}; }
      }
    });
    return JSON.stringify({checked: checked, worst: Math.round(worst), sample: sample,
      align: getComputedStyle(document.querySelector("table td.n")).textAlign});
  })()`));
  check('numeric cells are right-aligned (' + align.align + ')', align.align === 'right', JSON.stringify(align));
  check('every number sits under its own header (checked ' + align.checked + ', worst drift ' + align.worst + 'px)',
    align.checked > 3 && align.worst <= 24, JSON.stringify(align));

  const cardAlign = await cdp.evaluate(`(function(){
    var v = document.querySelector(".card .val");
    return v ? getComputedStyle(v).textAlign : "none";
  })()`);
  check('stat-card figures are right-aligned (' + cardAlign + ')', cardAlign === 'right');

  /* ---------- counting the shelf is optional ---------- */
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="order"]\').click()');
  await sleep(900);
  check('the stock box is hidden by default',
    !(await cdp.evaluate('!!document.querySelector(".stockIn")')));
  check('and no shortfall warning is claimed without a count',
    !(await cdp.evaluate('document.getElementById("view").innerText.indexOf("ينفد قبل التحويل") >= 0')));

  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await sleep(700);
  await cdp.evaluate(`(function(){var c=document.getElementById("cfgStock");c.checked=true;c.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(700);
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="order"]\').click()');
  await waitFor(cdp, '!!document.querySelector(".stockIn")', 'the stock box to appear');
  check('switching it on brings the stock box back', true);

  // a count entered must lower the suggestion. The count must be large enough to outlast the days before the
  // truck arrives: on some weekdays (with three order days set above) 40 pieces are all sold before delivery, so
  // they rightly change nothing — which made this check depend on the calendar.
  const before2 = await cdp.evaluate('(function(){var p=activeProducts()[0];var d=isOrderDay(today())?today():nextOrderDay(today());return planFor(p,d).suggested})()');
  await cdp.evaluate(`(function(){
    var el = document.querySelector(".stockIn");
    el.value = "400"; el.dispatchEvent(new Event("input", {bubbles:true})); return true;
  })()`);
  await sleep(1400);
  const after2 = await cdp.evaluate('(function(){var p=activeProducts()[0];var d=isOrderDay(today())?today():nextOrderDay(today());return planFor(p,d).suggested})()');
  check('a counted shelf lowers the suggestion (' + before2 + ' -> ' + after2 + ')', after2 < before2, before2 + ' / ' + after2);

  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await sleep(700);
  await cdp.evaluate(`(function(){var c=document.getElementById("cfgStock");c.checked=false;c.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(700);

  /* ---------- packing is optional ---------- */
  check('packing columns are hidden by default',
    !(await cdp.evaluate(`(function(){
      document.querySelector('#tabs button[data-tab="items"]').click();
      return !!document.querySelector('.itIn[data-f="packSize"]');
    })()`)));
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await sleep(600);
  await cdp.evaluate(`(function(){var c=document.getElementById("cfgPack");c.checked=true;c.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(700);
  check('and appear when switched on', await cdp.evaluate(`(function(){
    document.querySelector('#tabs button[data-tab="items"]').click();
    return !!document.querySelector('.itIn[data-f="packSize"]');
  })()`));
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await sleep(500);
  await cdp.evaluate(`(function(){var c=document.getElementById("cfgPack");c.checked=false;c.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(700);

  // every tab must render its own screen, identified by text only it shows
  const marks = {
    order: 'على مخزونك الحالي وحده',
    entry: 'آخر أربعة عشر يوماً',
    items: 'متوسّط يومي',
    stats: 'الأكثر مبيعاً',
    setup: 'جدول الطلب'
  };
  for (const tab of Object.keys(marks)) {
    // Wait for the screen to actually be on rather than guessing at a delay —
    // the analysis screen recomputes every product and can take a moment. A
    // synthetic click is occasionally dropped under load, so re-issue it a few
    // times before calling the screen broken.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      await cdp.evaluate(`document.querySelector('#tabs button[data-tab="${tab}"]').click()`);
      for (let i = 0; i < 16 && !ok; i++) {
        await sleep(250);
        ok = await cdp.evaluate(`window.S.tab === ${JSON.stringify(tab)} &&
          document.getElementById("view").innerText.indexOf(${JSON.stringify(marks[tab])}) >= 0`);
      }
    }
    const got = await cdp.evaluate(`(function(){
      var v = document.getElementById("view");
      return JSON.stringify({len: v.innerHTML.length, sTab: window.S.tab,
        head: v.innerText.slice(0,50).replace(/\\s+/g," ")});
    })()`);
    check('tab "' + tab + '" shows its own screen (' + JSON.parse(got).len + ' chars)', ok, got);
  }

  const orderSuggests = await cdp.evaluate(`(function(){
    document.querySelector('#tabs button[data-tab="order"]').click();
    var d = window.S.planDate ? parseYmd(window.S.planDate) : (isOrderDay(today()) ? today() : nextOrderDay(today()));
    return activeProducts().reduce(function(n,p){ return n + (planFor(p,d).suggested>0 ? 1 : 0) }, 0);
  })()`);
  check('order screen suggests real quantities (' + orderSuggests + ' items)', orderSuggests > 0);

  cdp.close();
  proc.kill();
  await sleep(1500);

  console.log('\n--- second run: does it all come back? ---');
  proc = launch();
  proc.stderr.on('data', d => stderr.push(d.toString()));
  page = await targets();
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to finish booting');

  check('restarts without the demo banner', (await cdp.evaluate('window.S.demo === false')));
  check('RELOAD: sold figure restored', (await cdp.evaluate(`window.S.days["${theDay}"].items.p01.sold`)) === 37);
  check('RELOAD: waste figure restored', (await cdp.evaluate(`window.S.days["${theDay}"].items.p01.waste`)) === 3);
  check('RELOAD: stockout flag restored', (await cdp.evaluate(`window.S.days["${theDay}"].items.p02.stockout`)) === true);
  check('RELOAD: day still closed', (await cdp.evaluate(`window.S.days["${theDay}"].closed`)) === true);
  check('RELOAD: full history restored', (await cdp.evaluate('Object.keys(window.S.days).length')) > 60);
  check('RELOAD: catalogue restored', (await cdp.evaluate('window.S.products.length')) === 15);
  check('RELOAD: the units survived the round trip',
    (await cdp.evaluate('JSON.stringify(window.S.products.filter(function(p){return p.unit==="كجم"}).map(function(p){return p.name}))')) === '["معمول تمر","صوص السينابون"]');
  check('RELOAD: three order days restored', (await cdp.evaluate('JSON.stringify(window.S.cfg.orderDays)')) === '[0,3,5]');
  check('RELOAD: per-day arrival hour restored', (await cdp.evaluate('window.S.cfg.dayCfg["5"].hour')) === 14);
  check('RELOAD: the shop learned from the record', (await cdp.evaluate('window.S.model.p01 && window.S.model.p01.n > 30')));

  cdp.close();
  proc.kill();
  await sleep(800);

  console.log('');
  check('window.prompt is never reached on the desktop',
    (await (async () => { try { return true; } catch (e) { return false; } })()) && !pageErrors.some(e => /prompt/i.test(e)));
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  console.log('  ....  dialogs raised and accepted: ' + (dialogs.length ? dialogs.join(' | ') : 'none'));
  const realErrors = stderr.join('').split('\n').filter(l => /error|cannot|undefined is not/i.test(l) && !/DevTools|Autofill|GPU|gpu_|Vulkan|dbus|cache|registration_protocol|DXGI/i.test(l));
  check('no errors from the app process', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nHARNESS ERROR: ' + (e && e.stack || e));
  process.exit(1);
});

