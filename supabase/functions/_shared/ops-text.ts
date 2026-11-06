// Чистая логика утилиты сисадмина: очистка текста от секретов, обрезка, доступность и перцентили, пороги алерта,
// текст ежедневной сводки, пути резервных копий, пароль. Без импортов и без Deno: файл читает и node-тест (tests/unit/ops.mjs).

// Ограничения столбцов client_events (те же числа в миграции): обрезаем заранее, чтобы вставка не падала на check
export const LIM = { name: 120, message: 300, detail: 1000, ua: 120 } as const;

export const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);

// Вырезаем всё, что похоже на секрет или личные данные. Порядок важен: сначала адреса и пары «ключ=значение»,
// потом «голые» длинные строки. Токен бота лежит в адресе запроса к Telegram, а текст ошибки fetch этот адрес содержит.
export function stripSecrets(input: unknown): string {
  return String(input ?? '')
    .replace(/(https?:\/\/[^\s?#"'<>]*)[?#]\S*/gi, '$1')                              // строка запроса и фрагмент в URL
    .replace(/(\.(?:html|js|mjs|json|css)|\/)[?#][^\s"'<>]*/gi, '$1')                   // то же для относительных адресов и файлов
    .replace(/\bbot\d{5,}:[\w-]{20,}/gi, 'bot[скрыто]')                                 // адрес Telegram Bot API с токеном
    .replace(/\bBearer\s+\S+/gi, 'Bearer [скрыто]')
    .replace(/\b(access_token|refresh_token|id_token|token|apikey|api_key|password|secret)(["']?\s*[:=]\s*["']?)[^\s&"',;]+/gi, '$1$2[скрыто]')
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[jwt]')                              // JWT
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[hex]')                                          // хэши, ключи в hex
    .replace(/(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{32,}={0,2}/g, '[скрыто]');          // base64-подобное; обязательна цифра, чтобы не резать длинные пути и имена
}

// Поле события: очистить и обрезать (сначала очистка: обрезка посреди токена оставила бы его хвост)
export const cleanField = (v: unknown, n: number) => clip(stripSecrets(v), n);

// ---------- Доступность и время ответа ----------
export const availabilityPct = (pings: { ok?: boolean | null }[]): number | null =>
  pings.length ? Math.round((pings.filter((p) => p.ok === true).length / pings.length) * 1000) / 10 : null;

// Перцентиль «ближайший ранг» по неупорядоченному списку; пустой список — null
export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

// Топ строк по частоте: [{name, count}], при равенстве по имени (порядок предсказуем)
export function topCounts(names: (string | null | undefined)[], limit: number): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const n of names) { const k = n || '(без названия)'; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}

// ---------- Пороги алерта ----------
// Причины сбоя числами, без текстов ошибок. Пустой список = всё в порядке.
export function alertReasons(
  clientErrors: number, pings: { ok?: boolean | null }[],
  lim: { errors: number; availabilityMin: number; minPings: number },
): string[] {
  const out: string[] = [];
  if (clientErrors >= lim.errors) out.push(`Ошибок браузера за 10 минут: ${clientErrors}`);
  const a = availabilityPct(pings);
  if (a !== null && pings.length >= lim.minPings && a < lim.availabilityMin) out.push(`Доступность за 30 минут: ${a}% (проверок: ${pings.length})`);
  return out;
}

// Прошло ли не меньше minMs с отметки (нет или битая отметка = прошло)
export function dueSince(iso: unknown, now: number, minMs: number): boolean {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return !Number.isFinite(t) || now - t >= minMs;
}

// ---------- Ежедневная сводка ----------
export type DigestInput = {
  hours: number;
  availability_pct: number | null; pings: number; resp_p95_ms: number | null;
  client_errors: number; server_errors: number;
  top_errors: { name: string; count: number }[];
  import_failures: { name: string; status: string }[];
  pending_requests: number;
  backup_last: { at: string; status: string; size_bytes?: number | null } | null;
};

const mb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

// Только числа, имена событий и названия групп: ни текстов ошибок, ни ответов bseu.by
export function buildDigest(d: DigestInput): string {
  const L: string[] = [];
  L.push(`За ${d.hours === 24 ? 'сутки' : `${d.hours} ч`}:`);
  L.push(d.availability_pct === null ? 'Доступность: нет данных' : `Доступность: ${d.availability_pct}% (проверок: ${d.pings})`);
  L.push(d.resp_p95_ms === null ? 'Ответ базы p95: нет данных' : `Ответ базы p95: ${d.resp_p95_ms} мс`);
  L.push(`Ошибки: браузер ${d.client_errors}, сервер ${d.server_errors}`);
  const top = d.top_errors.slice(0, 3);
  if (top.length) { L.push('Частые ошибки:'); for (const t of top) L.push(`• ${t.name}: ${t.count}`); }
  L.push(d.import_failures.length
    ? `Сбои импорта расписания: ${d.import_failures.map((f) => `${f.name} (${f.status})`).join(', ')}`
    : 'Сбоев импорта расписания нет');
  L.push(`Заявок на рассмотрении: ${d.pending_requests}`);
  const b = d.backup_last;
  L.push(!b ? 'Резервная копия: ещё не было'
    : `Резервная копия: ${b.status === 'ok' ? 'успешно' : 'СБОЙ'}, ${b.at.slice(0, 16).replace('T', ' ')} UTC${b.status === 'ok' && b.size_bytes ? `, ${mb(b.size_bytes)}` : ''}`);
  return L.join('\n');
}

// ---------- Резервные копии ----------
// <YYYY-MM-DD>/<HHMMSS>-<kind>.json.gz по UTC
export function backupPath(d: Date, kind: 'nightly' | 'manual'): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)}/${iso.slice(11, 19).replace(/:/g, '')}-${kind}.json.gz`;
}
export const RETENTION_DAYS = 14;

// ---------- Почта и пароль ----------
export const validEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);

// Без похожих знаков: нет I, O, i, l, o, 0, 1
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export const PASSWORD_LEN = 16;

// Знаки по равномерному распределению: байты выше кратного длине алфавита отбрасываем (иначе модуль смещает выбор)
export function genPassword(len = PASSWORD_LEN, alphabet = PASSWORD_ALPHABET): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < limit && out.length < len) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
