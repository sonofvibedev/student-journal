// Старая админка 1.x закрыта: студенты и пропуски 24ДММ-2 ведутся в таблицах 2.0 (кабинет старосты, headman.html).
// Функция раньше перезаписывала journal_private целиком и стёрла бы данные кабинета, поэтому теперь всегда отвечает 410.
// journal_private остаётся зеркалом для чтения: его обновляют триггеры (docs/stage2-db.md п. 6).
import { json, cors } from '../_shared/common.ts';

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  return json({ error: 'legacy_admin_closed' }, 410);
});
