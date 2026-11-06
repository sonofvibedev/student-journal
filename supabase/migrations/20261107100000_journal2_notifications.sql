-- Журнал 2.0, этап 3: очередь уведомлений в Telegram, настройки уведомлений, перепривязка бота,
-- ежедневные уведомления (горящие задания, срок справки, конец семестра), порог деканата, cron.
--
-- Контракт: docs/stage3-contract.md, раздел «База». Подробно (матрица прав, RPC, до → после, риски,
-- чек-лист): docs/stage3-db.md. Откат: supabase/migrations_down/20261107100000_journal2_notifications.down.sql.
--
-- ВНИМАНИЕ (cron). Секрета в файле нет: задания читают его из Vault (cron_secret), как send-reminders
-- (20261001181000_reminders_cron.sql). Адрес ниже — прод; тестовая копия миграций подменяет ref
-- (tools/test/apply-migrations.sh). Без pg_cron, pg_net или Vault задания не создаются (notice), остальное
-- применяется.

-- ===================================================================================================
-- 1. Очередь Telegram в notifications
-- ===================================================================================================
-- Старые строки получают 'skipped' (константный default заполняет их без перезаписи таблицы),
-- затем default меняется на 'pending' для новых.
alter table public.notifications
  add column dedupe_key    text,
  add column tg_status     text not null default 'skipped'
                           constraint notifications_tg_status_check
                           check (tg_status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  add column tg_sent_at    timestamptz,
  add column tg_attempts   int not null default 0,
  add column tg_claimed_at timestamptz,          -- когда строку забрал tg_claim_notifications (для «зависших»)
  add column tg_error      text;                 -- последняя ошибка отправки (p_error из tg_notification_done)
alter table public.notifications alter column tg_status set default 'pending';

-- Уникальность ключа на пользователя. Обычный (не частичный) unique: null-ключи различны и не мешают,
-- а Edge Function может писать upsert(..., { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true }).
alter table public.notifications add constraint notifications_dedupe_unique unique (user_id, dedupe_key);
-- Очередь: маленький частичный индекс (sent/skipped/failed в него не попадают)
create index notifications_tg_queue_idx on public.notifications (created_at) where tg_status in ('pending', 'sending');

-- Повторный insert с тем же (user_id, dedupe_key) молча пропускается (и обычный insert, не только on conflict).
-- Строки, вставленные раньше в том же операторе, видны (функция volatile), поэтому дубль внутри одного
-- insert ... select тоже отбрасывается. Одновременные вставки держит unique-ограничение.
create function public.notifications_dedupe()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.notifications n where n.user_id = new.user_id and n.dedupe_key = new.dedupe_key) then
    return null;
  end if;
  return new;
end;
$$;
create trigger notifications_dedupe before insert on public.notifications
  for each row when (new.dedupe_key is not null) execute function public.notifications_dedupe();

-- ===================================================================================================
-- 2. Настройки уведомлений и перепривязка Telegram
-- ===================================================================================================

-- Нет строки = тип включён. Выключенный тип не уходит в Telegram, в колокольчике остаётся.
create table public.notification_prefs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind    text not null check (kind in ('deadline_soon', 'task', 'schedule', 'grade', 'absence', 'dean_threshold',
                                        'certificate', 'chat', 'semester', 'import_failed')),
  enabled boolean not null,
  primary key (user_id, kind)
);

-- Экран «Журнал обновился»: строку заводит tg_reset_all, гасит tg_rebind_dismiss или tg-bot (service_role).
create table public.tg_rebind (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  old_telegram_id bigint,
  requested_at    timestamptz not null default now(),
  broadcast_at    timestamptz,
  dismissed_at    timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['notification_prefs', 'tg_rebind'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format(
      'create policy "Техработы" on public.%I as restrictive for all to anon, authenticated using ((select public.app_open())) with check ((select public.app_open()))',
      t);
  end loop;
end $$;

grant select, insert, update, delete on public.notification_prefs to authenticated;
create policy "Настройки уведомлений: свои" on public.notification_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select on public.tg_rebind to authenticated;
create policy "Перепривязка Telegram: своя" on public.tg_rebind for select to authenticated
  using (user_id = (select auth.uid()));

-- ===================================================================================================
-- 3. RPC Telegram для клиента
-- ===================================================================================================

-- Код привязки: теперь любой пользователь с active-членством (раньше — только со строкой profiles,
-- то есть только 24ДММ-2). Код, срок, одноразовость, хэш — как раньше. Ошибка по-прежнему 'no_profile'
-- (её текст уже знает profile.js).
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
  if not exists (select 1 from public.memberships m where m.user_id = uid and m.status = 'active') then
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

-- Сброс всех привязок (смена бота). Только сисадмин. → {reset, rebind}
-- reset  — сколько привязок удалено; rebind — сколько строк tg_rebind заведено или переоткрыто.
-- С привязкой: строка tg_rebind переоткрывается (old_telegram_id, requested_at = now(), broadcast/dismissed = null),
--   привязка и коды пользователя удаляются.
-- Active-участники без привязки: строка заводится, если её ещё нет; существующая не трогается. Поэтому
--   повторный вызов ничего не меняет (reset 0, rebind 0) и не теряет old_telegram_id для рассылки.
create function public.tg_reset_all()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_reset int; v_rebind int; v_new int;
begin
  if not public.is_sysadmin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  with l as (
    delete from public.tg_links where true returning user_id, telegram_id
  ), c as (
    delete from public.tg_link_codes k using l where k.user_id = l.user_id
  ), r as (
    insert into public.tg_rebind (user_id, old_telegram_id, requested_at, broadcast_at, dismissed_at)
    select l.user_id, l.telegram_id, now(), null, null from l
    on conflict (user_id) do update
      set old_telegram_id = excluded.old_telegram_id, requested_at = excluded.requested_at,
          broadcast_at = null, dismissed_at = null
    returning 1
  )
  select (select count(*) from l), (select count(*) from r) into v_reset, v_rebind;

  insert into public.tg_rebind (user_id)
  select distinct m.user_id from public.memberships m where m.status = 'active'
  on conflict (user_id) do nothing;
  get diagnostics v_new = row_count;

  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), null, 'tg_reset_all', jsonb_build_object('reset', v_reset, 'rebind', v_rebind + v_new));
  return jsonb_build_object('reset', v_reset, 'rebind', v_rebind + v_new);
end;
$$;

-- «Пропустить, привяжу позже»: своя строка, если ещё не погашена
create function public.tg_rebind_dismiss()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  update public.tg_rebind set dismissed_at = now() where user_id = auth.uid() and dismissed_at is null;
end;
$$;

-- ===================================================================================================
-- 4. Очередь для Edge Function tg-dispatch (только service_role)
-- ===================================================================================================
-- Одновременные вызовы не получают одну строку дважды: выборка идёт с FOR UPDATE SKIP LOCKED, и строка
-- в том же операторе становится 'sending'. Второй вызов либо пропускает строку, пока она заблокирована,
-- либо (после коммита первого) уже не видит её среди 'pending'. Перепроверки строк при SKIP LOCKED нет:
-- заблокированная строка просто пропускается. Предварительные update тоже берут строки через SKIP LOCKED,
-- поэтому вызовы друг друга не ждут.
create function public.tg_claim_notifications(p_limit int default 100)
returns table(id uuid, user_id uuid, kind text, title text, body text, ref jsonb, telegram_id bigint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  -- 1. «Зависшие» (функция упала после claim): старше 5 минут → снова в очередь, после 3 попыток — failed
  update public.notifications n
     set tg_status = case when n.tg_attempts >= 3 then 'failed' else 'pending' end
   where n.id in (select x.id from public.notifications x
                   where x.tg_status = 'sending' and x.tg_claimed_at < now() - interval '5 minutes'
                   for update skip locked);

  -- 2. Без привязки или с выключенным типом — в Telegram не уходят
  update public.notifications n
     set tg_status = 'skipped'
   where n.id in (select x.id from public.notifications x
                   where x.tg_status = 'pending'
                     and (not exists (select 1 from public.tg_links l where l.user_id = x.user_id)
                          or exists (select 1 from public.notification_prefs p
                                      where p.user_id = x.user_id and p.kind = x.kind and not p.enabled))
                   for update skip locked);

  -- 3. Забрать самые старые
  return query
  with c as (
    select x.id from public.notifications x
     where x.tg_status = 'pending'
       and exists (select 1 from public.tg_links l where l.user_id = x.user_id)
     order by x.created_at, x.id
     limit least(greatest(coalesce(p_limit, 100), 1), 500)
     for update skip locked
  ), u as (
    update public.notifications n
       set tg_status = 'sending', tg_attempts = n.tg_attempts + 1, tg_claimed_at = now()
      from c
     where n.id = c.id
    returning n.id, n.user_id, n.kind, n.title, n.body, n.ref, n.created_at
  )
  select u.id, u.user_id, u.kind, u.title, u.body, u.ref, l.telegram_id
    from u join public.tg_links l on l.user_id = u.user_id
   order by u.created_at, u.id;
end;
$$;

-- Итог отправки. ok → sent; иначе снова pending, а после 3 попыток — failed.
-- Принимается для 'sending' и 'pending' (поздний ответ после возврата «зависшей» строки в очередь).
create function public.tg_notification_done(p_id uuid, p_ok boolean, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.notifications
     set tg_status  = case when coalesce(p_ok, false) then 'sent' when tg_attempts >= 3 then 'failed' else 'pending' end,
         tg_sent_at = case when coalesce(p_ok, false) then now() else tg_sent_at end,
         tg_error   = case when coalesce(p_ok, false) then null else left(p_error, 500) end
   where id = p_id and tg_status in ('sending', 'pending');
$$;

-- ===================================================================================================
-- 5. Ежедневные уведомления (cron 09:00 по Минску; service_role)
-- ===================================================================================================
-- «Сегодня» и «завтра» — по Минску. Только active-группы и active-членства. Повтор в тот же день ничего
-- не добавляет (dedupe_key). В ключ входит дата срока: перенесённый срок напомнит ещё раз, а ключ
-- конца семестра не «залипает» на следующий семестр.
--   deadline_soon: задания со сроком завтра → active-студентам группы; при rec.subgroup = 1/2 — кроме
--     выбравших другую подгруппу (то же правило, что tasks_notify); кроме отметивших выполнение
--     (app_events homework_done / deadline_done). Ключ deadline:<task id>:<срок>.
--   certificate: справки в статусе waiting со сроком завтра → студенту (без ФИО) и старосте/заму (с ФИО;
--     своя справка старосты — одно уведомление, студенческое). Ключ cert-due:<id>:<срок>.
--   semester: до schedule_meta.semester_end 8–14 дней → «14», 1–7 дней → «7» (окно, а не точный день:
--     пропущенный запуск cron не теряет уведомление) → старосте и заму. Ключ semester:<group>:<конец>:<14|7>.
create function public.notify_daily()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Europe/Minsk')::date;
  v_tom   text := to_char((now() at time zone 'Europe/Minsk')::date + 1, 'YYYY-MM-DD');
  n_dl int; n_cert int; n_sem int;
begin
  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
  select m.user_id, t.group_id, 'deadline_soon',
         case t.kind when 'deadline' then 'Завтра дедлайн' else 'Завтра сдавать задание' end,
         left(concat_ws(': ', nullif(btrim(t.rec ->> 'subject'), ''), nullif(btrim(t.rec ->> 'text'), '')), 300),
         jsonb_build_object('task_id', t.id, 'kind', t.kind, 'due', v_tom),
         'deadline:' || t.id || ':' || v_tom
    from public.tasks t
    join public.groups g on g.id = t.group_id and g.status = 'active'
    join public.memberships m on m.group_id = t.group_id and m.status = 'active' and m.base_role = 'student'
    left join public.students s on s.id = m.student_id and s.group_id = m.group_id
   where left(t.rec ->> 'dueDate', 10) = v_tom
     and not (coalesce(t.rec ->> 'subgroup', '') in ('1', '2') and s.subgroup is not null
              and s.subgroup::text <> t.rec ->> 'subgroup')
     and not exists (select 1 from public.app_events e
                      where e.user_id = m.user_id and e.ref = t.id and e.kind in ('homework_done', 'deadline_done'))
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n_dl = row_count;

  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
  select m.user_id, c.group_id, 'certificate', 'Завтра срок сдачи справки',
         case when m.base_role = 'student' and m.student_id = c.student_id then c.what else c.name || ': ' || c.what end,
         jsonb_build_object('certificate_id', c.id, 'status', c.status, 'student_id', c.student_id, 'due', c.due_date),
         'cert-due:' || c.id || ':' || c.due_date
    from (select c.*, concat_ws(' ', s.last_name, s.first_name) as name,
                 concat_ws(', ',
                   case c.kind when 'sick' then 'Больничный' when 'statement' then 'Заявление' else 'Справка' end,
                   case when c.date_from is not null or c.date_to is not null
                        then concat_ws('–', to_char(c.date_from, 'DD.MM.YYYY'), to_char(c.date_to, 'DD.MM.YYYY')) end) as what
            from public.certificates c
            join public.groups g on g.id = c.group_id and g.status = 'active'
            join public.students s on s.id = c.student_id and s.group_id = c.group_id
           where c.status = 'waiting' and c.due_date = v_today + 1) c
    join public.memberships m on m.group_id = c.group_id and m.status = 'active'
     and ((m.base_role = 'student' and m.student_id = c.student_id) or m.extra_role in ('headman', 'deputy'))
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n_cert = row_count;

  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
  select m.user_id, sm.group_id, 'semester', 'Скоро конец семестра',
         'Последний день семестра — ' || to_char(sm.semester_end, 'DD.MM.YYYY') || ' (через ' || (sm.semester_end - v_today) || ' дн.)',
         jsonb_build_object('semester_end', sm.semester_end, 'days_left', sm.semester_end - v_today),
         'semester:' || sm.group_id || ':' || sm.semester_end || ':' || case when sm.semester_end - v_today > 7 then '14' else '7' end
    from public.schedule_meta sm
    join public.groups g on g.id = sm.group_id and g.status = 'active'
    join public.memberships m on m.group_id = sm.group_id and m.status = 'active' and m.extra_role in ('headman', 'deputy')
   where sm.semester_end - v_today between 1 and 14
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n_sem = row_count;

  return jsonb_build_object('deadline_soon', n_dl, 'certificate', n_cert, 'semester', n_sem);
end;
$$;

-- ===================================================================================================
-- 6. Порог деканата: триггер на absences
-- ===================================================================================================
-- Неуважительные часы студента за текущий календарный месяц по Минску — тот же расчёт, что absence_hours_my.
-- Уровень по сумме после изменения: ≥ dean_hours → 'dean', ≥ warn_hours → 'warn'. Один раз на уровень и месяц
-- (ключ dean:<student>:<YYYY-MM>:<warn|dean>); сразу через оба порога — только 'dean'. Кому: студент (текст без
-- чужих данных), староста и зам группы (с ФИО). Только active-группы. Уважительный пропуск, пропуск не в текущем
-- месяце или сумма ниже порога — ничего. Пропуски задним числом за прошлые месяцы не оцениваются.
create function public.absences_dean_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_from  date := date_trunc('month', now() at time zone 'Europe/Minsk')::date;
  v_to    date := (date_trunc('month', now() at time zone 'Europe/Minsk') + interval '1 month')::date;
  g       public.groups;
  v_h     numeric;
  v_level text;
  v_body  text;
  v_name  text;
begin
  if new.date is null or new.date < v_from or new.date >= v_to then
    return null;
  end if;
  select * into g from public.groups where id = new.group_id and status = 'active';
  if not found then
    return null;
  end if;
  select coalesce(sum(a.hours), 0) into v_h
    from public.absences a
   where a.group_id = new.group_id and a.student_id = new.student_id and not a.is_excused
     and a.date >= v_from and a.date < v_to;
  v_level := case when v_h >= g.dean_hours then 'dean' when v_h >= g.warn_hours then 'warn' end;
  if v_level is null then
    return null;
  end if;
  v_body := trim_scale(v_h)::text || ' ч неуважительных пропусков за '
         || (array['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь',
                   'октябрь', 'ноябрь', 'декабрь'])[extract(month from v_from)::int]
         || ' (предупреждение — ' || g.warn_hours || ' ч, деканат — ' || g.dean_hours || ' ч)';
  select concat_ws(' ', s.last_name, s.first_name) into v_name
    from public.students s where s.id = new.student_id and s.group_id = new.group_id;

  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
  select m.user_id, new.group_id, 'dean_threshold',
         case v_level when 'dean' then 'Достигнут порог деканата' else 'Приближение к порогу деканата' end,
         case when m.base_role = 'student' and m.student_id = new.student_id then v_body else v_name || ': ' || v_body end,
         jsonb_build_object('student_id', new.student_id, 'month', to_char(v_from, 'YYYY-MM'), 'level', v_level, 'hours', v_h),
         'dean:' || new.student_id || ':' || to_char(v_from, 'YYYY-MM') || ':' || v_level
    from public.memberships m
   where m.group_id = new.group_id and m.status = 'active'
     and ((m.base_role = 'student' and m.student_id = new.student_id) or m.extra_role in ('headman', 'deputy'))
  on conflict (user_id, dedupe_key) do nothing;
  return null;
end;
$$;
create trigger absences_dean_notify after insert or update of hours, is_excused, date on public.absences
  for each row when (not new.is_excused) execute function public.absences_dean_notify();

-- ===================================================================================================
-- 7. Права на функции
-- ===================================================================================================
do $$
declare f text;
begin
  -- триггерные: никому из клиентов
  foreach f in array array['notifications_dedupe()', 'absences_dean_notify()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- служебные: только service_role (cron вызывает notify_daily владельцем)
  foreach f in array array['tg_claim_notifications(int)', 'tg_notification_done(uuid, boolean, text)', 'notify_daily()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- клиентские: authenticated (права внутри по auth.uid())
  foreach f in array array['tg_reset_all()', 'tg_rebind_dismiss()', 'tg_create_link_code()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ===================================================================================================
-- 8. pg_cron (06:00 UTC = 09:00 Минск, 00:00 UTC = 03:00 Минск: в Беларуси круглый год UTC+3)
-- ===================================================================================================
-- Повторный запуск пересоздаёт задания (unschedule по имени). net.http_post асинхронный: ошибка или 404
-- функции попадает в net._http_response и cron.job_run_details и больше ни на что не влияет.
do $$
begin
  if to_regclass('cron.job') is null or to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron, pg_net или Vault нет: задания journal-* этапа 3 не созданы';
    return;
  end if;
  perform cron.unschedule(j.jobname) from cron.job j
    where j.jobname in ('journal-tg-dispatch', 'journal-schedule-nightly', 'journal-notify-daily');

  perform cron.schedule('journal-tg-dispatch', '* * * * *', $job$
    select net.http_post(
      url := 'https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/tg-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $job$);

  perform cron.schedule('journal-schedule-nightly', '0 0 * * *', $job$
    select net.http_post(
      url := 'https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/schedule-nightly',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$);

  perform cron.schedule('journal-notify-daily', '0 6 * * *', 'select public.notify_daily()');
end $$;
