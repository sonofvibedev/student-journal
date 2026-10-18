-- Рекорды и попытки пишет только Edge Function под service_role.
--
-- Политик insert, update и delete у этих таблиц нет, поэтому RLS такую запись
-- и так не пропускал. Но права на неё у anon и authenticated оставались от
-- общих прав проекта — убираем и их, чтобы «нельзя» держалось на двух замках,
-- а не на одном.

revoke insert, update, delete, truncate on public.game_records from anon, authenticated;
revoke insert, update, delete, truncate on public.word_attempts from anon, authenticated;
revoke all on public.word_attempts from anon;
