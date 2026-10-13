'use strict';
/*
 * The materials-and-recipes layer through the real app, with the owner's own worked example:
 *
 *   sold:   Black Coffee 10 · Ice Black Coffee 15 · سينابون كبير 30 · عرض التلة 20
 *   offer:  عرض التلة = 1 سينابون كبير + 1 Ice Black Coffee + 1 بوكس التلة
 *   links:  Black Coffee → قهوة · Ice Black Coffee → قهوة
 *   recipe: سينابون كبير = صوص 40 جم + كريمة 20 جم + مكسرات 10 جم
 *   →       قهوة 45 · سينابون كبير 50 · بوكس التلة 20 · صوص 2 كجم · كريمة 1 كجم · مكسرات 0.5 كجم
 *
 * Everything is set on the screen as the owner would. Also: the sales stay exactly as Odoo sold them,
 * products with no rule are listed (not dropped), an offer that contains itself is stopped, a branch can
 * override a brand recipe, CANELÉS and CHEZZZ never share a catalogue, the forecast × recipe need under
 * the order, the catalogue in a backup, and the catalogue surviving a restart.
 *
 *   node tools/test-recipes.js            (dev build)
 *   DAFTAR_EXE=...\Talabia.exe node tools/test-recipes.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-recipes-'));
const PORT = 9300 + Math.floor(Math.random() * 600);
const EXE = process.env.DAFTAR_EXE || null;
const BACKUP = path.join(PROFILE, 'backup-test.json');

let pass = 0, fail = 0;
const pageErrors = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + String(detail).slice(0, 400) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function launch() {
  const args = EXE ? ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT]
                   : ['.', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT];
  const env = Object.assign({}, process.env, { DAFTAR_TEST_BACKUP_FILE: BACKUP });
  return spawn(EXE || ELECTRON, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
const J = JSON.stringify;

/* ---- driving the screen the way the owner would ---- */
const ui = {
  /** the screen is split into sections (like the control panel): open the one the next step works in */
  async open(cdp, sec) {
    await cdp.evaluate(`(function(){ if(window.S.recSec!==${J(sec)}){ document.getElementById("recSec_"+${J(sec)}).click() } return 1 })()`);
    await waitFor(cdp, 'window.S.recSec===' + J(sec) + ' && document.querySelector("#view .cp-panel")', 'section ' + sec);
  },
  async addItem(cdp, name, unit) {
    await ui.open(cdp, 'items');
    await cdp.evaluate(`(function(){ document.getElementById("catNewItem").value=${J(name)};
      var u=document.getElementById("catNewUnit"); u.value=${J(unit)}; document.getElementById("catAddItem").click(); return 1 })()`);
    await waitFor(cdp, `window.S.cat.items.some(function(i){return i.name===${J(name)}})`, 'material ' + name);
  },
  itemId: (cdp, name) => cdp.evaluate(`(window.S.cat.items.filter(function(i){return i.name===${J(name)}})[0]||{}).id`),
  async link(cdp, product, item) {
    const id = await ui.itemId(cdp, item);
    await ui.open(cdp, 'links');
    await cdp.evaluate(`(function(){ var rows=document.querySelectorAll("#catLinks tbody tr");
      for (var i=0;i<rows.length;i++){ if(rows[i].cells[0].textContent.trim()===${J(product)}){ var s=rows[i].querySelector(".catLink"); s.value=${J(id)}; s.dispatchEvent(new Event("change",{bubbles:true})); return 1 } }
      throw new Error("no link row for ${product}") })()`);
    await sleep(200);
  },
  async addDef(cdp, kind, product) {
    await ui.open(cdp, kind === 'b' ? 'bundles' : 'recipes');
    const sel = kind === 'b' ? 'catNewBundle' : 'catNewRecipe', btn = kind === 'b' ? 'catAddBundle' : 'catAddRecipe';
    await cdp.evaluate(`(function(){ var s=document.getElementById(${J(sel)});
      for (var i=0;i<s.options.length;i++) if (s.options[i].text===${J(product)}) { s.value=s.options[i].value; break }
      if(!s.value) throw new Error("no option ${product}");
      document.getElementById(${J(btn)}).click(); return 1 })()`);
    await sleep(250);
  },
  card: (kind, product) => `(function(){ var cs=document.querySelectorAll('.catDef[data-kind="${kind}"]');
      for (var i=0;i<cs.length;i++) if (cs[i].querySelector("b").textContent===${J(product)}) return cs[i]; return null })()`,
  /** set line i of a definition: ref is "p:<product name>" or "i:<material name>" */
  async setLine(cdp, kind, product, i, ref, qty, unit) {
    await ui.open(cdp, kind === 'b' ? 'bundles' : 'recipes');
    await cdp.evaluate(`(function(){ var card=${ui.card(kind, product)};
      var n=card.querySelectorAll('tbody tr').length;
      if (n<=${i}) { card.querySelector(".catLineAdd").click() } return 1 })()`);
    await sleep(200);
    await cdp.evaluate(`(function(){ var card=${ui.card(kind, product)};
      var row=card.querySelectorAll('tbody tr')[${i}], s=row.querySelector('.catLine[data-f="ref"]');
      var want=${J(ref)}, kind=want.slice(0,2), name=want.slice(2);
      for (var k=0;k<s.options.length;k++){ var o=s.options[k];
        if (o.value.slice(0,2)===kind && (o.text===name || o.text.indexOf(name+" (")===0)) { s.value=o.value; break } }
      s.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`);
    await sleep(200);
    await cdp.evaluate(`(function(){ var card=${ui.card(kind, product)};
      var row=card.querySelectorAll('tbody tr')[${i}];
      var q=row.querySelector('.catLine[data-f="qty"]'); q.value=${J(String(qty))}; q.dispatchEvent(new Event("input",{bubbles:true}));
      ${unit ? `var u=row.querySelector('.catLine[data-f="unit"]'); u.value=${J(unit)}; u.dispatchEvent(new Event("change",{bubbles:true}));` : ''}
      return 1 })()`);
    await sleep(200);
  }
};

(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('recipes test, profile ' + PROFILE + '\n');
  let proc = launch();
  let cdp = await connect((await targets()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await cdp.evaluate('orderFoldsSet({mto:true,mat:true,needs:true,market:true,how:true}); 1');   // the order screen's folding sections, all open for the checks
  await cdp.evaluate('document.getElementById("fresh").click()');
  await waitFor(cdp, 'window.S.demo === false', 'an empty branch');
  const branchId = await cdp.evaluate('window.S.branchId');
  // the shop's products as Odoo sells them, plus one with no operational rule yet
  await cdp.evaluate(`(function(){
    [["bc","Black Coffee"],["ibc","Ice Black Coffee"],["cl","سينابون كبير"],["off","عرض التلة"],["cake","كيكة"]].forEach(function(x){
      var p={id:x[0], name:x[1], unit:"حبة", shelfLife:3, packSize:1, moq:0, active:true, aliases:[]};
      window.S.products.push(p); saveProduct(p);
    });
    return 1 })()`);

  console.log('--- the screen ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="recipes"]\').click()');
  await waitFor(cdp, 'window.S.tab==="recipes" && document.getElementById("recSecs")', 'the materials screen');
  check('the screen opens for the open brand', await cdp.evaluate('window.S.catBrand===curBrandKey() && /CANEL/i.test(document.getElementById("wordmark").textContent)'));
  for (const [n, u] of [['قهوة', 'قطعة'], ['صوص', 'جم'], ['كريمة', 'جم'], ['مكسرات', 'جم'], ['بوكس التلة', 'قطعة']]) await ui.addItem(cdp, n, u);
  check('five materials / operational items added', await cdp.evaluate('window.S.cat.items.length') === 5);
  await ui.link(cdp, 'Black Coffee', 'قهوة');
  await ui.link(cdp, 'Ice Black Coffee', 'قهوة');
  check('Black Coffee and Ice Black Coffee are linked to قهوة', await cdp.evaluate('Object.keys(window.S.cat.links).length') === 2);
  await ui.addDef(cdp, 'b', 'عرض التلة');
  await ui.setLine(cdp, 'b', 'عرض التلة', 0, 'p:سينابون كبير', 1);
  await ui.setLine(cdp, 'b', 'عرض التلة', 1, 'p:Ice Black Coffee', 1);
  await ui.setLine(cdp, 'b', 'عرض التلة', 2, 'i:بوكس التلة', 1);
  const bundle = JSON.parse(await cdp.evaluate('JSON.stringify(window.S.cat.bundles)'));
  const bl = Object.values(bundle)[0];
  check('the offer has its three lines', bl && bl.lines.length === 3 && bl.lines.filter(l => l.kind === 'p').length === 2 && bl.lines.filter(l => l.kind === 'i').length === 1, J(bundle));
  await ui.addDef(cdp, 'r', 'سينابون كبير');
  await ui.setLine(cdp, 'r', 'سينابون كبير', 0, 'i:صوص', 40, 'جم');
  await ui.setLine(cdp, 'r', 'سينابون كبير', 1, 'i:كريمة', 0.02, 'كجم');      // written in kilos on purpose
  await ui.setLine(cdp, 'r', 'سينابون كبير', 2, 'i:مكسرات', 10, 'جم');
  check('the recipe has its three lines', await cdp.evaluate('Object.values(window.S.cat.recipes)[0].lines.length') === 3);

  console.log('\n--- the worked example ---');
  const day = await cdp.evaluate('ymd(addDays(today(),-1))');
  await cdp.evaluate(`(function(){ var d=ensureDay(${J(day)});
    d.items={bc:{sold:10,waste:0,stockout:false},ibc:{sold:15,waste:0,stockout:false},cl:{sold:30,waste:0,stockout:false},off:{sold:20,waste:0,stockout:false},cake:{sold:5,waste:0,stockout:false}};
    saveDay(${J(day)}); relearn(); return 1 })()`);
  const O = JSON.parse(await cdp.evaluate(`(function(){ var o=opReport({from:${J(day)},to:${J(day)}}), byName={};
    o.rows.forEach(function(r){ byName[r.item.name]=r.total });
    var prods={}; Object.keys(o.tot.prods).forEach(function(k){ prods[opName(o.ctx,k)]=o.tot.prods[k] });
    return JSON.stringify({items:byName, prods:prods, bundled:o.tot.bundled, unlinked:Object.keys(o.tot.unlinked).map(function(k){return opName(o.ctx,k)+":"+o.tot.unlinked[k].qty})}) })()`));
  check('قهوة = 10 + 15 + 20 from the offer = 45', O.items['قهوة'] === 45, J(O.items));
  check('سينابون كبير after the offer = 30 + 20 = 50', O.prods['سينابون كبير'] === 50, J(O.prods));
  check('Ice Black Coffee after the offer = 15 + 20 = 35', O.prods['Ice Black Coffee'] === 35, J(O.prods));
  check('بوكس التلة = 20', O.items['بوكس التلة'] === 20, J(O.items));
  check('صوص = 50 × 40 = 2,000 جم', O.items['صوص'] === 2000, J(O.items));
  check('كريمة = 50 × 0.02 كجم = 1,000 جم (units converted)', Math.abs(O.items['كريمة'] - 1000) < 1e-6, J(O.items));
  check('مكسرات = 500 جم', O.items['مكسرات'] === 500, J(O.items));
  check('a product with no rule is listed, not dropped (كيكة 5)', O.unlinked.length === 1 && O.unlinked[0] === 'كيكة:5', J(O.unlinked));
  check('the recorded sales are untouched', await cdp.evaluate(`J=JSON.stringify, J(window.S.days[${J(day)}].items.off)`) === J({ sold: 20, waste: 0, stockout: false }) &&
    await cdp.evaluate(`window.S.days[${J(day)}].items.ibc.sold`) === 15);

  console.log('\n--- the analysis screen ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="stats"]\').click()');
  await waitFor(cdp, 'document.getElementById("opStats")', 'the operational analysis');
  await cdp.evaluate("(function(){ var b=document.querySelector('.paneSec[data-s=ops]'); if(b) b.click(); return 1 })()");   // the analysis in sections: open «التحليل التشغيلي»
  const st = await cdp.evaluate('document.getElementById("view").innerText');
  check('the sales analysis is still there', st.indexOf('تحليل كلّ صنف') >= 0 && st.indexOf('الأكثر مبيعاً') >= 0);
  check('the operational analysis shows صوص as 2 كجم', /صوص\s+2 كجم/.test(st), st.slice(st.indexOf('التحليل التشغيلي'), st.indexOf('التحليل التشغيلي') + 400));
  check('and مكسرات as 500 جم', /مكسرات\s+500 جم/.test(st));
  check('the products needing a link are listed with the reason', await cdp.evaluate('document.getElementById("opUnlinked").innerText.indexOf("كيكة") >= 0 && document.getElementById("opUnlinked").innerText.indexOf("لا ربط تشغيلي") >= 0'));
  const rowQ = await cdp.evaluate('(document.querySelector(\'.opRow\')||{}).dataset.item');
  await cdp.evaluate('document.querySelector(".opRow").click()');
  await waitFor(cdp, 'document.getElementById("opDetail")', 'an item detail');
  check('an item opens with where it came from', await cdp.evaluate('document.getElementById("opDetail").innerText.indexOf("جاء من") >= 0'), rowQ);
  const daily = JSON.parse(await cdp.evaluate(`JSON.stringify((function(){ var rows=document.querySelectorAll("#opDaily tbody tr");
    var O=opReport(statRange()), r=O.rows.filter(function(x){return x.item.id===${JSON.stringify(rowQ)}})[0];
    var sum=r.series.reduce(function(t,x){return t+x.qty},0);
    return {rows:rows.length, days:r.series.length, sumOk:Math.abs(sum-r.total)<1e-6, first:rows[0]&&rows[0].children[1].textContent, newest:r.series[r.series.length-1].date} })())`));
  check('the item shows how much went out day by day (newest first), and the days add up to the total', daily.rows === daily.days && daily.sumOk && daily.first === daily.newest, JSON.stringify(daily));
  const qSrc = JSON.parse(await cdp.evaluate(`(function(){ var o=opReport({from:${J(day)},to:${J(day)}}); var r=o.rows.filter(function(x){return x.item.name==="قهوة"})[0];
    return JSON.stringify(r.sources.map(function(s){return s.name+":"+s.amount})) })()`));
  check('قهوة comes from Black Coffee 10, Ice Black Coffee 15 and the offer 20', qSrc.sort().join() === ['Black Coffee:10', 'Ice Black Coffee:15', 'عرض التلة:20'].sort().join(), J(qSrc));

  console.log('\n--- changes take effect at once ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="recipes"]\').click()');
  await waitFor(cdp, 'document.getElementById("recSecs")', 'the recipes');
  await ui.setLine(cdp, 'r', 'سينابون كبير', 0, 'i:صوص', 30, 'جم');
  check('editing the recipe recomputes the analysis (صوص 1,500 جم)', await cdp.evaluate(`opReport({from:${J(day)},to:${J(day)}}).rows.filter(function(r){return r.item.name==="صوص"})[0].total`) === 1500);
  await ui.open(cdp, 'bundles');
  await cdp.evaluate(`(function(){ var c=${ui.card('b', 'عرض التلة')}.querySelector(".catDefOn"); c.checked=false; c.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`);
  await sleep(300);
  const off = JSON.parse(await cdp.evaluate(`(function(){ var o=opReport({from:${J(day)},to:${J(day)}}); var q=o.rows.filter(function(r){return r.item.name==="قهوة"})[0];
    return JSON.stringify({q:q&&q.total, ul:Object.keys(o.tot.unlinked).map(function(k){return opName(o.ctx,k)+":"+o.tot.unlinked[k].why})}) })()`));
  check('switching the offer off stops breaking it down (قهوة 25)', off.q === 25, J(off));
  check('…and says why it is no longer counted', off.ul.some(x => /عرض التلة:العرض موقوف/.test(x)), J(off.ul));
  await ui.open(cdp, 'bundles');
  await cdp.evaluate(`(function(){ var c=${ui.card('b', 'عرض التلة')}.querySelector(".catDefOn"); c.checked=true; c.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`);
  await ui.setLine(cdp, 'r', 'سينابون كبير', 0, 'i:صوص', 40, 'جم');

  console.log('\n--- an offer that contains itself ---');
  const cyc = JSON.parse(await cdp.evaluate(`(function(){
    var cat=JSON.parse(JSON.stringify(window.S.cat)), ctx0=opCtx(cat,window.S.branchId);
    var ko=productKey(window.S.products.filter(function(p){return p.id==="off"})[0]), kc=productKey(window.S.products.filter(function(p){return p.id==="cake"})[0]);
    cat.bundles[kc]={active:true,lines:[{kind:"p",ref:ko,qty:1}]};
    cat.bundles[ko].lines.push({kind:"p",ref:kc,qty:1});
    var ctx=opCtx(cat,window.S.branchId), acc=opAcc();
    opExpand(ctx,[ko],1,acc,ko,0,[]);
    return JSON.stringify({cycles:Object.keys(acc.cycles), sauce:acc.items[window.S.cat.items.filter(function(i){return i.name==="صوص"})[0].id]}) })()`));
  check('the loop is stopped and reported, the rest still counts', cyc.cycles.length === 1 && cyc.sauce === 40, J(cyc));

  console.log('\n--- a branch overrides the brand recipe ---');
  await ui.open(cdp, 'recipes');
  await cdp.evaluate('document.getElementById("catScopeBranch").click()');
  await waitFor(cdp, 'window.S.recScope==="branch"', 'branch scope');
  await ui.addDef(cdp, 'r', 'سينابون كبير');
  await ui.setLine(cdp, 'r', 'سينابون كبير', 0, 'i:صوص', 50, 'جم');
  const ov = JSON.parse(await cdp.evaluate(`(function(){
    var br=window.S.cat.branches[window.S.branchId]||{recipes:{}};
    var here=opReport({from:${J(day)},to:${J(day)}}).rows.filter(function(r){return r.item.name==="صوص"})[0].total;
    var bid=window.S.branchId; window.S.branchId="caneles-other";
    var other=opReport({from:${J(day)},to:${J(day)}}).rows.filter(function(r){return r.item.name==="صوص"})[0].total;
    window.S.branchId=bid;
    return JSON.stringify({stored:Object.keys(br.recipes).length, here:here, other:other, brand:Object.values(window.S.cat.recipes)[0].lines[0].qty}) })()`));
  check('the override is stored for this branch only', ov.stored === 1 && ov.brand === 40, J(ov));
  check('this branch uses 50 جم (2,500), another branch still 40 (2,000)', ov.here === 2500 && ov.other === 2000, J(ov));
  await cdp.evaluate(`(function(){ window.S.recScope="branch"; render(); return 1 })()`);
  await cdp.evaluate(`(function(){ ${ui.card('r', 'سينابون كبير')}.querySelector(".catDefDel").click(); return 1 })()`);
  await sleep(300);
  check('removing the override falls back to the brand recipe', await cdp.evaluate(`opReport({from:${J(day)},to:${J(day)}}).rows.filter(function(r){return r.item.name==="صوص"})[0].total`) === 2000);
  await cdp.evaluate('document.getElementById("catScopeBrand").click()');

  console.log('\n--- forecast × recipe under the order ---');
  // a few weeks of history so the order engine forecasts
  await cdp.evaluate(`(function(){ for(var i=2;i<30;i++){ var k=ymd(addDays(today(),-i)), d=ensureDay(k);
      d.items={bc:{sold:4,waste:0,stockout:false},ibc:{sold:6,waste:0,stockout:false},cl:{sold:10,waste:0,stockout:false},off:{sold:5,waste:0,stockout:false}}; saveDay(k) }
    relearn(); return 1 })()`);
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="order"]\').click()');
  await waitFor(cdp, 'document.getElementById("opNeeds")', 'the materials block');
  const need = JSON.parse(await cdp.evaluate(`(function(){
    var d=window.S.planDate?parseYmd(window.S.planDate):(isOrderDay(today())?today():nextOrderDay(today()));
    var plans=activeProducts().map(function(p){return {p:p,plan:planFor(p,d)}});
    var n=opNeeds(plans), get=function(nm){return n.rows.filter(function(r){return r.item.name===nm})[0]};
    var pl=function(id){return plans.filter(function(r){return r.p.id===id})[0].plan};
    return JSON.stringify({sauce:get("صوص").expected, sauceT:get("صوص").target, box:get("بوكس التلة").expected,
      cl:pl("cl").expected, off:pl("off").expected, clT:pl("cl").target, offT:Math.max(pl("off").target,pl("off").expected)}) })()`));
  check('the sauce need = (forecast سينابون كبير + forecast عرض التلة) × 40 جم',
    Math.abs(need.sauce - (need.cl + need.off) * 40) < 1e-6 && need.sauce > 0, J(need));
  check('the box need = forecast عرض التلة × 1', Math.abs(need.box - need.off) < 1e-6, J(need));
  check('with the reserve it is at least the expected need', need.sauceT >= need.sauce, J(need));
  check('the order screen shows the block', /المواد المطلوبة لهذه الطلبية/.test(await cdp.evaluate('document.getElementById("view").innerText')));
  check('the order quantities themselves are unchanged by the recipes', await cdp.evaluate(`(function(){
    var d=isOrderDay(today())?today():nextOrderDay(today()), p=window.S.products.filter(function(x){return x.id==="cl"})[0];
    var a=planFor(p,d).suggested, keep=window.S.cat; window.S.cat=emptyCat(curBrandKey()); var b=planFor(p,d).suggested; window.S.cat=keep; return a===b })()`));

  console.log('\n--- CANELÉS and CHEZZZ never share ---');
  // the catalogue is written a moment after the last edit: wait for that write, not a fixed time
  const catSaved = async () => {
    await waitFor(cdp, '!window.catT', 'the pending catalogue save to start', 15000);
    await cdp.evaluate('Promise.resolve(window.catP).then(function(){return 1},function(){return 1})');
    await waitFor(cdp, 'true', 'x');
  };
  await catSaved();
  const brandsDir = path.join(PROFILE, 'brands');
  for (let i = 0; i < 50 && !(fs.existsSync(brandsDir) && fs.readdirSync(brandsDir).includes('caneles.json')); i++) await sleep(200);
  const brands = fs.readdirSync(brandsDir);
  check('the catalogue is a CANELÉS file on disk', brands.includes('caneles.json') && !brands.includes('chezzz.json'), brands.join(','));
  const chz = await cdp.evaluate('(window.S.ws.branches.filter(function(b){return b.brand==="chezzz"})[0]||{}).id');
  if (chz) {
    await cdp.evaluate(`openBranch(${J(chz)}); 1`);
    await waitFor(cdp, `window.S.branchId===${J(chz)} && window.S.catBrand==="chezzz"`, 'the CHEZZZ branch and its catalogue');
    check('a CHEZZZ branch sees an empty catalogue of its own', await cdp.evaluate('window.S.cat.items.length') === 0);
    await cdp.evaluate(`openBranch(${J(branchId)}); 1`);
    await waitFor(cdp, `window.S.branchId===${J(branchId)} && window.S.catBrand==="caneles"`, 'back to CANELÉS');
    check('…and CANELÉS still has its five', await cdp.evaluate('window.S.cat.items.length') === 5);
  } else check('a CHEZZZ branch exists in a fresh profile', false);

  console.log('\n--- backup and restart ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="setup"]\').click()');
  await waitFor(cdp, 'document.getElementById("saveAs")', 'the data section');
  await cdp.evaluate('document.getElementById("saveAs").click()');
  await waitFor(cdp, 'true', 'x'); await sleep(1200);
  const bk = fs.existsSync(BACKUP) ? JSON.parse(fs.readFileSync(BACKUP, 'utf8')) : null;
  check('a backup carries the brand\'s catalogue', bk && bk.brandCatalog && bk.brandCatalog.items.length === 5 && bk.brandCatalog.brand === 'caneles', bk ? Object.keys(bk).join(',') : 'no file');
  check('…and the branch record is unchanged in shape', bk && Array.isArray(bk.products) && bk.days && !('brandCatalog' in (JSON.parse(fs.readFileSync(path.join(PROFILE, 'branches', branchId, 'daftar.json'), 'utf8')))));

  await catSaved();                                // every catalogue edit is on disk before the app is closed
  cdp.close(); proc.kill(); await sleep(1500);
  proc = launch();
  cdp = await connect((await targets()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');   // the delete questions below are answered «yes»
  await waitFor(cdp, 'window.S && window.S.ready && window.S.catBrand==="caneles"', 'the app and its catalogue after a restart');
  await cdp.evaluate('orderFoldsSet({mto:true,mat:true,needs:true,market:true,how:true}); 1');
  check('RELOAD: the catalogue comes back', await cdp.evaluate('window.S.cat.items.length') === 5 &&
    await cdp.evaluate(`opReport(null).rows.length`) >= 5);

  console.log('\n--- free units and many ingredients per recipe ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="recipes"]\').click()');
  await waitFor(cdp, 'document.getElementById("recSecs")', 'the materials screen');
  await ui.open(cdp, 'items');
  check('the unit is a free field with suggestions', await cdp.evaluate('document.getElementById("catNewUnit").tagName==="INPUT" && document.getElementById("catNewUnit").getAttribute("list")==="opUnitList" && document.querySelectorAll("#opUnitList option").length >= 5'));
  await ui.addItem(cdp, 'كوب ورق', '  كوب ');
  check('a unit typed freely is kept, spaces evened out («كوب»)', await cdp.evaluate('window.S.cat.items.filter(function(i){return i.name==="كوب ورق"})[0].unit') === 'كوب');
  await ui.addItem(cdp, 'صوص سينابون', 'كجم');
  // an existing material's unit is typed over too
  await cdp.evaluate(`(function(){ var id=window.S.cat.items.filter(function(i){return i.name==="بوكس التلة"})[0].id;
    var el=document.querySelector('.catItem[data-id="'+id+'"][data-f="unit"]'); el.value="كرتونة"; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`);
  await sleep(300);
  check('an existing material takes a typed unit (كرتونة)', await cdp.evaluate('window.S.cat.items.filter(function(i){return i.name==="بوكس التلة"})[0].unit') === 'كرتونة');
  await ui.addDef(cdp, 'r', 'Ice Black Coffee');
  await ui.setLine(cdp, 'r', 'Ice Black Coffee', 0, 'i:كوب ورق', 1, 'كوب');
  await ui.setLine(cdp, 'r', 'Ice Black Coffee', 1, 'i:صوص سينابون', 105, 'جم');   // stored in كجم, written in جم
  await ui.setLine(cdp, 'r', 'Ice Black Coffee', 2, 'i:مكسرات', 5, 'جم');
  check('«+ أضف مكوّناً» adds as many lines as needed (3)', await cdp.evaluate(`(function(){ var c=${ui.card('r', 'Ice Black Coffee')}; return c.querySelectorAll("tbody tr").length })()`) === 3);
  check('the add button says what it does', /أضف مكوّناً/.test(await cdp.evaluate(`${ui.card('r', 'Ice Black Coffee')}.querySelector(".catLineAdd").textContent`)));
  const fu = JSON.parse(await cdp.evaluate(`(function(){ var o=opReport({from:${J(day)},to:${J(day)}}), by={};
    o.rows.forEach(function(r){ by[r.item.name]={t:r.total,b:r.base} });
    var h=renderOpStats({from:${J(day)},to:${J(day)}});
    return JSON.stringify({by:by, cup:/كوب ورق[\\s\\S]{0,200}35 كوب/.test(h.replace(/<[^>]+>/g," ")), sauce:/صوص سينابون[\\s\\S]{0,200}3\\.68 كجم/.test(h.replace(/<[^>]+>/g," "))}) })()`));
  // Ice Black Coffee: 15 sold + 20 inside the offer = 35
  check('a custom unit is counted as written: 35 كوب', fu.by['كوب ورق'] && fu.by['كوب ورق'].t === 35 && fu.by['كوب ورق'].b === 'كوب', J(fu.by));
  check('grams written for a kilo material: 35 × 105 جم = 3,675 جم (3.68 كجم)', fu.by['صوص سينابون'] && Math.abs(fu.by['صوص سينابون'].t - 3675) < 1e-6, J(fu.by));
  check('two recipes add up on one material: مكسرات 500 + 35 × 5 = 675 جم', fu.by['مكسرات'] && fu.by['مكسرات'].t === 675, J(fu.by));
  check('the analysis shows the custom unit and the kilos', fu.cup && fu.sauce, J(fu));
  check('a custom-unit line offers only its own unit', await cdp.evaluate(`(function(){ var c=${ui.card('r', 'Ice Black Coffee')}; var s=c.querySelectorAll('.catLine[data-f="unit"]')[0]; return s.options.length===1 && s.value==="كوب" })()`));

  console.log('\n--- a recipe written as a link moves into the recipes ---');
  // the way the owner first wrote it: «كيكة» linked to صوص سينابون with 0.105 كجم per piece
  const sauceId = await ui.itemId(cdp, 'صوص سينابون');
  await ui.link(cdp, 'كيكة', 'صوص سينابون');
  await cdp.evaluate(`(function(){ var rows=document.querySelectorAll("#catLinks tbody tr");
    for (var i=0;i<rows.length;i++) if (rows[i].cells[0].textContent.trim()==="كيكة") { var f=rows[i].querySelector(".catLinkF"); f.value="0.105"; f.dispatchEvent(new Event("input",{bubbles:true})); }
    render(); return 1 })()`);
  await sleep(300);
  const before2 = await cdp.evaluate(`opReport({from:${J(day)},to:${J(day)}}).rows.filter(function(r){return r.item.name==="صوص سينابون"})[0].total`);
  check('a link with a quantity is pointed out', await cdp.evaluate('!!document.getElementById("catLinkHint")'));
  await cdp.evaluate('document.getElementById("catLinkMoveAll").click()');
  await sleep(400);
  const moved = JSON.parse(await cdp.evaluate(`(function(){ var k=productKey(window.S.products.filter(function(p){return p.id==="cake"})[0]);
    return JSON.stringify({link:!!window.S.cat.links[k], recipe:window.S.cat.recipes[k]||null}) })()`));
  check('it becomes a recipe line (صوص سينابون 0.105 كجم) and the link is gone', !moved.link && moved.recipe && moved.recipe.lines.length === 1 &&
    moved.recipe.lines[0].item === sauceId && moved.recipe.lines[0].qty === 0.105 && moved.recipe.lines[0].unit === 'كجم', J(moved));
  const after2 = await cdp.evaluate(`opReport({from:${J(day)},to:${J(day)}}).rows.filter(function(r){return r.item.name==="صوص سينابون"})[0].total`);
  check('the totals do not move (' + before2 + ' → ' + after2 + ')', Math.abs(before2 - after2) < 1e-6 && Math.abs(before2 - (3675 + 5 * 105)) < 1e-6);
  check('the coffee links (quantity 1) stay links', await cdp.evaluate('Object.keys(window.S.cat.links).length') === 2);

  console.log('\n--- made to order: ordered through its materials, each by its own shelf life ---');
  await cdp.evaluate(`(function(){
    var p={id:"b16", name:"بولز 16", unit:"حبة", shelfLife:3, packSize:1, moq:0, active:true, aliases:[]};
    window.S.products.push(p); saveProduct(p);
    for(var i=2;i<30;i++){ var k=ymd(addDays(today(),-i)); var d=ensureDay(k); d.items.b16={sold:3+(i%3),waste:0,stockout:false}; saveDay(k) }
    relearn(); render(); return 1 })()`);
  await ui.addItem(cdp, 'كور', 'قطعة');
  await ui.addItem(cdp, 'صوص بولز', 'جم');
  await cdp.evaluate(`(function(){ [["كور",30],["صوص بولز",2]].forEach(function(x){
    var id=window.S.cat.items.filter(function(i){return i.name===x[0]})[0].id;
    var el=document.querySelector('.catItem[data-id="'+id+'"][data-f="shelfLife"]'); el.value=String(x[1]); el.dispatchEvent(new Event("input",{bubbles:true})) }); return 1 })()`);
  await ui.addDef(cdp, 'r', 'بولز 16');
  await ui.setLine(cdp, 'r', 'بولز 16', 0, 'i:كور', 16, 'قطعة');
  await ui.setLine(cdp, 'r', 'بولز 16', 1, 'i:صوص بولز', 105, 'جم');
  const clBefore = await cdp.evaluate('(function(){var d=isOrderDay(today())?today():nextOrderDay(today());return planFor(window.S.products.filter(function(p){return p.id==="cl"})[0],d).suggested})()');
  // the owner ticks it in the Products tab
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="items"]\').click()');
  await waitFor(cdp, 'document.querySelector(\'.itMto[data-id="b16"]\')', 'the made-to-order column');
  await cdp.evaluate(`(function(){ var c=document.querySelector('.itMto[data-id="b16"]'); c.checked=true; c.dispatchEvent(new Event("change",{bubbles:true})); return 1 })()`);
  await waitFor(cdp, 'window.S.products.filter(function(p){return p.id==="b16"})[0].mto===true', 'the flag');
  check('a made-to-order product needs no shelf life in the Products tab', await cdp.evaluate('document.querySelector(\'tr[data-pid="b16"]\').innerText.indexOf("موادّه") >= 0 && !document.querySelector(\'tr[data-pid="b16"] .itIn[data-f="shelfLife"]\')'));
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="order"]\').click()');
  await waitFor(cdp, 'document.getElementById("opOrder")', 'the materials order');
  check('it is not ordered as a product', await cdp.evaluate('!document.querySelector(\'.row[data-pid="b16"]\') && !!document.getElementById("mtoNote")'));
  check('«يُحضَّر بالطلب» shows it as a card with what it is made of (its recipe\'s materials)', await cdp.evaluate('(function(){ var c=document.querySelector(".row.mto[data-mto=b16]"); return !!c && c.innerText.indexOf("كور")>=0 && c.innerText.indexOf("صوص بولز")>=0 && !!c.querySelector(".mtoQty") && !!c.querySelector("svg") })()'));
  check('…nor counted in the order footer', !/بولز 16/.test(await cdp.evaluate('document.getElementById("footinner").innerText')) &&
    await cdp.evaluate('orderedProducts().every(function(p){return p.id!=="b16"})'));
  const mo = JSON.parse(await cdp.evaluate(`(function(){
    var d=window.S.planDate?parseYmd(window.S.planDate):(isOrderDay(today())?today():nextOrderDay(today())), w=coverageWindow(d);
    var plans=activeProducts().map(function(p){return {p:p,plan:planFor(p,d)}});
    var mo=opMaterialOrder(plans,w), id=function(n){return window.S.cat.items.filter(function(i){return i.name===n})[0].id};
    var b=window.S.products.filter(function(p){return p.id==="b16"})[0];
    // the sauce's own ceiling, computed independently: 2 days from delivery × 105 جم × horizonBuffer
    var cap=0; for(var i=0;i<2;i++) cap+=forecast(b,addDays(w.delivery,i))*105*(i===0?w.after:1); cap*=window.S.cfg.horizonBuffer;
    var bp=plans.filter(function(r){return r.p.id==="b16"})[0].plan;
    return JSON.stringify({sauce:mo[id("صوص بولز")], core:mo[id("كور")], capCalc:cap, exp:bp.expected}) })()`));
  check('a 2-day sauce (shorter than the ~3-day window) is capped at what is used before it expires (' + mo.sauce.order + ' جم)', mo.sauce.capBinds && Math.abs(mo.sauce.order - Math.round(mo.capCalc * 100) / 100) < 0.011, JSON.stringify(mo));
  check('the 30-day core is not capped and covers the window with a reserve (' + mo.core.order + ' كور)', !mo.core.capBinds && mo.core.order >= Math.floor(mo.exp * 16) && mo.core.order === Math.ceil(mo.core.target - 1e-9), JSON.stringify(mo.core));
  check('the material expectation = forecast × recipe (core = 16 × product)', Math.abs(mo.core.expected - mo.exp * 16) < 1e-6, JSON.stringify(mo.core));
  check('the screen shows «مقيّد بالصلاحية» on the sauce', await cdp.evaluate('document.getElementById("opOrderCards").innerText.indexOf("مقيّد بالصلاحية") >= 0'));
  // an operational product («قهوة امريكي»): two made-to-order products linked to it are ordered as ONE card with the products
  await cdp.evaluate(`(function(){ var c=window.S.cat, ps=activeProducts().filter(function(p){return p.id!=="b16"&&p.id!=="cl"}).slice(0,2);
    c.items.push({id:"coffeeT",name:"قهوة تجربة",unit:"جرام",shelfLife:4,active:true});
    ps.forEach(function(p){ p.mto=true; c.links[productKey(p)]={item:"coffeeT",factor:101} });
    window.__coffeeFrom=ps.map(function(p){return p.name}); render(); return 1 })()`);
  await sleep(300);
  const cof = JSON.parse(await cdp.evaluate(`JSON.stringify((function(){ var card=document.querySelector('.rows:not(#opOrderCards) .row[data-item="coffeeT"]');
    return {withProducts:!!card, inMaterials:!!document.querySelector('#opOrderCards .row[data-item="coffeeT"]'), text:card?card.innerText:"", from:window.__coffeeFrom} })())`));
  check('a linked material is ordered as one card among the products (both its products in it)', cof.withProducts && !cof.inMaterials && cof.from.every(n => cof.text.indexOf(n) >= 0) && /مجمَّع/.test(cof.text), JSON.stringify(cof));
  // the shop's switch «اعرضها كصنف في الطلبية» on a recipe material (the sauce): it joins the products as one card
  const swId = await cdp.evaluate('window.S.cat.items.filter(function(i){return i.name==="صوص بولز"})[0].id');
  await cdp.evaluate(`(function(){ window.S.tab="recipes"; window.S.recSec="items"; render(); var c=document.querySelector('.catItem[data-id="${swId}"][data-f="asProduct"]');
    c.checked=true; c.dispatchEvent(new Event("change",{bubbles:true})); window.S.tab="order"; render(); return 1 })()`);
  await sleep(300);
  check('the switch moves a recipe material to the products as one card', await cdp.evaluate(`!!document.querySelector('.rows:not(#opOrderCards) .row[data-item="${swId}"]') && !document.querySelector('#opOrderCards .row[data-item="${swId}"]')`));
  check('…and it is saved with the catalogue', await cdp.evaluate(`sanitizeCatalog(JSON.parse(JSON.stringify(window.S.cat)),window.S.catBrand).items.filter(function(i){return i.id==="${swId}"})[0].asProduct===true`));
  await cdp.evaluate(`(function(){ window.S.cat.items.forEach(function(i){ if(i.id==="${swId}") i.asProduct=false; if(i.id==="coffeeT") i.asProduct=false }); render(); return 1 })()`);
  check('switched off, the sauce and even the linked coffee go back to «طلبية المواد»', await cdp.evaluate(`!!document.querySelector('#opOrderCards .row[data-item="${swId}"]') && !!document.querySelector('#opOrderCards .row[data-item="coffeeT"]')`));
  check('an unflagged product is ordered exactly as before', await cdp.evaluate('(function(){var d=isOrderDay(today())?today():nextOrderDay(today());return planFor(window.S.products.filter(function(p){return p.id==="cl"})[0],d).suggested})()') === clBefore);
  await cdp.evaluate('document.getElementById("saveOrder").click()');
  await sleep(500);
  check('the saved order holds no made-to-order product', await cdp.evaluate('(function(){var k=Object.keys(window.S.orders).sort().pop(); return !!k && !window.S.orders[k].items.b16 && !!window.S.orders[k].items.cl})()'));
  // the branch file is written a moment later: poll it rather than guess the time
  const readBranch = () => { try { return JSON.parse(fs.readFileSync(path.join(PROFILE, 'branches', branchId, 'daftar.json'), 'utf8')); } catch (e) { return null; } };
  let disk3 = readBranch();
  for (let i = 0; i < 50 && !(disk3 && (disk3.products.find(p => p.id === 'b16') || {}).mto === true); i++) { await sleep(200); disk3 = readBranch(); }
  check('DISK: the flag is kept on the product', (disk3.products.find(p => p.id === 'b16') || {}).mto === true);

  console.log('\n--- deleting a material that recipes use ---');
  await cdp.evaluate('document.querySelector(\'#tabs button[data-tab="recipes"]\').click()');
  await waitFor(cdp, 'document.getElementById("recSecs")', 'the materials screen');
  await ui.open(cdp, 'items');
  const sb = await ui.itemId(cdp, 'صوص بولز');
  // it is also used in a branch's own recipe
  await cdp.evaluate(`(function(){ var k=productKey(window.S.products.filter(function(p){return p.id==="b16"})[0]);
    window.S.cat.branches[window.S.branchId]={bundles:{},recipes:{}}; window.S.cat.branches[window.S.branchId].recipes[k]={active:true,lines:[{item:${J(sb)},qty:90,unit:"جم"}]}; render(); return 1 })()`);
  check('its ✕ is live, with a tooltip', await cdp.evaluate(`(function(){var b=document.querySelector('.catItemDel[data-id="${sb}"]'); return !!b && !b.disabled && /تُحذف معها/.test(b.title)})()`));
  const where = JSON.parse(await cdp.evaluate(`JSON.stringify(catUsesList(window.S.cat,${J(sb)}))`));
  check('the question names every place it is used', where.some(x => /^وصفة بولز 16$/.test(x)) && where.some(x => /وصفة بولز 16 \(خاصّ بفرع/.test(x)), J(where));
  await cdp.evaluate(`document.querySelector('.catItemDel[data-id="${sb}"]').click(); 1`);
  await sleep(400);
  const gone = JSON.parse(await cdp.evaluate(`(function(){ var k=productKey(window.S.products.filter(function(p){return p.id==="b16"})[0]), c=window.S.cat;
    return JSON.stringify({item:c.items.some(function(i){return i.id===${J(sb)}}), brand:c.recipes[k].lines.map(function(l){return l.item}), branch:c.branches[window.S.branchId].recipes[k].lines.length}) })()`));
  check('after «yes» the material is gone from the list', !gone.item, J(gone));
  check('…and from the brand recipe (the core line stays) and the branch recipe', gone.brand.length === 1 && gone.brand[0] !== sb && gone.branch === 0, J(gone));
  check('a material nobody uses deletes the same way', await (async () => {
    await ui.addItem(cdp, 'مادة مؤقتة', 'قطعة');
    const tid = await ui.itemId(cdp, 'مادة مؤقتة');
    await cdp.evaluate(`document.querySelector('.catItemDel[data-id="${tid}"]').click(); 1`);
    await sleep(300);
    return !(await cdp.evaluate(`window.S.cat.items.some(function(i){return i.id===${J(tid)}})`));
  })());

  console.log('\n--- «ماذا يُطلب في كل يوم»: Friday / Sunday / Tuesday, cinnabon cores on Sunday only ---');
  const sch = JSON.parse(await cdp.evaluate(`JSON.stringify((function(){
    var keep=JSON.stringify(window.S.cfg);
    window.S.cfg.orderDays=[0,2,5]; window.S.cfg.dayCfg={}; window.S.cfg.leadDays=1; window.S.cfg.deliveryHour=19; window.S.cfg.itemDays={};
    var core="coreT"; window.S.cat.items.push({id:"coreT",name:"كور تجربة",unit:"قطعة",shelfLife:30,active:true}); (function(){ var bc=window.S.products.filter(function(p){return p.id==="bc"})[0], k=productKey(bc); window.S.cat.recipes[k]={active:true,lines:[{item:"coreT",qty:16,unit:"قطعة"}]}; var br=(window.S.cat.branches||{})[window.S.branchId]; if(br&&br.recipes) delete br.recipes[k]; delete window.S.cat.links[k] })(); var sauce="coffeeT";
    var cl=window.S.products.filter(function(p){return p.id==="cl"})[0];
    // the owner's week: cores main on Sunday only; every product a top-up on Sunday
    setItemDay("i:"+core,"5","x"); setItemDay("i:"+core,"2","x");
    activeProducts().forEach(function(p){ setItemDay("p:"+p.id,"0","t") });
    var on=function(dow){ var d=addDays(today(),1); for(var i=0;i<8&&d.getDay()!==dow;i++) d=addDays(d,1); return d };   // the next such day after today: a day already under way has real sales since its main order
    var fri=on(5), sun=on(0), tue=on(2);
    var pf=planFor(cl,fri), ps=planFor(cl,sun), pt=planFor(cl,tue);
    var plansAt=function(d){ return activeProducts().map(function(p){return {p:p,plan:planFor(p,d)}}) };
    var moF=opMaterialOrder(plansAt(fri),coverageWindow(fri)), moS=opMaterialOrder(plansAt(sun),coverageWindow(sun));
    var cfgBack=sanitizeRecord({products:[],cfg:window.S.cfg}).cfg.itemDays;
    var r={friNext:pf.win.nextOrder.getDay(), friMode:pf.mode, tueNext:pt.win.nextOrder.getDay(),
      sunMode:ps.mode, sunSuggested:ps.suggested, sunNext:ps.win.nextOrder.getDay(),
      coreOnFri:!!moF[core], coreOnSun:!!moS[core], coreSunSpan:moS[core]&&moS[core].w.span, coreSunNext:moS[core]&&moS[core].w.nextOrder.getDay(),
      sauceFriNext:moF[sauce]&&moF[sauce].w.nextOrder.getDay(), saved:!!cfgBack["i:"+core]&&cfgBack["i:"+core]["5"]==="x"};
    window.__keepCfg=keep; return r })())`));
  check('Friday: a product covers until Tuesday’s order (its next main order), Tuesday until Friday', sch.friMode === 'm' && sch.friNext === 2 && sch.tueNext === 5, JSON.stringify(sch));
  check('Sunday: products are a top-up — shown, nothing guessed without a shelf count, main cover untouched', sch.sunMode === 't' && sch.sunSuggested === 0 && sch.sunNext === 2, JSON.stringify(sch));
  check('cinnabon cores: not on Friday’s order, on Sunday’s for a whole week (to next Sunday)', !sch.coreOnFri && sch.coreOnSun && sch.coreSunNext === 0 && sch.coreSunSpan > 6, JSON.stringify(sch));
  check('an untouched material still follows every order day (Friday → Sunday)', sch.sauceFriNext === 0, JSON.stringify(sch));
  check('the schedule is kept with the settings', sch.saved);
  await cdp.evaluate('window.S.tab="schedule"; render(); 1'); await sleep(300);
  const tbl = await cdp.evaluate('(function(){var t=document.getElementById("itemDaysTable"); return t?t.querySelectorAll("tbody tr").length+"|"+t.querySelectorAll("thead tr:first-child th").length:"none"})()');
  check('the settings show «ماذا يُطلب في كل يوم» with a row per product and material and a column per order day', /^\d+\|4$/.test(tbl) && +tbl.split('|')[0] > 3, tbl);
  // later: Monday replaces Sunday — copy Sunday's column, then drop Sunday
  const mon = await cdp.evaluate(`(function(){ window.S.cfg.orderDays=[0,1,2,5]; render();
    var b=document.querySelector('.itemDayBulk[data-d="1"]'); b.value="c0"; b.dispatchEvent(new Event("change",{bubbles:true}));
    window.S.cfg.orderDays=[1,2,5];
    var core="coreT";
    var r=itemMode("i:"+core,1)+itemMode("p:cl",1)+itemMode("i:"+core,5);
    window.S.cfg=freshCfg(JSON.parse(window.__keepCfg)); render(); return r })()`);
  check('«انسخ من الأحد» moves the whole Sunday to Monday (cores ordered, products top-up)', mon === 'mtx', mon);
  // the top-up suggests the real shortfall: what sold beyond the forecast since the last main order (Friday)
  const tp = JSON.parse(await cdp.evaluate(`JSON.stringify((function(){
    var keep=JSON.stringify(window.S.cfg), keepDays=JSON.stringify(window.S.days);
    window.S.cfg.orderDays=[0,2,5]; window.S.cfg.dayCfg={}; window.S.cfg.leadDays=1; window.S.cfg.deliveryHour=19; window.S.cfg.itemDays={}; window.S.cfg.trackStock=false;
    setItemDay("p:cl","0","t");
    var cl=window.S.products.filter(function(p){return p.id==="cl"})[0];
    var sun=today(); for(var i=0;i<8&&sun.getDay()!==0;i++) sun=addDays(sun,1);
    var fri=addDays(sun,-2), dv=deliveryFor(fri).date;                  // Friday's order lands Saturday evening
    // Saturday and Sunday sold 3× the forecast
    var extra=0; for(var d=dv; d<=sun; d=addDays(d,1)){ var k=ymd(d), f=demandFc(cl,d); window.S.days[k]=window.S.days[k]||{date:k,items:{}}; window.S.days[k].items.cl={sold:Math.round(f*3)}; extra+=(Math.round(f*3)-f)*(+d===+dv?deliveryFor(fri).after:1) }
    var pl=planFor(cl,sun);
    var r={mode:pl.mode, suggested:pl.suggested, short:pl.topup.short, from:pl.topup.from&&pl.topup.from.getDay(), extra:extra};
    window.S.days=JSON.parse(keepDays); window.S.cfg=freshCfg(JSON.parse(keep)); return r })())`));
  check('a top-up day suggests what sold beyond the forecast since Friday (' + tp.suggested + ')', tp.mode === 't' && tp.from === 5 && Math.abs(tp.short - tp.extra) < 1e-6 && tp.suggested >= Math.floor(tp.short) && tp.suggested > 0, JSON.stringify(tp));
  // «استبدل يوم بيوم»: Sunday → Monday with its arrival, hour and what is ordered on it
  const sw = JSON.parse(await cdp.evaluate(`JSON.stringify((function(){
    var keep=JSON.stringify(window.S.cfg);
    window.S.cfg.orderDays=[0,2,5]; window.S.cfg.dayCfg={"0":{lead:0,hour:10}}; window.S.cfg.itemDays={"i:coreT":{"2":"x","5":"x"},"p:cl":{"0":"t"}};
    window.S.tab="schedule"; render();
    document.getElementById("swapFrom").value="0"; document.getElementById("swapTo").value="1"; document.getElementById("swapDay").click();
    var c=window.S.cfg, r={days:c.orderDays.join(","), dc:JSON.stringify(c.dayCfg), cl:itemMode("p:cl",1), clOld:itemMode("p:cl",0), core:itemMode("i:coreT",1)+itemMode("i:coreT",5)};
    window.S.cfg=freshCfg(JSON.parse(keep)); render(); return r })())`));
  check('«استبدل الأحد بالاثنين» moves the day with its arrival, hour and its products', sw.days === '1,2,5' && sw.dc === '{"1":{"lead":0,"hour":10}}' && sw.cl === 't' && sw.core === 'mx', JSON.stringify(sw));

  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
