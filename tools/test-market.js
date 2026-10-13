'use strict';
/*
 * The Saudi market layer on synthetic data (a throwaway profile):
 *   Umm al-Qura dates from the engine; the calendar rules (fixed, Hijri, seasonal, retail; «needs confirmation» without dates);
 *   no invented impact; observed impact from confirmed days only (missing never zero, past only with before);
 *   the enhanced forecast off, shrunk, never on the shop's own occasion or a baseline factor; neutral calendar → occasions;
 *   offers: normalized demand (10 + 8×2 = 26), offer sales kept, multi-level to components; the AI context; the screens.
 *
 *   node tools/test-market.js            (dev build)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'daftar-market-'));
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

// SYNTHETIC test data only — in memory, in a throwaway profile; never saved to a real branch or the cloud.
(async () => {
  killOrphans();
  process.on('exit', killOrphans);
  console.log('Saudi market layer test, profile ' + PROFILE + '\n');
  const proc = launch();
  const cdp = await connect((await target()).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, 'window.S && window.S.ready', 'the app to boot');
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} 1');   // checks answer the system box
  await cdp.evaluate('orderFoldsSet({mto:true,mat:true,needs:true,market:true,how:true}); 1');
  await cdp.evaluate('document.getElementById("adopt").click()');
  await waitFor(cdp, 'window.S.demo === false', 'the sample catalogue');
  const ev = async (x) => JSON.parse(await cdp.evaluate('(async function(){ return JSON.stringify(await (' + x + ')) })()'));

  console.log('--- Umm al-Qura (the engine\'s own calendar, offline) ---');
  const h = await ev(`["2026-02-17","2026-02-18","2026-03-20","2026-05-26","2026-05-27","2026-10-07"].map(function(k){return hijriOf(parseYmd(k))})`);
  check('17 Feb 2026 = 29 Sha\'ban 1447, 18 Feb 2026 = 1 Ramadan 1447', h[0].m === 8 && h[0].d === 29 && h[1].y === 1447 && h[1].m === 9 && h[1].d === 1, JSON.stringify(h.slice(0, 2)));
  check('20 Mar 2026 = 1 Shawwal 1447 (Eid al-Fitr)', h[2].m === 10 && h[2].d === 1, JSON.stringify(h[2]));
  check('26 May 2026 = 9 Dhu al-Hijjah (Arafah), 27 May = 10 (Eid al-Adha)', h[3].m === 12 && h[3].d === 9 && h[4].m === 12 && h[4].d === 10, JSON.stringify(h.slice(3, 5)));
  check('7 Oct 2026 = 26 Rabi\' al-Akhir 1448, and the label is Arabic', h[5].y === 1448 && h[5].m === 4 && h[5].d === 26 && (await ev('hijriLabel(parseYmd("2026-10-07"))')) === '26 ربيع الآخر 1448');

  console.log('\n--- the calendar: generic rules, no invented impact ---');
  const me = await ev(`marketEvents("2026-01-01","2026-12-31").map(function(e){return [e.rule,e.start,e.end,e.expected]})`);
  const find = (r) => me.filter(x => x[0] === r);
  check('Ramadan 1447: 18 Feb → 19 Mar 2026 (the whole Hijri month)', JSON.stringify(find('ramadan')[0]) === JSON.stringify(['ramadan', '2026-02-18', '2026-03-19', null]), JSON.stringify(find('ramadan')));
  check('Eid al-Fitr 20–22 Mar, Eid al-Adha 27–30 May, Hajj 25–30 May', find('eid_fitr')[0][1] === '2026-03-20' && find('eid_adha')[0][1] === '2026-05-27' && find('eid_adha')[0][2] === '2026-05-30' && find('hajj')[0][1] === '2026-05-25', JSON.stringify([find('eid_fitr'), find('eid_adha'), find('hajj')]));
  check('fixed dates: Founding Day 22 Feb, Flag Day 11 Mar, National Day 23 Sep', find('founding')[0][1] === '2026-02-22' && find('flag')[0][1] === '2026-03-11' && find('national')[0][1] === '2026-09-23');
  check('White Friday 2026 = 27 Nov (the Friday after the 4th Thursday)', find('white_friday')[0][1] === '2026-11-27', JSON.stringify(find('white_friday')));
  check('no event carries an impact (expected = null everywhere)', me.every(x => x[3] === null));
  const needs = await ev(`MARKET_RULES.filter(function(r){return r.needs}).map(function(r){return r.id})`);
  check('school calendar, vacations, exams, graduation, Umrah, travel: listed «needs confirmation», with no dates', needs.length >= 6 && me.every(x => needs.indexOf(x[0]) < 0), JSON.stringify(needs));
  check('the 1448 Ramadan comes from the same calendar (8 Feb 2027)', (await ev(`marketEvents("2027-01-01","2027-03-31").filter(function(e){return e.rule==="ramadan"})[0].start`)) === '2027-02-08');

  console.log('\n--- observed impact: confirmed days only, missing never zero ---');
  // 28 days from Mon 2026-06-01: every day 10, an "occasion" on 15–17 Jun (Mon–Wed) at 15; 16 Jun missing (no file); one confirmed-zero product
  await cdp.evaluate(`(function(){
    window.__keep={days:S.days, imports:S.imports, events:S.events, products:S.products, cat:S.cat, catBrand:S.catBrand};
    S.products=[{id:"A",name:"صنف أ",shelfLife:3,active:true,unit:"حبة",aliases:[]},{id:"Z",name:"صنف صفر",shelfLife:3,active:true,unit:"حبة",aliases:[]}];
    S.days={}; S.imports=[]; S.events=[];
    for(var i=0;i<28;i++){ var k=ymd(addDays(parseYmd("2026-06-01"),i)); if(k==="2026-06-16") continue;
      var q=(k>="2026-06-15"&&k<="2026-06-17")?15:10; S.days[k]={date:k,items:{A:{sold:q,waste:0,stockout:false},Z:{sold:0,waste:0,stockout:false}}};
      S.imports.push({id:"i"+k,from:k,to:k,complete:true,mode:"replace",hash:""}) }
    relearn(); return 1 })()`);
  const ml = await ev(`measureLift(function(d,k){ k=k||ymd(d); return k>="2026-06-15"&&k<="2026-06-17" })`);
  check('the occasion days measure +50% (15 vs 10), from 2 confirmed days', Math.abs(ml.lift - 1.5) < 1e-9 && ml.inDays === 2, JSON.stringify(ml));
  check('the missing day (16 Jun, no file) is counted as missing, not as a zero', ml.missingIn === 1, JSON.stringify(ml));
  check('two days are not enough: «insufficient» (البيانات غير كافية للحكم)', ml.conf === 'insufficient' && (await ev('CONF_AR.insufficient')) === 'البيانات غير كافية للحكم');
  const mlB = await ev(`measureLift(function(d,k){ k=k||ymd(d); return k>="2026-06-15"&&k<="2026-06-17" }, "2026-06-16")`);
  check('measured with `before`: only days before it count (15 Jun only)', mlB.inDays === 1, JSON.stringify(mlB));

  console.log('\n--- the enhanced forecast stays off and never touches forecast() ---');
  await cdp.evaluate(`(function(){ var k=ymd(addDays(today(),1)); window.__tmr=k; return 1 })()`);
  const f0 = await ev(`(function(){ var p=S.products[0], d=addDays(today(),1); return {f:forecast(p,d), b:forecastBase(p,d), on:MARKET.on} })()`);
  check('MARKET.on ships false and forecast() is the current forecast exactly', f0.on === false && f0.f === f0.b, JSON.stringify(f0));
  // a proven effect: give "national" 8 confirmed days in the past at ×1.6 (a synthetic test, not a claim about National Day)
  const mm = await ev(`(function(){
    var F=marketFactors(); var nat=F.filter(function(f){return f.id==="national"})[0];
    nat.observed={lift:1.6,inDays:8,outDays:20,missingIn:0,conf:"medium"};
    var d=parseYmd("2026-09-23"), a=marketMultiplier(d,null,F);
    S.events=[{id:"own",name:"مناسبتي",kind:"national",from:"2026-09-23",to:"2026-09-23",mult:1}];
    var b=marketMultiplier(d,null,F); S.events=[];
    var wk=F.filter(function(f){return f.id==="weekend"})[0]; wk.observed={lift:2,inDays:20,outDays:20,missingIn:0,conf:"good"};
    var c=marketMultiplier(parseYmd("2026-09-25"),null,F);
    return {a:a, b:b, c:c, expect:1+0.6*8/15} })()`);
  check('a proven effect is shrunk by its sample (1 + 0.6 × 8/15)', Math.abs(mm.a.m - mm.expect) < 1e-9 && mm.a.used.length === 1, JSON.stringify(mm.a));
  check('…and never applied on a day the shop\'s own occasion already covers', mm.b.m === 1, JSON.stringify(mm.b));
  check('…and never for a factor the baseline already prices (weekend, payday)', mm.c.m === 1, JSON.stringify(mm.c));

  console.log('\n--- the day as the manager sees it ---');
  const md = await ev(`marketDay(parseYmd("2026-09-23"))`);
  check('Hijri date, periods, the calendar event marked «no proven effect»', !!md.hijri && md.events.some(e => e.name === 'اليوم الوطني' && e.status === 'no-proven-effect'), JSON.stringify(md.events));
  check('the why says the calendar event does not enter the forecast', md.why.some(w => /لا أثر مثبت/.test(w)), JSON.stringify(md.why));

  console.log('\n--- adding a calendar entry to the shop\'s occasions: neutral ---');
  await cdp.evaluate('S.tab="calendar"; render(); 1');
  await waitFor(cdp, 'document.querySelector(".mktAdd")', 'the calendar reference');
  const before = await ev(`forecast(S.products[0],addDays(today(),1))`);
  await cdp.evaluate('document.querySelector(".mktAdd").click(); 1');
  await waitFor(cdp, 'S.events.length===1', 'the occasion');
  const added = await ev('S.events[0]');
  check('copied with factor 1 and a reference to the calendar entry', added.mult === 1 && /^[a-z_]+:\d{4}-\d{2}-\d{2}$/.test(added.ref), JSON.stringify(added));
  check('factor 1 changes no forecast', (await ev(`forecast(S.products[0],addDays(today(),1))`)) === before);
  check('the reference survives the record check (sanitizeRecord)', await ev(`sanitizeRecord(JSON.parse(JSON.stringify(payload()))).events[0].ref===${J(added.ref)}`));
  await cdp.evaluate('S.events=[]; relearn(); 1');

  console.log('\n--- offers in the record: normalized demand, no double count ---');
  const nd = await ev(`(function(){
    var brand=curBrandKey();
    S.products=[{id:"C1",name:"سينابون كبير",shelfLife:3,active:true,unit:"حبة",aliases:[]},{id:"K1",name:"قهوة",shelfLife:1,active:true,unit:"كوب",aliases:[]},
                {id:"B1",name:"عرض اللمة",shelfLife:1,active:true,unit:"عرض",aliases:[]}];
    var K=function(id){return productKey(S.products.filter(function(x){return x.id===id})[0])}, bundles={}, recipes={};
    bundles[K("B1")]={lines:[{kind:"p",ref:K("C1"),qty:2},{kind:"p",ref:K("K1"),qty:1}]};
    recipes[K("C1")]={lines:[{item:"core",qty:1},{item:"sauce",qty:2}]};
    S.cat=sanitizeCatalog({items:[{id:"core",name:"كور",unit:"قطعة"},{id:"sauce",name:"صوص",unit:"قطعة"}],bundles:bundles,recipes:recipes},brand); S.catBrand=brand;
    S.days={"2026-06-01":{date:"2026-06-01",items:{C1:{sold:10,waste:0,stockout:false},K1:{sold:6,waste:0,stockout:false},B1:{sold:8,waste:0,stockout:false}}},
            "2026-06-02":{date:"2026-06-02",items:{B1:{sold:8,waste:0,stockout:false}}}};
    S.imports=[{id:"x1",from:"2026-06-01",to:"2026-06-01",complete:true,mode:"replace",hash:""},{id:"x2",from:"2026-06-02",to:"2026-06-02",complete:true,mode:"replace",hash:""}];
    relearn();
    var c=normalizedInsight(S.products[0],{from:"2026-06-01",to:"2026-06-01"}), k=normalizedInsight(S.products[1],{from:"2026-06-01",to:"2026-06-01"});
    var o=offerInsight({from:"2026-06-01",to:"2026-06-01"});
    var acc=opDay(opCtx(S.cat,S.branchId),S.days["2026-06-02"]);
    return {c:c, k:k, o:o, core:acc.items.core, sauce:acc.items.sauce} })()`);
  check('Cinnabon Large: 10 + 8 × 2 = 26', nd.c.own === 10 && nd.c.fromOffers === 16 && nd.c.normalized === 26, JSON.stringify(nd.c));
  check('Coffee: 6 + 8 × 1 = 14', nd.k.normalized === 14, JSON.stringify(nd.k));
  check('the offer\'s own sales are kept for offer analysis (8), with its contents', nd.o.length === 1 && nd.o[0].total === 8 && nd.o[0].contents.length === 2, JSON.stringify(nd.o));
  check('multi-level: عرض اللمة × 8 → Cinnabon × 16 → core × 16, sauce × 32', nd.core === 16 && nd.sauce === 32, JSON.stringify([nd.core, nd.sauce]));

  console.log('\n--- the AI context carries the market, the offers and data sufficiency ---');
  const ctx = await ev('aiContext()');
  check('market: Hijri today, next 14 days, factors with assumed/observed', ctx.market && !!ctx.market.todayHijri && ctx.market.next14Days.length === 14 && ctx.market.factors.every(f => f.assumption === 'غير محدّد'), JSON.stringify(Object.keys(ctx.market || {})));
  check('offers, normalized demand and data sufficiency are there', ctx.offers.length === 1 && ctx.normalizedDemand.length === 2 && !!ctx.dataSufficiency.similarDays, JSON.stringify([ctx.offers.length, ctx.normalizedDemand.length]));
  const v = await ev(`aiValidate("اليوم "+hijriOf(today()).d+" "+HIJRI_MONTHS[hijriOf(today()).m-1], aiContext(), "")`);
  check('a Hijri day number from the context passes the number check', v.ok, JSON.stringify(v));

  console.log('\n--- the screens render ---');
  for (const tab of ['order', 'stats', 'setup']) {
    await cdp.evaluate(`S.tab=${J(tab)}; render(); 1`);
    await sleep(200);
  }
  await cdp.evaluate('(function(){ var k=window.__keep; S.days=k.days; S.imports=k.imports; S.events=k.events; S.products=k.products; S.cat=k.cat; S.catBrand=k.catBrand; relearn(); S.tab="order"; render(); return 1 })()');
  await sleep(300);
  check('the order screen shows the market calendar (14 days)', await ev('document.querySelectorAll("#mktCalTable tbody tr").length===14'));
  await cdp.evaluate('S.tab="stats"; render(); 1'); await sleep(300);
  check('the analysis screen shows the market factors', await ev('!!document.getElementById("mktFactorTable")'));

  console.log('\n--- «السوق والدولة»: Saudi Arabia exactly as before; other markets their own weekend, salary days and calendar ---');
  const SA0 = await ev(`(function(){ var plist=S.products.filter(function(p){return p.active!==false}); var f=[]; for(var i=0;i<21;i++){ var d=addDays(today(),i), t=0; plist.forEach(function(p){ t+=forecast(p,d) }); f.push(Math.round(t*1e6)/1e6) }
    return {code:marketCode(), dow:DEFAULT_DOW.slice(), sameCurve:PAY_CURVE===PAY_SA, payFirst:PAY_CURVE[0], f:f, rules:MARKET_RULES.filter(function(r){return SA_RULES.indexOf(r)>=0}).length, sa:SA_RULES.length, periods:MARKET_PERIODS===SA_PERIODS} })()`);
  check('Saudi Arabia is the default, with the original weekday pattern, salary curve, periods and every original rule',
    SA0.code === 'SA' && J(SA0.dow) === J([0.80,0.76,0.80,0.95,1.38,1.33,0.98]) && SA0.sameCurve && SA0.rules === SA0.sa && SA0.periods, J(SA0));
  const AE = await ev(`(function(){ S.cfg.market="AE"; relearn(); var plist=S.products.filter(function(p){return p.active!==false}); var f=[]; for(var i=0;i<21;i++){ var d=addDays(today(),i), t=0; plist.forEach(function(p){ t+=forecast(p,d) }); f.push(Math.round(t*1e6)/1e6) }
    var wk=MARKET_PERIODS.filter(function(p){return p.id==="weekend"})[0], y=today().getFullYear();
    var ev=marketEvents(y+"-01-01",(y+1)+"-12-31"), ids=ev.map(function(e){return e.rule});
    return {code:marketCode(), sat:wk.test(new Date(y,0,3+((6-new Date(y,0,3).getDay()+7)%7))), fri:wk.test(new Date(y,0,1+((5-new Date(y,0,1).getDay()+7)%7))), nat:ids.indexOf("ae_national")>=0, founding:ids.indexOf("founding")>=0, fitr:ids.indexOf("x_fitr")>=0, f:f, dow:DEFAULT_DOW.slice(), name:wk.name} })()`);
  check('the UAE: weekend Saturday–Sunday, its National Day and the feasts, no Saudi Founding Day', AE.code === 'AE' && AE.sat && !AE.fri && AE.nat && !AE.founding && AE.fitr, J(AE));
  const EG = await ev('(function(){ S.cfg.market="EG"; relearn(); var e=marketEvents("2027-01-01","2027-12-31"), sham=e.filter(function(x){return x.rule==="eg_sham"})[0], oct=e.filter(function(x){return x.rule==="eg_oct6"})[0];' +
    ' return {sham:sham&&sham.start, oct:oct&&oct.start, pay:payFactor(new Date(2027,0,3))>payFactor(new Date(2027,0,23)), scope:sham&&sham.scope} })()');
  check('Egypt: Sham El-Nessim on the Monday after Orthodox Easter (3 May 2027), 6 October, salaries at the start of the month', EG.sham === '2027-05-03' && EG.oct === '2027-10-06' && EG.pay && EG.scope === 'محلي', J(EG));
  const GLm = await ev('(function(){ S.cfg.market="GL"; relearn(); var e=marketEvents("2026-01-01","2026-12-31").map(function(x){return x.rule+":"+x.start}); return {easter:e.indexOf("gl_easter:2026-04-05")>=0, cyber:e.indexOf("gl_cyber:2026-11-30")>=0, ramadan:e.some(function(x){return /ramadan/.test(x)})} })()');
  check('a world market: Easter (5 Apr 2026), Cyber Monday (30 Nov 2026), and no Hijri season', GLm.easter && GLm.cyber && !GLm.ramadan, J(GLm));
  const AR = await ev('(function(){ var o={}; [["MA","ma_throne","2027-07-30"],["DZ","dz_independence","2027-07-05"],["TN","tn_republic","2027-07-25"],["LY","ly_independence","2027-12-24"],["IQ","iq_national","2027-10-03"],["LB","lb_independence","2027-11-22"],["SY","sy_evacuation","2027-04-17"],["PS","ps_independence","2027-11-15"],["SD","sd_independence","2027-01-01"],["YE","ye_unity","2027-05-22"]].forEach(function(x){ S.cfg.market=x[0]; relearn(); var e=marketEvents("2027-01-01","2027-12-31"); o[x[0]]={nat:e.some(function(v){return v.rule===x[1]&&v.start===x[2]}), fitr:e.some(function(v){return v.rule==="x_fitr"}), founding:e.some(function(v){return v.rule==="founding"}), weekend:MARKET_PERIODS[0].name} });' +
    ' S.cfg.market="IQ"; relearn(); var iq=marketEvents("2027-01-01","2027-12-31"); o.ashura=iq.some(function(v){return v.rule==="ashura"});' +
    ' S.cfg.market="LB"; relearn(); var lb=marketEvents("2027-01-01","2027-12-31"); o.easters=[lb.filter(function(v){return v.rule==="lb_easter"}).map(function(v){return v.start})[0], lb.filter(function(v){return v.rule==="lb_easter_or"}).map(function(v){return v.start})[0]];' +
    ' S.cfg.market="SA"; relearn(); return o })()');
  check('the ten other Arab markets: each its national day on its date, the feasts, and no Saudi Founding Day', ['MA','DZ','TN','LY','IQ','LB','SY','PS','SD','YE'].every(function(c){ return AR[c].nat && AR[c].fitr && !AR[c].founding }), J(AR));
  check('…Iraq keeps Ashura; Lebanon both Easters (28 Mar and 2 May 2027); Morocco and Lebanon rest on Saturday–Sunday', AR.ashura && AR.easters[0] === '2027-03-28' && AR.easters[1] === '2027-05-02' && /السبت والأحد/.test(AR.MA.weekend) && /السبت والأحد/.test(AR.LB.weekend) && /الجمعة والسبت/.test(AR.IQ.weekend), J({a:AR.ashura, e:AR.easters, w:[AR.MA.weekend, AR.LB.weekend]}));
  const back = await ev(`(function(){ S.cfg.market="SA"; relearn(); var plist=S.products.filter(function(p){return p.active!==false}); var f=[]; for(var i=0;i<21;i++){ var d=addDays(today(),i), t=0; plist.forEach(function(p){ t+=forecast(p,d) }); f.push(Math.round(t*1e6)/1e6) } return {f:f, dow:DEFAULT_DOW.slice(), same:PAY_CURVE===PAY_SA} })()`);
  check('back to Saudi Arabia: every forecast is to the decimal what it was (nothing in the analysis moved)', J(back.f) === J(SA0.f) && J(back.dow) === J(SA0.dow) && back.same, J({before:SA0.f.slice(0,5), after:back.f.slice(0,5)}));
  check('…the UAE starts from its own weekday pattern (the record\'s own pattern, when long enough, still leads)', J(AE.dow) !== J(SA0.dow), J(AE.dow));
  const SAmore = await ev('(function(){ var y=today().getFullYear(); var ids=marketEvents(y+"-01-01",(y+1)+"-12-31").map(function(e){return e.rule}); return {last10:ids.indexOf("ramadan_last10")>=0, valentine:ids.indexOf("valentine")>=0, gergean:ids.indexOf("gergean")>=0, preFitr:ids.indexOf("pre_fitr")>=0} })()');
  check('Saudi Arabia gains the days a sweets shop lives by: the last ten nights, the nights before Eid, Gergean, 14 February', SAmore.last10 && SAmore.valentine && SAmore.gergean && SAmore.preFitr, J(SAmore));
  const kept = await ev('(function(){ S.cfg.market="KW"; var r=sanitizeRecord({products:[],cfg:S.cfg}); S.cfg.market="SA"; relearn(); return r.cfg.market })()');
  check('the market is kept with the branch', kept === 'KW', kept);
  // the settings and the calendar on screen
  await cdp.evaluate('try{localStorage.setItem("talabia.nativeConfirm","1")}catch(e){} window.confirm=function(){return true}; PANES={setup:"market"}; S.tab="setup"; render(); 1'); await sleep(250);
  check('«السوق والدولة» in the settings: nineteen markets (every Arab country and a world market), Saudi Arabia chosen', await ev('document.querySelectorAll(".mkCard").length===19 && document.querySelector(".mkCard.on").dataset.mk==="SA"'));
  await cdp.evaluate('document.querySelector(\'.mkCard[data-mk="EG"]\').click(); 1'); await sleep(250);
  check('…a press changes the branch\'s market', await ev('S.cfg.market==="EG" && marketCode()==="EG" && document.querySelector(".mkCard.on").dataset.mk==="EG"'));
  await cdp.evaluate('document.querySelector(\'.mkCard[data-mk="SA"]\').click(); 1'); await sleep(250);
  await cdp.evaluate('try{localStorage.removeItem("talabia.calDate.v1")}catch(e){} S.tab="calendar"; render(); 1'); await sleep(250);
  const cal = await ev('(function(){ var r=document.querySelector("#mktCalTable tbody tr"), d=parseYmd(r.dataset.day); return {day:r.cells[0].textContent, date:r.cells[1].textContent, wantDay:DOW_AR[d.getDay()], wantDate:gregLabel(d), head:document.querySelectorAll("#mktCalTable th")[1].textContent} })()');
  check('the calendar: «اليوم» is the day\'s name only, the date is Gregorian («10 أكتوبر 2026»)', cal.day === cal.wantDay && cal.date === cal.wantDate && /^\d{1,2} \S+ \d{4}$/.test(cal.date) && cal.head === 'التاريخ', J(cal));
  await cdp.evaluate('document.querySelector(\'#mktCal ~ .iseg .calDate[data-cd="h"], .calDate[data-cd="h"]\').click(); 1'); await sleep(200);
  check('…a switch shows the Hijri date instead', await ev('(function(){ var r=document.querySelector("#mktCalTable tbody tr"); return r.cells[1].textContent===hijriLabel(parseYmd(r.dataset.day)) })()'));
  await cdp.evaluate('document.querySelector(\'.calDate[data-cd="b"]\').click(); 1'); await sleep(200);
  check('…or both', await ev('(function(){ var r=document.querySelector("#mktCalTable tbody tr"), d=parseYmd(r.dataset.day); return r.cells[1].textContent.indexOf(gregLabel(d))===0 && r.cells[1].textContent.indexOf(hijriLabel(d))>0 })()'));
  await cdp.evaluate('try{localStorage.removeItem("talabia.calDate.v1")}catch(e){} 1');
  cdp.close(); proc.kill(); await sleep(800);
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows file locks */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
