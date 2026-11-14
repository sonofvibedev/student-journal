-- Тесты 2.1 п.13: справки — одна запись на документ (миграция 20261122100000_journal21_certificates.sql).
-- Привязка пропусков к справке (триггер), открытый больничный, однодневные справки, RPC certificate_set_open /
-- certificate_set_submitted / certificate_link, права и RLS, absences_guard, пересчёт срока, удаление опустевшей справки.
-- Фикстуры prelude: 1 староста A, 2 заместитель A, 3 студент A (t-a3), 5 препод лекций A («Маркетинг услуг»), 7 сисадмин,
-- 8 староста B, 9 студент B (t-b2).
-- Локально без стенда: node tools/test/run-db-local.mjs tests/db/certificates.sql (PGlite, см. tools/test/pglite.mjs).

create function pg_temp.val_as(u uuid, expr text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(u);
  begin execute 'select (' || expr || ')::text' into v; exception when others then v := 'ERR:' || sqlstate || ':' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;
create function pg_temp.state_as(u uuid, stmt text) returns text language plpgsql as $$
declare n bigint; v text;
begin
  perform pg_temp.as_user(u);
  begin execute stmt; get diagnostics n = row_count; v := 'ok:' || n;
  exception when others then v := sqlstate || ':' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;
create function pg_temp.is(t text, got text, want text) returns void language sql as
$$ insert into pg_temp.res values (t, got is not distinct from want, 'ожидалось ' || coalesce(want, 'null') || ', получено ' || coalesce(got, 'null')) $$;
create function pg_temp.starts(t text, got text, want text) returns void language sql as
$$ insert into pg_temp.res values (t, coalesce(got like want || '%', false), 'ожидалось ' || want || '…, получено ' || coalesce(left(got, 80), 'null')) $$;
create function pg_temp.ok(t text, c boolean, d text default '') returns void language sql as
$$ insert into pg_temp.res values (t, coalesce(c, false), coalesce(d, 'null')) $$;
-- вставка пропуска студента t-a3 группы A (как клиент кабинета старосты)
create function pg_temp.ab(id text, d text, typ text, ex boolean default true, sub boolean default false, due text default null, subj text default 'Статистика') returns text language sql as
$$ select format('insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, is_excused, cert_type, cert_submitted, cert_due_date)
                  values (%L, %L, %L, %L, %L, 2, %L, %L, %L, %L, %L)',
                 id, 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', d, subj, 'lecture', ex, typ, sub, due) $$;
-- справка пропуска
create function pg_temp.cert_of(p text) returns text language sql as $$ select certificate_id from public.absences where id = p $$;
create function pg_temp.c(p text) returns public.certificates language sql as
$$ select c.* from public.certificates c join public.absences a on a.certificate_id = c.id where a.id = p $$;

-- учебные дни группы A: пн–сб 2–7 и 9–14 ноября, кроме субботы 7.11 (праздник)
insert into public.study_days (day, semester, group_id)
select d::date, 'test', 'aaaaaaaa-0000-4000-8000-00000000000a'
  from generate_series('2026-11-02'::date, '2026-11-14'::date, '1 day') d
 where extract(isodow from d) < 7 and d::date <> '2026-11-07';

-- ===================================================================================================
-- 1. Больничный: первый пропуск открывает справку, следующие привязываются к ней
-- ===================================================================================================
select pg_temp.is('больничный: староста вносит пропуск 09.11', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-s1', '2026-11-09', 'Больничный')), 'ok:1');
select pg_temp.ok('больничный: открыта справка sick с 09.11, конца нет, не сдана, автор — староста',
  (select c.kind = 'sick' and c.open and c.date_from = '2026-11-09' and c.date_to is null and c.status = 'waiting'
          and c.created_by = pg_temp.u(1) and c.due_date is null from pg_temp.c('c-s1') c));
select pg_temp.ok('больничный: id справки из триггера с меткой ce-a- (её снимет откат)', pg_temp.cert_of('c-s1') like 'ce-a-%');
select pg_temp.is('больничный: второй пропуск 10.11 (другой предмет)', pg_temp.state_as(pg_temp.u(2), pg_temp.ab('c-s2', '2026-11-10', 'Больничный', subj => 'Маркетинг услуг')), 'ok:1');
select pg_temp.ok('больничный: 10.11 — та же справка', pg_temp.cert_of('c-s2') = pg_temp.cert_of('c-s1'));
select pg_temp.is('больничный: пропуск задним числом 06.11', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-s0', '2026-11-06', 'Больничный')), 'ok:1');
select pg_temp.ok('больничный: 06.11 — та же справка, начало сдвинулось на 06.11',
  pg_temp.cert_of('c-s0') = pg_temp.cert_of('c-s1') and (pg_temp.c('c-s1')).date_from = '2026-11-06');
select pg_temp.is('больничный: у студента один открытый', (select count(*)::text from public.certificates where student_id = 't-a3' and open), '1');
select pg_temp.ok('больничный: «Уже сдал» из пропуска не делает открытый больничный сданным',
  (select not cert_submitted from public.absences where id = 'c-s1'));
create temp table sk1 as select pg_temp.cert_of('c-s1') as id;
grant select on sk1 to public;

-- ===================================================================================================
-- 2. Права и RLS
-- ===================================================================================================
select pg_temp.expect_count('чтение: студент видит свою справку', pg_temp.u(3), 'select 1 from public.certificates where id = (select id from sk1)', 1);
select pg_temp.expect_count('чтение: студент B не видит', pg_temp.u(9), 'select 1 from public.certificates where student_id = ''t-a3''', 0);
select pg_temp.expect_count('чтение: староста B не видит', pg_temp.u(8), 'select 1 from public.certificates where student_id = ''t-a3''', 0);
select pg_temp.expect_count('чтение: преподаватель не видит', pg_temp.u(5), 'select 1 from public.certificates', 0);
select pg_temp.expect_count('чтение: заместитель видит', pg_temp.u(2), 'select 1 from public.certificates where id = (select id from sk1)', 1);
select pg_temp.expect_min('чтение: сисадмин видит', pg_temp.u(7), 'select 1 from public.certificates where id = (select id from sk1)', 1);
select pg_temp.expect_denied('напрямую: студент не правит свою справку', pg_temp.u(3), $$update public.certificates set note = 'x' where student_id = 't-a3'$$);
select pg_temp.expect_denied('напрямую: староста не удаляет справку с пропусками (FK)', pg_temp.u(1), $$delete from public.certificates where id = (select id from sk1)$$);
select pg_temp.expect_denied('напрямую: староста не вставляет справку', pg_temp.u(1),
  $$insert into public.certificates (group_id, student_id, kind) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'other')$$);
select pg_temp.expect_denied('напрямую: староста не ставит certificate_id пропуску', pg_temp.u(1),
  $$update public.absences set certificate_id = null where id = 'c-s1'$$);
select pg_temp.starts('RPC: студент не закрывает больничный', pg_temp.state_as(pg_temp.u(3), $$select public.certificate_set_open((select id from sk1), false)$$), '42501:forbidden');
select pg_temp.starts('RPC: староста B не закрывает', pg_temp.state_as(pg_temp.u(8), $$select public.certificate_set_open((select id from sk1), false)$$), '42501:forbidden');
select pg_temp.starts('RPC: преподаватель не отмечает сданной', pg_temp.state_as(pg_temp.u(5), $$select public.certificate_set_submitted((select id from sk1), true)$$), '42501:forbidden');
select pg_temp.starts('RPC: студент не привязывает пропуск', pg_temp.state_as(pg_temp.u(3), $$select public.certificate_link((select id from sk1), array['abs-a3'])$$), '42501:forbidden');
select pg_temp.starts('RPC: нет справки → not_found', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_open('ce-nope', false)$$), 'P0002:not_found');
select pg_temp.ok('RPC: anon не исполняет новые функции',
  not has_function_privilege('anon', 'public.certificate_set_open(text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.certificate_set_submitted(text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.certificate_link(text, text[])', 'execute')
  and not has_function_privilege('authenticated', 'public._cert_recount(text)', 'execute')
  and not has_function_privilege('authenticated', 'public._cert_for_write(text)', 'execute'));

-- закрытая группа и техработы
update public.groups set status = 'closed' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.starts('закрытая группа: закрыть больничный → group_closed', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_open((select id from sk1), false)$$), '42501:group_closed');
update public.groups set status = 'active' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
select pg_temp.starts('техработы: отметить сданной → maintenance', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_submitted((select id from sk1), false)$$), '42501:maintenance');
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';

-- ===================================================================================================
-- 3. Закрыть больничный, «Сдана», новый больничный
-- ===================================================================================================
select pg_temp.starts('открытый больничный нельзя отметить сданным → cert_open', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_submitted((select id from sk1), true)$$), 'P0001:cert_open');
select pg_temp.is('закрыть больничный (заместитель)', pg_temp.state_as(pg_temp.u(2), $$select public.certificate_set_open((select id from sk1), false)$$), 'ok:1');
select pg_temp.ok('закрыт: 06.11–10.11 (последний пропуск), срок сдачи 13.11',
  (select not open and date_from = '2026-11-06' and date_to = '2026-11-10' and due_date = '2026-11-13' from public.certificates where id = (select id from sk1)));
select pg_temp.ok('закрыт: пропуски повторяют срок сдачи', not exists (select 1 from public.absences where certificate_id = (select id from sk1) and cert_due_date is distinct from '2026-11-13'));
select pg_temp.ok('закрыт: в журнале действий', exists (select 1 from public.audit_log where action = 'certificate_set_open' and details ->> 'certificate_id' = (select id from sk1)));
select pg_temp.is('закрыть повторно — без ошибки', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_open((select id from sk1), false)$$), 'ok:1');
select pg_temp.is('после закрытия: новый пропуск 12.11 «Больничный»', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-s3', '2026-11-12', 'Больничный')), 'ok:1');
select pg_temp.ok('после закрытия: открыт новый больничный с 12.11',
  pg_temp.cert_of('c-s3') <> (select id from sk1) and (select open and date_from = '2026-11-12' from pg_temp.c('c-s3')));
select pg_temp.starts('открыть снова, когда есть другой открытый → already_open', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_open((select id from sk1), true)$$), 'P0001:already_open');
select pg_temp.is('освобождение 05.11 (для проверки not_sick)', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-e0', '2026-11-05', 'Освобождение')), 'ok:1');
select pg_temp.starts('закрыть: не больничный → not_sick (RPC)', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_open(pg_temp.cert_of('c-e0'), false)$$), '22023:not_sick');

select pg_temp.is('«Сдана»: закрытый больничный', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_submitted((select id from sk1), true)$$), 'ok:1');
select pg_temp.ok('«Сдана»: статус received и время, пропуски cert_submitted = true',
  (select status = 'received' and received_at is not null from public.certificates where id = (select id from sk1))
  and not exists (select 1 from public.absences where certificate_id = (select id from sk1) and not cert_submitted));
select pg_temp.ok('«Сдана»: уведомление студенту «Справка подтверждена: Больничный, 06.11.2026–10.11.2026»',
  exists (select 1 from public.notifications where user_id = pg_temp.u(3) and kind = 'certificate' and title = 'Справка подтверждена'
           and body = 'Больничный, 06.11.2026–10.11.2026'));
select pg_temp.ok('«Сдана»: старосте и заместителю — с ФИО',
  (select count(*) from public.notifications where user_id in (pg_temp.u(1), pg_temp.u(2)) and kind = 'certificate'
     and body = 'Тестов Студент: Больничный, 06.11.2026–10.11.2026') = 2);
select pg_temp.starts('сданный больничный нельзя открыть снова → already_received', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_open((select id from sk1), true)$$), 'P0001');
select pg_temp.starts('guard: пропуск под сданной справкой не сделать неуважительным', pg_temp.state_as(pg_temp.u(1),
  $$update public.absences set is_excused = false, cert_type = null where id = 'c-s1'$$), '42501:absences: пропуск закрыт сданной справкой');
select pg_temp.starts('guard: и причину не сменить', pg_temp.state_as(pg_temp.u(1),
  $$update public.absences set cert_type = 'Заявление' where id = 'c-s1'$$), '42501');
select pg_temp.is('guard: комментарий править можно', pg_temp.state_as(pg_temp.u(1), $$update public.absences set comment = 'ok' where id = 'c-s1'$$), 'ok:1');
select pg_temp.ok('guard: правка комментария не сбросила «сдана»', (select cert_submitted and certificate_id = (select id from sk1) from public.absences where id = 'c-s1'));
select pg_temp.is('снять отметку «Сдана»', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_submitted((select id from sk1), false)$$), 'ok:1');
select pg_temp.ok('снята: waiting, received_at пусто, пропуски не сданы',
  (select status = 'waiting' and received_at is null from public.certificates where id = (select id from sk1))
  and not exists (select 1 from public.absences where certificate_id = (select id from sk1) and cert_submitted));
select pg_temp.ok('снята: клиент не может сам поставить «сдана» привязанному пропуску (повторяет справку)',
  pg_temp.state_as(pg_temp.u(1), $$update public.absences set cert_submitted = true where id = 'c-s1'$$) = 'ok:1'
  and (select not cert_submitted from public.absences where id = 'c-s1'));

-- ===================================================================================================
-- 4. Правка и отмена пропусков пересчитывают срок; опустевшая справка удаляется
-- ===================================================================================================
select pg_temp.is('правка: 06.11 стал неуважительным', pg_temp.state_as(pg_temp.u(1),
  $$update public.absences set is_excused = false, cert_type = null where id = 'c-s0'$$), 'ok:1');
select pg_temp.ok('правка: пропуск отвязан, начало справки — 09.11',
  pg_temp.cert_of('c-s0') is null and (select date_from = '2026-11-09' and date_to = '2026-11-10' from public.certificates where id = (select id from sk1)));
select pg_temp.is('отмена: удалён 10.11', pg_temp.state_as(pg_temp.u(2), $$delete from public.absences where id = 'c-s2'$$), 'ok:1');
select pg_temp.ok('отмена: конец закрытой справки — 09.11', (select date_to = '2026-11-09' from public.certificates where id = (select id from sk1)));
create temp table sk2 as select pg_temp.cert_of('c-s3') as id;
grant select on sk2 to public;
select pg_temp.is('отмена: единственный пропуск открытого больничного', pg_temp.state_as(pg_temp.u(1), $$delete from public.absences where id = 'c-s3'$$), 'ok:1');
select pg_temp.ok('отмена: опустевшая справка удалена', not exists (select 1 from public.certificates where id = (select id from sk2)));
select pg_temp.ok('отмена: след в absence_cancellations хранит certificate_id',
  exists (select 1 from public.absence_cancellations where absence_id = 'c-s3' and absence ->> 'certificate_id' = (select id from sk2)));

-- ===================================================================================================
-- 5. Однодневные справки: освобождение / заявление / прочее — одна на вид и день
-- ===================================================================================================
select pg_temp.is('освобождение 11.11, 1-я пара, «Уже сдал»', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-e1', '2026-11-11', 'Освобождение', sub => true)), 'ok:1');
select pg_temp.is('освобождение 11.11, 2-я пара, срок 14.11', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-e2', '2026-11-11', 'Освобождение', sub => false, due => '2026-11-14', subj => 'Маркетинг услуг')), 'ok:1');
select pg_temp.ok('освобождение: одна справка 11.11–11.11, сдана, не открыта',
  pg_temp.cert_of('c-e1') = pg_temp.cert_of('c-e2')
  and (select kind = 'exemption' and date_from = '2026-11-11' and date_to = '2026-11-11' and status = 'received' and not open from pg_temp.c('c-e1')));
select pg_temp.ok('освобождение: 2-я пара повторяет справку (сдана)', (select cert_submitted from public.absences where id = 'c-e2'));
select pg_temp.is('заявление в тот же день', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-z1', '2026-11-11', 'Заявление', due => '2026-11-15')), 'ok:1');
select pg_temp.ok('заявление: своя справка, не сдана, срок 15.11',
  pg_temp.cert_of('c-z1') <> pg_temp.cert_of('c-e1') and (select kind = 'statement' and status = 'waiting' and due_date = '2026-11-15' from pg_temp.c('c-z1')));
select pg_temp.is('освобождение на другой день 12.11', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-e3', '2026-11-12', 'Освобождение')), 'ok:1');
select pg_temp.ok('освобождение 12.11 — отдельная справка', pg_temp.cert_of('c-e3') <> pg_temp.cert_of('c-e1'));
create temp table zk as select pg_temp.cert_of('c-z1') as id;
grant select on zk to public;
select pg_temp.is('смена причины: заявление → «Справка»', pg_temp.state_as(pg_temp.u(1), $$update public.absences set cert_type = 'Справка' where id = 'c-z1'$$), 'ok:1');
select pg_temp.ok('смена причины: новая справка other, прежняя (опустевшая) удалена',
  (select kind = 'other' and date_from = '2026-11-11' from pg_temp.c('c-z1')) and not exists (select 1 from public.certificates where id = (select id from zk)));
select pg_temp.is('смена даты пропуска с однодневной справкой', pg_temp.state_as(pg_temp.u(1), $$update public.absences set date = '2026-11-13' where id = 'c-e3'$$), 'ok:1');
select pg_temp.ok('смена даты: справка того же вида на новый день', (select kind = 'exemption' and date_from = '2026-11-13' and date_to = '2026-11-13' from pg_temp.c('c-e3')));
select pg_temp.is('уважительный без причины (как ставит преподаватель)', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-n1', '2026-11-13', null)), 'ok:1');
select pg_temp.ok('без причины: справки нет', pg_temp.cert_of('c-n1') is null);
select pg_temp.is('неуважительный «Больничный» (причина без уважительности)', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-n2', '2026-11-13', 'Больничный', ex => false)), 'ok:1');
select pg_temp.ok('неуважительный: справки нет, открытых больничных нет',
  pg_temp.cert_of('c-n2') is null and not exists (select 1 from public.certificates where student_id = 't-a3' and open));

-- повтор вставки из очереди (insert … on conflict do nothing): существующая строка не создаёт новую справку
select pg_temp.is('очередь: повтор вставки 09.11 «Больничный» (on conflict do nothing)', pg_temp.state_as(pg_temp.u(1),
  pg_temp.ab('c-s1', '2026-11-09', 'Больничный') || ' on conflict do nothing'), 'ok:0');
select pg_temp.ok('очередь: открытый больничный не появился', not exists (select 1 from public.certificates where student_id = 't-a3' and open));

-- ===================================================================================================
-- 6. certificate_link и «Открыть снова»
-- ===================================================================================================
select pg_temp.starts('link: пропуск другой группы → bad_absence', pg_temp.state_as(pg_temp.u(1),
  $$select public.certificate_link((select id from sk1), array['abs-b1'])$$), '22023:bad_absence');
select pg_temp.starts('link: к однодневной справке — только пропуск её дня', pg_temp.state_as(pg_temp.u(1),
  $$select public.certificate_link(pg_temp.cert_of('c-e3'), array['abs-a3'])$$), '22023:bad_absence');
select pg_temp.starts('link: к сданной справке нельзя', pg_temp.state_as(pg_temp.u(1),
  $$select public.certificate_link(pg_temp.cert_of('c-e1'), array['c-n1'])$$), 'P0001:already_received');
select pg_temp.is('link: неуважительный 04.11 → в больничный 09.11', pg_temp.state_as(pg_temp.u(1),
  $$select public.certificate_link((select id from sk1), array['abs-a3'])$$), 'ok:1');
select pg_temp.ok('link: пропуск уважительный, «Больничный», привязан; начало справки — 04.11',
  (select is_excused and cert_type = 'Больничный' and certificate_id = (select id from sk1) from public.absences where id = 'abs-a3')
  and (select date_from = '2026-11-04' from public.certificates where id = (select id from sk1)));
select pg_temp.is('открыть снова (других открытых нет)', pg_temp.state_as(pg_temp.u(1), $$select public.certificate_set_open((select id from sk1), true)$$), 'ok:1');
select pg_temp.ok('открыт снова: date_to пусто', (select open and date_to is null from public.certificates where id = (select id from sk1)));
select pg_temp.is('открыт снова: новый пропуск 13.11 «Больничный»', pg_temp.state_as(pg_temp.u(1), pg_temp.ab('c-s4', '2026-11-13', 'Больничный')), 'ok:1');
select pg_temp.ok('открыт снова: 13.11 привязан к нему', pg_temp.cert_of('c-s4') = (select id from sk1));
-- ограничения таблицы проверяем владельцем (клиенту вставка закрыта правами)
select pg_temp.expect_error('ограничение: второй открытый больничный студенту не вставить',
  $$insert into public.certificates (group_id, student_id, kind, date_from, open) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'sick', '2026-11-14', true)$$);
select pg_temp.expect_error('ограничение: открытым бывает только больничный',
  $$insert into public.certificates (group_id, student_id, kind, date_from, open) values ('bbbbbbbb-0000-4000-8000-00000000000b', 't-b2', 'other', '2026-11-14', true)$$);
select pg_temp.expect_error('ограничение: вторая однодневная справка того же вида и дня',
  $$insert into public.certificates (group_id, student_id, kind, date_from, date_to) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'exemption', '2026-11-11', '2026-11-11')$$);

-- ===================================================================================================
-- 7. Счётчики, которые читают справки
-- ===================================================================================================
select pg_temp.is('сводка: cert_waiting у t-a3 = несданные справки', pg_temp.val_as(pg_temp.u(1),
  $$(select cert_waiting from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null) where student_id = 't-a3')$$),
  (select count(*)::text from public.certificates where student_id = 't-a3' and status = 'waiting'));
