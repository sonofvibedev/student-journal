# Этап 1: база данных (группы, роли, RLS)

Миграция: `supabase/migrations/20261105200000_journal2_groups.sql`.
Откат: `supabase/migrations_down/20261105200000_journal2_groups.down.sql`.
Группа переезда 24ДММ-2: `00000000-0000-4000-8000-000000000024` (дальше G24).

## 1. Что создаётся

| Таблица | Назначение | Клиент (authenticated) |
|---|---|---|
| `groups` | группа: факультет, форма, курс, номер, пороги `warn_hours`/`dean_hours`, статус `active/closed/graduated`, id bseu.by | читает свои active-группы; сисадмин все |
| `group_invites` | код группы, только `code_hash` (sha-256 hex от кода без дефиса, верхний регистр) | нет доступа |
| `students` | студенты; `id` прежние `st-…`; `claimed_by` (unique), `claim_status free/pending/active` | см. матрицу |
| `memberships` | `(user_id, group_id)`, `base_role` student/teacher_lecture/teacher_practice, `extra_role` headman/deputy, `status` pending/active/rejected/removed | своя строка; староста — строки своей группы |
| `sysadmins` | сисадмины (вне memberships) | своя строка; сисадмин все |
| `teacher_assignments` | дисциплина + вид занятия преподавателя в группе | свои и своей группы |
| `absences` | пропуски (справка пока полями) | см. матрицу |
| `registration_requests` | заявка старосты новой группы | владелец: свой черновик |
| `join_attempts` | лимит перебора кода (Edge Function) | нет доступа |
| `consents` | согласия на обработку ПД | свои строки |
| `audit_log` | журнал действий | сисадмин все; староста — своей группы |
| `remind_log` | «Напомнить старосте» не чаще раза в час | нет доступа |

Ограничения в БД: `students.claimed_by unique` (один человек = одна запись); уникальность ФИО в группе (`lower(btrim())`); один active headman и один active deputy на группу (частичные unique-индексы); `extra_role` только при `base_role='student'`; `absences (student_id, group_id)` и `memberships (student_id, group_id)` — составные FK на `students (id, group_id)`, то есть пропуск/членство не может указывать на студента другой группы; одна открытая заявка (draft/submitted) на владельца.

**group_id в старых таблицах**: `app_events`, `student_achievements`, `game_records`, `tasks` (+`created_by`), `study_days` (ключ стал `(group_id, day)`). Колонка сразу `not null default G24`: старые писатели (клиент 1.x, Edge Functions, `seed-test.mjs`) group_id не передают и пишут только за 24ДММ-2. Default с константой заполняет существующие строки без перезаписи таблицы. Это легаси-допущение — убрать default на этапе 2.

Не тронуты: `tg_subscribers`, `tg_links` и прочие `tg_*`, `word_*`, `assoc_settings`, `pass_tokens`, `push_subscriptions`, `notify_log`, `code_attempts`, `invite_codes`, `profiles` (кроме триггера, см. п. 5).

## 2. Хелперы (security definer, stable, `search_path=''`, execute: authenticated, service_role)

| Функция | Возвращает |
|---|---|
| `is_sysadmin()` | есть в `sysadmins` |
| `my_active_groups()` | setof uuid — группы, где у меня active-членство |
| `has_group_role(g, roles[])` | active-членство с base_role или extra_role из roles; сисадмин — всегда true |
| `is_group_staff(g)` | headman/deputy группы или сисадмин |
| `group_open(g)` | `groups.status='active'` и (техработы выключены или `is_group_staff(g)`) |
| `is_group_reader(g)` *(доп.)* | `has_group_role(g, {student})` — студент (вкл. старосту/зама) или сисадмин; без преподавателей |
| `teaches(g, subject, kind)` *(доп.)* | active-преподаватель с назначением; null в аргументе = любой |
| `my_student_id(g)` *(доп.)* | student_id моего active-студенческого членства в g |
| `user_is_staff(g, u)` *(доп.)* | u — староста/зам группы g (ответ только участнику g) |
| `can_see_user(text)` *(доп.)* | аватарка: своя, общая active-группа или сисадмин |

Рекурсии нет: политики таблиц не читают свою таблицу напрямую, только через эти функции; функции принадлежат владельцу таблиц и читают `memberships` в обход RLS. Проверено запросами под `authenticated`.

`is_journal_admin()` теперь = сисадмин или active headman/deputy в G24 (раньше `isAdmin` в jsonb). `app_open()` — прежний текст (зависит от `is_journal_admin`). `maintenance_status()` и `set_maintenance()` не менялись, их вызов клиентом прежний.

## 3. Матрица прав (RLS)

| Таблица | pending/rejected/removed | студент active | староста/зам | преподаватель | сисадмин |
|---|---|---|---|---|---|
| groups | — | своя | своя | своя | все |
| students | только своя запись (`claimed_by = я`) | своя группа | своя группа | своя группа (если есть назначение) | все |
| memberships | своя строка | своя строка | своя группа | своя строка | все |
| absences: чтение | — | **вся группа** (решение: журнал открыт группе, как сейчас в 24ДММ-2) | своя группа | только `subject` + `lesson_kind` из назначения | все |
| absences: внесение | — | — | своя группа, `created_by = я` | только свои subject и lesson_kind | да |
| absences: изменение | — | — | свои и легаси-записи — любые поля; записи преподавателя — только справка/комментарий, «уважительный» только вместе со сданной справкой | только `is_excused` в записях своей дисциплины; свои записи — любые поля | да |
| absences: отмена | — | — | свои и легаси (`created_by is null`) | свои и старосты/зама, своей дисциплины | да |
| tasks: чтение | — | своя группа | своя группа | по `rec->>'subject'` из назначения | все |
| tasks: запись | — | — | своя группа; менять/удалять свои и легаси | — (этап 4) | да |
| journal_private, assoc_daily_results, рейтинги assoc | — | active-студент G24 | G24 | — | да |
| app_events, student_achievements | — | свои (`student_id = my_student_id(group_id)`) | свои | — | — |
| game_records, rpc_ach_board, rpc_game_points | — | своя группа | своя группа | — | все |
| study_days | — | своя группа | своя группа | своя группа | все |
| registration_requests | владелец: свой черновик (insert/update только `payload, step, schedule_status`, пока `draft`) | | | | читает все |
| audit_log | — | — | своя группа | — | все |
| group_invites, join_attempts, remind_log | только service_role и RPC |

Что неизменно у всех: прямая запись клиентом в `memberships`, `groups`, `group_invites`, `teacher_assignments`, `sysadmins`, `students` запрещена (нет grant). Любая запись в данные группы требует `group_open(group_id)`: журнал закрыт (`status<>'active'`) = только просмотр. Поля, которые RLS не выражает, держит триггер `absences_guard` (только для ролей anon/authenticated; service_role без ограничений). Restrictive «Техработы» висит на всех таблицах public, кроме `app_settings`, включая новые.

## 4. RPC

Все: security definer, `search_path=''`, права по `auth.uid()`, запись в `audit_log`. Ошибки — `raise exception '<код>'` (`forbidden` = 42501, `not_found` = P0002).

| Функция | Кто | Возвращает |
|---|---|---|
| `membership_approve(p_student_id text)` | староста/зам группы студента, сисадмин | `{ok, student_id, user_id}`; student pending→active, membership pending→active |
| `membership_reject(p_student_id text)` | то же | `{ok, …}`; запись свободна, membership → rejected |
| `student_reset_binding(p_student_id text)` | то же; не себя; старосту/зама — только сисадмин | `{ok, …}`; запись свободна, membership → removed; пропуски и события остаются |
| `remind_headman()` | pending-студент | `{ok, next_at}`; `ok=false` если прошло меньше часа; Edge Function рассылает по `audit_log.action='remind_headman'` |
| `consent_accept(p_group uuid, p_version text, p_text_hash text)` | своё active/pending-членство | `{ok}`; строка в `consents` + `memberships.consent_at/version` |
| `registration_submit(p_request uuid)` | владелец черновика | `{ok, request_id}`; draft → submitted |
| `sysadmin_approve_registration(p_request uuid)` | сисадмин | `{group_id, code}` — код открытым текстом один раз; повтор → `already_approved` |
| `sysadmin_reject_registration(p_request uuid, p_reason text)` | сисадмин | `{ok}` |
| `group_code_rotate(p_group uuid)` | староста/зам, сисадмин | text — новый код один раз, старый хэш перестаёт работать |
| `sysadmin_set_group_role(p_group uuid, p_user uuid, p_role text)` | сисадмин, не себе | `{ok, previous_holder}`; `headman`/`deputy` передаются (прежний держатель становится студентом), `student` снимает доп. роль, `none` удаляет из группы и освобождает запись |
| `sysadmin_set_thresholds(p_group uuid, p_warn int, p_dean int)` | сисадмин | `{ok}`; `1 ≤ warn ≤ dean` |
| `journal2_import_legacy()` | **только service_role** | счётчики, см. п. 5 |
| `sysadmin_bootstrap(p_user uuid)` | **только service_role** | `{ok}` |

Код группы: 8 символов из `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, возвращается как `ABCD-EFGH`; хэш считается от `ABCDEFGH` (без дефиса, верхний регистр). Edge Function нормализует ввод так же: верхний регистр, без пробелов и дефиса.

Формат `registration_requests.payload` (camelCase-варианты имён тоже принимаются):
```json
{
  "group":   {"name": "24ДММ-3", "faculty": "ФМк", "study_form": "Дневная", "course": 3, "group_no": "24ДММ-3",
              "university": "БГЭУ", "bseu_faculty_id": "13", "bseu_form_id": "10", "bseu_group_id": "…"},
  "owner":   {"last_name": "…", "first_name": "…", "email": "…", "studentIndex": 0},
  "students": [{"last_name": "…", "first_name": "…", "study_form": "budget"}]
}
```
`studentIndex` начинается с 0 и указывает на старосту в `students`. Без него староста получает роль без привязки к студенту. `study_form` — `budget` / `paid` / не указано.

Лимит перебора кода и создание аккаунтов делает Edge Function под service_role (`join_attempts`, вставка `students.claimed_by` + `memberships` со статусом pending). Anon-RPC нет.

## 5. Импорт 24ДММ-2 (`journal2_import_legacy`)

Вызывается **в конце миграции, в той же транзакции**, и триггером `profiles_legacy_sync` на каждую новую строку `profiles` (старый `register-with-code`). Повторно его можно вызывать под service_role.

- students ← `journal_private.students`: id сохраняется, `sort` по алфавиту, `status` «Бюджет/Платное» → budget/paid, `telegramUsername` → `telegram.username`. Существующая строка не перезаписывается, кроме пустого `telegram`.
- absences ← `journal_private.absences`: те же id, даты через безопасный разбор (кривая → null), часы → numeric, пустые строки → null, `created_by = null`. Существующие строки не трогаются (`on conflict do nothing`). Пропуски несуществующих студентов пропускаются (счётчик `skipped_absences`).
- memberships для каждого `profiles`: student/active. Роли получают только **вновь созданные** членства: первый `isAdmin` → headman, второй → deputy (если должность свободна). «Зам. старосты» из поля `role` jsonb **не** превращается в deputy: у него не было прав админа, роль выдаёт сисадмин.
- `students.claimed_by/claim_status='active'` для тех, у кого есть профиль.
- group_id в старых таблицах ставит default миграции (G24), отдельный backfill не нужен: строк с null не бывает.

Идемпотентность: повторный запуск ничего не дублирует и не затирает ручные правки: роли, сброшенные привязки (сброс удаляет легаси-профиль, поэтому повторный импорт не привяжет запись снова) и правки пропусков в новой таблице сохраняются.

**Ограничение:** удаления и правки, сделанные в `journal_private` старой админкой после первого импорта, в `absences`/`students` не переносятся (новые записи переносятся при следующем вызове). До запуска нового клиента источник правды — `journal_private`. Перед переключением клиента нужна сверка: для легаси-строк (`created_by is null`) перезалить из jsonb.

Результат на тесте (маскированная копия прода): `students 28, absences 276, memberships 28, claimed 28, headman 1, deputy 0, skipped_absences 0, profiles_without_student 0`. Повторный вызов: `new_memberships 0`. Сумма часов 580 = 580, уважительных 87 = 87. Староста — тот же студент, у которого был `isAdmin`.

## 6. Затронутые существующие объекты (до → после)

| Объект | Было | Стало |
|---|---|---|
| `journal_private` «Студент группы читает журнал» | есть строка в profiles | `is_group_reader(G24)` (легаси, таблица без group_id) |
| `app_events` «Свои события видны» / «добавляются» / «Отметку о домашке можно снять» | `user_id = я` | + `student_id = my_student_id(group_id)`; запись + `group_open` |
| `student_achievements` «Свои значки видны» / «добавляются» | student_id из profiles | `student_id = my_student_id(group_id)`; insert + `group_open`, прежние запреты на коды `game_%` и коды посещаемости |
| `game_records` «Рекорды видны вошедшим» | `true` | `is_group_reader(group_id)` |
| `study_days` «Учебные дни читают вошедшие» | `true` | `group_id in my_active_groups()` или сисадмин; PK `(day)` → `(group_id, day)` |
| `assoc_daily_results` «Итоги дней видят вошедшие» | `true` | `is_group_reader(G24)` (легаси) |
| `tasks` | клиенту закрыта | grant s/i/u/d + 4 политики (п. 3), колонки `group_id`, `created_by` |
| `storage.objects` «Аватарки видят вошедшие» | все вошедшие | `can_see_user(<имя файла без .jpg>)` |
| `is_journal_admin()` | `isAdmin` в jsonb через profiles | headman/deputy в G24 или сисадмин |
| `app_open()` | — | пересоздана с прежним текстом |
| `rpc_ach_board`, `rpc_game_points` | все строки | + `is_group_reader(sa.group_id)` |
| `rpc_assoc_board`, `rpc_assoc_day_board`, `rpc_assoc_total_board` | все вошедшие | + `is_group_reader(G24)` (легаси) |
| триггер `profiles_legacy_sync` на `profiles` | — | новый профиль → импорт; профиль для студента другой группы → ошибка |

Проверены и **не тронуты**: `profiles` «свой профиль»; `word_attempts` «Своя попытка видна» (только своя строка через profiles, у пользователя новой группы профиля нет — пусто); `assoc_settings` (настройки без личных данных); `push_subscriptions`, `tg_links`, `tg_task_requests` (только свои строки); `issue_pass_token`, `tg_create_link_code` (требуют profiles, поэтому новой группе недоступны: утечки нет); `tg_unlink`; `verify_pass_token`, `finalize_assoc_day`, `tg_submit_request`, `reset_student_access`, `attendance_badges_deserved`, `recompute_attendance_badges` (не вызываются клиентом); `maintenance_status`, `set_maintenance`; `app_events_fill_owner`.

**profiles**: остаётся легаси-связью «аккаунт ↔ student_id» только для 24ДММ-2. Студенту новой группы строка в profiles **не создаётся**. Связь user → student для них — `memberships.student_id` и `students.claimed_by`. Триггер не даст вставить профиль студенту другой группы.

## 7. Решения и допущения

1. Студент видит все пропуски своей группы (как сейчас в 24ДММ-2). Сузить до своих можно одной политикой.
2. Сисадмин проходит `has_group_role`, поэтому технически может вносить пропуски и задания (по ТЗ в интерфейсе у него этого нет).
3. Староста может удалять и править легаси-пропуски (`created_by is null`): они внесены старостой до переезда.
4. Уважительность в записи преподавателя староста меняет только вместе с отметкой «справка сдана».
5. Задания пишут только староста и зам. Запись преподавателями отложена на этап 4.
6. Глобальный режим техработ (`app_open`) пропускает только старосту/зама 24ДММ-2 и сисадмина. Старосты других групп при техработах заблокированы, как все.
7. Сброс привязки (`student_reset_binding`, `membership_reject`, роль `none`) удаляет легаси-строку `profiles` этого аккаунта. Иначе старый клиент и Edge Functions считали бы аккаунт прежним студентом, а повторный импорт привязал бы его снова. Аккаунт Auth остаётся.

## 8. Риски

- **Edge Function `taskstore` (`_shared/taskstore.ts`) пересобирает публичный `data.json` из ВСЕХ строк `tasks`.** Как только староста другой группы внесёт задание, оно попадёт в публичное зеркало 24ДММ-2. До запуска регистрации новых групп нужен фильтр `.eq('group_id', '00000000-0000-4000-8000-000000000024')` (зона исполнителя Edge Functions).
- `maintenanceBlocked()` и `jwtAdmin()` в Edge Functions по-прежнему смотрят `isAdmin` в jsonb, а RLS смотрит членство. Пока они совпадают после импорта. Если старая админка поменяет `isAdmin`, техработы в БД это не учтут.
- `recompute_attendance_badges()` отзывает управляемые значки у всех `student_id`, которых нет в `journal_private`, а `attendance_badges_deserved()` берёт `study_days` без фильтра группы. На этапе 1 у новых групп нет ни значков, ни учебных дней. На этапе 2 добавить фильтр G24.
- Default `group_id = G24` в старых таблицах: новый писатель, забывший передать group_id, запишет данные в 24ДММ-2. RLS (`my_student_id`, `is_group_staff`) клиенту этого не даст, но service_role — даст.
- Удаление аккаунта Auth: `students.claimed_by` обнуляется, `claim_status` остаётся прежним (импорт нормализует его для G24). Для других групп это сделает Edge Function или сисадмин.
- Откат удаляет новые таблицы с данными и строки других групп в старых таблицах. Профили, удалённые сбросом привязки, откат не возвращает.

## 9. Как миграция ведёт себя на проде

- Одна транзакция (`db push` оборачивает файл). На тесте ошибка в середине откатила всё, БД осталась нетронутой (проверено).
- Блокировки: `alter table … add column … default <константа>` — короткая ACCESS EXCLUSIVE без перезаписи таблицы (PG ≥ 11), FK проверяется сканом маленьких таблиц (сотни строк). Пересоздание PK `study_days` (89 строк) и замена политик — миллисекунды.
- Импорт идёт внутри миграции. Поэтому состояния «миграция есть, импорта нет» не бывает: 28 аккаунтов не теряют доступ, а староста не теряет обход техработ (на проде техработы сейчас **включены**).
- Импорт упадёт (и вся миграция откатится), если в `journal_private.students` есть два студента с одинаковыми ФИО (без учёта регистра и пробелов по краям). Проверить заранее (см. чек-лист).
- Клиент 1.x не меняется: читает `journal_private`, пишет `app_events`/значки, зовёт `maintenance_status()` и рейтинги, как раньше.

## 10. Чек-лист деплоя в прод

1. Бэкап: `pg_dump` + выгрузка `journal_private`, `profiles`, `app_events`, `student_achievements`, `game_records`, `tasks`, `study_days` в JSON. Проверить, что файл читается и числа совпадают.
2. Read-only проверка дублей ФИО на проде (должно вернуть 0 строк):
   ```sql
   select lower(btrim(s->>'lastName')), lower(btrim(s->>'firstName')), count(*)
     from public.journal_private, jsonb_array_elements(students) s
    group by 1, 2 having count(*) > 1;
   ```
3. Проверить, что в `journal_private.students` ровно один `isAdmin = true`.
4. Внести фильтр G24 в `_shared/taskstore.ts` (риск 1) и выложить Edge Functions **до** открытия регистрации новых групп.
5. Применить миграцию (по команде владельца, из привязанной к проду папки).
6. Сразу проверить: `select public.journal2_import_legacy();` под service_role → `students = 28, absences = 276, memberships = 28, headman = 1, skipped_absences = 0, profiles_without_student = 0`.
7. Под аккаунтом старосты: `maintenance_status()` → `admin: true`; журнал читается при включённых техработах. Под обычным студентом журнал читается после выключения техработ.
8. Назначить первого сисадмина: `select public.sysadmin_bootstrap('<uuid>');` под service_role.
9. Прогнать набор тестов прав на тестовом проекте с той же версией миграций.
10. При проблеме: down-скрипт (проверен на тесте) и восстановление из бэкапа п. 1.

## 11. Как проверялось (тестовый проект `jloicrwugkbchulunhtd`)

- `tools/test/apply-migrations.sh` → применено; `npm run test:reset` (seed работает на новой схеме) → импорт: 28/276/28, повтор без изменений.
- Сценарная проверка RLS: один `do`-блок под `authenticated` с подставленным `request.jwt.claims`, 69 проверок, всё откатывается. Регистрация группы B через RPC; pending видит 0 строк данных; студент A не пишет пропуски и не видит B; староста B не видит 24ДММ-2; преподаватель видит только свою дисциплину и вид; техработы; закрытая группа; передача роли. Результат `69 checks; ALL OK`. Контрольный прогон с двумя заведомо неверными ожиданиями дал 2 FAIL, то есть проверка ловит ошибки.
- Цикл «применить → down → применить»: после down хэши политик, функций (с правами), колонок, ограничений, прав на таблицы и индексов совпали с хэшами до миграции, запись в `schema_migrations` удалена, данные (28/265/509/89/7) на месте. Повторное применение и проверка RLS: снова ALL OK.
