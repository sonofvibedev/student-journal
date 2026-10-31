# Telegram-бот для домашки и дедлайнов

Бот принимает задачи от студентов с флагом `can_post_tasks` и пишет их в `data.json` в GitHub — туда же, куда пишет админка. Вебхук обрабатывает Edge Function `tg-bot`.

## Как это устроено

- **Права.** Флаг `profiles.can_post_tasks` у обычного пользователя. Выдаёт и снимает только админ, через функцию `tg-set-task-editor` (проверка по токену GitHub, как в `journal-save`). Сам студент флаг не изменит: у него нет права записи в `profiles`.
- **Админ в боте** (правит и удаляет любые записи, без ограничения в 24 часа) — Telegram-id из секрета `TG_ADMIN_IDS`. Он тоже должен быть привязан к аккаунту.
- **Привязка.** В кабинете вызывается RPC `tg_create_link_code()` и возвращает код `ABCD-EFGH` (10 минут, одноразовый, в базе только его sha-256). Пользователь шлёт код боту (`/start КОД` или просто код). Без привязки бот ничего не делает.
- **Диалог:** `/start` → Домашка / Дедлайн → предмет → дата (ближайшие занятия по предмету + «Другая дата», ввод `ДД.ММ`) → текст → предпросмотр (Сохранить, смена типа ПЗ/УСР, Изменить текст, Отмена). Состояние хранится в `tg_dialog_state`, срок 30 минут.
- **`/мои`** — последние 5 записей автора с кнопками «Изменить текст» и «Удалить» (в течение 24 часов от создания). Админ видит и правит любые.
- **Лимит** — 20 записей в час на пользователя (`tg_task_log`). После 5 неверных кодов за 10 минут привязка блокируется на 10 минут.
- **Запись в data.json:** бот читает свежий файл через GitHub Contents API, добавляет запись и пишет с `sha`; при 409/422 повторяет (до трёх раз). Запись содержит обычные поля админки плюс `author` (student_id), `source: "bot"`, `createdAt`. Коммит: `Бот: домашка Предмет — 05.11 (добавлено)`.

## Что нужно от вас (секреты)

| Секрет | Что это |
|---|---|
| `TELEGRAM_BOT_TOKEN` | уже есть |
| `TG_WEBHOOK_SECRET` | придумать длинную случайную строку, например `openssl rand -hex 32`. Символы только `A-Z a-z 0-9 _ -` |
| `GITHUB_TOKEN` | **нужно создать.** GitHub → Settings → Developer settings → Fine-grained tokens: репозиторий только `sonofvibedev/student-journal`, право **Contents: Read and write**, срок на ваш выбор. Это отдельный токен бота, не ваш `gh_pat` |
| `TG_ADMIN_IDS` | ваш числовой Telegram-id (узнать у @userinfobot); можно несколько через запятую |
| `SITE_URL` | уже есть (его использует `send-reminders`) |
| `GITHUB_REPO`, `GITHUB_BRANCH` | необязательно: по умолчанию `sonofvibedev/student-journal` и `main` (для тестового стенда задайте свои) |

```bash
supabase secrets set TG_WEBHOOK_SECRET=<случайная_строка> GITHUB_TOKEN=<токен> TG_ADMIN_IDS=<ваш_id>
```

## Запуск по шагам

1. Применить миграцию `supabase/migrations/20261101130000_tg_bot_tasks.sql` (`supabase db push`).
2. Задать секреты (выше).
3. Задеплоить функции. У бота JWT выключен: Telegram его не шлёт, защита — секретный заголовок.
   ```bash
   supabase functions deploy tg-bot --no-verify-jwt
   supabase functions deploy tg-set-task-editor --no-verify-jwt
   ```
4. Включить вебхук (значения подставьте свои, в репозиторий их не кладите):
   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://<PROJECT_REF>.supabase.co/functions/v1/tg-bot" \
     -d "secret_token=<TG_WEBHOOK_SECRET>" \
     -d 'allowed_updates=["message","callback_query"]' \
     -d "drop_pending_updates=true"
   ```
   Проверка: `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"` — без `last_error_message`.
5. По желанию — меню команд:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setMyCommands" \
     -d 'commands=[{"command":"start","description":"Добавить задачу"},{"command":"my","description":"Мои записи"},{"command":"cancel","description":"Отмена"}]'
   ```

## Выдать и снять право

Через функцию (токен админа тот же `gh_pat`, что в админке):

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/tg-set-task-editor" \
  -H "Content-Type: application/json" -H "apikey: <ANON_KEY>" \
  -d '{"ghToken":"<gh_pat>","action":"set","studentId":"st-...","value":true}'
# список имеющих право: {"ghToken":"...","action":"list"}
```

Либо SQL в панели Supabase: `update public.profiles set can_post_tasks = true where student_id = 'st-...';`. Студент должен быть зарегистрирован (иметь профиль). Снятый флаг действует сразу: бот проверяет его на каждое действие.

Привязка у пользователя: в кабинете вызвать `sb.rpc('tg_create_link_code')`, показать код, отправить его боту. Отвязка: `sb.rpc('tg_unlink')`; статус: `select` из `tg_links` (своя строка).

## Как проверить

1. `node tools/test-tgbot.js` — логика (даты, лимит, срок кода, секретный заголовок, сборка записи, расписание).
2. Без заголовка: `curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/tg-bot -d '{}'` → `403`.
3. Выдать себе флаг, получить код, прислать боту, пройти `/start` до «Сохранить». В репозитории появится коммит «Бот: …», через 1–2 минуты запись видна в приложении.
4. `/мои` → «Удалить» удаляет запись (тоже коммит).

## Ограничения и риски

- **Запись видна не сразу:** data.json отдаёт GitHub Pages, обновляется 1–2 минуты после коммита.
- **Расписание:** сервер читает `schedule.js` с сайта как текст и вытаскивает строки регулярками (код не исполняется). Если формат файла изменится или сайт недоступен, бот предложит «Сегодня / Завтра / Через неделю» и «Другая дата». Подгруппы и замены не учитываются, зачёты пропускаются.
- **Админ перезаписывает записи бота,** если не обновлён клиент: `saveDataToGitHub` берёт свежий `sha`, но содержимое строит из копии, загруженной при открытии страницы. Нужна правка в `index.html` — см. отчёт оркестратору (слияние записей `source: "bot"` перед PUT).
- Тип «УСР» бот пишет как есть, в форме админки такого типа нет (ЛК/ПЗ/ЛР).
- Привязку нельзя «увести»: код одноразовый и живёт 10 минут, но тот, кто увидел чужой код за это время, может им воспользоваться. Не показывайте код на экране лишний раз.
