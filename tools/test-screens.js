'use strict';
/*
 * The products and recipes screens (synthetic data, a throwaway profile):
 *   typing with real key presses while redraws run: the field keeps the focus and every letter (products, aliases,
 *   materials, recipe quantities, search); a rename keeps only the old name as an alias, never half-typed names;
 *   the section menus (like the control panel); the read-only «مراجعة» notes.
 *
 *   node tools/test-screens.js            (dev build)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-screens-'));
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
  return spawn(EXE || ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { DAFTAR_TEST_PDF_FILE: require('path').join(require('os').tmpdir(), 'talabia-test-out.pdf') }) });
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

// SYNTHETIC test data only — a throwaway profile; nothing reaches a real branch or the cloud.
(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('screens test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');
  const ev = async (x) => JSON.parse(await cdp.evaluate('JSON.stringify(' + x + ')'));
  // real key presses, one by one, while a background redraw (a sync, a stats refresh) runs every 150 ms
  const typeWhileRedrawing = async (selector, text, selectAll) => {
    await cdp.evaluate(`(function(){var n=document.querySelector(${J(selector)}); n.focus(); if(${!!selectAll}){ try{n.select()}catch(e){} } else { try{ var L=n.value.length; n.setSelectionRange(L,L) }catch(e){} } return 1})()`);
    const iv = setInterval(() => cdp.evaluate('render(); 1').catch(() => {}), 150);
    for (const ch of text) { await cdp.send('Input.insertText', { text: ch }); await sleep(70); }
    await sleep(500); clearInterval(iv); await sleep(200);
    return ev(`(function(){var a=document.activeElement; return {focused:!!a&&a.matches(${J(selector)}), value:a&&a.value}})()`);
  };
  // a real mouse click (press, a moment, release) in the middle of a field: does the focus land in it?
  const clickOn = async (sel) => {
    const r = await ev(`(function(){ var n=document.querySelector(${J(sel)}); n.scrollIntoView({block:"center"}); var b=n.getBoundingClientRect(); return {x:b.left+b.width/2, y:b.top+b.height/2} })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(80);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(300);
    return ev(`(function(){ var a=document.activeElement; return !!a && a.matches(${J(sel)}) })()`);
  };

  console.log('--- typing is never interrupted by a redraw ---');
  await cdp.evaluate('S.tab="items"; S.itemSec="list"; render(); 1'); await sleep(300);
  const r1 = await typeWhileRedrawing('.itIn[data-id="p01"][data-f="name"]', 'كيكة الشوكولاتة الداكنة', true);
  check('a product name: the field keeps the focus and every letter', r1.focused && r1.value === 'كيكة الشوكولاتة الداكنة', J(r1));
  await cdp.evaluate('document.activeElement.blur(); 1'); await sleep(300);
  const p01 = await ev('S.products.filter(function(p){return p.id==="p01"})[0]');
  check('the rename keeps ONLY the old name as an alias — no half-typed names', J(p01.aliases) === J(['كيكه الشوكولاته']), J(p01.aliases));
  const r1b = await typeWhileRedrawing('.itIn[data-id="p02"][data-f="aliases"]', '، توت كيك', false);
  check('the aliases field keeps the focus too', r1b.focused && /توت كيك$/.test(r1b.value), J(r1b));
  await cdp.evaluate('document.activeElement.blur(); 1');
  // the exact Odoo name, typed into the aliases field: it must not vanish, and no half-typed code is stored
  const r1c = await typeWhileRedrawing('.itIn[data-id="p03"][data-f="aliases"]', '، [POS-CH-099] Test Balls 16 | تست بولز 16', false);
  check('typing the Odoo name: the field keeps it while typing', r1c.focused && /\[POS-CH-099\] Test Balls 16 \| تست بولز 16$/.test(r1c.value), J(r1c));
  await cdp.evaluate('document.activeElement.blur(); 1'); await sleep(400);
  const p03 = await ev(`(function(){ var p=S.products.filter(function(p){return p.id==="p03"})[0], tr=document.querySelector('tr[data-pid="p03"]');
    return {aliases:p.aliases, field:tr.querySelector('.itIn[data-f="aliases"]').value, row:tr.innerText} })()`);
  check('…after leaving: its code and its names are stored', ['pos ch 099', 'test balls 16', 'تست بولز 16'].every(a => p03.aliases.indexOf(a) >= 0), J(p03.aliases));
  check('…the names stay visible in the field and the code shows as a chip', /تست بولز 16/.test(p03.field) && /POS-CH-099/.test(p03.row), J({ field: p03.field }));
  check('…«Test Balls 16» (a name with a size) is a name in the field, not a code chip', /test balls 16/i.test(p03.field) && !/TEST-BALLS-16/.test(p03.row), J({ field: p03.field }));
  // pasting a plain English Odoo name with a size (as the owner did for كنافة بولز 16): one paste, it stays
  await cdp.evaluate(`(function(){ var n=document.querySelector('.itIn[data-id="p04"][data-f="aliases"]'); n.focus(); var L=n.value.length; n.setSelectionRange(L,L); return 1 })()`);
  await cdp.send('Input.insertText', { text: '، Kunafa Balls 16' }); await sleep(300);
  await cdp.evaluate('document.activeElement.blur(); 1'); await sleep(400);
  const p04 = await ev(`(function(){ var p=S.products.filter(function(p){return p.id==="p04"})[0], tr=document.querySelector('tr[data-pid="p04"]');
    return {aliases:p.aliases, field:tr.querySelector('.itIn[data-f="aliases"]').value, row:tr.innerText} })()`);
  check('a pasted «Kunafa Balls 16» stays in the field after leaving it', /kunafa balls 16/i.test(p04.field) && p04.aliases.indexOf('kunafa balls 16') >= 0 && !/KUNAFA-BALLS-16/.test(p04.row), J(p04));
  check('codes are only Odoo-shaped (POS-CH-021 yes; Kunafa Balls 16, Triple Classic 96 no)',
    await ev('isOdooCode("pos ch 021") && isOdooCode("pos cn 017") && !isOdooCode("kunafa balls 16") && !isOdooCode("triple classic 96") && !isOdooCode("pos ch 021 kunafa balls 16")'));
  // the owner's case: paste an Odoo line — it shows exactly as pasted; replace it with another — only the new code is left
  const pasteInto = async (id, text, clear) => {
    await cdp.evaluate(`(function(){ var n=document.querySelector('.itIn[data-id="${id}"][data-f="aliases"]'); n.focus(); ${clear ? 'n.select();' : 'var L=n.value.length; n.setSelectionRange(L,L);'} return 1 })()`);
    if (text) await cdp.send('Input.insertText', { text }); else await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }).then(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }));
    await sleep(300);
    await cdp.evaluate('document.activeElement.blur(); 1'); await sleep(400);
    return ev(`(function(){ var p=S.products.filter(function(p){return p.id==="${id}"})[0], tr=document.querySelector('tr[data-pid="${id}"]');
      return {aliases:p.aliases, list:p.aliasList, field:tr.querySelector('.itIn[data-f="aliases"]').value, row:tr.innerText} })()`);
  };
  const ODOO1 = '[POS-CH-022] Cinnamon Balls 48 | سينامون بولز 48', ODOO2 = '[POS-CH-023] Kunafa Balls 28 | كنافة بولز 28';
  const pa = await pasteInto('p06', ODOO1, true);
  check('a pasted Odoo line shows exactly as pasted', pa.field === ODOO1, J(pa));
  check('…its code is a chip and the import matches its code and names', /POS-CH-022/.test(pa.row) && ['pos ch 022', 'cinnamon balls 48', 'سينامون بولز 48'].every(a => pa.aliases.indexOf(a) >= 0), J(pa.aliases));
  const pb = await pasteInto('p06', ODOO2, true);
  check('replacing it with another line: the field shows the new line only', pb.field === ODOO2, J(pb));
  check('…and the old code chip and old names are gone', !/POS-CH-022/.test(pb.row) && /POS-CH-023/.test(pb.row) && !pb.aliases.some(a => /022|cinnamon|سينامون/.test(a)), J(pb));
  const pc = await pasteInto('p06', '', true);
  check('emptying the field leaves no code chip and no alias', !/POS-CH-02/.test(pc.row) && pc.aliases.length === 0 && pc.field === '', J(pc));
  // long aliases never squeeze the product-name column
  await cdp.evaluate(`(function(){ var p=S.products.filter(function(p){return p.id==="p05"})[0]; p.aliases=(p.aliases||[]).concat(["pos ch 077","pos cn 078","pos xx 079","a very long english odoo product name number one","another very long english odoo product name number two"]); render(); return 1 })()`);
  await sleep(200);
  const widths = await ev(`(function(){ var tr=document.querySelector('tr[data-pid="p05"]'), c=tr.querySelectorAll('td'); return {name:Math.round(c[0].getBoundingClientRect().width), alias:Math.round(tr.querySelector('.itIn[data-f="aliases"]').parentNode.getBoundingClientRect().width)} })()`);
  check('the product-name column keeps its width (≥ 130 px) next to many aliases and codes', widths.name >= 130 && widths.alias <= 300, J(widths));
  check('…and nothing half-typed was stored («pos ch 0», «pos ch 09», «[pos»…)', !p03.aliases.some(a => /^(pos|pos ch|pos ch 0|pos ch 09)$/.test(a)), J(p03.aliases));
  // a new product named for the first time: its placeholder name is not an alias
  await cdp.evaluate('document.getElementById("addItem").click(); 1'); await sleep(300);
  const nid = await ev('S.products[S.products.length-1].id');
  await typeWhileRedrawing(`.itIn[data-id="${nid}"][data-f="name"]`, 'صنف تجريبي', true);
  await cdp.evaluate('document.activeElement.blur(); 1'); await sleep(300);
  const np = await ev(`S.products.filter(function(p){return p.id===${J(nid)}})[0]`);
  check('a new product renamed from «صنف جديد» gets no alias at all', np.name === 'صنف تجريبي' && !(np.aliases || []).length, J(np));

  console.log('\n--- the products screen: sections and search ---');
  await cdp.evaluate('S.itemSec="help"; render(); 1'); await sleep(200);
  check('«معنى الأعمدة» shows the help alone (no table)', await ev('!document.querySelector("#view tr[data-q]") && /معنى كلّ عمود/.test(document.getElementById("view").innerText)'));
  await cdp.evaluate('document.getElementById("itemSec_list").click(); 1'); await sleep(200);
  check('«قائمة الأصناف» shows the list', await ev('document.querySelectorAll("#view tr[data-q]").length===S.products.length'));
  const sr = await typeWhileRedrawing('#itSearch', 'براون', false);
  const shown = await ev('Array.prototype.filter.call(document.querySelectorAll("#view tr[data-q]"),function(r){return !r.hidden}).map(function(r){return r.dataset.pid})');
  check('the search filters the rows and keeps the focus', sr.focused && shown.length === 1 && shown[0] === 'p09', J({ sr, shown }));
  await cdp.evaluate('var s=document.getElementById("itSearch"); s.value=""; s.dispatchEvent(new Event("input",{bubbles:true})); 1');

  console.log('\n--- the recipes screen: a section at a time ---');
  // the brand's own catalogue finishes loading first, so it cannot land over the test catalogue afterwards
  await cdp.evaluate('ensureCatalog(); 1');
  await waitFor(cdp, 'window.S.catBrand===curBrandKey() && !window.S.catLoading', 'the brand catalogue to load');
  await cdp.evaluate(`(function(){ var b=curBrandKey(), K=function(id){return productKey(S.products.filter(function(p){return p.id===id})[0])};
    S.products.push({id:"OF1",name:"عرض تجريبي",unit:"عرض",shelfLife:1,active:true,aliases:[]});
    S.products.push({id:"OF2",name:"عرض بلا تعريف",unit:"عرض",shelfLife:1,active:true,aliases:[]});
    S.products.push({id:"S16",name:"بولز 16",unit:"بوكس",shelfLife:1,active:true,aliases:[]},{id:"S28",name:"بولز 28",unit:"بوكس",shelfLife:1,active:true,aliases:[]},{id:"S48",name:"بولز 48",unit:"بوكس",shelfLife:1,active:true,aliases:["بولز 28"]});
    var links={}, recipes={}, bundles={};
    links[K("p01")]={item:"sauce",factor:1};
    recipes[K("p01")]={lines:[{item:"sauce",qty:0.05,unit:"كجم"}]};                     // the same material through link and recipe
    recipes[K("S16")]={lines:[{item:"core",qty:16,unit:"حبة"},{item:"sauce",qty:0.16,unit:"كجم"}]};
    recipes[K("S28")]={lines:[{item:"core",qty:28,unit:"حبة"},{item:"sauce",qty:0.10,unit:"كجم"}]};   // 3.6 g a piece against 10 g
    recipes[K("S48")]={lines:[{item:"core",qty:48,unit:"حبة"},{item:"sauce",qty:0.48,unit:"كجم"}]};
    bundles[K("OF1")]={lines:[{kind:"p",ref:K("S48"),qty:48}]};                                      // 48 boxes of 48?
    S.cat=sanitizeCatalog({items:[{id:"core",name:"كور",unit:"حبة"},{id:"sauce",name:"صوص",unit:"كجم"},{id:"spare",name:"مادة لا تُستعمل",unit:"قطعة"}],links:links,recipes:recipes,bundles:bundles},b);
    S.catBrand=b; S.recSec=null; S.tab="recipes"; render(); return 1 })()`);
  await sleep(300);
  check('the screen opens on its section menu, nothing else', await ev('!!document.getElementById("recSecs") && !document.querySelector("#view .cp-panel")') && (await ev('document.querySelectorAll("#recSecs .recSec").length')) === 6);
  const secs = { items: 'catItems', links: 'catLinks', bundles: 'catBundles', recipes: 'catRecipes', mto: 'catMtoCard', review: 'catReview' };
  for (const [sec, id] of Object.entries(secs)) {
    await cdp.evaluate(`document.getElementById("recSec_${sec}").click(); 1`); await sleep(150);
    const others = Object.values(secs).filter(x => x !== id);
    check(`«${sec}» opens its own content only`, await ev(`!!document.getElementById(${J(id)}) && ${J(others)}.every(function(x){return !document.getElementById(x)})`));
  }
  await cdp.evaluate('document.getElementById("recSec_review").click(); 1'); await sleep(150);
  check('pressing the open section again closes it', await ev('S.recSec===null && !document.querySelector("#view .cp-panel")'));

  console.log('\n--- typing in the recipes screen ---');
  await cdp.evaluate('document.getElementById("recSec_items").click(); 1'); await sleep(150);
  const r2 = await typeWhileRedrawing('.catItem[data-id="sauce"][data-f="name"]', ' حار', false);
  check('a material name keeps the focus and the letters', r2.focused && r2.value === 'صوص حار', J(r2));
  await cdp.evaluate('document.activeElement.blur(); document.getElementById("recSec_recipes").click(); 1'); await sleep(200);
  const r3 = await typeWhileRedrawing('.catDef[data-kind="r"] .catLine[data-f="qty"]', '0.25', true);
  check('a recipe quantity keeps the focus and the number', r3.focused && r3.value === '0.25', J(r3));
  await cdp.evaluate('document.activeElement.blur(); 1');

  console.log('\n--- clicking from one field into the next: every click lands ---');
  // leaving a field saves and redraws; the redraw used to replace the field being clicked (half the clicks lost)
  await cdp.evaluate('S.tab="items"; S.itemSec="list"; render(); 1'); await sleep(300);
  let landed = 0, tries = 0;
  for (const id of ['p01', 'p02', 'p03', 'p04']) {
    tries++; if (await clickOn(`.itIn[data-id="${id}"][data-f="aliases"]`)) landed++;
    await cdp.send('Input.insertText', { text: '، [POS-ZZ-9' + id.slice(1) + '] Item ' + id + ' | صنف ' + id });
    await sleep(1000);
    tries++; if (await clickOn(`.itIn[data-id="${id}"][data-f="name"]`)) landed++;
    await cdp.send('Input.insertText', { text: ' ب' }); await sleep(1000);
    tries++; if (await clickOn(`.itIn[data-id="${id}"][data-f="unit"]`)) landed++;
  }
  check('products: every click into the next field lands (' + landed + '/' + tries + ')', landed === tries);
  await cdp.evaluate('document.activeElement.blur(); S.tab="recipes"; S.recSec="items"; render(); 1'); await sleep(300);
  landed = 0; tries = 0;
  for (const id of ['sauce', 'core', 'spare']) {
    tries++; if (await clickOn(`.catItem[data-id="${id}"][data-f="name"]`)) landed++;
    await cdp.send('Input.insertText', { text: ' ١' }); await sleep(1000);
    tries++; if (await clickOn(`.catItem[data-id="${id}"][data-f="shelfLife"]`)) landed++;
    await cdp.send('Input.insertText', { text: '3' }); await sleep(1000);
  }
  check('materials: every click into the next field lands (' + landed + '/' + tries + ')', landed === tries);
  await cdp.evaluate('document.activeElement.blur(); S.recSec="recipes"; S.defSel={r:"*"}; render(); 1'); await sleep(300);
  landed = 0; tries = 0;
  const nq = await ev('document.querySelectorAll(\'.catDef[data-kind="r"] .catLine[data-f="qty"]\').length');
  for (let i = 0; i < Math.min(nq, 4); i++) {
    tries++; if (await clickOn(`.catDef[data-kind="r"] tbody tr:nth-child(1) .catLine[data-f="qty"]`)) landed++;
    await cdp.send('Input.insertText', { text: '5' }); await sleep(1000);
    tries++; if (await clickOn(`.catDef[data-kind="r"] tbody tr:nth-child(2) .catLine[data-f="qty"]`)) landed++;
    await cdp.send('Input.insertText', { text: '7' }); await sleep(1000);
  }
  check('recipe lines: every click into the next quantity lands (' + landed + '/' + tries + ')', landed === tries && tries > 0);
  await cdp.evaluate('document.activeElement.blur(); 1');

  console.log('\n--- «مراجعة»: notes, nothing changed ---');
  const before = await ev('JSON.stringify(S.cat)');
  const rev = await ev('catReview().map(function(r){return r.kind+"|"+r.product})');
  const has = (k, p) => rev.some(x => x.split('|')[0] === k && (!p || x.split('|')[1].indexOf(p) >= 0));
  check('an «عرض» product with no offer definition', has('offer-undefined', 'عرض بلا تعريف'), J(rev));
  check('an offer asking for 48 × a whole box', has('offer-qty', 'عرض تجريبي'), J(rev));
  check('the same material through link and recipe (counted twice)', has('double', 'كيكة'), J(rev));
  check('a size whose per-piece amount is out of line (بولز 28)', has('size-ratio', 'بولز 28'), J(rev));
  check('an alias that is another product\'s name', has('alias-clash', 'بولز 48'), J(rev));
  check('a material nothing uses', has('unused'), J(rev));
  check('the review changes nothing', (await ev('JSON.stringify(S.cat)')) === before);
  await cdp.evaluate('document.getElementById("recSec_review").click(); 1'); await sleep(150);
  check('the review section lists them with their level', await ev('document.querySelectorAll("#catReview .catRevRow").length') === rev.length);

  console.log('\n--- offers and recipes: one window each, in the order the shop sets ---');
  await cdp.evaluate('S.recSec="recipes"; S.defSel={}; render(); 1'); await sleep(200);
  const bar = await ev('Array.prototype.map.call(document.querySelectorAll("#catRecipes .defPick"),function(b){return b.textContent})');
  check('the recipes show a bar of product names, one window open', bar.length === 5 && /الكلّ/.test(bar[4]) && (await ev('document.querySelectorAll("#catRecipes .catDef").length')) === 1, J(bar));
  await cdp.evaluate('document.querySelectorAll("#catRecipes .defPick")[2].click(); 1'); await sleep(150);
  check('picking a name opens that recipe only', (await ev('document.querySelector("#catRecipes .catDef b").textContent')) === bar[2], bar[2]);
  await cdp.evaluate('(function(){ var ks=defKeys(S.cat.recipes); dndMove("r",ks[2],ks[1],false); render(); return 1 })()'); await sleep(150);
  const bar2 = await ev('Array.prototype.map.call(document.querySelectorAll("#catRecipes .defPick"),function(b){return b.textContent})');
  check('moving it up the list keeps it open', bar2[1] === bar[2] && bar2[2] === bar[1] && (await ev('document.querySelector("#catRecipes .catDef b").textContent')) === bar[2], J(bar2));
  const back = await ev('(function(){ var c=sanitizeCatalog(JSON.parse(JSON.stringify(S.cat)),S.catBrand); return defKeys(c.recipes).map(function(k){return opName(opCtx(c,S.branchId),k)}) })()');
  check('…and the order survives saving and loading', J(back) === J(bar2.slice(0, 4)), J(back));
  await cdp.evaluate('document.querySelectorAll("#catRecipes .defPick")[4].click(); 1'); await sleep(150);
  check('«الكلّ» opens every recipe', (await ev('document.querySelectorAll("#catRecipes .catDef").length')) === 4);

  // the owner's «لمتنا 28»: an offer left behind by a deleted product, and a new product of the same name
  await cdp.evaluate(`(function(){ S.cat.bundles["n:"+normName("منتج محذوف 99")]={active:true,lines:[{kind:"i",ref:"core",qty:28}]}; S.recSec="bundles"; S.defSel={b:"n:"+normName("منتج محذوف 99")}; render(); return 1 })()`); await sleep(200);
  check('an offer whose product is gone is marked ⚠ with a way to tie it to a product', await ev('!!document.querySelector("#catBundles .catDefRelink") && /⚠/.test(document.querySelector("#catBundles .defBar").textContent)'));
  const opts = await ev('Array.prototype.map.call(document.querySelectorAll("#catNewBundle option"),function(o){return o.textContent})');
  check('the offers list names every product, the defined ones marked', opts.length === (await ev('S.products.length')) + 1 && opts.some(o => /عرض تجريبي — معرَّف/.test(o)), J(opts.slice(0, 6)));
  await cdp.evaluate(`(function(){ var s=document.querySelector("#catBundles .catDefRelink"); s.value=productKey(S.products.filter(function(p){return p.id==="OF2"})[0]); s.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`); await sleep(200);
  check('tying it to a product moves the offer to that product', await ev('!!catFind(S.cat.bundles,productKeys(S.products.filter(function(p){return p.id==="OF2"})[0])) && !S.cat.bundles["n:"+normName("منتج محذوف 99")]'));
  await cdp.evaluate(`(function(){ var s=document.getElementById("catNewBundle"); s.value=productKey(S.products.filter(function(p){return p.id==="OF1"})[0]); document.getElementById("catAddBundle").click(); return 1 })()`); await sleep(200);
  check('choosing a product already defined opens its window instead of adding', (await ev('document.querySelector("#catBundles .catDef b").textContent')) === 'عرض تجريبي' && (await ev('Object.keys(S.cat.bundles).length')) === 2);

  console.log('\n--- «المحذوفات»: delete, restore, delete for good ---');
  const nP = await ev('S.products.length');
  await cdp.evaluate('S.tab="items"; S.itemSec="list"; render(); document.querySelector(\'.delItem[data-id="p02"]\').click(); 1'); await sleep(200);
  check('a deleted product leaves the list and waits in «المحذوفات»', (await ev('S.products.length')) === nP - 1 && (await ev('S.trash[0].prod.id')) === 'p02');
  const usesBefore = await ev('catUses(S.cat,"sauce")');
  await cdp.evaluate('S.tab="recipes"; S.recSec="items"; render(); document.querySelector(\'.catItemDel[data-id="sauce"]\').click(); 1'); await sleep(200);
  check('a deleted material is kept with every place it was used', (await ev('S.cat.archive[0].kind')) === 'i' && (await ev('S.cat.archive[0].uses.length')) === usesBefore && usesBefore > 0, usesBefore);
  await cdp.evaluate(`(function(){ S.recSec="recipes"; S.defSel={r:"*"}; render(); document.querySelector("#catRecipes .catDefDel").click(); return 1 })()`); await sleep(200);
  check('a deleted recipe is kept', (await ev('S.cat.archive[0].kind')) === 'r');
  await cdp.evaluate('S.tab="items"; S.itemSec="trash"; render(); 1'); await sleep(200);
  check('«المحذوفات» lists the product, the material and the recipe', (await ev('document.querySelectorAll("#trashTable tbody tr").length')) === 3);
  // restore all three
  for (let n = 0; n < 3; n++) { await cdp.evaluate('document.querySelector("#trashTable .trRestore").click(); 1'); await sleep(200); }
  check('restoring brings the product back', (await ev('S.products.length')) === nP && (await ev('S.trash.length')) === 0);
  check('…the material back to every place it was used', (await ev('catUses(S.cat,"sauce")')) === usesBefore, await ev('catUses(S.cat,"sauce")'));
  check('…and the recipe back', (await ev('S.cat.archive.length')) === 0 && (await ev('Object.keys(S.cat.recipes).length')) === 4);
  await cdp.evaluate('S.tab="items"; S.itemSec="list"; render(); document.querySelector(\'.delItem[data-id="p03"]\').click(); S.itemSec="trash"; render(); document.querySelector("#trashTable .trPurge").click(); 1'); await sleep(200);
  check('«حذف نهائي» removes it for good', (await ev('S.trash.length')) === 0 && !(await ev('S.products.some(function(p){return p.id==="p03"})')));
  const rec = await ev('sanitizeRecord({products:[],trash:[{at:"2026-10-08T05:00:00Z",prod:{id:"x1",name:"تجربة",aliases:["a"],evil:1}}]}).trash');
  check('the trash survives saving, cleaned like any product', rec.length === 1 && rec[0].prod.name === 'تجربة' && rec[0].prod.evil === undefined, J(rec));

  console.log('\n--- reorder products and materials ---');
  await cdp.evaluate('S.itemSec="list"; render(); 1'); await sleep(150);
  const o1 = await ev('S.products.map(function(p){return p.id})');
  await cdp.evaluate(`dndMove("p","${o1[1]}","${o1[0]}",false); render(); 1`); await sleep(150);
  const o2 = await ev('S.products.map(function(p){return p.id})');
  check('moving a product puts it in its new place', o2[0] === o1[1] && o2[1] === o1[0], J(o2.slice(0, 3)));
  check('…and the rows follow', (await ev('document.querySelector("tbody tr[data-pid]").dataset.pid')) === o1[1]);
  // drag by the handle: the first product dropped below the fourth
  const d1 = await ev('S.products.map(function(p){return p.id})');
  const dragRes = await ev(`(function(){
    var ids=S.products.map(function(p){return p.id}), src=document.querySelector('tr[data-pid="'+ids[0]+'"]'), dst=document.querySelector('tr[data-pid="'+ids[3]+'"]');
    var h=src.querySelector(".itDrag"); if(!h) return {err:"no handle"};
    h.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));
    var dt=new DataTransfer(), r=dst.getBoundingClientRect(), y=r.top+r.height*0.8;
    src.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:dt}));
    dst.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}));
    var marked=dst.classList.contains("dropAfter");
    dst.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}));
    src.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:dt}));
    return {marked:marked, order:S.products.map(function(p){return p.id}), rows:Array.prototype.map.call(document.querySelectorAll("tbody tr[data-pid]"),function(x){return x.dataset.pid}).slice(0,5), dragLeft:document.querySelectorAll('tr[draggable="true"]').length}
  })()`);
  check('a product can be dragged by its handle (⠿) and dropped in its place', dragRes.marked && dragRes.order[3] === d1[0] && dragRes.order[0] === d1[1] && dragRes.order.length === d1.length, J(dragRes));
  check('…the rows follow, and nothing stays draggable (fields in the row type as before)', dragRes.rows[3] === d1[0] && dragRes.dragLeft === 0, J(dragRes));
  const m1 = await ev('S.cat.items.map(function(i){return i.id})');
  await cdp.evaluate('S.tab="recipes"; S.recSec="items"; render(); (function(){ var ids=S.cat.items.map(function(i){return i.id}), i=ids.indexOf("core"); dndMove("m","core",ids[i+1],true); render() })(); 1'); await sleep(150);
  const m2 = await ev('S.cat.items.map(function(i){return i.id})');
  check('moving a material down one place', m2.indexOf('core') === m1.indexOf('core') + 1 && m2[m1.indexOf('core')] === m1[m1.indexOf('core') + 1], J([m1, m2]));

  console.log('\n--- groups: products and materials in the shop\'s own groups, as cards; no arrows anywhere ---');
  check('no ↑↓ arrows are left — dragging is the one way to arrange', await ev('(function(){ S.tab="items"; S.itemSec="list"; render(); var a=document.querySelectorAll(".itMove").length; S.tab="recipes"; S.recSec="items"; render(); a+=document.querySelectorAll(".catItemMove").length; S.recSec="recipes"; S.defSel={r:"*"}; render(); a+=document.querySelectorAll(".catDefMove").length; return a===0 })()'));
  await cdp.evaluate('S.tab="items"; S.itemSec="list"; S.itemQ=""; S.cfg.groups=[]; render(); 1'); await sleep(150);
  check('with no groups the list is as before: every product shows', await ev('document.querySelectorAll("#itTableWrap tbody tr[data-pid]:not([hidden])").length===S.products.length && !document.querySelector(".grpSec")'), J(await ev('({rows:document.querySelectorAll("#itTableWrap tbody tr[data-pid]:not([hidden])").length, n:S.products.length, g:document.querySelectorAll(".grpSec").length, wrap:!!document.getElementById("itTableWrap")})')));
  await cdp.evaluate('document.getElementById("grpNew_p").value="البولز"; document.querySelector(\'.grpAdd[data-gk="p"]\').click(); 1'); await sleep(200);
  const G1 = await ev('({groups:S.cfg.groups, open:grpOpen("p"), cards:Array.prototype.map.call(document.querySelectorAll(\'.grpSec[data-gk="p"]\'),function(b){return b.dataset.g}), shown:document.querySelectorAll("#itTableWrap tbody tr[data-pid]:not([hidden])").length})');
  check('«+ مجموعة جديدة» makes a group with the shop\'s name, opens it (empty), and «بلا مجموعة» holds the rest', G1.groups.length === 1 && G1.groups[0].name === 'البولز' && G1.open === G1.groups[0].id && G1.cards.join() === G1.groups[0].id + ',_' && G1.shown === 0, J(G1));
  const gid = G1.groups[0].id;
  const pids = await ev('S.products.slice(0,3).map(function(p){return p.id})');
  // put two in it from the «المجموعة» column, and one by dropping it on the card
  await cdp.evaluate(`(function(){ grpSetOpen("p","_"); render(); ["${pids[0]}","${pids[1]}"].forEach(function(id){ var s=document.querySelector('.grpPick[data-gk="p"][data-id="'+id+'"]'); s.value="${gid}"; s.dispatchEvent(new Event("change",{bubbles:true})) }); return 1 })()`); await sleep(200);
  const dropG = await ev(`(function(){ var src=document.querySelector('tr[data-pid="${pids[2]}"]'), card=document.querySelector('.grpSec[data-gk="p"][data-g="${gid}"]');
    src.querySelector(".dndH").dispatchEvent(new MouseEvent("mousedown",{bubbles:true})); var dt=new DataTransfer(), r=card.getBoundingClientRect(), o={bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+5,clientY:r.top+5};
    src.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:dt})); card.dispatchEvent(new DragEvent("dragover",o)); var lit=card.classList.contains("dropInto");
    card.dispatchEvent(new DragEvent("drop",o)); src.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:dt}));
    return {lit:lit, in:S.products.filter(function(p){return p.group==="${gid}"}).map(function(p){return p.id})} })()`);
  check('a product goes into a group from its «المجموعة» column, or dropped on the group\'s card', dropG.lit && dropG.in.length === 3 && pids.every(function(id){ return dropG.in.indexOf(id) >= 0 }), J(dropG));
  await cdp.evaluate(`grpSetOpen("p",""); render(); document.querySelector('.grpSec[data-gk="p"][data-g="${gid}"]').click(); 1`); await sleep(150);
  const G2 = await ev('({shown:Array.prototype.map.call(document.querySelectorAll("#itTableWrap tbody tr[data-pid]:not([hidden])"),function(r){return r.dataset.pid}), wrap:!document.getElementById("itTableWrap").hidden})');
  check('pressing the group\'s card opens just its products, in the list\'s order', G2.wrap && G2.shown.join() === pids.join(), J(G2));
  await cdp.evaluate(`document.querySelector('.grpSec[data-gk="p"][data-g="${gid}"]').click(); 1`); await sleep(150);
  check('…a second press closes it', await ev('document.getElementById("itTableWrap").hidden && grpOpen("p")===""'));
  check('the search still finds a product in any group', await ev(`(function(){ var s=document.getElementById("itSearch"); s.value=normName(S.products[5].name); s.dispatchEvent(new Event("input",{bubbles:true})); var ok=!document.getElementById("itTableWrap").hidden && !document.querySelector('tr[data-pid="'+S.products[5].id+'"]').hidden; s.value=""; s.dispatchEvent(new Event("input",{bubbles:true})); S.itemQ=""; return ok })()`));
  const kept = await ev(`(function(){ var r=sanitizeRecord({products:S.products,cfg:S.cfg}); return {g:r.cfg.groups, n:r.products.filter(function(p){return p.group==="${gid}"}).length} })()`);
  check('groups and who is in them survive saving and loading', kept.g.length === 1 && kept.g[0].name === 'البولز' && kept.n === 3, J(kept));
  // recipes and offers have their OWN groups — nothing borrowed from the products
  await cdp.evaluate('S.tab="recipes"; S.recSec="recipes"; S.defSel={}; grpSetOpen("r",""); if(S.cat){ S.cat.rgroups=[]; S.cat.bgroups=[] } render(); 1'); await sleep(150);
  check('the product groups never show among the recipes (with no recipe groups: the plain bar)', await ev('!document.querySelector(\'.grpSec[data-gk="r"]\') && document.querySelectorAll(\'#catRecipes .defPick[data-dnd="r"]\').length>0 && !!document.getElementById("grpNew_r")'));
  await cdp.evaluate('document.getElementById("grpNew_r").value="البولز"; document.querySelector(\'.grpAdd[data-gk="r"]\').click(); 1'); await sleep(200);
  const RG = await ev(`(function(){ var g=S.cat.rgroups[0]; var k=defKeys(S.cat.recipes)[0]; grpPut("r",k,g.id); grpSetOpen("r",""); render();
    var cards=Array.prototype.map.call(document.querySelectorAll('.grpSec[data-gk="r"]'),function(b){return b.dataset.g});
    document.querySelector('.grpSec[data-gk="r"][data-g="'+g.id+'"]').click(); var chips=Array.prototype.map.call(document.querySelectorAll('#catRecipes .defPick[data-dnd="r"]'),function(b){return b.dataset.key});
    var kept=sanitizeCatalog(JSON.parse(JSON.stringify(S.cat)),S.catBrand);
    return {name:g.name, cards:cards, chips:chips, k:k, kept:kept.rgroups.length===1&&kept.recipes[k].group===g.id, prodGroupsHere:cards.some(function(x){return (S.cfg.groups||[]).some(function(pg){return pg.id===x})})} })()`);
  check('recipes get their own groups: made here, a recipe put in one, the card opens just its recipes, kept with the brand', RG.name === 'البولز' && RG.cards.indexOf('_') >= 0 && RG.chips.join() === RG.k && RG.kept && !RG.prodGroupsHere, J(RG));
  await cdp.evaluate('if(S.cat){ S.cat.rgroups=[]; Object.keys(S.cat.recipes).forEach(function(k){ delete S.cat.recipes[k].group }) } grpSetOpen("r",""); render(); 1');
  // materials
  await cdp.evaluate('S.recSec="items"; render(); document.getElementById("grpNew_m").value="الصوصات"; document.querySelector(\'.grpAdd[data-gk="m"]\').click(); 1'); await sleep(200);
  const GM = await ev(`(function(){ var g=S.cat.groups[0]; grpSetOpen("m","_"); render(); var s=document.querySelector('.grpPick[data-gk="m"]'); var id=s.dataset.id; s.value=g.id; s.dispatchEvent(new Event("change",{bubbles:true}));
    grpSetOpen("m",g.id); render(); var rows=Array.prototype.map.call(document.querySelectorAll('#catItems tr[data-dnd="m"]'),function(r){return r.dataset.id});
    var c=sanitizeCatalog(JSON.parse(JSON.stringify(S.cat)),S.catBrand); return {name:g.name, rows:rows, id:id, kept:c.groups.length===1&&c.items.filter(function(i){return i.group===g.id}).length===1} })()`);
  check('materials have their own groups the same way (kept with the brand)', GM.name === 'الصوصات' && GM.rows.join() === GM.id && GM.kept, J(GM));
  await cdp.evaluate(`(function(){ var g=S.cat.groups[0].id; grpSetOpen("m",g); render(); document.querySelector('.grpDel[data-gk="m"]').click(); return 1 })()`); await sleep(200);
  check('«احذف المجموعة» keeps everything that was in it (moved to «بلا مجموعة»)', await ev('S.cat.groups.length===0 && S.cat.items.every(function(i){return !i.group}) && S.cat.items.length>0'));
  await cdp.evaluate('S.cfg.groups=[]; saveCfg(); S.products.forEach(function(p){ if(p.group){ delete p.group; saveProduct(p) } }); grpSetOpen("p",""); grpSetOpen("r",""); grpSetOpen("m",""); S.tab="items"; render(); 1');

  console.log('\n--- units, totals, the material order, the last 14 days ---');
  check('«جرام» and «كيلو» are grams and kilos', await ev('opToBase(1,"كيلو")===1000 && opToBase(500,"جرام")===500 && opBase("جرام")==="جم" && opCompatible("جرام").indexOf("كجم")>=0'));
  check('1000 جرام shows as 1 كجم', /^1 كجم/.test(await ev('fmtOp(opToBase(1000,"جرام"),opBase("جرام"),true)')), await ev('fmtOp(opToBase(1000,"جرام"),opBase("جرام"),true)'));
  const tot = await ev(`(function(){ var d=document.createElement("div"); d.style.direction="ltr"; d.innerHTML=fmtTotals([{total:8,unit:"عرض"},{total:12,unit:"بوكس"},{total:1,unit:"صحن"}]); document.body.appendChild(d);
    var sp=d.querySelectorAll("span[dir=rtl] > span[dir=rtl]"), r=[]; sp.forEach(function(x){ r.push(x.getBoundingClientRect().left) }); var t=d.innerText; d.remove(); return {t:t, lefts:r} })()`);
  check('totals read «8 عرض · 12 بوكس · 1 صحن», number first, right to left', tot.t.replace(/\s+/g, ' ').trim() === '8 عرض · 12 بوكس · 1 صحن' && tot.lefts[0] > tot.lefts[1] && tot.lefts[1] > tot.lefts[2], J(tot));
  await cdp.evaluate('S.tab="entry"; render(); 1'); await sleep(250);
  const days = await ev('(function(){ var t=document.getElementById("entDaysTable"); return t?{rows:t.querySelectorAll("tbody tr").length, heads:Array.prototype.map.call(t.querySelectorAll("th"),function(x){return x.textContent})}:null })()');
  check('the last 14 days are a table with headers', days && days.rows === 14 && days.heads[0] === 'اليوم' && days.heads.indexOf('المباع') >= 0, J(days));
  const second = await ev('document.querySelectorAll("#entDaysTable tbody tr")[3].dataset.d');
  await cdp.evaluate('document.querySelectorAll("#entDaysTable tbody tr")[3].click(); 1'); await sleep(200);
  check('a row opens its day', (await ev('S.entryDate')) === second);

  console.log('\n--- «الشروحات»: every explanation shown or hidden, one by one ---');
  await cdp.evaluate('try{localStorage.removeItem("talabia.notesHidden.v1")}catch(e){} NOTES_HIDE=null; S.tab="setup"; render(); 1'); await sleep(400);
  const reg = await ev('(function(){ var r=notesReg(), by={}; Object.keys(r).forEach(function(k){by[r[k].tab]=(by[r[k].tab]||0)+1}); return by })()');
  check('the list holds the explanations of every screen (not only those opened)', ['order', 'entry', 'items', 'recipes', 'stats', 'setup'].every(t => reg[t] > 0), J(reg));
  check('the settings show the section with a switch per paragraph', await ev('!!document.getElementById("notesAll") && document.querySelectorAll("#notesList .noteTgl").length >= 10'));
  // hide one paragraph of the order screen, then see it gone there
  const key = await ev('Object.keys(notesReg()).filter(function(k){return /^order\|/.test(k)})[0]');
  await cdp.evaluate(`(function(){ var c=document.querySelector('.noteTgl[data-k="'+CSS.escape(${J(key)})+'"]'); c.checked=false; c.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`);
  await cdp.evaluate('orderFoldsSet({mto:true,mat:true,needs:true,market:true,how:true}); S.tab="order"; render(); 1'); await sleep(300);
  const st = await ev(`(function(){ var el=document.querySelector('[data-nk="'+CSS.escape(${J(key)})+'"]'); var others=Array.prototype.filter.call(document.querySelectorAll("#view [data-nk]"),function(x){return x!==el});
    return {found:!!el, hidden:!!el&&getComputedStyle(el).display==="none", othersShown:others.length>0&&others.every(function(x){return getComputedStyle(x).display!=="none"})} })()`);
  check('a paragraph switched off disappears from its screen, the others stay', st.found && st.hidden && st.othersShown, J(st));
  await cdp.evaluate('S.tab="setup"; render(); var c=document.getElementById("notesAll"); c.checked=false; c.dispatchEvent(new Event("change",{bubbles:true})); S.tab="entry"; render(); 1'); await sleep(300);
  check('the main switch hides every explanation', await ev('Array.prototype.every.call(document.querySelectorAll("#view [data-nk]"),function(x){return getComputedStyle(x).display==="none"}) && document.querySelectorAll("#view [data-nk]").length>0'));
  await cdp.evaluate('S.tab="setup"; render(); var c=document.getElementById("notesAll"); c.checked=true; c.dispatchEvent(new Event("change",{bubbles:true})); document.getElementById("notesShowAll").click(); S.tab="order"; render(); 1'); await sleep(300);
  check('«أظهرها كلّها» brings them all back', await ev('Array.prototype.every.call(document.querySelectorAll("#view [data-nk]"),function(x){return getComputedStyle(x).display!=="none"})'));

  console.log('\n--- «المساعد الذكي ✨»: a floating window, moved, resized, pinned, remembered ---');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate('try{localStorage.removeItem("talabia.assistant.v1")}catch(e){} AST=null; S.asst=[]; S.tab="order"; render(); 1'); await sleep(300);
  const A_box = (sel) => ev('(function(){ var n=document.querySelector(' + J(sel) + '); if(!n||n.hidden) return null; var b=n.getBoundingClientRect(); return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)} })()');
  const A_mouse = async (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  const Z = await ev('asstZoom()');
  const A_dragBy = async (sel, dxc, dyc) => { const b = await A_box(sel); const x = b.x + b.w / 2, y = b.y + b.h / 2, dx = dxc * Z, dy = dyc * Z;
    await A_mouse('mouseMoved', x, y); await A_mouse('mousePressed', x, y); for (let k = 1; k <= 6; k++) { await A_mouse('mouseMoved', x + dx * k / 6, y + dy * k / 6); await sleep(20) } await A_mouse('mouseReleased', x + dx, y + dy); await sleep(150) };
  // the button sits beside the branch, in the header; the old screen tab is gone
  const A_hb = await ev('(function(){ var b=document.getElementById("asstBtn"), p=document.getElementById("branchPick"); return {txt:b&&b.textContent.trim(), inHeader:!!(b&&b.closest("header.top")), next:!!(b&&p&&p.nextElementSibling===b), tab:!!document.querySelector(\'#tabs button[data-tab="assistant"]\')} })()');
  check('«المساعد الذكي ✨» sits in the header right beside the branch; no separate screen tab', A_hb.txt === 'المساعد الذكي ✨' && A_hb.inHeader && A_hb.next && !A_hb.tab, J(A_hb));
  await cdp.evaluate('document.getElementById("asstBtn").click(); 1'); await sleep(250);
  const A_o1 = await ev('(function(){ var w=document.getElementById("asstWin"); return {shown:!w.hidden, tab:S.tab, view:!!document.getElementById("view").innerText.length, dir:getComputedStyle(w).direction, title:w.querySelector(".ttl").textContent, ctx:document.getElementById("asstCtx").textContent} })()');
  check('it opens as a window over the current screen (the screen stays), right to left', A_o1.shown && A_o1.tab === 'order' && A_o1.view && A_o1.dir === 'rtl' && A_o1.title === 'المساعد الذكي ✨', J(A_o1));
  check('it knows where the user is: the screen and the branch', /السياق: الطلبية/.test(A_o1.ctx), A_o1.ctx);
  await cdp.evaluate('S.tab="stats"; render(); 1'); await sleep(250);
  check('…and follows the user to another screen', /التحليل/.test(await ev('document.getElementById("asstCtx").textContent')));
  // the conversation still works: Enter sends, the question carries its context, nothing leaves the app
  await cdp.evaluate('window.__fetchCount=0; var __f=window.fetch; window.fetch=function(){ window.__fetchCount++; return __f.apply(this,arguments) }; document.getElementById("asstInput").focus(); 1');
  await cdp.send('Input.insertText', { text: 'إيه المنتجات اللي محتاجة طلب؟' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(250);
  const A_c1 = await ev('(function(){ var m=document.querySelectorAll("#asstLog .asst-msg"); return {n:m.length, me:m[1]&&m[1].innerText, bot:m[2]&&m[2].innerText, A_box:document.getElementById("asstInput").value, fetches:window.__fetchCount} })()');
  check('the conversation works: the question (with its screen) answered from the record (the next order, product by product); the box empties', A_c1.n === 3 && /إيه المنتجات اللي محتاجة طلب؟/.test(A_c1.me) && /التحليل/.test(A_c1.me) && /طلبية/.test(A_c1.bot) && A_c1.A_box === '', J(A_c1));
  check('…and no request leaves the app', A_c1.fetches === 0, J(A_c1));
  const A_cx = await ev('(function(){ var c=asstContext(); return {screen:c.where.screen, days:c.schedule.orderDays.length, data:!!c.data, products:c.data&&c.data.products.length, stockKnown:c.stockKnown, rules:/لا تخترعه/.test(c.rules)} })()');
  check('its context holds the app data (branch, next order, products, schedule) and the rule never to invent numbers', A_cx.screen === 'stats' && A_cx.days > 0 && A_cx.data && A_cx.products > 3 && A_cx.rules, J(A_cx));
  // move by the header (real A_mouse), and it never leaves the app's window
  const St = () => ev('asstState()');
  await cdp.evaluate('asstSet({x:300,y:200,w:420,h:520}); 1'); await sleep(100);
  await A_dragBy('#asstHead .ttl', 160, -120);
  const A_b1 = await St();
  check('dragging the header (by its title) moves the window', Math.abs(A_b1.x - 460) <= 2 && Math.abs(A_b1.y - 80) <= 2, J(A_b1));
  await A_dragBy('#asstHead .ttl', 3000, 3000);
  const A_b2 = await A_box('#asstWin');
  check('it cannot be dragged out of the app: it stops at the edge', A_b2.x + A_b2.w <= 1281 && A_b2.y + A_b2.h <= 801 && A_b2.x >= 0 && A_b2.y >= 0, J(A_b2));
  await A_dragBy('#asstHead .ttl', -5000, -5000);
  const A_b3 = await A_box('#asstWin');
  check('…nor out the other side', A_b3.x >= 0 && A_b3.y >= 0 && A_b3.x <= 1 && A_b3.y <= 1, J(A_b3));
  // resize by a corner; never below the minimum
  await cdp.evaluate('asstSet({x:300,y:120,w:420,h:520}); 1'); await sleep(100);
  await A_dragBy('#asstWin .rz[data-d="se"]', 120, 80);
  const A_r1 = await St();
  check('a corner resizes it (width and height)', Math.abs(A_r1.w - 540) <= 3 && Math.abs(A_r1.h - 600) <= 3, J(A_r1));
  await A_dragBy('#asstWin .rz[data-d="se"]', -900, -900);
  const A_r2 = await St();
  check('…never below its minimum size', A_r2.w === 320 && A_r2.h === 380, J(A_r2));
  await A_dragBy('#asstWin .rz[data-d="w"]', -100, 0);
  const A_r3 = await St();
  check('the left edge widens it toward the left', Math.abs(A_r3.w - 420) <= 3 && Math.abs(A_r3.x - (A_r2.x - 100)) <= 3, J([A_r2, A_r3]));
  // minimise → a bubble; the bubble brings it back where it was
  await cdp.evaluate('document.getElementById("asstMinB").click(); 1'); await sleep(150);
  const A_m1 = await ev('({win:document.getElementById("asstWin").hidden, bubble:!document.getElementById("asstBubble").hidden, txt:document.getElementById("asstBubble").textContent})');
  check('minimise: the window becomes a «✨ المساعد الذكي» bubble', A_m1.win && A_m1.bubble && /المساعد الذكي/.test(A_m1.txt), J(A_m1));
  await cdp.evaluate('document.getElementById("asstBubble").click(); 1'); await sleep(150);
  const A_m2 = await St();
  check('…the bubble restores it, same place and size, conversation kept', !(await ev('document.getElementById("asstWin").hidden')) && A_m2.x === A_r3.x && A_m2.w === A_r3.w && (await ev('document.querySelectorAll("#asstLog .asst-msg").length')) === 3, J([A_r3, A_m2]));
  // maximise / restore
  await cdp.evaluate('document.getElementById("asstMaxB").click(); 1'); await sleep(150);
  const A_x1 = await A_box('#asstWin');
  check('maximise fills the app (with a small margin)', A_x1.w >= 1280 - 50 && A_x1.h >= 800 - 30, J(A_x1));
  await cdp.evaluate('document.getElementById("asstMaxB").click(); 1'); await sleep(150);
  check('…and restore brings back its size', (await St()).w === A_r3.w && !(await St()).max);
  // pinned: it takes real room beside the app; floating again gives it back
  await cdp.evaluate('document.getElementById("asstPin").click(); 1'); await sleep(200);
  const A_p1 = await ev('(function(){ var w=document.getElementById("asstWin").getBoundingClientRect(), a=document.querySelector(".app").getBoundingClientRect(); return {pinned:document.body.classList.contains("asst-pinned"), wl:Math.round(w.left), wr:Math.round(w.right), wh:Math.round(w.height), appLeft:Math.round(a.left)} })()');
  check('pinned: a panel beside the app that takes its own room (the content does not sit under it)', A_p1.pinned && A_p1.wl === 0 && A_p1.wh >= 799 && A_p1.appLeft >= A_p1.wr - 1, J(A_p1));
  const A_pw0 = (await St()).pinW;
  await A_dragBy('#asstWin .rz[data-d="e"]', 80, 0);
  const A_p2 = (await St()).pinW;
  check('…its width can be dragged', Math.abs(A_p2 - A_pw0 - 80) <= 3, J([A_pw0, A_p2]));
  await cdp.evaluate('document.getElementById("asstPin").click(); 1'); await sleep(200);
  const A_p3 = await ev('({pinned:document.body.classList.contains("asst-pinned"), appLeft:Math.round(document.querySelector(".app").getBoundingClientRect().left), mode:asstState().mode})');
  check('…and back to floating: the app has its full width again', !A_p3.pinned && A_p3.appLeft < 5 && A_p3.mode === 'floating', J(A_p3));
  // remembered after the app is opened again
  await cdp.evaluate('asstSet({x:210,y:90,w:470,h:540}); document.getElementById("asstPin").click(); 1'); await sleep(150);
  await cdp.send('Page.reload'); await waitFor(cdp, 'window.S && window.S.ready && document.getElementById("asstWin")', 'the app to come back'); await sleep(700);
  const A_rm = await ev('(function(){ var w=document.getElementById("asstWin"); return {shown:!w.hidden, pinned:document.body.classList.contains("asst-pinned"), st:asstState()} })()');
  check('reopening the app remembers it: open, pinned, its size and place', A_rm.shown && A_rm.pinned && A_rm.st.mode === 'pinned' && A_rm.st.x === 210 && A_rm.st.w === 470, J(A_rm));
  await cdp.evaluate('document.getElementById("asstPin").click(); asstSet({max:false}); 1'); await sleep(150);
  // the two buttons open the same assistant with their question
  await cdp.evaluate('S.tab="order"; render(); document.getElementById("asstClose").click(); 1'); await sleep(150);
  await cdp.evaluate('document.getElementById("asstOrder").click(); 1'); await sleep(250);
  const A_ob = await ev('(function(){ var m=document.querySelectorAll("#asstLog .asst-msg.me"); return {shown:!document.getElementById("asstWin").hidden, last:m.length?m[m.length-1].innerText:""} })()');
  check('«اسأل عن الطلبية» opens the assistant with the order in context', A_ob.shown && /يحتاج طلب/.test(A_ob.last) && /الطلبية/.test(A_ob.last), J(A_ob));
  await cdp.evaluate('document.getElementById("asstClose").click(); 1'); await sleep(100);
  check('close hides it (and the bubble)', await ev('document.getElementById("asstWin").hidden && document.getElementById("asstBubble").hidden'));
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  console.log('\n--- the order screen: its sections are cards side by side ---');
  await cdp.evaluate('try{var P=JSON.parse(localStorage.getItem("talabia.panes.v1")||"{}"); delete P.order; localStorage.setItem("talabia.panes.v1",JSON.stringify(P))}catch(e){} PANES=null; S.tab="order"; render(); 1'); await sleep(300);
  const F0 = await ev('(function(){ var b=document.querySelectorAll(\'.paneSec[data-g="order"]\'); var r=Array.prototype.map.call(b,function(x){return x.getBoundingClientRect().top}); return {keys:Array.prototype.map.call(b,function(x){return x.dataset.s}), open:document.querySelectorAll(\'.pane[data-g="order"]:not([hidden])\').length, sideBySide:r.length>1&&Math.abs(r[0]-r[1])<2, products:document.querySelectorAll(\'.pane[data-s="products"] .row[data-pid]\').length} })()');
  check('the order screen: «طلبية الأصناف» first, then the other sections — cards side by side, none open at first', F0.keys[0] === 'products' && F0.keys.indexOf('how') > 0 && F0.keys.indexOf('market') > 0 && F0.open === 0 && F0.sideBySide && F0.products > 3, J(F0));
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="products"]\').click(); 1'); await sleep(200);
  check('«طلبية الأصناف» opens with one press (the product cards)', await ev('!document.querySelector(\'.pane[data-s="products"]\').hidden && document.querySelectorAll(\'.pane[data-s="products"] .row[data-pid]\').length>3'));
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="products"]\').click(); 1'); await sleep(200);
  check('…and closes with the next', await ev('document.querySelector(\'.pane[data-s="products"]\').hidden'));
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="market"]\').click(); 1'); await sleep(200);
  check('the market calendar opens on its own (14 days)', await ev('!document.querySelector(\'.pane[data-s="market"]\').hidden && document.querySelectorAll("#mktCalTable tbody tr").length===14'));
  // «يُحضَّر بالطلب» shows its list even when «الشروحات» hides explanations
  await cdp.evaluate('S.products.slice(0,2).forEach(function(p){p.mto=true}); NOTES_HIDE={all:true,keys:{}}; render(); 1'); await sleep(200);
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="mto"]\').click(); 1'); await sleep(200);
  check('«يُحضَّر بالطلب» opens to its cards, like the products and the materials (expected amount, not an order field) — even with every explanation hidden', await ev('(function(){ var p=document.querySelector(\'.pane[data-s="mto"]\'); var t=p&&p.querySelector("#mtoNote"); return !!p&&!p.hidden&&!!t&&getComputedStyle(t).display!=="none"&&t.querySelectorAll(".row.mto").length===2 && t.querySelectorAll(".row.mto .mtoQty").length===2 && !t.querySelector(".qtyIn") })()'));
  await cdp.evaluate('S.products.slice(0,2).forEach(function(p){p.mto=false}); NOTES_HIDE={all:false,keys:{}}; render(); 1');

  console.log('\n--- the app\'s own confirm dialog (instead of the system box) ---');
  await cdp.evaluate('try{localStorage.removeItem("talabia.nativeConfirm")}catch(e){} S.tab="items"; S.itemSec="list"; render(); 1'); await sleep(300);
  const nDlg0 = dialogs.length, nP0 = await ev('S.products.length'), pid = await ev('S.products[S.products.length-1].id'), pname = await ev('S.products[S.products.length-1].name');
  await cdp.evaluate(`document.querySelector('.delItem[data-id="${pid}"]').click(); 1`); await sleep(300);
  const D1 = await ev('(function(){ var d=document.getElementById("cfmDlg"); if(!d) return null; return {title:d.querySelector("h3").textContent, head:d.querySelector("#cfmHead").textContent, yes:document.getElementById("cfmYes").textContent, danger:document.getElementById("cfmYes").classList.contains("danger"), focus:document.activeElement&&document.activeElement.id, brand:!!d.querySelector(".cfm-brand .applogo svg")} })()');
  check('deleting asks in the app\'s own dialog (logo, title, the item named, red «نعم، احذف»), not the system box', !!D1 && D1.title === 'تأكيد الحذف' && D1.head.indexOf(pname) >= 0 && D1.yes === 'نعم، احذف' && D1.danger && !D1.brand && dialogs.length === nDlg0, J(D1));
  check('…the safe answer «إلغاء» has the focus', D1 && D1.focus === 'cfmNo', D1 && D1.focus);
  await cdp.evaluate('document.getElementById("cfmNo").click(); 1'); await sleep(300);
  check('«إلغاء» keeps the product', (await ev('S.products.length')) === nP0 && !(await ev('!!document.getElementById("cfmDlg")')));
  await cdp.evaluate(`document.querySelector('.delItem[data-id="${pid}"]').click(); 1`); await sleep(250);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(250);
  check('Escape cancels too', (await ev('S.products.length')) === nP0 && !(await ev('!!document.getElementById("cfmDlg")')));
  await cdp.evaluate(`document.querySelector('.delItem[data-id="${pid}"]').click(); 1`); await sleep(250);
  await cdp.evaluate('document.getElementById("cfmYes").click(); 1'); await sleep(400);
  check('«نعم، احذف» deletes it (to «المحذوفات»)', (await ev('S.products.length')) === nP0 - 1 && (await ev(`S.trash.some(function(x){return x.prod.id===${J(pid)}})`)));
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');

  console.log('\n--- sections open with one press and close with the next; «حول التطبيق» rests at the foot ---');
  await cdp.evaluate('try{localStorage.removeItem("talabia.panes.v1")}catch(e){} PANES=null; S.tab="setup"; render(); 1'); await sleep(250);
  const T0 = await ev('(function(){ var idle=document.querySelector(\'.pane-idle[data-g="setup"]\'); return {cards:Array.prototype.map.call(document.querySelectorAll(\'.paneSec[data-g="setup"]\'),function(b){return b.dataset.s}), open:document.querySelectorAll(\'.pane[data-g="setup"]:not([hidden])\').length, about:!!idle&&!idle.hidden&&/Mohamed Hasan/.test(idle.innerText)} })()');
  check('settings open with no section, «حول التطبيق» at the foot — and no «about» card', T0.open === 0 && T0.about && T0.cards.indexOf('about') < 0, J(T0));
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="general"]\').click(); 1'); await sleep(150);
  const T1 = await ev('({open:!document.querySelector(\'.pane[data-s="general"]\').hidden, about:!document.querySelector(\'.pane-idle[data-g="setup"]\').hidden})');
  check('one press opens the section and the «about» block steps aside', T1.open && !T1.about, J(T1));
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="general"]\').click(); 1'); await sleep(150);
  const T2 = await ev('({open:document.querySelectorAll(\'.pane[data-g="setup"]:not([hidden])\').length, about:!document.querySelector(\'.pane-idle[data-g="setup"]\').hidden, on:document.querySelectorAll(\'.paneSec.on[data-g="setup"]\').length})');
  check('a second press closes it, and «حول التطبيق» comes back', T2.open === 0 && T2.about && T2.on === 0, J(T2));
  await cdp.evaluate('S.tab="items"; S.itemSec="list"; render(); document.getElementById("itemSec_list").click(); 1'); await sleep(200);
  check('the products screen closes its open section on a second press too', await ev('S.itemSec==="none" && !document.querySelector("#view table") && !!document.querySelector("#view .cp-hint")'));
  await cdp.evaluate('document.getElementById("itemSec_list").click(); 1'); await sleep(200);
  check('…and opens it again', await ev('S.itemSec==="list" && !!document.querySelector("#view table")'));

  console.log('\n--- «إقفال اليوم» in sections ---');
  await cdp.evaluate('try{var P=JSON.parse(localStorage.getItem("talabia.panes.v1")||"{}"); delete P.entry; localStorage.setItem("talabia.panes.v1",JSON.stringify(P))}catch(e){} PANES=null; S.tab="entry"; render(); 1'); await sleep(250);
  const E0 = await ev('(function(){ var open=document.querySelector(\'.pane[data-g="entry"]:not([hidden])\'); return {cards:Array.prototype.map.call(document.querySelectorAll(\'.paneSec[data-g="entry"]\'),function(b){return b.dataset.s}), open:open&&open.dataset.s, inputs:document.querySelectorAll(\'.pane[data-s="record"] .entIn\').length, todayCards:!!document.querySelector("#view .cards .card.good")} })()');
  check('the close keeps the date and today\'s figures on top; «تسجيل اليوم» starts open; the import and the 14 days are cards', E0.open === 'record' && E0.inputs > 3 && E0.todayCards && E0.cards.join() === 'record,import,days', J(E0));
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="days"]\').click(); 1'); await sleep(150);
  check('the last 14 days open with one press (and the table steps aside)', await ev('!document.querySelector(\'.pane[data-s="days"]\').hidden && document.querySelector(\'.pane[data-s="record"]\').hidden && document.querySelectorAll("#entDaysTable tbody tr").length===14'));
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="days"]\').click(); 1'); await sleep(150);
  check('…and close with the next', await ev('document.querySelectorAll(\'.pane[data-g="entry"]:not([hidden])\').length===0 && !document.querySelector(\'.pane-idle[data-g="entry"]\').hidden'));

  console.log('\n--- «جدول الطلب» in sections ---');
  await cdp.evaluate('S.tab="schedule"; render(); 1'); await sleep(200);
  const SC = await ev('Array.prototype.map.call(document.querySelectorAll(\'.paneSec[data-g="schedule"]\'),function(b){return b.dataset.s}).join()');
  check('the schedule is four cards: days, what each day, default time, leaning', SC === 'days,items,timing,tend', SC);
  await cdp.evaluate('document.querySelector(\'.paneSec[data-s="items"]\').click(); 1'); await sleep(150);
  check('…«ماذا يُطلب في كل يوم» opens with one press', await ev('!document.querySelector(\'.pane[data-s="items"]\').hidden && !!document.getElementById("itemDaysTable")'));

  console.log('\n--- the analysis: the older reports as cards of their own ---');
  await cdp.evaluate('S.tab="stats"; render(); 1'); await sleep(400);
  const LG = await ev('Array.prototype.map.call(document.querySelectorAll(\'.paneSec[data-g="stats"]\'),function(b){return b.dataset.s})');
  check('one card per subject: the weekday index folded into «تحليل الأيام», every product\'s waste into «الهدر والنفاد», the best sellers into «تحليل كلّ صنف»', LG.indexOf('waste') >= 0 && ['dow', 'top', 'allp', 'more'].every(k => LG.indexOf(k) < 0), J(LG));
  check('…their content kept, in its new home', await ev('/مؤشّر أيام الأسبوع/.test(document.querySelector(\'.pane[data-s="days"]\').innerHTML) && /كلّ الأصناف/.test(document.querySelector(\'.pane[data-s="waste"]\').innerHTML) && /الأكثر مبيعاً/.test(document.querySelector(\'.pane[data-s="products"]\').innerHTML)'));
  check('«التنبيهات» says what deserves a look (or that all is well), and the salary pattern is drawn', await ev('!!document.querySelector(\'.pane[data-s="alerts"] #alertSection\') && (document.querySelectorAll("#alertList .alertRow").length>0 || /لا شيء يقلق/.test(document.querySelector(\'.pane[data-s="alerts"]\').textContent)) && !!document.querySelector(\'.pane[data-s="branch"] svg rect\')'));

  console.log('\n--- an analysis card with its own period ---');
  await cdp.evaluate('try{localStorage.removeItem("talabia.cardRange.v1")}catch(e){} CARD_RNG=null; S.statFrom=null; S.statTo=null; S.statPeriod=0; S.tab="stats"; render(); 1'); await sleep(400);
  const CR0 = await ev('(function(){ var p=document.querySelector(\'.pane[data-s="products"]\'), d=document.querySelector(\'.pane[data-s="days"]\'); return {bar:!!p.querySelector(".card-range .crFrom"), barDays:!!d.querySelector(".card-range"), own:!!p.querySelector(".card-range.own"), rows:p.querySelectorAll(".statRow").length, total:document.querySelector(".cards .card .val").textContent} })()');
  check('each analysis card has its own «من / إلى», following the page period at first', CR0.bar && CR0.barDays && !CR0.own && CR0.rows > 3, J(CR0));
  // the products card alone: one week, two weeks back
  const wk = await ev('(function(){ var k=Object.keys(S.days).sort(); return {from:k[k.length-14], to:k[k.length-8]} })()');
  await cdp.evaluate(`(function(){ var b=document.querySelector('.pane[data-s="products"] .card-range'); b.querySelector(".crFrom").value=${J(wk.from)}; var t=b.querySelector(".crTo"); t.value=${J(wk.to)}; t.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`); await sleep(500);
  const CR1 = await ev(`(function(){ var p=document.querySelector('.pane[data-s="products"]'); var tot=0; Array.prototype.forEach.call(p.querySelectorAll(".statRow"),function(r){ tot+=parseFloat((r.children[2].textContent||"0").replace(/,/g,""))||0 });
    var exp=0; S.products.forEach(function(x){ seriesFor(x.id,{from:${J(wk.from)},to:${J(wk.to)}}).forEach(function(q){ exp+=q.qty }) });
    return {own:!!p.querySelector(".card-range.own"), open:!p.hidden, tot:Math.round(tot), exp:Math.round(exp), page:document.querySelector(".cards .card .val").textContent, daysOwn:!!document.querySelector('.pane[data-s="days"] .card-range.own')} })()`);
  check('dates on the products card recalculate that card alone, for those dates', CR1.own && CR1.open && Math.abs(CR1.tot - CR1.exp) <= Math.max(2, CR1.exp * 0.01) && CR1.exp > 0, J(CR1));
  check('…the page summary and the other cards keep the page period', CR1.page === CR0.total && !CR1.daysOwn, J(CR1));
  await cdp.evaluate('document.querySelector(\'.pane[data-s="products"] .crClear\').click(); 1'); await sleep(400);
  check('«اتبع فترة الصفحة» hands it back', await ev('!document.querySelector(\'.pane[data-s="products"] .card-range.own\') && !cardRanges().products'));

  console.log('\n--- a card\'s dates: the year can be typed, the row is aligned ---');
  await cdp.evaluate('try{localStorage.removeItem("talabia.cardRange.v1")}catch(e){} CARD_RNG=null; PANES={stats:"products"}; S.tab="stats"; render(); 1'); await sleep(400);
  const AL = await ev('(function(){ var b=document.querySelector(\'.pane[data-s="products"] .card-range\'), ins=b.querySelectorAll("input"), lb=b.querySelectorAll(".crf span"); var r=function(x){var q=x.getBoundingClientRect(); return {t:q.top,b:q.bottom,l:q.left,c:(q.top+q.bottom)/2}}; return {mid:[r(ins[0]).c,r(ins[1]).c,r(lb[0]).c,r(lb[1]).c,r(b.querySelector(".lbl")).c], labelBeside:Math.abs(r(lb[0]).c-r(ins[0]).c)<3, minmax:!!(ins[0].min||ins[0].max)} })()');
  check('«من» and «إلى» sit beside their boxes, all on one line', AL.labelBeside && Math.max.apply(null, AL.mid) - Math.min.apply(null, AL.mid) < 4 && !AL.minmax, J(AL));
  await cdp.evaluate('(function(){ var i=document.querySelector(\'.pane[data-s="products"] .crFrom\'); i.focus(); return 1 })()');
  for (const k of '01062025') { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k, code: 'Digit' + k, windowsVirtualKeyCode: 48 + (+k) }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'Digit' + k, windowsVirtualKeyCode: 48 + (+k) }); await sleep(60); }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(500);
  const YR = await ev('(cardRanges().products||{}).from||null');
  check('a whole date, its year included, can be typed into a card\'s «من» (2025 kept)', !!YR && YR.slice(0, 4) === '2025', YR);
  await cdp.evaluate('try{localStorage.removeItem("talabia.cardRange.v1")}catch(e){} CARD_RNG=null; render(); 1');

  console.log('\n--- every date field: label beside the box, year typeable ---');
  const besides = [];
  for (const [tab, id] of [['order', 'planDate'], ['entry', 'entryDate'], ['stats', 'statFrom'], ['stats', 'statTo']]) {
    await cdp.evaluate(`S.tab=${J(tab)}; render(); 1`); await sleep(300);
    besides.push(await ev(`(function(){ var i=document.getElementById(${J(id)}); if(!i) return {id:${J(id)},missing:true}; var l=i.closest("label"), sp=l&&l.querySelector("span"); var a=i.getBoundingClientRect(), b=sp.getBoundingClientRect();
      return {id:${J(id)}, beside:Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<4, both:!!(i.min&&i.max&&i.min.slice(0,4)===i.max.slice(0,4))} })()`));
  }
  check('the order date, the close date and the analysis period: each label beside its box, no year lock', besides.every(x => !x.missing && x.beside && !x.both), J(besides));

  check('the branch picker has no «إضافة فرع أو إدارة الفروع» (branches are added on «البراند والفروع» only)', await ev('!document.querySelector("#branchPick option[value=__manage]")'));
  console.log('\n--- drag and drop: materials, recipes, offers; a second press closes a recipe ---');
  const DRAG = `function(src,dst,frac,horiz){ var h=src.querySelector(".dndH"); if(h) h.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));
    var dt=new DataTransfer(), r=dst.getBoundingClientRect(), o={bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+r.width*frac,clientY:r.top+r.height*frac};
    src.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:dt})); dst.dispatchEvent(new DragEvent("dragover",o));
    var marked=dst.classList.contains("dropAfter")?"after":dst.classList.contains("dropBefore")?"before":"";
    dst.dispatchEvent(new DragEvent("drop",o)); src.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:dt})); return marked }`;
  await cdp.evaluate('S.tab="recipes"; S.recSec="items"; render(); 1'); await sleep(150);
  const MD = await ev(`(function(){ var drag=${DRAG}; var m0=S.cat.items.map(function(i){return i.id});
    var src=document.querySelector('#catItems tr[data-dnd="m"][data-id="'+m0[0]+'"]'), dst=document.querySelector('#catItems tr[data-dnd="m"][data-id="'+m0[2]+'"]');
    if(!src||!dst) return {err:"rows"}; var mk=drag(src,dst,0.85); return {mk:mk, m0:m0, m1:S.cat.items.map(function(i){return i.id})} })()`);
  check('a material is dragged by its handle (⠿) and dropped in its place', MD.mk === 'after' && MD.m1[2] === MD.m0[0] && MD.m1[0] === MD.m0[1] && MD.m1.length === MD.m0.length, J(MD));
  await cdp.evaluate('S.recSec="recipes"; S.defSel={}; render(); 1'); await sleep(150);
  const RD = await ev(`(function(){ var drag=${DRAG}; var chips=function(){return Array.prototype.map.call(document.querySelectorAll('#catRecipes .defPick[data-dnd="r"]'),function(b){return b.dataset.key})};
    var k0=chips(); if(k0.length<3) return {err:"chips",k0:k0,n:defKeys(S.cat.recipes).length,sec:S.recSec,tab:S.tab,cr:!!document.getElementById("catRecipes"),g:grpList("p").length,html:(document.getElementById("catRecipes")||{}).innerText};
    var src=document.querySelector('#catRecipes .defPick[data-key="'+k0[0]+'"]'), dst=document.querySelector('#catRecipes .defPick[data-key="'+k0[2]+'"]');
    var rtl=getComputedStyle(dst).direction==="rtl"; var mk=drag(src,dst,rtl?0.15:0.85); return {mk:mk, k0:k0, k1:chips(), order:defKeys(S.cat.recipes)} })()`);
  check('a recipe is dragged by its name in the bar and dropped in its place (kept in the catalogue order)', RD.mk === 'after' && RD.k1[2] === RD.k0[0] && RD.order[2] === RD.k0[0], J(RD));
  const TG = await ev(`(function(){ var b=function(){return document.querySelector('#catRecipes .defPick.primary[data-dnd="r"]')}; var first=b(); if(!first) return {err:"none open"}; var k=first.dataset.key;
    first.click(); var closed=!b() && !document.querySelector('#catRecipes .catDef');
    document.querySelector('#catRecipes .defPick[data-key="'+k+'"]').click(); var again=!!b() && b().dataset.key===k && !!document.querySelector('#catRecipes .catDef');
    return {closed:closed, again:again} })()`);
  check('a press opens a recipe, a second press on it closes it', TG.closed && TG.again, J(TG));
  await cdp.evaluate('S.recSec="bundles"; S.defSel={}; render(); 1'); await sleep(150);
  check('offers drag the same way', await ev('document.querySelectorAll(\'#catBundles .defPick[data-dnd="b"][draggable="true"]\').length >= 1'));

  console.log('\n--- the deeper analysis: comparison, time, accuracy, ranking, lost sales; the tested trend ---');
  await cdp.evaluate('S.tab="stats"; render(); 1'); await sleep(300);
  const AN = await ev('(function(){ var keys=["compare","timeline","accuracy","abc","lost"], out={}; keys.forEach(function(k){ var p=document.querySelector(\'.pane[data-g="stats"][data-s="\'+k+\'"]\'); out[k]=!!p&&!/تعذّر حساب/.test(p.textContent) }); return out })()');
  check('the analysis gains «المقارنة», «المبيعات عبر الزمن», «دقّة التوقّع», «تصنيف الأصناف», «المبيعات الضائعة» — each worked out', AN.compare && AN.timeline && AN.accuracy && AN.abc && AN.lost, J(AN));
  check('…the comparison has its three cards and a row per product; the timeline is drawn', await ev('document.querySelector("#cmpSection + .cmpGrid").querySelectorAll(".cmpCard").length===3 && document.querySelectorAll("#cmpTable tbody tr").length>0 && !!document.querySelector("#tlChart path")'));
  check('…every product shows a small line of its days and its forecast accuracy', await ev('(function(){ var rows=document.querySelectorAll(\'.pane[data-g="stats"][data-s="products"] .statRow\'); return rows.length>0 && Array.prototype.every.call(rows,function(r){ return r.querySelectorAll("td").length===11 }) && document.querySelectorAll(\'.pane[data-g="stats"][data-s="products"] svg.spark\').length>0 })()'));
  check('no broken numbers (×0.9209999…) left on the analysis screen', await ev('!/\\d\\.\\d{6,}/.test(document.getElementById("view").textContent)'));
  const TR = await ev(`(function(){
    var mk=function(id,fn){ var p={id:id,name:id,unit:"حبة",shelfLife:3,packSize:1,moq:0,active:true,aliases:[]}; S.products.push(p);
      for(var i=70;i>=1;i--){ var k=ymd(addDays(today(),-i)), d=S.days[k]||(S.days[k]={date:k,items:{},closed:true}); d.items[id]={sold:fn(70-i,parseYmd(k)),waste:0,stockout:false} } return p };
    var up=mk("trUp",function(i,dd){ return Math.round((10+i*0.6)*S.dowIndex[dd.getDay()]*payFactor(dd)) });
    var flat=mk("trFlat",function(i){ return 20+((i*7)%5)-2 });
    relearn();
    var d=addDays(today(),2), tu=S.trend.trUp||{}, tf=S.trend.trFlat||{};
    var r={upActive:!!tu.active, upGain:tu.gain, upSlope:tu.slope, flatActive:!!tf.active, upLift:forecast(up,d)/Math.max(1e-9,forecastBase(up,d)), flatSame:trendFactor(flat,d)===1};
    S.products=S.products.filter(function(p){return p.id!=="trUp"&&p.id!=="trFlat"}); Object.keys(S.days).forEach(function(k){ delete S.days[k].items.trUp; delete S.days[k].items.trFlat }); relearn();
    return r })()`);
  check('a product rising steadily gets the trend (tested on its last 28 days to be closer to what sold), and its forecast leads', TR.upActive && TR.upGain > 0 && TR.upSlope > 0 && TR.upLift > 1 && TR.upLift <= 1.15, J(TR));
  check('…a steady product does not: its forecast is exactly what it was', !TR.flatActive && TR.flatSame, J(TR));

  await cdp.evaluate('try{localStorage.removeItem("talabia.cmpFree.v1")}catch(e){} try{localStorage.setItem("talabia.cmpTab.v1","free")}catch(e){} PANES={stats:"compare"}; S.tab="stats"; render(); 1'); await sleep(250);
  const CF0 = await ev('({rows:document.querySelectorAll("#cmpFreeTable tbody tr").length, chart:!!document.querySelector("#cmpFreeChart path"), inputs:document.querySelectorAll(".cmpDate").length})');
  check('«قارن أيّ فترتين»: two periods of your own, a row per product and both drawn day by day', CF0.rows > 0 && CF0.chart && CF0.inputs === 4, J(CF0));
  const CF1 = await ev(`(function(){ var el=document.querySelector(".cmpAf"); var k=Object.keys(S.days).sort(); el.value=k[k.length-20]; el.dispatchEvent(new Event("change",{bubbles:true})); var st=cmpFreeState(); document.querySelector('.cmpQuick[data-q="prev"]').click(); var st2=cmpFreeState(); return {af:st.a.from, want:k[k.length-20], lenA:Math.round((parseYmd(st2.a.to)-parseYmd(st2.a.from))/864e5), lenB:Math.round((parseYmd(st2.b.to)-parseYmd(st2.b.from))/864e5), bEndsBeforeA:st2.b.to<st2.a.from} })()`);
  check('…a date typed changes the period at once; «الأولى بما قبلها مباشرة» sets the second to the same length just before', CF1.af === CF1.want && CF1.lenA === CF1.lenB && CF1.bEndsBeforeA, J(CF1));
  await cdp.evaluate('try{localStorage.removeItem("talabia.cmpFree.v1")}catch(e){} 1');
  const MN = await ev(`(function(){
    var p=S.products[0]; p.price=10; p.cost=4; var k=Object.keys(S.days).sort().slice(-5), sold=0, waste=0;
    k.forEach(function(d){ var e=S.days[d].items[p.id]; if(e&&e.sold!=null&&e.sold!==""){ sold+=+e.sold||0; waste+=+e.waste||0 } });
    S.statFrom=k[0]; S.statTo=k[k.length-1]; PANES={stats:"money"}; S.tab="stats"; render();
    var row=Array.prototype.filter.call(document.querySelectorAll("#moneyTable tbody tr"),function(r){return r.children[0].textContent===p.name})[0];
    var r={rows:document.querySelectorAll("#moneyTable tbody tr").length, sales:row&&row.children[1].textContent, want:Math.round(sold*10), profit:row&&row.children[3].textContent, wantP:Math.round(sold*6-waste*4)};
    delete p.price; delete p.cost; S.statFrom=null; S.statTo=null; render(); return r })()`);
  check('«التحليل المالي»: with a price and a cost, the sales and the profit in money (sales × price; sold × margin − waste × cost)', MN.rows >= 1 && parseInt(String(MN.sales).replace(/[^0-9]/g,''),10) === MN.want && parseInt(String(MN.profit).replace(/[^0-9]/g,''),10) === Math.abs(MN.wantP), J(MN));
  const OT = await ev('(function(){ var O=orderText(); S.tab="order"; render(); var why=Array.prototype.some.call(document.querySelectorAll(".row .why"),function(w){return /بين \\d/.test(w.textContent)}); return {head:O.head, n:O.lines.length, text:O.text.slice(0,60), btns:!!document.getElementById("exportOrder"), why:why} })()');
  check('the order: «انسخ الطلبية» and «اطبع / PDF», its text ready for the kitchen; each card says the likely range («بين … و…»)', OT.btns && OT.n > 0 && /طلبية/.test(OT.head) && OT.why, J(OT));
  const UD = await ev(`(function(){
    var keys=Object.keys(S.days).sort(), k=keys[keys.length-4], rec=S.days[k], keep=JSON.stringify(rec.items);
    for(var pid in rec.items) if(hasSold(rec.items[pid])) rec.items[pid].sold=(+rec.items[pid].sold||0)*6+5;
    var A=statAlerts(), hit=A.some(function(x){return x.act&&x.act.indexOf('data-day="'+k+'"')>=0&&/dayIgnore/.test(x.act)});
    PANES={stats:"alerts"}; S.tab="stats"; render();
    var b=document.querySelector('.dayIgnore[data-day="'+k+'"]'); if(b) b.click();
    var ign=!!S.days[k].ignore, outOfLearn=!learnHist().some(function(r){return r.date===k}), inRecord=historyAsc().some(function(r){return r.date===k});
    var undo=document.querySelector('.dayUnignore[data-day="'+k+'"]'); if(undo) undo.click();
    var back=!S.days[k].ignore&&learnHist().some(function(r){return r.date===k});
    var san=sanitizeRecord({products:[],days:{"2026-01-05":{date:"2026-01-05",items:{},closed:false,ignore:true}}}), kept=!!(san&&san.days&&san.days["2026-01-05"]&&san.days["2026-01-05"].ignore);
    rec.items=JSON.parse(keep); relearn(); render();
    return {hit:hit, btn:!!b, ign:ign, outOfLearn:outOfLearn, inRecord:inRecord, undo:!!undo, back:back, kept:kept} })()`);
  check('an unusual day (6× its usual) is flagged in «التنبيهات» with «تجاهله في التعلّم»', UD.hit && UD.btn, J(UD));
  check('…pressed: the model stops learning from it, the day stays in the record; «أعِد» brings it back; the flag survives saving', UD.ign && UD.outOfLearn && UD.inRecord && UD.undo && UD.back && UD.kept, J(UD));
  const PL = await ev(`(function(){
    var p={id:"payX",name:"payX",unit:"حبة",shelfLife:3,packSize:1,moq:0,active:true,aliases:[]}; S.products.push(p); var made=[];
    for(var i=140;i>=1;i--){ var k=ymd(addDays(today(),-i)), d=S.days[k]; if(!d){ d=S.days[k]={date:k,items:{},closed:true}; made.push(k) } var dd=parseYmd(k), dm=dd.getDate();
      d.items.payX={sold:Math.round(300*S.dowIndex[dd.getDay()]*(dm<=5?1.9:dm>=27?1.6:dm<=15?0.9:0.6)),waste:0,stockout:false} }
    relearn(); var on=S.payLearn&&S.payLearn.active, gain=S.payLearn&&S.payLearn.gain, early=PAY_CURVE[1], mid=PAY_CURVE[19];
    PANES={stats:"accuracy"}; S.tab="stats"; render(); var card=/نمط الراتب/.test((document.querySelector('.pane[data-g="stats"][data-s="accuracy"]')||{}).textContent||"")&&/متعلَّم/.test(document.querySelector('.pane[data-g="stats"][data-s="accuracy"]').textContent);
    S.products=S.products.filter(function(x){return x.id!=="payX"}); Object.keys(S.days).forEach(function(k){ delete S.days[k].items.payX }); made.forEach(function(k){ delete S.days[k] }); relearn();
    var off=!S.payLearn.active, same=PAY_CURVE===PAY_SA||PAY_CURVE===PAY_START;
    return {on:on, gain:gain, early:early, mid:mid, card:card, off:off, same:same, reason:S.payLearn.reason} })()`);
  check('the salary curve is learned from the branch when it proves closer (replayed on the last 28 days), shown in «دقّة التوقّع»', PL.on && PL.gain >= 0.03 && PL.early > PL.mid && PL.card, J(PL));
  check('…without that proof the default curve stays exactly as it was', PL.off && PL.same, J(PL));
  const MO = await ev(`(function(){
    var real=marketFactors, nx=ymd(addDays(today(),20)), nx2=ymd(addDays(today(),22));
    marketFactors=function(){ return [{id:"natday",name:"اليوم الوطني",active:true,next:{start:nx,end:nx2},observed:{lift:1.32,conf:"good",inDays:9}}] };
    var A=statAlerts(), sug=A.some(function(x){return x.act&&/addMeasured/.test(x.act)});
    PANES={stats:"alerts"}; S.tab="stats"; render(); var b=document.querySelector(".addMeasured"); if(b) b.click();
    var ev=S.events.filter(function(e){return e.ref==="natday:"+nx})[0], again=statAlerts().some(function(x){return x.act&&/addMeasured/.test(x.act)});
    marketFactors=real; S.events=S.events.filter(function(e){return e!==ev}); saveEvents(); relearn(); render();
    return {sug:sug, btn:!!b, mult:ev&&ev.mult, from:ev&&ev.from, to:ev&&ev.to, again:again} })()`);
  check('an occasion whose effect your record measured, coming soon: one press adds it to your occasions at that effect (×1.3), then the suggestion goes', MO.sug && MO.btn && MO.mult === 1.3 && MO.from && MO.to && !MO.again, J(MO));
  const BI = await ev(`(function(){
    var mk=function(id,fn){ var p={id:id,name:id,unit:"حبة",shelfLife:3,packSize:1,moq:0,active:true,aliases:[]}; S.products.push(p);
      for(var i=80;i>=1;i--){ var k=ymd(addDays(today(),-i)), d=S.days[k]||(S.days[k]={date:k,items:{},closed:true}); d.items[id]={sold:fn(80-i,parseYmd(k)),waste:0,stockout:false} } return p };
    // sells 25% above its own weekday rhythm every Friday and Saturday-free week… simply: a steady level the weekday index under-reads
    var hi=mk("biHi",function(i,dd){ return Math.round(20*(dd.getDay()===5?2.2:1)) });
    var flat=mk("biFlat",function(i,dd){ return Math.round(20*S.dowIndex[dd.getDay()]*payFactor(dd)) });
    relearn(); var d=addDays(today(),3), bh=S.bias.biHi||{}, bf=S.bias.biFlat||{};
    var r={hiActive:!!bh.active, hiGain:bh.gain, hiMult:bh.mult, flatActive:!!bf.active, flatSame:biasFactor(flat)===1};
    PANES={stats:"accuracy"}; S.tab="stats"; render(); r.card=/تصحيح الميل/.test(document.querySelector('.pane[data-g="stats"][data-s="accuracy"]').textContent);
    S.products=S.products.filter(function(p){return p.id!=="biHi"&&p.id!=="biFlat"}); Object.keys(S.days).forEach(function(k){ delete S.days[k].items.biHi; delete S.days[k].items.biFlat }); relearn();
    return r })()`);
  check('bias correction: never on a product the forecast reads right (its forecast exactly as it was); the accuracy screen counts the corrected ones', !BI.flatActive && BI.flatSame && BI.card, J(BI));
  check('…and when a correction is active it was tested to be closer (≥3%) and stays within ±20%', !BI.hiActive || (BI.hiGain >= 0.03 && BI.hiMult >= 0.8 && BI.hiMult <= 1.2), J(BI));
  const LN = await ev(`(function(){
    var p=S.products[0], keep={}; Object.keys(S.days).forEach(function(k){ var e=S.days[k].items[p.id]; if(e) keep[k]=JSON.stringify(e) });
    var ks=Object.keys(S.days).sort().slice(-30); ks.forEach(function(k){ S.days[k].items[p.id]={sold:10,waste:4,stockout:false} });

    var sl0=serviceLevel(p,2), sug=leanAdvice().some(function(x){return /leanSet/.test(x.act)&&x.act.indexOf('data-v="-1"')>=0&&x.act.indexOf(p.id)>=0});
    PANES={stats:"alerts"}; S.tab="stats"; render(); var b=document.querySelector('.leanSet[data-pid="'+p.id+'"][data-v="-1"]'); if(b) b.click();
    var set=p.lean===-1&&p.leanAt===ymd(today()), sl1=serviceLevel(p,2), quiet=!leanAdvice().some(function(x){return x.act.indexOf('data-v="-2"')>=0&&x.act.indexOf(p.id)>=0});
    var san=sanitizeRecord({products:[{id:"x1",name:"x",lean:-1,leanAt:"2026-10-01"}],days:{}}), kept=san&&san.products[0].lean===-1&&san.products[0].leanAt==="2026-10-01";
    var r0=document.querySelector('.leanSet[data-pid="'+p.id+'"][data-v="0"]'); if(r0) r0.click();
    var back=p.lean==null&&Math.abs(serviceLevel(p,2)-sl0)<1e-12;
    ks.forEach(function(k){ if(keep[k]) S.days[k].items[p.id]=JSON.parse(keep[k]); else delete S.days[k].items[p.id] }); relearn(); render();
    return {sug:sug, btn:!!b, set:set, lower:sl1<sl0, quiet:quiet, kept:kept, reset:!!r0, back:back} })()`);
  check('a product wasting a lot and never running out: a suggestion to lean it toward less waste; one press, and only that product\'s service level drops', LN.sug && LN.btn && LN.set && LN.lower, J(LN));
  check('…measured afresh from that day (no repeat suggestion), the choice saved, and «أعِده للعادي» brings back exactly the old level', LN.quiet && LN.kept && LN.reset && LN.back, J(LN));
  const SS = await ev(`(function(){ S.statFrom=null; S.statTo=null; S.statPeriod=0; S.tab="stats"; render(); var el=document.getElementById("smartSum"); return {on:!!el, lines:el?el.querySelectorAll(".smartLine").length:0, text:el?el.textContent.slice(0,120):""} })()`);
  check('«الملخّص الذكي» on top of the analysis: the few things worth knowing, in plain words', SS.on && SS.lines >= 2, J(SS));
  const AB = await ev(`(function(){ var keep=S.products.map(function(p){return p.price}); S.products.forEach(function(p,i){ p.price=i===0?100:1 }); PANES={stats:"abc"}; S.tab="stats"; render();
    var t=document.querySelector('.pane[data-g="stats"][data-s="abc"]').textContent, first=(document.querySelector("#abcTable tbody tr td")||{}).textContent;
    S.products.forEach(function(p,i){ if(keep[i]==null) delete p.price; else p.price=keep[i] }); render(); var t2=document.querySelector('.pane[data-g="stats"][data-s="abc"]').textContent;
    return {money:/بالمال/.test(t), first:first, want:S.products[0].name, unitAgain:/أضف سعر البيع/.test(t2)} })()`);
  check('«تصنيف الأصناف» ranks by money once every product sold has a price (the priciest leads); without prices, by quantity as before', AB.money && AB.first === AB.want && AB.unitAgain, J(AB));
  const BL = await ev(`(function(){
    var mk=function(id,fn){ var p={id:id,name:id,unit:"حبة",shelfLife:3,packSize:1,moq:0,active:true,aliases:[]}; S.products.push(p);
      for(var i=90;i>=1;i--){ var k=ymd(addDays(today(),-i)), d=S.days[k]||(S.days[k]={date:k,items:{},closed:true}); d.items[id]={sold:fn(90-i,parseYmd(k)),waste:0,stockout:false} } return p };
    // a breakfast item: busy on Sundays and Mondays only — a rhythm the branch-wide weekday index does not have
    var sun=addDays(today(),1); while(sun.getDay()!==0) sun=addDays(sun,1); var wed=addDays(sun,3);
    // first alone: a product that follows the branch's own weekday rhythm (the one the forecast already uses)
    var flat=mk("blFlat",function(i,dd){ return Math.round(20*S.dowIndex[dd.getDay()]*payFactor(dd)) });
    relearn(); var bf=S.blend.blFlat||{}, r={flatActive:!!bf.active, flatSame:Math.abs(forecast(flat,sun)-forecastBase(flat,sun)*trendFactor(flat,sun)*biasFactor(flat))<1e-9};
    var own=mk("blOwn",function(i,dd){ return Math.round((dd.getDay()<=1?60:12)*payFactor(dd)) });
    relearn(); var bo=S.blend.blOwn||{}; r.ownActive=!!bo.active; r.ownW=bo.w; r.ownGain=bo.gain; r.sunVsWed=forecast(own,sun)/Math.max(1e-9,forecast(own,wed));
    PANES={stats:"accuracy"}; S.tab="stats"; render(); r.card=/نفس اليوم/.test(document.querySelector('.pane[data-g="stats"][data-s="accuracy"]').textContent);
    PANES={stats:"nextweek"}; S.tab="stats"; render();
    var row=Array.prototype.filter.call(document.querySelectorAll("#nwTable tbody tr"),function(t){return t.children[0].textContent==="blOwn"})[0];
    r.nwCols=row?row.children.length:0; r.nwRange=row?/–/.test(row.lastElementChild.textContent):false;
    S.products=S.products.filter(function(p){return p.id!=="blOwn"&&p.id!=="blFlat"}); Object.keys(S.days).forEach(function(k){ delete S.days[k].items.blOwn; delete S.days[k].items.blFlat }); relearn();
    return r })()`);
  check('«نفس اليوم»: a product with a weekday rhythm of its own gets the second opinion blended in (tested to be closer), and its Sunday stands out', BL.ownActive && BL.ownW > 0 && BL.ownGain >= 0.03 && BL.sunVsWed > 2, J(BL));
  check('…a product the forecast already reads right is left exactly as it was; the accuracy screen counts the blended ones', !BL.flatActive && BL.flatSame && BL.card, J(BL));
  check('«توقّع الأسبوع القادم»: seven days per product, the week, and its likely range', BL.nwCols === 10 && BL.nwRange, J(BL));
  const WY = await ev(`(function(){ S.tab="order"; render(); var d=document.querySelector(".row .whyMore"); if(!d) return {has:false}; d.open=true;
    var rows=d.querySelectorAll(".whyDay").length, steps=d.querySelector(".whySteps").textContent, pid=d.closest(".row").dataset.pid, p=S.products.filter(function(x){return x.id===pid})[0];
    return {has:true, rows:rows, sugg:/المقترح/.test(steps), reserve:/احتياطي/.test(steps)} })()`);
  check('the order: «ليه الرقم ده؟» opens every factor day by day, then the reserve, the shelf and the pack, to the suggestion', WY.has && WY.rows >= 1 && WY.sugg && WY.reserve, J(WY));
  const UN = await ev(`(function(){ S.tab="order"; render(); var row=document.querySelector(".rows .row[data-pid]"), pid=row.dataset.pid, p=S.products.filter(function(x){return x.id===pid})[0];
    var dd=S.planDate?parseYmd(S.planDate):(isOrderDay(today())?today():nextOrderDay(today())), pl=planFor(p,dd), keep=S.overrides[pid];
    S.overrides[pid]=Math.max(10,pl.suggested*3+5); render(); var r1=document.querySelector('.row[data-pid="'+pid+'"] .usualNote');
    if(keep==null) delete S.overrides[pid]; else S.overrides[pid]=keep; render(); var r0=document.querySelector('.row[data-pid="'+pid+'"] .usualNote');
    return {sugg:pl.suggested, warned:!!r1, text:r1?r1.textContent:"", cleared:!r0||pl.suggested<4} })()`);
  check('…a quantity typed far from the suggestion is pointed out before the order is placed («انتبه»), and goes when put back', (UN.sugg < 4 || UN.warned) && UN.cleared, J(UN));
  const EO = await ev(`(function(){ var p=S.products.filter(function(x){return S.model[x.id]&&S.model[x.id].n>=7&&S.model[x.id].base>=2})[0]; if(!p) return {none:true};
    var k=Object.keys(S.days).sort().slice(-1)[0], d=parseYmd(k), fcv=round1(forecast(p,d)), e={sold:Math.round(fcv*10)+10, waste:0};
    var hi=entryOdd(p,e,fcv), ok=entryOdd(p,{sold:Math.round(fcv),waste:0},fcv), ww=entryOdd(p,{sold:2,waste:9},fcv);
    return {fcv:fcv, hi:hi, ok:ok, ww:ww} })()`);
  check('«إقفال اليوم»: a figure ten times the day\'s usual is flagged («صفر زيادة؟»), and so is waste far above sales; a normal figure is not', EO.none || (/صفر زيادة/.test(EO.hi) && EO.ok === '' && /الهدر/.test(EO.ww)), J(EO));
  const DM = await ev(`(function(){ var p={id:"dmX",name:"dmX",unit:"حبة",shelfLife:3,packSize:1,moq:0,active:true,aliases:[]}; S.products.push(p);
    var ks=Object.keys(S.days).sort(), sp=recordSpan(), all=datesBetween(ymd(addDays(parseYmd(sp.to),-60)),sp.to); all.forEach(function(k,i){ var r=S.days[k]||(S.days[k]={date:k,items:{},closed:true}); r.items.dmX={sold:i<20?5:0,waste:0,stockout:false} });
    var sug=dormantProducts().some(function(x){return x.p.id==="dmX"}); PANES={stats:"alerts"}; S.tab="stats"; render(); var b=document.querySelector('.prodSleep[data-pid="dmX"]'); if(b) b.click();
    var off=p.active===false, gone=!dormantProducts().some(function(x){return x.p.id==="dmX"}), busy=!dormantProducts().some(function(x){return x.p.id===S.products[0].id});
    S.products=S.products.filter(function(x){return x.id!=="dmX"}); Object.keys(S.days).forEach(function(k){ delete S.days[k].items.dmX }); relearn(); render();
    return {sug:sug, btn:!!b, off:off, gone:gone, busy:busy} })()`);
  check('a product not sold for 30 days while the record went on: «أوقفه» in the alerts pauses it (record kept); a selling product is never suggested', DM.sug && DM.btn && DM.off && DM.gone && DM.busy, J(DM));
  const QA = await ev(`(function(){
    var p=S.products.filter(function(x){return x.active!==false&&S.model[x.id]&&S.model[x.id].base>0})[0], nm=p.name;
    var keys=Object.keys(S.days).sort(), sp=recordSpan(), end=parseYmd(sp.to), wk=datesBetween(ymd(addDays(end,-6)),ymd(end)), want=0;
    wk.forEach(function(k){ var e=S.days[k]&&S.days[k].items[p.id]; if(hasSold(e)) want+=+e.sold||0 });
    var ans=function(q){ return localAnswer(q)||"" };
    return {nm:nm, sales:ans("بعت كام "+nm+" الأسبوع ده؟"), want:numText(qtyRound(p,want)), fc:ans("توقع بكرة لل"+nm), top:ans("ايه اكتر صنف مبيعا الشهر ده"), cmp:ans("قارن الاسبوع ده باللي قبله"),
      dow:ans("ايه اقوى يوم عندي"), acc:ans("دقة التوقع كام"), waste:ans("اكتر صنف هدر"), none:localAnswer("ازيك عامل ايه"), help:ASST_HELP, order:ans("ايه اللي محتاج طلب")} })()`);
  check('«اسأل بياناتك»: «بعت كام [صنف] الأسبوع ده؟» answers with what the record says (the exact sum)', QA.sales.indexOf(QA.nm) >= 0 && QA.sales.indexOf(QA.want) >= 0 && /بِعت/.test(QA.sales), J(QA));
  check('…the forecast for tomorrow with its range, the best sellers, a week-on-week comparison, the weekdays, the accuracy and the waste', /توقّع/.test(QA.fc) && /بين/.test(QA.fc) && /الأكثر مبيعاً/.test(QA.top) && /٪/.test(QA.cmp) && /أيام الأسبوع/.test(QA.dow) && /دقّة التوقّع/.test(QA.acc) && QA.waste.length > 0 && /طلبية/.test(QA.order), J(QA));
  check('…and a question it does not understand gets examples, never an invented number', QA.none === null && /جرّب مثلاً/.test(QA.help), J(QA.none));
  const WI = await ev(`(function(){ PANES={stats:"whatif"}; S.tab="stats"; render(); var rows=document.querySelectorAll("#wiTable tbody tr"), keep=S.cfg.tendency;
    var lo=whatIfAt(0,nextOrderDay(today())), hi=whatIfAt(100,nextOrderDay(today())), su=function(o){return Object.keys(o).reduce(function(a,u){return a+o[u]},0)};
    return {rows:rows.length, cur:!!document.querySelector("#wiTable .wiCur"), more:su(hi.units)>=su(lo.units), wasteUp:su(hi.waste)>=su(lo.waste), shortDown:su(hi.short)<=su(lo.short), same:S.cfg.tendency===keep} })()`);
  check('«ماذا لو؟»: the next order at each tendency — leaning to fewer stock-outs orders more, leaves more, runs short less; the current one marked; nothing changed', WI.rows >= 5 && WI.cur && WI.more && WI.wasteUp && WI.shortDown && WI.same, J(WI));
  const DB = await ev(`(function(){ S.tab="order"; render(); var b=document.getElementById("dailyBrief"); return {on:!!b, text:b?b.textContent.slice(0,160):""} })()`);
  check('«موجز اليوم» on top of the order: tomorrow against its usual, and what deserves a look', DB.on && /غداً/.test(DB.text), J(DB));
  const RC = await ev(`(function(){ return {k:RANGE_K, cal:RANGE_CAL, inRange:RANGE_K>=0.8&&RANGE_K<=2, hit:RANGE_CAL.cover==null||RANGE_CAL.k===2||RANGE_CAL.k===0.8||Math.abs(RANGE_CAL.cover-0.8)<=0.09} })()`);
  check('the range «بين … و…» is calibrated on what really happened (about 8 in 10), within ×0.8 – ×2', RC.inRange && RC.hit, J(RC));
  const NP = await ev(`(function(){
    var src=S.products.filter(function(x){return x.active!==false&&S.model[x.id]&&S.model[x.id].n>=14&&!x.mto})[0];
    var p={id:"npX",name:"صنف جديد تجريبي",unit:"حبة",shelfLife:3,packSize:1,moq:0,active:true,aliases:[]}; S.products.push(p); relearn();
    var d=addDays(today(),2), f0=forecast(p,d), alert=statAlerts().some(function(x){return /npX|صنف جديد تجريبي/.test(x.t)});
    S.tab="order"; render(); var sel=document.querySelector('.likeSel[data-pid="npX"]'); var hasBox=!!sel;
    if(sel){ sel.value=src.id; sel.dispatchEvent(new Event("change",{bubbles:true})) }
    var f1=forecast(p,d), want=forecastBase(src,d)*1, linked=p.like===src.id&&p.likePct===100;
    var pct=document.querySelector('.likePct[data-pid="npX"]'); if(pct){ pct.value="50"; pct.dispatchEvent(new Event("change",{bubbles:true})) }
    var f2=forecast(p,d);
    // three days of its own sales, twice the half-share: the weight moves toward its own record
    for(var i=3;i>=1;i--){ var k=ymd(addDays(today(),-i)), r=S.days[k]||(S.days[k]={date:k,items:{},closed:true}); r.items.npX={sold:Math.round(2*0.5*forecastBase(src,parseYmd(k))),waste:0,stockout:false} }
    relearn(); var n3=S.model.npX.n, f3=forecast(p,d);
    var san=sanitizeRecord({products:[{id:"a1",name:"a",like:"b2",likePct:50},{id:"b2",name:"b",like:"b2"}],days:{}}), kept=san&&san.products[0].like==="b2"&&san.products[0].likePct===50&&!san.products[1].like;
    var plain=S.products.filter(function(x){return x.id!==src.id&&x.id!=="npX"&&!x.like})[0], same=Math.abs(newBase(plain,S.model[plain.id])-(S.model[plain.id].base||0))<1e-12;
    S.products=S.products.filter(function(x){return x.id!=="npX"}); Object.keys(S.days).forEach(function(k){ delete S.days[k].items.npX }); relearn(); render();
    return {f0:f0, alert:alert, box:hasBox, linked:linked, f1:f1, want:want, f2:f2, n3:n3, f3:f3, kept:kept, same:same} })()`);
  check('a new product: zero until it sells (an alert says so), and under its order card «يبدأ توقّعه من صنفٍ يشبهه»', NP.f0 === 0 && NP.alert && NP.box, J(NP));
  check('…a product chosen: its forecast starts from that one (×100%, then ×50%), and its own days take over as they come', NP.linked && Math.abs(NP.f1 - NP.want) / Math.max(1e-9, NP.want) < 0.02 && Math.abs(NP.f2 - NP.want / 2) / Math.max(1e-9, NP.want) < 0.02 && NP.n3 === 3 && NP.f3 > NP.f2, J(NP));
  check('…the choice is saved (never itself), and a product with no choice is exactly as before', NP.kept && NP.same, J(NP));
  const WK = await ev(`(function(){ PANES={stats:"weekly"}; S.tab="stats"; render(); var W=weeklyData(), t=weeklyText(W), sp=recordSpan(), end=parseYmd(sp.to), A=datesBetween(ymd(addDays(end,-6)),ymd(end)), p=W.rows[0].p, want=0;
    A.forEach(function(k){ var e=S.days[k]&&S.days[k].items[p.id]; if(hasSold(e)) want+=+e.sold||0 });
    var keep=window.print; window.print=function(){}; document.getElementById("printWeekly").click(); setTimeout(function(){ window.print=keep },300); var ps=document.getElementById("printSheet");
    return {rows:document.querySelectorAll("#wkTable tbody tr").length, n:W.rows.length, sold:W.rows[0].sold, want:want, text:/التقرير الأسبوعي/.test(t)&&/الأسبوع القادم/.test(t)&&t.indexOf(p.name)>=0, btns:!!document.getElementById("copyWeekly"), printed:true, sheet:!!ps&&/التقرير الأسبوعي/.test(ps.textContent)&&ps.querySelectorAll("tbody tr").length===W.rows.length} })()`);
  check('«التقرير الأسبوعي»: last week product by product (the exact sums), against the week before, with next week — ready to copy or print', WK.rows === WK.n && WK.sold === WK.want && WK.text && WK.btns && WK.printed && WK.sheet, J(WK));
  await cdp.evaluate('try{var P=JSON.parse(localStorage.getItem("talabia.panes.v1")||"{}"); P.order="products"; localStorage.setItem("talabia.panes.v1",JSON.stringify(P))}catch(e){} PANES={order:"products"}; S.tab="order"; render(); 1'); await sleep(300);
  const OUT = await ev(`(function(){
    var shown=Array.prototype.filter.call(document.querySelectorAll('.pane[data-g="order"][data-s="products"] .row'),function(r){ var i=r.querySelector(".qtyIn,.matQty"); return i&&+i.value>0 }).length;
    var secs=orderSections(), all=orderDoc("all"), one=orderDoc(["products"]);
    document.getElementById("exportOrder").click(); var box=document.getElementById("outBox"), tiles=box?box.querySelectorAll(".outTile input:not(#outAll)"):[];
    var r={shown:shown, oneN:one.n, allN:all.n, secs:secs.length, tiles:tiles.length, allChecked:Array.prototype.every.call(tiles,function(i){return i.checked}), prev:!!(box&&box.querySelector("#outPrev").srcdoc.indexOf("<table>")>=0), text:/طلبية الأصناف/.test(all.text)};
    var ca=box.querySelector("#outAll"); ca.checked=false; ca.dispatchEvent(new Event("change",{bubbles:true}));
    r.noneDisabled=box.querySelector('[data-out="pdf"]').disabled===true;
    tiles[0].checked=true; tiles[0].dispatchEvent(new Event("change",{bubbles:true})); r.oneOn=!box.querySelector('[data-out="pdf"]').disabled&&/بنداً من 1/.test(box.querySelector("#outSum").textContent);
    r.btns=["copy","print","pdf","close"].every(function(k){return !!box.querySelector('[data-out="'+k+'"]')}); r.full=document.getElementById("exportOrder").textContent.trim()==="تصدير"&&box.querySelector('[data-out="copy"]').textContent.trim()==="نسخ"&&box.querySelector('[data-out="print"]').textContent.trim()==="طباعة"&&box.querySelector('[data-out="pdf"]').textContent.trim()==="حفظ"&&!document.getElementById("copyOrder");
    box.querySelector('[data-out="close"]').click(); r.closed=!document.getElementById("outBox");
    return r })()`);
  check('copy / print: every card listed to tick (all ticked to start, «تحديد الكل»), a live preview of the page, the actions spelled out in full', OUT.tiles === OUT.secs && OUT.allChecked && OUT.prev && OUT.noneDisabled && OUT.oneOn && OUT.btns && OUT.full && OUT.closed && OUT.oneN === OUT.shown && OUT.allN >= OUT.oneN && OUT.text, J(OUT));
  await cdp.evaluate('document.getElementById("exportOrder").click(); document.querySelector("#outBox [data-out=print]").click(); 1'); await sleep(900);
  let PWOK = false; for (let i = 0; i < 40 && !PWOK; i++) { PWOK = await ev('!document.getElementById("outPrinter") && !document.getElementById("outBox")'); if (!PWOK) await sleep(200); }   // the sheet is laid out first
  check('«طباعة» opens the separate preview window (no panel inside the export window), and the export window closes', PWOK);
  const PDFP = require('path').join(require('os').tmpdir(), 'talabia-test-out.pdf'); try{ fs.unlinkSync(PDFP) }catch(e){}
  const PR = JSON.parse(await cdp.evaluate('window.desktop.docOut(orderDoc("all").html,"pdf","test").then(function(r){return JSON.stringify(r)})'));
  let pdfSize = 0; try{ pdfSize = fs.statSync(PDFP).size }catch(e){}
  check('…«احفظ PDF» writes a real PDF of the order (laid out on a clean page, not the blank one)', PR.ok && pdfSize > 3000, J({PR, pdfSize}));
  const PP = JSON.parse(await cdp.evaluate('window.desktop.docOut(orderDoc("products").html,"print","test").then(function(r){return JSON.stringify(r)})'));
  check('…«اطبع» lays the same page out (a real document, opened to preview and print — and again, as often as wanted)', PP.ok && PP.bytes > 3000, J(PP));
  const PP2 = JSON.parse(await cdp.evaluate('window.desktop.docOut(orderDoc("all").html,"print","test").then(function(r){return JSON.stringify(r)})'));
  check('…a second print right after works too (nothing left hanging)', PP2.ok, J(PP2));
  const HUB = await ev('(function(){ try{localStorage.setItem("talabia.cmpTab.v1","events")}catch(e){} PANES={stats:"compare"}; S.tab="stats"; render(); var p=document.querySelector(\'.pane[data-g="stats"][data-s="compare"]\'); return {one:!document.querySelector(\'.paneSec[data-g="stats"][data-s="cmpfree"]\')&&!document.querySelector(\'.paneSec[data-g="stats"][data-s="brcompare"]\'), tabs:p.querySelectorAll(".cmpTabB").length, ev:!!p.querySelector("#cmpEvents"), sels:p.querySelectorAll(".cmpEvSel").length, rows:p.querySelectorAll("#cmpEvTable tbody tr").length, n:occasionList().length} })()');
  check('«المقارنات»: one card with its ways to compare (periods, two periods by hand, branches, occasions); «المناسبات» sets two occasions side by side', HUB.one && HUB.tabs >= 3 && HUB.ev && (HUB.n < 2 || (HUB.sels === 2 && HUB.rows > 0)), J(HUB));
  await cdp.evaluate('try{localStorage.removeItem("talabia.cmpTab.v1")}catch(e){} 1');
  const DRG = await ev('(function(){ S.tab="stats"; render(); var secs=Array.prototype.map.call(document.querySelectorAll(\'.paneSec[data-g="stats"]\'),function(b){return b.dataset.s}); var drag=document.querySelector(\'.paneSec[data-g="stats"][draggable="true"]\'); var a=secs[0], b=secs[2]; var moved=dndMove("ui-stats",b,a,false); render(); var after=Array.prototype.map.call(document.querySelectorAll(\'.paneSec[data-g="stats"]\'),function(x){return x.dataset.s}); var r={first:secs.slice(0,3), drag:!!drag, moved:moved, nowFirst:after[0]===b}; if(S.cfg.ui) delete S.cfg.ui.stats; if(S.cat&&S.cat.ui) delete S.cat.ui.stats; render(); return r })()');
  check('the analysis cards come in order of importance (alerts, each product, comparisons first), and a card dragged onto another takes its place', DRG.first[0] === 'alerts' && DRG.first[1] === 'products' && DRG.drag && DRG.moved && DRG.nowFirst, J(DRG));
  const BC = await ev(`(function(){
    var mk=function(mult,waste,out){ var days={}; for(var i=1;i<=30;i++){ var k=ymd(addDays(today(),-i)); days[k]={date:k,items:{a:{sold:Math.round(10*mult),waste:waste,stockout:i%10===0&&out},b:{sold:Math.round(4*mult),waste:0,stockout:false}},closed:true} } return {days:days, products:[{id:"a",name:"كنافة"},{id:"b",name:"بسبوسة"}]} };
    var A=summarizeBranch(mk(2,0,false)), B=summarizeBranch(mk(1,2,true));
    return {aAvg:A.avg28, bAvg:B.avg28, aWaste:A.waste, bWaste:B.waste, bOuts:B.outs, topA:A.top, kn:A.byName[normName("كنافة")].avg, days:A.days} })()`);
  check('«مقارنة الفروع»: each branch summed on its own (daily average, waste, stock-outs, its best seller, each product)', BC.days === 28 || BC.days === 30, J(BC));
  check('…the numbers are right (twice the sales, no waste, no stock-outs vs. less, waste, some stock-outs — those days counted at their likely demand)', BC.aAvg === 28 && BC.bAvg > 14 && BC.bAvg < 15 && BC.aWaste === 0 && BC.bWaste > 0 && BC.bOuts > 0 && BC.topA === 'كنافة' && BC.kn === 20, J(BC));

  console.log('\n--- «التقويم والمناسبات» in cards ---');
  await cdp.evaluate('try{var P=JSON.parse(localStorage.getItem("talabia.panes.v1")||"{}"); delete P.calendar; localStorage.setItem("talabia.panes.v1",JSON.stringify(P))}catch(e){} try{ if(typeof PANES==="object"&&PANES) delete PANES.calendar }catch(e){} S.tab="calendar"; render(); 1'); await sleep(200);
  const CAL = await ev('({secs:Array.prototype.map.call(document.querySelectorAll(\'.paneSec[data-g="calendar"]\'),function(b){return b.dataset.s}), open:(document.querySelector(\'.paneSec[data-g="calendar"].on\')||{}).dataset, add:!!document.getElementById("addEvent")&&!document.getElementById("addEvent").closest(".pane").hidden, ref:!!document.querySelector(\'.pane[data-g="calendar"][data-s="ref"] #mktRefTable\')})');
  check('the calendar screen is four cards (occasions, the next two weeks, the market reference, how it works), occasions open', CAL.secs.join() === 'events,weeks,ref,how' && CAL.open && CAL.open.s === 'events' && CAL.add && CAL.ref, J(CAL));
  await cdp.evaluate('document.querySelector(\'.paneSec[data-g="calendar"][data-s="ref"]\').click(); 1'); await sleep(150);
  check('…a press opens another card in its place', await ev('!document.querySelector(\'.pane[data-g="calendar"][data-s="ref"]\').hidden && document.querySelector(\'.pane[data-g="calendar"][data-s="events"]\').hidden'));
  await cdp.evaluate('try{var P=JSON.parse(localStorage.getItem("talabia.panes.v1")||"{}"); delete P.calendar; localStorage.setItem("talabia.panes.v1",JSON.stringify(P))}catch(e){} try{ if(typeof PANES==="object"&&PANES) delete PANES.calendar }catch(e){} 1');

  console.log('\n--- «تخصيص الواجهة»: show, hide and order every screen and card — per branch, or for the brand ---');
  await cdp.evaluate('try{localStorage.setItem("talabia.uiScope.v1","branch")}catch(e){} window.confirm=function(){return true}; delete S.cfg.ui; if(S.cat) delete S.cat.ui; PANES={setup:"ui"}; S.tab="setup"; render(); 1'); await sleep(400);
  await cdp.evaluate('render(); 1'); await sleep(300);
  await cdp.evaluate('try{localStorage.removeItem("talabia.uiOpen.v1")}catch(e){} render(); 1'); await sleep(200);
  const UI0 = await ev('({groups:Array.prototype.map.call(document.querySelectorAll(".uiGrpSec"),function(g){return g.dataset.g}), lists:document.querySelectorAll(".uiGroup").length})');
  check('«تخصيص الواجهة» is cards inside: one per screen, all closed', UI0.groups.indexOf('tabs') >= 0 && UI0.groups.indexOf('order') >= 0 && UI0.groups.indexOf('items') >= 0 && UI0.groups.indexOf('recipes') >= 0 && UI0.lists === 0, J(UI0));
  await cdp.evaluate('document.querySelector(\'.uiGrpSec[data-g="tabs"]\').click(); 1'); await sleep(200);
  const UI1 = await ev('({lists:Array.prototype.map.call(document.querySelectorAll(".uiGroup"),function(g){return g.dataset.g}), rows:document.querySelectorAll(".uiRow").length, setupLocked:!document.querySelector(\'.uiShow[data-g="tabs"][data-k="setup"]\')})');
  check('…a press opens one screen\'s list (settings cannot be hidden)', UI1.lists.join() === 'tabs' && UI1.rows >= 8 && UI1.setupLocked, J(UI1));
  await cdp.evaluate('document.querySelector(\'.uiGrpSec[data-g="tabs"]\').click(); 1'); await sleep(200);
  check('…a second press closes it', await ev('document.querySelectorAll(".uiGroup").length===0'));
  await cdp.evaluate('document.querySelector(\'.uiGrpSec[data-g="order"]\').click(); 1'); await sleep(200);
  await cdp.evaluate('(function(){ var x=document.querySelector(\'.uiShow[data-g="order"][data-k="market"]\'); x.checked=false; x.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()'); await sleep(200);
  await cdp.evaluate('S.tab="order"; render(); 1'); await sleep(300);
  check('a card switched off disappears from its screen (here «تقويم السوق» from the order screen), for this branch', await ev('!document.querySelector(\'.paneSec[data-g="order"][data-s="market"]\') && !!document.querySelector(\'.paneSec[data-g="order"][data-s="products"]\') && S.cfg.ui.order.hidden.indexOf("market")>=0'));
  await cdp.evaluate('dndMove("ui-tabs","stats","order",false); (function(){ var x=document.querySelector(\'.uiShow[data-g="tabs"]\'); return 1 })(); S.cfg.ui.tabs.hidden=["calendar"]; saveCfg(); render(); 1'); await sleep(300);
  const UT1 = await ev('({first:document.querySelector("#tabs button[data-tab]").dataset.tab, cal:document.querySelector(\'#tabs button[data-tab="calendar"]\').hidden})');
  check('screens are reordered by dragging and can be hidden (here «التحليل» first, «التقويم» hidden)', UT1.first === "stats" && UT1.cal === true, J(UT1));
  // the brand's choice, and a branch's own choice over it
  await cdp.evaluate('delete S.cfg.ui; saveCfg(); try{localStorage.setItem("talabia.uiScope.v1","brand")}catch(e){} PANES={setup:"ui"}; S.tab="setup"; render(); 1'); await sleep(300);
  await cdp.evaluate('(function(){ var x=document.querySelector(\'.uiShow[data-g="order"][data-k="how"]\'); x.checked=false; x.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()'); await sleep(200);
  const B1 = await ev('({brand:!!(S.cat.ui&&S.cat.ui.order&&S.cat.ui.order.hidden.indexOf("how")>=0), branch:!!(S.cfg.ui&&S.cfg.ui.order), from:uiOf("order").from})');
  check('«كلّ فروع البراند» keeps the choice with the brand (every branch follows it)', B1.brand && !B1.branch && B1.from === 'brand', J(B1));
  await cdp.evaluate('S.cfg.ui={order:{order:[],hidden:[]}}; render(); 1');
  check('…and a branch\'s own arrangement wins over the brand\'s', await ev('uiOf("order").from==="branch" && uiArrange("order",[{k:"how"},{k:"products"}],function(x){return x.k},function(x){return x.k}).length===2'));
  const uiKept = await ev('(function(){ var r=sanitizeRecord({products:[],cfg:{ui:{tabs:{order:["stats"],hidden:["calendar","<bad>"]}}}}).cfg.ui; var c=sanitizeCatalog({ui:{order:{order:[],hidden:["how"]}}},S.catBrand).ui; return {r:r, c:c} })()');
  check('both are kept (and cleaned) with the branch and the brand', uiKept.r.tabs.order[0] === 'stats' && uiKept.r.tabs.hidden.join() === 'calendar' && uiKept.c.order.hidden[0] === 'how', J(uiKept));
  await cdp.evaluate('delete S.cfg.ui; saveCfg(); if(S.cat){ delete S.cat.ui; saveCatalog() } try{localStorage.removeItem("talabia.uiScope.v1")}catch(e){} render(); 1'); await sleep(200);
  await cdp.evaluate('S.tab="order"; render(); 1'); await sleep(200);
  check('«أعِد الافتراضي» brings every screen and card back', await ev('!!document.querySelector(\'.paneSec[data-g="order"][data-s="market"]\') && !document.querySelector(\'#tabs button[data-tab="calendar"]\').hidden'));

  console.log('\n--- «المظهر والألوان»: five day themes, five night themes, and one from the logo ---');
  await cdp.evaluate('try{localStorage.removeItem("dq-pal-"+CUR_BRAND); localStorage.removeItem("dq-logo-"+CUR_BRAND)}catch(e){} applyBrand(CUR_BRAND); PANES={setup:"theme"}; S.tab="setup"; render(); 1'); await sleep(300);
  const TH0 = await ev('({light:document.querySelectorAll(\'.thSw[data-mode="light"]\').length, dark:document.querySelectorAll(\'.thSw[data-mode="dark"]\').length, onLight:(document.querySelector(\'.thSw.on[data-mode="light"]\')||{}).dataset, bg:getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()})');
  check('settings show 5 day and 5 night themes (plus the brand\'s own, selected)', TH0.light === 6 && TH0.dark === 6 && TH0.onLight && TH0.onLight.id === 'brand', J(TH0));
  // every preset reads well: text, faint text, the accent, and the button text on the accent
  const CT = await ev('(function(){ var low=99, who=""; ["light","dark"].forEach(function(m){ THEMES[m].forEach(function(t){ var p=makePalette(m,t.h,t.s,t.t); [[p.ink,p.bg],[p["ink-3"],p.surface],[p["ink-3"],p["surface-2"]],[p.accent,p.surface],[p["on-accent"],p.accent],[p["accent-ink"],p["accent-soft"]]].forEach(function(x){ var c=contrast(x[0],x[1]); if(c<low){low=c; who=m+"/"+t.id} }) }) }); return {low:Math.round(low*100)/100, who:who} })()');
  check('every theme keeps text readable (contrast ≥ 4.5 everywhere; lowest ' + CT.low + ')', CT.low >= 4.5, J(CT));
  // pick «ميرمية» for the day: the page wears it at once and keeps it
  await cdp.evaluate('document.querySelector(\'.thSw[data-mode="light"][data-id="sage"]\').click(); 1'); await sleep(300);
  const TH1 = await ev('(function(){ var p=makePalette("light",150,28,12); return {want:p.bg, bg:getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase(), mode:document.documentElement.getAttribute("data-theme"), saved:themePrefs().light} })()');
  check('choosing a day theme dresses the app at once and is kept', TH1.bg === TH1.want.toLowerCase() && TH1.mode === 'light' && TH1.saved === 'sage', J(TH1));
  await cdp.evaluate('document.querySelector(\'.thSw[data-mode="dark"][data-id="midnight"]\').click(); 1'); await sleep(300);
  check('…and a night theme the same way (the app switches to night)', await ev('document.documentElement.getAttribute("data-theme")==="dark" && getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()===makePalette("dark",212,58,24).bg.toLowerCase()'));
  // a logo: a red mark on white → a red-hued theme
  await cdp.evaluate(`(function(){ var c=document.createElement("canvas"); c.width=120; c.height=60; var x=c.getContext("2d"); x.fillStyle="#fff"; x.fillRect(0,0,120,60); x.fillStyle="#C0392B"; x.fillRect(10,10,70,40); x.fillStyle="#1F3A5F"; x.fillRect(85,15,25,25);
    c.toBlob(function(b){ buildLogoTheme(new File([b],"logo.png",{type:"image/png"})) }); return 1 })()`); await sleep(1200);
  const LGT = await ev('(function(){ var L=logoTheme(); if(!L) return null; var h=rgb2hsl.apply(null,hex2rgb(L.light.accent)); return {colors:L.colors, hue:Math.round(h[0]), prefs:themePrefs(), swatch:!!document.querySelector(\'.thSw[data-id="logo"]\'), img:!!L.img, read:Math.round(contrast(L.light.accent,"#FFFFFF")*100)/100} })()');
  check('a logo becomes a theme in its own colour (red → a red accent), applied day and night', !!LGT && (LGT.hue <= 15 || LGT.hue >= 345) && LGT.prefs.light === 'logo' && LGT.prefs.dark === 'logo' && LGT.swatch && LGT.img, J(LGT));
  check('…still readable (accent ≥ 4.5 on white)', LGT && LGT.read >= 4.5, LGT && LGT.read);
  await cdp.evaluate('document.getElementById("logoForget").click(); 1'); await sleep(300);
  check('«احذف ثيم اللوجو» goes back to the brand\'s colours', await ev('!logoTheme() && themePrefs().light!=="logo" && themePrefs().dark!=="logo"'));
  await cdp.evaluate('PANES={setup:"theme"}; S.tab="setup"; render(); document.getElementById("customColor").value="#2e7d32"; document.getElementById("customApply").click(); 1'); await sleep(300);
  check('«ثيم بألوانك»: one colour becomes a day and a night theme, applied, with its own swatch', await ev('(function(){ var C=customTheme(), P=themePrefs(), h=rgb2hsl.apply(null,hex2rgb(C.light.accent)); return P.light==="custom"&&P.dark==="custom"&&Math.abs(h[0]-123)<12&&!!document.querySelector(\'.thSw[data-id="custom"]\')&&getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase()===(document.documentElement.getAttribute("data-theme")==="dark"?C.dark:C.light).accent.toLowerCase() })()'));
  await cdp.evaluate('try{localStorage.removeItem("dq-custom-"+CUR_BRAND)}catch(e){} 1');
  await cdp.evaluate('try{localStorage.removeItem("dq-pal-"+CUR_BRAND)}catch(e){} applyBrand(CUR_BRAND); 1');

  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
