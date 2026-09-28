-- Studak: одноразовые токены пропуска на 5 минут.
-- В базе — только sha256-хэш токена и привязка к студенту; сам токен знает лишь телефон владельца (в QR).
-- Таблицу напрямую не читает и не пишет никто (RLS без политик): выдача — issue_pass_token()
-- для вошедшего студента, проверка — verify_pass_token() только для сервера (Edge Function verify-pass).
create table public.pass_tokens (
  id bigint generated always as identity primary key,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  student_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.pass_tokens enable row level security;
create index pass_tokens_user_idx on public.pass_tokens (user_id);
revoke all on table public.pass_tokens from public, anon, authenticated;

-- Выдать новый токен вошедшему студенту. Прошлые токены этого студента сразу гаснут —
-- действует только QR, который сейчас на экране. Не чаще раза в 10 секунд.
create or replace function public.issue_pass_token()
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_student text;
  v_token text;
  v_expires timestamptz := now() + interval '5 minutes';
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select p.student_id into v_student from public.profiles p where p.user_id = v_uid;
  if v_student is null then
    raise exception 'no_profile' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.pass_tokens t where t.user_id = v_uid and t.created_at > now() - interval '10 seconds') then
    raise exception 'too_often' using errcode = 'P0001';
  end if;
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'), '=');
  delete from public.pass_tokens t where t.user_id = v_uid or t.expires_at < now() - interval '1 day';
  insert into public.pass_tokens (token_hash, user_id, student_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_uid, v_student, v_expires);
  return query select v_token, v_expires;
end;
$$;
revoke all on function public.issue_pass_token() from public, anon;
grant execute on function public.issue_pass_token() to authenticated;

-- Проверить токен (вызывает только Edge Function verify-pass с серверным ключом).
-- Возвращает строку, только если токен существует и не истёк; иначе — пусто.
create or replace function public.verify_pass_token(p_token text)
returns table (student_id text, user_id uuid, login text, expires_at timestamptz)
language sql
security definer
set search_path = ''
stable
as $$
  select t.student_id, t.user_id, p.login, t.expires_at
  from public.pass_tokens t
  join public.profiles p on p.user_id = t.user_id and p.student_id = t.student_id
  where p_token ~ '^[A-Za-z0-9_-]{20,64}$'
    and t.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and t.expires_at > now()
  limit 1;
$$;
revoke all on function public.verify_pass_token(text) from public, anon, authenticated;
grant execute on function public.verify_pass_token(text) to service_role;
