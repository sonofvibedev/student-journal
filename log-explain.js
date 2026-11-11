// «Журнал 2.0.3»: понятные подписи к записям «Логи» сисадмина. Чистые функции без обращения к странице и базе:
// explain(строка ленты) → { who, text, ok, help }, toCsv(строки). Лента приходит из sysadmin_activity_log.
// Работает в браузере (window.LogExplain) и в Node (тест).
(function (root) {
  'use strict';
  const ROLE_RU = { sysadmin: 'Сисадмин', teacher: 'Преподаватель', headman: 'Староста', deputy: 'Заместитель старосты', student: 'Студент', system: 'Система', unknown: 'Пользователь' };
  const KIND_RU = { admin: 'Управление', absence: 'Пропуски', cancel: 'Отмена пропусков', grade: 'Оценки', task: 'Задания', error: 'Ошибки' };
  const ACTION = {
    registration_approve: 'Заявка одобрена', registration_reject: 'Заявка отклонена', membership_approve: 'Студент подтверждён', membership_reject: 'Студент отклонён',
    student_reset_binding: 'Сброс привязки', remind_headman: 'Напоминание старосте', consent_accept: 'Согласие принято', group_code_rotate: 'Новый код группы',
    set_group_role: 'Роль в группе', set_thresholds: 'Пороги пропусков', sysadmin_bootstrap: 'Сисадмин назначен',
    teacher_assign: 'Преподаватель назначен', teacher_remove: 'Преподаватель снят', sysadmin_add: 'Сисадмин добавлен', sysadmin_remove: 'Сисадмин снят',
    group_create: 'Группа создана', group_status: 'Статус группы изменён', sysadmin_user_create: 'Учётная запись создана', backup_manual: 'Копия создана вручную',
    backup_download: 'Копия скачана', ops_report_sent: 'Сводка отправлена', tg_webhook_reinstall: 'Вебхук бота переустановлен',
  };

  // Что означает ошибка и что делать. Первое совпавшее правило по «имя сообщение».
  const ERR_HELP = [
    [/failed to fetch|networkerror|load failed|network request failed/i, 'Браузер не смог связаться с сервером: у пользователя пропала или слабая связь.', 'Разовые записи не опасны: отметки сохраняются в очереди. Если таких много сразу, откройте «Состояние» и проверьте доступность.'],
    [/jwt|token|not authenticated|401/i, 'Вход пользователя устарел или недействителен.', 'Ничего не делать: пользователь войдёт заново. Если жалоб много, проверьте «Состояние».'],
    [/permission denied|row-level security|42501|forbidden/i, 'База отказала: у пользователя нет права на это действие или журнал закрыт (техработы, закрытая группа).', 'Проверьте режим техработ и статус группы; если права должны быть, поправьте роль в «Роли».'],
    [/rejection/i, 'В странице не обработана ошибка запроса.', 'Откройте «Подробности»: там страница и стек. Если повторяется у многих, сообщите разработчику.'],
    [/backup/i, 'Резервная копия не создана.', 'Откройте «Служебное → Копии», проверьте место и создайте копию вручную.'],
    [/schedule/i, 'Расписание не обновилось: сайт bseu.by не ответил или изменил разметку.', 'Повторите обновление у старосты через 10 минут. Если не проходит, проверьте сайт вручную.'],
    [/tg-|telegram/i, 'Не сработала отправка или приём в Telegram.', 'Откройте «Состояние» → бот. При необходимости переустановите вебхук в «Служебное».'],
    [/notify-registration|mail|resend/i, 'Письмо не отправлено.', 'Проверьте ключ почтового сервиса и адрес отправителя в секретах функций.'],
    [/health-check|ops-report/i, 'Не сработала проверка состояния или сводка.', 'Откройте «Состояние»: если доступность в норме, ошибка разовая.'],
    [/typeerror|referenceerror|syntaxerror|error/i, 'Ошибка в коде страницы у пользователя.', 'Откройте «Подробности»: страница и стек. Если повторяется, сообщите разработчику.'],
  ];
  const errHelp = (name, message) => {
    const s = `${name || ''} ${message || ''}`, h = ERR_HELP.find((x) => x[0].test(s));
    return h ? { means: h[1], todo: h[2] } : { means: 'Неизвестная ошибка.', todo: 'Откройте «Подробности». Если повторяется, сообщите разработчику.' };
  };

  const day = (iso) => (iso ? String(iso).slice(8, 10) + '.' + String(iso).slice(5, 7) : '');
  const hrs = (q) => (q == null ? '' : ' (' + String(Number(q)).replace('.', ',') + ' ч)');
  const place = (r) => [r.target, r.subject || 'без предмета', day(r.on_date)].filter(Boolean).join(', ');

  function explain(r) {
    const role = ROLE_RU[r.actor_role] || ROLE_RU.unknown;
    const who = r.actor ? `${r.actor_name} (${role.toLowerCase()})` : r.kind === 'error' ? 'Не определён (ошибки не привязаны к пользователю)' : 'Система';
    const by = r.actor ? role : 'Система';
    let text, help = null;
    switch (r.action) {
      case 'absence_add': text = `${by} внёс пропуск${hrs(r.qty)}: ${place(r)}.${r.detail ? ' ' + r.detail[0].toUpperCase() + r.detail.slice(1) + '.' : ''} Сохранено.`; break;
      case 'absence_cancel': text = `${by} отменил пропуск${hrs(r.qty)}: ${place(r)}. Отмена сохранена в истории.`; break;
      case 'grade_set': text = `${by} внёс отметку: ${place(r)}. Сохранено.`; break;
      case 'task_homework': text = `${by} добавил или изменил домашнее задание: ${[r.subject || 'без предмета', r.detail, r.on_date ? 'срок ' + day(r.on_date) : ''].filter(Boolean).join(', ')}. Сохранено.`; break;
      case 'task_deadline': text = `${by} добавил или изменил дедлайн: ${[r.subject || 'без предмета', r.detail, r.on_date ? 'срок ' + day(r.on_date) : ''].filter(Boolean).join(', ')}. Сохранено.`; break;
      default:
        if (r.kind === 'admin') text = `${by}: ${ACTION[r.action] || r.action}. Выполнено.${r.detail ? ' Параметры: ' + (r.detail.length > 160 ? r.detail.slice(0, 160) + '…' : r.detail) + '.' : ''}`;
        else { help = errHelp(r.action, r.detail); text = `Ошибка «${r.action || 'без названия'}»${r.detail ? ': ' + r.detail : ''}. ${help.means} Что делать: ${help.todo}`; }
    }
    return { who, text, ok: r.ok !== false, help, kindRu: KIND_RU[r.kind] || r.kind, roleRu: role };
  }

  // CSV для Excel: «;», кавычки удваиваются, ячейка не может начинаться с =, +, -, @ (иначе Excel выполнит её как формулу)
  const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  function toCsv(rows) {
    const head = ['Время', 'Тип', 'Роль', 'Кто', 'Группа', 'Событие', 'Предмет', 'Студент', 'Дата', 'Результат', 'Пояснение'];
    const lines = rows.map((r) => { const e = explain(r); return [r.at, e.kindRu, e.roleRu, r.actor ? r.actor_name : '', r.group_name || '', ACTION[r.action] || r.action, r.subject || '', r.target || '', r.on_date || '', e.ok ? 'Успешно' : 'Ошибка', e.text].map(cell).join(';'); });
    return [head.map(cell).join(';')].concat(lines).join('\r\n');
  }

  const LE = { ROLE_RU, KIND_RU, ACTION, errHelp, explain, toCsv };
  root.LogExplain = LE;
  if (typeof module !== 'undefined' && module.exports) module.exports = LE;
})(typeof window !== 'undefined' ? window : globalThis);
