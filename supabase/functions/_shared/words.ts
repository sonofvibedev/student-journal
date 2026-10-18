// Общее для «Ассоциаций»: дата по Минску, доступ администратора и выдача
// значков. Лежит отдельно, потому что этим пользуются обе функции —
// word-of-day (игра) и word-admin (админ-панель).
import { admin } from './common.ts';

// Сутки считаются по Минску, как и напоминания: иначе «Слово дня» менялось бы
// у студентов в разное время, а в три часа ночи наступал бы следующий день.
export function minskDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

// Кто такой администратор: тот, у кого есть токен GitHub с правом записи в
// репозиторий журнала. Это ровно тот же токен, которым админка сохраняет
// data.json, поэтому отдельного пароля не нужно. Токен нигде не хранится и
// не пишется в журнал — функция только спрашивает о нём GitHub.
const GITHUB_REPO = Deno.env.get('GITHUB_REPO') ?? 'sonofvibedev/student-journal';

export async function isRepoAdmin(token: string): Promise<boolean> {
  const clean = String(token ?? '').trim();
  if (!clean || clean.length > 255) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: {
        Authorization: `Bearer ${clean}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'journal-24dmm2',
      },
    });
    if (!res.ok) return false;
    const repo = await res.json();
    return !!repo?.permissions?.push;
  } catch (_) {
    return false;
  }
}

// Записывает значки и возвращает коды тех, что выданы впервые. Повтор не
// страшен: уникальный индекс не даст второй такой строки, 23505 означает
// «уже есть» и ошибкой не считается.
export async function grantBadges(studentId: string, codes: string[]): Promise<string[]> {
  if (!codes.length) return [];
  const { data: had } = await admin
    .from('student_achievements').select('code')
    .eq('student_id', studentId).in('code', codes);
  const have = new Set((had ?? []).map((r: { code: string }) => r.code));
  const fresh = codes.filter((c) => !have.has(c));
  if (!fresh.length) return [];

  const now = new Date().toISOString();
  const { error } = await admin.from('student_achievements').insert(
    fresh.map((code) => ({
      student_id: studentId, code, period: '', semester: gameSemester(now), earned_at: now,
    })),
  );
  if (error && error.code !== '23505') return [];
  return fresh;
}

// Семестр в том же виде, что и в study-days.json: fall-2026 или spring-2026.
// Сентябрь — январь считаем осенним, остальное весенним.
export function gameSemester(iso: string): string {
  const d = new Date(iso);
  const m = d.getMonth();                 // 0 — январь
  const fall = m >= 8 || m === 0;         // сентябрь…декабрь и январь
  const year = m === 0 ? d.getFullYear() - 1 : d.getFullYear();
  return fall ? `fall-${year}` : `spring-${d.getFullYear()}`;
}
