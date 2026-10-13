'use strict';
/*
 * Every Arabic letter on every screen is drawn in IBM Plex Sans Arabic — the fonts ship inside the app, so this
 * holds with no internet. Asks Chromium which fonts it actually used for each element with Arabic text
 * (CSS.getPlatformFontsForNode), so a fallback to a Windows font anywhere is caught, including Arabic unit words
 * beside numbers («146 حبة · 29 كوب»).
 *
 *   node tools/test-fonts.js            (dev build)
 *   DAFTAR_EXE=...\Talabia.exe node tools/test-fonts.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-fonts-'));
const PORT = 9300 + Math.floor(Math.random() * 600);
const EXE = process.env.DAFTAR_EXE || null;
const ALLOWED = ['IBM Plex Sans Arabic', 'IBM Plex Mono', 'Archivo Black'];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + String(detail).slice(0, 500) : '')); }
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
    const waiting = new Map(), requests = [];
    const send = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
      if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate threw');
        return r.result.result.value;
      };
      resolve({ send, evaluate, requests, close: () => ws.close() });
    });
  });
}
async function waitFor(cdp, expr, label, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await cdp.evaluate('!!(' + expr + ')')) return true; await sleep(200); }
  throw new Error('timed out waiting for ' + label);
}
const { killOrphans } = require('./orphans');

/** The fonts Chromium used for each element holding Arabic text of its own, on the screen as it is now. */
async function fontsOnScreen(cdp) {
  await cdp.evaluate(`(function(){
    document.querySelectorAll("[data-fp]").forEach(function(e){e.removeAttribute("data-fp")});
    var n=0, ar=/[\\u0600-\\u06FF]/;
    document.querySelectorAll("body *").forEach(function(el){
      if(n>=350||el.closest("script,style,[hidden]")) return;
      var own=Array.prototype.some.call(el.childNodes,function(c){return c.nodeType===3&&ar.test(c.nodeValue)});
      if(own&&el.getClientRects().length) {
        el.setAttribute("data-fp",String(n++));
        // symbols no Arabic font carries (arrows, ✓ ✕): the system draws those, and that is fine — they are not Arabic
        var txt=el.textContent;      // the fonts Chromium reports cover the element's whole subtree
        el.setAttribute("data-sym",String((txt.match(/[\\u2190-\\u21FF\\u2700-\\u27BF\\u2713\\u2715]/g)||[]).length));
      }
    });
    return n })()`);
  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  const q = await cdp.send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: '[data-fp]' });
  const bad = [], used = new Set();
  let checked = 0;
  for (const nodeId of q.result.nodeIds || []) {
    const r = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    const fonts = (r.result && r.result.fonts) || [];
    fonts.forEach(f => used.add(f.familyName));
    // Chromium names the face with its weight («IBM Plex Sans Arabic SemiBold»): the family is the prefix
    let strange = fonts.filter(f => f.glyphCount > 0 && !ALLOWED.some(a => f.familyName.indexOf(a) === 0));
    if (strange.length) {
      const attrs = (await cdp.send('DOM.getAttributes', { nodeId })).result.attributes;
      const sym = +attrs[attrs.indexOf('data-sym') + 1] || 0;
      if (strange.reduce((s, f) => s + f.glyphCount, 0) <= sym) strange = [];      // only the arrows fell back
    }
    checked++;
    if (strange.length) {
      const html = await cdp.send('DOM.getOuterHTML', { nodeId });
      bad.push(strange.map(f => f.familyName + '×' + f.glyphCount).join('+') + ' in ' + String(html.result.outerHTML).replace(/\s+/g, ' ').slice(0, 120));
    }
  }
  return { checked, bad, used: [...used] };
}

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('fonts test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await targets()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); await cdp.send('Network.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');
  await waitFor(cdp, 'document.fonts.status === "loaded"', 'the fonts');

  check('the Arabic font is inside the app (a local file, loaded)', await cdp.evaluate('document.fonts.check("16px \\"IBM Plex Sans Arabic\\"", "حبة")') &&
    await cdp.evaluate('Array.prototype.some.call(document.styleSheets,function(s){return /vendor\\/fonts\\/fonts\\.css$/.test(s.href||"")})'));
  const tabs = [['order', 'على مخزونك الحالي وحده'], ['entry', 'آخر أربعة عشر يوماً'], ['items', 'متوسّط يومي'], ['recipes', 'المواد والأصناف التشغيلية'], ['stats', 'الأكثر مبيعاً'], ['schedule', 'جدول الطلب'], ['calendar', 'المناسبات'], ['setup', 'التخزين والمزامنة']];
  for (const [t, mark] of tabs) {
    await cdp.evaluate(`document.querySelector('#tabs button[data-tab="${t}"]').click(); 1`);
    await waitFor(cdp, `window.S.tab==="${t}" && document.getElementById("view").innerText.indexOf(${JSON.stringify(mark)})>=0`, 'the ' + t + ' screen');
    await sleep(400);
    const r = await fontsOnScreen(cdp);
    check(t + ': every Arabic text is drawn in IBM Plex Sans Arabic (' + r.checked + ' elements)', r.checked > 10 && r.bad.length === 0, r.bad.slice(0, 4).join(' | '));
  }
  // the daily close's totals card: «146 حبة · 29 كوب …» — numbers in the number font, units in the Arabic one
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="entry"]\').click(); 1');
  await waitFor(cdp, 'document.querySelector(".card.good .val")', 'the sold-today card');
  const card = await (async () => {
    await cdp.evaluate('document.querySelectorAll("[data-fp]").forEach(function(e){e.removeAttribute("data-fp")}); (document.querySelector(".card.good .val span[dir=rtl] span[dir=rtl]")||document.querySelector(".card.good .val")).setAttribute("data-fp","card"); 1');
    const doc = await cdp.send('DOM.getDocument', { depth: 0 });
    const q = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '[data-fp="card"]' });
    const r = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: q.result.nodeId });
    return { text: await cdp.evaluate('document.querySelector(\'[data-fp="card"]\').innerText'), fonts: r.result.fonts.map(f => f.familyName + '×' + f.glyphCount) };
  })();
  check('the «مباع اليوم» card: digits in IBM Plex Mono, unit words in IBM Plex Sans Arabic (' + card.text.replace(/\s+/g, ' ') + ')',
    card.fonts.some(f => /^IBM Plex Mono/.test(f)) && card.fonts.some(f => /^IBM Plex Sans Arabic/.test(f)) && card.fonts.every(f => ALLOWED.some(a => f.indexOf(a) === 0)), card.fonts.join(', '));
  check('no font is fetched from the internet', !cdp.requests.some(u => /fonts\.(googleapis|gstatic)\.com/.test(u)), cdp.requests.filter(u => /fonts\./.test(u)).join(' '));

  cdp.close(); proc.kill(); await sleep(800);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
