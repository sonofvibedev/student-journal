// Код сброса пароля: 10 знаков без 0/O/1/I/L, показывается как ABCDE-23456; в базе только sha-256 от кода без дефиса.
// Без Deno и без клиента базы: файл читает и node-тест (tests/unit/password-reset.mjs).
import { genPassword } from './ops-text.ts';

export const RESET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RESET_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;

// Ввод студента: регистр, пробелы и дефисы не важны
export const normResetCode = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');

// raw — для хэша, shown — для показа старосте
export function newResetCode(): { raw: string; shown: string } {
  const raw = genPassword(10, RESET_ALPHABET);
  return { raw, shown: `${raw.slice(0, 5)}-${raw.slice(5)}` };
}
