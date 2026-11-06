# Выкладка «Журнала 2.0» в прод

Прод: проект `journal-24dmm2`, ref `woiqekpuoddxixlrbvkp`. Реальные данные: 28 студентов, 276 пропусков, 265 событий, 509 значков, 35 игровых рекордов, 7 задач, 89 учебных дней, 28 профилей.
Ветка `stage6-semester` (23 коммита от `main`) не слита и не запушена. Тестового стенда в проде нет: тесты шли на `jloicrwugkbchulunhtd`.

**Выкладка делается только по прямой команде владельца.** Каждый шаг ниже, который пишет в прод, выполняется после слов «выкладывай» и подтверждения этого шага.

## 0. Что идёт в прод

| Что | Состав |
|---|---|
| Миграции (7, у каждой есть `*.down.sql` в `supabase/migrations_down/`) | `20261105200000_journal2_groups`, `20261106100000_journal2_cabinets`, `20261107100000_journal2_notifications`, `20261108100000_journal2_teachers_chat`, `20261109100000_journal2_ops`, `20261110100000_journal2_semester`, `20261111100000_journal2_erasure` |
| Edge Functions (новые) | `join-group`, `registration-start`, `schedule-lookup`, `schedule-import`, `schedule-nightly`, `notify-registration`, `tg-dispatch`, `tg-info`, `tg-rebind-broadcast`, `tg-status`, `tg-webhook-setup`, `client-report`, `health-check`, `ops-report`, `backup-run`, `backup-link`, `sysadmin-user` |
| Edge Functions (изменены) | `tg-bot`, `journal-save` (теперь всегда 410: старая админка 1.x закрыта), общий код `_shared/` (его используют и старые функции: после правки `_shared` передеплоить всё, что его импортирует, см. шаг 5) |
| Сайт (новые файлы) | `app.html`, `headman.html`, `teacher.html`, `sysadmin.html`, `join.html`, `register.html`, `app-student.js`, `cab-core.js`, `cab.css`, `chat-crypto.js`, `chat-ui.js`, `headman.js`, `teacher.js`, `sysadmin.js`, `join.js`, `register.js`, `j2-core.js`, `j2-gate.js`, `j2.css`, `monitor.js`, `offline-queue.js`, `pwa.js`, `vendor/exceljs.min.js` |
| Сайт (изменены) | `index.html` (без `#hash` ведёт на `app.html` или `join.html`), `sw.js` (`journal-24dmm2-v51`) |
| Секреты функций | уже есть: `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`, `TG_ADMIN_IDS`, `RESEND_API_KEY`, `MAIL_FROM`, `ADMIN_EMAIL`, `VAPID_*`, `GITHUB_*`. Новые: `SITE_URL` (адрес сайта на HTTPS, начинается с `https://`), `TG_WEBHOOK_SECRET` (если ещё не задан для `tg-bot`) |
| Cron (создают миграции) | `journal-tg-dispatch` (каждую минуту), `journal-schedule-nightly`, `journal-notify-daily`, `journal-ops-cleanup`, `journal-health` (5 мин), `journal-ops-report`, `journal-backup`, `journal-semester`, `journal-graduates` |

## 1. Перед началом (только чтение, прод не меняется)

1. Ветка чистая, тесты зелёные на тесте: `npm run test:unit`, `npm run test:db` (955/955), e2e по одному (`ui` 21, `schedule` 17, `student` 61, `headman` 54, `teacher` 71, `chat-rest` 65, `ops-rest` 60, `ops` 90, `offline` 21, `erasure` 23).
2. `npx supabase migration list --linked` из папки, привязанной к проду: на проде применены все миграции до `20261103130000_maintenance_mode`; семь миграций 2.0 отсутствуют. Если порядок другой — СТОП.
3. Дубли ФИО (должно вернуть 0 строк; иначе импорт откатит миграцию 1):
   ```sql
   select lower(btrim(s->>'lastName')), lower(btrim(s->>'firstName')), count(*)
     from public.journal_private, jsonb_array_elements(students) s
    group by 1, 2 having count(*) > 1;
   ```
4. Ровно один староста: `select count(*) from public.journal_private, jsonb_array_elements(students) s where (s->>'isAdmin')::boolean;` → 1.
5. Подгруппы (проверка после миграции 1, до миграции 2 нужно, чтобы значения были только `'1'`/`'2'` или пусто; остальные станут null): `select subgroup, count(*) from public.students group by 1;`. `db push` применяет все 7 миграций подряд, поэтому при сомнении проверить на копии: на тесте все значения валидны.
6. Vault: `select count(*) from vault.decrypted_secrets where name = 'cron_secret';` → 1. Значение то же, что секрет функций `CRON_SECRET`. Если 0: `select vault.create_secret('<CRON_SECRET>', 'cron_secret', 'x-cron-secret для cron');`.
7. Снять контрольные числа «до»: `select count(*) from public.attendance_badges_deserved();` (на тесте 325 для копии; на проде своё число).
8. Секреты: `npx supabase secrets list --project-ref woiqekpuoddxixlrbvkp` — есть всё из таблицы выше. Недостающие задать: `SITE_URL`, `TG_WEBHOOK_SECRET` (`openssl rand -hex 32`, символы `A-Za-z0-9_-`). Значения в чат и в репозиторий не класть.

## 2. Бэкап (обязательно, до любой записи)

1. `pg_dump` прода в файл вне репозитория (например, `C:\Users\dimpo\backups\journal-pre2.0-<дата>.sql`).
2. JSON-выгрузка (read-only): `journal_private`, `profiles`, `app_events`, `student_achievements`, `game_records`, `tasks`, `study_days`, `absences` (если уже есть), `tg_links`, `tg_link_codes`, `notifications`.
3. **Проверить чтение:** файл открывается, JSON парсится, число строк по каждой таблице равно числу в базе (28 / 28 / 265 / 509 / 35 / 7 / 89 и т. д.). Без проверки дальше не идти.
4. В базе уже есть `backup_20261103_*` — оставить, не удалять.
5. Скачать копию Storage-бакетов (`avatars`), если она нужна для отката.

## 3. Техработы включить

Через текущую админку 1.x (или `maintenance_mode`). Во время техработ журнал проходит только сисадмин и староста 24ДММ-2 (`is_journal_admin`). Проверить с аккаунта студента, что вход закрыт. Объявить студентам время окна.

## 4. Миграции (из папки `supabase/`, привязанной к проду)

```
npx supabase link --project-ref woiqekpuoddxixlrbvkp
cat supabase/.temp/project-ref        # = woiqekpuoddxixlrbvkp
npx supabase db push --linked          # покажет список из 7 миграций; подтвердить только его
```

Миграция 1 идёт одной транзакцией и сама импортирует 24ДММ-2 (`journal2_import_legacy`): ошибка откатывает всё, база остаётся нетронутой.

Если `db push` просит `--include-all` или показывает чужие миграции — СТОП, разобраться, не форсировать.

**Что проверить сразу после:**

1. Импорт (service_role): `select public.journal2_import_legacy();` → `students = 28, absences = 276, memberships = 28, headman = 1, skipped_absences = 0, profiles_without_student = 0` (повтор безопасен, ничего не меняет).
2. Сверка до/после — заполнить `docs/reports/migration-24dmm2.md` по образцу `docs/reports/test-copy.md`: `students`, `absences`, `profiles`, `app_events` (265), `student_achievements` (509), `game_records` (35), `study_days` (89), `tasks` (7), + хэш содержимого `journal_private`. Любое расхождение = откат (раздел «Откат»).
3. Значки G24: `select count(*) from public.attendance_badges_deserved() where group_id = '00000000-0000-4000-8000-000000000024';` = число из шага 1.7.
4. Cron: `select jobname, schedule, command like '%woiqekpuoddxixlrbvkp%' as prod_url from cron.job where jobname like 'journal-%' order by 1;` — девять новых заданий, адрес прода у всех; старый `journal-reminders` пока на месте.
5. Права: `select proname, prosecdef, proconfig from pg_proc where proname like 'sysadmin_%' or proname like 'ops_%' or proname like 'chat_%' or proname = 'teacher_group_stats';` — все `prosecdef = t`, `search_path=""`. `select has_function_privilege('anon','public.ops_summary(int)','execute');` → `f`. `select id, public from storage.buckets where id = 'backups';` → `f`.
6. Староста (сессия под его аккаунтом): `maintenance_status()` → `admin: true`, журнал читается при включённых техработах.
7. Первый сисадмин (service_role): `select public.sysadmin_bootstrap('<uuid аккаунта сисадмина>');`.

**Порядок выполнения: 3 → 5 → 4 → 6 → 7.** Функции (раздел 5) выкладываются ДО миграций: иначе cron раз в минуту и раз в 5 минут получает 404 (`net._http_response`; вреда нет, но шум в логах). Проверки раздела 5 про `cron.job_run_details` делаются уже после миграций.

## 5. Edge Functions

Деплой из папки, привязанной к проду, JWT выключен (функции проверяют токен сами; публичный ключ `sb_publishable_…` не JWT):

```
npx supabase functions deploy <имя> --project-ref woiqekpuoddxixlrbvkp --no-verify-jwt --use-api
```

Порядок: сначала `journal-save` (закрывает старую админку; идёт при включённых техработах, правки 1.x больше не нужны), `health-check`, `ops-report`, `backup-run`, `backup-link`, `tg-dispatch`, `schedule-nightly`, `schedule-import`, `schedule-lookup`; затем `join-group`, `registration-start`, `notify-registration`, `tg-info`, `tg-status`, `tg-rebind-broadcast`, `tg-webhook-setup`, `client-report`, `sysadmin-user`; затем `tg-bot`.
Старые функции, импортирующие `_shared/` (`journal-save`, `tg-requests`, `tg-set-task-editor`, `send-reminders`, `submit-game-score`, `word-*`, `verify-pass`, `admin-data`, `change-login`, `register-with-code`, `subscribe-telegram`): `git diff main..HEAD -- supabase/functions/_shared` и передеплоить те, чей импортируемый файл изменился.
Проверка: `npx supabase functions list --project-ref woiqekpuoddxixlrbvkp` — все новые со статусом `ACTIVE`.

Через 5–10 минут: `select status, return_message from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'journal-tg-dispatch') order by start_time desc limit 3;` → `succeeded`; `select status_code from net._http_response order by created desc limit 5;` → 200.

## 6. Сайт

1. `deploy-fix.ps1 -RepoPath C:\Users\dimpo\student-journal` публикует `index.html`, `data.json`, `cabinet.html`, `manifest.json`, `sw.js`, `icons/` (скрипт добавляет и все файлы кабинетов 2.0 из раздела 0; перед запуском посмотреть `git status`).
2. Hosting (GitHub Pages) отдаёт по HTTPS: `chat-crypto.js` (Web Crypto) работает только в secure context.
3. Через 1–2 минуты открыть `…/app.html`, `…/headman.html`, `…/sysadmin.html` в чистом окне: HTTP 200, нет ошибок в консоли. Сервис-воркер сменится на `journal-24dmm2-v51` после второго открытия.

## 7. 24ДММ-2: переключение на кабинет 2.0

1. Староста и 28 студентов входят по прежним логину и паролю: профиль и `student_id` не менялись, значки и рекорды на месте (выборочно 3 студента, сверить с «до»).
2. Согласие на данные запрашивается при первом входе после обновления.
3. `cron.unschedule('journal-reminders')` — **в день переключения и сброса бота**, не раньше (иначе двойные напоминания):
   `select cron.unschedule('journal-reminders');` → `true`.
4. Telegram:
   - вебхук: `POST https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/tg-webhook-setup` с заголовком `x-cron-secret: <CRON_SECRET>` → `ok: true`, `last_error: null`;
   - «Служебное» в `sysadmin.html` → «Сбросить привязки Telegram» (`tg_reset_all`), затем рассылка `tg-rebind-broadcast`. Каждый студент получает «Журнал обновился. Войдите заново…» и привязывает бота кодом из кабинета.
   - До сброса старые привязки `tg_links` уже работают с очередью 2.0.
5. Расписание: «Обновить расписание» у старосты или ждать `journal-schedule-nightly`; `select * from public.schedule_meta` — статус `ok`.
6. Сисадмин: «Состояние» отвечает; через 5–10 минут `pings > 0`; «Создать копию сейчас» создаёт строку в `backups` и файл `backups/<дата>/`.
7. Старая админка 1.x закрыта: `journal-save` отвечает 410 `legacy_admin_closed` (выложен в шаге 5), «Админ-панель» в `index.html` ведёт на `headman.html`. Проверка: `curl -s -X POST https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/journal-save -H "apikey: <publishable key>"` → `{"error":"legacy_admin_closed"}`, код 410. Открытая вкладка 1.x у старосты при сохранении получит ошибку, данные не потеряются.

## 8. Смоук (после всех шагов, под реальными ролями)

- Студент: главная, расписание, учёба, пропуски, профиль, уведомления; `#games`, `#achievements` открываются из `index.html#…`.
- Староста: сводка, журнал (добавить и удалить тестовый пропуск), справка, задания, заявки студентов, чат.
- Сисадмин: Состояние, Логи, Роли, Группы, Служебное; назначить преподавателя; тестовое письмо (Resend) доходит.
- Преподаватель (тестовый): журнал дисциплины, посещаемость, чат со старостой.
- Регистрация новой тестовой группы: `register.html` → заявка → одобрение сисадмином → код группы → вход студента (`join.html`). Тестовую группу и студента затем стереть через «Удаление данных».
- В `cron.job_run_details` за последний час нет `failed`; `ops_summary(1)` без `server_errors`.

## 9. Техработы выключить

Только после смоука. Проверить вход обычным студентом.

## 10. Откат

| Когда | Что делать |
|---|---|
| Ошибка `db push` | ничего: транзакция откатилась. Разобрать причину, прод не изменён |
| Расхождение сверки или поломка кабинетов после миграций | техработы ВКЛ; down-скрипты **в обратном порядке** из `supabase/migrations_down/` (erasure → semester → ops → teachers_chat → notifications → cabinets → groups), выполнить как SQL; убрать записи из `supabase_migrations.schema_migrations`; сверить числа с бэкапом; при расхождении — восстановить из `pg_dump`/JSON шага 2 |
| Плохая функция | `supabase functions deploy` предыдущей версии из `main` (`git checkout main -- supabase/functions/<имя>`); новые функции можно оставить, cron к ним просто получит 404 |
| Плохой сайт | вернуть предыдущий коммит GitHub Pages (`git revert` деплой-коммита и push); `sw.js` версией выше |
| Telegram | если сброс привязок уже прошёл, привязки не возвращаются: студенты привязывают заново (кнопка «Привязать» в профиле). Вебхук вернуть на прежний URL при необходимости |
| `journal-reminders` | `select cron.schedule(...)` из `20261001181000_reminders_cron.sql` вернуть задание |

Откат миграций **безвозвратно** удаляет: новые таблицы (`students`, `memberships`, ключи и сообщения чата, справки, оценки, заявки на удаление, бэкап-метаданные), строки других групп в старых таблицах, привязки Telegram, удалённые `tg_reset_all`. Данные 24ДММ-2 в `journal_private` не меняются откатом.

## 11. Открытые риски (решить до команды «выкладывай»)

1. ~~Старая админка 1.x и `journal-save`~~ — решено: `journal-save` отвечает 410, вход в админку 1.x ведёт на `headman.html`. Остаточное: открытая вкладка 1.x не сохранит правки (покажет ошибку); попросить старосту обновить страницу.
2. **Стирание данных.** Бэкапы Storage хранятся 14 дней и содержат ФИО; файл аватара остаётся; старая админка 1.x может вернуть ФИО в `journal_private`; тексты согласия и срок «один год после выпуска» нужно сверить с деканатом.
3. ~~`deploy-fix.ps1`~~ — решено: скрипт добавляет все файлы кабинетов 2.0; перед запуском всё равно посмотреть `git status`.
4. **Служебные файлы не коммитить:** `supabase/.temp/cli-latest`, `.mcp.json`, `claude_code_prompt.md`, `tools-inventory.md`, `docs_for_claude_code/`, `tools/perf-init.mjs`, `ТЗ_Журнал_2.0.docx`.
5. **Слияние веток.** Ветки `stage1…stage6-semester` идут цепочкой. Слить `stage6-semester` в `main` одним PR после успешной выкладки (или до неё, если Pages публикуется из `main`: тогда шаг 6 = merge + push, и порядок «функции → миграции → сайт» обязателен).
