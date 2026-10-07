-- ============================================================================
-- supabase-coverage.sql — حماية «سجلّ الاستيراد» (P0-1) على الخادم
--
-- ما يفعله: يضيف حارساً على جدول daftar_branches يمنع أيّ حسابٍ غير المالك من
-- تعديل سجلّ الاستيراد (data -> 'imports') إلا إذا كان دوره يملك صلاحية
-- «استيراد ملف أودو» (entry.import) أو «استعادة نسخة» (data.import).
--
-- لماذا: التطبيق يسجّل لكلّ استيراد الفترة التي غطّاها، وعليه يُبنى «صفر
-- مؤكَّد» مقابل «بيانات ناقصة». حارس الصلاحيات الحالي (talabia_guard_perms)
-- يقارن الأصناف والأيام والجرد والطلبيات والمناسبات والإعدادات فقط، فلا يرى هذا
-- المفتاح الجديد.
--
-- إن لم تشغّله: المزامنة تعمل كما هي ويُحفظ السجلّ ويُزامَن، لكنّ الخادم لا يمنع
-- حساباً له صلاحية الوصول للفرع من تعديل هذا السجلّ بطلبٍ مباشر خارج التطبيق.
-- (داخل التطبيق لا يكتبه إلا الاستيراد.)
--
-- لا يغيّر أيّ بيانات، ولا يمسّ الحارس الموجود؛ يضيف دالةً وحارساً جديدين فقط.
-- يُشغَّل مرّةً واحدة في SQL Editor بعد supabase-security.sql و supabase-roles.sql.
-- ============================================================================

create or replace function private.talabia_guard_imports() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_perms jsonb;
begin
  if (select auth.uid()) is null then return new; end if;           -- SQL Editor / خدمة داخلية
  if private.talabia_is_admin() then return new; end if;           -- المالك
  if coalesce(new.data -> 'imports', '[]'::jsonb) is not distinct from coalesce(old.data -> 'imports', '[]'::jsonb) then
    return new;
  end if;
  select coalesce(r.perms, '{}'::jsonb) into v_perms
    from private.talabia_users t left join private.talabia_roles r on r.id = t.role_id
   where t.user_id = (select auth.uid());
  if private.tp(coalesce(v_perms, '{}'::jsonb), 'entry.import') or private.tp(coalesce(v_perms, '{}'::jsonb), 'data.import') then
    return new;
  end if;
  raise exception 'غير مسموح: «سجلّ الاستيراد» ليس من صلاحيات دورك' using errcode = '42501';
end $$;

revoke all on function private.talabia_guard_imports() from public, anon, authenticated;

drop trigger if exists talabia_guard_imports on public.daftar_branches;
create trigger talabia_guard_imports before update on public.daftar_branches
  for each row execute function private.talabia_guard_imports();
