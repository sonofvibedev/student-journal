-- Журнал 2.1, п.2: подробный лог для сисадмина — кто входил, что открывал и нажимал, плюс уведомления сисадмину в Telegram.
-- Что кладём: время, пользователь (ФИО, роль, группа на момент события), тип (вход, выход, экран, действие, ошибка), название экрана/кнопки,
-- устройство. Паролей и содержимого чата здесь нет и быть не может: клиент шлёт только названия экранов и подписи кнопок.
-- Хранение 30 дней (ops_cleanup, cron journal-ops-cleanup уже есть). Таблица закрыта от клиентов целиком: запись только через usage_log_batch,
-- чтение только сисадмину через sysadmin_usage_log.
-- Откат: supabase/migrations_down/20261121100000_journal21_usage_log.down.sql.

-- ===================================================================================================
-- 1. События
-- ===================================================================================================
create table public.usage_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  user_name   text,
  role        text,
  group_id    uuid,
  group_name  text,
  kind        text not null check (kind in ('login', 'logout', 'screen', 'action', 'error')),
  name        text,
  device      text,
  device_id   text,
  new_device  boolean not null default false
);
create index usage_events_at_idx on public.usage_events (at desc);
create index usage_events_user_idx on public.usage_events (user_id, at desc);
alter table public.usage_events enable row level security;
revoke all on public.usage_events from public, anon, authenticated;

-- ===================================================================================================
-- 2. Настройки уведомлений сисадмина (по умолчанию: всё важное включено, дайджест выключен)
-- ===================================================================================================
create table public.sysadmin_prefs (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  new_device  boolean not null default true,
  roles       boolean not null default true,
  deletes     boolean not null default true,
  errors      boolean not null default true,
  digest      boolean not null default false
);
alter table public.sysadmin_prefs enable row level security;
revoke all on public.sysadmin_prefs from public, anon, authenticated;

create function public.sysadmin_prefs_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.sysadmin_prefs;
begin
  perform public._assert_sysadmin(false);
  select * into r from public.sysadmin_prefs where user_id = (select auth.uid());
  return jsonb_build_object('new_device', coalesce(r.new_device, true), 'roles', coalesce(r.roles, true), 'deletes', coalesce(r.deletes, true),
                            'errors', coalesce(r.errors, true), 'digest', coalesce(r.digest, false));
end;
$$;

create function public.sysadmin_prefs_set(p_key text, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._assert_sysadmin(true);
  if p_key is null or p_on is null or p_key not in ('new_device', 'roles', 'deletes', 'errors', 'digest') then raise exception 'bad_request' using errcode = '22023'; end if;
  insert into public.sysadmin_prefs (user_id) values ((select auth.uid())) on conflict (user_id) do nothing;
  execute format('update public.sysadmin_prefs set %I = $1 where user_id = $2', p_key) using p_on, (select auth.uid());
end;
$$;

-- Уведомление каждому сисадмину, у которого включён этот вид. Попадает в notifications; бот шлёт в Telegram тем, у кого есть привязка (tg-dispatch раз в минуту).
-- p_key — ключ дедупликации (повторы не плодим). Не бросает: сбой уведомления не должен ронять действие, которое его вызвало.
create function public._sys_alert(p_pref text, p_title text, p_body text, p_key text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
  select s.user_id, null, 'sys_alert', left(p_title, 200), left(p_body, 400), jsonb_build_object('pref', p_pref), p_key
    from public.sysadmins s
    left join public.sysadmin_prefs p on p.user_id = s.user_id
   where case p_pref when 'new_device' then coalesce(p.new_device, true) when 'roles' then coalesce(p.roles, true)
                     when 'deletes' then coalesce(p.deletes, true) when 'errors' then coalesce(p.errors, true)
                     when 'digest' then coalesce(p.digest, false) else false end
  on conflict (user_id, dedupe_key) do nothing;
exception when others then
  null;
end;
$$;

-- ===================================================================================================
-- 3. Запись пачкой (клиент собирает события и шлёт раз в ~20 секунд)
-- ===================================================================================================
-- p_events: [{k: kind, n: name, d: «Android · Chrome», di: id устройства, t: время на клиенте в мс}]. До 60 событий за вызов, не больше 600 в час на пользователя.
-- Время клиента принимаем, только если оно в пределах суток назад (иначе — now()): часы телефона врать могут.
create function public.usage_log_batch(p_events jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text; v_role text; v_gid uuid; v_gname text;
  e jsonb; v_kind text; v_at timestamptz; v_dev text; v_devid text; v_new boolean; n int := 0;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_events) <> 'array' then raise exception 'bad_request' using errcode = '22023'; end if;
  if not public.app_open() then return 0; end if;                              -- техработы: не пишем, клиенту ошибка не нужна
  if (select count(*) from public.usage_events u where u.user_id = v_uid and u.at > now() - interval '1 hour') > 600 then return 0; end if;

  v_name := public._actor_name(v_uid);
  select m.group_id, g.name into v_gid, v_gname
    from public.memberships m join public.groups g on g.id = m.group_id
   where m.user_id = v_uid order by (m.status = 'active') desc, m.created_at limit 1;
  v_role := public._actor_role(v_uid, v_gid);

  for e in select * from jsonb_array_elements(p_events) limit 60 loop
    v_kind := e ->> 'k';
    if v_kind is null or v_kind not in ('login', 'logout', 'screen', 'action', 'error') then continue; end if;
    v_at := case when (e ->> 't') ~ '^\d{10,14}$' and to_timestamp(((e ->> 't')::numeric) / 1000) between now() - interval '1 day' and now()
                 then to_timestamp(((e ->> 't')::numeric) / 1000) else now() end;
    v_dev := nullif(left(btrim(coalesce(e ->> 'd', '')), 60), '');
    v_devid := nullif(left(regexp_replace(coalesce(e ->> 'di', ''), '[^a-zA-Z0-9]', '', 'g'), 16), '');
    v_new := false;
    if v_kind = 'login' and v_devid is not null then
      -- «новое устройство»: у пользователя уже были входы, но с этого устройства ещё не было. Самый первый вход пользователя тревогой не считаем.
      v_new := exists (select 1 from public.usage_events u where u.user_id = v_uid and u.kind = 'login')
               and not exists (select 1 from public.usage_events u where u.user_id = v_uid and u.kind = 'login' and u.device_id = v_devid);
    end if;
    insert into public.usage_events (at, user_id, user_name, role, group_id, group_name, kind, name, device, device_id, new_device)
      values (v_at, v_uid, v_name, v_role, v_gid, v_gname, v_kind, nullif(left(btrim(coalesce(e ->> 'n', '')), 80), ''), v_dev, v_devid, v_new);
    n := n + 1;
    if v_new then
      perform public._sys_alert('new_device', 'Вход с нового устройства',
        concat_ws(', ', v_name, case v_role when 'student' then 'студент' when 'headman' then 'староста' when 'deputy' then 'заместитель старосты' when 'teacher' then 'преподаватель' when 'sysadmin' then 'сисадмин' else v_role end,
                  v_gname) || coalesce(E'\n' || v_dev, ''),
        'dev:' || v_uid || ':' || v_devid);
    end if;
  end loop;
  return n;
end;
$$;

-- ===================================================================================================
-- 4. Лента для сисадмина (фильтры: человек, роль, тип события, даты, поиск)
-- ===================================================================================================
create function public.sysadmin_usage_log(p_user uuid default null, p_role text default null, p_kind text default null,
                                          p_from date default null, p_to date default null, p_q text default null,
                                          p_limit int default 100, p_offset int default 0)
returns table(at timestamptz, kind text, name text, user_id uuid, user_name text, role text, group_name text, device text, new_device boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_q text := nullif(lower(btrim(coalesce(p_q, ''))), '');
begin
  perform public._assert_sysadmin(false);
  if p_kind is not null and p_kind not in ('login', 'logout', 'screen', 'action', 'error') then raise exception 'bad_kind' using errcode = '22023'; end if;
  return query
    select u.at, u.kind, u.name, u.user_id, u.user_name, u.role, u.group_name, u.device, u.new_device
      from public.usage_events u
     where (p_user is null or u.user_id = p_user)
       and (p_role is null or u.role = p_role)
       and (p_kind is null or u.kind = p_kind)
       and (p_from is null or u.at >= p_from::timestamptz)
       and (p_to is null or u.at < (p_to + 1)::timestamptz)
       and (v_q is null or lower(concat_ws(' ', u.user_name, u.name, u.group_name, u.device)) like '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
     order by u.at desc, u.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Люди, у которых есть события (для выпадающего списка «Пользователь»)
create function public.sysadmin_usage_people()
returns table(user_id uuid, user_name text, role text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._assert_sysadmin(false);
  return query select distinct on (u.user_id) u.user_id, u.user_name, u.role from public.usage_events u where u.user_id is not null order by u.user_id, u.at desc;
end;
$$;

-- ===================================================================================================
-- 5. Мгновенные уведомления: роли, удаления, ошибки
-- ===================================================================================================
create function public.usage_audit_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_who text := public._actor_name(new.actor);
begin
  if new.action in ('set_group_role', 'teacher_assign', 'sysadmin_add', 'sysadmin_bootstrap', 'registration_approve', 'membership_approve', 'homework_access_set') then
    perform public._sys_alert('roles', 'Выдана роль или доступ', v_who || ': ' || new.action || coalesce(' ' || nullif(new.details::text, '{}'), ''), 'audit:' || new.id);
  elsif new.action ~ '(remove|erase|erasure|delete)' then
    perform public._sys_alert('deletes', 'Удаление', v_who || ': ' || new.action || coalesce(' ' || nullif(new.details::text, '{}'), ''), 'audit:' || new.id);
  end if;
  return null;
end;
$$;
create trigger audit_log_usage_alert after insert on public.audit_log
  for each row execute function public.usage_audit_alert();

create function public.usage_cancel_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._sys_alert('deletes', 'Отменён пропуск', public._actor_name(new.cancelled_by) || ': ' || coalesce(new.absence ->> 'subject', 'без предмета') || ', ' || coalesce(new.absence ->> 'date', ''), 'cancel:' || new.id);
  return null;
end;
$$;
create trigger absence_cancellations_usage_alert after insert on public.absence_cancellations
  for each row execute function public.usage_cancel_alert();

-- Ошибки: не чаще одного уведомления на название ошибки в полчаса
create function public.usage_error_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'error' then
    perform public._sys_alert('errors', 'Ошибка в журнале', concat_ws(': ', new.source, new.name, left(new.message, 160)),
      'err:' || md5(coalesce(new.source, '') || coalesce(new.name, '')) || ':' || floor(extract(epoch from now()) / 1800)::bigint);
  end if;
  return null;
end;
$$;
create trigger client_events_usage_alert after insert on public.client_events
  for each row execute function public.usage_error_alert();

-- ===================================================================================================
-- 6. Дайджест за сутки (cron 05:00 UTC = 08:00 по Минску), только тем, у кого он включён
-- ===================================================================================================
create function public.sysadmin_digest()
returns int language plpgsql security definer set search_path = '' as $$
declare v_since timestamptz := now() - interval '24 hours'; v_users int; v_logins int; v_actions int; v_new int; v_err int; v_day text := to_char((now() at time zone 'Europe/Minsk')::date, 'YYYY-MM-DD'); n int;
begin
  select count(distinct user_id), count(*) filter (where kind = 'login'), count(*) filter (where kind = 'action'), count(*) filter (where new_device)
    into v_users, v_logins, v_actions, v_new from public.usage_events where at >= v_since;
  select count(*) into v_err from public.client_events where kind = 'error' and at >= v_since;
  perform public._sys_alert('digest', 'Журнал за сутки',
    'Заходили: ' || v_users || ' чел., входов: ' || v_logins || ', действий: ' || v_actions || ', новых устройств: ' || v_new || ', ошибок: ' || v_err, 'digest:' || v_day);
  select count(*) into n from public.notifications where dedupe_key = 'digest:' || v_day;
  return n;
end;
$$;

-- ===================================================================================================
-- 7. Хранение 30 дней и права
-- ===================================================================================================
create or replace function public.ops_cleanup()
returns integer language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.client_events e where e.at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from public.usage_events u where u.at < now() - interval '30 days';
  return n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['usage_audit_alert()', 'usage_cancel_alert()', 'usage_error_alert()', '_sys_alert(text, text, text, text)', 'sysadmin_digest()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['usage_log_batch(jsonb)', 'sysadmin_usage_log(uuid, text, text, date, date, text, int, int)', 'sysadmin_usage_people()', 'sysadmin_prefs_get()', 'sysadmin_prefs_set(text, boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  grant execute on function public.sysadmin_digest() to service_role;
end $$;

do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron нет: задание journal-sysadmin-digest не создано';
    return;
  end if;
  perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'journal-sysadmin-digest';
  perform cron.schedule('journal-sysadmin-digest', '0 5 * * *', 'select public.sysadmin_digest()');
end $$;
