-- طلبية | Talabia — الحسابات والصلاحيات (مشروع daftara)
-- ─────────────────────────────────────────────────────────────────────────
-- المدير: يرى كلّ الفروع، وإعدادات التخزين، ويدير المستخدمين من داخل التطبيق.
-- المستخدم: يسجّل الدخول للمزامنة فقط، ويرى الفروع التي يحدّدها له المدير وحدها.
--
-- قبل التشغيل أوّل مرّة (من لوحة Supabase):
--   1) Authentication ← Users ← Add user ← أدخل بريدك وكلمة مرور قوية وفعّل «Auto Confirm User».
--   2) Authentication ← Sign In / Providers ← أوقف «Allow new users to sign up».
-- ثم: SQL Editor ← New query ← الصق هذا الملف ← اكتب بريدك في السطر المعلَّم ← Run.
--
-- يصلح تشغيله أكثر من مرّة. لا يحذف أي بيانات: لا DROP TABLE ولا DELETE ولا TRUNCATE.
-- لو البريد غير موجود يتوقف الملف كله قبل أي تغيير.
-- ─────────────────────────────────────────────────────────────────────────

-- ← اكتب بريد حسابك (المدير) هنا
drop table if exists pg_temp._owner;
create temporary table _owner as
  select lower(trim('YOUR_EMAIL@example.com')) as email;

do $$
begin
  if not exists (select 1 from auth.users u join _owner o on lower(u.email) = o.email) then
    raise exception 'الحساب غير موجود — أنشئه أولًا من Authentication ← Users ← Add user، واكتب بريده في أعلى الملف';
  end if;
end $$;

-- 0) جدول الفروع (لا يمسّ بياناته إن كان موجودًا)
create table if not exists public.daftar_branches (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  brand       text not null,
  name        text not null check (char_length(name) <= 120),
  rev         integer not null default 1,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false,
  device      text,
  data        jsonb not null check (pg_column_size(data) < 5000000)
);

-- 1) الحسابات المسموح لها وصلاحياتها — في مخطط خاص غير مكشوف عبر الـ API
create schema if not exists private;
create table if not exists private.talabia_users (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table private.talabia_users add column if not exists role text not null default 'staff';
alter table private.talabia_users add column if not exists branches text[] not null default '{}';
do $$ begin
  alter table private.talabia_users add constraint talabia_users_role_chk check (role in ('admin','staff'));
exception when duplicate_object then null; end $$;
revoke all on private.talabia_users from public, anon, authenticated;

insert into private.talabia_users (user_id, role)
select u.id, 'admin' from auth.users u join _owner o on lower(u.email) = o.email
on conflict (user_id) do update set role = 'admin';

-- 2) دوالّ التحقّق (تقرأ القائمة بصلاحية المالك ولا تكشفها)
create or replace function private.talabia_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users where user_id = (select auth.uid()) and role = 'admin');
$$;
create or replace function private.talabia_can(p_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users
                 where user_id = (select auth.uid()) and (role = 'admin' or p_id = any(branches)));
$$;
create or replace function private.is_talabia_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users where user_id = (select auth.uid()));
$$;
revoke all on function private.talabia_is_admin(), private.talabia_can(text), private.is_talabia_user() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.talabia_is_admin(), private.talabia_can(text), private.is_talabia_user() to authenticated;

-- 3) جدول الفروع: المفتاح العام ممنوع؛ كلّ مستخدم يرى فروعه فقط؛ الإنشاء والحذف للمدير
alter table public.daftar_branches enable row level security;
drop policy if exists "daftar anon access"    on public.daftar_branches;
drop policy if exists "daftar members access" on public.daftar_branches;
drop policy if exists "talabia_members_only"  on public.daftar_branches;
drop policy if exists "talabia_read"   on public.daftar_branches;
drop policy if exists "talabia_insert" on public.daftar_branches;
drop policy if exists "talabia_update" on public.daftar_branches;
drop policy if exists "talabia_delete" on public.daftar_branches;

revoke all on table public.daftar_branches from anon;
revoke all on table public.daftar_branches from authenticated;
grant select, insert, update, delete on table public.daftar_branches to authenticated;

create policy "talabia_read" on public.daftar_branches for select to authenticated
  using ((select private.talabia_can(id)));
create policy "talabia_insert" on public.daftar_branches for insert to authenticated
  with check ((select private.talabia_is_admin()));
create policy "talabia_update" on public.daftar_branches for update to authenticated
  using ((select private.talabia_can(id)))
  with check ((select private.talabia_is_admin()) or ((select private.talabia_can(id)) and deleted = false));
create policy "talabia_delete" on public.daftar_branches for delete to authenticated
  using ((select private.talabia_is_admin()));

-- المستخدم العادي يعدّل بيانات فرعه فقط: لا يغيّر اسمه ولا البراند ولا المعرّف
create or replace function private.talabia_guard_branch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_is_admin()
     and (new.id is distinct from old.id or new.brand is distinct from old.brand
          or new.name is distinct from old.name or new.deleted is distinct from old.deleted) then
    raise exception 'غير مسموح: تعديل الفرع نفسه للمدير فقط';
  end if;
  return new;
end $$;
drop trigger if exists talabia_guard_branch on public.daftar_branches;
create trigger talabia_guard_branch before update on public.daftar_branches
  for each row execute function private.talabia_guard_branch();

-- 4) ما يسأله التطبيق عن الحساب المسجَّل: هل هو مسموح، ودوره، وفروعه
create or replace function public.talabia_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('member', true, 'role', t.role, 'branches', to_jsonb(t.branches))
       from private.talabia_users t where t.user_id = (select auth.uid())),
    jsonb_build_object('member', false));
$$;
-- (يبقى للتوافق مع النسخة السابقة من التطبيق)
create or replace function public.talabia_am_i_member() returns boolean
language sql stable security definer set search_path = '' as $$ select private.is_talabia_user(); $$;

-- 5) إدارة المستخدمين من داخل التطبيق — كلّ دالّة تتحقّق أوّلاً أنّ المتّصل مدير
create or replace function public.talabia_admin_users() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.talabia_is_admin() then raise exception 'غير مسموح'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', t.user_id, 'email', u.email, 'role', t.role, 'branches', to_jsonb(t.branches),
             'last_sign_in', u.last_sign_in_at, 'me', t.user_id = (select auth.uid()))
           order by t.role, u.email)
      from private.talabia_users t join auth.users u on u.id = t.user_id), '[]'::jsonb);
end $$;

create or replace function private.talabia_admins_after(p_user uuid, p_role text) returns integer
language sql stable security definer set search_path = '' as $$
  select (select count(*)::int from private.talabia_users where role = 'admin' and user_id <> p_user)
       + (case when p_role = 'admin' then 1 else 0 end);
$$;

create or replace function public.talabia_admin_create_user(p_email text, p_password text, p_role text, p_branches text[])
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_email text := lower(trim(p_email));
begin
  if not private.talabia_is_admin() then raise exception 'غير مسموح'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'البريد غير صحيح'; end if;
  if p_role not in ('admin','staff') then raise exception 'الدور غير صحيح'; end if;
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is null then
    if p_password is null or char_length(p_password) < 8 then raise exception 'كلمة المرور 8 أحرف على الأقل'; end if;
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
            extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text,
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
            'email', now(), now(), now());
  end if;
  insert into private.talabia_users (user_id, role, branches)
  values (v_id, p_role, coalesce(p_branches, '{}'))
  on conflict (user_id) do update set role = excluded.role, branches = excluded.branches;
  return v_id;
end $$;

create or replace function public.talabia_admin_set_access(p_user uuid, p_role text, p_branches text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_is_admin() then raise exception 'غير مسموح'; end if;
  if p_role not in ('admin','staff') then raise exception 'الدور غير صحيح'; end if;
  if private.talabia_admins_after(p_user, p_role) < 1 then raise exception 'لا بدّ من مديرٍ واحدٍ على الأقل'; end if;
  update private.talabia_users set role = p_role, branches = coalesce(p_branches, '{}') where user_id = p_user;
  if not found then raise exception 'المستخدم غير موجود'; end if;
end $$;

create or replace function public.talabia_admin_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_is_admin() then raise exception 'غير مسموح'; end if;
  if p_password is null or char_length(p_password) < 8 then raise exception 'كلمة المرور 8 أحرف على الأقل'; end if;
  if not exists (select 1 from private.talabia_users where user_id = p_user) then raise exception 'المستخدم غير موجود'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_user;
end $$;

create or replace function public.talabia_admin_remove(p_user uuid, p_delete_account boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_is_admin() then raise exception 'غير مسموح'; end if;
  if private.talabia_admins_after(p_user, 'staff') < 1 then raise exception 'لا بدّ من مديرٍ واحدٍ على الأقل'; end if;
  delete from private.talabia_users where user_id = p_user;
  if p_delete_account then delete from auth.users where id = p_user; end if;
end $$;

revoke all on function public.talabia_me(), public.talabia_am_i_member(), public.talabia_admin_users(),
  public.talabia_admin_create_user(text, text, text, text[]), public.talabia_admin_set_access(uuid, text, text[]),
  public.talabia_admin_set_password(uuid, text), public.talabia_admin_remove(uuid, boolean) from public, anon;
revoke all on function private.talabia_admins_after(uuid, text), private.talabia_guard_branch() from public, anon, authenticated;
grant execute on function public.talabia_me(), public.talabia_am_i_member(), public.talabia_admin_users(),
  public.talabia_admin_create_user(text, text, text, text[]), public.talabia_admin_set_access(uuid, text, text[]),
  public.talabia_admin_set_password(uuid, text), public.talabia_admin_remove(uuid, boolean) to authenticated;

-- 6) جدول قديم إن وُجد من نسخة سابقة: قفل كامل دون حذف
do $$
begin
  if to_regclass('public.daftar_members') is not null then
    execute 'alter table public.daftar_members enable row level security';
    execute 'revoke all on table public.daftar_members from anon, authenticated';
  end if;
end $$;

-- 7) تحقّق: يجب أن يظهر بريدك ودوره admin
select u.email as "الحساب", t.role as "الدور", t.branches as "الفروع"
from private.talabia_users t join auth.users u on u.id = t.user_id;
