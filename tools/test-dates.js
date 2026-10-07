'use strict';
/*
 * Typing a date by hand, fast, into every date field — the calendar picker kept.
 *
 * For each field: focus it, type dd mm yyyy one key at a time while the app
 * redraws itself in the background (as sync and branch counts do), and check
 * that the field keeps the focus the whole way, the screen is not rebuilt under
 * the fingers, the typed date is the one that lands, and it is applied once
 * the shop leaves the field (Tab / Enter). A date picked from the calendar
 * (no typing) still applies at once.
 *
 *   node tools/test-dates.js            (dev build)
 *   DAFTAR_EXE=...\Talabia.exe node tools/test-dates.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-dates-'));
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
    await sleep(150);
  }
  throw new Error('timed out waiting for ' + label);
}
const { killOrphans } = require('./orphans');

async function key(cdp, k, code, vk) {
  const base = { key: k, code: code || k, windowsVirtualKeyCode: vk || 0 };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base, k.length === 1 ? { text: k } : {}));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const digitKey = (cdp, d) => key(cdp, d, 'Digit' + d, 48 + +d);

/**
 * Type `ymd` into the field found by `sel` as dd mm yyyy, a background redraw
 * between keystrokes, then leave the field with `leave` ("tab" or "enter").
 */
async function typeDate(cdp, sel, ymd, leave, noYear) {
  const [y0, m, d] = ymd.split('-');
  // a field whose min and max share a year fills the year itself; the shop types day and month only
  const y = noYear ? '' : y0;
  // the previous field's commit (and the redraw it releases) lands before this field's count starts
  await waitFor(cdp, '!window.HOLD_RENDER && !window.holdT && !window.POINTER_DOWN', 'the previous field to settle');
  await sleep(800);                       // longer than the soft redraw a previous field's edit schedules (700 ms)
  await cdp.evaluate(`(function(){
    window.__renders = 0;
    // count the redraws that really rebuild the screen (a deferred one only touches the header)
    window.__stacks = [];
    if (!window.__wrapped) { var r = window.render; window.render = function(){ if (!dateTypingInView()) { window.__renders++; window.__stacks.push(String(new Error().stack).replace(/file:\\/\\/\\/[^)]*index\\.html/g,"").split("\\n").slice(2,8).join(" < ") + " ev=" + (window.event&&window.event.type) + " @" + (document.activeElement&&document.activeElement.id)) } return r.apply(this, arguments) }; window.__wrapped = true; }
    var el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({block:"center"}); el.focus(); return 1 })()`);
  await sleep(150);
  // put the caret on the day segment, the way a click at the start of the field does
  await key(cdp, 'Home', 'Home', 36);
  const focusLost = [];
  const keys = (d + m + y).split('');
  // Chromium forgets a half-typed segment after about a second without a key; when the HARNESS itself is
  // that slow between two keys (a loaded machine), the test did not type fast and its result says nothing
  let maxGap = 0, lastKey = 0;
  for (let i = 0; i < keys.length; i++) {
    if (lastKey) maxGap = Math.max(maxGap, Date.now() - lastKey);
    lastKey = Date.now();
    await digitKey(cdp, keys[i]);
    await sleep(35);                       // fast typing
    if (i === 3 || i === 6) await cdp.evaluate('render(); 1');   // a sync / stats redraw arrives mid-typing
    const still = await cdp.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`);
    if (!still) focusLost.push(i);
    if (process.env.DATES_DEBUG) console.log('      key ' + keys[i] + ' -> ' + await cdp.evaluate(`(function(){var el=document.querySelector(${JSON.stringify(sel)});
      return JSON.stringify({v:el&&el.value, held:el&&!!el._dateHeld, r:window.__renders, act:document.activeElement&&(document.activeElement.id||document.activeElement.className)})})()`));
  }
  const mid = JSON.parse(await cdp.evaluate(`JSON.stringify({value: (document.querySelector(${JSON.stringify(sel)})||{}).value,
    focused: document.activeElement === document.querySelector(${JSON.stringify(sel)}), renders: window.__renders, stacks: window.__stacks.join(" || ")})`));
  if (leave === 'enter') await key(cdp, 'Enter', 'Enter', 13);
  else await cdp.evaluate(`document.querySelector(${JSON.stringify(sel)}).blur(); 1`);
  await sleep(400);
  return { focusLost, mid, maxGap };
}

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('date typing test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await targets()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');
  const tab = async (t) => {
    await cdp.evaluate(`document.querySelector('#tabs button[data-tab="${t}"]').click()`);
    await waitFor(cdp, `window.S.tab === "${t}"`, 'the ' + t + ' tab');
    await sleep(300);
  };
  const today = await cdp.evaluate('ymd(today())');
  const past = await cdp.evaluate('ymd(addDays(today(), -17))');
  const past2 = await cdp.evaluate('ymd(addDays(today(), -9))');

  async function field(label, sel, ymd, committed, leave, noYear) {
    let r = await typeDate(cdp, sel, ymd, leave || 'tab', noYear);
    // the harness, not the app, paused long enough for Chromium to drop the segment: type it again (same checks)
    for (let k = 0; k < 2 && r.mid.value !== ymd && r.maxGap >= 800; k++) {
      console.log('      (harness paused ' + r.maxGap + ' ms between keys — typing ' + label + ' again)');
      r = await typeDate(cdp, sel, ymd, leave || 'tab', noYear);
    }
    check(label + ': keeps the focus while typing fast with redraws arriving', r.focusLost.length === 0, 'lost after keys ' + r.focusLost.join(','));
    check(label + ': the screen is not rebuilt under the fingers', r.mid.renders === 0, 'rebuilt ' + r.mid.renders + ' times while typing: ' + r.mid.stacks);
    check(label + ': the typed date is in the field (' + r.mid.value + ')', r.mid.value === ymd, JSON.stringify(r.mid));
    const got = await cdp.evaluate(committed);
    check(label + ': applied on leaving the field (' + got + ')', got === ymd, got);
  }

  console.log('--- order date ---');
  await tab('order');
  const future = await cdp.evaluate('ymd(addDays(today(), 12))');
  await field('order date', '#planDate', future, 'window.S.planDate');
  check('order date: the plan moved to that day', await cdp.evaluate('document.getElementById("planDate").value') === future);
  await field('order date (Enter)', '#planDate', await cdp.evaluate('ymd(addDays(today(), 5))'), 'window.S.planDate', 'enter');

  // leaving by a real mouse click on something else: the click must land AND the date apply
  {
    const target = await cdp.evaluate('ymd(addDays(today(), 9))');
    const [y, m, d] = target.split('-');
    await cdp.evaluate('document.getElementById("planDate").focus(); 1');
    await key(cdp, 'Home', 'Home', 36);
    for (const ch of (d + m + y)) { await digitKey(cdp, ch); await sleep(30); }
    const pt = JSON.parse(await cdp.evaluate(`(function(){var b=document.querySelector('#tabs button[data-tab="items"]').getBoundingClientRect();
      return JSON.stringify({x:b.left+b.width/2, y:b.top+b.height/2})})()`));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await sleep(500);
    const after = JSON.parse(await cdp.evaluate('JSON.stringify({tab: window.S.tab, plan: window.S.planDate})'));
    check('a click elsewhere right after typing is not swallowed (tab ' + after.tab + ')', after.tab === 'items', JSON.stringify(after));
    check('…and the typed order date is applied (' + after.plan + ')', after.plan === target, JSON.stringify(after));
  }

  console.log('\n--- daily close ---');
  await tab('entry');
  await field('daily-close date', '#entryDate', past, 'window.S.entryDate');

  console.log('\n--- analysis range ---');
  await tab('stats');
  await field('analysis from', '#statFrom', past, 'window.S.statFrom');
  await field('analysis to', '#statTo', past2, 'window.S.statTo');
  await cdp.evaluate('(document.getElementById("statClear")||{click:function(){}}).click()');
  await sleep(300);

  console.log('\n--- occasions ---');
  await tab('setup');
  await waitFor(cdp, 'document.querySelector(\'.evIn[data-f="from"]\')', 'an occasion row');
  const evId = await cdp.evaluate('document.querySelector(\'.evIn[data-f="from"]\').dataset.id');
  await field('occasion start', `.evIn[data-id="${evId}"][data-f="from"]`, '2026-11-20',
    `(window.S.events.filter(function(e){return e.id===${JSON.stringify(evId)}})[0]||{}).from`);

  console.log('\n--- import ---');
  await tab('entry');
  const csv = 'Date,Product,Quantity\n' + past + ',كيكة الشوكولاتة,5\n' + today + ',كيكة الشوكولاتة,6\n,براونيز,2\n';
  await cdp.evaluate(`(function(){ startImport(new File([${JSON.stringify(csv)}], "d.csv", {type:"text/csv"})); return 1 })()`);
  await waitFor(cdp, 'window.S.imp && document.getElementById("impFrom")', 'the import screen');
  await field('import from', '#impFrom', past2, 'window.S.imp.from');
  await field('import to', '#impTo', today, 'window.S.imp.to');
  const row = await cdp.evaluate('document.querySelector(".impUndated").dataset.row');
  const sameYear = await cdp.evaluate(`(function(){var el=document.getElementById("impU"+${JSON.stringify(row)});
    return !!(el.min&&el.max&&el.min.slice(0,4)===el.max.slice(0,4))})()`);
  await field('undated row', '#impU' + row, past2, `window.S.imp.undated[${JSON.stringify(row)}]`, 'tab', sameYear);
  await cdp.evaluate('document.getElementById("impScopeDay").click()');
  await waitFor(cdp, 'document.getElementById("impSingleDate")', 'the day picker');
  await field('import single day', '#impSingleDate', past, 'window.S.imp.singleDate');

  console.log('\n--- the calendar picker still applies at once ---');
  // a pick from the calendar sets the value with no typing; it must not wait for the field to be left
  await cdp.evaluate(`(function(){ var el=document.getElementById("impSingleDate"); el.focus();
    el.value=${JSON.stringify(past2)}; el.dispatchEvent(new Event("input",{bubbles:true})); return 1 })()`);
  await sleep(300);
  check('a picked date applies without leaving the field', await cdp.evaluate('window.S.imp.singleDate') === past2);
  await cdp.evaluate('document.getElementById("impCancel2").click()');

  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
