-- Режим технических работ: пока он включён, доступ к данным есть только у старосты
-- (студент с isAdmin в journal_private.students). Гости и остальные студенты получают
-- пустые ответы и отказ на запись: ограничение на стороне базы, а не только в интерфейсе.
-- Edge Functions ходят секретным ключом в обход RLS, их закрывает maintenanceBlocked() в _shared/common.ts.

-- ===== Настройки приложения =====
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.app_settings (key, value) values ('maintenance', '{"on": false}'::jsonb)
  on conflict (key) do nothing;

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to anon, authenticated;
-- Читать режим может любой, иначе экран техработ не показать. Писать нельзя никому, кроме set_maintenance().
drop policy if exists "Режим техработ виден всем" on public.app_settings;
create policy "Режим техработ виден всем" on public.app_settings
  for select to anon, authenticated using (true);

-- ===== Кто староста =====
create or replace function public.is_journal_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
      join public.journal_private j on j.id = 'main'
      cross join lateral jsonb_array_elements(j.students) s
     where p.user_id = (select auth.uid())
       and s ->> 'id' = p.student_id
       and s ->> 'isAdmin' = 'true'
  );
$$;

-- Открыто ли приложение для вызывающего: режим выключен или это староста
create or replace function public.app_open()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce((select (value ->> 'on')::boolean from public.app_settings where key = 'maintenance'), false) is not true
      or public.is_journal_admin();
$$;

-- Для клиента: включён ли режим и староста ли он (один запрос, работает и без входа)
create or replace function public.maintenance_status()
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'on', coalesce((select (value ->> 'on')::boolean from public.app_settings where key = 'maintenance'), false),
    'admin', public.is_journal_admin()
  );
$$;

-- Включить или выключить режим. Староста всегда проходит app_open(), так что запереть себя не сможет.
-- (Параметр p_on: слово on в Postgres зарезервировано.)
create or replace function public.set_maintenance(p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_journal_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  insert into public.app_settings (key, value, updated_at, updated_by)
    values ('maintenance', jsonb_build_object('on', coalesce(p_on, false)), now(), (select auth.uid()))
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.is_journal_admin() from public;
revoke all on function public.app_open() from public;
revoke all on function public.maintenance_status() from public;
revoke all on function public.set_maintenance(boolean) from public, anon;
-- is_journal_admin и app_open зовутся из политик: роли клиента должны уметь их исполнять
grant execute on function public.is_journal_admin() to anon, authenticated;
grant execute on function public.app_open() to anon, authenticated;
grant execute on function public.maintenance_status() to anon, authenticated;
grant execute on function public.set_maintenance(boolean) to authenticated;

-- ===== Закрывающая политика на каждую таблицу public (кроме app_settings) =====
-- RESTRICTIVE: складывается с существующими политиками через И, их менять не нужно.
-- Таблицы, созданные позже, эту миграцию не получат: добавьте им такую же политику.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename <> 'app_settings' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Техработы" on public.%I', t);
    execute format(
      'create policy "Техработы" on public.%I as restrictive for all to anon, authenticated using ((select public.app_open())) with check ((select public.app_open()))',
      t);
  end loop;
end $$;

-- Аватарки лежат в storage.objects
drop policy if exists "Техработы" on storage.objects;
create policy "Техработы" on storage.objects as restrictive for all to anon, authenticated
  using ((select public.app_open())) with check ((select public.app_open()));

-- ===== Функции, которые студент вызывает напрямую (security definer обходит RLS) =====
-- Тела прежние, добавлена только проверка app_open().

create or replace function public.issue_pass_token()
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_student text;
  v_token text;
  v_expires timestamptz := now() + interval '5 minutes';
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.app_open() then
    raise exception 'maintenance' using errcode = '42501';
  end if;
  select p.student_id into v_student from public.profiles p where p.user_id = v_uid;
  if v_student is null then
    raise exception 'no_profile' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.pass_tokens t where t.user_id = v_uid and t.created_at > now() - interval '10 seconds') then
    raise exception 'too_often' using errcode = 'P0001';
  end if;
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'), '=');
  delete from public.pass_tokens t where t.user_id = v_uid or t.expires_at < now() - interval '1 day';
  insert into public.pass_tokens (token_hash, user_id, student_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_uid, v_student, v_expires);
  return query select v_token, v_expires;
end;
$$;

create or replace function public.tg_create_link_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  uid  uuid := (select auth.uid());
  raw  text := '';
  b    bytea;
  i    int;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if not public.app_open() then
    raise exception 'maintenance' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where user_id = uid) then
    raise exception 'no_profile';
  end if;
  b := extensions.gen_random_bytes(8);
  for i in 0..7 loop
    raw := raw || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
  end loop;
  delete from public.tg_link_codes where user_id = uid or expires_at < now() - interval '1 day';
  insert into public.tg_link_codes (code_hash, user_id, expires_at)
    values (encode(extensions.digest(raw, 'sha256'), 'hex'), uid, now() + interval '10 minutes');
  return substr(raw, 1, 4) || '-' || substr(raw, 5, 4);
end;
$$;

create or replace function public.tg_unlink()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.tg_links where user_id = (select auth.uid()) and public.app_open();
  delete from public.tg_link_codes where user_id = (select auth.uid()) and public.app_open();
$$;

-- Таблицы-рейтинги: при включённых техработах у не-старосты пустой ответ
create or replace function public.rpc_ach_board(exclude_codes text[] default '{}')
returns table (student_id text, badges integer)
language sql
security definer
set search_path = public
stable
as $$
  select sa.student_id, count(*)::integer as badges
    from public.student_achievements sa
   where not (sa.code = any (coalesce(exclude_codes, '{}')))
     and public.app_open()
   group by sa.student_id
   order by badges desc, sa.student_id;
$$;

create or replace function public.rpc_game_points(codes text[], points integer[])
returns table (student_id text, points integer)
language sql
security definer
set search_path = public
stable
as $$
  select sa.student_id, sum(w.points)::integer as points
    from public.student_achievements sa
    join unnest(codes, points) as w(code, points) on w.code = sa.code
   where public.app_open()
   group by sa.student_id
   order by points desc, sa.student_id;
$$;

create or replace function public.rpc_assoc_board(p_day date default null)
returns table (student_id text, points integer, days integer, tries integer)
language sql
security definer
set search_path = public
stable
as $$
  select wa.student_id,
         sum(wa.points)::integer as points,
         count(*) filter (where wa.solved)::integer as days,
         sum(wa.tries)::integer as tries
    from public.word_attempts wa
   where wa.mode = 'ranks'
     and wa.day >= date_trunc('month', coalesce(p_day, current_date))::date
     and wa.day <  (date_trunc('month', coalesce(p_day, current_date)) + interval '1 month')::date
     and public.app_open()
   group by wa.student_id
  having sum(wa.points) > 0
   order by points desc, tries asc, days desc, wa.student_id;
$$;

create or replace function public.rpc_assoc_day_board(p_day date default null)
returns table (student_id text, place integer, points integer, tries integer, finished_at timestamptz, bonus integer)
language sql
security definer
set search_path = public
stable
as $$
  with d as (select coalesce(p_day, (now() at time zone 'Europe/Minsk')::date) as day),
  ranked as (
    select wa.student_id, wa.points, wa.tries, wa.updated_at as finished_at,
           row_number() over (order by wa.points desc, wa.updated_at asc, wa.student_id asc)::integer as place
      from public.word_attempts wa, d
     where wa.day = d.day and wa.mode = 'ranks' and wa.solved and wa.points > 0
       and public.app_open()
  )
  select r.student_id, r.place, r.points, r.tries, r.finished_at,
         coalesce(res.bonus, s.bonus, 0) as bonus
    from ranked r
    cross join d
    left join public.assoc_daily_results res on res.day = d.day and res.student_id = r.student_id
    left join public.assoc_settings s on s.place = r.place
   order by r.place;
$$;

create or replace function public.rpc_assoc_total_board()
returns table (student_id text, bonus integer, wins integer, days integer)
language sql
security definer
set search_path = public
stable
as $$
  select r.student_id,
         sum(r.bonus)::integer as bonus,
         count(*) filter (where r.place = 1)::integer as wins,
         count(*)::integer as days
    from public.assoc_daily_results r
   where public.app_open()
   group by r.student_id
  having sum(r.bonus) > 0
   order by bonus desc, wins desc, count(*) filter (where r.place = 2) desc, days desc, r.student_id;
$$;

-- create or replace сохраняет права из прежних миграций; на всякий случай повторяем их
revoke all on function public.issue_pass_token() from public, anon;
grant execute on function public.issue_pass_token() to authenticated;
-- Не покрыто намеренно: verify_pass_token (только service_role, закрыт в Edge Function verify-pass),
-- tg_submit_request, finalize_assoc_day (service_role), reset_student_access, code_attempts_cleanup,
-- app_events_fill_owner (триггер) — клиенту недоступны.
