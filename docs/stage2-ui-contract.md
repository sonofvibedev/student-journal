# Этап 2: контракт интерфейса и данных (кабинеты студента и старосты)

Документ для исполнителей экранов. Базу пишет отдельная миграция `supabase/migrations/20261106100000_journal2_cabinets.sql` (описание: `docs/stage2-db.md`, когда будет готово). Если имя или поле здесь расходится с миграцией, прав файл миграции, а расхождение надо назвать в отчёте.

## Страницы и файлы

| Файл | Что |
|---|---|
| `app.html` + `app-student.js` | кабинет студента: вкладки Главная, Расписание, Учёба, Профиль; экран «Уведомления» |
| `headman.html` + `headman.js` | кабинет старосты (отдельная страница): Сводка, Журнал, Задания, Чат; экраны «Заявки студентов», «Отчёт для деканата» |
| `cab-core.js`, `cab.css`, `j2.css`, `j2-core.js` | оболочка, роутер, помощники, стили (уже написаны, читать целиком перед работой) |
| `j2-gate.js` | экран согласия поверх страницы (на кабинетах заявки выключены флагом `J2_GATE_NO_STAFF`) |
| `vendor/exceljs.min.js`, `dean-report.js` | выгрузка xlsx: `buildDeanReport(ExcelJS, students, absences, year, month0)` |

Роутер: `Cab.start({ kind, tabs, routes, start })`. Адреса `#/home`, `#/study/homework`. Экран — функция `render(el, ctx, params, { isCurrent })`, пишет HTML в `el` через `Cab.h` (интерполяции экранируются) и вешает обработчики. `ctx` = `{ uid, group, student, member, isStaff, role, closed }`.

Если экран хочет заново отрисоваться после действия, вызывает `Cab.rerender()`.

## Данные (клиент читает под своим токеном, права решает RLS)

- `schedule_lessons(group_id, lesson_date, pair_no, starts_at, ends_at, subject, kind lecture|practice|lab|other, teacher, room, subgroup 1|2|null, prev_room, changed_at)`; `schedule_meta(group_id, last_import_at, last_status, semester_start, semester_end)`.
- `tasks(id, kind homework|deadline, rec jsonb {id, subject, type, text, dueDate, subgroup 0|1|2, createdAt}, group_id, created_by)`. `rec.type`: `ПЗ`, `УСР`, `zachet`, `exam`, `deadline` и т. п.; разбор — `Cab.task(row)`. Домашка = kind homework; дедлайн = deadline; зачёты и экзамены = rec.type zachet/exam. Запись делает староста: `insert` со своим `id` формата `hw-<ms>` / `dl-<ms>`, `rec.id = id`, `group_id`.
- `absences(id, group_id, student_id, date, subject, hours, is_excused, cert_type, cert_submitted, cert_due_date, comment, created_by, lesson_kind, certificate_id)`.
- `certificates(id, group_id, student_id, kind sick|statement|other, date_from, date_to, due_date, status waiting|received|none, note, created_by, received_at)`.
- `grades(id, group_id, student_id, subject, lesson_kind, value 1..10 | null, passed bool | null, lesson_date, comment)`.
- `notifications(id, user_id, group_id, kind absence|task|certificate|grade|…, title, body, ref jsonb, created_at, read_at)`.
- `students(id, group_id, last_name, first_name, study_form budget|paid, claim_status, subgroup)`; `memberships`; `groups(name, warn_hours, dean_hours, status)`; `teacher_assignments(subject, lesson_kind)` — для списка преподавателей берём `schedule_lessons.teacher` (уникальные пары предмет + вид + преподаватель).
- Личные события, достижения, игры остаются в `index.html` (ссылки `index.html#games`, `index.html#achievements`, `index.html#zachetka` с калькулятором рейтинга); в новых кабинетах их не переписываем.

## RPC (все через `Cab.rpc(name, args)`)

| RPC | Аргументы | Ответ |
|---|---|---|
| `absence_hours_my` | `p_group uuid` | `{ total, excused, unexcused, warn_hours, dean_hours }` (какие часы идут в кольцо, решает миграция: см. docs/stage2-db.md) |
| `group_absence_summary` | `p_group uuid, p_from date, p_to date` | строки `{ student_id, student_name, total, excused, cert_waiting }` (староста, зам, сисадмин) |
| `certificate_create` | `p_student_id, p_kind, p_from, p_to, p_due, p_note` | id справки |
| `certificate_resolve` | `p_certificate text, p_status 'received'\|'none', p_absence_ids text[]` | `{ ok, status, closed, hours }` |
| `notifications_mark_read` | `p_ids uuid[]` | — |
| `notifications_mark_all_read` | — | — |
| `student_set_subgroup` | `p_subgroup smallint` (1, 2 или null) | — |
| `membership_approve` / `membership_reject` | `p_student_id text` | `{ ok }` (уже есть с этапа 1) |
| `remind_headman`, `consent_accept`, `student_reset_binding`, `group_code_rotate` | см. docs/stage1-db.md | |

## Правила интерфейса (из ТЗ и макетов `docs/screens/s01–s06.jpg`)

- Тёмная тема, токены из `j2.css`: фон `#0A0C11`, лайм `#C6F432`, янтарный `--j-amber`, коралловый `--j-coral`, мятный, фиолетовый. Шрифт Onest. Светлой темы нет.
- Нажимаемое не меньше 44 px по высоте. Смысл не только цветом: рядом всегда подпись («завтра», «не подтверждена»).
- 390 px: без горизонтальной прокрутки. Длинные слова переносятся (`overflow-wrap:anywhere`).
- Студент только смотрит (кроме подгруппы и настроек). Староста вносит пропуски, справки, задания, отменяет только свои записи. Запись преподавателя видна, но не меняется (кнопок нет).
- Журнал закрыт (`ctx.closed`): всё показывается, кнопки записи скрыты, сверху плашка «Журнал закрыт: только просмотр».
- Все тексты по-русски, ошибки человеческим языком (`Cab.rpcText(e)`), кнопка «Повторить» там, где запрос может упасть.
- Подпись у расписания: «Данные с bseu.by. Сверяйте с деканатом.» и строка «Обновлено с bseu.by <когда>» из `schedule_meta.last_import_at`.
- Время «сейчас» берётся только через `Cab.minsk()` (в тестах подменяется через `Cab.testNow`).
