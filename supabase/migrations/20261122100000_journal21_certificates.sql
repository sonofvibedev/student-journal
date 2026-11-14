-- Журнал 2.1, п.13: справки — одна запись на документ, а не на каждый пропуск по предмету.
--
-- Модель:
--  - public.certificates — справка: вид sick (больничный) | exemption (освобождение) | statement (заявление) | other (прочее),
--    срок date_from–date_to, open = открытый больничный (date_to = null, пока открыт), сдана = status 'received' (+ received_at),
--    не сдана = 'waiting'; due_date — срок сдачи. Пропуски ссылаются на справку через absences.certificate_id (с этапа 2).
--  - Больничный длится несколько дней: у студента не больше одного открытого. Уважительный пропуск с причиной «Больничный»
--    сам привязывается к открытому больничному студента, а если его нет — открывает новый с датой пропуска (триггер, поэтому
--    работает и для пропусков из очереди без сети). «Новый больничный» = сначала закрыть открытый (certificate_set_open).
--  - Освобождение, заявление и прочее — одна справка на студента, вид и день: все пары дня привязываются к ней.
--  - Колонки absences.cert_type / cert_submitted / cert_due_date остаются: cert_type — причина пропуска (по ней выбирается
--    вид справки), cert_submitted и cert_due_date у привязанного пропуска повторяют справку (для отката и 1.x-зеркала).
--  - Создаёт справку триггер привязки, закрывает и отмечает «Сдана» староста/заместитель группы или сисадмин через RPC ниже;
--    напрямую (права этапа 2) остаются только правка описания и удаление ожидающей справки без пропусков.
--
-- Перенос данных (раздел 5): старые справки-в-пропусках сливаются по правилам tools/certs-merge.mjs (отчёт сверки:
-- docs/reports/v21-certificates-migration.md). Меняется только absences.certificate_id; числа пропусков, часов, уважительных и все
-- остальные поля пропусков сверяются до/после — при расхождении миграция падает целиком. Повторный запуск ничего не меняет.
-- Метки для отката: справки переноса — id 'ce-m13-…', созданные триггером привязки — 'ce-a-…'; откат трогает только их.
-- Откат: supabase/migrations_down/20261122100000_journal21_certificates.down.sql.

-- ===================================================================================================
-- 1. Схема
-- ===================================================================================================
alter table public.certificates drop constraint if exists certificates_kind_check;
alter table public.certificates add constraint certificates_kind_check check (kind in ('sick', 'exemption', 'statement', 'other'));
alter table public.certificates add column if not exists open boolean not null default false;
-- открытым бывает только больничный и только без даты конца
alter table public.certificates drop constraint if exists certificates_open_check;
alter table public.certificates add constraint certificates_open_check check (not open or (kind = 'sick' and date_to is null));
-- у студента не больше одного открытого больничного; однодневная справка — одна на вид и день
create unique index if not exists certificates_one_open on public.certificates (student_id, group_id) where open;
create unique index if not exists certificates_one_day on public.certificates (student_id, group_id, kind, date_from) where kind <> 'sick';
comment on column public.certificates.open is 'Открытый больничный: date_to = null, к нему привязываются новые пропуски с причиной «Больничный»';

-- Права этапа 2 не меняются: прямая правка описания / удаление ожидающей справки старостой и RPC certificate_create /
-- certificate_resolve остаются (интерфейс 2.1 их не вызывает, тесты tests/db/cabinets.sql их держат). Они не ломают модель:
-- справку с привязанными пропусками удалить нельзя (FK), а срок и привязку триггеры ниже пересчитывают при любой правке пропуска.

-- ===================================================================================================
-- 2. Вспомогательные функции
-- ===================================================================================================

-- Вид справки по причине пропуска (absences.cert_type). null — без причины: справки нет.
create or replace function public._cert_kind(p_type text)
returns text language sql immutable set search_path = '' as $$
  select case when nullif(btrim(p_type), '') is null then null
              when btrim(p_type) = 'Больничный' then 'sick'
              when btrim(p_type) = 'Освобождение' then 'exemption'
              when btrim(p_type) = 'Заявление' then 'statement'
              else 'other' end;
$$;

-- Причина пропуска по виду справки (для certificate_link)
create or replace function public._cert_type_ru(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind when 'sick' then 'Больничный' when 'exemption' then 'Освобождение' when 'statement' then 'Заявление' else 'Справка' end;
$$;

-- Срок справки по привязанным пропускам: начало — самый ранний, конец — самый поздний (у открытого — null).
-- Справка без пропусков удаляется: её создали пропуски, она ничего не покрывает (след пропусков — в absence_cancellations).
create or replace function public._cert_recount(p_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_from date; v_to date; v_n int;
begin
  select min(a.date), max(a.date), count(*) into v_from, v_to, v_n from public.absences a where a.certificate_id = p_id;
  if v_n = 0 then
    delete from public.certificates where id = p_id;
    return;
  end if;
  update public.certificates c
     set date_from = v_from, date_to = case when c.open then null else v_to end
   where c.id = p_id and (c.date_from, c.date_to) is distinct from (v_from, case when c.open then null else v_to end);
end;
$$;

-- ===================================================================================================
-- 3. Триггеры absences: привязка к справке и пересчёт срока
-- ===================================================================================================

-- BEFORE INSERT/UPDATE (после absences_guard и erased_student_guard: имя начинается с zz_).
-- Уважительный пропуск с датой и причиной привязывается к справке своего вида:
--   больничный — к открытому больничному студента (нет открытого — открывается новый с этой даты);
--   прочее — к справке того же вида на этот день (нет — создаётся однодневная; «Уже сдал» и срок берутся из пропуска).
-- Привязанный пропуск повторяет справку: cert_submitted = «сдана», cert_due_date = срок справки.
-- Неуважительный, без причины или без даты — отвязывается. certificate_id, поставленный доверенным кодом (RPC справок,
-- миграция), не трогается: клиенту эта колонка закрыта правами и absences_guard.
create or replace function public.absences_cert_link()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := case when new.is_excused and new.date is not null then public._cert_kind(new.cert_type) end;
  c public.certificates;
begin
  if (tg_op = 'INSERT' and new.certificate_id is not null)
     or (tg_op = 'UPDATE' and new.certificate_id is distinct from old.certificate_id) then
    return new;
  end if;
  -- повторная отправка из очереди (insert … on conflict do nothing): строка уже есть, вставки не будет — справку не создаём
  if tg_op = 'INSERT' and exists (select 1 from public.absences a where a.id = new.id) then
    return new;
  end if;
  if v_kind is null then
    new.certificate_id := null;
    return new;
  end if;
  if new.certificate_id is not null then                -- уже привязан: остаётся, если справка подходит
    select * into c from public.certificates where id = new.certificate_id;
    if not (found and c.kind = v_kind and (v_kind = 'sick' or c.date_from = new.date)) then
      c := null;
    end if;
  end if;
  if c.id is null then
    if v_kind = 'sick' then
      select * into c from public.certificates
       where student_id = new.student_id and group_id = new.group_id and open;
      if not found then
        -- новый больничный открыт и не сдан; срок сдачи появится при закрытии
        insert into public.certificates (id, group_id, student_id, kind, date_from, date_to, due_date, status, open, created_by)
          values ('ce-a-' || replace(gen_random_uuid()::text, '-', ''), new.group_id, new.student_id, 'sick', new.date, null, null,
                  'waiting', true, auth.uid())
          on conflict do nothing
          returning * into c;
        if c.id is null then                            -- одновременно открыл другой запрос
          select * into c from public.certificates where student_id = new.student_id and group_id = new.group_id and open;
        end if;
      end if;
    else
      select * into c from public.certificates
       where student_id = new.student_id and group_id = new.group_id and kind = v_kind and date_from = new.date;
      if not found then
        insert into public.certificates (id, group_id, student_id, kind, date_from, date_to, due_date, status, received_at, created_by)
          values ('ce-a-' || replace(gen_random_uuid()::text, '-', ''), new.group_id, new.student_id, v_kind, new.date, new.date, new.cert_due_date,
                  case when new.cert_submitted then 'received' else 'waiting' end, case when new.cert_submitted then now() end, auth.uid())
          on conflict do nothing
          returning * into c;
        if c.id is null then
          select * into c from public.certificates
           where student_id = new.student_id and group_id = new.group_id and kind = v_kind and date_from = new.date;
        end if;
      end if;
    end if;
  end if;
  new.certificate_id := c.id;
  new.cert_submitted := c.status = 'received';
  new.cert_due_date := c.due_date;
  return new;
end;
$$;

-- AFTER: срок затронутых справок по оставшимся пропускам; опустевшая справка удаляется
create or replace function public.absences_cert_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'INSERT' and old.certificate_id is not null
     and (tg_op = 'DELETE' or old.certificate_id is distinct from new.certificate_id or old.date is distinct from new.date) then
    perform public._cert_recount(old.certificate_id);
  end if;
  if tg_op <> 'DELETE' and new.certificate_id is not null
     and (tg_op = 'INSERT' or old.certificate_id is distinct from new.certificate_id or old.date is distinct from new.date) then
    perform public._cert_recount(new.certificate_id);
  end if;
  return null;
end;
$$;

-- absences_guard: «закрыт справкой» теперь значит «справка сдана». Пропуск под сданной справкой нельзя напрямую сделать
-- неуважительным или сменить причину — сначала снять отметку «Сдана» (certificate_set_submitted). Привязка к несданной
-- справке правке не мешает (триггер перепривяжет или отвяжет). Остальное — как в 20261106100000.
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
  if old.certificate_id is not null and old.cert_submitted
     and (new.is_excused, new.cert_type) is distinct from (old.is_excused, old.cert_type) then
    raise exception 'absences: пропуск закрыт сданной справкой' using errcode = '42501';
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

-- Уведомление «Справка подтверждена»: + освобождение, однодневная справка — одной датой, открытый больничный — «с …»
create or replace function public.certificates_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_title text := case new.status when 'received' then 'Справка подтверждена' else 'Справка не подтверждена' end;
  v_what  text := concat_ws(', ', public._cert_type_ru(new.kind),
                    case when new.date_from is null and new.date_to is null then null
                         when new.date_to is null then 'с ' || to_char(new.date_from, 'DD.MM.YYYY')
                         when new.date_from is not distinct from new.date_to then to_char(new.date_from, 'DD.MM.YYYY')
                         else concat_ws('–', to_char(new.date_from, 'DD.MM.YYYY'), to_char(new.date_to, 'DD.MM.YYYY')) end);
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

-- ===================================================================================================
-- 4. RPC (староста/заместитель группы справки, сисадмин; журнал открыт, нет техработ)
-- ===================================================================================================

-- Справка для записи: блокировка строки, права, техработы и закрытая группа
create or replace function public._cert_for_write(p_certificate text)
returns public.certificates language plpgsql security definer set search_path = '' as $$
declare c public.certificates;
begin
  select * into c from public.certificates where id = p_certificate for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.is_group_staff(c.group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public._assert_writable(c.group_id);
  return c;
end;
$$;

-- «Закрыть больничный» (p_open = false): конец = дата последнего привязанного пропуска, срок сдачи — если не задан,
-- через 3 дня после конца (как DOC_DAYS в «Отметках»). «Открыть снова» (p_open = true): только несданный больничный,
-- и только если у студента нет другого открытого (already_open). → {ok, open, date_from, date_to, due_date}
create or replace function public.certificate_set_open(p_certificate text, p_open boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.certificates; v_to date;
begin
  if p_open is null then raise exception 'bad_request' using errcode = '22023'; end if;
  c := public._cert_for_write(p_certificate);
  if c.kind <> 'sick' then raise exception 'not_sick' using errcode = '22023'; end if;
  if c.open = p_open then
    return jsonb_build_object('ok', true, 'open', c.open, 'date_from', c.date_from, 'date_to', c.date_to, 'due_date', c.due_date);
  end if;
  if p_open then
    if c.status = 'received' then raise exception 'already_received' using errcode = 'P0001'; end if;
    if exists (select 1 from public.certificates o where o.student_id = c.student_id and o.group_id = c.group_id and o.open) then
      raise exception 'already_open' using errcode = 'P0001';
    end if;
    update public.certificates set open = true, date_to = null where id = c.id returning * into c;
  else
    select max(a.date) into v_to from public.absences a where a.certificate_id = c.id;
    v_to := coalesce(v_to, c.date_from);
    update public.certificates set open = false, date_to = v_to, due_date = coalesce(due_date, v_to + 3)
     where id = c.id returning * into c;
    update public.absences set cert_due_date = c.due_date where certificate_id = c.id and cert_due_date is distinct from c.due_date;
  end if;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), c.group_id, 'certificate_set_open',
            jsonb_build_object('certificate_id', c.id, 'student_id', c.student_id, 'open', c.open, 'date_to', c.date_to));
  return jsonb_build_object('ok', true, 'open', c.open, 'date_from', c.date_from, 'date_to', c.date_to, 'due_date', c.due_date);
end;
$$;

-- «Сдана» / снять отметку. Открытый больничный сначала закрывают (cert_open). Привязанные пропуски повторяют статус.
-- → {ok, status, absences}
create or replace function public.certificate_set_submitted(p_certificate text, p_submitted boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.certificates; v_n int;
begin
  if p_submitted is null then raise exception 'bad_request' using errcode = '22023'; end if;
  c := public._cert_for_write(p_certificate);
  if p_submitted and c.open then raise exception 'cert_open' using errcode = 'P0001'; end if;
  if (c.status = 'received') <> p_submitted then
    update public.certificates
       set status = case when p_submitted then 'received' else 'waiting' end,
           received_at = case when p_submitted then now() end
     where id = c.id returning * into c;
  end if;
  update public.absences set cert_submitted = p_submitted
   where certificate_id = c.id and cert_submitted is distinct from p_submitted;
  get diagnostics v_n = row_count;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), c.group_id, 'certificate_set_submitted',
            jsonb_build_object('certificate_id', c.id, 'student_id', c.student_id, 'submitted', p_submitted));
  return jsonb_build_object('ok', true, 'status', c.status, 'absences', v_n);
end;
$$;

-- Привязать пропуски к выбранной справке того же студента и группы: пропуск становится уважительным с причиной вида справки
-- и повторяет её статус. Однодневной справке подходят только пропуски её дня, сданной — ничего (сначала снять отметку).
-- Пропуск под другой сданной справкой не переносится. Хоть один неподходящий id → bad_absence, ничего не меняется.
-- Срок обеих справок пересчитывается (опустевшая прежняя удаляется). → {ok, linked}
create or replace function public.certificate_link(p_certificate text, p_absence_ids text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.certificates; v_ids text[] := coalesce(p_absence_ids, '{}'); v_n int;
begin
  c := public._cert_for_write(p_certificate);
  if c.status = 'received' then raise exception 'already_received' using errcode = 'P0001'; end if;
  if cardinality(v_ids) = 0 or exists (
       select 1 from unnest(v_ids) x(id)
        where not exists (
          select 1 from public.absences a
            left join public.certificates o on o.id = a.certificate_id
           where a.id = x.id and a.student_id = c.student_id and a.group_id = c.group_id and a.date is not null
             and (c.kind = 'sick' or a.date = c.date_from)
             and (o.id is null or o.id = c.id or o.status <> 'received'))) then
    raise exception 'bad_absence' using errcode = '22023';
  end if;
  update public.absences a
     set certificate_id = c.id, is_excused = true, cert_type = public._cert_type_ru(c.kind),
         cert_submitted = false, cert_due_date = c.due_date
   where a.id = any (v_ids) and a.certificate_id is distinct from c.id;
  get diagnostics v_n = row_count;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), c.group_id, 'certificate_link',
            jsonb_build_object('certificate_id', c.id, 'student_id', c.student_id, 'absences', to_jsonb(v_ids)));
  return jsonb_build_object('ok', true, 'linked', v_n);
end;
$$;

-- ===================================================================================================
-- 5. Перенос данных: старые справки-в-пропусках → справки (тот же алгоритм, что tools/certs-merge.mjs)
-- ===================================================================================================
do $$
declare
  -- Исключение владельца (2026-11-14, по dry run): Ракитская (st-1758300000013) и Щигло (st-1758300000024) — один больничный
  -- 19.10–24.10, хотя 21.10 у группы были пары (пропусков в тот день не внесено). Только для них и только этот день;
  -- общее правило не меняется. То же — JOIN в tools/certs-merge.mjs.
  v_join text[] := array['st-1758300000013|2026-10-21', 'st-1758300000024|2026-10-21'];
  n0 bigint; h0 numeric; e0 bigint; s0 text;
  n1 bigint; h1 numeric; e1 bigint; s1 text;
  v_certs int; v_linked int;
begin
  -- до: число пропусков, часы, уважительные, отпечаток всех полей, кроме certificate_id
  select count(*), coalesce(sum(a.hours), 0), count(*) filter (where a.is_excused),
         md5(coalesce(string_agg(concat_ws('|', a.id, a.group_id, a.student_id, a.date, a.subject, a.hours, a.is_excused,
                                           a.cert_type, a.cert_submitted, a.cert_due_date, a.comment, a.lesson_kind, a.pair_no,
                                           a.created_by, a.created_at), E'\n' order by a.id), ''))
    into n0, h0, e0, s0 from public.absences a;

  -- что переносим: уважительные с датой и причиной, ещё без справки
  drop table if exists _cm_src, _cm;
  create temp table _cm_src on commit drop as
    select a.id, a.group_id, a.student_id, a.date, a.hours, a.cert_submitted, a.cert_due_date, a.created_at,
           public._cert_kind(a.cert_type) as kind
      from public.absences a
     where a.certificate_id is null and a.is_excused and a.date is not null and public._cert_kind(a.cert_type) is not null;

  -- острова: больничные подряд без учебного дня (дня с парами в schedule_lessons группы) между соседними датами;
  -- прочее — по одному на вид и день
  create temp table _cm on commit drop as
  with d as (select distinct s.group_id, s.student_id, s.kind, s.date from _cm_src s),
  l as (select d.*, lag(d.date) over (partition by d.group_id, d.student_id, d.kind order by d.date) as prev from d),
  i as (
    select l.*, sum(case when l.kind <> 'sick' or l.prev is null or exists (
                   select 1 from public.schedule_lessons sl
                    where sl.group_id = l.group_id and sl.lesson_date > l.prev and sl.lesson_date < l.date
                      and not (l.student_id || '|' || sl.lesson_date::text = any (v_join)))
                 then 1 else 0 end) over (partition by l.group_id, l.student_id, l.kind order by l.date) as isl
      from l),
  f as (select i.*, min(i.date) over (partition by i.group_id, i.student_id, i.kind, i.isl) as dfrom from i)
  select s.*, 'ce-m13-' || md5(s.student_id || '|' || s.kind || '|' || f.dfrom::text) as cid
    from _cm_src s join f on f.group_id = s.group_id and f.student_id = s.student_id and f.kind = s.kind and f.date = s.date;

  -- «Сдана»: received_at — когда внесён последний из слитых пропусков (точного времени сдачи в 2.0 не было)
  insert into public.certificates (id, group_id, student_id, kind, date_from, date_to, due_date, status, received_at, note, open, created_by)
  select m.cid, m.group_id, m.student_id, m.kind, min(m.date), max(m.date), max(m.cert_due_date),
         case when bool_and(m.cert_submitted) then 'received' else 'waiting' end,
         case when bool_and(m.cert_submitted) then coalesce(max(m.created_at), now()) end,
         case when bool_or(m.cert_submitted) and not bool_and(m.cert_submitted) then
           'Объединено из пропусков: сдано за '
           || (select string_agg(to_char(z.date, 'DD.MM'), ', ' order by z.date) from (select distinct y.date from _cm y where y.cid = m.cid and y.cert_submitted) z)
           || '; не сдано за '
           || (select string_agg(to_char(z.date, 'DD.MM'), ', ' order by z.date) from (select distinct y.date from _cm y where y.cid = m.cid and not y.cert_submitted) z)
         end,
         false, null
    from _cm m
   group by m.cid, m.group_id, m.student_id, m.kind
  on conflict (id) do nothing;
  get diagnostics v_certs = row_count;

  -- зеркало 1.x (journal_private) не нужно: certificate_id в jsonb не попадает
  alter table public.absences disable trigger absences_mirror_upd;
  update public.absences a set certificate_id = m.cid from _cm m where a.id = m.id and a.certificate_id is null;
  get diagnostics v_linked = row_count;
  alter table public.absences enable trigger absences_mirror_upd;

  -- после: ничего, кроме certificate_id, не изменилось
  select count(*), coalesce(sum(a.hours), 0), count(*) filter (where a.is_excused),
         md5(coalesce(string_agg(concat_ws('|', a.id, a.group_id, a.student_id, a.date, a.subject, a.hours, a.is_excused,
                                           a.cert_type, a.cert_submitted, a.cert_due_date, a.comment, a.lesson_kind, a.pair_no,
                                           a.created_by, a.created_at), E'\n' order by a.id), ''))
    into n1, h1, e1, s1 from public.absences a;
  if (n1, h1, e1) is distinct from (n0, h0, e0) then
    raise exception 'certificates migration: пропусков % → %, часов % → %, уважительных % → %', n0, n1, h0, h1, e0, e1;
  end if;
  if s1 is distinct from s0 then raise exception 'certificates migration: изменились поля пропусков'; end if;
  if exists (select 1 from public.absences a where a.certificate_id is null and a.is_excused and a.date is not null
                                                and public._cert_kind(a.cert_type) is not null) then
    raise exception 'certificates migration: остались уважительные пропуски с причиной без справки';
  end if;
  if exists (select 1 from public.certificates c where not exists (select 1 from public.absences a where a.certificate_id = c.id)) then
    raise exception 'certificates migration: есть справка без пропусков';
  end if;
  if exists (select 1 from public.absences a join public.certificates c on c.id = a.certificate_id
              where (c.kind <> 'sick' and a.date <> c.date_from) or a.date < c.date_from or a.date > c.date_to) then
    raise exception 'certificates migration: пропуск вне срока своей справки';
  end if;
  raise notice 'certificates migration: справок создано %, пропусков привязано %, всего пропусков %, часов %', v_certs, v_linked, n1, h1;
end $$;

-- ===================================================================================================
-- 6. Триггеры (после переноса: перенос сам ставит certificate_id) и права на функции
-- ===================================================================================================
drop trigger if exists zz_absences_cert_link on public.absences;
create trigger zz_absences_cert_link before insert or update on public.absences
  for each row execute function public.absences_cert_link();
drop trigger if exists absences_cert_sync on public.absences;
create trigger absences_cert_sync after insert or update or delete on public.absences
  for each row execute function public.absences_cert_sync();

do $$
declare f text;
begin
  foreach f in array array['_cert_kind(text)', '_cert_type_ru(text)', '_cert_recount(text)', '_cert_for_write(text)',
                           'absences_cert_link()', 'absences_cert_sync()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['certificate_set_open(text, boolean)', 'certificate_set_submitted(text, boolean)',
                           'certificate_link(text, text[])'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
