// Общее для Edge Functions журнала: админ-клиент (секретный ключ только из окружения функции),
// CORS, ответы, правила логина и пароля.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

export const EMAIL_DOMAIN = 'students.journal-24dmm2.app';
export const LOGIN_RE = /^[a-z0-9_.]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys.default) return keys.default;
  } catch (_) { /* старый формат окружения */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

export const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const loginToEmail = (login: string) => `${login}@${EMAIL_DOMAIN}`;
export const normLogin = (v: unknown) => String(v ?? '').trim().toLowerCase();
