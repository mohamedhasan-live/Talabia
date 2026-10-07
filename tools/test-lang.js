'use strict';
/*
 * Arabic / English. Arabic is the app exactly as built; English is a layer over it. Checks:
 *   - the switch (header button and Settings), remembered after a restart, back to Arabic the same way
 *   - English is left-to-right, Arabic right-to-left
 *   - no Arabic left on any screen in English, except the shop's own names (products, branches,
 *     materials, occasions) and the word «العربية» on the switch itself
 *   - the shop's names are never translated; dialogs (confirm) are translated too
 *
 *   node tools/test-lang.js            (dev build)
 *   DAFTAR_EXE=...\Talabia.exe node tools/test-lang.js
 *   LANG_REPORT=1 → also writes tools/i18n-leftovers.txt (what is still in Arabic, for translating)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-lang-'));
const PORT = 9300 + Math.floor(Math.random() * 600);
const EXE = process.env.DAFTAR_EXE || null;

let pass = 0, fail = 0;
const dialogs = [], pageErrors = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + String(detail).slice(0, 600) : '')); }
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
      if (msg.method === 'Page.javascriptDialogOpening') { dialogs.push(msg.params.message); send('Page.handleJavaScriptDialog', { accept: false }); }
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

/** Arabic still visible on the screen, the shop's names and the switch's own «العربية» aside. */
const LEFT = `(function(){
  var keep={}; (S.products||[]).forEach(function(p){keep[p.name]=1;if(p.unit)keep[p.unit]=1});
  (S.events||[]).forEach(function(e){keep[e.name]=1}); (S.ws&&S.ws.branches||[]).forEach(function(b){keep[b.name]=1});
  (S.cat&&S.cat.items||[]).forEach(function(i){keep[i.name]=1;keep[i.unit]=1});
  keep["العربية"]=1;
  var names=Object.keys(keep).sort(function(a,b){return b.length-a.length});
  var out={}, ar=/[\\u0600-\\u06FF]/;
  var scan=function(s){
    s=String(s||""); names.forEach(function(k){ if(k) s=s.split(k).join("\\u25AA") });
    s.split(/\\n/).forEach(function(line){ line=line.trim(); if(line!=="ع"&&ar.test(line)) out[line.slice(0,160)]=1 });
  };
  scan(document.body.innerText);
  document.querySelectorAll("[title],[placeholder],[aria-label]").forEach(function(el){
    if(el.closest("[hidden]")) return;
    ["title","placeholder","aria-label"].forEach(function(a){ scan(el.getAttribute(a)) }) });
  scan(document.title);
  return JSON.stringify(Object.keys(out));
})()`;

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('language test, profile ' + PROFILE + '\n');
  const proc = launch();
  let cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');
  check('Arabic by default: right to left, Arabic tabs', await cdp.evaluate('document.documentElement.dir==="rtl" && document.querySelector(\'#tabs button[data-tab="order"]\').textContent.trim()==="الطلبية"'));
  check('the header has the language switch (EN)', await cdp.evaluate('document.getElementById("langBtn").textContent.trim()==="EN"'));

  console.log('\n--- switching to English ---');
  await cdp.evaluate('document.getElementById("langBtn").click(); 1');
  await sleep(1500);
  cdp.close();
  cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready && window.LANG==="en"', 'the app in English');
  await sleep(600);
  check('English: left to right, lang en', await cdp.evaluate('document.documentElement.dir==="ltr" && document.documentElement.lang==="en" && getComputedStyle(document.querySelector(".app")).direction==="ltr"'));
  check('the tabs are in English', await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="order"]\').textContent.trim()==="Order" && document.querySelector(\'#tabs button[data-tab="recipes"]\').textContent.trim()==="Ingredients & recipes"'),
    await cdp.evaluate('Array.prototype.map.call(document.querySelectorAll("#tabs button"),function(b){return b.textContent.trim()}).join(" | ")'));
  check('the switch now offers Arabic (ع)', await cdp.evaluate('document.getElementById("langBtn").textContent.trim()==="ع"'));

  const all = {};
  const tabs = ['order', 'entry', 'items', 'recipes', 'stats', 'setup', 'branches'];
  for (const t of tabs) {
    const has = await cdp.evaluate(`!!document.querySelector('#tabs button[data-tab="${t}"]') && !document.querySelector('#tabs button[data-tab="${t}"]').hidden`);
    if (!has) continue;
    await cdp.evaluate(`document.querySelector('#tabs button[data-tab="${t}"]').click(); 1`);
    await waitFor(cdp, `window.S.tab==="${t}"`, 'the ' + t + ' screen');
    await sleep(700);
    if (t === 'stats') { await cdp.evaluate('var r=document.querySelector(".statRow"); if(r) r.click(); 1'); await sleep(500); }
    const left = JSON.parse(await cdp.evaluate(LEFT));
    left.forEach(x => { all[x] = (all[x] || []).concat(t); });
    check(t + ': no Arabic left in English (' + left.length + ' left)', left.length === 0, left.slice(0, 8).join(' ‖ '));
  }
  // the import wizard
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click(); 1');
  await sleep(400);
  const csv = 'Date,Product,Quantity\n' + await cdp.evaluate('ymd(addDays(today(),-2))') + ',كيكة الشوكولاتة,5\n,منتج جديد تماماً,2\n';
  await cdp.evaluate(`(function(){ startImport(new File([${JSON.stringify(csv)}], "s.csv", {type:"text/csv"})); return 1 })()`);
  await waitFor(cdp, 'window.S.imp && document.getElementById("impScope")', 'the import screen');
  await sleep(500);
  let left = JSON.parse(await cdp.evaluate(LEFT)).filter(x => !/منتج جديد تماماً/.test(x));
  left.forEach(x => { all[x] = (all[x] || []).concat('import'); });
  check('import: no Arabic left in English (' + left.length + ' left)', left.length === 0, left.slice(0, 8).join(' ‖ '));
  await cdp.evaluate('document.getElementById("impCancel2").click(); 1');

  console.log('\n--- the shop\'s names stay as written ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="items"]\').click(); 1');
  await waitFor(cdp, 'window.S.tab==="items" && document.querySelector(".itIn")', 'the items screen');
  check('a product name shows exactly as typed', await cdp.evaluate('(function(){var p=S.products[0].name; return Array.prototype.some.call(document.querySelectorAll(".itIn[data-f=name]"),function(i){return i.value===p})})()'));
  check('the branch name in the header stays as typed', await cdp.evaluate('document.getElementById("branchName").textContent===S.ws.branches.filter(function(b){return b.id===S.branchId})[0].name'));
  check('the data is unchanged by the language (names still Arabic in memory)', await cdp.evaluate('/[\\u0600-\\u06FF]/.test(S.products[0].name)'));

  console.log('\n--- dialogs ---');
  dialogs.length = 0;
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="items"]\').click(); 1'); await sleep(400);
  await cdp.evaluate('var b=document.querySelector(".delItem"); b&&b.click(); 1');
  await sleep(500);
  check('a confirm dialog is in English (' + (dialogs[0] || '').slice(0, 60) + ')', dialogs.length > 0 && !/[ء-ي]{4,}(?![^«]*»)/.test(dialogs[0].replace(/«[^»]*»/g, '')), dialogs.join(' | '));

  console.log('\n--- back to Arabic from Settings ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click(); 1');
  await waitFor(cdp, 'document.getElementById("langAr")', 'the language section');
  await cdp.evaluate('document.getElementById("langAr").click(); 1');
  await sleep(1500);
  cdp.close();
  cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await waitFor(cdp, 'window.S && window.S.ready && window.LANG==="ar"', 'the app in Arabic');
  check('Arabic again, right to left, on the screen that was open (settings)', await cdp.evaluate('document.documentElement.dir==="rtl" && S.tab==="setup" && document.querySelector(\'#tabs button[data-tab="order"]\').textContent.trim()==="الطلبية"'));

  if (process.env.LANG_REPORT) fs.writeFileSync(path.join(__dirname, 'i18n-leftovers.txt'), Object.keys(all).map(k => k + '\t' + all[k].join(',')).join('\n'), 'utf8');
  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
