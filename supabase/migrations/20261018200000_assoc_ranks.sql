-- «Ассоциации» по новым правилам: слово угадывают по близости, а не по подсказкам.
--
-- Старые попытки остаются в истории как есть, у них mode = 'hints6'. Новые
-- пишутся с mode = 'ranks' и своими счётчиками: сколько слов названо, сколько
-- подсказок открыто, сдался игрок или угадал, и какие слова он называл.
-- Месячный рейтинг считает только новые попытки — поэтому он начинается
-- заново с момента обновления, а прежние результаты никуда не деваются.

alter table public.word_attempts
  add column if not exists mode    text    not null default 'ranks',
  add column if not exists tries   integer not null default 0 check (tries >= 0),
  add column if not exists hints   integer not null default 0 check (hints >= 0),
  add column if not exists gave_up boolean not null default false,
  add column if not exists guesses jsonb   not null default '[]'::jsonb;

-- Всё, что было до обновления, — старый режим
update public.word_attempts set mode = 'hints6' where hint is not null and tries = 0 and mode = 'ranks';

-- Подсказок в новом режиме может быть сколько угодно, а старое поле hint
-- (номер открытой подсказки от 1 до 6) новым попыткам не нужно
alter table public.word_attempts alter column hint drop not null;
alter table public.word_attempts alter column hint drop default;
alter table public.word_attempts drop constraint if exists word_attempts_hint_check;

-- Слова больше не хранят шесть подсказок: у загаданного слова их нет вовсе
alter table public.word_bank alter column hints set default '{}'::text[];
alter table public.word_bank drop constraint if exists word_bank_hints_check;

-- ===== Месячный рейтинг =====
-- Сумма очков за текущий месяц, только новый режим. При равенстве очков выше
-- тот, у кого меньше попыток в сумме.
-- Возвращаемые столбцы изменились (добавились попытки), поэтому функцию
-- приходится пересоздавать целиком
drop function if exists public.rpc_assoc_board(date);

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
   group by wa.student_id
  having sum(wa.points) > 0
   order by points desc, tries asc, days desc, wa.student_id;
$$;

revoke all on function public.rpc_assoc_board(date) from public, anon;
grant execute on function public.rpc_assoc_board(date) to authenticated;

-- ===== Бакет с рейтингами =====
-- Приватный: политик на storage.objects для него нет, поэтому читает его
-- только service_role, то есть Edge Function. Файлы заливает скрипт
-- tools/assoc/upload.py с секретным ключом из окружения.
insert into storage.buckets (id, name, public)
     values ('assoc-ranks', 'assoc-ranks', false)
on conflict (id) do update set public = false;
