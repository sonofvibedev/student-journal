# Этап 2: база данных кабинетов студента и старосты

Миграция: `supabase/migrations/20261106100000_journal2_cabinets.sql`.
Откат: `supabase/migrations_down/20261106100000_journal2_cabinets.down.sql`.
Тесты: `tests/db/cabinets.sql` (вместе с `tests/db/rls.sql` запускаются `npm run test:db`).
G24 — группа 24ДММ-2 (`00000000-0000-4000-8000-000000000024`).

## 1. Что создаётся

| Таблица | Назначение | Клиент (authenticated) |
|---|---|---|
| `schedule_lessons` | пары по датам: `lesson_date, pair_no, starts_at, ends_at, subject, kind (lecture/practice/lab/other), teacher, room, subgroup (null = вся группа), prev_room, changed_at`; ключ `unique nulls not distinct (group_id, lesson_date, pair_no, subject, subgroup)` | только чтение |
| `schedule_meta` | состояние импорта: `semester_start, semester_end, last_import_at, last_status, last_error, lessons_count, week1_monday` | только чтение |
| `certificates` | справки `ce-…`: `kind sick/statement/other, date_from, date_to, due_date, status waiting/received/none, note, created_by, received_at` | чтение; правка описания и удаление ожидающей — староста |
| `absences.certificate_id` | пропуск закрыт справкой; FK `(certificate_id, student_id, group_id) → certificates (id, student_id, group_id)` — справка того же студента и группы | не пишется клиентом |
| `grades` | оценки `gr-…`: `subject, lesson_kind lecture/practice, value 1..10` **или** `passed`, `lesson_date, comment, created_by` | см. матрицу |
| `notifications` | колокольчик: `user_id, group_id, kind, title, body, ref jsonb, created_at, read_at` | свои строки, только чтение; «прочитано» — RPC |
| `students.subgroup` | было `text` (не использовалось), стало `smallint` с `check (subgroup in (1, 2))`, null = не выбрана | через RPC |

**Даты семестра** — в одном месте: `schedule_meta.semester_start/semester_end` (их пишет импорт расписания). `groups.semester_end` этапа 1 не удалена, потому что `schedule-import` (строка с `groups.update({ semester_end, schedule_status })`) её пишет; это копия, читать её не нужно. Убрать `semester_end` из этого update и колонку — отдельной миграцией, когда функция перестанет её писать.

Ограничения в БД: справка, оценка, пропуск не могут указывать на студента другой группы (составные FK на `students (id, group_id)`); пропуск не может ссылаться на справку другого студента (составной FK); у оценки ровно одно из `value`/`passed`; `date_from ≤ date_to`; дубль пары в расписании невозможен.

## 2. Матрица прав

| Таблица / действие | pending, removed, без группы | студент active | староста / зам | преподаватель | сисадмин | service_role |
|---|---|---|---|---|---|---|
| schedule_lessons: чтение | — | своя группа | своя группа | только `subject` из назначения (любой вид) | все | все |
| schedule_meta: чтение | — | своя группа | своя группа | группа с назначением | все | все |
| schedule_*: запись | — | — | — | — | — (только импорт) | да |
| certificates: чтение | — | **свои** | своя группа | — | все | все |
| certificates: создание / закрытие | — | — | `certificate_create`, `certificate_resolve` | — | RPC | да |
| certificates: правка `kind, date_from, date_to, due_date, note` / удаление | — | — | только `status = 'waiting'`, `group_open` | — | да | да |
| grades: чтение | — | **свои** | своя группа | `teaches(group, subject, lesson_kind)` | все | все |
| grades: вставка / правка (`value, passed, lesson_date, comment`) / удаление | — | — | — | `teaches(group, subject, lesson_kind)`, `group_open`, вставка с `created_by = я` | да | да |
| notifications | — | свои: чтение, `notifications_mark_*` | свои | свои | **только свои** | все |
| students.subgroup | — | своя запись через `student_set_subgroup` | своя | — | — | да |

Везде: запись требует `group_open(group_id)` (закрытая группа — только чтение); restrictive «Техработы» (`app_open()`) висит на всех пяти новых таблицах. RPC этапа 2 проверяют и `group_open`, и `app_open()` (иначе security definer обходил бы техработы: старосты новых групп при техработах закрыты, как решено на этапе 1).

## 3. RPC (все security definer, `search_path=''`, execute: authenticated, service_role)

| Функция | Кто | Возвращает / ошибки |
|---|---|---|
| `certificate_create(p_student_id text, p_kind text, p_from date, p_to date, p_due date, p_note text)` | староста/зам группы студента, сисадмин | `text` — id `ce-…`. Ошибки: `not_found`, `forbidden`, `maintenance`, `group_closed`, `bad_kind`, `bad_dates`. `p_note` обрезается до 500 знаков |
| `certificate_resolve(p_certificate text, p_status text, p_absence_ids text[])` | то же | `{ok, status, closed, hours}`. `received`: закрывает **только** переданные пропуски того же студента и группы, не закрытые другой справкой: `is_excused = true`, `cert_submitted = true`, `certificate_id`, `cert_type` = «Больничный»/«Заявление»/«Другое». Хоть один чужой id → `bad_absence`, ничего не меняется. `none`: только статус, `p_absence_ids` игнорируется. Ошибки: `already_received` (received — конечный статус), `bad_status` и как выше |
| `student_set_subgroup(p_subgroup smallint)` | свой active-студент (`claimed_by = я`, `claim_status = active`, active-членство) | `{ok, subgroup}`; `1`, `2` или `null`. Ошибки: `bad_subgroup`, `not_student`, `maintenance`, `group_closed` |
| `notifications_mark_read(p_ids uuid[])` | любой вошедший | `int` — сколько своих непрочитанных отмечено; чужие id молча игнорируются |
| `notifications_mark_all_read()` | любой вошедший | `int` |
| `absence_hours_my(p_group uuid)` | active-студент группы (в т. ч. староста) | `{total, excused, unexcused, warn_hours, dean_hours, period_from, period_to}` за **текущий календарный месяц по Минску**. Ошибки: `forbidden`, `maintenance` |
| `group_absence_summary(p_group uuid, p_from date, p_to date)` | староста/зам, сисадмин | `table(student_id text, student_name text, total numeric, excused numeric, cert_waiting int)` — все студенты группы (и без пропусков), порядок `sort, фамилия, имя`; `null` в датах = без границы; `cert_waiting` — справки в статусе `waiting` без учёта периода. Ошибки: `forbidden`, `maintenance` |

**Как считаются часы.** Как в 1.x: `renderHomeHours` в `index.html` берёт пропуски студента за текущий календарный месяц и сравнивает с порогом только **неуважительные** часы (`DEAN_WARNING_HOURS = 12`; «Почти лимит» — когда до порога ≤ 2 ч). `dean-report.js` — тоже помесячный. Поэтому `absence_hours_my` отдаёт часы месяца, а пороги группы (`warn_hours` = «предупреждение», по умолчанию 8; `dean_hours` = «деканат», 12) клиент сравнивает с `unexcused`. В 2.0 вместо «≤ 2 ч до порога» есть явный `warn_hours`.

Ошибки — `raise exception '<код>'`: `forbidden`, `maintenance`, `group_closed`, `not_student` = 42501; `not_found` = P0002; `already_received` = P0001; `bad_*` = 22023. В supabase-js код приходит в `error.message`.

## 4. Уведомления

Пишут только security definer триггеры (и service_role). Клиент не может вставить, изменить или удалить строку. Получатели — только active-членства; pending и удалённые ничего не получают.

| Событие | Кому | kind / title / body | ref |
|---|---|---|---|
| вставка в `absences` с `created_by is not null` (легаси-импорт не шлёт) | студент | `absence` / «Внесён пропуск» / «Маркетинг услуг, лекция: 2 ч» (вид пропускается, если null) | `{absence_id, date}` |
| вставка в `tasks` | active-студенты группы, кроме автора; при `rec.subgroup` = 1/2 пропускаются студенты, выбравшие другую подгруппу (не выбравшие — получают) | `task` / «Новое задание» или «Новый дедлайн» / «предмет: текст» (до 300 знаков) | `{task_id, kind, due}` |
| `certificates.status` → `received` / `none` | студент; староста и зам группы (кроме самого студента) | `certificate` / «Справка подтверждена» / «Справка не подтверждена» / «Больничный, 03.11.2026–04.11.2026»; старосте с ФИО студента впереди | `{certificate_id, status, student_id}` |
| вставка в `grades` | студент | `grade` / «Новая оценка» / «Маркетинг услуг, лекция: 8» или «зачтено»/«не зачтено» | `{grade_id, date}` |

Текст содержит только то, что получатель и так видит (свой пропуск, своя оценка, задания своей группы; ФИО студента — старосте его группы).

## 5. Затронутые существующие объекты (до → после)

| Объект | Было | Стало |
|---|---|---|
| `students.subgroup` | `text`, без ограничений | `smallint`, `check in (1,2)`; значения `'1'`/`'2'` сохраняются, прочее → null |
| `absences` права authenticated | `insert`, `update` на таблицу | `insert`, `update` по списку колонок **без** `certificate_id` (политики прежние) |
| `absences_guard()` | — | + `certificate_id` в списке неизменяемых полей; пропуск, закрытый справкой, нельзя сделать неуважительным / «справка не сдана» напрямую (только security definer RPC проходит, т. к. guard пропускает не-клиентские роли) |
| триггеры `absences` | `absences_guard` | + `absences_notify` (row, after insert), `absences_mirror_ins/upd/del` (statement, переходные таблицы) |
| триггеры `students` | — | + `students_mirror_ins/upd/del` |
| триггеры `tasks` | — | + `tasks_notify`, `zz_fill_group_id` |
| `app_events, student_achievements, game_records, tasks, study_days`.`group_id` | `not null default G24` | `not null` **без** default + триггер `zz_fill_group_id` (before insert) |
| `app_events_fill_owner()` | `student_id` только из `profiles` (у новых групп профиля нет → ошибка) | из `profiles`, иначе из `students.claimed_by = я, claim_status = active`; `search_path` `public` → `''` |
| `attendance_badges_deserved()` | `(student_id, code, period)`, только `journal_private`, `study_days` без группы | `(group_id, student_id, code, period)`: G24 — по `journal_private` (как раньше, результат на тестовой копии совпал побитно: 325 строк, тот же хэш), остальные группы — по `students`/`absences`; учебные дни своей группы |
| `recompute_attendance_badges()` | отзывал управляемые значки у всех, кого нет в `journal_private`; вставлял без группы | считает все группы; вставляет с `group_id` и семестром своей группы |
| `journal_private` | меняла только `journal-save` | + зеркало из `absences`/`students` для G24 (п. 6) |

`fill_group_id()` по порядку: явный `group_id` → группа студента строки (`student_id`) → единственная active-группа вызывающего → **только `tasks` и только не клиентская роль**: G24 → иначе ошибка `23502`.

Аудит писателей, которые полагались на default G24:

| Писатель | Роль | Что пишет | Как теперь |
|---|---|---|---|
| `submit-game-score` | service_role | `game_records` | группа из `student_id` |
| `_shared/words.ts` `grantBadges` (submit-game-score, word-of-day) | service_role | `student_achievements` | группа из `student_id` |
| `_shared/taskstore.ts` `applyOps` (tg-bot, админка 1.x через Edge Functions) | service_role | `tasks` (upsert без `group_id`) | **оставлен легаси-путь G24** в триггере: у `tasks` нет `student_id`, а taskstore обслуживает только зеркало `data.json` 24ДММ-2 |
| `recompute_attendance_badges` | владелец | `student_achievements` | передаёт `group_id` |
| `achievements.js` (клиент) | authenticated | `app_events`, `student_achievements` | группа из `student_id` (RLS по-прежнему сверяет с `my_student_id`) |
| `tools/test/seed-test.mjs` | владелец, триггеры выключены | все пять таблиц | передаёт `group_id` G24 явно |
| `study_days` | только миграции | — | без `group_id` → ошибка |

## 6. Зеркало в journal_private (G24)

Пока старый `index.html` читает `journal_private`, а новый кабинет старосты пишет в `absences`/`students`, statement-триггеры переносят изменения строк **G24** в jsonb:

- вставка: элемент добавляется, если его id в jsonb ещё нет (строки легаси-импорта там уже есть — не трогаются);
- правка: поля накладываются на элемент с тем же id (`e || new`); чужие ключи элемента (`isAdmin`, `role`, `middleName`…) сохраняются; `date`, `totalHours`, `subject`, а у студентов все поля — только если не null (кривую легаси-дату не затираем);
- удаление: элемент убирается;
- формат 1.x: пропуск `{id, studentId, date, totalHours, isExcused, subject, comment, certType, certDueDate, certSubmitted}`, студент `{id, lastName, firstName, status: Бюджет/Платное, telegramUsername}`;
- `journal_private` пишется, только если jsonb реально изменился (повтор той же правки — ничего), и одним `update` на оператор;
- рекурсии нет: на `journal_private` висит только пересчёт значков (пишет `student_achievements`);
- изменения других групп jsonb не трогают; для них тот же триггер вызывает `recompute_attendance_badges()` (у G24 пересчёт идёт через триггер `journal_private_badges`). Сбой пересчёта не откатывает запись пропуска (warning).

Проверено тестом: вставка/правка/повтор/удаление пропуска G24, правка легаси-пропуска, правка студента G24 → jsonb; группа A → jsonb не меняется.

**Остаётся опасность:** Edge Function `journal-save` (старая админка) перезаписывает `journal_private` целиком. Всё, что кабинет записал после её последней загрузки, она сотрёт из jsonb (в таблицах останется), а её правки в таблицы не попадут. После переключения на кабинет `journal-save` должна отказывать в записи (зона владельца Edge Functions).

## 7. Решения

1. Справка в статусе `received` — конечная: повторное закрытие и откат на `none` запрещены (`already_received`). Поэтому `none` никогда не открывает пропуски: открывать нечего. `none → received` разрешено (справку донесли позже). Ошибку старосты исправляет сисадмин.
2. `certificate_resolve` проходит `absences_guard` штатно: guard пропускает не-клиентские роли (security definer RPC), а сама RPC ставит `is_excused` только вместе с `cert_submitted = true` — то же правило, что guard требует от старосты. Guard не отключается.
3. Справки создаются и закрываются только через RPC; напрямую — правка описания и удаление ожидающей справки (на неё ещё ничего не ссылается).
4. Уведомление о пропуске не шлётся для строк с `created_by is null` (легаси-импорт из `journal_private`, сотни старых пропусков).
5. «Актуально на» для значков новых групп — вчера по Минску (сегодняшние пропуски могут быть ещё не внесены). У G24 — `journal_private.updated_at`, как раньше.
6. Студент по-прежнему видит все пропуски группы (решение этапа 1), но справки и оценки — только свои.
7. Сисадмин читает справки и оценки всех групп, но не чужие уведомления.

## 8. Риски

- **journal-save** перезаписывает jsonb (п. 6).
- До переключения клиента источник правды для G24 — `journal_private`: `absence_hours_my` и `group_absence_summary` для G24 видят таблицы, куда правки старой админки после импорта не попадают. Перед запуском кабинета для G24: перезалить легаси-строки или переключать одновременно с блокировкой `journal-save`.
- `taskstore` пишет `tasks` без `group_id` → триггер ставит G24. Новый service-писатель заданий без `group_id` тоже попадёт в G24 — передавайте `group_id` явно.
- Пересчёт значков идёт на каждый оператор с пропусками не-G24 и считает все группы. ponytail: полный пересчёт, при десятках групп — пересчитывать только затронутые группы.
- Зеркало не переносит в jsonb пропуски G24, вставленные service_role, если их id уже есть в jsonb (так и задумано для импорта).
- Откат удаляет справки, оценки, уведомления, расписание вместе с данными; связи `absences.certificate_id` теряются (уважительность пропусков остаётся). Правки jsonb, сделанные зеркалом, остаются.

## 9. Чек-лист деплоя в прод (дополнение к stage1-db.md, п. 10)

1. Бэкап как в этапе 1 + `certificates`/`grades` не нужны (новые). Отдельно выгрузить `journal_private`.
2. Проверить, что на проде `students.subgroup` пуст или только `'1'`/`'2'` (read-only): `select subgroup, count(*) from public.students group by 1;` — остальные значения станут null.
3. Применить миграцию. Она не запускает импорт и не пересчитывает значки: данные G24 не меняются.
4. Сразу проверить: `select count(*) from public.attendance_badges_deserved() where group_id = '00000000-0000-4000-8000-000000000024';` = числу строк прежней функции до миграции (снять заранее: `select count(*) from public.attendance_badges_deserved();`).
5. Выложить `schedule-import` (пишет `schedule_lessons`/`schedule_meta`).
6. Перед открытием кабинета старосты для G24: `journal-save` отказывает в записи; сверка `journal_private` ↔ `absences` для легаси-строк.
7. При проблеме: down-скрипт (проверен на тесте) и бэкап.

## 10. Как проверялось (тестовый проект `jloicrwugkbchulunhtd`)

- `tools/test/apply-migrations.sh` → применена.
- Значки G24: хэш и число строк `attendance_badges_deserved()` до и после миграции совпали (325).
- `npm run test:db`: `tests/db/cabinets.sql` 174/174, `tests/db/rls.sql` 115/115 (старые проверки без изменений). Контрольный прогон с двумя заведомо неверными ожиданиями дал 2 провала.
- Цикл «применить → down → применить»: после down хэши политик, функций (с правами), колонок, ограничений, прав на таблицы и колонки, индексов и триггеров, а также данные (`journal_private`, счётчики, значки) совпали с состоянием до миграции; запись в `schema_migrations` удалена; повторное применение и тесты — снова все зелёные.
