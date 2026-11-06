-- Журнал 2.0, этап 6: удаление персональных данных по просьбе студента и выпускников через год после выпуска
-- (раздел 5 ТЗ: «удаление по запросу, данные выпускников удаляются через год после выпуска; формулировки сверить
-- с деканатом»).
--
-- Студент подаёт заявку, староста или заместитель решает (заявку самого старосты/зама — только сисадмин), одобрение
-- сразу стирает. Сисадмин может стереть студента напрямую. Стирание: запись students обезличивается (пропуски, справки
-- и оценки остаются для статистики группы и отчёта деканата, но без связи с человеком), аккаунт удаляется, личное
-- (события, значки, игры, уведомления, Telegram, чат) удаляется, ФИО вычищается из текстов.
-- Выпуск: sysadmin_set_group_status(…, 'graduated'); через год graduates_cleanup() (cron journal-graduates)
-- стирает всех студентов группы, аккаунты студентов и старост, расписание и задания; преподаватели и сисадмины
-- остаются (у преподавателя снимается только членство в этой группе).
-- Что удаляется, что остаётся и почему, риски: docs/stage6-db.md. Откат: supabase/migrations_down/20261111100000_journal2_erasure.down.sql
-- (схема возвращается, стёртые данные — нет).

-- ===================================================================================================
-- 1. Схема
-- ===================================================================================================

alter table public.groups add column erased_at timestamptz;
alter table public.students add column erased_at timestamptz;

-- 'erased' — запись обезличена: не свободна (экран «выберите себя» в join-group показывает только 'free',
-- claim требует 'free'), ни к кому не привязана
alter table public.students drop constraint students_claim_status_check;
alter table public.students add constraint students_claim_status_check
  check (claim_status in ('free', 'pending', 'active', 'erased'));

-- Заявки на удаление. user_id переживает удаление аккаунта (set null): строка остаётся следом решения.
-- Статусы: pending → done (одобрено и стёрто в той же транзакции) | rejected | withdrawn (отозвал сам студент).
create table public.data_deletion_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete set null,
  group_id    uuid not null references public.groups (id),
  student_id  text not null,
  status      text not null default 'pending' check (status in ('pending', 'done', 'rejected', 'withdrawn')),
  created_at  timestamptz not null default now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  note        text check (length(note) <= 500),
  foreign key (student_id, group_id) references public.students (id, group_id)
);
-- Одна открытая заявка на пользователя
create unique index data_deletion_requests_one_open on public.data_deletion_requests (user_id) where status = 'pending';
create index data_deletion_requests_group_idx on public.data_deletion_requests (group_id, status);

alter table public.data_deletion_requests enable row level security;
revoke all on public.data_deletion_requests from public, anon, authenticated;
create policy "Техработы" on public.data_deletion_requests as restrictive for all to anon, authenticated
  using ((select public.app_open())) with check ((select public.app_open()));
-- Чтение: своя заявка, староста/зам группы, сисадмин. Запись — только RPC.
grant select on public.data_deletion_requests to authenticated;
create policy "Заявки на удаление: чтение" on public.data_deletion_requests for select to authenticated
  using (user_id = (select auth.uid()) or public.is_group_staff(group_id));

-- ===================================================================================================
-- 2. Стёртая запись студента неизменна и не получает новых данных
-- ===================================================================================================

-- Любой update стёртой строки молча пропускается (легаси-импорт 24ДММ-2, сброс привязки, join-group и т. п.
-- не «оживят» запись: claim_status и claimed_by остаются как после стирания)
create function public.students_erased_freeze()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.erased_at is not null then
    return null;
  end if;
  return new;
end;
$$;
create trigger students_erased_freeze before update on public.students
  for each row execute function public.students_erased_freeze();

-- Новая строка про стёртого студента: клиенту — ошибка student_erased; сервисным писателям (легаси-импорт,
-- пересчёт значков) — строка молча пропускается, чтобы не ронять их целиком
create function public.erased_student_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.students s where s.id = new.student_id and s.erased_at is not null) then
    if current_user in ('authenticated', 'anon') then
      raise exception 'student_erased' using errcode = '42501';
    end if;
    return null;
  end if;
  return new;
end;
$$;
create trigger erased_student_guard before insert on public.absences
  for each row execute function public.erased_student_guard();
create trigger erased_student_guard before insert on public.grades
  for each row execute function public.erased_student_guard();
create trigger erased_student_guard before insert on public.certificates
  for each row execute function public.erased_student_guard();
create trigger erased_student_guard before insert on public.student_achievements
  for each row execute function public.erased_student_guard();

-- ===================================================================================================
-- 3. Стирание студента (внутреннее)
-- ===================================================================================================

-- Удаление аккаунтов: легаси-таблицы Telegram и рассылок без FK (по telegram id и адресу push), аватар, auth.users.
-- Кого удалять, решает вызывающий (сисадминов и преподавателей сюда не передают).
create function public._delete_accounts(p_users uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_tg text[]; v_txt text[]; n int;
begin
  if coalesce(cardinality(p_users), 0) = 0 then
    return 0;
  end if;
  select coalesce(array_agg(u::text), '{}') into v_txt from unnest(p_users) u;
  select coalesce(array_agg(distinct x.t::text), '{}') into v_tg from (
    select l.telegram_id as t from public.tg_links l where l.user_id = any (p_users)
    union select r.old_telegram_id from public.tg_rebind r where r.user_id = any (p_users)
    union select k.telegram_id from public.tg_task_log k where k.user_id = any (p_users)
  ) x where x.t is not null;
  delete from public.tg_subscribers t where t.chat_id::text = any (v_tg) or t.tg_user_id::text = any (v_tg);
  delete from public.tg_dialog_state t where t.telegram_id::text = any (v_tg);
  delete from public.tg_task_log t where t.user_id = any (p_users) or t.telegram_id::text = any (v_tg);
  delete from public.tg_action_log t where t.actor_user_id = any (p_users) or t.actor = any (select 'tg:' || x from unnest(v_tg) x);
  delete from public.tg_task_requests t where t.author_user_id = any (p_users);
  delete from public.notify_log n
   where n.target = any (select 'tg:' || x from unnest(v_tg) x)
      or n.target in (select p.endpoint from public.push_subscriptions p where p.user_id = any (p_users));
  -- почта (логин) аккаунта в журнале действий (sysadmin-user пишет email)
  update public.audit_log a set details = a.details - 'email'
   where a.details ? 'email' and a.details ->> 'user_id' = any (v_txt);
  -- Аватар: только строка метаданных (файл становится недоступен; сам объект удаляет лишь Storage API —
  -- см. риски в docs/stage6-db.md). Флаг storage.allow_delete_query — на эту транзакцию и сразу снимается.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects o where o.bucket_id = 'avatars' and split_part(o.name, '.', 1) = any (v_txt);
  perform set_config('storage.allow_delete_query', 'false', true);
  -- Каскад: memberships, consents, notifications, notification_prefs, tg_links, tg_link_codes, tg_rebind,
  -- push_subscriptions, pass_tokens, profiles, app_events, registration_requests (свои), chat_keys/threads/messages/reads;
  -- students.claimed_by и data_deletion_requests.user_id → null
  delete from auth.users u where u.id = any (p_users);
  get diagnostics n = row_count;
  return n;
end;
$$;
-- Идемпотентно: стёртая запись → {already: true}, ничего не меняется. Запись блокируется for update, поэтому
-- два одновременных стирания одного студента выполняются по очереди, второе видит already.
-- Аккаунты записи: привязанный (claimed_by), членства группы с этой записью, легаси-профиль. Аккаунт удаляется
-- из auth.users, только если у него нет другой жизни: не сисадмин и нет active/pending-членства в другой группе
-- (преподаватель или студент другой группы). Такой аккаунт остаётся, у него снимается только эта группа.
-- Порядок: тексты чистятся по старому ФИО → личное удаляется → аккаунты удаляются → запись обезличивается.
create function public._erase_student(p_group uuid, p_student text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  G constant uuid := '00000000-0000-4000-8000-000000000024';
  s public.students;
  v_users uuid[];
  v_del uuid[];
  v_last text;
  v_first text;
  v_new_first text;
begin
  select * into s from public.students where id = p_student and group_id = p_group for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if s.erased_at is not null then
    return jsonb_build_object('student_id', s.id, 'already', true, 'accounts_deleted', 0, 'accounts_kept', 0);
  end if;

  select coalesce(array_agg(distinct x.u), '{}') into v_users from (
    select s.claimed_by as u
    union select m.user_id from public.memberships m where m.group_id = p_group and m.student_id = s.id
    union select p.user_id from public.profiles p where p.student_id = s.id
  ) x where x.u is not null;
  select coalesce(array_agg(u), '{}') into v_del from unnest(v_users) u
   where not exists (select 1 from public.sysadmins a where a.user_id = u)
     and not exists (select 1 from public.memberships m
                      where m.user_id = u and m.group_id <> p_group and m.status in ('active', 'pending'));

  -- 3.1 ФИО в текстах. Строки ищутся по фамилии и имени (оба есть в тексте); замена дословная (регистр как в записи).
  v_last := nullif(btrim(s.last_name), '');
  v_first := nullif(btrim(s.first_name), '');
  if length(v_last) >= 2 and v_first is not null then
    -- audit_log.details: замена в тексте jsonb; имя с кавычкой или обратной косой чертой сломало бы jsonb — такие
    -- записи не трогаем (см. риски в docs/stage6-db.md)
    if v_last !~ '["\\]' and v_first !~ '["\\]' then
      update public.audit_log a
         set details = replace(replace(a.details::text, v_last, 'Удалён'), v_first, 'студент')::jsonb
       where strpos(a.details::text, v_last) > 0 and strpos(a.details::text, v_first) > 0;
    end if;
    -- payload заявок группы: элемент списка студентов с этим ФИО → обезличенный; владелец с этой фамилией — без имени и почты
    update public.registration_requests r
       set payload = jsonb_set(r.payload, '{students}', (
             select coalesce(jsonb_agg(case when lower(btrim(coalesce(e ->> 'last_name', e ->> 'lastName'))) = lower(v_last)
                                             and lower(btrim(coalesce(e ->> 'first_name', e ->> 'firstName'))) = lower(v_first)
                                            then jsonb_build_object('last_name', 'Удалён', 'first_name', 'студент')
                                            else e end order by o), '[]'::jsonb)
               from jsonb_array_elements(r.payload -> 'students') with ordinality x(e, o)))
     where r.group_id = p_group and jsonb_typeof(r.payload -> 'students') = 'array';
    update public.registration_requests r
       set payload = jsonb_set(r.payload, '{owner}', (r.payload -> 'owner') - 'name' - 'email')
     where r.group_id = p_group and jsonb_typeof(r.payload -> 'owner') = 'object'
       and strpos(lower(coalesce(r.payload -> 'owner' ->> 'name', '')), lower(v_last)) > 0;
    -- уведомления других людей с ФИО в тексте (справки, порог деканата старосте)
    delete from public.notifications n
     where strpos(n.body, v_last) > 0 and strpos(n.body, v_first) > 0;
  end if;

  -- 3.2 Записи о студенте остаются (статистика, отчёт деканата), свободный текст — нет
  update public.absences set comment = null where student_id = s.id and comment is not null;
  update public.certificates set note = null where student_id = s.id and note is not null;
  update public.grades set comment = null where student_id = s.id and comment is not null;
  -- записи, внесённые удаляемым аккаунтом (староста), становятся «легаси» группы: их правит новый староста
  update public.absences set created_by = null where created_by = any (v_del);
  update public.certificates set created_by = null where created_by = any (v_del);
  update public.tasks set created_by = null where created_by = any (v_del);

  -- 3.3 Личное по записи студента (без FK на аккаунт)
  delete from public.app_events where student_id = s.id;
  delete from public.student_achievements where student_id = s.id;
  delete from public.game_records where student_id = s.id;
  delete from public.word_attempts where student_id = s.id;
  delete from public.assoc_daily_results where student_id = s.id;
  delete from public.remind_log where group_id = p_group and student_id = s.id;
  delete from public.invite_codes where student_id = s.id;
  delete from public.pass_tokens where student_id = s.id;
  delete from public.profiles where student_id = s.id;
  delete from public.tg_task_requests where author_student_id = s.id;
  delete from public.notifications n where n.ref ->> 'student_id' = s.id;

  -- 3.4 Аккаунты, которые остаются: снимается только эта группа
  delete from public.chat_threads t where t.group_id = p_group and t.student_user_id = any (v_users);
  delete from public.notifications n where n.group_id = p_group and n.user_id = any (v_users);
  delete from public.consents c where c.group_id = p_group and c.user_id = any (v_users);
  delete from public.memberships m where m.group_id = p_group and m.user_id = any (v_users);

  -- 3.5 Удаляемые аккаунты
  perform public._delete_accounts(v_del);

  -- 3.6 Запись студента обезличивается (уникальность ФИО в группе: имя с коротким хэшем id, при совпадении — с id)
  begin
    update public.students
       set last_name = 'Удалён', first_name = 'студент-' || left(md5(s.id), 8), telegram = null,
           claimed_by = null, claim_status = 'erased', claimed_at = null, erased_at = now()
     where id = s.id;
  exception when unique_violation then
    update public.students
       set last_name = 'Удалён', first_name = 'студент-' || s.id, telegram = null,
           claimed_by = null, claim_status = 'erased', claimed_at = null, erased_at = now()
     where id = s.id;
  end;
  select first_name into v_new_first from public.students where id = s.id;

  -- 3.7 Легаси-зеркало 24ДММ-2: элемент студента заменяется целиком (без старых ключей telegramUsername, isAdmin…).
  -- Элемент не удаляется: на него ссылаются пропуски в том же jsonb, старый index.html ищет имя по studentId.
  if p_group = G then
    update public.journal_private j
       set students = (select coalesce(jsonb_agg(case when e ->> 'id' = s.id
                                                      then jsonb_build_object('id', s.id, 'lastName', 'Удалён', 'firstName', v_new_first)
                                                      else e end order by o), '[]'::jsonb)
                         from jsonb_array_elements(j.students) with ordinality x(e, o)),
           updated_at = now()
     where j.id = 'main' and jsonb_typeof(j.students) = 'array'
       and exists (select 1 from jsonb_array_elements(j.students) e where e ->> 'id' = s.id);
  end if;

  update public.data_deletion_requests r
     set status = 'done', reviewed_by = coalesce(r.reviewed_by, auth.uid()), reviewed_at = coalesce(r.reviewed_at, now())
   where r.student_id = s.id and r.status = 'pending';

  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'student_erase',
            jsonb_build_object('student_id', s.id, 'accounts_deleted', cardinality(v_del),
                               'accounts_kept', cardinality(v_users) - cardinality(v_del)));
  return jsonb_build_object('student_id', s.id, 'already', false, 'accounts_deleted', cardinality(v_del),
                            'accounts_kept', cardinality(v_users) - cardinality(v_del));
end;
$$;

-- ===================================================================================================
-- 4. RPC (security definer, search_path = ''; ошибки — raise exception '<код>')
-- ===================================================================================================

-- 1. Студент подаёт заявку (active-студент группы, в т. ч. староста/зам). Повтор при открытой заявке возвращает её.
-- Уведомление: заявка студента — старосте и заму группы, заявка старосты/зама — сисадминам.
create function public.request_data_deletion(p_group uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  m public.memberships;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  select * into m from public.memberships
   where user_id = v_uid and group_id = p_group and status = 'active' and base_role = 'student' and student_id is not null;
  if not found then raise exception 'not_student' using errcode = '42501'; end if;
  select r.id into v_id from public.data_deletion_requests r where r.user_id = v_uid and r.status = 'pending';
  if v_id is not null then
    return jsonb_build_object('ok', true, 'request_id', v_id, 'status', 'pending', 'already', true);
  end if;
  insert into public.data_deletion_requests (user_id, group_id, student_id)
    values (v_uid, p_group, m.student_id)
  on conflict (user_id) where status = 'pending' do nothing
  returning id into v_id;
  if v_id is null then                                    -- параллельный вызов успел первым
    select r.id into v_id from public.data_deletion_requests r where r.user_id = v_uid and r.status = 'pending';
    return jsonb_build_object('ok', true, 'request_id', v_id, 'status', 'pending', 'already', true);
  end if;

  if m.extra_role is null then
    insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
    select x.user_id, p_group, 'erasure', 'Заявка на удаление данных',
           'Студент группы просит удалить свои персональные данные. Решение — в кабинете старосты.',
           jsonb_build_object('request_id', v_id), 'erasure:' || v_id
      from public.memberships x
     where x.group_id = p_group and x.status = 'active' and x.extra_role in ('headman', 'deputy')
    on conflict (user_id, dedupe_key) do nothing;
  else
    insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
    select a.user_id, p_group, 'erasure', 'Заявка на удаление данных',
           case m.extra_role when 'headman' then 'Староста' else 'Заместитель старосты' end || ' группы '
             || (select g.name from public.groups g where g.id = p_group)
             || ' просит удалить свои персональные данные. Решает системный администратор.',
           jsonb_build_object('request_id', v_id), 'erasure:' || v_id
      from public.sysadmins a
    on conflict (user_id, dedupe_key) do nothing;
  end if;
  insert into public.audit_log (actor, group_id, action, details)
    values (v_uid, p_group, 'erasure_request', jsonb_build_object('request_id', v_id, 'student_id', m.student_id));
  return jsonb_build_object('ok', true, 'request_id', v_id, 'status', 'pending', 'already', false);
end;
$$;

-- 2. Своя заявка: открытая, иначе последняя (любой статус); заявок нет — null
create function public.my_data_deletion()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  return (select jsonb_build_object('id', r.id, 'group_id', r.group_id, 'status', r.status, 'created_at', r.created_at,
                                    'reviewed_at', r.reviewed_at, 'note', r.note)
            from public.data_deletion_requests r
           where r.user_id = auth.uid()
           order by (r.status = 'pending') desc, r.created_at desc, r.reviewed_at desc nulls last, r.id
           limit 1);
end;
$$;

-- 3. Отозвать свою открытую заявку
create function public.withdraw_data_deletion()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_group uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  update public.data_deletion_requests r set status = 'withdrawn', reviewed_at = now()
   where r.user_id = auth.uid() and r.status = 'pending'
  returning r.id, r.group_id into v_id, v_group;
  if v_id is null then raise exception 'not_pending' using errcode = 'P0002'; end if;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), v_group, 'erasure_withdraw', jsonb_build_object('request_id', v_id));
  return jsonb_build_object('ok', true, 'request_id', v_id);
end;
$$;

-- 4. Заявки группы (староста/зам группы, сисадмин); p_group null — все группы, только сисадмин.
-- requester_role — текущая роль заявителя ('student' | 'headman' | 'deputy'; null — аккаунта или членства уже нет).
-- can_resolve — может ли вызывающий решить заявку.
create function public.data_deletion_requests_list(p_group uuid)
returns table(id uuid, group_id uuid, group_name text, student_id text, student_name text, requester_role text,
              status text, created_at timestamptz, reviewed_at timestamptz, note text, can_resolve boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_sys boolean := public.is_sysadmin();
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_group is null and not v_sys then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_group is not null and not public.is_group_staff(p_group) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  return query
  select r.id, r.group_id, g.name, r.student_id, concat_ws(' ', s.last_name, s.first_name),
         case when m.user_id is null then null else coalesce(m.extra_role, 'student') end,
         r.status, r.created_at, r.reviewed_at, r.note,
         coalesce(r.status = 'pending' and (v_sys or (m.user_id is not null and m.extra_role is null and r.user_id <> auth.uid())), false)
    from public.data_deletion_requests r
    join public.groups g on g.id = r.group_id
    join public.students s on s.id = r.student_id and s.group_id = r.group_id
    left join public.memberships m on m.user_id = r.user_id and m.group_id = r.group_id and m.status = 'active'
   where p_group is null or r.group_id = p_group
   order by (r.status = 'pending') desc, r.created_at desc;
end;
$$;

-- 5. Решение по заявке. Одобрение сразу стирает (_erase_student). Заявку студента решает староста/зам его группы
-- или сисадмин; заявку старосты/зама — только сисадмин. Если запись студента с момента заявки привязана к другому
-- аккаунту (сброс привязки и новый вход) — stale_request: удалился бы не тот человек.
create function public.resolve_data_deletion(p_request uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.data_deletion_requests;
  v_role text;
  v_member boolean;
  v_claimed uuid;
  v_note text := left(nullif(btrim(p_note), ''), 500);
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_approve is null then raise exception 'bad_decision' using errcode = '22023'; end if;
  select * into r from public.data_deletion_requests where id = p_request for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select m.extra_role into v_role from public.memberships m
   where m.user_id = r.user_id and m.group_id = r.group_id and m.status = 'active';
  v_member := found;                                      -- заявитель всё ещё active-участник группы
  if not (public.is_sysadmin()
          or (public.is_group_staff(r.group_id) and r.user_id is distinct from auth.uid()
              and v_member and v_role is null)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  if r.status <> 'pending' then raise exception 'not_pending' using errcode = 'P0001'; end if;

  if p_approve then
    select s.claimed_by into v_claimed from public.students s where s.id = r.student_id and s.group_id = r.group_id;
    if v_claimed is distinct from r.user_id then raise exception 'stale_request' using errcode = 'P0001'; end if;
    perform public._erase_student(r.group_id, r.student_id);
    update public.data_deletion_requests
       set status = 'done', reviewed_by = auth.uid(), reviewed_at = now(), note = v_note
     where id = r.id;
  else
    update public.data_deletion_requests
       set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), note = v_note
     where id = r.id;
    if r.user_id is not null then
      insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
        values (r.user_id, r.group_id, 'erasure', 'Заявка на удаление данных отклонена',
                coalesce(v_note, 'Причина не указана.'), jsonb_build_object('request_id', r.id), 'erasure-rejected:' || r.id)
      on conflict (user_id, dedupe_key) do nothing;
    end if;
  end if;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), r.group_id, 'erasure_resolve',
            jsonb_build_object('request_id', r.id, 'student_id', r.student_id, 'approve', p_approve));
  return jsonb_build_object('ok', true, 'status', case when p_approve then 'done' else 'rejected' end);
end;
$$;

-- 6. Сисадмин стирает студента напрямую (без заявки). Повтор → already: true.
create function public.sysadmin_erase_student(p_student text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_group uuid; v_res jsonb;
begin
  perform public._assert_sysadmin(true);
  select s.group_id into v_group from public.students s where s.id = p_student;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_res := public._erase_student(v_group, p_student);
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), v_group, 'sysadmin_erase_student', jsonb_build_object('student_id', p_student, 'already', v_res -> 'already'));
  return jsonb_build_object('ok', true, 'group_id', v_group) || v_res;
end;
$$;

-- 7. Статус группы: + 'graduated' (выпуск: только просмотр, через год — graduates_cleanup).
-- graduated_at ставится при выпуске (повторный 'graduated' срок не продлевает), сбрасывается при возврате в
-- active/closed. Отметку автозакрытия снимают closed и graduated (как раньше closed). Стёртую группу не меняют.
create or replace function public.sysadmin_set_group_status(p_group uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old text; v_erased timestamptz;
begin
  perform public._assert_sysadmin(true);
  if p_status is null or p_status not in ('active', 'closed', 'graduated') then raise exception 'bad_status' using errcode = '22023'; end if;
  select g.status, g.erased_at into v_old, v_erased from public.groups g where g.id = p_group for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_erased is not null then raise exception 'group_erased' using errcode = 'P0001'; end if;
  update public.groups g
     set status = p_status,
         semester_closed_for = case when p_status in ('closed', 'graduated') then null else g.semester_closed_for end,
         graduated_at = case when p_status <> 'graduated' then null
                             when v_old = 'graduated' then coalesce(g.graduated_at, now())
                             else now() end
   where g.id = p_group;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'group_status', jsonb_build_object('from', v_old, 'to', p_status));
  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

-- 8. Выпускники через год (cron journal-graduates, service_role). Идемпотентно: стёртая группа (erased_at) не
-- выбирается. Группы блокируются for update skip locked (параллельный запуск пропустит занятую).
-- Остаются: строка группы, обезличенные студенты, пропуски, справки, оценки, audit_log — для статистики и
-- отчёта деканата. Удаляются: аккаунты студентов (и старост) без другой группы, членства и назначения
-- преподавателей в этой группе, чат группы, уведомления группы, расписание, темы занятий, задания, учебные дни,
-- код группы; payload заявки на регистрацию.
create function public.graduates_cleanup()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g record;
  st record;
  r jsonb;
  v_del uuid[];
  n_groups int := 0;
  n_students int := 0;
  n_accounts int := 0;
  g_students int;
  g_accounts int;
begin
  for g in
    select gr.id from public.groups gr
     where gr.status = 'graduated' and gr.graduated_at < now() - interval '1 year' and gr.erased_at is null
     order by gr.graduated_at
     for update skip locked
  loop
    g_students := 0; g_accounts := 0;
    for st in select s.id from public.students s where s.group_id = g.id and s.erased_at is null order by s.id loop
      r := public._erase_student(g.id, st.id);
      g_students := g_students + 1;
      g_accounts := g_accounts + (r ->> 'accounts_deleted')::int;
    end loop;
    -- аккаунты студентов группы без записи (не подтверждённые, сброшенные): не сисадмин и нет другой группы
    select coalesce(array_agg(m.user_id), '{}') into v_del
      from public.memberships m
     where m.group_id = g.id and m.base_role = 'student'
       and not exists (select 1 from public.sysadmins a where a.user_id = m.user_id)
       and not exists (select 1 from public.memberships o
                        where o.user_id = m.user_id and o.group_id <> g.id and o.status in ('active', 'pending'));
    g_accounts := g_accounts + public._delete_accounts(v_del);

    delete from public.chat_threads t where t.group_id = g.id;
    delete from public.notifications n where n.group_id = g.id;
    delete from public.consents c where c.group_id = g.id;
    delete from public.teacher_assignments t where t.group_id = g.id;
    delete from public.memberships m where m.group_id = g.id;
    delete from public.schedule_lessons l where l.group_id = g.id;
    delete from public.schedule_meta l where l.group_id = g.id;
    delete from public.lesson_notes l where l.group_id = g.id;
    delete from public.tasks t where t.group_id = g.id;
    delete from public.study_days d where d.group_id = g.id;
    delete from public.remind_log l where l.group_id = g.id;
    delete from public.group_invites i where i.group_id = g.id;
    update public.registration_requests q set payload = jsonb_build_object('erased', true) where q.group_id = g.id;
    update public.groups x set erased_at = now() where x.id = g.id;
    insert into public.audit_log (actor, group_id, action, details)
      values (null, g.id, 'group_erase', jsonb_build_object('students', g_students, 'accounts_deleted', g_accounts));
    n_groups := n_groups + 1;
    n_students := n_students + g_students;
    n_accounts := n_accounts + g_accounts;
  end loop;
  return jsonb_build_object('groups', n_groups, 'students', n_students, 'accounts_deleted', n_accounts);
end;
$$;

-- ===== Права на функции =====
do $$
declare f text;
begin
  -- внутренние и триггерные: никому из клиентов
  foreach f in array array['_erase_student(uuid, text)', '_delete_accounts(uuid[])', 'students_erased_freeze()',
                           'erased_student_guard()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- служебные: только service_role (cron вызывает владельцем)
  revoke all on function public.graduates_cleanup() from public, anon, authenticated;
  grant execute on function public.graduates_cleanup() to service_role;
  -- клиентские: authenticated (права внутри по auth.uid())
  foreach f in array array['request_data_deletion(uuid)', 'my_data_deletion()', 'withdraw_data_deletion()',
                           'data_deletion_requests_list(uuid)', 'resolve_data_deletion(uuid, boolean, text)',
                           'sysadmin_erase_student(text)', 'sysadmin_set_group_status(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ===================================================================================================
-- 5. cron (UTC; Минск круглый год UTC+3): 01:25 UTC = 04:25 по Минску, после journal-semester и journal-ops-cleanup
-- ===================================================================================================
do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron нет: задание journal-graduates не создано';
    return;
  end if;
  perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'journal-graduates';
  perform cron.schedule('journal-graduates', '25 1 * * *', 'select public.graduates_cleanup()');
end $$;
