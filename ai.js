'use strict';
/*
 * The AI explanation layer — optional, and off until the owner enters an Anthropic API key in Settings.
 *
 * It never calculates. The page builds a structured context from the app's own deterministic results
 * (aiContext: coverage, analytics, forecast traces, order traces, component demand) and the model only reads
 * that context and explains it in Arabic. The page then checks every number in the answer against the context
 * (aiValidate) before showing it as verified. Nothing here can write a sale, a forecast or an order.
 *
 * The key lives on this computer only, encrypted by Windows for this user (Electron safeStorage / DPAPI),
 * and is never sent to the page.
 */
const fs = require('fs');

const MODEL = 'claude-opus-5-5';
const SYSTEM = [
  'أنت مساعد تحليلٍ داخل تطبيق «طلبية» لتخطيط طلبيات فروع الحلويات. اكتب بالعربية الفصحى، بإيجازٍ وبنقاطٍ قصيرة.',
  'مصدرك الوحيد هو كائن JSON المرفق: نتائج حسبها التطبيق من مبيعات أودو المستوردة. لا تعرف شيئاً خارجه.',
  'قواعد لا تُكسر:',
  '1. لا تخترع رقماً: كلّ رقمٍ تكتبه يجب أن يكون موجوداً في السياق كما هو (يجوز تقريبه إلى منزلةٍ عشرية واحدة أو إلى عددٍ صحيح، أو كتابة النسبة مئويةً).',
  '2. لا تخترع مبيعاتٍ ولا مخزوناً ولا سجلّات أودو. إن كان «available» فارغاً (null) فالمخزون غير معروف، فقل ذلك.',
  '3. اليوم «missing» بيانات ناقصة وليس صفراً. والصفر «zero» صفرٌ مؤكَّد.',
  '4. لا تعدّل التوقّع ولا الكمية المقترحة؛ هي من محرّك التطبيق. يجوز أن تنبّه أو توصي، والقرار للمدير.',
  '5. إن لم تكفِ البيانات للجواب فقل ذلك صراحةً واذكر ما ينقص (مثلاً عدد الأيام المغطّاة، أو «fallback»).',
  '6. ميّز بين ما تعلّمه التطبيق من البيانات (source: "learned"/"mixed") وما هو افتراض (source: "assumed").',
  '7. اذكر الأرقام التي بنيت عليها الجواب.',
  '8. إن كان الرقم افتراضاً فقل: «هذا افتراض». وإن كان مقيساً من المبيعات فقل: «هذا مبني على البيانات الفعلية». وإن لم تكفِ البيانات فقل: «البيانات غير كافية للحكم».',
  '9. مناسبات التقويم (market) لا أثر لها على التوقّع ما لم يكن أثرها مقيساً؛ لا تنسب لمناسبةٍ أثراً غير موجود في السياق.',
  '10. لا تنشئ طلبية شراء ولا تقترح أرقاماً بديلة للكمية؛ اشرح كمية التطبيق ونبّه إلى ما يستحق المراجعة.',
  '11. العرض (offers) يُباع سطراً واحداً، والطلب الموحَّد للمنتج = مبيعاته + العرض × كمّيته؛ لا تعدّ العرض مرّتين.'
].join('\n');

function makeAi({ file, safeStorage, Anthropic, fetchImpl, baseURL, model }) {
  const useModel = model || MODEL;
  const canEncrypt = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; } };
  function readKey() {
    try {
      if (!fs.existsSync(file)) return null;
      const k = safeStorage.decryptString(fs.readFileSync(file));
      return /^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(k) ? k : null;
    } catch (e) { return null; }
  }
  function state() {
    return { enabled: !!readKey(), model: useModel, canStore: canEncrypt() };
  }
  function setKey(key) {
    key = String(key || '').trim();
    if (!key) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* gone */ } return { ok: true, enabled: false }; }
    if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(key)) return { ok: false, error: 'المفتاح لا يشبه مفتاح Anthropic (يبدأ بـ sk-ant-)' };
    if (!canEncrypt()) return { ok: false, error: 'تشفير ويندوز غير متاح على هذا الجهاز، فلا يُحفظ المفتاح' };
    fs.writeFileSync(file, safeStorage.encryptString(key));
    return { ok: true, enabled: true };
  }
  async function ask({ question, context }) {
    const key = readKey();
    if (!key) return { ok: false, error: 'off' };
    const q = String(question || '').trim().slice(0, 1000);
    if (!q) return { ok: false, error: 'اكتب سؤالاً' };
    const ctx = typeof context === 'string' ? context : JSON.stringify(context || {});
    if (ctx.length > 400000) return { ok: false, error: 'السياق أكبر من المسموح' };
    const client = new Anthropic(Object.assign({ apiKey: key, timeout: 90000 }, fetchImpl ? { fetch: fetchImpl } : {}, baseURL ? { baseURL } : {}));
    try {
      const res = await client.beta.messages.create({
        model: useModel,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: 'سياق التطبيق (JSON):\n' + ctx + '\n\nسؤال المدير: ' + q }]
      });
      if (res.stop_reason === 'refusal') return { ok: false, error: 'رفض النموذج الإجابة عن هذا السؤال' };
      const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text) return { ok: false, error: 'لم يصل جواب' };
      return { ok: true, text, model: res.model, truncated: res.stop_reason === 'max_tokens' };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: 'مفتاح Anthropic غير صالح — غيّره من الإعدادات' };
      if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'المفتاح لا يملك صلاحية هذا النموذج' };
      if (e instanceof Anthropic.RateLimitError) return { ok: false, error: 'تجاوزتَ حدّ الطلبات — حاول بعد قليل' };
      if (e instanceof Anthropic.APIConnectionError) return { ok: false, error: 'لا اتصال بالإنترنت — الشرح الذكي يحتاج اتصالاً، وباقي التطبيق يعمل كما هو' };
      if (e instanceof Anthropic.APIError) return { ok: false, error: 'خطأ من خدمة Anthropic (' + e.status + ')' };
      return { ok: false, error: String(e && e.message || e) };
    }
  }
  return { state, setKey, ask, MODEL: useModel, SYSTEM };
}

module.exports = { makeAi, MODEL, SYSTEM };
