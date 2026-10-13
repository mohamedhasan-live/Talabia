'use strict';
/*
 * The intelligence layer on synthetic data (a throwaway profile; nothing reaches a real branch or the cloud):
 *   Phase 1  obsOf / dayKind / dataQuality — sold, confirmed zero, missing; the same table imported twice
 *   Phase 2  productInsight / branchInsight — missing days out, confirmed zeros in; weighted average; last N data days
 *   Phase 3/8 forecastTrace / orderTrace — explain forecast() and planFor() without changing them; fallbacks
 *   Phase 6/7 componentDemand — Cinnabon cores and sauce, one coffee for Black and Iced Black, offers (عرض اللمة, بوكس التيلا)
 *   Phase 9  eventInsight — assumed vs measured
 *   Phase 10/11 aiContext / aiValidate — calculated results only; invented numbers caught
 *
 *   node tools/test-intel.js            (dev build)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-intel-'));
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

// SYNTHETIC test data only — built in memory in a throwaway profile, never saved to a real branch or the cloud.
(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('intelligence layer test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');
  const ev = async (x) => JSON.parse(await cdp.evaluate('JSON.stringify(' + x + ')'));

  // 2026-08-03 (Mon) … 2026-08-16 (Sun): X sells, 08-05 confirmed zero row, 08-06 covered but X absent (implied zero),
  // 08-07 no file at all (missing), 08-08 recorded by hand without an import (not covered), the rest covered.
  await cdp.evaluate(`(function(){
    window.__keep={days:S.days, imports:S.imports, events:S.events, products:S.products, cat:S.cat, catBrand:S.catBrand};
    var it=function(o){var r={};Object.keys(o).forEach(function(k){r[k]={sold:o[k],waste:0,stockout:false}});return r};
    S.products=[{id:"X",name:"صنف إكس",shelfLife:3,packSize:1,moq:0,active:true,unit:"حبة",aliases:[]},
                {id:"Y",name:"صنف واي",shelfLife:3,packSize:1,moq:0,active:true,unit:"حبة",aliases:[]}];
    var sales={"2026-08-03":{X:4,Y:1},"2026-08-04":{X:6,Y:0},"2026-08-05":{X:0,Y:2},"2026-08-06":{Y:3},"2026-08-08":{X:9},
      "2026-08-09":{X:5,Y:1},"2026-08-10":{X:7,Y:0},"2026-08-11":{X:8,Y:2},"2026-08-12":{X:2,Y:1},"2026-08-13":{X:6,Y:0},"2026-08-14":{X:12,Y:4},"2026-08-15":{X:3,Y:1},"2026-08-16":{X:5,Y:0}};
    S.days={}; Object.keys(sales).forEach(function(k){ S.days[k]={date:k,items:it(sales[k])} });
    S.imports=Object.keys(sales).filter(function(k){return k!=="2026-08-08"}).map(function(k){return {id:"i"+k,from:k,to:k,complete:true,mode:"replace",hash:""}});
    S.events=[]; relearn(); return 1 })()`);

  console.log('--- Phase 1: one rule for every product-day ---');
  const o = await ev(`["2026-08-03","2026-08-05","2026-08-06","2026-08-07","2026-08-08"].map(function(k){return obsOf(S.products[0],k).state})`);
  check('sold / Odoo 0 row = zero / covered but absent = zero / no file = missing / hand-recorded sale = sold', JSON.stringify(o) === JSON.stringify(['sold', 'zero', 'zero', 'missing', 'sold']), JSON.stringify(o));
  const oy = await ev(`obsOf(S.products[1],"2026-08-08").state`);
  check('a hand-recorded day without an import: a product with no figure stays missing (no zero is made)', oy === 'missing', oy);
  const dk = await ev(`["2026-08-03","2026-08-07","2026-08-08"].map(dayKind)`);
  check('day kinds: covered / missing / recorded', JSON.stringify(dk) === JSON.stringify(['covered', 'missing', 'recorded']), JSON.stringify(dk));
  const dq = await ev(`(function(){var q=dataQuality(); return {missing:q.missing, recorded:q.recorded, covered:q.covered.length, warnings:q.warnings.length}})()`);
  check('data quality: 08-07 missing, 08-08 recorded without import, 12 covered', JSON.stringify(dq.missing) === '["2026-08-07"]' && JSON.stringify(dq.recorded) === '["2026-08-08"]' && dq.covered === 12 && dq.warnings >= 2, JSON.stringify(dq));
  await cdp.evaluate(`S.imports.push({id:"late",from:"2026-08-10",to:"2026-08-10",complete:false,reason:"rows",mode:"add",hash:""}); 1`);
  const sh = await ev(`dataQuality().shadowed`);
  check('a complete day shadowed by a later incomplete import is reported', JSON.stringify(sh) === '["2026-08-10"]', JSON.stringify(sh));
  await cdp.evaluate(`S.imports.pop(); 1`);

  console.log('\n--- Phase 1: the same table imported twice ---');
  const csv = 'Date,Product,Quantity\n2026-08-20,صنف إكس,4\n2026-08-20,صنف واي,1\n';
  const startCsv = async () => { await cdp.evaluate(`(function(){ S.imp=null; startImport(new File([${J(csv)}],"same.csv")); return 1 })()`); await waitFor(cdp, 'S.imp && S.imp.fileName==="same.csv" && S.imp.fingerprint', 'the file to read'); };
  await startCsv();
  const fp1 = await ev('S.imp.fingerprint');
  await cdp.evaluate('applyImport(); 1'); await waitFor(cdp, '!S.imp', 'the first import');
  check('the import record keeps the table fingerprint', await ev(`S.imports[S.imports.length-1].hash===${J(fp1)}`));
  await startCsv();
  check('the same table again: the review says it was imported before', await ev('!!importSeenBefore(S.imp)') && await ev('!!document.getElementById("impSeenBefore")'));
  await cdp.evaluate('S.imp.mode="replace"; S.imp.modeChosen=true; applyImport(); 1'); await waitFor(cdp, '!S.imp', 'the replace');
  check('«replace» of the same table changes nothing', await ev('S.days["2026-08-20"].items.X.sold===4'));
  // «add» of the same table stays possible (existing behaviour, tools/test-import.js) — the warning is what is new
  await startCsv();
  await cdp.evaluate('S.imp.mode="add"; S.imp.modeChosen=true; applyImport(); 1'); await waitFor(cdp, '!S.imp', 'the add');
  check('«add» of the same table is still allowed after the warning (existing behaviour kept): 4 + 4', await ev('S.days["2026-08-20"].items.X.sold===8'));
  check('…and the record now shows that table imported more than once', await ev('dataQuality().duplicates.length>=1'));
  check('the fingerprint survives the record check (sanitizeRecord)', await ev(`sanitizeRecord(JSON.parse(JSON.stringify(payload()))).imports.some(function(x){return x.hash===${J(fp1)}})`));
  await cdp.evaluate('delete S.days["2026-08-20"]; S.imports=S.imports.filter(function(x){return x.from!=="2026-08-20"}); relearn(); 1');

  console.log('\n--- Phase 2: analytics exclude missing, keep confirmed zeros ---');
  const pi = await ev(`(function(){var r=productInsight(S.products[0],{from:"2026-08-03",to:"2026-08-16"}); delete r.series; return r})()`);
  const X = [4, 6, 0, 0, 9, 5, 7, 8, 2, 6, 12, 3, 5];                  // 08-07 missing is not there
  check('counts: 11 days sold, 2 confirmed zero, 1 missing', pi.counts.sold === 11 && pi.counts.zero === 2 && pi.counts.missing === 1, JSON.stringify(pi.counts));
  check('average = total / observed days (missing out, zeros in)', Math.abs(pi.avg - X.reduce((a, b) => a + b, 0) / X.length) < 1e-9 && pi.observed === 13, JSON.stringify([pi.avg, pi.observed]));
  check('best day 14/8 (12), worst day a confirmed zero', pi.best.date === '2026-08-14' && pi.best.qty === 12 && pi.worst.qty === 0, JSON.stringify([pi.best, pi.worst]));
  check('last 7 data days end at the last observed day (16/8): 10–16/8, avg 43/7', pi.last7.to === '2026-08-16' && pi.last7.observed === 7 && Math.abs(pi.last7.avg - 43 / 7) < 1e-9, JSON.stringify(pi.last7));
  const w = (() => { let ws = 0, wq = 0; const days = ['03', '04', '05', '06', '08', '09', '10', '11', '12', '13', '14', '15', '16']; days.forEach((d, i) => { const age = 16 - +d; const ww = Math.pow(0.5, age / 14); ws += ww; wq += ww * X[i]; }); return wq / ws; })();
  check('recency-weighted average (half-life 14 days) matches an independent calculation', Math.abs(pi.weightedAvg - w) < 1e-9, JSON.stringify([pi.weightedAvg, w]));
  check('weekday averages carry the confirmed zeros (Wednesday 5/8 = 0, 12/8 = 2 → 1)', Math.abs(pi.weekday.avg[3] - 1) < 1e-9, JSON.stringify(pi.weekday.avg));
  const bi = await ev(`(function(){var b=branchInsight({from:"2026-08-03",to:"2026-08-16"}); return {counted:b.counted, covered:b.covered, rec:b.recordedOnly, avg:b.dailyAvg, days:b.series.map(function(x){return x.date})}})()`);
  check('branch: 13 counted days (08-07 missing left out), 12 covered, 1 recorded', bi.counted === 13 && bi.covered === 12 && bi.rec === 1 && bi.days.indexOf('2026-08-07') < 0, JSON.stringify(bi));

  console.log('\n--- Phase 3/8: traces explain, never change, the numbers ---');
  const ft = await ev(`(function(){var p=S.products[0], d=parseYmd("2026-08-21"); var t=forecastTrace(p,d); return {t:t, f:forecast(p,d)}})()`);
  check('forecastTrace.forecast is forecast() exactly', ft.t.forecast === ft.f && ft.f > 0, JSON.stringify([ft.t.forecast, ft.f]));
  check('drivers name the weekday and payday factors and say they are assumed/mixed', ft.t.drivers.some(d => d.key === 'weekday') && ft.t.drivers.some(d => d.key === 'payday' && d.source === 'assumed'), JSON.stringify(ft.t.drivers));
  check('fallback is stated (default weekday pattern below 14 days)', ft.t.fallback === 'default-weekday-pattern', ft.t.fallback);
  const nh = await ev(`(function(){ S.products.push({id:"Z",name:"صنف جديد",shelfLife:3,active:true,unit:"حبة",aliases:[]}); relearn(); var t=forecastTrace(S.products[2],parseYmd("2026-08-21")); S.products.pop(); relearn(); return t })()`);
  check('a product with no history: forecast 0, fallback no-history (nothing fabricated)', nh.forecast === 0 && nh.fallback === 'no-history', JSON.stringify(nh));
  const ot = await ev(`(function(){var p=S.products[0], d=parseYmd("2026-08-19"); var t=orderTrace(p,d), pl=planFor(p,d); return {t:t, s:pl.suggested, e:pl.expected}})()`);
  check('orderTrace.recommended = planFor().suggested; expected kept apart', ot.t.recommended === ot.s && Math.abs(ot.t.expected - ot.e) < 1e-12, JSON.stringify([ot.t.recommended, ot.s]));
  check('no stock source: available is null (unknown), never an invented 0', ot.t.available === null && ot.t.availableSource === 'none', JSON.stringify([ot.t.available, ot.t.availableSource]));
  check('the explanation is plain text', typeof ot.t.explanation === 'string' && ot.t.explanation.indexOf('<') < 0 && ot.t.explanation.length > 20);

  console.log('\n--- Phase 6/7: components, offers, one coffee for two drinks ---');
  // a test catalogue (synthetic): cores, sauce, coffee, ice; Cinnabon recipe, Black & Iced Black → the same coffee, two offers
  const cd = await ev(`(function(){
    var brand=curBrandKey();
    S.products=S.products.concat([
      {id:"C1",name:"سينابون كبير",shelfLife:3,active:true,unit:"حبة",aliases:[]},{id:"K1",name:"بلاك كوفي",shelfLife:1,active:true,unit:"كوب",aliases:[]},
      {id:"K2",name:"ايس بلاك كوفي",shelfLife:1,active:true,unit:"كوب",aliases:[]},{id:"B1",name:"عرض اللمة",shelfLife:1,active:true,unit:"عرض",aliases:[]},
      {id:"B2",name:"بوكس التيلا",shelfLife:1,active:true,unit:"بوكس",aliases:[]}]);
    var P=function(id){return S.products.filter(function(x){return x.id===id})[0]}, K=function(id){return productKey(P(id))};
    var links={}, recipes={}, bundles={};
    links[K("K1")]={item:"coffee",factor:18}; links[K("K2")]={item:"coffee",factor:18};
    recipes[K("C1")]={lines:[{item:"core",qty:1},{item:"sauce",qty:40}]}; recipes[K("K2")]={lines:[{item:"ice",qty:1}]};
    bundles[K("B1")]={lines:[{kind:"p",ref:K("C1"),qty:2},{kind:"p",ref:K("K1"),qty:1}]};
    bundles[K("B2")]={lines:[{kind:"p",ref:K("C1"),qty:1},{kind:"p",ref:K("K2"),qty:1}]};
    S.cat=sanitizeCatalog({items:[{id:"core",name:"كور سينابون",unit:"قطعة"},{id:"sauce",name:"صوص",unit:"جم"},{id:"coffee",name:"قهوة",unit:"جم"},{id:"ice",name:"بوكس ثلج",unit:"قطعة"}],
      links:links, recipes:recipes, bundles:bundles},brand);
    S.catBrand=brand;
    var plan=function(id,e,t){return {p:P(id), plan:{expected:e, target:t}}};
    var a=componentDemand([plan("C1",10,12),plan("B1",5,6)]);
    var b=componentDemand([plan("K1",7,7),plan("K2",4,4)]);
    var c=componentDemand([plan("B2",3,3)]);
    var pick=function(r,n){var x=r.rows.filter(function(z){return z.item===n})[0];return x?{e:x.expected,r:x.required,a:x.available,s:x.shortage}:null};
    return {core:pick(a,"كور سينابون"), sauce:pick(a,"صوص"), coffeeA:pick(a,"قهوة"), coffeeB:pick(b,"قهوة"), ice:pick(b,"بوكس ثلج"), boxCore:pick(c,"كور سينابون"), boxCoffee:pick(c,"قهوة"), boxIce:pick(c,"بوكس ثلج")};
  })()`);
  check('10 Cinnabon Large + 5 «عرض اللمة» (2 large each) = 20 cores expected, 24 required (targets 12 + 6×2)', cd.core && cd.core.e === 20 && cd.core.r === 24, JSON.stringify(cd.core));
  check('…sauce 40 g a piece = 800 g expected', cd.sauce && cd.sauce.e === 800, JSON.stringify(cd.sauce));
  check('…the offer\'s coffee: 5 × 18 g = 90 g', cd.coffeeA && cd.coffeeA.e === 90, JSON.stringify(cd.coffeeA));
  check('Black Coffee and Iced Black Coffee are one coffee component: (7 + 4) × 18 g = 198 g', cd.coffeeB && cd.coffeeB.e === 198, JSON.stringify(cd.coffeeB));
  check('…and only the iced one takes an ice box (4)', cd.ice && cd.ice.e === 4, JSON.stringify(cd.ice));
  check('Box Al Tella × 3 = 3 cores + 54 g coffee + 3 ice boxes', cd.boxCore && cd.boxCore.e === 3 && cd.boxCoffee.e === 54 && cd.boxIce.e === 3, JSON.stringify([cd.boxCore, cd.boxCoffee, cd.boxIce]));
  check('available and shortage stay null without a stock source (never invented)', cd.core.a === null && cd.core.s === null);

  console.log('\n--- offers → their products in the order (OFFER_DEMAND, off by default) ---');
  // synthetic sales for the Cinnabon, Black Coffee and the two offers on the covered days, so each has a forecast
  const od = await ev(`(function(){
    var k=Object.keys(S.days).filter(function(x){return dayKind(x)==="covered"});
    k.forEach(function(x,i){ var it=S.days[x].items; it.C1={sold:3+i%3,waste:0,stockout:false}; it.B1={sold:1+i%2,waste:0,stockout:false}; it.B2={sold:i%2,waste:0,stockout:false}; it.K1={sold:2,waste:0,stockout:false} });
    relearn();
    var P=function(id){return S.products.filter(function(x){return x.id===id})[0]}, d=parseYmd("2026-08-19");
    var act=function(){return S.products.filter(function(p){return p.active!==false})};
    OFFER_DEMAND.on=false;
    var off=planFor(P("C1"),d), offOrdered=orderedProducts().map(function(p){return p.id}), k1Off=planFor(P("K1"),d);
    var matOff=componentDemand(act().map(function(p){return {p:p,plan:planFor(p,d)}}));
    OFFER_DEMAND.on=true;
    var on=planFor(P("C1"),d), onOrdered=orderedProducts().map(function(p){return p.id}), k1On=planFor(P("K1"),d);
    var w=coverageWindow(d), extra=0, k1Extra=0;
    w.days.forEach(function(x,i){ extra+=(2*forecast(P("B1"),x)+1*forecast(P("B2"),x))*w.weights[i]; k1Extra+=forecast(P("B1"),x)*w.weights[i] });
    var matOn=componentDemand(materialPlans(act(),d));
    OFFER_DEMAND.on=false;
    var back=planFor(P("C1"),d);
    return {offS:off.suggested, offE:off.expected, offX:off.offerExpected, onE:on.expected, onX:on.offerExpected, extra:extra,
            offOrdered:offOrdered, onOrdered:onOrdered, matSame:JSON.stringify(matOff.rows)===JSON.stringify(matOn.rows), backS:back.suggested, backE:back.expected,
            k1:k1On.expected-k1Off.expected, k1Extra:k1Extra, offers:Object.keys(offerMap().offers).sort(), map:offerMap().map.C1};
  })()`);
  check('off (the default): no offer demand, the offer is ordered as before', od.offX === 0 && od.offOrdered.indexOf('B1') >= 0, JSON.stringify(od));
  check('the offers are found from the catalogue: عرض اللمة and بوكس التيلا', JSON.stringify(od.offers) === '["B1","B2"]', JSON.stringify(od.offers));
  check('Cinnabon Large sits in both: 2 per عرض اللمة, 1 per بوكس التيلا', JSON.stringify(od.map) === JSON.stringify([{ offer: 'B1', qty: 2 }, { offer: 'B2', qty: 1 }]), JSON.stringify(od.map));
  check('on: Cinnabon expected = its own + 2 × عرض اللمة + 1 × بوكس التيلا over the window', Math.abs(od.onE - od.offE - od.extra) < 1e-9 && Math.abs(od.onX - od.extra) < 1e-9 && od.extra > 0, JSON.stringify([od.onE, od.offE, od.extra]));
  check('on: Black Coffee gets 1 per عرض اللمة', Math.abs(od.k1 - od.k1Extra) < 1e-9 && od.k1Extra > 0, JSON.stringify([od.k1, od.k1Extra]));
  check('on: the offers are no longer ordered as products; their products are', od.onOrdered.indexOf('B1') < 0 && od.onOrdered.indexOf('B2') < 0 && od.onOrdered.indexOf('C1') >= 0, JSON.stringify(od.onOrdered));
  check('on: the materials are unchanged (each offer broken down once, not twice)', od.matSame === true);
  check('switched back off: exactly the same numbers as before', od.backS === od.offS && Math.abs(od.backE - od.offE) < 1e-12, JSON.stringify([od.backS, od.offS]));
  check('OFFER_DEMAND ships off', await ev('OFFER_DEMAND.on===false'));

  console.log('\n--- Phase 9: occasions — assumed vs measured ---');
  const ei = await ev(`(function(){ S.events=[{id:"e",name:"مناسبة اختبار",kind:"national",from:"2026-08-14",to:"2026-08-14",mult:1.45}]; relearn(); var r=eventInsight(); S.events=[]; relearn(); return r })()`);
  check('an occasion\'s factor is labelled «assumed» (typed by the shop)', ei.length === 1 && ei[0].source === 'assumed' && ei[0].factor === 1.45, JSON.stringify(ei));

  console.log('\n--- Phase 10/11: AI context and validation ---');
  const ctx = await ev('aiContext()');
  check('the AI context carries the products, their traces and the semantics', ctx && ctx.products.length >= 2 && ctx.products[0].next7Days.length === 7 && !!ctx.semantics.missing, JSON.stringify(Object.keys(ctx || {})));
  check('…with no raw series (only calculated results)', JSON.stringify(ctx).indexOf('"series"') < 0);
  const v1 = await ev(`aiValidate("متوسّط صنف إكس "+(Math.round(productInsight(S.products[0],null).avg*10)/10)+" قطعة", aiContext(), "")`);
  check('a number from the context (rounded as written) passes', v1.ok, JSON.stringify(v1));
  const v2 = await ev(`aiValidate("سيبيع صنف إكس 4321 قطعة غداً", aiContext(), "")`);
  check('an invented number is caught and listed', !v2.ok && v2.unknown.indexOf('4321') >= 0, JSON.stringify(v2));
  const v3 = await ev(`aiValidate("الجمعة أعلى بـ ٦٨٪", {f:1.68}, "")`);
  check('a factor written as a percentage (×1.68 → 68٪, Arabic digits) passes', v3.ok, JSON.stringify(v3));
  await cdp.evaluate('S.demo=true; 1');
  check('no AI context in the demo (sample data is never sent)', (await ev('aiContext()')) === null);
  await cdp.evaluate('S.demo=false; 1');

  await cdp.evaluate('(function(){ var k=window.__keep; S.days=k.days; S.imports=k.imports; S.events=k.events; S.products=k.products; S.cat=k.cat; S.catBrand=k.catBrand; relearn(); return 1 })()');
  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
