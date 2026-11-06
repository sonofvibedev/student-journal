# Этап 5: база данных утилиты сисадмина

Миграция: `supabase/migrations/20261109100000_journal2_ops.sql`.
Откат: `supabase/migrations_down/20261109100000_journal2_ops.down.sql`.
Тесты: `tests/db/ops.sql` (в `npm run test:db`), `tests/e2e/ops-rest.mjs` (в `npm run test:e2e`, через настоящий REST).
Контракт: `docs/stage5-contract.md`, раздел «База».

## 1. Что создаётся

| Объект | Назначение | Клиент (authenticated) |
|---|---|---|
| `client_events (id bigint identity, at, source ∈ client/server/health, kind ∈ error/perf/ping/alert, name ≤ 120, message ≤ 300, detail ≤ 1000, ms, ok, ua ≤ 120, group_id)` | ошибки браузера и сервера, замеры, пинги, алерты. Без идентификаторов пользователей; `group_id` без FK (событие не теряется из-за удалённой или выдуманной группы). Индексы `(at)`, `(kind, at)` | чтение — только сисадмин. Записи нет: пишет service_role (`client-report`, `health-check`, `_shared/oplog.ts`) |
| `ops_state (key pk, value jsonb, updated_at)` | служебное состояние Edge Functions: ключи **`last_alert`** и **`last_digest`**. `updated_at` ставит триггер `ops_state_touch` на любой insert/update (upsert без `updated_at` тоже обновляет время) | нет доступа (только service_role); сисадмин видит время через `ops_summary` |
| `backups (id uuid, at, kind ∈ nightly/manual, path, size_bytes, tables jsonb, status ∈ ok/failed, error)` | журнал резервных копий | чтение — только сисадмин. Пишет service_role (`backup-run`) |
| Storage `backups` | закрытое хранилище файлов копий: `public = false`, **без политик** на `storage.objects` → доступ только service_role (скачивание — подписанной ссылкой из `backup-link`) | нет |
| `_group_create(group jsonb, students jsonb, schedule_status text) → uuid` | общая часть `sysadmin_approve_registration` и `sysadmin_create_group`: группа + студенты (sort = позиция в массиве) | закрыто |
| `_group_payload_check(group jsonb, students jsonb)` | проверки payload для `sysadmin_create_group` | закрыто |
| `_assert_sysadmin(write boolean)` | `forbidden`, если не сисадмин; при записи ещё `maintenance`, если `app_open()` ложно | закрыто |
| `ops_cleanup() → int` | удаляет `client_events` старше 30 дней (`where e.at < now() - interval '30 days'`) | закрыто (service_role, cron) |
| 12 RPC сисадмина | раздел 3 | execute (сисадмин проверяется внутри) |
| 4 задания pg_cron | раздел 4 | — |

На трёх новых таблицах: RLS, `revoke all` у `public, anon, authenticated`, restrictive «Техработы» (`app_open()`).

## 2. Матрица прав

| Таблица / действие | аноним | студент / староста | преподаватель | сисадмин | service_role |
|---|---|---|---|---|---|
| client_events: чтение | — | — | — | все строки | все |
| client_events: insert / update / delete | — | — | — | — (нет grant) | да |
| ops_state: чтение / запись | — | — | — | — (только через `ops_summary`: время `last_alert`, `last_digest`) | да |
| backups: чтение | — | — | — | все строки | все |
| backups: запись | — | — | — | — | да |
| Storage `backups` | — | — | — | — (ссылка из Edge Function) | да |
| RPC этапа 5 | — (нет execute) | `forbidden` | `forbidden` | да | — (`auth.uid()` нет → `forbidden`) |
| `ops_cleanup` | — | — | — | — | да (cron) |
| chat_*, tg_* | без изменений: RPC этапа 5 их не читают (проверено тестом по тексту функций), сисадмин по-прежнему не видит чат |

## 3. RPC — точные сигнатуры

Все `security definer`, `search_path = ''`, execute: `authenticated, service_role`; первым делом `_assert_sysadmin`.
Ошибка — `raise exception '<код>'`, код приходит в `error.message`. Общие: `forbidden` (42501), `maintenance` (42501,
только у пишущих; у сисадмина `app_open()` всегда истинен). Всё, что меняет данные, пишет `audit_log`.

| Функция | Возвращает | Ошибки |
|---|---|---|
| `ops_summary(p_hours int default 24)` | `jsonb` (ниже) | `bad_hours` (22023: не 1…720 или null) |
| `ops_events(p_source text default null, p_kind text default null, p_hours int default 24, p_limit int default 100, p_before bigint default null)` | `setof client_events` (все колонки таблицы), по `id` убыванию | `bad_hours` |
| `sysadmin_find_user(p_email text)` | `uuid` или `null` | — |
| `sysadmin_assign_teacher(p_user uuid, p_group uuid, p_role text, p_subjects text[])` | `jsonb {"ok": true}` | `bad_role` (22023), `not_found` (P0002, группа), `user_not_found` (P0002), `bad_subjects` (22023: null, пустой массив, пустой/null предмет, предмет > 200 знаков), `too_many_subjects` (22023: > 20 после trim и distinct), `is_student` (P0001) |
| `sysadmin_remove_teacher(p_user uuid, p_group uuid)` | `jsonb {"ok": true, "assignments": int}` (сколько назначений удалено) | `not_teacher` (P0002: нет членства `teacher_*` в группе) |
| `sysadmin_teachers(p_group uuid)` | `table(user_id uuid, email text, role text, subjects text[], status text)` | — |
| `sysadmin_add_sysadmin(p_user uuid)` | `jsonb {"ok": true, "added": boolean}` (`false` — уже был) | `user_not_found` |
| `sysadmin_remove_sysadmin(p_user uuid)` | `jsonb {"ok": true}` | `self` (42501), `not_found` (P0002: не сисадмин), `last_sysadmin` (P0001) |
| `sysadmin_list_sysadmins()` | `table(user_id uuid, email text, created_at timestamptz)` | — |
| `sysadmin_create_group(p_group jsonb, p_students jsonb)` | `jsonb {"group_id": uuid, "code": "XXXX-XXXX"}` | `bad_payload`, `no_students`, `too_many_students`, `bad_student`, `duplicate_student` (все 22023), `duplicate_group` (P0001) |
| `sysadmin_set_group_status(p_group uuid, p_status text)` | `jsonb {"ok": true, "status": text}` | `bad_status` (22023: не `active`/`closed`), `not_found` |
| `sysadmin_group_subjects(p_group uuid)` | `text[]` (distinct, по алфавиту; `{}`, если расписания нет) | — |

`ops_summary` → `{hours, availability_pct, pings, resp_p50_ms, resp_p95_ms, page_p50_ms, page_p95_ms, client_errors,
server_errors, top_errors: [{name, message, count}], imports: [{group_id, name, last_import_at, last_status, last_error,
lessons_count}], pending_requests, pending_students, last_alert_at, last_digest_at, backup_last: {at, size_bytes, status} | null,
maintenance}`:
- окно — `at >= now() - p_hours часов`;
- `pings` — все `kind = 'ping'` (и `db`, и `site`); `availability_pct = round(100 × ok / pings, 1)`, **`null` при 0 пингов**;
- `resp_p50/p95_ms` — `percentile_cont` (с интерполяцией) по `ms` пингов `name = 'db'`, округление до целого;
  `null`, если таких нет. Пинги с `ok = false` тоже входят (задержка сбоя — тоже задержка);
- `page_p50/p95_ms` — то же по `kind = 'perf' and name = 'page'`;
- `client_errors` / `server_errors` — `kind = 'error'` по `source`; `top_errors` — до 5 пар `(name, message)` всех ошибок
  окна, по убыванию числа;
- `imports` — все группы, кроме `graduated` (left join `schedule_meta`: поля `null`, если импорта не было), по имени;
- `pending_requests` — заявки `submitted`; `pending_students` — `students.claim_status = 'pending'` (по всем группам);
- `last_alert_at` / `last_digest_at` — `ops_state.updated_at` ключей `last_alert` / `last_digest` (`value` не читается);
- `backup_last` — самая новая запись `backups` (в т. ч. `failed`); `maintenance` — `app_settings.maintenance.on`.
Сверх контракта: поле `hours` (эхо параметра).

`ops_events`: фильтры по равенству (неизвестное значение → пусто); `p_limit` приводится к 1…200; курсор: следующая
страница — `p_before = id последней строки`.

`sysadmin_find_user`: `lower(email) = lower(btrim(p_email))`.

`sysadmin_assign_teacher`: создаёт или переводит членство в `active` с `base_role = p_role`, `extra_role = null`,
`student_id = null`, без согласия (`consent_*` не трогаются); затем удаляет все `teacher_assignments` пользователя в
группе и вставляет предметы (trim, distinct) с `lesson_kind = lecture|practice` по роли. `is_student`: у пользователя
в группе есть членство студента `active`/`pending` или привязанная запись `students` (студент со снятой привязкой —
`removed`/`rejected` — может стать преподавателем). Студент группы A может преподавать в группе B. Смена вида
(лекции → ПЗ) закрывает старые треды чата этого вида (по правилу `_chat_live` этапа 4). audit `teacher_assign`
`{user_id, role, subjects}`.

`sysadmin_remove_teacher`: членство `removed`, назначения удаляются; треды чата пропадают у обеих сторон (политики
этапа 4), при повторном назначении возвращаются. audit `teacher_remove`.

`sysadmin_teachers`: все членства `teacher_*` группы (в т. ч. `removed` — с пустым `subjects`), сначала `active`, затем
по почте.

`sysadmin_remove_sysadmin`: под advisory-блокировкой перепроверяет, что вызывающий ещё сисадмин, что цель — сисадмин,
и что сисадминов больше одного. При запрете снимать себя `last_sysadmin` достижим только гонкой (два сисадмина
снимают друг друга одновременно) — блокировка её закрывает. audit `sysadmin_add` / `sysadmin_remove`.

`sysadmin_create_group`: формат `p_group`/`p_students` — как `registration_requests.payload.group` / `.students`
(`name` или `group_no`, `faculty`, `study_form` группы — свободный текст, `course` — число или строка цифр, `university`,
`bseu_faculty_id`, `bseu_form_id`, `bseu_group_id`; студент — `last_name`/`lastName`, `first_name`/`firstName`,
`study_form`/`studyForm` ∈ `budget | paid | нет`). Проверки (`_group_payload_check`) — правила и коды
`registration_submit` (имя группы непустое; ≥ 1 студент; ФИО непустые и уникальны без учёта регистра и пробелов;
форма `budget`/`paid`/нет, пустая строка — ошибка) плюс пределы ввода: имя группы ≤ 60, ≤ 300 студентов, фамилия и имя
≤ 100. `duplicate_group`: имя совпадает (без регистра и пробелов) с группой не в статусе `graduated` (под
advisory-блокировкой). Создаёт группу `active` и студентов (`_group_create`, та же функция, что у одобрения заявки),
код — `_group_code_set` (в базе только sha-256, код в ответе один раз). Старосты и членств нет — назначаются потом
(`sysadmin_set_group_role` после входа студента). `schedule_status = null`. audit `group_create {name, students}` —
без кода.

`sysadmin_set_group_status`: `active ↔ closed` (оба направления), `graduated` через RPC не ставится. `closed` =
`group_open()` ложно: чтение остаётся, запись RLS и RPC закрыта. audit `group_status {from, to}`.

## 4. pg_cron

| Задание | Расписание (UTC) | Что делает |
|---|---|---|
| `journal-health` | `*/5 * * * *` | POST `/functions/v1/health-check`, `x-cron-secret` из Vault, timeout 30 с |
| `journal-ops-report` | `0 6 * * *` (09:00 Минск) | POST `/functions/v1/ops-report`, timeout 60 с |
| `journal-backup` | `30 0 * * *` (03:30 Минск) | POST `/functions/v1/backup-run`, timeout 150 с |
| `journal-ops-cleanup` | `15 1 * * *` | `select public.ops_cleanup()` |

Создание идемпотентно (`unschedule` по имени, затем `schedule`). Нет `pg_cron` → notice, заданий нет; нет `pg_net` или
Vault → создаётся только `journal-ops-cleanup` (ему HTTP не нужен). Адрес — прод; `tools/test/apply-migrations.sh`
подменяет ref в тестовой копии (тест проверяет, что прод-ref в `cron.job` нет). Секрет — Vault `cron_secret`, как на этапе 3.

## 5. Затронутые существующие объекты (до → после)

| Объект | Было | Стало |
|---|---|---|
| `sysadmin_approve_registration` | вставка группы и студентов в теле функции | то же через `_group_create` (тот же SQL). Ответ, проверки, коды ошибок, членство старосты, код группы, audit — без изменений (проверено тестами: группа, порядок студентов, `course`, `schedule_status`, привязка владельца по `studentIndex`, хэш кода, audit, `already_approved`, `not_submitted`, `not_found`, `forbidden`) |
| `storage.buckets` | `avatars`, `assoc-ranks` | + `backups` (private) |
| `registration_submit`, `_group_code_set`, политики | — | не менялись |

## 6. Решения

1. `ops_state` клиенту закрыта целиком (контракт: «только service_role»); время алерта и сводки сисадмин видит в
   `ops_summary`. `updated_at` ставит триггер, поэтому Edge Functions достаточно `upsert({key, value})`.
2. Доступность — по всем пингам (`db` и `site`); время ответа — только `db` (по контракту).
3. Перцентили — `percentile_cont` (интерполяция), округление до целых мс.
4. `ops_cleanup()` — отдельная функция (а не SQL в тексте задания): её можно проверить тестом; клиентам закрыта.
5. Проверки `sysadmin_create_group` вынесены в `_group_payload_check`; `registration_submit` не переписан (этап 1
   без SQL-тестов одобрения, риск не нужен), поэтому правила студентов записаны в двух местах — при правке менять оба.
6. Одобрение заявки по-прежнему полагается на проверки `registration_submit` (payload после отправки не меняется:
   правка — только черновика).
7. `duplicate_group` — только у `sysadmin_create_group`; одобрение заявки дубли имён не проверяет (как раньше).
8. Новые коды сверх контракта: `bad_hours`, `user_not_found`, `bad_subjects`, `too_many_subjects`, `bad_role`,
   `not_teacher`, `self`, `not_found`, `last_sysadmin`, `bad_payload`, `no_students`, `too_many_students`,
   `bad_student`, `duplicate_student`, `duplicate_group`, `bad_status`.
9. Ответы сверх контракта: `ops_summary.hours`, `sysadmin_remove_teacher.assignments`, `sysadmin_add_sysadmin.added`,
   `sysadmin_set_group_status.status`.

## 7. Риски

- **Объём `client_events`**: пинг каждые 5 минут = 2 × 288 строк в сутки + события браузера (лимит `client-report`
  60 за 10 минут с адреса). 30 дней хранения — десятки тысяч строк; индексы `(at)`, `(kind, at)` держат сводку.
  `ops_summary(720)` читает месяц целиком — для кнопки «7 дней» и «24 часа» это не проблема.
- **`top_errors` группирует по точному `message`**: если в тексте ошибки есть переменные части, топ размазывается.
  Нормализация — забота `client-report`.
- **Хранилище `backups` без политик**: любой код с service-ключом читает копии. Копии содержат персональные данные
  (ФИО, пропуски) — ключ держать только в секретах функций.
- **Откат** удаляет `client_events`, `ops_state`, `backups` (журнал). Файлы копий в Storage не удаляются; хранилище
  убирается только пустым (`storage.protect_delete` запрещает прямое удаление; для пустого хранилища down-скрипт
  включает `storage.allow_delete_query` на время транзакции). Группы, созданные сисадмином, назначения, сисадмины,
  статусы групп и audit остаются.
- **Назначение преподавателя без согласия** — по контракту; согласие (`consent_accept`) преподаватель даёт при входе,
  если UI его спросит.
- **`sysadmin_find_user`** читает `auth.users` (security definer): только сисадмин, только точное совпадение почты.

## 8. Чек-лист деплоя в прод (дополнение к stage1–4)

1. Бэкап (как на этапе 4); новых данных до миграции нет.
2. Vault: секрет `cron_secret` уже есть (этап 3) — проверить:
   `select count(*) from vault.decrypted_secrets where name = 'cron_secret';` → 1.
3. **Сначала** выложить Edge Functions `health-check`, `ops-report`, `backup-run` (и секрет `SITE_URL`), иначе cron
   будет каждые 5 минут получать 404 (вреда нет, но шум в `net._http_response`).
4. Применить миграцию.
5. Проверить:
   `select jobname, schedule, command like '%woiqekpuoddxixlrbvkp%' from cron.job where jobname like 'journal-%';` — 4 новых задания, адрес прода;
   `select id, public from storage.buckets where id = 'backups';` → `f`;
   `select count(*) from pg_policies where schemaname = 'storage' and (qual || coalesce(with_check, '')) like '%backups%';` → 0;
   `select proname, prosecdef, proconfig from pg_proc where proname like 'sysadmin_%' or proname like 'ops_%';` — все `t`, `search_path=""`;
   `select has_function_privilege('anon', 'public.ops_summary(int)', 'execute');` → `f`.
6. Под сисадмином: «Состояние» — `ops_summary(24)` отвечает (доступность `null` до первого пинга), через 5–10 минут
   `pings > 0`. «Создать копию сейчас» → строка в `backups`, файл в `backups/<дата>/`.
7. При проблеме: down-скрипт (проверен на тесте) и бэкап п. 1. Перед откатом скачать файлы копий, если нужны.

## 9. Как проверялось (тестовый проект `jloicrwugkbchulunhtd`)

- `tools/test/apply-migrations.sh` → применена.
- `npm run test:db`: `ops.sql` 198/198, `teachers_chat.sql` 211/211, `cabinets.sql` 174/174, `notifications.sql` 138/138,
  `rls.sql` 115/115 — 836/836 (старые 638 не менялись). Контрольный прогон с двумя заведомо неверными ожиданиями
  дал ровно 2 провала.
- `ops.sql`: права таблиц (чтение только сисадмином, запись клиента закрыта всем, ops_state закрыта), ограничения длины
  и значений, «Техработы», Storage без политик, security definer и права функций, отсутствие `chat_`/`tg_` в текстах RPC,
  отсутствие update/delete без `where`; каждый из 12 RPC → `forbidden` студенту, старосте, преподавателю; cron (4 задания,
  не прод); `ops_summary` на 0, 1 и многих строках (доступность `null`, интерполяция p95, окна 1/24/48 ч, фильтр `name`,
  топ-5, импорт без `graduated`, `ops_state`, последняя копия, техработы), `bad_hours`; `ops_events` (порядок, фильтры,
  курсор, лимит 200); `ops_cleanup` удаляет только старше 30 дней; все ветки преподавателей, групп, сисадминов; одобрение
  заявки после переноса в `_group_create`.
- `tests/e2e/ops-rest.mjs`: 60/60 — каждый RPC настоящим JWT через `/rest/v1/rpc`, запрещённые пути (прямые insert в три
  таблицы анонимом, студентом и сисадмином; чтение; все RPC студентом, старостой, снятым преподавателем и анонимом;
  `ops_cleanup`; `group_invites`, `chat_messages`, `tg_links` сисадмину), закрытие и открытие группы с проверкой записи
  старосты, назначение и снятие преподавателя с проверкой видимости расписания. Временные аккаунты, группы, события,
  копии и записи audit удаляются в конце (счётчики данных до и после совпали).
- Цикл «применить → down → применить»: после down хэши политик (public, storage), функций (текст, права, security definer),
  колонок, ограничений, прав на таблицы и колонки, индексов, триггеров, заданий cron, хранилищ Storage и счётчики данных
  совпали с состоянием до миграции; запись в `schema_migrations` удалена. Повторное применение дало те же хэши, что первое;
  тесты — снова 836/836 и 60/60. Первый прогон down упал на `storage.protect_delete` и откатился целиком (транзакция) —
  исправлено, см. раздел 7.
