-- Журнал 2.1, п.1: староста видит, привязан ли у студента Telegram-бот (чтобы понять, почему бот не даёт вносить домашки).
-- Только чтение, новых таблиц нет. Откат: supabase/migrations_down/20261120100000_journal21_hw_bot_status.down.sql.
create function public.homework_bot_status(p_group uuid)
returns table(student_id text, bot_linked boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_group_staff(p_group) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select s.id, exists (select 1 from public.tg_links l where l.user_id = s.claimed_by)
      from public.students s
     where s.group_id = p_group and s.claim_status = 'active';
end;
$$;
revoke all on function public.homework_bot_status(uuid) from public, anon;
grant execute on function public.homework_bot_status(uuid) to authenticated;
