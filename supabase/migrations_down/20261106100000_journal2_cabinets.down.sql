-- Откат 20261106100000_journal2_cabinets.sql: БД возвращается к состоянию после 20261105200000.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
-- ВНИМАНИЕ: удаляет расписание, справки, оценки, уведомления вместе с данными; связи пропусков со справками
-- (absences.certificate_id) теряются, сами пропуски и их is_excused/cert_submitted остаются. Подгруппа студентов
-- остаётся (как текст '1'/'2'). Правки journal_private, сделанные зеркалом, остаются (это данные 24ДММ-2).
begin;

-- 1. Триггеры этапа 2 на существующих таблицах
drop trigger absences_mirror_ins on public.absences;
drop trigger absences_mirror_upd on public.absences;
drop trigger absences_mirror_del on public.absences;
drop trigger students_mirror_ins on public.students;
drop trigger students_mirror_upd on public.students;
drop trigger students_mirror_del on public.students;
drop trigger absences_notify on public.absences;
drop trigger tasks_notify on public.tasks;
do $$
declare t text;
begin
  foreach t in array array['app_events', 'student_achievements', 'game_records', 'tasks', 'study_days'] loop
    execute format('drop trigger zz_fill_group_id on public.%I', t);
    execute format('alter table public.%I alter column group_id set default %L::uuid', t, '00000000-0000-4000-8000-000000000024');
  end loop;
end $$;

-- 2. Пропуски: связь со справкой и права по колонкам → прежние права на таблицу
alter table public.absences drop column certificate_id;
revoke insert, update on public.absences from authenticated;
grant insert, update on public.absences to authenticated;

-- 3. Новые таблицы (их политики и триггеры уходят вместе с ними)
drop table public.notifications, public.grades, public.certificates, public.schedule_meta, public.schedule_lessons;

-- 4. Подгруппа: обратно text без ограничения
alter table public.students drop constraint students_subgroup_check;
alter table public.students alter column subgroup type text using subgroup::text;

-- 5. Новые функции
drop function public.group_absence_summary(uuid, date, date);
drop function public.absence_hours_my(uuid);
drop function public.notifications_mark_all_read();
drop function public.notifications_mark_read(uuid[]);
drop function public.student_set_subgroup(smallint);
drop function public.certificate_resolve(text, text, text[]);
drop function public.certificate_create(text, text, date, date, date, text);
drop function public._assert_writable(uuid);
drop function public.journal_private_mirror();
drop function public.fill_group_id();
drop function public.grades_notify();
drop function public.certificates_notify();
drop function public.tasks_notify();
drop function public.absences_notify();
drop function public._lesson_kind_ru(text);
drop function public._notify_student(uuid, text, text, text, text, jsonb);

-- 6. Прежние тексты изменённых функций (из 20261105200000, 20261006010000, 20261103120000)
create or replace function public.absences_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if current_user not in ('authenticated', 'anon') then
    return new;                                   -- service_role и владелец: без ограничений
  end if;
  if new.id is distinct from old.id or new.group_id is distinct from old.group_id
     or new.student_id is distinct from old.student_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'absences: поле нельзя менять' using errcode = '42501';
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

create or replace function public.app_events_fill_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'app_events: нет вошедшего пользователя';
  end if;
  select p.student_id into new.student_id from public.profiles p where p.user_id = new.user_id;
  if new.student_id is null then
    raise exception 'app_events: у пользователя нет профиля';
  end if;
  return new;
end;
$$;

drop function public.attendance_badges_deserved();
create function public.attendance_badges_deserved()
returns table(student_id text, code text, period text)
language sql stable security definer set search_path = public as $fn$

with jp as (
  select (updated_at at time zone 'Europe/Minsk')::date as as_of, students, absences
    from public.journal_private where id = 'main'
),
sd as (select day, to_char(day, 'YYYY-MM') as m from (select day from public.study_days) t(day)),
bounds as (select min(day) as first_day, max(day) as last_day from sd),
st as (select distinct s->>'id' as sid from jp, jsonb_array_elements(jp.students) s where s->>'id' is not null),
-- неуважительные пропуски внутри учебного периода (achMyAbsences + !isExcused)
ab as (
  select a->>'studentId' as sid, (a->>'date')::date as d,
         case when a->>'totalHours' ~ '^\d+(\.\d+)?$' then (a->>'totalHours')::numeric else 0 end as h
    from jp, jsonb_array_elements(jp.absences) a, bounds b
   where coalesce(a->>'isExcused', 'false') not in ('true', 't', '1')
     and a->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
     and (a->>'date')::date between b.first_day and b.last_day
),
bad as (select distinct sid, d from ab),
-- серии: учебные дни <= as_of; плохой день начинает новую группу
sdays as (
  select st.sid, sd.day, (bad.d is not null) as is_bad,
         sum((bad.d is not null)::int) over (partition by st.sid order by sd.day) as grp
    from st cross join sd cross join jp
    left join bad on bad.sid = st.sid and bad.d = sd.day
   where sd.day <= jp.as_of
),
best as (
  select sid, coalesce(max(c), 0) as best
    from (select sid, grp, count(*) filter (where not is_bad) as c from sdays group by sid, grp) g
   group by sid
),
streak_lad(code, need) as (values ('streak_3',3),('streak_5',5),('streak_10',10),('streak_15',15),('streak_20',20),('streak_30',30)),
anti_lad(code, need) as (values ('anti_m2',2),('anti_m4',4),('anti_m6',6),('anti_m8',8),('anti_m10',10),('anti_m12',12),('anti_m14',12)),
-- месяц закрыт, когда его последний учебный день <= as_of
closed as (
  select m, lag(m) over (order by m) as prev_m
    from (select m from sd group by m having max(day) <= (select as_of from jp)) c
),
bad_m as (select distinct sid, to_char(d, 'YYYY-MM') as m from ab),
hrs as (select sid, to_char(d, 'YYYY-MM') as m, sum(h) as h from ab group by sid, to_char(d, 'YYYY-MM')),
res as (
  select b.sid, l.code, ''::text as period from best b join streak_lad l on b.best >= l.need
  union all
  select st.sid, 'clean_sheet', c.m from st cross join closed c
   where not exists (select 1 from bad_m x where x.sid = st.sid and x.m = c.m)
  union all
  select st.sid, 'recovered', c.m from st cross join closed c
   where c.prev_m is not null
     and exists (select 1 from bad_m x where x.sid = st.sid and x.m = c.prev_m)
     and not exists (select 1 from bad_m x where x.sid = st.sid and x.m = c.m)
  union all
  select st.sid, 'clean_term', '' from st, jp, bounds
   where jp.as_of >= bounds.last_day and not exists (select 1 from bad x where x.sid = st.sid)
  union all
  select h.sid, l.code, h.m from hrs h join anti_lad l on h.h >= l.need
)
select sid::text as student_id, code::text as code, period::text as period from res

$fn$;

create or replace function public.recompute_attendance_badges()
returns table(student_id text, code text, period text, action text)
language plpgsql security definer set search_path = public as $fn$
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
    insert into public.student_achievements (student_id, code, period, semester, earned_at)
    select d.student_id, d.code, d.period,
           coalesce((select semester from public.study_days order by day limit 1), ''), now()
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

revoke execute on function public.recompute_attendance_badges() from public, anon, authenticated;
revoke execute on function public.attendance_badges_deserved() from public, anon, authenticated;

-- 7. Запись о миграции: иначе db push не применит её повторно
delete from supabase_migrations.schema_migrations where version = '20261106100000';

commit;
