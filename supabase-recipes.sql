-- =====================================================================================
-- Talabia 1.5.0 — المكوّنات والوصفات: صفٌّ لكلّ براند في public.talabia_brand_catalog
--
-- يُشغَّل مرّةً واحدة في SQL Editor لمشروع Supabase، بعد supabase-security.sql ثمّ supabase-roles.sql.
-- آمنٌ للتشغيل أكثر من مرّة، ولا يمسّ جدول الفروع ولا بياناته.
--
-- القراءة: المالك، وكلّ حسابٍ مسنَدٍ إليه فرعٌ من هذا البراند (فلا يرى حسابُ تشيززز وصفاتِ كانوليه).
-- الكتابة: المالك، أو حسابٌ دوره فيه «تعديل صنف» (items.edit) أو «تعديل الوصفات» (recipes.edit)
--          ويرى فرعاً من البراند نفسه. الحذف للمالك وحده.
-- =====================================================================================

create table if not exists public.talabia_brand_catalog (
  brand       text primary key check (brand ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  rev         integer not null default 1,
  updated_at  timestamptz not null default now(),
  device      text,
  data        jsonb not null check (pg_column_size(data) < 2000000)
);

alter table public.talabia_brand_catalog enable row level security;
revoke all on public.talabia_brand_catalog from anon;
grant select, insert, update on public.talabia_brand_catalog to authenticated;

-- يرى الحسابُ البراندَ إن رأى فرعاً واحداً منه (private.talabia_can من supabase-security.sql)
create or replace function private.talabia_can_brand(p_brand text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.talabia_is_admin()
      or exists (select 1 from public.daftar_branches b
                  where b.brand = p_brand and not b.deleted and private.talabia_can(b.id));
$$;
-- ويعدّل وصفاته إن كان المالك، أو كان في دوره «تعديل صنف» أو «تعديل الوصفات» (private.talabia_perm من supabase-roles.sql)
create or replace function private.talabia_can_recipes(p_brand text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.talabia_is_admin()
      or (private.talabia_can_brand(p_brand)
          and (private.talabia_perm('items.edit') or private.talabia_perm('recipes.edit')));
$$;
revoke all on function private.talabia_can_brand(text), private.talabia_can_recipes(text) from public, anon;
grant execute on function private.talabia_can_brand(text), private.talabia_can_recipes(text) to authenticated;

drop policy if exists "talabia_catalog_read"   on public.talabia_brand_catalog;
drop policy if exists "talabia_catalog_insert" on public.talabia_brand_catalog;
drop policy if exists "talabia_catalog_update" on public.talabia_brand_catalog;
drop policy if exists "talabia_catalog_delete" on public.talabia_brand_catalog;

create policy "talabia_catalog_read" on public.talabia_brand_catalog for select to authenticated
  using ((select private.talabia_can_brand(brand)));
create policy "talabia_catalog_insert" on public.talabia_brand_catalog for insert to authenticated
  with check ((select private.talabia_can_recipes(brand)));
create policy "talabia_catalog_update" on public.talabia_brand_catalog for update to authenticated
  using ((select private.talabia_can_recipes(brand)))
  with check ((select private.talabia_can_recipes(brand)));
create policy "talabia_catalog_delete" on public.talabia_brand_catalog for delete to authenticated
  using ((select private.talabia_is_admin()));

-- لا يتغيّر براند الصفّ بعد إنشائه (وصفات تشيززز لا تصير وصفات كانوليه)
create or replace function private.talabia_guard_catalog() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.brand is distinct from old.brand then
    raise exception 'غير مسموح: براند الوصفات لا يتغيّر' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.talabia_guard_catalog() from public, anon, authenticated;
drop trigger if exists talabia_guard_catalog on public.talabia_brand_catalog;
create trigger talabia_guard_catalog before update on public.talabia_brand_catalog
  for each row execute function private.talabia_guard_catalog();

-- تحقّق: يجب أن يعيد سطراً واحداً بالاسم talabia_brand_catalog
select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = 'talabia_brand_catalog';
