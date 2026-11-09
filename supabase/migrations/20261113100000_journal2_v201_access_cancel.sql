-- Журнал 2.0.1: след отмены пропусков, «Доступы» студентов к внесению домашки, лабораторные в пропусках.
-- Только добавления: существующие таблицы, данные и политики не меняются (кроме расширения check у
-- absences.lesson_kind и текста _lesson_kind_ru — оба обратно совместимы).
--
-- A. Отмена пропуска остаётся обычным DELETE из absences (политика «Пропуски: отмена», клиенты headman.js,
--    offline-queue.js, teacher.js не меняются). Перед удалением триггер кладёт строку целиком в absence_cancellations:
--    кто, когда, что было. FK нет намеренно: след не мешает стиранию студента и группы.
-- B. Староста/заместитель выдаёт студенту право вносить домашку (homework_access_set). Студент с правом пишет в tasks
--    только kind = 'homework' и только свои строки; дедлайны/зачёты/экзамены — по-прежнему старосте.
-- C. Пропуск по лабораторной: lesson_kind = 'lab'. Назначений преподавателей на лабораторные нет
--    (teacher_assignments/grades не меняются), поэтому такие пропуски видят только группа и староста.
-- Откат: supabase/migrations_down/20261113100000_journal2_v201_access_cancel.down.sql.

-- ===================================================================================================
-- 1. След отмены пропусков
-- ===================================================================================================

-- absence — to_jsonb(old) целиком; cancelled_by null — удалил service_role/владелец (импорт, Edge Function)
create table public.absence_cancellations (
  id           uuid primary key default gen_random_uuid(),
  absence_id   text not null,
  group_id     uuid not null,
  student_id   text not null,
  absence      jsonb not null,
  cancelled_by uuid,
  cancelled_at timestamptz not null default now()
);
create index absence_cancellations_group_idx on public.absence_cancellations (group_id, cancelled_at desc);
create index absence_cancellations_student_idx on public.absence_cancellations (student_id);

alter table public.absence_cancellations enable row level security;
revoke all on public.absence_cancellations from public, anon, authenticated;
create policy "Техработы" on public.absence_cancellations as restrictive for all to anon, authenticated
  using ((select public.app_open())) with check ((select public.app_open()));
-- Чтение: староста/заместитель группы и сисадмин (is_group_staff). Пишет только триггер.
grant select on public.absence_cancellations to authenticated;
create policy "Отменённые пропуски: чтение" on public.absence_cancellations for select to authenticated
  using (public.is_group_staff(group_id));

-- BEFORE DELETE: строка следа пишется в той же транзакции, что и удаление (откат удаления откатывает и след).
-- Ничего не меняет в удаляемой строке, поэтому зеркало journal_private и пересчёт значков (absences_mirror_del,
-- AFTER statement) работают как раньше.
create function public.absences_log_cancel()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.absence_cancellations (absence_id, group_id, student_id, absence, cancelled_by)
    values (old.id, old.group_id, old.student_id, to_jsonb(old), auth.uid());
  return old;
end;
$$;
create trigger absences_log_cancel before delete on public.absences
  for each row execute function public.absences_log_cancel();

-- ===================================================================================================
-- 2. Право студента вносить домашку
-- ===================================================================================================

-- Право привязано к записи студента. Удаление записи students снимает право (cascade); стирание — триггер ниже.
create table public.homework_editors (
  group_id   uuid not null,
  student_id text not null,
  granted_by uuid default auth.uid(),
  granted_at timestamptz not null default now(),
  primary key (group_id, student_id),
  foreign key (student_id, group_id) references public.students (id, group_id) on delete cascade
);
create index homework_editors_student_idx on public.homework_editors (student_id);

alter table public.homework_editors enable row level security;
revoke all on public.homework_editors from public, anon, authenticated;
create policy "Техработы" on public.homework_editors as restrictive for all to anon, authenticated
  using ((select public.app_open())) with check ((select public.app_open()));
-- Чтение: своя строка, староста/заместитель группы, сисадмин. Запись — только homework_access_set.
grant select on public.homework_editors to authenticated;
create policy "Доступы: чтение" on public.homework_editors for select to authenticated
  using (student_id = public.my_student_id(group_id) or public.is_group_staff(group_id));

-- Есть ли у вызывающего право вносить домашку в группе g: active-членство студента + строка в homework_editors.
-- Староста/заместитель пишут задания по своим политикам «Задания: …», от этой функции не зависят.
create function public.can_add_homework(g uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
      join public.homework_editors h on h.group_id = m.group_id and h.student_id = m.student_id
     where m.user_id = (select auth.uid()) and m.group_id = g and m.status = 'active' and m.base_role = 'student');
$$;

-- Выдать (p_on = true) или снять право. Только староста/заместитель группы студента или сисадмин.
-- Ошибки (текст исключения): bad_request, not_found, forbidden, maintenance, group_closed.
create function public.homework_access_set(p_student text, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.students;
begin
  if p_on is null then raise exception 'bad_request' using errcode = '22023'; end if;
  select * into s from public.students where id = p_student;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.is_group_staff(s.group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if s.erased_at is not null or s.claim_status = 'erased' then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public._assert_writable(s.group_id);
  if p_on then
    insert into public.homework_editors (group_id, student_id) values (s.group_id, s.id)
    on conflict (group_id, student_id) do nothing;
  else
    delete from public.homework_editors h where h.group_id = s.group_id and h.student_id = s.id;
  end if;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), s.group_id, 'homework_access_set', jsonb_build_object('student_id', s.id, 'on', p_on));
end;
$$;

-- Стирание студента (_erase_student ставит erased_at): право снимается, свободный текст из следа отмен
-- убирается так же, как _erase_student чистит absences.comment
create function public.students_erased_v201_cleanup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.homework_editors h where h.student_id = new.id;
  update public.absence_cancellations c set absence = c.absence - 'comment'
   where c.student_id = new.id and c.absence ? 'comment';
  return null;
end;
$$;
create trigger students_erased_v201_cleanup after update of erased_at on public.students
  for each row when (old.erased_at is null and new.erased_at is not null)
  execute function public.students_erased_v201_cleanup();

-- Новые permissive-политики tasks (складываются через OR с «Задания: …» старосты и преподавателя).
-- Студент с правом: только домашка, только от своего имени, только свои строки; техработы и закрытая группа
-- закрывают запись (group_open ложь для не-старосты).
create policy "Задания: внесение студентом с доступом" on public.tasks for insert to authenticated
  with check (created_by = (select auth.uid()) and kind = 'homework'
              and public.group_open(group_id) and public.can_add_homework(group_id));
create policy "Задания: изменение студентом с доступом" on public.tasks for update to authenticated
  using (created_by = (select auth.uid()) and kind = 'homework'
         and public.group_open(group_id) and public.can_add_homework(group_id))
  with check (created_by = (select auth.uid()) and kind = 'homework'
              and public.group_open(group_id) and public.can_add_homework(group_id));
create policy "Задания: удаление студентом с доступом" on public.tasks for delete to authenticated
  using (created_by = (select auth.uid()) and kind = 'homework'
         and public.group_open(group_id) and public.can_add_homework(group_id));

-- ===================================================================================================
-- 3. Лабораторные в пропусках
-- ===================================================================================================
-- Старые строки ('lecture', 'practice', null) остаются валидными
alter table public.absences drop constraint absences_lesson_kind_check;
alter table public.absences add constraint absences_lesson_kind_check
  check (lesson_kind in ('lecture', 'practice', 'lab'));

create or replace function public._lesson_kind_ru(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind when 'lecture' then 'лекция' when 'practice' then 'практическое' when 'lab' then 'лабораторная' end;
$$;

-- ===== Права на функции =====
do $$
declare f text;
begin
  -- внутренние и триггерные: никому из клиентов
  foreach f in array array['absences_log_cancel()', 'students_erased_v201_cleanup()', '_lesson_kind_ru(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- хелпер политик tasks: как остальные хелперы RLS
  revoke all on function public.can_add_homework(uuid) from public, anon, authenticated;
  grant execute on function public.can_add_homework(uuid) to authenticated, service_role;
  -- клиентская RPC: только authenticated (права внутри по auth.uid(); без пользователя — всегда forbidden)
  revoke all on function public.homework_access_set(text, boolean) from public, anon, authenticated;
  grant execute on function public.homework_access_set(text, boolean) to authenticated;
end $$;
