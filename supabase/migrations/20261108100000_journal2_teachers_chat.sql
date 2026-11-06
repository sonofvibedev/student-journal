-- Журнал 2.0, этап 4: преподаватели и чат «староста/заместитель ↔ преподаватель» со сквозным шифрованием.
--
-- Контракт: docs/stage4-contract.md («Роли и тестовые аккаунты», «Чат со сквозным шифрованием»).
-- Подробно (матрица прав, RPC, модель угроз, до → после, риски, чек-лист): docs/stage4-db.md.
-- Откат: supabase/migrations_down/20261108100000_journal2_teachers_chat.down.sql.
--
-- Чат: база хранит только открытые ключи, зашифрованные паролем переписки резервные копии закрытых ключей
-- и шифртексты (iv + ciphertext). Расшифровать сообщения сервер не может. Доступ к треду — только двум
-- участникам и только пока их роли актуальны (староста/зам группы ↔ преподаватель с назначением в группе).
-- Сисадмин к чату доступа не имеет (ни строк, ни ключей, ни копий).

-- ===================================================================================================
-- 1. Таблицы
-- ===================================================================================================

-- Ключи переписки: открытый ключ (JWK EC P-256: только kty, crv, x, y) и резервная копия закрытого,
-- зашифрованная на клиенте ключом из пароля переписки. Пишет только chat_keys_publish.
create table public.chat_keys (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  public_jwk  jsonb not null,
  key_version int not null default 1 check (key_version >= 1),
  backup      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Тред: староста или заместитель группы (student_user_id) ↔ преподаватель (teacher_user_id).
-- kind — вид занятий преподавателя (из его base_role) на момент открытия.
create table public.chat_threads (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references public.groups (id),
  student_user_id uuid not null references auth.users (id) on delete cascade,
  teacher_user_id uuid not null references auth.users (id) on delete cascade,
  kind            text not null check (kind in ('lecture', 'practice')),
  created_at      timestamptz not null default now(),
  unique (group_id, student_user_id, teacher_user_id),
  check (student_user_id <> teacher_user_id)
);
create index chat_threads_student_idx on public.chat_threads (student_user_id);
create index chat_threads_teacher_idx on public.chat_threads (teacher_user_id);

-- Сообщения: только шифртекст. iv — 12 байт (16 знаков base64url); ciphertext — до 8192 байт
-- (10923 знака base64url), не короче тега AES-GCM (16 байт = 22 знака).
create table public.chat_messages (
  id                    uuid primary key default gen_random_uuid(),
  thread_id             uuid not null references public.chat_threads (id) on delete cascade,
  sender_id             uuid not null references auth.users (id) on delete cascade,
  sender_key_version    int not null check (sender_key_version >= 1),
  recipient_key_version int not null check (recipient_key_version >= 1),
  iv                    text not null check (iv ~ '^[A-Za-z0-9_-]{16}$'),
  ciphertext            text not null check (length(ciphertext) between 22 and 10923 and ciphertext ~ '^[A-Za-z0-9_-]+$'),
  created_at            timestamptz not null default now()
);
create index chat_messages_thread_idx on public.chat_messages (thread_id, created_at);
create index chat_messages_sender_idx on public.chat_messages (sender_id, created_at);   -- лимит 30/мин

create table public.chat_reads (
  thread_id    uuid not null references public.chat_threads (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

-- Тема и план занятия: пишет преподаватель своей дисциплины и своего вида занятий
create table public.lesson_notes (
  group_id    uuid not null references public.groups (id),
  lesson_date date not null,
  pair_no     smallint not null check (pair_no between 1 and 12),
  subject     text not null check (length(subject) between 1 and 200),
  lesson_kind text not null check (lesson_kind in ('lecture', 'practice')),
  topic       text check (length(topic) <= 200),
  plan        text check (length(plan) <= 4000),
  updated_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  primary key (group_id, lesson_date, pair_no, subject)
);

do $$
declare t text;
begin
  foreach t in array array['chat_keys', 'chat_threads', 'chat_messages', 'chat_reads', 'lesson_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format(
      'create policy "Техработы" on public.%I as restrictive for all to anon, authenticated using ((select public.app_open())) with check ((select public.app_open()))',
      t);
  end loop;
end $$;

-- ===================================================================================================
-- 2. Хелперы чата
-- ===================================================================================================

-- Жив ли тред по ТЕКУЩИМ ролям: студент-сторона — active староста/заместитель группы, преподаватель —
-- active teacher_<kind> группы с назначением этого вида. Сисадмин сюда не проходит (без is_group_staff).
-- Внутренняя: принимает произвольных пользователей, поэтому клиентам закрыта (иначе — справочник ролей).
create function public._chat_live(p_group uuid, p_student uuid, p_teacher uuid, p_kind text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                  where m.user_id = p_student and m.group_id = p_group and m.status = 'active'
                    and m.base_role = 'student' and m.extra_role in ('headman', 'deputy'))
     and exists (select 1 from public.memberships m
                   join public.teacher_assignments ta on ta.user_id = m.user_id and ta.group_id = m.group_id
                                                     and ta.lesson_kind = p_kind
                  where m.user_id = p_teacher and m.group_id = p_group and m.status = 'active'
                    and m.base_role = 'teacher_' || p_kind);
$$;

-- Живые треды вызывающего (для RLS и RPC). Отвечает только про auth.uid(), поэтому клиентам открыта.
create function public.chat_my_thread_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select t.id from public.chat_threads t
   where (t.student_user_id = (select auth.uid()) or t.teacher_user_id = (select auth.uid()))
     and public._chat_live(t.group_id, t.student_user_id, t.teacher_user_id, t.kind);
$$;

-- Строка base64url длиной p_min…p_max (без «=»), декодируемая (длина mod 4 ≠ 1)
create function public._chat_b64u_ok(p text, p_min int, p_max int)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and length(p) between p_min and p_max and p ~ '^[A-Za-z0-9_-]+$' and length(p) % 4 <> 1;
$$;

-- ===================================================================================================
-- 3. Политики
-- ===================================================================================================

-- Ключи: своя строка целиком (в т. ч. своя резервная копия); чужие открытые ключи — только chat_peer_key.
grant select on public.chat_keys to authenticated;
create policy "Ключи чата: своя строка" on public.chat_keys for select to authenticated
  using (user_id = (select auth.uid()));

-- Треды, сообщения, отметки: только участник живого треда. Записи клиента нет (только RPC).
grant select on public.chat_threads, public.chat_messages, public.chat_reads to authenticated;
create policy "Чат: треды участника" on public.chat_threads for select to authenticated
  using (id in (select public.chat_my_thread_ids()));
create policy "Чат: сообщения участника" on public.chat_messages for select to authenticated
  using (thread_id in (select public.chat_my_thread_ids()));
create policy "Чат: свои отметки прочтения" on public.chat_reads for select to authenticated
  using (user_id = (select auth.uid()) and thread_id in (select public.chat_my_thread_ids()));

-- Темы занятий. Колонки updated_by/updated_at ставит триггер; update-права на ключевые колонки нужны
-- для upsert PostgREST (он пишет все колонки запроса), сами значения держит with check.
grant select, delete on public.lesson_notes to authenticated;
grant insert (group_id, lesson_date, pair_no, subject, lesson_kind, topic, plan) on public.lesson_notes to authenticated;
grant update (group_id, lesson_date, pair_no, subject, lesson_kind, topic, plan) on public.lesson_notes to authenticated;
create policy "Темы занятий: чтение" on public.lesson_notes for select to authenticated
  using (public.is_group_reader(group_id) or public.teaches(group_id, subject, lesson_kind));
create policy "Темы занятий: внесение" on public.lesson_notes for insert to authenticated
  with check (public.group_open(group_id)
              and (public.teaches(group_id, subject, lesson_kind) or (select public.is_sysadmin())));
create policy "Темы занятий: изменение" on public.lesson_notes for update to authenticated
  using (public.teaches(group_id, subject, lesson_kind) or (select public.is_sysadmin()))
  with check (public.group_open(group_id)
              and (public.teaches(group_id, subject, lesson_kind) or (select public.is_sysadmin())));
create policy "Темы занятий: удаление" on public.lesson_notes for delete to authenticated
  using (public.group_open(group_id)
         and (public.teaches(group_id, subject, lesson_kind) or (select public.is_sysadmin())));

create function public.lesson_notes_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);   -- клиент не подставит чужого автора
  return new;
end;
$$;
create trigger lesson_notes_touch before insert or update on public.lesson_notes
  for each row execute function public.lesson_notes_touch();

-- ===================================================================================================
-- 4. Преподаватель: задания своих дисциплин; пустая дисциплина больше не значит «любая»
-- ===================================================================================================
-- teaches(g, null, …) = «любая дисциплина». Поэтому строка без дисциплины (subject null / rec.subject пуст)
-- раньше была видна любому преподавателю группы, а в absences преподаватель мог внести или «увести» в null
-- пропуск своего вида. Теперь ветка преподавателя требует непустую дисциплину. Ветки старосты не менялись.

drop policy "Задания: чтение" on public.tasks;
create policy "Задания: чтение" on public.tasks for select to authenticated
  using (public.is_group_reader(group_id)
         or (coalesce(rec ->> 'subject', '') <> '' and public.teaches(group_id, rec ->> 'subject', null)));
create policy "Задания: внесение преподавателем" on public.tasks for insert to authenticated
  with check (created_by = (select auth.uid())
              and coalesce(rec ->> 'subject', '') <> '' and public.teaches(group_id, rec ->> 'subject', null)
              and public.group_open(group_id));
-- только свои; автор не меняется (with check требует себя)
create policy "Задания: изменение преподавателем" on public.tasks for update to authenticated
  using (created_by = (select auth.uid())
         and coalesce(rec ->> 'subject', '') <> '' and public.teaches(group_id, rec ->> 'subject', null))
  with check (created_by = (select auth.uid())
              and coalesce(rec ->> 'subject', '') <> '' and public.teaches(group_id, rec ->> 'subject', null)
              and public.group_open(group_id));
-- свои, старосты/заместителя и легаси (created_by null) — только своей дисциплины
create policy "Задания: удаление преподавателем" on public.tasks for delete to authenticated
  using (public.group_open(group_id)
         and coalesce(rec ->> 'subject', '') <> '' and public.teaches(group_id, rec ->> 'subject', null)
         and (created_by = (select auth.uid()) or created_by is null or public.user_is_staff(group_id, created_by)));

drop policy "Пропуски: чтение" on public.absences;
create policy "Пропуски: чтение" on public.absences for select to authenticated
  using (public.is_group_reader(group_id)
         or (subject is not null and lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)));
drop policy "Пропуски: внесение" on public.absences;
create policy "Пропуски: внесение" on public.absences for insert to authenticated
  with check (created_by = (select auth.uid())
              and public.group_open(group_id)
              and (public.is_group_staff(group_id)
                   or (subject is not null and lesson_kind is not null and public.teaches(group_id, subject, lesson_kind))));
drop policy "Пропуски: изменение" on public.absences;
create policy "Пропуски: изменение" on public.absences for update to authenticated
  using (public.is_group_staff(group_id)
         or (subject is not null and lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)))
  with check (public.group_open(group_id)
              and (public.is_group_staff(group_id)
                   or (subject is not null and lesson_kind is not null and public.teaches(group_id, subject, lesson_kind))));
drop policy "Пропуски: отмена" on public.absences;
create policy "Пропуски: отмена" on public.absences for delete to authenticated
  using (public.group_open(group_id)
         and ((public.is_group_staff(group_id) and (created_by = (select auth.uid()) or created_by is null))
              or (subject is not null and lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)
                  and (created_by = (select auth.uid()) or public.user_is_staff(group_id, created_by)))));

-- ===================================================================================================
-- 5. RPC чата (security definer, search_path = ''; ошибки — raise exception '<код>')
-- ===================================================================================================

-- Публикация ключей. Первый вызов → версия 1. Повтор без p_reset: тот же открытый ключ → обновляется только
-- резервная копия (смена пароля переписки), другой → key_mismatch. p_reset → новый ключ, версия + 1.
-- Ключи заводят только возможные участники чата: active староста/заместитель или преподаватель.
create function public.chat_keys_publish(p_public_jwk jsonb, p_backup jsonb, p_reset boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_pub jsonb;
  v_bak jsonb;
  k public.chat_keys;
  v_ver int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships m
                  where m.user_id = v_uid and m.status = 'active'
                    and (m.extra_role in ('headman', 'deputy') or m.base_role in ('teacher_lecture', 'teacher_practice'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- открытый ключ: EC P-256, x и y по 32 байта; закрытая часть (d) — отказ, в базу идёт только kty/crv/x/y
  if jsonb_typeof(p_public_jwk) is distinct from 'object' or p_public_jwk ? 'd'
     or p_public_jwk ->> 'kty' is distinct from 'EC' or p_public_jwk ->> 'crv' is distinct from 'P-256'
     or coalesce(p_public_jwk ->> 'x', '') !~ '^[A-Za-z0-9_-]{43}$'
     or coalesce(p_public_jwk ->> 'y', '') !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  v_pub := jsonb_build_object('kty', 'EC', 'crv', 'P-256', 'x', p_public_jwk ->> 'x', 'y', p_public_jwk ->> 'y');
  -- копия: { v:1, kdf:'PBKDF2-SHA256', iter ≥ 600000, salt 16 байт, iv 12 байт, ct } — лишние поля отбрасываются
  if jsonb_typeof(p_backup) is distinct from 'object'
     or p_backup -> 'v' is distinct from '1'::jsonb
     or p_backup ->> 'kdf' is distinct from 'PBKDF2-SHA256'
     or jsonb_typeof(p_backup -> 'iter') is distinct from 'number'
     or not coalesce(case when (p_backup ->> 'iter') ~ '^\d{6,8}$'
                          then (p_backup ->> 'iter')::int between 600000 and 10000000 end, false)
     or coalesce(p_backup ->> 'salt', '') !~ '^[A-Za-z0-9_-]{22}$'
     or coalesce(p_backup ->> 'iv', '') !~ '^[A-Za-z0-9_-]{16}$'
     or not public._chat_b64u_ok(p_backup ->> 'ct', 24, 2048) then
    raise exception 'bad_backup' using errcode = '22023';
  end if;
  v_bak := jsonb_build_object('v', 1, 'kdf', 'PBKDF2-SHA256', 'iter', (p_backup ->> 'iter')::int,
                              'salt', p_backup ->> 'salt', 'iv', p_backup ->> 'iv', 'ct', p_backup ->> 'ct');

  perform pg_advisory_xact_lock(hashtextextended('chat_keys:' || v_uid::text, 0));   -- два первых вызова подряд
  select * into k from public.chat_keys where user_id = v_uid for update;
  if not found then
    insert into public.chat_keys (user_id, public_jwk, key_version, backup) values (v_uid, v_pub, 1, v_bak);
    v_ver := 1;
  elsif coalesce(p_reset, false) then
    update public.chat_keys set public_jwk = v_pub, backup = v_bak, key_version = k.key_version + 1, updated_at = now()
     where user_id = v_uid;
    v_ver := k.key_version + 1;
  elsif k.public_jwk ->> 'x' = v_pub ->> 'x' and k.public_jwk ->> 'y' = v_pub ->> 'y' then
    update public.chat_keys set backup = v_bak, updated_at = now() where user_id = v_uid;
    v_ver := k.key_version;
  else
    raise exception 'key_mismatch' using errcode = 'P0001';
  end if;
  if k.user_id is null or coalesce(p_reset, false) then              -- смена ключа меняет отпечаток: след для разбора
    insert into public.audit_log (actor, group_id, action, details)
      values (v_uid, null, 'chat_key_publish', jsonb_build_object('key_version', v_ver, 'reset', coalesce(p_reset, false)));
  end if;
  return jsonb_build_object('key_version', v_ver);
end;
$$;

-- Открытый ключ собеседника по треду (только участнику живого треда). Ключей ещё нет → public_jwk и
-- key_version = null.
create function public.chat_peer_key(p_thread uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.chat_threads;
  v_peer uuid;
  k public.chat_keys;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  select * into t from public.chat_threads where id = p_thread and id in (select public.chat_my_thread_ids());
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  v_peer := case when t.student_user_id = v_uid then t.teacher_user_id else t.student_user_id end;
  select * into k from public.chat_keys where user_id = v_peer;
  return jsonb_build_object('user_id', v_peer, 'public_jwk', k.public_jwk, 'key_version', k.key_version);
end;
$$;

-- Открыть (или получить) тред: вызывает active староста/заместитель группы, собеседник — преподаватель,
-- назначенный на эту группу. kind — из base_role преподавателя.
create function public.chat_thread_open(p_group uuid, p_teacher uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_kind text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships m
                  where m.user_id = v_uid and m.group_id = p_group and m.status = 'active'
                    and m.base_role = 'student' and m.extra_role in ('headman', 'deputy')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select substr(m.base_role, 9) into v_kind
    from public.memberships m
   where m.user_id = p_teacher and m.group_id = p_group and m.status = 'active'
     and m.base_role in ('teacher_lecture', 'teacher_practice')
     and exists (select 1 from public.teacher_assignments ta
                  where ta.user_id = m.user_id and ta.group_id = m.group_id and ta.lesson_kind = substr(m.base_role, 9));
  if v_kind is null then raise exception 'not_teacher' using errcode = 'P0002'; end if;
  if not public.group_open(p_group) then raise exception 'group_closed' using errcode = '42501'; end if;
  insert into public.chat_threads (group_id, student_user_id, teacher_user_id, kind)
    values (p_group, v_uid, p_teacher, v_kind)
  on conflict (group_id, student_user_id, teacher_user_id) do nothing
  returning id into v_id;
  if v_id is null then
    select t.id into v_id from public.chat_threads t
     where t.group_id = p_group and t.student_user_id = v_uid and t.teacher_user_id = p_teacher;
  end if;
  return v_id;
end;
$$;

-- Мои треды. Старосте/заму — ещё и преподаватели его групп, с которыми треда нет (thread_id null).
-- peer_role: 'headman' | 'deputy' | 'teacher_lecture' | 'teacher_practice'. unread — сообщения собеседника
-- после моей отметки прочтения.
create function public.chat_threads_my()
returns table(thread_id uuid, group_id uuid, group_name text, peer_user_id uuid, peer_name text, peer_role text,
              kind text, last_message_at timestamptz, unread int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  return query
  with th as (
    select t.*, (t.student_user_id = v_uid) as i_student
      from public.chat_threads t
     where t.id in (select public.chat_my_thread_ids())
  ), live as (
    select th.id as thread_id, th.group_id, g.name as group_name,
           case when th.i_student then th.teacher_user_id else th.student_user_id end as peer_user_id,
           case when th.i_student then case th.kind when 'lecture' then 'Преподаватель лекций' else 'Преподаватель ПЗ' end
                when sm.extra_role = 'headman' then 'Староста ' || g.name
                else 'Зам. старосты ' || g.name end as peer_name,
           case when th.i_student then 'teacher_' || th.kind else sm.extra_role end as peer_role,
           th.kind,
           (select max(cm.created_at) from public.chat_messages cm where cm.thread_id = th.id) as last_message_at,
           (select count(*)::int from public.chat_messages cm
             where cm.thread_id = th.id and cm.sender_id <> v_uid
               and cm.created_at > coalesce((select r.last_read_at from public.chat_reads r
                                              where r.thread_id = th.id and r.user_id = v_uid), '-infinity')) as unread
      from th
      join public.groups g on g.id = th.group_id
      join public.memberships sm on sm.user_id = th.student_user_id and sm.group_id = th.group_id
  ), todo as (
    select null::uuid as thread_id, g.id as group_id, g.name as group_name, tm.user_id as peer_user_id,
           case tm.base_role when 'teacher_lecture' then 'Преподаватель лекций' else 'Преподаватель ПЗ' end as peer_name,
           tm.base_role as peer_role, substr(tm.base_role, 9) as kind,
           null::timestamptz as last_message_at, 0 as unread
      from public.memberships me
      join public.groups g on g.id = me.group_id
      join public.memberships tm on tm.group_id = me.group_id and tm.status = 'active'
                                and tm.base_role in ('teacher_lecture', 'teacher_practice')
     where me.user_id = v_uid and me.status = 'active' and me.base_role = 'student'
       and me.extra_role in ('headman', 'deputy')
       and exists (select 1 from public.teacher_assignments ta
                    where ta.user_id = tm.user_id and ta.group_id = tm.group_id and ta.lesson_kind = substr(tm.base_role, 9))
       and not exists (select 1 from public.chat_threads t
                        where t.group_id = me.group_id and t.student_user_id = v_uid and t.teacher_user_id = tm.user_id)
  )
  select * from live
  union all
  select * from todo
  order by 3, 7, 5;
end;
$$;

-- Отправка шифртекста. Версии ключей — текущие у обоих (иначе key_changed: собеседник или я сменили ключ,
-- клиент должен перечитать chat_peer_key / свой ключ). Уведомление собеседнику без текста, не чаще раза в 5 минут
-- на тред и получателя (dedupe_key).
create function public.chat_send(p_thread uuid, p_iv text, p_ciphertext text, p_sender_kv int, p_recipient_kv int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.chat_threads;
  v_peer uuid;
  v_my int;
  v_peer_kv int;
  v_id uuid;
  v_sig text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  select * into t from public.chat_threads where id = p_thread and id in (select public.chat_my_thread_ids());
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.group_open(t.group_id) then raise exception 'group_closed' using errcode = '42501'; end if;
  if length(p_ciphertext) > 10923 then raise exception 'too_long' using errcode = '22001'; end if;   -- > 8192 байт
  if p_iv is null or p_iv !~ '^[A-Za-z0-9_-]{16}$' or not public._chat_b64u_ok(p_ciphertext, 22, 10923) then
    raise exception 'bad_message' using errcode = '22023';
  end if;
  v_peer := case when t.student_user_id = v_uid then t.teacher_user_id else t.student_user_id end;
  -- for share: параллельный сброс ключа ждёт конца отправки, версия не «уплывает» между проверкой и вставкой
  select k.key_version into v_my from public.chat_keys k where k.user_id = v_uid for share;
  select k.key_version into v_peer_kv from public.chat_keys k where k.user_id = v_peer for share;
  if v_my is null or v_peer_kv is null or p_sender_kv is distinct from v_my or p_recipient_kv is distinct from v_peer_kv then
    raise exception 'key_changed' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('chat_send:' || v_uid::text, 0));   -- лимит без гонки
  if (select count(*) from public.chat_messages m
       where m.sender_id = v_uid and m.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.chat_messages (thread_id, sender_id, sender_key_version, recipient_key_version, iv, ciphertext)
    values (t.id, v_uid, p_sender_kv, p_recipient_kv, p_iv, p_ciphertext)
  returning id into v_id;

  if v_uid = t.student_user_id then
    select case m.extra_role when 'headman' then 'Староста ' else 'Зам. старосты ' end || g.name into v_sig
      from public.memberships m join public.groups g on g.id = m.group_id
     where m.user_id = v_uid and m.group_id = t.group_id;
  else
    v_sig := 'Преподаватель';
  end if;
  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
    values (v_peer, t.group_id, 'chat', 'Новое сообщение в чате', v_sig, jsonb_build_object('thread_id', t.id),
            'chat:' || t.id || ':' || v_peer || ':' || floor(extract(epoch from now()) / 300)::bigint)
  on conflict (user_id, dedupe_key) do nothing;
  return v_id;
end;
$$;

-- Отметка «прочитано» (до текущего момента) + гасит свои уведомления chat по этому треду
create function public.chat_mark_read(p_thread uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  if not exists (select 1 from public.chat_my_thread_ids() x(id) where x.id = p_thread) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.chat_reads (thread_id, user_id, last_read_at) values (p_thread, v_uid, now())
  on conflict (thread_id, user_id) do update set last_read_at = excluded.last_read_at;
  update public.notifications n set read_at = now()
   where n.user_id = v_uid and n.kind = 'chat' and n.ref ->> 'thread_id' = p_thread::text and n.read_at is null;
end;
$$;

-- ===================================================================================================
-- 6. Сводка группы для преподавателя
-- ===================================================================================================
-- students — записей студентов в группе. За последние 30 дней по Минску (включая сегодня):
-- attendance_pct = 100 × (1 − часы пропусков ÷ (пар по расписанию × 2 ч × студентов)), только дисциплины и виды
-- занятий вызывающего; null, если пар не было. absences_week — часы пропусков тех же дисциплин за 7 дней.
-- Сисадмин (без своих назначений) получает сводку по всем назначениям группы.
-- ponytail: пара подгруппы считается на всю группу и сегодняшние ещё не прошедшие пары входят в план —
-- процент чуть завышен; уточнять, если подгрупп станет много.
create function public.teacher_group_stats(p_group uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_today    date := (now() at time zone 'Europe/Minsk')::date;
  v_teacher  boolean := public.teaches(p_group, null, null);
  v_students int;
  v_planned  numeric;
  v_absent   numeric;
  v_week     numeric;
begin
  if not (v_teacher or public.is_sysadmin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  select count(*) into v_students from public.students s where s.group_id = p_group;
  with pairs as (
    select distinct ta.subject, ta.lesson_kind
      from public.teacher_assignments ta
      join public.memberships m on m.user_id = ta.user_id and m.group_id = ta.group_id
                               and m.status = 'active' and m.base_role = 'teacher_' || ta.lesson_kind
     where ta.group_id = p_group and (not v_teacher or ta.user_id = auth.uid())
  )
  select count(*) * 2 * v_students into v_planned
    from public.schedule_lessons l join pairs p on p.subject = l.subject and p.lesson_kind = l.kind
   where l.group_id = p_group and l.lesson_date between v_today - 29 and v_today;
  with pairs as (
    select distinct ta.subject, ta.lesson_kind
      from public.teacher_assignments ta
      join public.memberships m on m.user_id = ta.user_id and m.group_id = ta.group_id
                               and m.status = 'active' and m.base_role = 'teacher_' || ta.lesson_kind
     where ta.group_id = p_group and (not v_teacher or ta.user_id = auth.uid())
  )
  select coalesce(sum(a.hours), 0), coalesce(sum(a.hours) filter (where a.date >= v_today - 6), 0)
    into v_absent, v_week
    from public.absences a join pairs p on p.subject = a.subject and p.lesson_kind = a.lesson_kind
   where a.group_id = p_group and a.date between v_today - 29 and v_today;
  return jsonb_build_object(
    'students', v_students,
    'attendance_pct', case when v_planned > 0 then round(greatest(0, 100 * (1 - v_absent / v_planned)), 1) end,
    'absences_week', v_week);
end;
$$;

-- ===================================================================================================
-- 7. Права на функции
-- ===================================================================================================
do $$
declare f text;
begin
  -- внутренние и триггерные: никому из клиентов
  foreach f in array array['_chat_live(uuid, uuid, uuid, text)', '_chat_b64u_ok(text, int, int)', 'lesson_notes_touch()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- клиентские (права внутри по auth.uid()); chat_my_thread_ids нужна политикам RLS
  foreach f in array array['chat_my_thread_ids()', 'chat_keys_publish(jsonb, jsonb, boolean)', 'chat_peer_key(uuid)',
                           'chat_thread_open(uuid, uuid)', 'chat_threads_my()',
                           'chat_send(uuid, text, text, int, int)', 'chat_mark_read(uuid)',
                           'teacher_group_stats(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
