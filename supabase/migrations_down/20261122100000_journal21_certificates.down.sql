-- Откат 2.1 п.13 (справки: одна запись на документ). Возвращает схему и функции как после 20261106100000.
-- Данные: снимаются связи absences.certificate_id и удаляются справки этой миграции — перенесённые (id 'ce-m13-…') и созданные
-- триггером привязки ('ce-a-…'). Справки, созданные через certificate_create (id 'ce-<uuid>'), остаются (до миграции в проде их 0).
-- Пропуски не теряются: часы, уважительность и cert_type / cert_submitted / cert_due_date остаются в absences —
-- у пропусков, которые после миграции правили или чьи справки отмечали «Сдана», там текущее состояние справки.
-- Открытые больничные и сроки «с–по» после отката видны только по датам пропусков.

drop trigger if exists zz_absences_cert_link on public.absences;
drop trigger if exists absences_cert_sync on public.absences;

-- связи и справки (зеркало 1.x не нужно: certificate_id в jsonb не попадает)
alter table public.absences disable trigger absences_mirror_upd;
update public.absences set certificate_id = null where certificate_id like 'ce-m13-%' or certificate_id like 'ce-a-%';
alter table public.absences enable trigger absences_mirror_upd;
delete from public.certificates where id like 'ce-m13-%' or id like 'ce-a-%';
-- вида «освобождение» в схеме этапа 2 нет: у оставшихся (сторонних) справок — «прочее»
update public.certificates set kind = 'other' where kind = 'exemption';

drop function if exists public.certificate_link(text, text[]);
drop function if exists public.certificate_set_submitted(text, boolean);
drop function if exists public.certificate_set_open(text, boolean);
drop function if exists public._cert_for_write(text);
drop function if exists public.absences_cert_sync();
drop function if exists public.absences_cert_link();
drop function if exists public._cert_recount(text);
drop function if exists public._cert_type_ru(text);
drop function if exists public._cert_kind(text);

drop index if exists public.certificates_one_open;
drop index if exists public.certificates_one_day;
alter table public.certificates drop constraint if exists certificates_open_check;
alter table public.certificates drop column if exists open;
alter table public.certificates drop constraint if exists certificates_kind_check;
alter table public.certificates add constraint certificates_kind_check check (kind in ('sick', 'statement', 'other'));

-- absences_guard и certificates_notify — как в 20261106100000_journal2_cabinets.sql
create or replace function public.absences_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if current_user not in ('authenticated', 'anon') then
    return new;                                   -- service_role, владелец и security definer RPC: без ограничений
  end if;
  if new.id is distinct from old.id or new.group_id is distinct from old.group_id
     or new.student_id is distinct from old.student_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at or new.certificate_id is distinct from old.certificate_id then
    raise exception 'absences: поле нельзя менять' using errcode = '42501';
  end if;
  if old.certificate_id is not null
     and (new.is_excused, new.cert_submitted) is distinct from (old.is_excused, old.cert_submitted) then
    raise exception 'absences: пропуск закрыт справкой' using errcode = '42501';
  end if;
  if old.created_by = v_uid then
    return new;                                   -- своя запись: любые поля (вид/дисциплину держит with check)
  end if;
  if public.is_group_staff(old.group_id) then
    if old.created_by is null then
      return new;                                 -- легаси-запись группы
    end if;
    -- запись преподавателя: только справка и комментарий; уважительность — только вместе со сданной справкой
    if (new.date, new.subject, new.hours, new.lesson_kind) is distinct from (old.date, old.subject, old.hours, old.lesson_kind)
       or (new.is_excused is distinct from old.is_excused and not new.cert_submitted) then
      raise exception 'absences: староста меняет в чужой записи только справку' using errcode = '42501';
    end if;
    return new;
  end if;
  -- преподаватель в чужой записи своей дисциплины: только «уважительный»
  if (new.date, new.subject, new.hours, new.lesson_kind, new.cert_type, new.cert_submitted, new.cert_due_date, new.comment)
     is distinct from
     (old.date, old.subject, old.hours, old.lesson_kind, old.cert_type, old.cert_submitted, old.cert_due_date, old.comment) then
    raise exception 'absences: преподаватель меняет только уважительность' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.certificates_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_title text := case new.status when 'received' then 'Справка подтверждена' else 'Справка не подтверждена' end;
  v_what  text := concat_ws(', ',
                    case new.kind when 'sick' then 'Больничный' when 'statement' then 'Заявление' else 'Справка' end,
                    case when new.date_from is not null or new.date_to is not null
                         then concat_ws('–', to_char(new.date_from, 'DD.MM.YYYY'), to_char(new.date_to, 'DD.MM.YYYY')) end);
  v_ref   jsonb := jsonb_build_object('certificate_id', new.id, 'status', new.status, 'student_id', new.student_id);
  v_name  text;
begin
  perform public._notify_student(new.group_id, new.student_id, 'certificate', v_title, v_what, v_ref);
  select concat_ws(' ', s.last_name, s.first_name) into v_name from public.students s where s.id = new.student_id;
  insert into public.notifications (user_id, group_id, kind, title, body, ref)
  select m.user_id, new.group_id, 'certificate', v_title, v_name || ': ' || v_what, v_ref
    from public.memberships m
   where m.group_id = new.group_id and m.status = 'active' and m.extra_role in ('headman', 'deputy')
     and m.student_id is distinct from new.student_id;      -- своя справка старосты: одно уведомление
  return null;
end;
$$;
