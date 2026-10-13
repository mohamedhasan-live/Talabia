'use strict';
/*
 * The AI explanation layer against a local stand-in for the Anthropic API (no real key, no network):
 *   off without a key; the key stored encrypted and never in the page; the request (model, fallback, system rules,
 *   calculated context only); answers verified number by number; invented numbers flagged; failures said plainly.
 *
 *   node tools/test-ai.js            (dev build)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-ai-'));
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

// A stand-in for the Anthropic API on this computer: the app is pointed at it (DAFTAR_AI_BASE_URL, test runs only).
const http = require('http');
const seen = [];
let reply = 'ok';
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let j = null; try { j = JSON.parse(body); } catch (e) { /* not json */ }
    seen.push({ url: req.url, headers: req.headers, body: j });
    if (reply === '401') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); return; }
    const text = typeof reply === 'function' ? reply(j) : reply;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
  });
});
const TEST_KEY = 'sk-ant-test-' + 'x'.repeat(32);       // a test value for this throwaway profile only

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  process.env.DAFTAR_AI_BASE_URL = 'http://127.0.0.1:' + mock.address().port;
  console.log('AI layer test, profile ' + PROFILE + ', stand-in ' + process.env.DAFTAR_AI_BASE_URL + '\n');
  const proc = launch();
  const cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');
  const ev = async (x) => JSON.parse(await cdp.evaluate('(async function(){ return JSON.stringify(await (' + x + ')) })()'));
  // synthetic sales so the context has something calculated in it
  await cdp.evaluate(`(function(){ var p=S.products[0]; for(var i=1;i<=10;i++){ var k=ymd(addDays(today(),-i)); S.days[k]={date:k,items:{}}; S.days[k].items[p.id]={sold:3+i%4,waste:0,stockout:false}; S.imports.push({id:"t"+i,from:k,to:k,complete:true,mode:"replace",hash:""}) } relearn(); S.tab="stats"; render(); return 1 })()`);

  console.log('--- off until a key is stored ---');
  await waitFor(cdp, 'S.aiState', 'the AI state');
  check('without a key the AI is off and says so', (await ev('S.aiState.enabled')) === false && await ev('!!document.getElementById("aiCard") && !document.getElementById("aiAsk")'));
  check('asking without a key makes no request', (await ev('window.desktop.aiAsk({question:"x",context:"{}"})')).error === 'off' && seen.length === 0);

  console.log('\n--- storing the key (owner, Settings) ---');
  const bad = await ev('window.desktop.aiSetKey("not-a-key")');
  check('a value that is not an Anthropic key is refused', bad.ok === false, JSON.stringify(bad));
  const set = await ev(`window.desktop.aiSetKey(${J(TEST_KEY)})`);
  check('the key is stored and the AI switches on', set.ok && set.enabled, JSON.stringify(set));
  const keyFile = path.join(PROFILE, 'ai-key.bin');
  check('the key file is encrypted (the key is not readable in it)', fs.existsSync(keyFile) && fs.readFileSync(keyFile).toString('latin1').indexOf(TEST_KEY) < 0);
  check('the page never holds the key', (await ev('window.desktop.aiState()')).enabled === true && (await cdp.evaluate('JSON.stringify(window.S).indexOf(' + J(TEST_KEY) + ')')) < 0);

  console.log('\n--- a question, answered from the app\'s own numbers ---');
  await cdp.evaluate('S.aiState=null; render(); 1');
  await waitFor(cdp, 'document.getElementById("aiAsk")', 'the question box');
  reply = (j) => { const ctx = JSON.parse(j.messages[0].content.split('\n').slice(1).join('\n').split('\n\nسؤال المدير:')[0]); const p = ctx.products[0];
    return 'الصنف ' + p.name + ' متوسّطه ' + (Math.round(p.history.average * 10) / 10) + ' في اليوم.'; };
  await cdp.evaluate('document.querySelector(".aiPreset").click(); 1');
  await waitFor(cdp, 'S.ai && !S.ai.busy', 'the answer');
  const req = seen[seen.length - 1];
  check('the request goes to the Messages API with the stored key', req.url.indexOf('/v1/messages') >= 0 && req.headers['x-api-key'] === TEST_KEY, req.url);
  check('model claude-opus-5-5, refusal fallback on, effort set', req.body.model === 'claude-opus-5-5' && req.body.fallbacks === 'default' && String(req.headers['anthropic-beta'] || '').indexOf('server-side-fallback-2026-07-01') >= 0 && req.body.output_config.effort === 'medium', JSON.stringify({ m: req.body.model, f: req.body.fallbacks, b: req.headers['anthropic-beta'] }));
  check('the system prompt forbids invented numbers and missing-as-zero', /لا تخترع رقماً/.test(req.body.system) && /missing/.test(req.body.system));
  check('the question carries the calculated context (traces, semantics), not raw series', /سياق التطبيق/.test(req.body.messages[0].content) && /next7Days/.test(req.body.messages[0].content) && !/"series"/.test(req.body.messages[0].content));
  check('the answer is shown and marked verified (its numbers are in the data)', await ev('!!document.getElementById("aiAnswer") && S.ai.check.ok') && await ev('document.getElementById("aiCard").parentNode.innerHTML.indexOf("موجودة في بيانات التطبيق")>=0'), await ev('S.ai'));

  console.log('\n--- an invented number is flagged ---');
  reply = 'سيبيع الفرع 7654321 قطعة غداً.';
  await cdp.evaluate('document.getElementById("aiQ").value="كم سيبيع الفرع غداً؟"; document.getElementById("aiAsk").click(); 1');
  await waitFor(cdp, 'S.ai && !S.ai.busy && S.ai.q==="كم سيبيع الفرع غداً؟"', 'the second answer');
  check('the number 7654321 is listed as not found, and the answer is not marked verified', await ev('S.ai.check.ok===false && S.ai.check.unknown.indexOf("7654321")>=0'), await ev('S.ai'));

  console.log('\n--- failures are said plainly ---');
  reply = '401';
  await cdp.evaluate('document.getElementById("aiAsk").click(); 1');
  await waitFor(cdp, 'S.ai && !S.ai.busy && S.ai.error', 'the error');
  check('a rejected key gives a clear message, nothing else changes', /غير صالح/.test(await ev('S.ai.error')), await ev('S.ai.error'));
  check('the forecast and the order are untouched by any of this', await ev('(function(){var p=S.products[0]; return forecastTrace(p,addDays(today(),1)).forecast===forecast(p,addDays(today(),1))})()'));

  console.log('\n--- removing the key ---');
  const clr = await ev('window.desktop.aiSetKey("")');
  check('removing the key switches the AI off and deletes the file', clr.ok && clr.enabled === false && !fs.existsSync(keyFile), JSON.stringify(clr));

  cdp.close(); proc.kill(); mock.close(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
