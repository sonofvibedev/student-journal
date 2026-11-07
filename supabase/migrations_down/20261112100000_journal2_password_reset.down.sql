-- Откат 20261112100000_journal2_password_reset.sql: БД возвращается к состоянию после 20261111100000.
-- Выданные коды сброса удаляются вместе с таблицей; записи password_reset_* в audit_log остаются.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
begin;

drop function public.password_reset_issue(uuid, text, text);
drop table public.password_resets;

delete from supabase_migrations.schema_migrations where version = '20261112100000';

commit;
