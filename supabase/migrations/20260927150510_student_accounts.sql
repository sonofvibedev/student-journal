-- Аккаунты студентов «Журнала 24ДММ-2». Данные о пропусках остаются в data.json;
-- здесь только связь «аккаунт Supabase Auth ↔ student_id из data.json» и одноразовые коды.

-- Профиль: один аккаунт на студента. Студент только читает свою строку;
-- создаёт и меняет строки только Edge Function (секретный ключ).
create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  student_id text not null unique,
  login      text not null unique check (login ~ '^[a-z0-9_.]{3,32}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
create policy "Студент читает свой профиль" on public.profiles
  for select to authenticated using ((select auth.uid()) = user_id);

-- Одноразовые коды первого входа и восстановления. Хранится только sha-256 кода.
-- Клиент к таблице доступа не имеет (RLS включён, политик нет, права отозваны).
create table public.invite_codes (
  id         bigint generated always as identity primary key,
  student_id text not null,
  code_hash  text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index invite_codes_student_idx on public.invite_codes (student_id);
alter table public.invite_codes enable row level security;
revoke all on public.invite_codes from anon, authenticated;

-- Неудачные попытки ввода кода — для ограничения перебора в Edge Function (по хэшу IP).
create table public.code_attempts (
  id      bigint generated always as identity primary key,
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index code_attempts_ip_at_idx on public.code_attempts (ip_hash, at);
alter table public.code_attempts enable row level security;
revoke all on public.code_attempts from anon, authenticated;

-- Выдать студенту новый одноразовый код (первый вход, забытый пароль, новый студент).
-- Прежние неиспользованные коды студента аннулируются. Возвращает код открытым текстом —
-- только тому, кто запустил функцию. Запуск — из SQL Editor панели Supabase.
create or replace function public.reset_student_access(p_student_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- без 0/O, 1/I/L
  raw  text := '';
  b    bytea;
  i    int;
begin
  if coalesce(trim(p_student_id), '') = '' then
    raise exception 'student_id не указан';
  end if;
  b := extensions.gen_random_bytes(10);
  for i in 0..9 loop
    raw := raw || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
  end loop;
  delete from public.invite_codes where student_id = p_student_id and used_at is null;
  insert into public.invite_codes (student_id, code_hash)
    values (p_student_id, encode(extensions.digest(raw, 'sha256'), 'hex'));
  return substr(raw, 1, 5) || '-' || substr(raw, 6, 5);
end;
$$;
revoke all on function public.reset_student_access(text) from public, anon, authenticated;
comment on function public.reset_student_access(text) is
  'Выдаёт новый одноразовый код студенту: select public.reset_student_access(''st-...''); Аккаунт и аватарка сохраняются, по коду задаётся новый пароль.';
