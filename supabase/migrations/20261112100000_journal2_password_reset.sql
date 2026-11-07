-- Журнал 2.0: сброс забытого пароля по одноразовому коду. Староста/заместитель группы студента или сисадмин выпускает
-- код (Edge Function password-reset-issue), студент сам задаёт новый пароль (password-reset). Пароль никто, кроме
-- студента, не знает; код живёт 24 часа, одноразовый, у пользователя не больше одного действующего (новый гасит старый).
-- Таблица закрыта для клиентов целиком: читают и пишут только Edge Functions секретным ключом.
-- Стирание данных (_delete_accounts → delete from auth.users) удаляет коды каскадом по user_id; created_by → null.
-- Откат: supabase/migrations_down/20261112100000_journal2_password_reset.down.sql.

create table public.password_resets (
  code_hash  text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at    timestamptz
);
-- Один неиспользованный код на пользователя (просроченный тоже считается: его удаляет следующий выпуск)
create unique index password_resets_one_open on public.password_resets (user_id) where used_at is null;
create index password_resets_created_by_idx on public.password_resets (created_by);

alter table public.password_resets enable row level security;
revoke all on public.password_resets from public, anon, authenticated;

-- Выпуск кода (вызывает только password-reset-issue: p_actor — проверенный по JWT пользователь, хэш кода считает функция).
-- Кто может: сисадмин — любому студенту с аккаунтом; староста/заместитель (active) — студенту своей группы.
-- Нельзя: себе (для этого смена пароля в кабинете), сисадмину. Без сисадмина нельзя: старосте (его выпускает только
-- сисадмин), заместителю — только староста; аккаунту, который состоит в другой группе или преподаёт: иначе староста
-- одной группы получил бы чужие права (код видит выпускающий и мог бы войти сам).
-- Ошибки (текст исключения): forbidden, no_student, no_account, self, forbidden_target, bad_request.
create function public.password_reset_issue(p_actor uuid, p_student_id text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.students;
  v_sys boolean;
  v_actor_role text;
  v_target_role text;
  v_expires timestamptz;
begin
  if p_actor is null or coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'bad_request' using errcode = '22023';
  end if;
  v_sys := exists (select 1 from public.sysadmins a where a.user_id = p_actor);
  select * into s from public.students where id = p_student_id for update;
  if not found then
    -- не сисадмину не подсказываем, существует ли запись
    if v_sys then raise exception 'no_student' using errcode = 'P0002'; end if;
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not v_sys then
    select m.extra_role into v_actor_role from public.memberships m
     where m.user_id = p_actor and m.group_id = s.group_id and m.status = 'active' and m.extra_role in ('headman', 'deputy');
    if v_actor_role is null then raise exception 'forbidden' using errcode = '42501'; end if;
  end if;
  if s.claimed_by is null or s.claim_status <> 'active' then
    raise exception 'no_account' using errcode = 'P0002';
  end if;
  if s.claimed_by = p_actor then raise exception 'self' using errcode = 'P0001'; end if;
  if exists (select 1 from public.sysadmins a where a.user_id = s.claimed_by) then
    raise exception 'forbidden_target' using errcode = '42501';
  end if;
  if not v_sys then
    select m.extra_role into v_target_role from public.memberships m
     where m.user_id = s.claimed_by and m.group_id = s.group_id and m.status = 'active';
    if v_target_role = 'headman' or (v_target_role = 'deputy' and v_actor_role <> 'headman')
       or exists (select 1 from public.memberships m
                   where m.user_id = s.claimed_by and m.group_id <> s.group_id and m.status = 'active')
       or exists (select 1 from public.teacher_assignments t where t.user_id = s.claimed_by) then
      raise exception 'forbidden_target' using errcode = '42501';
    end if;
  end if;

  -- старые коды этого пользователя гасим, заодно чистим давно просроченные чужие
  delete from public.password_resets r where r.user_id = s.claimed_by or r.expires_at < now() - interval '7 days';
  insert into public.password_resets (code_hash, user_id, created_by)
    values (p_code_hash, s.claimed_by, p_actor)
    returning expires_at into v_expires;
  insert into public.audit_log (actor, group_id, action, details)
    values (p_actor, s.group_id, 'password_reset_issue', jsonb_build_object('student_id', s.id, 'user_id', s.claimed_by));
  return jsonb_build_object('ok', true, 'student_id', s.id, 'expires_at', v_expires);
end;
$$;

revoke all on function public.password_reset_issue(uuid, text, text) from public, anon, authenticated;
grant execute on function public.password_reset_issue(uuid, text, text) to service_role;
