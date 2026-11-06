# Этап 3: база данных очереди уведомлений и Telegram

Миграция: `supabase/migrations/20261107100000_journal2_notifications.sql`.
Откат: `supabase/migrations_down/20261107100000_journal2_notifications.down.sql`.
Тесты: `tests/db/notifications.sql` (вместе с `rls.sql` и `cabinets.sql` запускаются `npm run test:db`).
Контракт: `docs/stage3-contract.md`, раздел «База».

## 1. Что создаётся

| Объект | Назначение | Клиент (authenticated) |
|---|---|---|
| `notifications.dedupe_key text` | ключ от повторов; уникален в паре `(user_id, dedupe_key)` (`notifications_dedupe_unique`, null-ключи не мешают) | только чтение своих строк |
| `notifications.tg_status text not null default 'pending'` | `pending → sending → sent / failed`, `skipped` — в Telegram не уходит. Строки, существовавшие до миграции, стали `skipped` | — |
| `notifications.tg_sent_at`, `tg_attempts int default 0` | время отправки, число попыток | — |
| `notifications.tg_claimed_at`, `tg_error` | **дополнение к контракту**: когда строку забрал `tg_claim_notifications` (нужно для «зависших» > 5 минут), последняя ошибка из `tg_notification_done(p_error)` | — |
| триггер `notifications_dedupe` (before insert) | обычный повторный insert с тем же `(user_id, dedupe_key)` молча пропускается (строка не вставляется, ошибки нет); дубль внутри одного `insert … select` тоже | — |
| индекс `notifications_tg_queue_idx` | частичный по `created_at` для `pending`/`sending` | — |
| `notification_prefs (user_id, kind, enabled)` | выключенные типы; **нет строки = включено**; `kind` ∈ 10 ключей контракта (check); `user_id` по умолчанию `auth.uid()` | свои строки: чтение, вставка, правка, удаление |
| `tg_rebind (user_id pk, old_telegram_id, requested_at, broadcast_at, dismissed_at)` | экран «Журнал обновился» и рассылка после смены бота | своя строка: только чтение |
| триггер `absences_dean_notify` | порог деканата (п. 4) | — |
| cron `journal-tg-dispatch`, `journal-schedule-nightly`, `journal-notify-daily` | п. 6 | — |

Edge Function пишет уведомления `schedule` под service_role: подойдёт и обычный `insert`, и
`upsert(rows, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true })` — повтор с тем же ключом не создаёт строку.

## 2. Матрица прав

| Таблица / действие | аноним | студент, староста, зам, преподаватель | сисадмин | service_role |
|---|---|---|---|---|
| notifications: чтение | — | только свои | только свои | все |
| notifications: запись | — | — (только `notifications_mark_*` этапа 2) | — | да |
| notification_prefs | — | **только свои** строки (все действия; чужую нельзя ни прочитать, ни вставить, ни переписать на себя/другого) | только свои | да |
| tg_rebind: чтение | — | своя строка | своя строка | все |
| tg_rebind: запись | — | только `tg_rebind_dismiss()` | + `tg_reset_all()` | да (`tg-bot` гасит строку при привязке) |
| `tg_create_link_code()` | — | active-участник любой группы | если есть active-членство | — |
| `tg_reset_all()` | — | — | да | — (нет `auth.uid()` → `forbidden`) |
| `tg_rebind_dismiss()` | — | своя строка | своя строка | — |
| `tg_claim_notifications`, `tg_notification_done`, `notify_daily` | — | — | — | да (cron вызывает `notify_daily` владельцем) |

Техработы: restrictive «Техработы» (`app_open()`) на обеих новых таблицах; клиентские RPC (`tg_create_link_code`,
`tg_rebind_dismiss`, `tg_reset_all`) проверяют `app_open()` — как RPC этапа 2. Сисадмин проходит `app_open()` всегда.
Служебные RPC (claim, done, `notify_daily`) и триггеры `app_open()` не проверяют (как триггеры этапа 2): Edge Function
при техработах сама решает, слать ли (`maintenanceBlocked()` в `_shared/common.ts`); уведомления при этом копятся
в `pending`, не теряются.

Закрытые группы: `notify_daily` и порог деканата берут только `groups.status = 'active'`. Запись клиентов в закрытую
группу и так закрыта политиками этапов 1–2.

## 3. RPC — точные сигнатуры (имена из контракта, без изменений)

Все `security definer`, `search_path = ''`. Ошибки — `raise exception '<код>'`, код приходит в `error.message`.

| Функция | Кто | Возвращает | Ошибки |
|---|---|---|---|
| `tg_create_link_code() returns text` | active-участник | `'ABCD-EFGH'` (8 символов `A–Z` без `I L O`, `2–9`), 10 минут, одноразовый, в базе sha-256; прежние коды пользователя гасит | `not_authenticated`, `maintenance` (42501), `no_profile` — **имя прежнее**, теперь значит «нет active-членства» (profile.js уже показывает для него текст) |
| `tg_reset_all() returns jsonb` | сисадмин | `{"reset": int, "rebind": int}` — `reset`: удалено привязок; `rebind`: заведено или переоткрыто строк `tg_rebind` | `forbidden` (42501), `maintenance` |
| `tg_rebind_dismiss() returns void` | вошедший | — (своя строка без `dismissed_at` → `dismissed_at = now()`; нет строки — ничего) | `not_authenticated` (28000), `maintenance` |
| `tg_claim_notifications(p_limit int default 100) returns table(id uuid, user_id uuid, kind text, title text, body text, ref jsonb, telegram_id bigint)` | service_role | строки по `created_at` (самые старые первыми); `p_limit` ограничен 1…500 | нет прав → `permission denied` |
| `tg_notification_done(p_id uuid, p_ok boolean, p_error text default null) returns void` | service_role | — | нет прав → `permission denied` |
| `notify_daily() returns jsonb` | service_role, cron | `{"deadline_soon": int, "certificate": int, "semester": int}` — сколько строк создано (повтор в тот же день → нули) | нет прав → `permission denied` |

`tg_reset_all` подробно: у каждого с привязкой строка `tg_rebind` заводится или переоткрывается
(`old_telegram_id` = прежний `telegram_id`, `requested_at = now()`, `broadcast_at = null`, `dismissed_at = null`),
его `tg_links` и `tg_link_codes` удаляются. Каждому с active-членством без привязки строка заводится, **если её ещё
нет** (существующая не трогается). Отсюда идемпотентность: повторный вызов → `{reset: 0, rebind: 0}`, прежний
`old_telegram_id` не стирается (рассылке он нужен). Пишет `audit_log` (`action = 'tg_reset_all'`).

`tg_claim_notifications` по шагам:
1. `sending` с `tg_claimed_at` старше 5 минут → `pending` (сбой функции), а если `tg_attempts ≥ 3` → `failed`.
2. `pending` без привязки (`tg_links`) или с выключенным типом (`notification_prefs.enabled = false`) → `skipped`.
3. Самые старые `pending` с привязкой → `sending`, `tg_attempts + 1`, `tg_claimed_at = now()` → возвращаются с `telegram_id`.

`tg_notification_done`: `p_ok = true` → `sent`, `tg_sent_at = now()`, `tg_error = null`; иначе `tg_error = p_error`
(до 500 знаков) и `pending`, если `tg_attempts < 3`, иначе `failed`. Действует на строки `sending` и `pending`
(поздний ответ после возврата «зависшей» строки); `sent`, `skipped`, `failed` не меняются.
Итого строка уходит в Telegram не больше 3 раз.

**Почему одну строку не получат два вызова.** Шаг 3 выбирает строки `for update skip locked` и в том же операторе
ставит `sending`. Параллельный вызов либо пропускает строку, пока она заблокирована (SKIP LOCKED не ждёт и не
перепроверяет её), либо, если первый уже закоммитил, не находит её среди `pending`. Шаги 1–2 тоже берут строки через
`skip locked`, поэтому вызовы друг друга не ждут. Повторная выдача возможна только для «зависшей» строки (> 5 минут
в `sending`) — это и есть повтор после сбоя. Тест: два последовательных claim (limit 1, затем 1000) и третий —
пересечений нет; параллельность в одной транзакции SQL-набора не воспроизводится, поэтому здесь — рассуждение.

## 4. Уведомления этапа 3

| Источник | kind | Кому | title / body | dedupe_key | ref |
|---|---|---|---|---|---|
| `notify_daily`: задание со сроком **завтра** (по Минску) | `deadline_soon` | active-студенты группы (в т. ч. староста, зам, автор); при `rec.subgroup` = 1/2 — кроме выбравших другую подгруппу (правило `tasks_notify`); кроме отметивших выполнение (`app_events` `homework_done`/`deadline_done`) | «Завтра дедлайн» / «Завтра сдавать задание»; «предмет: текст» (до 300) | `deadline:<task id>:<YYYY-MM-DD>` | `{task_id, kind, due}` |
| `notify_daily`: справка `waiting` со сроком завтра | `certificate` | студент; староста и зам (своя справка старосты — одно, студенческое) | «Завтра срок сдачи справки»; студенту «Больничный, 02.11.2026–03.11.2026», старосте «Фамилия Имя: …» | `cert-due:<id>:<YYYY-MM-DD>` | `{certificate_id, status, student_id, due}` |
| `notify_daily`: до `schedule_meta.semester_end` 8–14 дней → «14», 1–7 → «7» | `semester` | староста, зам | «Скоро конец семестра»; «Последний день семестра — 20.12.2026 (через 14 дн.)» | `semester:<group>:<YYYY-MM-DD конца>:<14\|7>` | `{semester_end, days_left}` |
| вставка / правка `hours, is_excused, date` в `absences` | `dean_threshold` | студент; староста и зам | «Приближение к порогу деканата» / «Достигнут порог деканата»; «8 ч неуважительных пропусков за ноябрь (предупреждение — 8 ч, деканат — 12 ч)», старосте с «Фамилия Имя: » впереди | `dean:<student>:<YYYY-MM>:<warn\|dean>` | `{student_id, month, level, hours}` |

**Отклонение от контракта (только внутренние ключи):** в `deadline:`, `cert-due:` и `semester:` добавлена дата.
Без неё перенесённый срок не напомнил бы второй раз, а `semester:<group>:14` «залип» бы навсегда и в следующем
семестре уведомления бы не было. Ключи пишет только база; клиент и функции их не разбирают.

Порог деканата: неуважительные часы студента за **текущий календарный месяц по Минску** (тот же расчёт, что
`absence_hours_my`) после изменения. `≥ dean_hours` → `dean`, иначе `≥ warn_hours` → `warn`. Один раз на уровень и
месяц (ключ); сразу через оба порога — только `dean`. Уважительный пропуск триггер не запускает; пропуск не текущего
месяца и сумма ниже порога — ничего. Срабатывает и на пропуски без `created_by` (порог — про сумму, не про автора).

Окно для семестра (а не ровно 14 и 7 дней): пропущенный запуск cron не теряет уведомление; ключ не даёт повторов.

Утечки: студенту — только своё (свои часы, своя справка, задания своей группы); ФИО — только старосте и заму его группы.
Проверено тестом (тексты студента не содержат чужих ФИО).

## 5. Затронутые существующие объекты (до → после)

| Объект | Было | Стало |
|---|---|---|
| `notifications` | `id, user_id, group_id, kind, title, body, ref, created_at, read_at` | + `dedupe_key, tg_status, tg_sent_at, tg_attempts, tg_claimed_at, tg_error`; + unique `(user_id, dedupe_key)`, check `tg_status`, индекс очереди, триггер `notifications_dedupe`. Старые строки → `tg_status = 'skipped'` |
| `absences` | триггеры этапа 2 | + `absences_dean_notify` (after insert / update of `hours, is_excused, date`, when `not is_excused`) |
| `tg_create_link_code()` | код только при строке в `profiles` (24ДММ-2) | код при любом `memberships.status = 'active'`; без него — та же ошибка `no_profile`. Права прежние (`authenticated`, `service_role`). Тело остального не менялось |
| `cron.job` | `journal-reminders`, `assoc-daily-finalize`, `journal-tg-requests-expire`, `journal-word-auto` | + `journal-tg-dispatch` (`* * * * *`), `journal-schedule-nightly` (`0 0 * * *`), `journal-notify-daily` (`0 6 * * *`). Старые не тронуты |

Триггеры этапа 2 (`absences_notify`, `tasks_notify`, `certificates_notify`, `grades_notify`) не менялись: их строки
теперь просто попадают в очередь как `pending`.

## 6. cron

| Задание | Расписание (UTC) | Минск | Действие |
|---|---|---|---|
| `journal-tg-dispatch` | `* * * * *` | каждую минуту | `net.http_post` → `/functions/v1/tg-dispatch`, заголовок `x-cron-secret` из Vault `cron_secret`, таймаут 30 с |
| `journal-schedule-nightly` | `0 0 * * *` | 03:00 | `net.http_post` → `/functions/v1/schedule-nightly`, тот же заголовок, таймаут 60 с |
| `journal-notify-daily` | `0 6 * * *` | 09:00 | `select public.notify_daily()` (в базе, без HTTP) |

URL в миграции — прод (`woiqekpuoddxixlrbvkp`), как в старых cron-миграциях; `tools/test/apply-migrations.sh`
подменяет ref в тестовой копии. Создание идемпотентно: задания с этими именами сначала снимаются. Нет pg_cron, pg_net
или Vault — блок пропускается с notice, остальная миграция применяется.

`net.http_post` асинхронный: ошибка, 404 или таймаут записываются в `net._http_response` и `cron.job_run_details` и
больше ни на что не влияют. На тесте до выкладки функций — 404 каждую минуту, это ожидаемо.

## 7. Решения

1. `dedupe_key` — обычный unique `(user_id, dedupe_key)`, а не частичный индекс: null-ключи и так различны, а
   PostgREST `on_conflict` с частичным индексом не работает. Плюс before-триггер, чтобы и обычный insert с тем же
   ключом молча пропускался, как сказано в контракте.
2. Добавлены `tg_claimed_at` (без него «зависшие > 5 минут» не отличить от свежих) и `tg_error` (куда писать
   `p_error`). Имена из контракта не менялись.
3. Даты в ключах `deadline:`, `cert-due:`, `semester:` (п. 4).
4. `tg_reset_all`: существующая строка пользователя без привязки не трогается — повтор безопасен и не стирает `old_telegram_id`.
5. `deadline_soon` не шлётся тем, кто отметил задание выполненным; автору задания шлётся (это напоминание, а не новость).
6. Ошибка `tg_create_link_code` для пользователя без членства осталась `no_profile` — её уже понимает `profile.js`.
7. `p_limit` ограничен 1…500, чтобы ошибка в функции не забрала всю очередь в `sending`.
8. Старая рассылка `send-reminders` (`journal-reminders`, 09:00, `tg_subscribers` и web push) миграцией **не
   трогается**. Отключать её в день переключения 24ДММ-2 на кабинет 2.0 и сброса бота (`tg_reset_all` + рассылка):
   `select cron.unschedule('journal-reminders');`. Раньше нельзя: у подписчиков web push в 2.0 замены нет. До
   отключения студент 24ДММ-2, подписанный в старом боте и привязанный в 2.0, получит про горящий срок два сообщения.

## 8. Риски

- **Хвост очереди после простоя.** Если `tg-dispatch` не работал сутки, после починки уйдут все накопленные
  `pending`, в том числе устаревшие «завтра срок». ponytail: срока жизни у `pending` нет; если понадобится — в claim
  переводить в `skipped` строки старше N часов.
- **`cron.job_run_details` и `net._http_response`** растут: задание раз в минуту даёт ~1440 строк в сутки.
  `net._http_response` pg_net чистит сам (6 часов), `cron.job_run_details` — нет. При росте добавить ежедневную очистку.
- **Порог деканата задним числом.** Пропуски за прошлые месяцы и пропуски, внесённые до выкладки, не оцениваются;
  первое после выкладки изменение у студента, который уже за порогом, пришлёт уведомление в этот момент.
- **Пороги меняются в середине месяца** (`sysadmin_set_thresholds`): уже отправленный уровень не повторится в этом
  месяце, даже если новый порог выше.
- **`journal-schedule-nightly` с таймаутом 60 с**: pg_net запишет таймаут, если обход групп дольше, но функция
  продолжит работу (её лимит — забота функции).
- **Telegram-привязки 24ДММ-2.** До сброса (`tg_reset_all`) старые привязки из `tg_links` работают с очередью сразу
  после выкладки: студенты 24ДММ-2 начнут получать уведомления 2.0 в текущего бота.
- **Откат** удаляет `notification_prefs`, `tg_rebind` и tg-колонки; уведомления в колокольчике остаются; привязки,
  удалённые `tg_reset_all`, не возвращаются.

## 9. Чек-лист деплоя в прод (дополнение к stage1-db.md п. 10 и stage2-db.md п. 9)

1. Бэкап `notifications`, `tg_links`, `tg_link_codes` (JSON).
2. Проверить секрет в Vault (read-only): `select count(*) from vault.secrets where name = 'cron_secret';` = 1.
   Если 0 — сначала `select vault.create_secret('<то же, что CRON_SECRET у функций>', 'cron_secret', 'x-cron-secret для cron');`.
   Тот же секрет должен стоять в секретах Edge Functions как `CRON_SECRET`.
3. Выложить Edge Functions `tg-dispatch`, `schedule-nightly` (и остальные этапа 3) **до** миграции или сразу после:
   иначе `journal-tg-dispatch` раз в минуту получает 404 (вреда нет, но шум в логах).
4. Применить миграцию. Она не шлёт ничего сама: существующие уведомления становятся `skipped`.
5. Сразу проверить:
   `select tg_status, count(*) from public.notifications group by 1;` — только `skipped` (плюс новые `pending`);
   `select jobname, schedule from cron.job where jobname like 'journal-%' order by 1;` — 3 новых задания и старые;
   в `command` новых заданий адрес `woiqekpuoddxixlrbvkp`.
6. Через пару минут: `select status, return_message from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'journal-tg-dispatch') order by start_time desc limit 3;` — `succeeded`;
   `select status_code from net._http_response order by created desc limit 3;` — 200.
7. Решение п. 7.8: `journal-reminders` отключить в день переключения 24ДММ-2 и сброса бота.
8. При проблеме: down-скрипт (проверен на тесте) и бэкап п. 1.

## 10. Как проверялось (тестовый проект `jloicrwugkbchulunhtd`)

- `tools/test/apply-migrations.sh` → применена; все 168 существующих уведомлений стали `skipped`; три задания cron
  созданы с тестовым адресом; `journal-tg-dispatch` отрабатывает раз в минуту, 404 от несуществующей функции лежит
  в `net._http_response`, ошибок cron нет.
- `npm run test:db`: `notifications.sql` 138/138, `cabinets.sql` 174/174, `rls.sql` 115/115 — итого 427/427.
  Контрольный прогон с двумя заведомо неверными ожиданиями дал 2 провала.
- Две старые проверки `cabinets.sql` («pending ничего не получил», «группа B не получила») падали и **без** этой
  миграции (проверено на откаченной схеме: 287/289): в базе остались закоммиченные уведомления `task` от e2e-прогона
  у тестовых аккаунтов 4 и 9. Исправлено в `tests/db/prelude.sql`: внутри откатываемой транзакции удаляются
  уведомления аккаунтов 1–11 (рядом с освобождением этих аккаунтов).
- Цикл «применить → down → применить»: после down хэши политик (public и storage), функций (текст, права,
  security definer), колонок, ограничений, прав на таблицы и колонки, индексов, триггеров, заданий cron и счётчики
  данных совпали с состоянием до миграции; запись в `schema_migrations` удалена. Повторное применение дало те же хэши,
  что первое; тесты — снова 427/427.
