/* The print window: the real sheet (laid out exactly as it will print) beside every printing option — the app's own. */
(function(){
  var P = window.printer, DOC = null, BUSY = false, SEQ = 0, TIMER = null;
  var $ = function(id){ return document.getElementById(id) };
  var EN = false, AR = {};
  /** Arabic or English, right-to-left or left-to-right — as the app is. */
  function applyLang(en){
    EN = !!en; document.documentElement.lang = EN ? 'en' : 'ar'; document.documentElement.dir = EN ? 'ltr' : 'rtl';
    Array.prototype.forEach.call(document.querySelectorAll('[data-en]'), function(el, i){ if(!el.dataset.ar) el.dataset.ar = el.textContent; el.textContent = EN ? el.dataset.en : el.dataset.ar });
    Array.prototype.forEach.call(document.querySelectorAll('[data-en-title]'), function(el){ if(!el.dataset.arTitle) el.dataset.arTitle = el.title; el.title = EN ? el.dataset.enTitle : el.dataset.arTitle });
    Array.prototype.forEach.call(document.querySelectorAll('[data-en-ph]'), function(el){ if(!el.dataset.arPh) el.dataset.arPh = el.placeholder; el.placeholder = EN ? el.dataset.enPh : el.dataset.arPh });
  }
  var T = { pick:['اختر طابعة، أو أضف واحدة','Choose a printer, or add one'], range:['اكتب الصفحات هكذا: 1-2، 4','Write the pages like this: 1-2, 4'], sending:['جارٍ الإرسال للطابعة…','Sending to the printer…'],
    sent:['أُرسلت للطابعة ✓','Sent to the printer ✓'], fail:['تعذّرت الطباعة','Could not print'], pfail:['تعذّرت المعاينة','Could not preview'], none:['لا طابعة مثبّتة — اضغط «إضافة طابعة»','No printer installed — press «Add a printer»'],
    dflt:[' (الافتراضية)',' (default)'], edgeOpen:['جارٍ فتح نافذة الطباعة في Edge…','Opening the print window in Edge…'], edge:['فُتحت في Edge — اختر الطابعة والإعدادات من نافذته، ومعاينتها كاملة','Opened in Edge — choose the printer and settings there, with a full preview'],
    browser:['فُتحت في المتصفّح — نافذة الطباعة فيه بمعاينة كاملة','Opened in the browser — its print window has a full preview'], ofail:['تعذّر الفتح','Could not open'], port:['عمودي','Portrait'], land:['أفقي','Landscape'] };
  function tr(k){ return T[k][EN ? 1 : 0] }
  function say(t){ $('status').textContent = t || '' }
  /** "1-2, 4" → [{from:0,to:1},{from:3,to:3}] (zero-based), or null when it does not read. */
  function ranges(txt){
    var out = [], ok = true;
    String(txt || '').replace(/[٠-٩]/g, function(c){ return '٠١٢٣٤٥٦٧٨٩'.indexOf(c) }).split(/[,،\s]+/).filter(Boolean).forEach(function(part){
      var m = part.match(/^(\d+)(?:-(\d+))?$/); if(!m){ ok = false; return }
      var a = +m[1], b = m[2] ? +m[2] : a; if(a < 1 || b < a){ ok = false; return }
      out.push({ from: a - 1, to: b - 1 });
    });
    return ok && out.length ? out : null;
  }
  function opts(){
    var some = $('pages').value === 'some', R = some ? ranges($('range').value) : null;
    return {
      deviceName: $('printer').value, copies: Math.max(1, Math.min(99, Math.round(+$('copies').value || 1))), collate: $('collate').checked,
      landscape: $('orient').value === 'l', pageSize: $('paper').value, color: $('color').value === 'c', marginType: $('margins').value,
      scale: +$('scale').value || 100, duplexMode: $('duplex').value, pagesPerSheet: +$('pps').value || 1, printBackground: $('bg').checked,
      pageRanges: R, badRange: some && !R
    };
  }
  /** Lay the sheet out again with the options that change it (paper, orientation, margins, size, pages) — the latest wins. */
  function render(){
    if(!DOC) return;
    clearTimeout(TIMER);
    TIMER = setTimeout(function(){
      var o = opts(), my = ++SEQ;
      if(o.badRange){ say(tr('range')); return }
      say(''); $('sheet').classList.add('busy'); document.querySelector('.sheetW').classList.toggle('land', o.landscape);
      P.render(DOC.html, o).then(function(r){
        if(my !== SEQ) return;
        $('sheet').classList.remove('busy');
        if(r && r.ok){ $('doc').src = r.url + '#toolbar=0&navpanes=0&view=Fit'; $('pinfo').textContent = o.pageSize + ' · ' + (o.landscape ? tr('land') : tr('port')) }
        else say(tr('pfail') + (r && r.error ? ': ' + r.error : ''));
      });
    }, 180);
  }
  function loadPrinters(keep){
    P.printers().then(function(r){
      var L = (r && r.list) || [], sel = $('printer'), last = keep || null;
      if(!last) try{ last = localStorage.getItem('talabia.printer.v1') }catch(e){}
      if(!L.length){ sel.innerHTML = ''; var n0 = document.createElement('option'); n0.value = ''; n0.textContent = tr('none'); sel.appendChild(n0); return }
      var pick = L.some(function(p){return p.name === last}) ? last : ((L.filter(function(p){return p.isDefault})[0] || L[0]).name);
      sel.innerHTML = L.map(function(p){ var o = document.createElement('option'); o.value = p.name; o.textContent = p.label + (p.isDefault ? tr('dflt') : ''); if(p.name === pick) o.selected = true; return o.outerHTML }).join('');
    });
  }
  function closeMe(){ $('wrap').classList.remove('in'); setTimeout(function(){ P.close() }, 220) }

  P.onDoc(function(d){
    DOC = d; applyLang(d.lang === 'en'); $('sub').textContent = d.title || ''; say(''); BUSY = false; $('go').disabled = false;
    $('wrap').classList.remove('in'); void $('wrap').offsetWidth;
    render(); loadPrinters();
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ $('wrap').classList.add('in') }) });
  });
  ['orient', 'paper', 'margins', 'scale', 'bg'].forEach(function(id){ $(id).addEventListener('change', render) });
  $('pages').addEventListener('change', function(){ $('range').disabled = $('pages').value !== 'some'; if(!$('range').disabled) $('range').focus(); render() });
  $('range').addEventListener('input', render);
  $('color').addEventListener('change', function(){ $('sheet').classList.toggle('gray', $('color').value === 'g') });
  $('refresh').addEventListener('click', function(){ loadPrinters($('printer').value) });
  $('add').addEventListener('click', function(){ P.addPrinter() });
  window.addEventListener('focus', function(){ if(DOC) loadPrinters($('printer').value) });   // back from Windows settings: the new printer is there
  $('go').addEventListener('click', function(){
    if(BUSY || !DOC) return;
    var o = opts(); if(!o.deviceName){ say(tr('pick')); return } if(o.badRange){ say(tr('range')); return }
    try{ localStorage.setItem('talabia.printer.v1', o.deviceName) }catch(e){}
    BUSY = true; $('go').disabled = true; say(tr('sending'));
    P.printNow(DOC.html, o).then(function(r){
      BUSY = false; $('go').disabled = false;
      if(r && r.ok){ say(tr('sent')); setTimeout(closeMe, 700) }
      else say(tr('fail') + (r && r.error ? ': ' + r.error : ''));
    });
  });
  $('more').addEventListener('click', function(){
    if(!DOC) return; say(tr('edgeOpen'));
    P.system(DOC.html, opts()).then(function(r){
      if(r && r.ok){ say(r.edge ? tr('edge') : tr('browser')); setTimeout(closeMe, 1600) }
      else say(tr('ofail') + (r && r.error ? ': ' + r.error : ''));
    });
  });
  $('close').addEventListener('click', closeMe);
  $('x').addEventListener('click', closeMe);
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeMe() });
})();
