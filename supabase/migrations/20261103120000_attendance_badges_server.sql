-- Значки посещаемости считает база, а не браузер.
--
-- Раньше их выдавал клиент (achievements.js): если пропуски ещё не успели загрузиться,
-- вся история считалась «без прогулов» и студенты получали streak_30; отозвать значок
-- было некому. Теперь заслуженный набор выводится из journal_private (пропуски, студенты)
-- и study_days, а триггер пересчитывает его при любой правке: задним числом, удалением,
-- сменой уважительности.
--
-- Правила 1:1 с achDeserved(): от даты «пропуски актуальны на» (updated_at по Минску)
-- считаются только учебные дни; уважительный пропуск серию не прерывает.
-- Управляемые коды: streak_*, cert_*, clean_sheet, clean_term, recovered, anti_m*.
-- Остальные значки (welcome, homework, game_*, collector...) не трогаются.
-- cert_*: в данных нет certSubmittedAt, поэтому не заслужены никогда (выданные отзываются).

create table if not exists public.study_days (
  day      date primary key,
  semester text not null
);
alter table public.study_days enable row level security;
revoke all on public.study_days from anon, authenticated;
grant select on public.study_days to authenticated;
drop policy if exists "Учебные дни читают вошедшие" on public.study_days;
create policy "Учебные дни читают вошедшие" on public.study_days
  for select to authenticated using (true);

insert into public.study_days (day, semester) values
  ('2026-09-01', 'fall-2026'),
  ('2026-09-02', 'fall-2026'),
  ('2026-09-03', 'fall-2026'),
  ('2026-09-04', 'fall-2026'),
  ('2026-09-05', 'fall-2026'),
  ('2026-09-07', 'fall-2026'),
  ('2026-09-08', 'fall-2026'),
  ('2026-09-09', 'fall-2026'),
  ('2026-09-10', 'fall-2026'),
  ('2026-09-11', 'fall-2026'),
  ('2026-09-14', 'fall-2026'),
  ('2026-09-15', 'fall-2026'),
  ('2026-09-16', 'fall-2026'),
  ('2026-09-17', 'fall-2026'),
  ('2026-09-18', 'fall-2026'),
  ('2026-09-19', 'fall-2026'),
  ('2026-09-21', 'fall-2026'),
  ('2026-09-22', 'fall-2026'),
  ('2026-09-23', 'fall-2026'),
  ('2026-09-24', 'fall-2026'),
  ('2026-09-25', 'fall-2026'),
  ('2026-09-26', 'fall-2026'),
  ('2026-09-28', 'fall-2026'),
  ('2026-09-29', 'fall-2026'),
  ('2026-09-30', 'fall-2026'),
  ('2026-10-01', 'fall-2026'),
  ('2026-10-02', 'fall-2026'),
  ('2026-10-03', 'fall-2026'),
  ('2026-10-05', 'fall-2026'),
  ('2026-10-06', 'fall-2026'),
  ('2026-10-07', 'fall-2026'),
  ('2026-10-08', 'fall-2026'),
  ('2026-10-09', 'fall-2026'),
  ('2026-10-10', 'fall-2026'),
  ('2026-10-12', 'fall-2026'),
  ('2026-10-13', 'fall-2026'),
  ('2026-10-14', 'fall-2026'),
  ('2026-10-15', 'fall-2026'),
  ('2026-10-16', 'fall-2026'),
  ('2026-10-17', 'fall-2026'),
  ('2026-10-19', 'fall-2026'),
  ('2026-10-20', 'fall-2026'),
  ('2026-10-21', 'fall-2026'),
  ('2026-10-22', 'fall-2026'),
  ('2026-10-23', 'fall-2026'),
  ('2026-10-24', 'fall-2026'),
  ('2026-10-26', 'fall-2026'),
  ('2026-10-27', 'fall-2026'),
  ('2026-10-28', 'fall-2026'),
  ('2026-10-29', 'fall-2026'),
  ('2026-10-30', 'fall-2026'),
  ('2026-10-31', 'fall-2026'),
  ('2026-11-02', 'fall-2026'),
  ('2026-11-03', 'fall-2026'),
  ('2026-11-04', 'fall-2026'),
  ('2026-11-05', 'fall-2026'),
  ('2026-11-06', 'fall-2026'),
  ('2026-11-09', 'fall-2026'),
  ('2026-11-10', 'fall-2026'),
  ('2026-11-11', 'fall-2026'),
  ('2026-11-12', 'fall-2026'),
  ('2026-11-13', 'fall-2026'),
  ('2026-11-14', 'fall-2026'),
  ('2026-11-16', 'fall-2026'),
  ('2026-11-17', 'fall-2026'),
  ('2026-11-18', 'fall-2026'),
  ('2026-11-19', 'fall-2026'),
  ('2026-11-20', 'fall-2026'),
  ('2026-11-21', 'fall-2026'),
  ('2026-11-23', 'fall-2026'),
  ('2026-11-24', 'fall-2026'),
  ('2026-11-25', 'fall-2026'),
  ('2026-11-26', 'fall-2026'),
  ('2026-11-27', 'fall-2026'),
  ('2026-11-28', 'fall-2026'),
  ('2026-11-30', 'fall-2026'),
  ('2026-12-01', 'fall-2026'),
  ('2026-12-02', 'fall-2026'),
  ('2026-12-03', 'fall-2026'),
  ('2026-12-04', 'fall-2026'),
  ('2026-12-07', 'fall-2026'),
  ('2026-12-08', 'fall-2026'),
  ('2026-12-09', 'fall-2026'),
  ('2026-12-10', 'fall-2026'),
  ('2026-12-11', 'fall-2026'),
  ('2026-12-14', 'fall-2026'),
  ('2026-12-15', 'fall-2026'),
  ('2026-12-16', 'fall-2026'),
  ('2026-12-18', 'fall-2026')
on conflict (day) do nothing;

create or replace function public.attendance_badge_codes()
returns text[] language sql immutable as $$
  select array['streak_3','streak_5','streak_10','streak_15','streak_20','streak_30','cert_1','cert_3','cert_5','clean_sheet','clean_term','recovered','anti_m2','anti_m4','anti_m6','anti_m8','anti_m10','anti_m12','anti_m14'];
$$;

-- Чистая функция: что заслужено прямо сейчас. Ничего не пишет, годится для сухого прогона.
create or replace function public.attendance_badges_deserved()
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
         coalesce(nullif(a->>'totalHours', '')::numeric, 0) as h
    from jp, jsonb_array_elements(jp.absences) a, bounds b
   where coalesce((a->>'isExcused')::boolean, false) = false
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

-- Приводит student_achievements в соответствие с заслуженным: лишнее отзывает, недостающее выдаёт.
-- Повторный вызов без правок данных ничего не возвращает.
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

create or replace function public.tg_recompute_attendance_badges()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  perform public.recompute_attendance_badges();
  return null;
end
$fn$;
revoke execute on function public.tg_recompute_attendance_badges() from public, anon, authenticated;

drop trigger if exists journal_private_badges on public.journal_private;
create trigger journal_private_badges
  after update of absences, students, updated_at on public.journal_private
  for each statement execute function public.tg_recompute_attendance_badges();

-- Клиент больше не вставляет управляемые коды (и game_*, как раньше).
drop policy if exists "Свои значки добавляются" on public.student_achievements;
create policy "Свои значки добавляются" on public.student_achievements
  for insert to authenticated
  with check (
    student_id = (select p.student_id from public.profiles p where p.user_id = (select auth.uid()))
    and code not like 'game\_%'
    and code <> all (public.attendance_badge_codes())
  );
