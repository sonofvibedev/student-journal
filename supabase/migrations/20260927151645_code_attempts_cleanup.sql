-- Неудачные попытки нужны только за последние минуты (лимит перебора); старше суток — удаляем при каждой новой записи.
create or replace function public.code_attempts_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.code_attempts where at < now() - interval '1 day';
  return null;
end;
$$;
revoke all on function public.code_attempts_cleanup() from public, anon, authenticated;
create trigger code_attempts_cleanup after insert on public.code_attempts
  for each statement execute function public.code_attempts_cleanup();
