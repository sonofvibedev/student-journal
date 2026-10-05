-- Достижения, баллы и таблица лидеров.
--
-- Что где лежит:
--   achievement_catalog   — справочник достижений: название, баллы, обод значка, порог;
--   student_achievements  — выданные значки с датой и снимком баллов;
--   leaderboard           — посчитанный рейтинг семестра;
--   app_events            — что студент сделал в приложении (аватарка, студак, домашка…);
--   journal_homework      — зеркало homework из data.json: по нему проверяется, что
--                           отмечают реально существующее задание;
--   journal_absences      — зеркало absences из data.json для серверного подсчёта.
--
-- Главное правило: достижения и баллы пишет только сервер (Edge Function
-- recalc-achievements под service_role). Клиент пишет исключительно свои
-- app_events. Иначе рейтинг не стоил бы ничего: его можно было бы проставить
-- себе из консоли браузера.
--
-- Чужие неуважительные часы и чужие антидостижения наружу не отдаются:
-- journal_absences и leaderboard закрыты полностью, рейтинг читается
-- через rpc_leaderboard(), которая отдаёт только место, баллы и число значков.

-- ============================================================================
-- Справочник достижений
-- ============================================================================
create table if not exists public.achievement_catalog (
  code          text primary key,
  category      text    not null check (category in ('attendance', 'app', 'homework', 'anti')),
  title         text    not null,
  description   text    not null,
  points        integer not null default 0,
  tier          text    not null default 'accent' check (tier in ('accent', 'bronze', 'silver', 'gold', 'platinum', 'anti')),
  group_code    text,                                  -- лесенка: streak, cert, homework
  threshold     integer,                               -- порог ступени
  is_anti       boolean not null default false,
  is_repeatable boolean not null default false,        -- можно получать каждый месяц
  sort          integer not null default 0
);

alter table public.achievement_catalog enable row level security;

drop policy if exists "Каталог достижений виден вошедшим" on public.achievement_catalog;
create policy "Каталог достижений виден вошедшим" on public.achievement_catalog
  for select to authenticated using (true);

-- ============================================================================
-- Зеркало data.json: домашка и пропуски
-- ============================================================================

-- Домашка нужна клиенту только для проверки «такое задание правда есть»
create table if not exists public.journal_homework (
  id        text primary key,
  subject   text,
  type      text,
  due_date  date,
  synced_at timestamptz not null default now()
);

alter table public.journal_homework enable row level security;

drop policy if exists "Домашка видна вошедшим" on public.journal_homework;
create policy "Домашка видна вошедшим" on public.journal_homework
  for select to authenticated using (true);

-- Пропуски: читает только сервер. Политик нет вообще — значит клиенту закрыто.
create table if not exists public.journal_absences (
  source_id         text primary key,                  -- id записи в data.json
  student_id        text    not null,
  date              date    not null,
  hours             numeric not null default 0,
  is_excused        boolean not null default false,
  cert_due_date     date,
  cert_submitted_at date,
  synced_at         timestamptz not null default now()
);

create index if not exists journal_absences_student_date on public.journal_absences (student_id, date);

alter table public.journal_absences enable row level security;

-- ============================================================================
-- События приложения: что студент сделал сам
-- ============================================================================
create table if not exists public.app_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  student_id text not null,
  kind       text not null check (kind in (
               'first_login', 'avatar_set', 'pass_opened',
               'whats_new_read', 'notifications_on', 'homework_done')),
  ref        text not null default '',                 -- id домашки или номер версии
  created_at timestamptz not null default now()
);

-- Одно событие одного вида на один ref: домашку нельзя отметить дважды
create unique index if not exists app_events_unique on public.app_events (user_id, kind, ref);
create index if not exists app_events_student on public.app_events (student_id, kind);

-- user_id и student_id ставит база, а не клиент: подставить чужие не получится
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

-- Функция нужна только триггеру. Без revoke она торчит наружу как
-- /rest/v1/rpc/app_events_fill_owner — лишняя точка входа с правами владельца.
revoke all on function public.app_events_fill_owner() from public, anon, authenticated;

drop trigger if exists app_events_before_insert on public.app_events;
create trigger app_events_before_insert
  before insert on public.app_events
  for each row execute function public.app_events_fill_owner();

alter table public.app_events enable row level security;

drop policy if exists "Свои события видны" on public.app_events;
create policy "Свои события видны" on public.app_events
  for select to authenticated using (user_id = (select auth.uid()));

-- Добавить можно только своё событие, а «Сделано» — только у существующей домашки
drop policy if exists "Свои события добавляются" on public.app_events;
create policy "Свои события добавляются" on public.app_events
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (kind <> 'homework_done' or exists (select 1 from public.journal_homework h where h.id = ref))
  );

-- Снять галочку «Сделано» можно, остальные события не удаляются
drop policy if exists "Отметку о домашке можно снять" on public.app_events;
create policy "Отметку о домашке можно снять" on public.app_events
  for delete to authenticated
  using (user_id = (select auth.uid()) and kind = 'homework_done');

-- Политики update нет: изменить событие нельзя никому, кроме service_role

-- ============================================================================
-- Выданные значки
-- ============================================================================
create table if not exists public.student_achievements (
  id         bigint generated always as identity primary key,
  student_id text    not null,
  code       text    not null references public.achievement_catalog (code) on delete cascade,
  period     text    not null default '',              -- '' или '2026-10' у повторяемых
  semester   text    not null,
  points     integer not null default 0,               -- снимок баллов на момент выдачи
  earned_at  timestamptz not null default now()
);

create unique index if not exists student_achievements_unique
  on public.student_achievements (student_id, code, period);
create index if not exists student_achievements_student on public.student_achievements (student_id, semester);

alter table public.student_achievements enable row level security;

-- Студент видит только свои значки: иначе чужие антидостижения были бы видны
drop policy if exists "Свои значки видны" on public.student_achievements;
create policy "Свои значки видны" on public.student_achievements
  for select to authenticated
  using (student_id = (select p.student_id from public.profiles p where p.user_id = (select auth.uid())));

-- ============================================================================
-- Рейтинг
-- ============================================================================
create table if not exists public.leaderboard (
  semester        text    not null,
  student_id      text    not null,
  points          integer not null default 0,
  badges_count    integer not null default 0,
  unexcused_hours numeric not null default 0,           -- наружу не отдаётся
  place           integer not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (semester, student_id)
);

alter table public.leaderboard enable row level security;
-- Политик нет: напрямую таблицу не прочитать, только через rpc_leaderboard()

-- Рейтинг наружу: место, студент, баллы и число значков. Часов здесь нет.
create or replace function public.rpc_leaderboard(p_semester text default null)
returns table (place integer, student_id text, points integer, badges_count integer)
language sql
security definer
set search_path = public
stable
as $$
  select l.place, l.student_id, l.points, l.badges_count
  from public.leaderboard l
  where l.semester = coalesce(p_semester, (select max(l2.semester) from public.leaderboard l2))
  order by l.place, l.student_id;
$$;

revoke all on function public.rpc_leaderboard(text) from public, anon;
grant execute on function public.rpc_leaderboard(text) to authenticated;

-- ============================================================================
-- Каталог достижений: названия, баллы и пороги согласованы со старостой
-- ============================================================================
insert into public.achievement_catalog
  (code, category, title, description, points, tier, group_code, threshold, is_anti, is_repeatable, sort) values
  -- Посещаемость
  ('clean_sheet', 'attendance', 'Чистый лист',
   'Календарный месяц без единого неуважительного часа', 50, 'accent', null, null, false, true, 10),
  ('streak_3',  'attendance', 'Разминка',
   '3 учебных дня подряд без неуважительных пропусков', 10, 'bronze', 'streak', 3, false, false, 20),
  ('streak_5',  'attendance', 'Пятидневка',
   '5 учебных дней подряд без неуважительных пропусков', 15, 'bronze', 'streak', 5, false, false, 21),
  ('streak_10', 'attendance', 'На волне',
   '10 учебных дней подряд без неуважительных пропусков', 25, 'silver', 'streak', 10, false, false, 22),
  ('streak_15', 'attendance', 'Железная воля',
   '15 учебных дней подряд без неуважительных пропусков', 35, 'silver', 'streak', 15, false, false, 23),
  ('streak_20', 'attendance', 'Несгибаемый',
   '20 учебных дней подряд без неуважительных пропусков', 50, 'gold', 'streak', 20, false, false, 24),
  ('streak_30', 'attendance', 'Легенда посещаемости',
   '30 учебных дней подряд без неуважительных пропусков', 80, 'platinum', 'streak', 30, false, false, 25),
  ('clean_term', 'attendance', 'Чистый семестр',
   'Весь семестр без неуважительных часов', 150, 'accent', null, null, false, false, 30),
  ('recovered', 'attendance', 'Исправился',
   'Месяц без неуважительных сразу после месяца, в котором они были', 30, 'accent', null, null, false, true, 40),
  ('cert_1', 'attendance', 'Справка вовремя',
   'Одна справка сдана до срока', 10, 'bronze', 'cert', 1, false, false, 50),
  ('cert_3', 'attendance', 'Справка вовремя · 3',
   'Три справки сданы до срока', 10, 'silver', 'cert', 3, false, false, 51),
  ('cert_5', 'attendance', 'Справка вовремя · 5',
   'Пять справок сданы до срока', 10, 'gold', 'cert', 5, false, false, 52),
  -- Приложение
  ('welcome', 'app', 'Добро пожаловать',
   'Первый вход после обновления', 5, 'accent', null, null, false, false, 60),
  ('first_steps', 'app', 'Первые шаги',
   'Поставил аватарку и открыл свой студак MarketPass', 15, 'accent', null, 2, false, false, 61),
  ('tech', 'app', 'Дотошный технарь',
   'Прочитал «Что нового» до конца', 5, 'accent', null, null, false, false, 62),
  ('notify_on', 'app', 'Всегда в курсе',
   'Включил уведомления о дедлайнах и домашке', 5, 'accent', null, null, false, false, 63),
  ('collector', 'app', 'Коллекционер',
   'Собрал 10 достижений', 20, 'accent', null, 10, false, false, 64),
  -- Домашка
  ('hw_1',  'homework', 'Первая ласточка',
   'Одна домашка отмечена сделанной', 5, 'bronze', 'homework', 1, false, false, 70),
  ('hw_3',  'homework', 'Втянулся',
   'Три домашки отмечены сделанными', 10, 'bronze', 'homework', 3, false, false, 71),
  ('hw_10', 'homework', 'Прилежный',
   'Десять домашек отмечены сделанными', 20, 'silver', 'homework', 10, false, false, 72),
  ('hw_25', 'homework', 'Книжный червь',
   'Двадцать пять домашек отмечены сделанными', 30, 'gold', 'homework', 25, false, false, 73),
  ('hw_50', 'homework', 'Машина знаний',
   'Пятьдесят домашек отмечены сделанными', 50, 'platinum', 'homework', 50, false, false, 74),
  -- Антидостижения: баллов не дают и дополнительно не снимают
  ('anti_2',  'anti', 'Прогулял — бывает',
   '2 неуважительных часа за семестр', 0, 'anti', 'anti', 2, true, false, 80),
  ('anti_6',  'anti', 'Ярый прогульщик',
   '6 неуважительных часов за семестр', 0, 'anti', 'anti', 6, true, false, 81),
  ('anti_9',  'anti', 'Красная зона',
   '9 неуважительных часов за семестр', 0, 'anti', 'anti', 9, true, false, 82),
  ('anti_18', 'anti', 'Призрак аудитории',
   '18 неуважительных часов за семестр', 0, 'anti', 'anti', 18, true, false, 83)
on conflict (code) do update set
  category      = excluded.category,
  title         = excluded.title,
  description   = excluded.description,
  points        = excluded.points,
  tier          = excluded.tier,
  group_code    = excluded.group_code,
  threshold     = excluded.threshold,
  is_anti       = excluded.is_anti,
  is_repeatable = excluded.is_repeatable,
  sort          = excluded.sort;
