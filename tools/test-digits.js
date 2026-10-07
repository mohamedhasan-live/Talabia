'use strict';
/*
 * Every number the app shows is written 0-9, never ٠-٩ or ۰-۹: the text of
 * every screen, the values and placeholders of its fields, the window title,
 * the browser locale the native number and date fields draw with, and a digit
 * typed on an Arabic-Indic keyboard into a quantity field.
 *
 *   node tools/test-digits.js            (dev build)
 *   DAFTAR_EXE=...\Talabia.exe node tools/test-digits.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-digits-'));
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
  const args = EXE ? ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT]
                   : ['.', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  return spawn(EXE || ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
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
    const send = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push('exception: ' + (d.exception && d.exception.description || d.text));
      }
      if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
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

// Everything a person can read on the screen right now, with the Arabic-Indic digits found in it.
const SCAN = `(function(){
  var bad = /[\\u0660-\\u0669\\u06F0-\\u06F9]/g, parts = [document.title, document.body.innerText];
  document.querySelectorAll("input,textarea,select").forEach(function(el){
    parts.push(el.value || ""); parts.push(el.placeholder || ""); parts.push(el.title || "");
    if (el.tagName === "SELECT") Array.prototype.forEach.call(el.options, function(o){ parts.push(o.text) });
  });
  document.querySelectorAll("[title],[aria-label]").forEach(function(el){
    parts.push(el.getAttribute("title") || ""); parts.push(el.getAttribute("aria-label") || "");
  });
  var hits = [];
  parts.forEach(function(p){
    var s = String(p), m;
    bad.lastIndex = 0;
    while ((m = bad.exec(s)) && hits.length < 6) hits.push(s.slice(Math.max(0, m.index - 25), m.index + 10).replace(/\\s+/g, " "));
  });
  return JSON.stringify({chars: document.body.innerText.length, hits: hits});
})()`;

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('digits test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await targets()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');

  console.log('--- the locale the native fields draw with ---');
  const loc = JSON.parse(await cdp.evaluate(`JSON.stringify({lang: navigator.language,
    num: new Intl.NumberFormat().format(1234567.5), date: new Intl.DateTimeFormat().format(new Date(2026, 9, 4)),
    dir: document.documentElement.getAttribute("dir") || getComputedStyle(document.querySelector(".app")).direction,
    pageLang: document.documentElement.getAttribute("lang")})`));
  check('browser locale is en-GB (' + loc.lang + ')', loc.lang === 'en-GB', JSON.stringify(loc));
  check('the default number format is 0-9 (' + loc.num + ')', /^[0-9.,]+$/.test(loc.num), loc.num);
  check('the default date format is 0-9, day first (' + loc.date + ')', loc.date === '04/10/2026', loc.date);
  check('the page itself stays Arabic and right-to-left', loc.pageLang === 'ar' && /rtl/.test(loc.dir), JSON.stringify(loc));

  console.log('\n--- every screen ---');
  const scan = async (label) => {
    const r = JSON.parse(await cdp.evaluate(SCAN));
    check(label + ': no ٠-٩ / ۰-۹ (' + r.chars + ' chars read)', r.chars > 50 && r.hits.length === 0, JSON.stringify(r.hits));
  };
  await scan('the demo banner');
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');

  const tab = async (t, mark) => {
    await cdp.evaluate(`document.querySelector('#tabs button[data-tab="${t}"]').click()`);
    await waitFor(cdp, `window.S.tab === "${t}" && document.getElementById("view").innerText.indexOf(${JSON.stringify(mark)}) >= 0`, 'the ' + t + ' screen');
  };
  await tab('order', 'على مخزونك الحالي وحده');
  await scan('order');
  check('arrival times are 0-9 (e.g. "7 مساءً")', await cdp.evaluate('/\\b\\d{1,2} (مساءً|صباحاً|ظهراً)/.test(document.getElementById("view").innerText)'));
  await tab('entry', 'آخر أربعة عشر يوماً');
  await scan('daily close');
  await tab('items', 'متوسّط يومي');
  await scan('items');
  await tab('stats', 'الأكثر مبيعاً');
  await scan('analysis');
  await cdp.evaluate('document.querySelector(".statRow").click()');
  await waitFor(cdp, 'document.getElementById("statClose")', 'a product detail');
  await scan('analysis, one product open');
  await cdp.evaluate('document.querySelector(\'.statPeriod[data-p="7"]\').click()');
  await sleep(500);
  await scan('analysis, last 7 days');
  await tab('setup', 'جدول الطلب');
  await scan('settings');
  if (await cdp.evaluate('!!document.querySelector(\'#tabs button[data-tab="branches"]\')')) {
    await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="branches"]\').click()');
    await sleep(700);
    await scan('branches');
  }

  // the import wizard, with a period, an undated row and a recorded day
  await tab('entry', 'آخر أربعة عشر يوماً');
  const day = await cdp.evaluate('ymd(addDays(today(), -2))');
  const csv = 'Date,Product,Quantity\n' + day + ',كيكة الشوكولاتة,12\n,براونيز,3\n2025-01-01,براونيز,4\n01/02/2026,براونيز,1\n';
  await cdp.evaluate(`(function(){ startImport(new File([${JSON.stringify(csv)}], "s.csv", {type:"text/csv"})); return 1 })()`);
  await waitFor(cdp, 'window.S.imp && document.getElementById("impScope")', 'the import screen');
  await scan('import wizard');
  await cdp.evaluate('document.getElementById("impCancel2").click()');
  await waitFor(cdp, '!window.S.imp', 'cancel');

  console.log('\n--- formatting helpers ---');
  const h = JSON.parse(await cdp.evaluate('JSON.stringify([fmtHour(19), fmtHour(9), fmtHour(12), fmtHour(24), fmtDate(new Date(2026,9,4)), numText(1234.5), money(98000)])'));
  check('helpers write 0-9 (' + h.join(' | ') + ')', h.join('').match(/[٠-٩۰-۹]/) === null &&
    h[0] === '7 مساءً' && h[1] === '9 صباحاً' && h[2] === '12 ظهراً' && h[3] === '12 منتصف الليل', JSON.stringify(h));

  console.log('\n--- typing on an Arabic-Indic keyboard ---');
  await tab('order', 'على مخزونك الحالي وحده');
  const pid = await cdp.evaluate('document.querySelector(".qtyIn").dataset.pid');
  await cdp.evaluate('(function(){var el=document.querySelector(".qtyIn"); el.focus(); el.select(); return 1})()');
  await cdp.send('Input.insertText', { text: '٦٧' });
  await sleep(600);
  const typed = JSON.parse(await cdp.evaluate(`JSON.stringify({ov: window.S.overrides[${JSON.stringify(pid)}],
    val: (document.querySelector('.qtyIn[data-pid=${JSON.stringify(pid)}]')||{}).value})`));
  check('٦٧ typed into a quantity is taken as 67', typed.ov === 67, JSON.stringify(typed));
  check('…and the field shows 67', typed.val === '67', JSON.stringify(typed));
  await scan('order, after typing');

  await tab('items', 'متوسّط يومي');
  await cdp.evaluate('(function(){var el=document.querySelector(\'.itIn[data-f="name"]\'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return 1})()');
  await cdp.send('Input.insertText', { text: ' ١٢' });
  await sleep(300);
  check('a digit typed into a text field is written 0-9 too', await cdp.evaluate('/ 12$/.test(document.querySelector(\'.itIn[data-f="name"]\').value)'),
    await cdp.evaluate('document.querySelector(\'.itIn[data-f="name"]\').value'));

  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
