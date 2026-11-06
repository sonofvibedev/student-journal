// Серверные ошибки в client_events (source='server'): их видит сисадмин в разделе «Логи» и в сводке.
// Не бросает: журнал ошибок не должен ронять функцию, которая и так уже в ошибке. Если сама запись не удалась (база лежит), молчим.
// Передавайте коды и названия, а не тексты пользователей; токены и длинные ключи вырезаются здесь же (stripSecrets) на всякий случай.
import { admin } from './common.ts';
import { cleanField, LIM } from './ops-text.ts';

export async function logServer(name: string, message: string, detail?: string): Promise<void> {
  try {
    await admin.from('client_events').insert({
      source: 'server', kind: 'error',
      name: cleanField(name, LIM.name), message: cleanField(message, LIM.message),
      detail: detail ? cleanField(detail, LIM.detail) : null,
    });
  } catch (_) { /* см. выше */ }
}
