// Кто администратор: вошедший студент, у которого в списке группы (journal_private) стоит isAdmin.
// Тот же флаг рисует значок «Администратор журнала»; менять список может только админ (journal-save).
import { admin, loadStudents } from './common.ts';

export async function jwtAdmin(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user) return null;
  const { data: p } = await admin.from('profiles').select('student_id').eq('user_id', auth.user.id).maybeSingle();
  if (!p?.student_id) return null;
  const s = (await loadStudents()).find((x) => x.id === p.student_id);
  return s?.isAdmin === true ? p.student_id : null;
}
