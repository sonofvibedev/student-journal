// Что изменилось в списках задач: записи, которые надо вставить или обновить, и id, которые надо удалить.
// Чистая функция (тест: tools/test-tasks.js). Бот правит списки в памяти, а в таблицу tasks уходит только разница:
// две одновременные правки разных записей не мешают друг другу.
export type Rec = Record<string, unknown> & { id: string };
export type Lists = { homework: Rec[]; deadlines: Rec[] };
export type Kind = 'homework' | 'deadline';
export type Ops = { upserts: Array<{ kind: Kind; rec: Rec }>; deletes: string[] };

const KEYS: Array<[keyof Lists, Kind]> = [['homework', 'homework'], ['deadlines', 'deadline']];

export function diffTasks(before: Lists, after: Lists): Ops {
  const old = new Map<string, string>();
  KEYS.forEach(([k]) => (before[k] ?? []).forEach((r) => old.set(r.id, JSON.stringify(r))));
  const ops: Ops = { upserts: [], deletes: [] };
  const kept = new Set<string>();
  KEYS.forEach(([k, kind]) => (after[k] ?? []).forEach((rec) => {
    if (!rec || !rec.id) return;
    kept.add(rec.id);
    if (old.get(rec.id) !== JSON.stringify(rec)) ops.upserts.push({ kind, rec });
  }));
  old.forEach((_, id) => { if (!kept.has(id)) ops.deletes.push(id); });
  return ops;
}
