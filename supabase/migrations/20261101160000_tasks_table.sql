-- Домашка и дедлайны переезжают из data.json в таблицу: источник правды — она, data.json — публичное зеркало,
-- которое сервер пересобирает после каждой записи (см. _shared/taskstore.ts).
-- Запись лежит в rec целиком, в том виде, как была в data.json: форма для клиента и бота не меняется.
-- Клиентам доступа нет: читают и пишут только Edge Functions (секретный ключ); гости читают зеркало.
create table public.tasks (
  id         text primary key,
  seq        bigint generated always as identity,
  kind       text not null check (kind in ('homework', 'deadline')),
  rec        jsonb not null check (jsonb_typeof(rec) = 'object' and rec ->> 'id' = id),
  updated_at timestamptz not null default now()
);
create index tasks_seq_idx on public.tasks (seq);
alter table public.tasks enable row level security;
revoke all on public.tasks from anon, authenticated;

-- Содержимое data.json на момент переноса (порядок сохранён)
insert into public.tasks (id, kind, rec) values
  ('hw-1791460174322', 'homework', '{"id":"hw-1791460174322","subject":"Маркетинг услуг","type":"ПЗ","text":"Выставки по подгруппам","dueDate":"2026-10-22","subgroup":0,"createdAt":"2026-10-08T11:49:34.322Z"}'::jsonb),
  ('hw-1791521051483', 'homework', '{"id":"hw-1791521051483","subject":"Маркетинг инноваций","type":"ПЗ","text":"Мудл: https://elearning.bseu.by/mod/assign/view.php?id=81443","dueDate":"2026-10-21","subgroup":0,"createdAt":"2026-10-09T04:44:11.483Z"}'::jsonb),
  ('hw-1791810788685', 'homework', '{"id":"hw-1791810788685","subject":"Эконометрика","type":"ПЗ","text":"КР №2\n\nПо всем темам, которые проходили на ПЗ, 5 заданий","dueDate":"2026-10-31","subgroup":0,"createdAt":"2026-10-12T13:13:08.685Z"}'::jsonb),
  ('hw-1792520286918', 'homework', '{"id":"hw-1792520286918","subject":"Интегрированные маркетинговые коммуникации","type":"ПЗ","text":"Начало темы 11 + отвечаем до конца баннеры","dueDate":"2026-10-26","subgroup":0,"createdAt":"2026-10-20T18:18:06.918Z"}'::jsonb),
  ('dl-1790945129020', 'deadline', '{"id":"dl-1790945129020","type":"zachet","subject":"Логистика","text":"1/1005 13:05-15:55","dueDate":"2026-12-11","createdAt":"2026-10-02T12:45:29.020Z"}'::jsonb),
  ('dl-1790945328435', 'deadline', '{"id":"dl-1790945328435","type":"zachet","subject":"Маркетинг инноваций","text":"3/140 16:05-19:05","dueDate":"2026-12-16","createdAt":"2026-10-02T12:48:48.435Z"}'::jsonb),
  ('dl-1790945389634', 'deadline', '{"id":"dl-1790945389634","type":"zachet","subject":"Функционально-стоимостный анализ","text":"1/1005 13:05-15:55","dueDate":"2026-12-18","createdAt":"2026-10-02T12:49:49.634Z"}'::jsonb),
  ('dl-1793301565366', 'deadline', '{"id":"dl-1793301565366","type":"deadline","subject":"Маркетинг услуг","text":"Гостиницы","dueDate":"2026-11-04","createdAt":"2026-10-29T19:19:25.366Z"}'::jsonb)
on conflict (id) do nothing;
