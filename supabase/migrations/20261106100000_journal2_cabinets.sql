-- Журнал 2.0, этап 2: кабинеты студента и старосты (часть базы данных).
--
-- Новое: расписание (schedule_lessons, schedule_meta), справки (certificates + absences.certificate_id),
-- оценки (grades), колокольчик (notifications) с триггерами-источниками, подгруппа студента,
-- агрегаты для главной студента и сводки старосты.
-- Легаси: group_id в старых таблицах заполняет триггер (константный default G24 снят), значки посещаемости
-- считаются по группам, зеркало absences/students → journal_private для старого index.html (только G24).
-- Подробно (матрица прав, RPC, до → после, риски, чек-лист): docs/stage2-db.md.
-- Откат: supabase/migrations_down/20261106100000_journal2_cabinets.down.sql.
--
-- G24 = группа переезда 24ДММ-2, id 00000000-0000-4000-8000-000000000024.

-- ===================================================================================================
-- 1. Подгруппа студента: text → smallint 1/2 (колонка была с этапа 1, клиент в неё не писал)
-- ===================================================================================================
alter table public.students
  alter column subgroup type smallint
  using case when btrim(subgroup) in ('1', '2') then btrim(subgroup)::smallint end;
alter table public.students add constraint students_subgroup_check check (subgroup in (1, 2));

-- ===================================================================================================
-- 2. Таблицы
-- ===================================================================================================

-- Расписание группы. Пишет только Edge Function schedule-import (service_role).
-- subgroup null = вся группа; ключ занятия: группа, дата, пара, предмет, подгруппа (null = null).
create table public.schedule_lessons (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups (id),
  lesson_date date not null,
  pair_no     smallint not null check (pair_no between 1 and 12),
  starts_at   time,
  ends_at     time,
  subject     text not null,
  kind        text not null default 'other' check (kind in ('lecture', 'practice', 'lab', 'other')),
  teacher     text,
  room        text,
  subgroup    smallint check (subgroup in (1, 2)),
  prev_room   text,
  changed_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint schedule_lessons_slot_unique unique nulls not distinct (group_id, lesson_date, pair_no, subject, subgroup)
);
create index schedule_lessons_group_date_idx on public.schedule_lessons (group_id, lesson_date);

-- Состояние импорта и границы семестра. Источник правды для дат семестра — эта таблица
-- (groups.semester_end этапа 1 — копия, которую пишет тот же импорт; см. docs/stage2-db.md).
create table public.schedule_meta (
  group_id       uuid primary key references public.groups (id),
  semester_start date,
  semester_end   date,
  last_import_at timestamptz,
  last_status    text,
  last_error     text,
  lessons_count  int,
  week1_monday   date
);

-- Справки. Создаёт и закрывает староста/заместитель через RPC; студент видит свои.
create table public.certificates (
  id          text primary key default ('ce-' || replace(gen_random_uuid()::text, '-', '')),
  group_id    uuid not null references public.groups (id),
  student_id  text not null,
  kind        text not null check (kind in ('sick', 'statement', 'other')),
  date_from   date,
  date_to     date,
  due_date    date,
  status      text not null default 'waiting' check (status in ('waiting', 'received', 'none')),
  note        text,
  created_by  uuid default auth.uid(),
  received_at timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (student_id, group_id) references public.students (id, group_id),
  unique (id, student_id, group_id),            -- цель FK из absences: справка того же студента и группы
  check (date_from is null or date_to is null or date_from <= date_to)
);
create index certificates_group_idx on public.certificates (group_id, status);
create index certificates_student_idx on public.certificates (student_id);

-- Пропуск, закрытый справкой. FK составной: справка другого студента или группы невозможна.
alter table public.absences add column certificate_id text;
alter table public.absences add constraint absences_certificate_fkey
  foreign key (certificate_id, student_id, group_id) references public.certificates (id, student_id, group_id);
create index absences_certificate_idx on public.absences (certificate_id) where certificate_id is not null;

-- Оценки: пишет преподаватель своей дисциплины и вида занятий (интерфейс — позже), читает студент свои.
create table public.grades (
  id          text primary key default ('gr-' || replace(gen_random_uuid()::text, '-', '')),
  group_id    uuid not null references public.groups (id),
  student_id  text not null,
  subject     text not null,
  lesson_kind text not null check (lesson_kind in ('lecture', 'practice')),
  value       smallint check (value between 1 and 10),
  passed      boolean,
  lesson_date date,
  comment     text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  foreign key (student_id, group_id) references public.students (id, group_id),
  check ((value is null) <> (passed is null))      -- ровно одно: балл или зачёт
);
create index grades_group_idx on public.grades (group_id, subject);
create index grades_student_idx on public.grades (student_id);

-- Колокольчик. Пишут только security definer триггеры и service_role; клиент читает свои и
-- отмечает прочитанными через RPC.
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  group_id   uuid references public.groups (id),
  kind       text not null,
  title      text not null,
  body       text,
  ref        jsonb,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['schedule_lessons', 'schedule_meta', 'certificates', 'grades', 'notifications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ===================================================================================================
-- 3. Политики
-- ===================================================================================================

grant select on public.schedule_lessons, public.schedule_meta to authenticated;
create policy "Расписание: чтение" on public.schedule_lessons for select to authenticated
  using (public.is_group_reader(group_id) or public.teaches(group_id, subject, null));
create policy "Расписание: состояние импорта" on public.schedule_meta for select to authenticated
  using (public.is_group_reader(group_id) or public.teaches(group_id, null, null));

-- Справки: создание и закрытие — только RPC; напрямую староста правит описание и удаляет ожидающую
grant select, delete on public.certificates to authenticated;
grant update (kind, date_from, date_to, due_date, note) on public.certificates to authenticated;
create policy "Справки: чтение" on public.certificates for select to authenticated
  using (student_id = public.my_student_id(group_id) or public.is_group_staff(group_id));
create policy "Справки: правка" on public.certificates for update to authenticated
  using (public.is_group_staff(group_id) and status = 'waiting')
  with check (public.is_group_staff(group_id) and public.group_open(group_id) and status = 'waiting');
create policy "Справки: удаление" on public.certificates for delete to authenticated
  using (public.is_group_staff(group_id) and public.group_open(group_id) and status = 'waiting');

-- absences.certificate_id клиент не пишет: права на вставку и правку — по списку колонок без неё
revoke insert, update on public.absences from authenticated;
grant insert (id, group_id, student_id, date, subject, hours, is_excused, cert_type, cert_submitted, cert_due_date,
              comment, created_by, lesson_kind, created_at) on public.absences to authenticated;
grant update (id, group_id, student_id, date, subject, hours, is_excused, cert_type, cert_submitted, cert_due_date,
              comment, created_by, lesson_kind, created_at) on public.absences to authenticated;

-- Оценки: студент — свои; староста/зам — группа; преподаватель — своя дисциплина и вид; сисадмин — всё
grant select, insert, delete on public.grades to authenticated;
grant update (value, passed, lesson_date, comment) on public.grades to authenticated;
create policy "Оценки: чтение" on public.grades for select to authenticated
  using (student_id = public.my_student_id(group_id)
         or public.is_group_staff(group_id)
         or public.teaches(group_id, subject, lesson_kind));
create policy "Оценки: внесение" on public.grades for insert to authenticated
  with check (created_by = (select auth.uid())
              and public.group_open(group_id)
              and (public.teaches(group_id, subject, lesson_kind) or (select public.is_sysadmin())));
create policy "Оценки: изменение" on public.grades for update to authenticated
  using (public.teaches(group_id, subject, lesson_kind) or (select public.is_sysadmin()))
  with check (public.group_open(group_id)
              and (public.teaches(group_id, subject, lesson_kind) or (select public.is_sysadmin())));
create policy "Оценки: удаление" on public.grades for delete to authenticated
  using (public.group_open(group_id)
         and (public.teaches(group_id, subject, lesson_kind) or (select public.is_sysadmin())));

grant select on public.notifications to authenticated;
create policy "Уведомления: свои" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

-- ===================================================================================================
-- 4. Пропуск, закрытый справкой: уважительность и «справка сдана» меняет только RPC справок
-- ===================================================================================================
create or replace function public.absences_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if current_user not in ('authenticated', 'anon') then
    return new;                                   -- service_role, владелец и security definer RPC: без ограничений
  end if;
  if new.id is distinct from old.id or new.group_id is distinct from old.group_id
     or new.student_id is distinct from old.student_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at or new.certificate_id is distinct from old.certificate_id then
    raise exception 'absences: поле нельзя менять' using errcode = '42501';
  end if;
  if old.certificate_id is not null
     and (new.is_excused, new.cert_submitted) is distinct from (old.is_excused, old.cert_submitted) then
    raise exception 'absences: пропуск закрыт справкой' using errcode = '42501';
  end if;
  if old.created_by = v_uid then
    return new;                                   -- своя запись: любые поля (вид/дисциплину держит with check)
  end if;
  if public.is_group_staff(old.group_id) then
    if old.created_by is null then
      return new;                                 -- легаси-запись группы
    end if;
    -- запись преподавателя: только справка и комментарий; уважительность — только вместе со сданной справкой
    if (new.date, new.subject, new.hours, new.lesson_kind) is distinct from (old.date, old.subject, old.hours, old.lesson_kind)
       or (new.is_excused is distinct from old.is_excused and not new.cert_submitted) then
      raise exception 'absences: староста меняет в чужой записи только справку' using errcode = '42501';
    end if;
    return new;
  end if;
  -- преподаватель в чужой записи своей дисциплины: только «уважительный»
  if (new.date, new.subject, new.hours, new.lesson_kind, new.cert_type, new.cert_submitted, new.cert_due_date, new.comment)
     is distinct from
     (old.date, old.subject, old.hours, old.lesson_kind, old.cert_type, old.cert_submitted, old.cert_due_date, old.comment) then
    raise exception 'absences: преподаватель меняет только уважительность' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ===================================================================================================
-- 5. Уведомления: внутренние функции и триггеры-источники (security definer: клиенту вставка закрыта)
-- ===================================================================================================

-- Уведомление active-аккаунту студента (если запись студента ни к кому не привязана — никому)
create function public._notify_student(p_group uuid, p_student text, p_kind text, p_title text, p_body text, p_ref jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, group_id, kind, title, body, ref)
  select m.user_id, p_group, p_kind, p_title, p_body, p_ref
    from public.memberships m
   where m.group_id = p_group and m.student_id = p_student and m.status = 'active' and m.base_role = 'student';
$$;

create function public._lesson_kind_ru(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind when 'lecture' then 'лекция' when 'practice' then 'практическое' end;
$$;

-- Пропуск внесён → студенту. Легаси-импорт (created_by null) уведомлений не шлёт.
create function public.absences_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._notify_student(new.group_id, new.student_id, 'absence', 'Внесён пропуск',
    concat_ws(', ', coalesce(nullif(btrim(new.subject), ''), 'Без предмета'), public._lesson_kind_ru(new.lesson_kind))
      || ': ' || coalesce(trim_scale(new.hours)::text, '?') || ' ч',
    jsonb_build_object('absence_id', new.id, 'date', new.date));
  return null;
end;
$$;
create trigger absences_notify after insert on public.absences
  for each row when (new.created_by is not null) execute function public.absences_notify();

-- Задание внесено → всем active-студентам группы, кроме автора и студентов другой подгруппы
create function public.tasks_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_sub text := coalesce(new.rec ->> 'subgroup', '');
begin
  insert into public.notifications (user_id, group_id, kind, title, body, ref)
  select m.user_id, new.group_id, 'task',
         case new.kind when 'deadline' then 'Новый дедлайн' else 'Новое задание' end,
         left(concat_ws(': ', nullif(btrim(new.rec ->> 'subject'), ''), nullif(btrim(new.rec ->> 'text'), '')), 300),
         jsonb_build_object('task_id', new.id, 'kind', new.kind, 'due', new.rec ->> 'dueDate')
    from public.memberships m
    left join public.students s on s.id = m.student_id and s.group_id = m.group_id
   where m.group_id = new.group_id and m.status = 'active' and m.base_role = 'student'
     and m.user_id is distinct from new.created_by
     and not (v_sub in ('1', '2') and s.subgroup is not null and s.subgroup::text <> v_sub);
  return null;
end;
$$;
create trigger tasks_notify after insert on public.tasks
  for each row execute function public.tasks_notify();

-- Справка получена / не сдана → студенту и старосте/заму группы (ФИО студента старосте и так видно)
create function public.certificates_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_title text := case new.status when 'received' then 'Справка подтверждена' else 'Справка не подтверждена' end;
  v_what  text := concat_ws(', ',
                    case new.kind when 'sick' then 'Больничный' when 'statement' then 'Заявление' else 'Справка' end,
                    case when new.date_from is not null or new.date_to is not null
                         then concat_ws('–', to_char(new.date_from, 'DD.MM.YYYY'), to_char(new.date_to, 'DD.MM.YYYY')) end);
  v_ref   jsonb := jsonb_build_object('certificate_id', new.id, 'status', new.status, 'student_id', new.student_id);
  v_name  text;
begin
  perform public._notify_student(new.group_id, new.student_id, 'certificate', v_title, v_what, v_ref);
  select concat_ws(' ', s.last_name, s.first_name) into v_name from public.students s where s.id = new.student_id;
  insert into public.notifications (user_id, group_id, kind, title, body, ref)
  select m.user_id, new.group_id, 'certificate', v_title, v_name || ': ' || v_what, v_ref
    from public.memberships m
   where m.group_id = new.group_id and m.status = 'active' and m.extra_role in ('headman', 'deputy')
     and m.student_id is distinct from new.student_id;      -- своя справка старосты: одно уведомление
  return null;
end;
$$;
create trigger certificates_notify after update of status on public.certificates
  for each row when (new.status in ('received', 'none') and new.status is distinct from old.status)
  execute function public.certificates_notify();

-- Оценка внесена → студенту
create function public.grades_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._notify_student(new.group_id, new.student_id, 'grade', 'Новая оценка',
    concat_ws(', ', new.subject, public._lesson_kind_ru(new.lesson_kind)) || ': '
      || coalesce(new.value::text, case when new.passed then 'зачтено' else 'не зачтено' end),
    jsonb_build_object('grade_id', new.id, 'date', new.lesson_date));
  return null;
end;
$$;
create trigger grades_notify after insert on public.grades
  for each row execute function public.grades_notify();

-- ===================================================================================================
-- 6. Легаси: group_id в старых таблицах заполняет триггер вместо константы G24
-- ===================================================================================================
-- Порядок: явный group_id → группа студента строки (student_id) → единственная active-группа вызывающего →
-- (только tasks, только не клиент) G24 → ошибка.
-- Последний легаси-случай: _shared/taskstore.ts (tg-bot, админка 1.x) пишет задания под service_role без group_id,
-- и это всегда задания 24ДММ-2 (зеркало data.json). Остальные service-писатели (submit-game-score, words.ts
-- grantBadges) передают student_id, группа берётся из него.
-- security invoker: клиент видит students по RLS (свою группу), service_role и владелец — всё.
create function public.fill_group_id()
returns trigger language plpgsql set search_path = '' as $$
declare v_sid text; v_g uuid; v_groups uuid[];
begin
  if new.group_id is not null then
    return new;
  end if;
  v_sid := to_jsonb(new) ->> 'student_id';
  if v_sid is not null then
    select s.group_id into v_g from public.students s where s.id = v_sid;
  end if;
  if v_g is null and auth.uid() is not null then
    select array_agg(t.g) into v_groups from public.my_active_groups() as t(g);
    if cardinality(v_groups) = 1 then v_g := v_groups[1]; end if;
  end if;
  if v_g is null and tg_table_name = 'tasks' and current_user not in ('authenticated', 'anon') then
    v_g := '00000000-0000-4000-8000-000000000024';
  end if;
  if v_g is null then
    raise exception '%: не удалось определить group_id, передайте его явно', tg_table_name using errcode = '23502';
  end if;
  new.group_id := v_g;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['app_events', 'student_achievements', 'game_records', 'tasks', 'study_days'] loop
    execute format('alter table public.%I alter column group_id drop default', t);
    -- имя с zz_: срабатывает после app_events_before_insert (тот ставит student_id)
    execute format('create trigger zz_fill_group_id before insert on public.%I for each row execute function public.fill_group_id()', t);
  end loop;
end $$;

-- app_events: student_id из легаси-профиля, а у студента новой группы (профиля нет) — из его записи students
create or replace function public.app_events_fill_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'app_events: нет вошедшего пользователя';
  end if;
  select p.student_id into new.student_id from public.profiles p where p.user_id = new.user_id;
  if new.student_id is null then
    select s.id into new.student_id from public.students s where s.claimed_by = new.user_id and s.claim_status = 'active';
  end if;
  if new.student_id is null then
    raise exception 'app_events: у пользователя нет записи студента';
  end if;
  return new;
end;
$$;

-- ===================================================================================================
-- 7. Значки посещаемости по группам
-- ===================================================================================================
-- G24 до переключения клиента считается по journal_private (источник правды старой админки), остальные
-- группы — по students/absences. Учебные дни — study_days своей группы. «Актуально на»: у G24 —
-- journal_private.updated_at (как раньше), у новых групп — вчера по Минску (сегодняшние пропуски могут
-- быть ещё не внесены; так меньше выдач и отзывов в течение дня). Правила те же, что в 20261103120000.
drop function public.attendance_badges_deserved();
create function public.attendance_badges_deserved()
returns table(group_id uuid, student_id text, code text, period text)
language sql stable security definer set search_path = '' as $fn$

with jp as (
  select (j.updated_at at time zone 'Europe/Minsk')::date as as_of, j.students, j.absences
    from public.journal_private j where j.id = 'main'
),
asof as (
  select '00000000-0000-4000-8000-000000000024'::uuid as gid, jp.as_of from jp
  union all
  select g.id, (now() at time zone 'Europe/Minsk')::date - 1
    from public.groups g where g.id <> '00000000-0000-4000-8000-000000000024'
),
sd as (select d.group_id as gid, d.day, to_char(d.day, 'YYYY-MM') as m from public.study_days d),
bounds as (select gid, min(day) as first_day, max(day) as last_day from sd group by gid),
st as (
  select distinct '00000000-0000-4000-8000-000000000024'::uuid as gid, s ->> 'id' as sid
    from jp, jsonb_array_elements(jp.students) s where s ->> 'id' is not null
  union
  select s.group_id, s.id from public.students s where s.group_id <> '00000000-0000-4000-8000-000000000024'
),
-- неуважительные пропуски внутри учебного периода группы
ab0 as (
  select '00000000-0000-4000-8000-000000000024'::uuid as gid, a ->> 'studentId' as sid, (a ->> 'date')::date as d,
         case when a ->> 'totalHours' ~ '^\d+(\.\d+)?$' then (a ->> 'totalHours')::numeric else 0 end as h
    from jp, jsonb_array_elements(jp.absences) a
   where coalesce(a ->> 'isExcused', 'false') not in ('true', 't', '1')
     and a ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$'
  union all
  select a.group_id, a.student_id, a.date, coalesce(a.hours, 0)
    from public.absences a
   where a.group_id <> '00000000-0000-4000-8000-000000000024' and not a.is_excused and a.date is not null
),
ab as (select ab0.* from ab0 join bounds b on b.gid = ab0.gid where ab0.d between b.first_day and b.last_day),
bad as (select distinct gid, sid, d from ab),
-- серии: учебные дни <= «актуально на»; плохой день начинает новую группу
sdays as (
  select st.gid, st.sid, sd.day, (bad.d is not null) as is_bad,
         sum((bad.d is not null)::int) over (partition by st.gid, st.sid order by sd.day) as grp
    from st
    join sd on sd.gid = st.gid
    join asof on asof.gid = st.gid
    left join bad on bad.gid = st.gid and bad.sid = st.sid and bad.d = sd.day
   where sd.day <= asof.as_of
),
best as (
  select gid, sid, coalesce(max(c), 0) as best
    from (select gid, sid, grp, count(*) filter (where not is_bad) as c from sdays group by gid, sid, grp) g
   group by gid, sid
),
streak_lad(code, need) as (values ('streak_3',3),('streak_5',5),('streak_10',10),('streak_15',15),('streak_20',20),('streak_30',30)),
anti_lad(code, need) as (values ('anti_m2',2),('anti_m4',4),('anti_m6',6),('anti_m8',8),('anti_m10',10),('anti_m12',12),('anti_m14',12)),
-- месяц закрыт, когда его последний учебный день <= «актуально на»
closed as (
  select gid, m, lag(m) over (partition by gid order by m) as prev_m
    from (select sd.gid, sd.m from sd join asof on asof.gid = sd.gid
           group by sd.gid, sd.m, asof.as_of having max(sd.day) <= asof.as_of) c
),
bad_m as (select distinct gid, sid, to_char(d, 'YYYY-MM') as m from ab),
hrs as (select gid, sid, to_char(d, 'YYYY-MM') as m, sum(h) as h from ab group by gid, sid, to_char(d, 'YYYY-MM')),
res as (
  select b.gid, b.sid, l.code, ''::text as period from best b join streak_lad l on b.best >= l.need
  union all
  select st.gid, st.sid, 'clean_sheet', c.m from st join closed c on c.gid = st.gid
   where not exists (select 1 from bad_m x where x.gid = st.gid and x.sid = st.sid and x.m = c.m)
  union all
  select st.gid, st.sid, 'recovered', c.m from st join closed c on c.gid = st.gid
   where c.prev_m is not null
     and exists (select 1 from bad_m x where x.gid = st.gid and x.sid = st.sid and x.m = c.prev_m)
     and not exists (select 1 from bad_m x where x.gid = st.gid and x.sid = st.sid and x.m = c.m)
  union all
  select st.gid, st.sid, 'clean_term', '' from st
    join bounds on bounds.gid = st.gid
    join asof on asof.gid = st.gid
   where asof.as_of >= bounds.last_day
     and not exists (select 1 from bad x where x.gid = st.gid and x.sid = st.sid)
  union all
  select h.gid, h.sid, l.code, h.m from hrs h join anti_lad l on h.h >= l.need
)
select gid as group_id, sid::text as student_id, code::text as code, period::text as period from res

$fn$;

-- Приводит student_achievements в соответствие с заслуженным по всем группам. Значки студента другой группы
-- больше не отзываются из-за того, что его нет в journal_private.
create or replace function public.recompute_attendance_badges()
returns table(student_id text, code text, period text, action text)
language plpgsql security definer set search_path = '' as $fn$
#variable_conflict use_column
begin
  return query
  with d as (select * from public.attendance_badges_deserved()),
  del as (
    delete from public.student_achievements sa
     where sa.code = any(public.attendance_badge_codes())
       and not exists (select 1 from d where d.student_id = sa.student_id and d.code = sa.code and d.period = sa.period)
    returning sa.student_id, sa.code, sa.period
  ),
  ins as (
    insert into public.student_achievements (student_id, code, period, semester, earned_at, group_id)
    select d.student_id, d.code, d.period,
           coalesce((select x.semester from public.study_days x where x.group_id = d.group_id order by x.day limit 1), ''),
           now(), d.group_id
      from d
     where not exists (select 1 from public.student_achievements sa
                        where sa.student_id = d.student_id and sa.code = d.code and sa.period = d.period)
    on conflict do nothing
    returning student_id, code, period
  )
  select del.student_id, del.code, del.period, 'revoked'::text from del
  union all
  select ins.student_id, ins.code, ins.period, 'granted'::text from ins;
end
$fn$;

-- ===================================================================================================
-- 8. Зеркало absences/students (только G24) → journal_private для старого index.html
-- ===================================================================================================
-- Statement-триггер с переходными таблицами: одна правка journal_private на оператор.
-- Вставка: добавляет записи, которых в jsonb ещё нет (строки легаси-импорта там уже есть — не трогаем).
-- Правка: накладывает поля на элемент с тем же id (чужие ключи элемента — isAdmin, role… — сохраняются).
-- Удаление: убирает элемент. Повтор того же изменения ничего не меняет; journal_private пишется, только если
-- jsonb действительно изменился. Рекурсии нет: на journal_private висит только пересчёт значков (он пишет
-- student_achievements). Для групп кроме G24 тот же триггер пересчитывает значки (их jsonb не участвует).
create function public.journal_private_mirror()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  G constant uuid := '00000000-0000-4000-8000-000000000024';
  v_rows jsonb := '[]'::jsonb;      -- элементы jsonb для вставки/правки
  v_del text[] := '{}';
  v_old jsonb;
  v_new jsonb;
  v_other boolean := false;         -- были строки других групп (для пересчёта значков)
begin
  if tg_table_name = 'absences' then
    if tg_op in ('INSERT', 'UPDATE') then
      select coalesce(jsonb_agg(
               jsonb_strip_nulls(jsonb_build_object('date', n.date, 'totalHours', n.hours, 'subject', n.subject))
               || jsonb_build_object('id', n.id, 'studentId', n.student_id, 'isExcused', n.is_excused,
                                     'comment', coalesce(n.comment, ''), 'certType', n.cert_type,
                                     'certDueDate', n.cert_due_date, 'certSubmitted', n.cert_submitted)), '[]'::jsonb)
        into v_rows from new_rows n where n.group_id = G;
      v_other := exists (select 1 from new_rows n where n.group_id <> G);
    else
      select coalesce(array_agg(o.id), '{}') into v_del from old_rows o where o.group_id = G;
      v_other := exists (select 1 from old_rows o where o.group_id <> G);
    end if;
  else
    if tg_op in ('INSERT', 'UPDATE') then
      select coalesce(jsonb_agg(
               jsonb_strip_nulls(jsonb_build_object(
                 'id', n.id, 'lastName', n.last_name, 'firstName', n.first_name,
                 'status', case n.study_form when 'budget' then 'Бюджет' when 'paid' then 'Платное' end,
                 'telegramUsername', n.telegram ->> 'username'))), '[]'::jsonb)
        into v_rows from new_rows n where n.group_id = G;
    else
      select coalesce(array_agg(o.id), '{}') into v_del from old_rows o where o.group_id = G;
    end if;
  end if;

  if jsonb_array_length(v_rows) > 0 or cardinality(v_del) > 0 then
    if tg_table_name = 'absences' then
      select j.absences into v_old from public.journal_private j where j.id = 'main' for update;
    else
      select j.students into v_old from public.journal_private j where j.id = 'main' for update;
    end if;
    if v_old is not null then
      select coalesce(jsonb_agg(case when tg_op = 'UPDATE' and r.o is not null then e.v || r.o else e.v end order by e.ord), '[]'::jsonb)
        into v_new
        from jsonb_array_elements(v_old) with ordinality e(v, ord)
        left join jsonb_array_elements(v_rows) r(o) on r.o ->> 'id' = e.v ->> 'id'
       where not coalesce(e.v ->> 'id' = any (v_del), false);
      v_new := v_new || coalesce((select jsonb_agg(r.o) from jsonb_array_elements(v_rows) r(o)
                                   where not exists (select 1 from jsonb_array_elements(v_old) e(v) where e.v ->> 'id' = r.o ->> 'id')),
                                 '[]'::jsonb);
      if v_new is distinct from v_old then
        if tg_table_name = 'absences' then
          update public.journal_private set absences = v_new, updated_at = now() where id = 'main';
        else
          update public.journal_private set students = v_new, updated_at = now() where id = 'main';
        end if;
      end if;
    end if;
  end if;

  if v_other then
    begin                                         -- сбой пересчёта не откатывает запись пропуска
      perform public.recompute_attendance_badges();
    exception when others then
      raise warning 'recompute_attendance_badges: %', sqlerrm;
    end;
  end if;
  return null;
end;
$$;
create trigger absences_mirror_ins after insert on public.absences
  referencing new table as new_rows for each statement execute function public.journal_private_mirror();
create trigger absences_mirror_upd after update on public.absences
  referencing old table as old_rows new table as new_rows for each statement execute function public.journal_private_mirror();
create trigger absences_mirror_del after delete on public.absences
  referencing old table as old_rows for each statement execute function public.journal_private_mirror();
create trigger students_mirror_ins after insert on public.students
  referencing new table as new_rows for each statement execute function public.journal_private_mirror();
create trigger students_mirror_upd after update on public.students
  referencing old table as old_rows new table as new_rows for each statement execute function public.journal_private_mirror();
create trigger students_mirror_del after delete on public.students
  referencing old table as old_rows for each statement execute function public.journal_private_mirror();

-- ===================================================================================================
-- 9. RPC
-- ===================================================================================================

-- Общая проверка записи в группу из RPC: журнал открыт и нет глобальных техработ (как у RLS)
create function public._assert_writable(p_group uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  if not public.group_open(p_group) then raise exception 'group_closed' using errcode = '42501'; end if;
end;
$$;

-- 1. Новая справка (староста/заместитель группы студента, сисадмин) → id
create function public.certificate_create(p_student_id text, p_kind text, p_from date, p_to date, p_due date, p_note text)
returns text language plpgsql security definer set search_path = '' as $$
declare s public.students; v_id text;
begin
  select * into s from public.students where id = p_student_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.is_group_staff(s.group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public._assert_writable(s.group_id);
  if p_kind is null or p_kind not in ('sick', 'statement', 'other') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if p_from > p_to then raise exception 'bad_dates' using errcode = '22023'; end if;
  insert into public.certificates (group_id, student_id, kind, date_from, date_to, due_date, note)
    values (s.group_id, s.id, p_kind, p_from, p_to, p_due, left(nullif(btrim(p_note), ''), 500))
    returning id into v_id;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), s.group_id, 'certificate_create', jsonb_build_object('certificate_id', v_id, 'student_id', s.id));
  return v_id;
end;
$$;

-- 2. «Справка получена» / «Нет справки».
-- received: закрывает ТОЛЬКО переданные пропуски того же студента и группы (не закрытые другой справкой):
--   is_excused = true вместе с cert_submitted = true (то же правило, что absences_guard для старосты).
--   Ошибочный id → bad_absence, ничего не меняется. Повторный received → already_received.
-- none: только статус; справка в статусе waiting/none ничего не закрывала, поэтому и открывать нечего.
--   Позже можно всё же отметить received (студент донёс справку).
create function public.certificate_resolve(p_certificate text, p_status text, p_absence_ids text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.certificates; v_ids text[] := coalesce(p_absence_ids, '{}'); v_n int := 0; v_hours numeric := 0;
begin
  select * into c from public.certificates where id = p_certificate for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.is_group_staff(c.group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public._assert_writable(c.group_id);
  if p_status is null or p_status not in ('received', 'none') then raise exception 'bad_status' using errcode = '22023'; end if;
  if c.status = 'received' then raise exception 'already_received' using errcode = 'P0001'; end if;

  if p_status = 'received' then
    if exists (select 1 from unnest(v_ids) x(id)
                where not exists (select 1 from public.absences a
                                   where a.id = x.id and a.student_id = c.student_id and a.group_id = c.group_id
                                     and (a.certificate_id is null or a.certificate_id = c.id))) then
      raise exception 'bad_absence' using errcode = '22023';
    end if;
    with u as (
      update public.absences a
         set is_excused = true, cert_submitted = true, certificate_id = c.id,
             cert_type = case c.kind when 'sick' then 'Больничный' when 'statement' then 'Заявление' else 'Другое' end
       where a.id = any (v_ids) and a.student_id = c.student_id and a.group_id = c.group_id
      returning a.hours
    )
    select count(*), coalesce(sum(u.hours), 0) into v_n, v_hours from u;
    update public.certificates set status = 'received', received_at = now() where id = c.id;
  else
    update public.certificates set status = 'none' where id = c.id;
  end if;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), c.group_id, 'certificate_resolve',
            jsonb_build_object('certificate_id', c.id, 'status', p_status, 'absences', to_jsonb(v_ids), 'hours', v_hours));
  return jsonb_build_object('ok', true, 'status', p_status, 'closed', v_n, 'hours', v_hours);
end;
$$;

-- 3. Студент выбирает подгруппу (1, 2 или null — «не знаю»). Только своя active-запись.
create function public.student_set_subgroup(p_subgroup smallint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.students;
begin
  if p_subgroup is not null and p_subgroup not in (1, 2) then raise exception 'bad_subgroup' using errcode = '22023'; end if;
  select st.* into s from public.students st
    join public.memberships m on m.user_id = st.claimed_by and m.group_id = st.group_id and m.student_id = st.id
                             and m.status = 'active' and m.base_role = 'student'
   where st.claimed_by = auth.uid() and st.claim_status = 'active';
  if not found then raise exception 'not_student' using errcode = '42501'; end if;
  perform public._assert_writable(s.group_id);
  update public.students set subgroup = p_subgroup where id = s.id;
  return jsonb_build_object('ok', true, 'subgroup', p_subgroup);
end;
$$;

-- 4. Колокольчик: отметить прочитанными свои → число отмеченных
create function public.notifications_mark_read(p_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.notifications set read_at = now()
   where user_id = auth.uid() and id = any (coalesce(p_ids, '{}')) and read_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function public.notifications_mark_all_read()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 5. Часы пропусков для главной студента: свой студент в группе, текущий календарный месяц по Минску
-- (как renderHomeHours в index.html). Пороги сравниваются с unexcused (неуважительные), как в 1.x.
create function public.absence_hours_my(p_group uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_sid text := public.my_student_id(p_group);
  v_from date := date_trunc('month', now() at time zone 'Europe/Minsk')::date;
  v_to date := (date_trunc('month', now() at time zone 'Europe/Minsk') + interval '1 month')::date;
  g public.groups;
  r record;
begin
  if v_sid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  select * into g from public.groups where id = p_group;
  select coalesce(sum(a.hours), 0) as total,
         coalesce(sum(a.hours) filter (where a.is_excused), 0) as excused,
         coalesce(sum(a.hours) filter (where not a.is_excused), 0) as unexcused
    into r
    from public.absences a
   where a.group_id = p_group and a.student_id = v_sid and a.date >= v_from and a.date < v_to;
  return jsonb_build_object('total', r.total, 'excused', r.excused, 'unexcused', r.unexcused,
                            'warn_hours', g.warn_hours, 'dean_hours', g.dean_hours,
                            'period_from', v_from, 'period_to', v_to - 1);
end;
$$;

-- 6. Сводка пропусков группы за период (староста/заместитель, сисадмин). null в датах = без границы.
-- Все студенты группы, в т. ч. без пропусков; cert_waiting — справки в статусе waiting (без учёта периода).
create function public.group_absence_summary(p_group uuid, p_from date, p_to date)
returns table(student_id text, student_name text, total numeric, excused numeric, cert_waiting int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.is_group_staff(p_group) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  return query
  select s.id,
         concat_ws(' ', s.last_name, s.first_name),
         coalesce(sum(a.hours), 0)::numeric,
         coalesce(sum(a.hours) filter (where a.is_excused), 0)::numeric,
         (select count(*)::int from public.certificates c
           where c.student_id = s.id and c.group_id = s.group_id and c.status = 'waiting')
    from public.students s
    left join public.absences a on a.student_id = s.id and a.group_id = s.group_id
                               and (p_from is null or a.date >= p_from) and (p_to is null or a.date <= p_to)
   where s.group_id = p_group
   group by s.id
   order by s.sort nulls last, s.last_name, s.first_name;
end;
$$;

-- ===== Права на функции =====
do $$
declare f text;
begin
  -- внутренние и триггерные: никому из клиентов
  foreach f in array array['_notify_student(uuid, text, text, text, text, jsonb)', '_lesson_kind_ru(text)',
                           'absences_notify()', 'tasks_notify()', 'certificates_notify()', 'grades_notify()',
                           'fill_group_id()', 'journal_private_mirror()', '_assert_writable(uuid)',
                           'attendance_badges_deserved()', 'recompute_attendance_badges()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- клиентские RPC: только authenticated (права проверяются внутри по auth.uid())
  foreach f in array array['certificate_create(text, text, date, date, date, text)',
                           'certificate_resolve(text, text, text[])', 'student_set_subgroup(smallint)',
                           'notifications_mark_read(uuid[])', 'notifications_mark_all_read()',
                           'absence_hours_my(uuid)', 'group_absence_summary(uuid, date, date)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ===================================================================================================
-- 10. «Техработы» на новых таблицах (тот же restrictive-паттерн, что в 20261103130000 и этапе 1)
-- ===================================================================================================
do $$
declare t text;
begin
  foreach t in array array['schedule_lessons', 'schedule_meta', 'certificates', 'grades', 'notifications'] loop
    execute format(
      'create policy "Техработы" on public.%I as restrictive for all to anon, authenticated using ((select public.app_open())) with check ((select public.app_open()))',
      t);
  end loop;
end $$;
