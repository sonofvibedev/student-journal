# Этап 3: контракт (расписание по ночам, очередь уведомлений, Telegram)

Три исполнителя работают параллельно: база (миграция), Edge Functions, интерфейс. Имена ниже обязательны. Если имя не подходит из-за найденной проблемы, исполнитель называет замену в отчёте, и я согласую остальных.

## Типы уведомлений (10 из ТЗ) → ключи `notifications.kind` и настроек

| Событие ТЗ | kind | Кому | Когда / кто создаёт |
|---|---|---|---|
| Горящая домашка или дедлайн | `deadline_soon` | студенты группы (с учётом подгруппы) | за сутки до срока; `notify_daily()` по cron в 09:00 Минск |
| Новая домашка или дедлайн | `task` | студенты (кроме автора) | сразу; триггер уже есть (этап 2) |
| Изменение расписания | `schedule` | студенты (по подгруппе занятия) и староста, зам | после ночного импорта; Edge Function пишет строки |
| Новая оценка | `grade` | студент | сразу; триггер есть |
| Внесён пропуск | `absence` | студент | сразу; триггер есть |
| Приближение к порогу деканата | `dean_threshold` | студент, староста, зам | при достижении `warn_hours` и `dean_hours` (неуважительные часы за месяц, как в `absence_hours_my`); новый триггер на `absences`, один раз на порог и месяц |
| Срок сдачи справки / справка подтверждена | `certificate` | студент, староста, зам | подтверждена: триггер есть; срок: `notify_daily()` за сутки до `due_date` |
| Новое сообщение в чате | `chat` | староста, преподаватель | этап 4 (ключ резервируется, текст сообщения в уведомление не попадает) |
| Скорое закрытие семестра | `semester` | староста, зам | за 14 и за 7 дней до `schedule_meta.semester_end`; `notify_daily()` |
| Сбой или ошибка импорта | `import_failed` | системные администраторы | сразу (Telegram и почта из функции) и сводкой за день; в `notifications` не пишется |

Каждый тип студент и староста может выключить (`notification_prefs`). Выключенный тип не отправляется в Telegram, но в колокольчике остаётся (колокольчик — все события).

## База (миграция `20261107100000_journal2_notifications.sql`)

- `notifications` получает: `dedupe_key text` (уникальный индекс `(user_id, dedupe_key)` где не null; повторный insert с тем же ключом игнорируется), `tg_status text not null default 'pending'` check `pending|sending|sent|skipped|failed`, `tg_sent_at timestamptz`, `tg_attempts int not null default 0`. Старые строки к моменту миграции помечаются `skipped` (в Telegram не уходят).
- `notification_prefs(user_id uuid, kind text, enabled boolean not null, primary key (user_id, kind))`: читать, вставлять, менять и удалять строки только свои (RLS). Нет строки = включено.
- `tg_rebind(user_id uuid pk, old_telegram_id bigint, requested_at timestamptz default now(), broadcast_at timestamptz, dismissed_at timestamptz)`: пользователь читает свою строку; пишет только RPC.
- RPC (security definer, `search_path=''`, права по `auth.uid()`, `app_open()`):
  - `tg_reset_all() returns jsonb {reset int, rebind int}`: только сисадмин. Для каждого пользователя с привязкой в `tg_links` заводит/обновляет строку `tg_rebind` (запоминает `old_telegram_id`, `requested_at=now()`, `broadcast_at=null`, `dismissed_at=null`), удаляет его `tg_links` и `tg_link_codes`; активным пользователям без привязки строку тоже заводит (экран «Журнал обновился» нужен всем). Пишет `audit_log`. Повторный вызов безопасен.
  - `tg_rebind_dismiss() returns void`: своя строка, `dismissed_at=now()` («Пропустить, привяжу позже»).
  - `tg_create_link_code()` теперь работает для любого пользователя с active-членством (раньше только при строке в `profiles`, то есть только 24ДММ-2), остальное как раньше (код ABCD-EFGH, 10 минут, одноразовый, хэш).
  - Привязка (`tg_links`) при успехе гасит `tg_rebind` пользователя (`dismissed_at=now()`): делает Edge Function `tg-bot` через service_role, отдельного RPC не нужно; `tg_links` остаётся как есть.
  - `tg_claim_notifications(p_limit int default 100) returns table(id uuid, user_id uuid, kind text, title text, body text, ref jsonb, telegram_id bigint)`: только service_role. Берёт `pending` строки (`for update skip locked`, самые старые первыми), у которых есть привязка и тип включён: ставит `sending`, `tg_attempts+1`, возвращает. Строки без привязки или с выключенным типом сразу переводит в `skipped`. Строки `sending` старше 5 минут возвращает в `pending` (сбой функции).
  - `tg_notification_done(p_id uuid, p_ok boolean, p_error text default null) returns void`: только service_role. ok → `sent`, `tg_sent_at=now()`; не ok → `pending`, если попыток меньше 3, иначе `failed`.
  - `notify_daily() returns jsonb` (service_role и cron): создаёт `deadline_soon`, `certificate` (срок завтра), `semester` (14 и 7 дней) с `dedupe_key` вида `deadline:<task id>`, `cert-due:<id>`, `semester:<group>:<14|7>`; считает «завтра» и «сегодня» по Минску; закрытые и неактивные группы пропускает.
  - триггер на `absences` для `dean_threshold` (см. таблицу); ключи `dean:<student>:<YYYY-MM>:<warn|dean>`.
- pg_cron (в миграции, url проекта как в старых cron-миграциях, секрет из Vault `cron_secret`, тестовая копия подменяет url):
  - `journal-tg-dispatch`: каждую минуту → POST `/functions/v1/tg-dispatch`
  - `journal-schedule-nightly`: `0 0 * * *` (03:00 Минск) → POST `/functions/v1/schedule-nightly`
  - `journal-notify-daily`: `0 6 * * *` (09:00 Минск) → `select public.notify_daily()`
- Старая рассылка `send-reminders` (`journal-reminders`, 09:00, подписчики `tg_subscribers` и push) не трогается: для вошедших в 2.0 её заменяет `deadline_soon`. Решение о её отключении при выкладке записать в docs.

## Edge Functions

Секреты функций: `TELEGRAM_BOT_TOKEN`, `TG_ADMIN_IDS`, `TG_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `ADMIN_EMAIL`, `SITE_URL`, `CRON_SECRET`. Функции без JWT (проверка своя). Заголовок запуска по расписанию — `x-cron-secret` (сравнение с `CRON_SECRET`).

| Функция | Вызов | Что делает |
|---|---|---|
| `_shared/schedule.ts` | — | `importGroup(groupId, actor)` из текущего `schedule-import` (разбор, diff, запись, `schedule_meta`), возвращает `{ok, added, removed, changed, lessons, changes[]}` или ошибку; `changes[]` — список изменений для уведомлений (дата, пара, предмет, вид изменения: `room`, `time`, `teacher`, `added`, `removed`, старые и новые значения, подгруппа) |
| `schedule-import` | JWT: сисадмин, староста, зам группы | тонкая обёртка над `importGroup`; после успеха пишет уведомления `schedule` (см. ниже) |
| `schedule-nightly` | `x-cron-secret` | все активные группы по очереди (пауза 2 с между запросами к bseu.by), уведомления `schedule` по изменениям, при ошибке сразу алерт сисадминам, в конце сводка за день сисадминам (Telegram и почта) |
| `tg-dispatch` | `x-cron-secret` | `tg_claim_notifications` → Telegram `sendMessage` (заголовок жирным, текст, кнопка «Открыть журнал» только если `SITE_URL` начинается с `https://`; без текста сообщений чата) → `tg_notification_done`; блокировка бота пользователем (403) = неудача без повтора больше 3 раз |
| `tg-info` | публичный POST | `{ bot_username }` через `getMe` (кэш в памяти функции на час); нужен кабинету для кнопки «Открыть бота» |
| `tg-rebind-broadcast` | JWT: сисадмин | всем из `tg_rebind` с `broadcast_at is null` по `old_telegram_id`: «Журнал обновился. Войдите заново: отправьте код из кабинета» → `broadcast_at=now()` |
| `tg-bot` (правка) | webhook | при успешной привязке отвечает «Готово, вы вошли как <Фамилия И.>, <группа>. Уведомления включены.» и вторым сообщением «Что приходит: горящие домашки, изменения расписания, оценки и пропуски. Выключить можно в профиле.»; гасит `tg_rebind`; привязка работает и для пользователей без `profiles` (новые группы) |

Уведомление `schedule`: на каждого получателя одно сообщение за импорт. `title` «Изменилось расписание», `body` до 5 строк («Стратегический маркетинг, 12 ноября: аудитория 402 → 405»), дальше «и ещё N»; `dedupe_key = schedule:<group>:<дата импорта>`; получатели: активные студенты группы, кому подходит подгруппа занятия (подгруппа не выбрана = все), староста и зам. Только изменения в будущем (даты не раньше сегодняшней) и только `room`, `time`, `teacher`, `added`, `removed`.

Алерт сисадминам: `TG_ADMIN_IDS` (Telegram) и `ADMIN_EMAIL` (Resend). Текст без секретов и без содержимого ответа bseu.by (только код ошибки и группа).

## Интерфейс (приложение студента и сисадмина)

- Профиль, строка `#tgRow`: «Telegram-уведомления: привязан / не привязан» (запрос к `tg_links` своей строки), по нажатию экран `#/profile/telegram`.
- `#/profile/telegram`: статус привязки; не привязан → кнопка «Получить код» (RPC `tg_create_link_code`) → код крупно (формат `4F29-71` как в макете s03), срок 10 минут (обратный отсчёт), кнопка «Открыть бота в Telegram» (`https://t.me/<bot_username>?start=<код без дефиса>`; имя из функции `tg-info`), инструкция из трёх шагов; привязан → «Отвязать» (RPC `tg_unlink`) с подтверждением. Ниже переключатели типов уведомлений (10 штук минус неприменимые роли; для студента без `semester`, `import_failed`, `chat`), запись в `notification_prefs` сразу при нажатии.
- Экран «Журнал обновился» (`#/rebind`, макет s03 средний): показывается после входа в кабинет один раз, если есть своя строка `tg_rebind` без `dismissed_at` и нет привязки; шаги «Получите код», «Отправьте код боту», «Готово»; кнопки «Открыть бота в Telegram» и «Пропустить, привяжу позже» (RPC `tg_rebind_dismiss`). Если привязка появилась (опрос раз в 5 секунд), экран сам закрывается и показывает «Готово».
- Сисадмин (`sysadmin.html`): блок «Служебное» → «Сбросить привязки Telegram» (подтверждение, RPC `tg_reset_all`, затем вызов `tg-rebind-broadcast`, показывает «Сброшено N, разослано M»). Остальной «Служебное» — этап 5.
