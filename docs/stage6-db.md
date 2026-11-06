# Этап 6: удаление персональных данных (база)

Миграция: `supabase/migrations/20261111100000_journal2_erasure.sql`.
Откат: `supabase/migrations_down/20261111100000_journal2_erasure.down.sql` (схема возвращается, **стёртые данные — нет**).
Тесты: `tests/db/erasure.sql` (в `npm run test:db`).
ТЗ, раздел 5: «удаление по запросу, данные выпускников удаляются через год после выпуска; формулировки сверить с деканатом».
Тексты уведомлений и подписи в интерфейсе — черновые, сверить с деканатом.

## 1. Что создаётся

| Объект | Назначение |
|---|---|
| `groups.erased_at`, `students.erased_at` | когда группа / запись студента стёрта |
| `students.claim_status` + `'erased'` | стёртая запись: не свободна (join-group показывает и даёт выбрать только `free`), ни к кому не привязана |
| `data_deletion_requests (id, user_id → auth.users on delete set null, group_id, student_id, status ∈ pending/done/rejected/withdrawn, created_at, reviewed_by, reviewed_at, note ≤ 500)` | заявки. Одна `pending` на пользователя (частичный unique). RLS: чтение — своя, староста/зам группы, сисадмин; записи клиента нет (только RPC); «Техработы» |
| триггер `students_erased_freeze` | любой update стёртой строки `students` молча пропускается (легаси-импорт, сброс привязки, join-group её не «оживят») |
| триггер `erased_student_guard` на `absences`, `grades`, `certificates`, `student_achievements` | новая строка про стёртого: клиенту `student_erased` (42501), сервисным писателям (импорт, пересчёт значков) — строка молча пропускается |
| `_erase_student(p_group uuid, p_student text) → jsonb` | стирание одного студента (раздел 3). Клиентам закрыто |
| `_delete_accounts(p_users uuid[]) → int` | удаление аккаунтов и их следов в легаси-таблицах без FK. Клиентам закрыто |
| `graduates_cleanup() → jsonb` | выпускники через год. Только service_role; cron `journal-graduates` `25 1 * * *` (04:25 по Минску) |
| `sysadmin_set_group_status` | + статус `graduated` |

## 2. RPC — контракт для клиента

Все `security definer`, `search_path = ''`, execute: `authenticated, service_role`. Ошибка — `raise exception '<код>'`,
код в `error.message`. Общие: `not_authenticated` (28000), `maintenance` (42501, техработы), `forbidden` (42501).
Всё, что меняет данные, пишет `audit_log` (без ФИО: только id).

| Функция | Кто | Возвращает | Ошибки |
|---|---|---|---|
| `request_data_deletion(p_group uuid)` | active-студент группы (в т. ч. староста/зам) | `{ok, request_id, status: 'pending', already}`; при открытой заявке — она же, `already: true` | `not_student` (42501: нет active-членства студента в группе — преподаватель, ожидающий, чужая группа) |
| `my_data_deletion()` | любой вошедший | `{id, group_id, status, created_at, reviewed_at, note}` — открытая заявка, иначе последняя; `null`, если заявок нет | — |
| `withdraw_data_deletion()` | автор открытой заявки | `{ok, request_id}`, статус → `withdrawn` | `not_pending` (P0002) |
| `data_deletion_requests_list(p_group uuid)` | староста/зам группы, сисадмин; `p_group = null` — все группы, только сисадмин | `table(id, group_id, group_name, student_id, student_name, requester_role, status, created_at, reviewed_at, note, can_resolve)`; открытые первыми, затем новые | `forbidden` |
| `resolve_data_deletion(p_request uuid, p_approve boolean, p_note text)` | заявку студента — староста/зам его группы или сисадмин; заявку старосты/зама — только сисадмин; свою — никто, кроме сисадмина | `{ok, status: 'done' \| 'rejected'}`. Одобрение сразу стирает. Отказ — уведомление автору (`erasure`, текст = `p_note` или «Причина не указана.») | `bad_decision` (22023: `p_approve` null), `not_found` (P0002), `forbidden`, `not_pending` (P0001), `stale_request` (P0001: запись студента с момента заявки привязана к другому аккаунту) |
| `sysadmin_erase_student(p_student text)` | сисадмин | `{ok, group_id, student_id, already, accounts_deleted, accounts_kept}`; повтор — `already: true` | `not_found` (P0002) |
| `sysadmin_set_group_status(p_group uuid, p_status text)` | сисадмин | `{ok, status}` (как раньше) | `bad_status` (22023: не `active`/`closed`/`graduated`), `not_found`, `group_erased` (P0001: группа уже стёрта) |

- `requester_role`: текущая роль автора в группе — `'student'`, `'headman'`, `'deputy'`; `null`, если аккаунта или active-членства уже нет.
- `can_resolve`: вызывающий может решить эту заявку сейчас (кнопки «Удалить данные» / «Отклонить»).
- `student_name` у стёртых — «Удалён студент-xxxxxxxx».
- Уведомления `kind = 'erasure'`: о новой заявке студента — старосте и заму группы; о заявке старосты/зама — сисадминам;
  об отказе — автору. ФИО в тексте нет. Типа `erasure` нет в `notification_prefs` (выключить нельзя).
- Клиенту: прятать записи `students` с `claim_status = 'erased'` из выбора и журнала (в сводке и отчёте они остаются строкой
  «Удалён студент-…», чтобы часы группы сходились).

### Выпуск

`sysadmin_set_group_status(g, 'graduated')`: `graduated_at = now()` (повторный `graduated` срок не продлевает), отметка
автозакрытия `semester_closed_for` снимается. Группа только для просмотра: `group_open()` требует `active`, все политики
записи и RPC идут через неё; `semester_tick` трогает только `active` и автозакрытые `closed`; `notify_daily` — только
`active`. Возврат в `active`/`closed` сбрасывает `graduated_at`. Стёртую группу (`erased_at`) менять нельзя.
`graduates_cleanup()` раз в сутки берёт группы `graduated`, `graduated_at < now() − 1 год`, `erased_at is null`.

## 3. Что стирается (каждая таблица)

Стирание студента (`_erase_student`): запись блокируется `for update`; стёртая → `already`, ничего не меняется.
Аккаунты записи = `claimed_by` ∪ членства группы с этой записью ∪ легаси-профиль. Аккаунт **удаляется** из `auth.users`,
если он не сисадмин и у него нет active/pending-членства в другой группе. Иначе (преподаватель или студент другой
группы, сисадмин) аккаунт **остаётся**, у него снимается только эта группа.

| Таблица | Решение | Почему |
|---|---|---|
| `students` | **обезличить**: `last_name = 'Удалён'`, `first_name = 'студент-' + 8 знаков md5(id)` (при совпадении — `'студент-' + id`), `telegram`, `claimed_by`, `claimed_at` = null, `claim_status = 'erased'`, `erased_at` | на строку ссылаются пропуски, справки, оценки (составные FK); уникальность ФИО в группе не нарушается |
| `absences` | **оставить**, `comment` = null; `created_by` удалённого аккаунта = null | статистика группы и отчёт деканата; свободный текст мог содержать ФИО; записи старосты становятся «легаси» и их правит новый староста |
| `certificates` | **оставить**, `note` = null; `created_by` удалённого = null | на справку ссылаются пропуски (FK); статистика |
| `grades` | **оставить**, `comment` = null | статистика; текст |
| `tasks` | оставить; `created_by` удалённого = null | задания группы не личные |
| `app_events`, `student_achievements`, `game_records`, `word_attempts`, `assoc_daily_results` | **удалить** по `student_id` | личная активность, значки, рейтинги игр; для статистики группы не нужны |
| `remind_log`, `invite_codes`, `pass_tokens`, `profiles` | **удалить** по записи | служебные связи с человеком |
| `tg_task_requests` | **удалить** по `author_student_id` и автору | текст, написанный студентом |
| `notifications` | **удалить**: свои (каскад), чужие с `ref.student_id` этой записи, чужие с ФИО в тексте (справки, порог деканата старосте) | ФИО в тексте |
| `memberships`, `consents`, `notification_prefs`, `tg_links`, `tg_link_codes`, `tg_rebind`, `push_subscriptions`, `chat_keys` | **удалить** (каскад от `auth.users`; у оставленного аккаунта — только членство, согласия и уведомления этой группы) | личное, без аккаунта смысла нет |
| `chat_threads`, `chat_messages`, `chat_reads` | **удалить** треды, где человек — сторона старосты (каскад; у оставленного аккаунта — треды этой группы) | E2E-чат; сообщения преподавателя в том же треде удаляются вместе с ним (отдельно их не сохранить) |
| `registration_requests` | своя заявка — каскад; в `payload` заявок группы элемент с этим ФИО → `{"last_name":"Удалён","first_name":"студент"}`; владелец с этой фамилией — без `name` и `email` | список студентов в payload с ФИО |
| `audit_log` | **оставить**, в `details` дословная замена фамилии → «Удалён», имени → «студент» в строках, где есть и то и другое; ключ `email` у записей об удалённом аккаунте убирается | журнал нужен для разбора; RPC не пишут туда ФИО, замена — страховка (Edge Functions, ручные записи) |
| `tg_subscribers`, `tg_dialog_state`, `tg_task_log`, `tg_action_log`, `notify_log` | **удалить** по telegram id (из `tg_links`, `tg_rebind`, `tg_task_log`) и push-адресам удаляемого аккаунта | легаси без FK на аккаунт; `tg_name` — имя в Telegram |
| `storage.objects` (`avatars`) | **удалить строку** `<user_id>.*` удаляемого аккаунта (через `storage.allow_delete_query` на транзакцию) | аватар — фото |
| `journal_private` (только 24ДММ-2) | элемент студента в `students` **заменяется** на `{id, lastName: 'Удалён', firstName}` (без `telegramUsername`, `isAdmin` и прочих ключей); `comment` пропусков в jsonb → '' (зеркало) | элемент не удаляется: на него ссылаются пропуски в том же jsonb, старый index.html ищет имя по `studentId` |
| `data_deletion_requests` | открытые заявки этой записи → `done`; строки остаются, `user_id` → null | след решения без ФИО |
| `join_attempts`, `code_attempts`, `client_events`, `backups`, `ops_state`, `schedule_*`, `study_days`, `lesson_notes`, `word_*`, `assoc_settings`, `app_settings`, `group_invites`, `teacher_assignments`, `sysadmins` | не трогаются при стирании одного студента | нет данных о студенте (хэши IP, события без пользователей, данные группы) |

Выпускники (`graduates_cleanup`, на каждую группу): все нестёртые студенты через `_erase_student`; аккаунты
студентов группы без записи (ожидающие, отклонённые, сброшенные) — удаляются, если не сисадмин и нет другой группы;
затем **удаляются** членства и назначения преподавателей в этой группе (аккаунты преподавателей остаются), чат группы,
уведомления группы, согласия группы, `schedule_lessons`, `schedule_meta`, `lesson_notes`, `tasks`, `study_days`,
`remind_log`, `group_invites` (код группы); `registration_requests.payload` группы → `{"erased": true}`. **Остаются**:
строка `groups` (+ `erased_at`), обезличенные `students`, `absences`, `certificates`, `grades`, `audit_log` (+ `group_erase`).
Расписание, темы занятий и задания без группы смысла не имеют и могут содержать имена преподавателей; пропуски и оценки —
единственное, что может понадобиться деканату позже (сводные часы группы).

## 4. Безопасность и гонки

- `_erase_student`, `_delete_accounts` — без execute у клиентов; `graduates_cleanup` — только service_role.
- Студента чужой группы не стереть: заявка — только своей записи (`my` членство), решение — староста/зам группы
  заявки, напрямую — сисадмин. Аккаунт сисадмина и преподавателя (членство в другой группе) не удаляется никаким путём.
- После стирания старосты группа остаётся без старосты (unique-индекс «один староста» не нарушается; нового назначает
  сисадмин через `sysadmin_set_group_role`, как у группы, созданной сисадмином).
- Повтор: стёртая запись → `already`, `graduates_cleanup` берёт только `erased_at is null`. Два одновременных стирания
  одной записи идут по очереди (`for update` на `students`), второе видит `already`. Заявка решается под `for update`.
  Группы в чистке — `for update skip locked`.
- Динамического SQL в новых функциях нет.

## 5. Известные ограничения и риски

- **Резервные копии.** Ночные копии в Storage `backups` хранятся 14 дней и содержат ФИО. Из копии стереть нельзя:
  данные полностью исчезают через 14 дней после стирания. Восстановление из копии старше стирания вернёт стёртое —
  после восстановления повторить стирание (`sysadmin_erase_student` по `audit_log` `student_erase`).
- **Аватар.** Удаляется строка `storage.objects`: файл больше не выдаётся, но сам объект в хранилище остаётся (удалить
  его может только Storage API). Если нужно удалять физически — Edge Function с `storage.remove` до вызова стирания.
- **Свободный текст.** Замена ФИО в `audit_log` дословная (регистр как в записи), только для фамилии от 2 знаков и
  без `"`/`\`; имя заменяется во всей строке, где есть и фамилия (может задеть тёзку в той же записи). В `tasks.rec`,
  `lesson_notes`, `schedule_lessons`, текстах уведомлений без ФИО «Фамилия Имя» поиск не делается. Зашифрованный чат
  проверить нельзя — треды удаляются целиком.
- **Сброшенные аккаунты.** Аккаунт, который раньше был привязан к записи, но привязку сбросили (членство `removed`,
  `student_id` null), при стирании студента не удаляется (неизвестно, тот ли это человек); при выпуске группы — удаляется.
- **Легаси 1.x.** Старая админка (`journal-save`) перезаписывает `journal_private` целиком из своей копии: открытая до
  стирания вкладка может вернуть ФИО в jsonb. Таблица `students` от этого не меняется (заморозка, импорт берёт только новые id).
- **Откат** схемы не восстанавливает данные; ограничение `claim_status` возвращается `not valid` (обезличенные строки
  остаются `erased`). После отката легаси-импорт может перевести стёртые строки 24ДММ-2 в `free` (они станут выбираемыми
  с именем «Удалён студент-…»).
- Формулировки уведомлений и срок «год после выпуска» — сверить с деканатом (ТЗ).
