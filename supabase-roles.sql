-- طلبية | Talabia — لوحة تحكم المالك: الأدوار والصلاحيات وسجل النشاط (مشروع daftara)
-- ─────────────────────────────────────────────────────────────────────────
-- يُشغَّل بعد supabase-security.sql، ويصلح تشغيله أكثر من مرّة.
-- SQL Editor ← New query ← الصق الملف كاملاً ← (اكتب بريدك في السطر المعلَّم إن طُلب) ← Run.
--
-- ما يفعله:
--   - حسابك أنت «المالك»: وحده يدير المستخدمين والأدوار والفروع والتخزين، ويستطيع تفويض
--     «إدارة المستخدمين» و«إدارة الأدوار» و«عرض السجل» لدورٍ يختاره — دون أن يمسّ المفوَّضُ
--     حسابَ المالك أو حسابه هو أو صلاحياته، ودون أن يمنح أحداً صلاحيةً حسّاسة أو يمسح السجل.
--   - أي مدير آخر يصير «مستخدماً» يحتفظ بكل الفروع التي كان يراها، ثم تحدّد له دوره.
--   - أدوار بأسماء تختارها، لكلٍّ منها صلاحيات (شاشات وإجراءات) تفتحها وتقفلها.
--   - إيقاف حساب يمنعه فوراً من الدخول ومن البيانات على كل الأجهزة.
--   - سجل نشاط: من فعل ماذا ومتى وفي أي فرع (البريد يكتبه الخادم، لا الجهاز).
--
-- لا يحذف أي بيانات: لا DROP TABLE ولا مساس بجدول الفروع.
-- ─────────────────────────────────────────────────────────────────────────

-- ← اكتب بريد حسابك (المالك) هنا. إن تركته كما هو وكان في المشروع مديرٌ واحد فقط، فهو المالك.
drop table if exists pg_temp._owner_email;
create temporary table _owner_email as
  select lower(trim('YOUR_EMAIL@example.com')) as email;

do $$
begin
  if to_regclass('private.talabia_users') is null then
    raise exception 'شغّل ملف supabase-security.sql أولاً، ثم أعد تشغيل هذا الملف';
  end if;
end $$;

-- 1) أعمدة جديدة لحسابات التطبيق
alter table private.talabia_users add column if not exists is_owner boolean not null default false;
alter table private.talabia_users add column if not exists role_id  text;
alter table private.talabia_users add column if not exists active   boolean not null default true;
alter table private.talabia_users add column if not exists display_name text check (display_name is null or char_length(display_name) <= 60);

-- 2) تحديد المالك (مرّة واحدة؛ لا يتغيّر في التشغيلات التالية)
do $$
declare v_owner uuid; v_email text; v_admins int;
begin
  if exists (select 1 from private.talabia_users where is_owner) then return; end if;
  select email into v_email from _owner_email;
  if v_email <> 'your_email@example.com' then
    select t.user_id into v_owner from private.talabia_users t join auth.users u on u.id = t.user_id
     where lower(u.email) = v_email;
    if v_owner is null then
      raise exception 'البريد % ليس من حسابات التطبيق — اكتب بريد حسابك الذي تدخل به', v_email;
    end if;
  else
    select count(*) into v_admins from private.talabia_users where role = 'admin';
    if v_admins <> 1 then
      raise exception 'في المشروع % مديرين — اكتب بريد حسابك في أعلى الملف ليُعرف أنه المالك', v_admins;
    end if;
    select user_id into v_owner from private.talabia_users where role = 'admin';
  end if;
  update private.talabia_users set is_owner = (user_id = v_owner);
  update private.talabia_users set role = 'admin', active = true where user_id = v_owner;
  -- بقية المديرين: مستخدمون يحتفظون بكل الفروع الحالية حتى يحدّد المالك غير ذلك
  update private.talabia_users
     set role = 'staff',
         branches = (select coalesce(array_agg(b.id order by b.id), '{}') from public.daftar_branches b where not b.deleted)
   where role = 'admin' and user_id <> v_owner;
end $$;

-- 3) الأدوار وسجل النشاط — في المخطط الخاص غير المكشوف
create table if not exists private.talabia_roles (
  id         text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name       text not null check (char_length(name) between 1 and 60),
  perms      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists private.talabia_activity (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  user_id   uuid,
  email     text,
  branch_id text,
  action    text,
  detail    text
);
create index if not exists talabia_activity_at on private.talabia_activity (at desc);
revoke all on private.talabia_roles, private.talabia_activity from public, anon, authenticated;

-- أدوار جاهزة (تُضاف مرّة واحدة إن لم يكن هناك أي دور)
insert into private.talabia_roles (id, name, perms)
select * from (values
  ('manager', 'مدير فرع', '{"view.order":true,"view.entry":true,"view.items":true,"view.stats":true,"order.save":true,"order.adjust":true,"order.stock":true,"entry.record":true,"entry.close":true,"entry.import":true,"items.add":true,"items.edit":true,"setup.schedule":true,"setup.tracking":true,"setup.tendency":true,"setup.events":true,"data.export":true}'::jsonb),
  ('staff',   'موظف',     '{"view.order":true,"view.entry":true,"view.items":true,"order.adjust":true,"order.stock":true,"entry.record":true,"entry.close":true}'::jsonb),
  ('viewer',  'مشاهدة فقط','{"view.order":true,"view.entry":true,"view.items":true,"view.stats":true}'::jsonb)
) as v(id, name, perms)
where not exists (select 1 from private.talabia_roles);

-- 4) دوال التحقّق: الحساب الموقوف لا يرى شيئاً، والإدارة للمالك وحده
create or replace function private.talabia_is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users
                 where user_id = (select auth.uid()) and is_owner and active);
$$;
-- «المدير» في سياسات الجدول = المالك (هو وحده من يحمل role = 'admin' بعد هذا الملف)
create or replace function private.talabia_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users
                 where user_id = (select auth.uid()) and role = 'admin' and is_owner and active);
$$;
create or replace function private.talabia_can(p_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users
                 where user_id = (select auth.uid()) and active and (role = 'admin' or p_id = any(branches)));
$$;
create or replace function private.is_talabia_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users where user_id = (select auth.uid()) and active);
$$;
-- صلاحيات لوحة التحكم المفوّضة، جزءاً جزءاً: المالك يملكها كلّها، وغيره بما في دوره
--   usr.view عرض المستخدمين · usr.add إضافة · usr.edit تعديل الدور والفروع والاسم · usr.stop إيقاف وتفعيل
--   usr.pass كلمات المرور · usr.delete حذف · role.view عرض الأدوار · role.add إنشاء دور · role.edit تعديله
--   role.delete حذفه · log.view عرض السجلّ   (والصلاحيات الجامعة القديمة admin.users / admin.roles / admin.log تشملها)
create or replace function private.talabia_can_admin(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users t left join private.talabia_roles r on r.id = t.role_id
                 where t.user_id = (select auth.uid()) and t.active
                   and (t.is_owner or coalesce(r.perms ->> p, '') = 'true'
                        or (p like 'usr.%' and coalesce(r.perms ->> 'admin.users', '') = 'true')
                        or (p like 'role.%' and coalesce(r.perms ->> 'admin.roles', '') = 'true')
                        or (p like 'log.%' and coalesce(r.perms ->> 'admin.log', '') = 'true')));
$$;
-- الحسّاس: الصلاحيات الإدارية نفسها، والبيانات (تصدير واستعادة)، وحذف الفروع — لا يمنحها إلا المالك
create or replace function private.talabia_perms_sensitive(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select exists (select 1 from jsonb_each_text(coalesce(p, '{}'::jsonb)) e
                 where e.value = 'true' and (e.key like 'admin.%' or e.key like 'usr.%' or e.key like 'role.%' or e.key like 'log.%'
                                             or e.key like 'data.%' or e.key = 'branches.delete'));
$$;
-- الصلاحيات الإدارية وحدها (لوحة التحكم): صاحب دورٍ فيه شيءٌ منها نظيرٌ للمفوَّض، لا يمسّه إلا المالك
create or replace function private.talabia_perms_admin(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select exists (select 1 from jsonb_each_text(coalesce(p, '{}'::jsonb)) e
                 where e.value = 'true' and (e.key like 'admin.%' or e.key like 'usr.%' or e.key like 'role.%' or e.key like 'log.%'));
$$;
create or replace function private.talabia_role_admin(p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select private.talabia_perms_admin(perms) from private.talabia_roles where id = p_role), false);
$$;
-- مفاتيح الصلاحيات الحسّاسة المفعّلة في مجموعة صلاحيات (للمقارنة: المفوَّض لا يضيف منها ولا ينزع)
create or replace function private.talabia_sens_keys(p jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(e.key order by e.key), '{}') from jsonb_each_text(coalesce(p, '{}'::jsonb)) e
   where e.value = 'true' and (e.key like 'admin.%' or e.key like 'usr.%' or e.key like 'role.%' or e.key like 'log.%'
                               or e.key like 'data.%' or e.key = 'branches.delete');
$$;
create or replace function private.talabia_role_sensitive(p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select private.talabia_perms_sensitive(perms) from private.talabia_roles where id = p_role), false);
$$;
-- من يديره غيرُ المالك: لا المالك، ولا نفسه، ولا صاحب دورٍ حسّاس (من عيّنهم المالك)
create or replace function private.talabia_guard_target(p_user uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.talabia_is_owner() then return; end if;
  if exists (select 1 from private.talabia_users where user_id = p_user and is_owner) then raise exception 'حساب المالك لا يُمَسّ'; end if;
  if p_user = (select auth.uid()) then raise exception 'لا تستطيع تعديل حسابك أو صلاحياتك بنفسك'; end if;
  if exists (select 1 from private.talabia_users t where t.user_id = p_user and private.talabia_role_admin(t.role_id)) then
    raise exception 'هذا الحساب مديرٌ مفوَّض مثلك — يعدّله المالك وحده';
  end if;
end $$;
-- لا يُسنَد دورٌ حسّاس إلا من المالك
create or replace function private.talabia_guard_role(p_role text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.talabia_is_owner() then return; end if;
  if p_role is not null and private.talabia_role_sensitive(p_role) then raise exception 'لا تستطيع منح دورٍ فيه صلاحيات حسّاسة'; end if;
end $$;
revoke all on function private.talabia_is_owner() from public, anon;
grant execute on function private.talabia_is_owner() to authenticated;

-- 5) ما يسأله التطبيق: هل الحساب مسموح، دوره، فروعه، وصلاحياته
create or replace function public.talabia_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case when not t.active then jsonb_build_object('member', false, 'disabled', true)
            else jsonb_build_object(
              'member', true, 'role', t.role, 'owner', t.is_owner, 'name', t.display_name,
              'branches', to_jsonb(t.branches), 'role_id', t.role_id,
              'role_name', r.name, 'perms', coalesce(r.perms, '{}'::jsonb)) end
       from private.talabia_users t left join private.talabia_roles r on r.id = t.role_id
      where t.user_id = (select auth.uid())),
    jsonb_build_object('member', false));
$$;

-- 6) إدارة المستخدمين (المالك وحده)
create or replace function public.talabia_admin_users() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.talabia_can_admin('usr.view') then raise exception 'غير مسموح'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', t.user_id, 'email', u.email, 'name', t.display_name, 'role', t.role, 'owner', t.is_owner,
             'role_id', t.role_id, 'active', t.active, 'branches', to_jsonb(t.branches),
             'last_sign_in', u.last_sign_in_at, 'me', t.user_id = (select auth.uid()))
           order by t.is_owner desc, u.email)
      from private.talabia_users t join auth.users u on u.id = t.user_id), '[]'::jsonb);
end $$;

-- (نسخة أولى بلا اسم، إن كانت شُغّلت من قبل)
drop function if exists public.talabia_admin_create_member(text, text, text, text[]);
drop function if exists public.talabia_admin_set_member(uuid, text, text[]);

create or replace function public.talabia_admin_create_member(p_email text, p_password text, p_role_id text, p_branches text[], p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_email text := lower(trim(p_email)); v_name text := nullif(left(trim(coalesce(p_name, '')), 60), '');
begin
  if not private.talabia_can_admin('usr.add') then raise exception 'غير مسموح'; end if;
  perform private.talabia_guard_role(p_role_id);
  if exists (select 1 from private.talabia_users where lower(display_name) = lower(v_name)
               and user_id <> coalesce((select id from auth.users where lower(email) = v_email), '00000000-0000-0000-0000-000000000000'::uuid)) then
    raise exception 'يوجد مستخدم بنفس الاسم';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'البريد غير صحيح'; end if;
  if p_role_id is not null and not exists (select 1 from private.talabia_roles where id = p_role_id) then
    raise exception 'الدور غير موجود';
  end if;
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is not null and exists (select 1 from private.talabia_users where user_id = v_id and is_owner) then
    raise exception 'هذا حساب المالك';
  end if;
  if v_id is not null and exists (select 1 from private.talabia_users where user_id = v_id) then perform private.talabia_guard_target(v_id); end if;
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
  insert into private.talabia_users (user_id, role, branches, role_id, active, display_name)
  values (v_id, 'staff', coalesce(p_branches, '{}'), p_role_id, true, v_name)
  on conflict (user_id) do update set role = 'staff', branches = excluded.branches, role_id = excluded.role_id,
                                      display_name = coalesce(excluded.display_name, private.talabia_users.display_name);
  return v_id;
end $$;

create or replace function public.talabia_admin_set_member(p_user uuid, p_role_id text, p_branches text[], p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text := nullif(left(trim(coalesce(p_name, '')), 60), '');
begin
  if not private.talabia_can_admin('usr.edit') then raise exception 'غير مسموح'; end if;
  if exists (select 1 from private.talabia_users where user_id = p_user and is_owner) then
    raise exception 'حساب المالك لا يُقيَّد';
  end if;
  perform private.talabia_guard_target(p_user);
  if p_role_id is distinct from (select role_id from private.talabia_users where user_id = p_user) then
    perform private.talabia_guard_role(p_role_id);
  end if;
  if p_role_id is not null and not exists (select 1 from private.talabia_roles where id = p_role_id) then
    raise exception 'الدور غير موجود';
  end if;
  if v_name is not null and exists (select 1 from private.talabia_users where lower(display_name) = lower(v_name) and user_id <> p_user) then
    raise exception 'يوجد مستخدم بنفس الاسم';
  end if;
  update private.talabia_users set role = 'staff', role_id = p_role_id, branches = coalesce(p_branches, '{}'),
         display_name = coalesce(v_name, display_name)
   where user_id = p_user;
  if not found then raise exception 'المستخدم غير موجود'; end if;
end $$;

create or replace function public.talabia_admin_set_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_can_admin('usr.stop') then raise exception 'غير مسموح'; end if;
  perform private.talabia_guard_target(p_user);
  if exists (select 1 from private.talabia_users where user_id = p_user and is_owner) then
    raise exception 'حساب المالك لا يُوقَف';
  end if;
  update private.talabia_users set active = coalesce(p_active, true) where user_id = p_user;
  if not found then raise exception 'المستخدم غير موجود'; end if;
  -- الإيقاف يمنع تسجيل الدخول نفسه أيضاً، ويُنهي جلساته القائمة
  update auth.users set banned_until = case when coalesce(p_active, true) then null else 'infinity'::timestamptz end,
         updated_at = now()
   where id = p_user;
  if not coalesce(p_active, true) then
    begin
      delete from auth.sessions where user_id = p_user;
    exception when others then null;      -- إن اختلف مخطط auth يكفي الحظر ورفض البيانات
    end;
  end if;
end $$;

-- النسخ القديمة من دوال الإدارة: للمالك وحده، ولا تصنع مديراً آخر
create or replace function public.talabia_admin_create_user(p_email text, p_password text, p_role text, p_branches text[])
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_is_owner() then raise exception 'غير مسموح: للمالك فقط'; end if;
  return public.talabia_admin_create_member(p_email, p_password, null, p_branches, null);
end $$;
create or replace function public.talabia_admin_set_access(p_user uuid, p_role text, p_branches text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_role_id text;
begin
  if not private.talabia_is_owner() then raise exception 'غير مسموح: للمالك فقط'; end if;
  select role_id into v_role_id from private.talabia_users where user_id = p_user;
  perform public.talabia_admin_set_member(p_user, v_role_id, p_branches, null);
end $$;
create or replace function public.talabia_admin_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_can_admin('usr.pass') then raise exception 'غير مسموح'; end if;
  perform private.talabia_guard_target(p_user);
  if p_password is null or char_length(p_password) < 8 then raise exception 'كلمة المرور 8 أحرف على الأقل'; end if;
  if not exists (select 1 from private.talabia_users where user_id = p_user) then raise exception 'المستخدم غير موجود'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_user;
end $$;
create or replace function public.talabia_admin_remove(p_user uuid, p_delete_account boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_can_admin('usr.delete') then raise exception 'غير مسموح'; end if;
  perform private.talabia_guard_target(p_user);
  if exists (select 1 from private.talabia_users where user_id = p_user and is_owner) then
    raise exception 'حساب المالك لا يُحذف';
  end if;
  delete from private.talabia_users where user_id = p_user;
  if p_delete_account then delete from auth.users where id = p_user; end if;
end $$;

-- 7) الأدوار (المالك وحده)
create or replace function public.talabia_admin_roles() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.talabia_can_admin('role.view') or private.talabia_can_admin('usr.add') or private.talabia_can_admin('usr.edit')) then raise exception 'غير مسموح'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'perms', r.perms,
             'users', (select count(*) from private.talabia_users t where t.role_id = r.id)) order by r.name)
      from private.talabia_roles r), '[]'::jsonb);
end $$;

create or replace function public.talabia_admin_save_role(p_id text, p_name text, p_perms jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text := coalesce(nullif(p_id, ''), 'r-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10));
begin
  if not private.talabia_can_admin(case when exists (select 1 from private.talabia_roles where id = v_id) then 'role.edit' else 'role.add' end) then raise exception 'غير مسموح'; end if;
  if not private.talabia_is_owner() then
    -- الحسّاس يبقى كما وضعه المالك: لا يُضاف ولا يُنزع (ولدورٍ جديد: لا شيء منه)
    if private.talabia_sens_keys(p_perms) <> private.talabia_sens_keys((select perms from private.talabia_roles where id = v_id)) then
      raise exception 'لا تستطيع منح صلاحيات حسّاسة أو نزعها (البيانات، الصلاحيات الإدارية، حذف الفروع)';
    end if;
    if exists (select 1 from private.talabia_users where user_id = (select auth.uid()) and role_id = v_id) then raise exception 'لا تستطيع تعديل دورك أنت'; end if;
    if private.talabia_role_admin(v_id) then raise exception 'هذا دور مديرٍ مفوَّض — يعدّله المالك وحده'; end if;
  end if;
  if p_name is null or char_length(trim(p_name)) = 0 then raise exception 'اكتب اسم الدور'; end if;
  if jsonb_typeof(coalesce(p_perms, '{}'::jsonb)) <> 'object' then raise exception 'صلاحيات غير صالحة'; end if;
  if exists (select 1 from private.talabia_roles where lower(name) = lower(trim(p_name)) and id <> v_id) then
    raise exception 'يوجد دور بنفس الاسم';
  end if;
  insert into private.talabia_roles (id, name, perms, updated_at) values (v_id, trim(p_name), coalesce(p_perms, '{}'::jsonb), now())
  on conflict (id) do update set name = excluded.name, perms = excluded.perms, updated_at = now();
  return v_id;
end $$;

create or replace function public.talabia_admin_delete_role(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not private.talabia_can_admin('role.delete') then raise exception 'غير مسموح'; end if;
  if not private.talabia_is_owner() and (private.talabia_role_admin(p_id)
     or exists (select 1 from private.talabia_users where user_id = (select auth.uid()) and role_id = p_id)) then
    raise exception 'لا تستطيع حذف هذا الدور';
  end if;
  select count(*) into v_n from private.talabia_users where role_id = p_id;
  if v_n > 0 then raise exception 'هذا الدور لـ % مستخدم — انقلهم لدور آخر أولاً', v_n; end if;
  delete from private.talabia_roles where id = p_id;
end $$;

-- 8) سجل النشاط: أي حساب مفعّل يكتب، والمالك وحده يقرأ ويمسح
create or replace function public.talabia_log(p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_email text; v_n int := 0; it jsonb; v_at timestamptz;
begin
  if not private.is_talabia_user() then return 0; end if;
  if jsonb_typeof(p_items) <> 'array' then return 0; end if;
  select email into v_email from auth.users where id = (select auth.uid());
  for it in select * from jsonb_array_elements(p_items) limit 100 loop
    begin v_at := (it ->> 'at')::timestamptz; exception when others then v_at := now(); end;
    if v_at is null or v_at > now() + interval '5 minutes' or v_at < now() - interval '30 days' then v_at := now(); end if;
    insert into private.talabia_activity (at, user_id, email, branch_id, action, detail)
    values (v_at, (select auth.uid()), v_email,
            left(coalesce(it ->> 'branch', ''), 48), left(coalesce(it ->> 'action', ''), 32), left(coalesce(it ->> 'detail', ''), 300));
    v_n := v_n + 1;
  end loop;
  -- يُحتفظ بآخر 5000 عملية
  delete from private.talabia_activity
   where id < (select id from private.talabia_activity order by id desc offset 5000 limit 1);
  return v_n;
end $$;

create or replace function public.talabia_admin_activity(p_limit integer, p_email text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.talabia_can_admin('log.view') then raise exception 'غير مسموح'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('at', a.at, 'email', a.email, 'branch', a.branch_id,
                                        'action', a.action, 'detail', a.detail) order by a.at desc)
      from (select * from private.talabia_activity
             where p_email is null or p_email = '' or lower(email) = lower(p_email)
             order by at desc limit least(greatest(coalesce(p_limit, 300), 1), 1000)) a), '[]'::jsonb);
end $$;

create or replace function public.talabia_admin_clear_activity() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.talabia_is_owner() then raise exception 'غير مسموح: للمالك فقط'; end if;
  delete from private.talabia_activity;
end $$;

-- 9) الصلاحيات على الدوال
revoke all on function
  public.talabia_me(), public.talabia_admin_users(),
  public.talabia_admin_create_member(text, text, text, text[], text), public.talabia_admin_set_member(uuid, text, text[], text),
  public.talabia_admin_set_active(uuid, boolean), public.talabia_admin_create_user(text, text, text, text[]),
  public.talabia_admin_set_access(uuid, text, text[]), public.talabia_admin_set_password(uuid, text),
  public.talabia_admin_remove(uuid, boolean), public.talabia_admin_roles(),
  public.talabia_admin_save_role(text, text, jsonb), public.talabia_admin_delete_role(text),
  public.talabia_log(jsonb), public.talabia_admin_activity(integer, text), public.talabia_admin_clear_activity()
  from public, anon;
grant execute on function
  public.talabia_me(), public.talabia_admin_users(),
  public.talabia_admin_create_member(text, text, text, text[], text), public.talabia_admin_set_member(uuid, text, text[], text),
  public.talabia_admin_set_active(uuid, boolean), public.talabia_admin_create_user(text, text, text, text[]),
  public.talabia_admin_set_access(uuid, text, text[]), public.talabia_admin_set_password(uuid, text),
  public.talabia_admin_remove(uuid, boolean), public.talabia_admin_roles(),
  public.talabia_admin_save_role(text, text, jsonb), public.talabia_admin_delete_role(text),
  public.talabia_log(jsonb), public.talabia_admin_activity(integer, text), public.talabia_admin_clear_activity()
  to authenticated;

-- 10) فرض الصلاحيات على الخادم نفسه
-- ─────────────────────────────────────────────────────────────────────────
-- كل حفظٍ يرسله حسابٌ غير المالك يُقارَن بما في السحاب: ما تغيّر في بيانات الفرع
-- يجب أن تسمح به صلاحيات دوره، وإلا رُفض الحفظ كلّه — حتى لو عُبث بالتطبيق.
-- المقارنة بالمعنى لا بالنصّ: القيم الافتراضية التي يضيفها التطبيق عند التحميل
-- (صفرٌ مكان فراغ، وحدةٌ افتراضية…) ليست تعديلاً.

create or replace function private.tp(p jsonb, k text) returns boolean
language sql immutable set search_path = '' as $$ select coalesce(p -> k, 'false'::jsonb) = 'true'::jsonb $$;

create or replace function private.tnum(j jsonb, def numeric) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if j is null or jsonb_typeof(j) = 'null' then return def; end if;
  if jsonb_typeof(j) in ('number', 'string') then
    begin return (j #>> '{}')::numeric; exception when others then return def; end;
  end if;
  return def;
end $$;

create or replace function private.tobj(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$ select case when jsonb_typeof(j) = 'object' then j else '{}'::jsonb end $$;
create or replace function private.tarr(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$ select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end $$;

-- الأصناف: {معرّف: {الحقول بقيمها الافتراضية}}
create or replace function private.tn_products(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(p ->> 'id', jsonb_build_object(
           'name', coalesce(p ->> 'name', ''),
           'unit', coalesce(nullif(p ->> 'unit', ''), 'حبة'),
           'shelfLife', private.tnum(p -> 'shelfLife', 5),
           'packSize', private.tnum(p -> 'packSize', 1),
           'moq', private.tnum(p -> 'moq', 0),
           'active', coalesce(p -> 'active', 'true'::jsonb) <> 'false'::jsonb,
           'aliases', private.tarr(p -> 'aliases'))), '{}'::jsonb)
    from jsonb_array_elements(private.tarr(j)) p
   where jsonb_typeof(p) = 'object' and p ? 'id';
$$;

-- أيام السجلّ: يومٌ بلا أرقامٍ ولا إقفال كأنه غير موجود
create or replace function private.tn_days(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(d.k, d.v), '{}'::jsonb) from (
    select y.k, jsonb_build_object(
             'closed', coalesce(y.v -> 'closed', 'false'::jsonb) = 'true'::jsonb,
             'items', coalesce((
               select jsonb_object_agg(x.ik, jsonb_build_object(
                        'sold', private.tnum(x.iv -> 'sold', 0), 'waste', private.tnum(x.iv -> 'waste', 0),
                        'lost', private.tnum(x.iv -> 'lost', 0),
                        'stockout', coalesce(x.iv -> 'stockout', 'false'::jsonb) = 'true'::jsonb))
                 from jsonb_each(private.tobj(y.v -> 'items')) as x(ik, iv)
                where jsonb_typeof(x.iv) = 'object'
                  and (private.tnum(x.iv -> 'sold', 0) <> 0 or private.tnum(x.iv -> 'waste', 0) <> 0
                       or private.tnum(x.iv -> 'lost', 0) <> 0
                       or coalesce(x.iv -> 'stockout', 'false'::jsonb) = 'true'::jsonb)), '{}'::jsonb)) as v
      from jsonb_each(private.tobj(j)) as y(k, v)
     where jsonb_typeof(y.v) = 'object'
  ) d
  where (d.v ->> 'closed') = 'true' or (d.v -> 'items') <> '{}'::jsonb;
$$;

-- الجرد: صنفٌ بلا رصيد كأنه غير موجود
create or replace function private.tn_stock(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(s.k, s.v), '{}'::jsonb) from (
    select y.k, (select jsonb_agg(jsonb_build_object('qty', private.tnum(l -> 'qty', 0), 'expiry', l -> 'expiry'))
                   from jsonb_array_elements(private.tarr(y.v)) l where jsonb_typeof(l) = 'object') as v
      from jsonb_each(private.tobj(j)) as y(k, v)
  ) s where s.v is not null;
$$;

create or replace function private.tn_orders(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(y.k, jsonb_build_object(
           'status', coalesce(y.v ->> 'status', ''),
           'items', coalesce((select jsonb_object_agg(x.ik, jsonb_build_object(
                                 'suggested', private.tnum(x.iv -> 'suggested', 0), 'ordered', private.tnum(x.iv -> 'ordered', 0)))
                                from jsonb_each(private.tobj(y.v -> 'items')) as x(ik, iv)
                               where jsonb_typeof(x.iv) = 'object'), '{}'::jsonb))), '{}'::jsonb)
    from jsonb_each(private.tobj(j)) as y(k, v)
   where jsonb_typeof(y.v) = 'object';
$$;

create or replace function private.tn_events(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(e ->> 'id', jsonb_build_object(
           'name', coalesce(e ->> 'name', ''), 'kind', coalesce(nullif(e ->> 'kind', ''), 'other'),
           'from', e -> 'from', 'to', e -> 'to', 'mult', private.tnum(e -> 'mult', 1))), '{}'::jsonb)
    from jsonb_array_elements(private.tarr(j)) e
   where jsonb_typeof(e) = 'object' and e ? 'id';
$$;

-- الإعدادات في ثلاث مجموعات، كلٌّ بصلاحيتها
create or replace function private.tn_schedule(c jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'orderDays', coalesce((select jsonb_agg(distinct x order by x)
                             from (select private.tnum(d, -1)::int as x from jsonb_array_elements(private.tarr(c -> 'orderDays')) d) q
                            where x between 0 and 6), '[0,3]'::jsonb),
    'leadDays', private.tnum(c -> 'leadDays', 1),
    'deliveryHour', private.tnum(c -> 'deliveryHour', 19),
    'afterShare', case when c -> 'afterShare' is null or jsonb_typeof(c -> 'afterShare') = 'null' or (c ->> 'afterShare') = ''
                       then null else private.tnum(c -> 'afterShare', null) end,
    'horizonBuffer', private.tnum(c -> 'horizonBuffer', 0.95),
    'dayCfg', coalesce((select jsonb_object_agg(y.k, y.v) from (
                 select d.k, jsonb_strip_nulls(jsonb_build_object(
                          'lead', case when d.v ? 'lead' then private.tnum(d.v -> 'lead', 0) end,
                          'hour', case when d.v ? 'hour' then private.tnum(d.v -> 'hour', 0) end)) as v
                   from jsonb_each(private.tobj(c -> 'dayCfg')) as d(k, v)
                  where jsonb_typeof(d.v) = 'object') y
               where y.v <> '{}'::jsonb), '{}'::jsonb));
$$;
create or replace function private.tn_tracking(c jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'trackWaste',       coalesce(c -> 'trackWaste', 'true'::jsonb) = 'true'::jsonb,
    'trackStockout',    coalesce(c -> 'trackStockout', 'true'::jsonb) = 'true'::jsonb,
    'trackPacking',     coalesce(c -> 'trackPacking', 'false'::jsonb) = 'true'::jsonb,
    'trackStock',       coalesce(c -> 'trackStock', 'false'::jsonb) = 'true'::jsonb,
    'showShelfInClose', coalesce(c -> 'showShelfInClose', 'false'::jsonb) = 'true'::jsonb);
$$;

/** أوّل تعديلٍ لا تسمح به الصلاحيات، أو null إن كان كلّ ما تغيّر مسموحاً. */
create or replace function private.talabia_edit_violation(o jsonb, n jsonb, p jsonb) returns text
language plpgsql stable set search_path = '' as $$
declare
  op jsonb := private.tn_products(o -> 'products');
  np jsonb := private.tn_products(n -> 'products');
  od jsonb := private.tn_days(o -> 'days');
  nd jsonb := private.tn_days(n -> 'days');
  r record; a jsonb; b jsonb; k text;
begin
  -- الاستعادة من نسخة تستبدل بيانات الفرع كلّها، فصلاحيتها تشمل كلّ تعديل
  if private.tp(p, 'data.import') then return null; end if;

  for r in select x.key from jsonb_each(np) x where not op ? x.key loop
    if not (private.tp(p, 'items.add') or private.tp(p, 'entry.import')) then return 'إضافة صنف'; end if;
  end loop;
  for r in select x.key from jsonb_each(op) x where not np ? x.key loop
    if not private.tp(p, 'items.delete') then return 'حذف صنف'; end if;
  end loop;
  for r in select x.key, x.value as a, np -> x.key as b from jsonb_each(op) x where np ? x.key and (np -> x.key) <> x.value loop
    if (r.a - 'aliases') <> (r.b - 'aliases') then
      if not private.tp(p, 'items.edit') then return 'تعديل صنف'; end if;
    elsif not (private.tp(p, 'items.edit') or private.tp(p, 'entry.import')) then
      return 'تعديل الأسماء البديلة لصنف';
    end if;
  end loop;

  for k in select key from jsonb_each(od) union select key from jsonb_each(nd) loop
    a := od -> k; b := nd -> k;
    if a is not distinct from b then continue; end if;
    if coalesce(a -> 'closed', 'false'::jsonb) is distinct from coalesce(b -> 'closed', 'false'::jsonb)
       and not (private.tp(p, 'entry.close') or private.tp(p, 'entry.import')) then
      return 'إقفال اليوم أو فتحه';
    end if;
    if coalesce(a -> 'items', '{}'::jsonb) is distinct from coalesce(b -> 'items', '{}'::jsonb)
       and not (private.tp(p, 'entry.record') or private.tp(p, 'entry.import')) then
      return 'تسجيل المبيعات';
    end if;
  end loop;

  if private.tn_stock(o -> 'stock') <> private.tn_stock(n -> 'stock') and not private.tp(p, 'order.stock') then return 'الجرد'; end if;
  if private.tn_orders(o -> 'orders') <> private.tn_orders(n -> 'orders') and not private.tp(p, 'order.save') then return 'اعتماد الطلبية'; end if;
  if private.tn_events(o -> 'events') <> private.tn_events(n -> 'events') and not private.tp(p, 'setup.events') then return 'المناسبات'; end if;
  if private.tn_schedule(private.tobj(o -> 'cfg')) <> private.tn_schedule(private.tobj(n -> 'cfg')) and not private.tp(p, 'setup.schedule') then return 'جدول الطلب'; end if;
  if private.tn_tracking(private.tobj(o -> 'cfg')) <> private.tn_tracking(private.tobj(n -> 'cfg')) and not private.tp(p, 'setup.tracking') then return 'ما يُسجَّل يومياً'; end if;
  if private.tnum(o -> 'cfg' -> 'tendency', 50) <> private.tnum(n -> 'cfg' -> 'tendency', 50) and not private.tp(p, 'setup.tendency') then return 'ميل النظام'; end if;
  return null;
end $$;

create or replace function private.talabia_guard_perms() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_perms jsonb; v_bad text;
begin
  if (select auth.uid()) is null then return new; end if;           -- SQL Editor / خدمة داخلية
  if private.talabia_is_admin() then return new; end if;           -- المالك
  if new.data is not distinct from old.data then return new; end if;
  select coalesce(r.perms, '{}'::jsonb) into v_perms
    from private.talabia_users t left join private.talabia_roles r on r.id = t.role_id
   where t.user_id = (select auth.uid());
  v_bad := private.talabia_edit_violation(old.data, new.data, coalesce(v_perms, '{}'::jsonb));
  if v_bad is not null then
    raise exception 'غير مسموح: «%» ليس من صلاحيات دورك', v_bad using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function private.tp(jsonb, text), private.tnum(jsonb, numeric), private.tobj(jsonb), private.tarr(jsonb),
  private.tn_products(jsonb), private.tn_days(jsonb), private.tn_stock(jsonb), private.tn_orders(jsonb), private.tn_events(jsonb),
  private.tn_schedule(jsonb), private.tn_tracking(jsonb), private.talabia_edit_violation(jsonb, jsonb, jsonb),
  private.talabia_guard_perms() from public, anon, authenticated;

drop trigger if exists talabia_guard_perms on public.daftar_branches;
create trigger talabia_guard_perms before update on public.daftar_branches
  for each row execute function private.talabia_guard_perms();

-- 10ب) صلاحيات الفروع: «إنشاء فرع» و«تعديل اسم الفرع» يمنحهما المالك لمن يشاء عبر الدور.
--      الحذف وتغيير البراند والمعرّف تبقى للمالك وحده.
create or replace function private.talabia_perm(k text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.talabia_users t join private.talabia_roles r on r.id = t.role_id
                 where t.user_id = (select auth.uid()) and t.active
                   and coalesce(r.perms -> k, 'false'::jsonb) = 'true'::jsonb);
$$;
revoke all on function private.talabia_perm(text) from public, anon;
grant execute on function private.talabia_perm(text) to authenticated;

-- يحلّ محلّ حارس supabase-security.sql: الاسم يتغيّر لمن يحمل «branches.edit»
create or replace function private.talabia_guard_branch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.talabia_is_admin() then return new; end if;
  if new.id is distinct from old.id or new.brand is distinct from old.brand or new.deleted is distinct from old.deleted then
    raise exception 'غير مسموح: تعديل الفرع نفسه للمالك فقط';
  end if;
  if new.name is distinct from old.name and not private.talabia_perm('branches.edit') then
    raise exception 'غير مسموح: «تعديل الفروع» ليس من صلاحيات دورك' using errcode = '42501';
  end if;
  return new;
end $$;

-- إنشاء فرع لمن يحمل «branches.add»: يُضاف الفرع ويُسند إلى منشئه فوراً
create or replace function public.talabia_branch_create(p_row jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_id    text := p_row ->> 'id';
  v_brand text := p_row ->> 'brand';
  v_name  text := btrim(coalesce(p_row ->> 'name', ''));
begin
  if not (private.talabia_is_admin() or private.talabia_perm('branches.add')) then
    raise exception 'غير مسموح: «إنشاء الفروع» ليس من صلاحيات دورك' using errcode = '42501';
  end if;
  if v_id is null or v_id !~ '^[a-z0-9][a-z0-9-]{0,47}$' then raise exception 'معرّف الفرع غير صالح'; end if;
  if v_name = '' or char_length(v_name) > 120 then raise exception 'اسم الفرع غير صالح'; end if;
  if v_brand is null or not exists (select 1 from public.daftar_branches where brand = v_brand) then
    raise exception 'البراند غير معروف';
  end if;
  if exists (select 1 from public.daftar_branches where id = v_id) then raise exception 'يوجد فرعٌ بهذا المعرّف'; end if;
  if jsonb_typeof(p_row -> 'data') is distinct from 'object' then raise exception 'بيانات الفرع غير صالحة'; end if;
  insert into public.daftar_branches (id, brand, name, rev, updated_at, deleted, device, data)
  values (v_id, v_brand, v_name, greatest(1, private.tnum(p_row -> 'rev', 1)::int), now(), false,
          left(p_row ->> 'device', 80), p_row -> 'data');
  update private.talabia_users set branches = array_append(branches, v_id)
   where user_id = (select auth.uid()) and not (v_id = any(branches));
  return v_id;
end $$;
revoke all on function public.talabia_branch_create(jsonb) from public, anon;
grant execute on function public.talabia_branch_create(jsonb) to authenticated;

-- 11) تحقّق: يجب أن يظهر حسابك وبجانبه «المالك»
select u.email as "الحساب",
       case when t.is_owner then 'المالك' else 'مستخدم' end as "الصفة",
       coalesce(r.name, '—') as "الدور",
       case when t.active then 'مفعّل' else 'موقوف' end as "الحالة"
from private.talabia_users t join auth.users u on u.id = t.user_id
left join private.talabia_roles r on r.id = t.role_id
order by t.is_owner desc, u.email;
