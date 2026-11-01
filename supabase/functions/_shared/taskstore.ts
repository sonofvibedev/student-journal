// Домашка и дедлайны: источник правды — таблица tasks. data.json в GitHub — публичное зеркало:
// его читают гости сайта, а после каждой записи сервер пересобирает его из таблицы.
// Пересборка целиком, поэтому конфликт sha (409) лечится повтором и ничего не теряет.
import { Buffer } from 'node:buffer';
import { admin } from './common.ts';
import { diffTasks, type Lists, type Ops, type Rec } from './taskdiff.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
const GH_TOKEN = Deno.env.get('GITHUB_TOKEN');
const GH_REPO = Deno.env.get('GITHUB_REPO') ?? 'sonofvibedev/student-journal';
const GH_BRANCH = Deno.env.get('GITHUB_BRANCH') ?? 'main';

// ---------- Таблица tasks ----------
export async function loadLists(): Promise<Lists> {
  const { data, error } = await admin.from('tasks').select('kind, rec').order('seq');
  if (error) throw new Error('tasks_read');
  const rows = (data ?? []) as Array<{ kind: string; rec: Rec }>;
  return {
    homework: rows.filter((r) => r.kind === 'homework').map((r) => r.rec),
    deadlines: rows.filter((r) => r.kind === 'deadline').map((r) => r.rec),
  };
}

export async function applyOps(ops: Ops) {
  if (ops.upserts.length) {
    const now = new Date().toISOString();
    const { error } = await admin.from('tasks').upsert(
      ops.upserts.map((u) => ({ id: u.rec.id, kind: u.kind, rec: u.rec, updated_at: now })), { onConflict: 'id' });
    if (error) throw new Error('tasks_write');
  }
  if (ops.deletes.length) {
    const { error } = await admin.from('tasks').delete().in('id', ops.deletes);
    if (error) throw new Error('tasks_write');
  }
}

// ---------- Зеркало: data.json в GitHub ----------
const ghUrl = `https://api.github.com/repos/${GH_REPO}/contents/data.json`;
const ghHeaders = () => ({
  Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json',
  'User-Agent': 'journal-24dmm2-bot', 'X-GitHub-Api-Version': '2022-11-28',
});

export async function ghRead(): Promise<{ data: Any; sha: string }> {
  if (!GH_TOKEN) throw new Error('github_not_configured');
  const res = await fetch(`${ghUrl}?ref=${encodeURIComponent(GH_BRANCH)}`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`github_read_${res.status}`);
  const j = await res.json();
  const text = Buffer.from(String(j.content ?? ''), 'base64').toString('utf8').replace(/^﻿/, '');
  return { data: JSON.parse(text), sha: j.sha };
}

// Пересобрать data.json: задачи — из таблицы, patch (предметы, преподаватели, объявления) — от админки.
// true — файл обновлён, false — менять нечего. Исключение — GitHub не ответил за все попытки.
export async function syncMirror(message: string, patch: Record<string, unknown> = {}): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ data, sha }, lists] = await Promise.all([ghRead(), loadLists()]);
    const next = { ...data, ...patch, homework: lists.homework, deadlines: lists.deadlines };
    const same = (a: Any) => JSON.stringify({ ...a, lastUpdated: 0 });
    if (same(next) === same(data)) return false;
    next.lastUpdated = new Date().toISOString();
    const res = await fetch(ghUrl, {
      method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message, branch: GH_BRANCH, sha,
        content: Buffer.from(JSON.stringify(next, null, 2), 'utf8').toString('base64'),
      }),
    });
    if (res.ok) return true;
    if (res.status !== 409 && res.status !== 422) throw new Error(`github_write_${res.status}`);
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));   // кто-то успел раньше: читаем заново
  }
  throw new Error('github_conflict');
}

// Зеркало вторично: таблица уже обновлена, так что сбой GitHub не отменяет запись. Следующая запись догонит.
export async function syncMirrorQuietly(message: string, patch: Record<string, unknown> = {}): Promise<boolean> {
  try { await syncMirror(message, patch); return true; }
  catch (e) { console.error('mirror', e instanceof Error ? e.message.slice(0, 40) : 'unknown'); return false; }
}

// Прочитать задачи → изменить в памяти → записать в таблицу только разницу → обновить зеркало.
// mutate вернёт null, если менять нечего.
export async function updateData<T>(mutate: (data: Any) => { result: T; message: string } | null): Promise<T | null> {
  const before = await loadLists();
  const data: Any = JSON.parse(JSON.stringify(before));
  const out = mutate(data);
  if (!out) { await syncMirrorQuietly('Обновлена копия data.json'); return null; }   // повтор после обрыва: заодно чиним зеркало
  await applyOps(diffTasks(before, data));
  await syncMirrorQuietly(out.message);
  return out.result;
}
