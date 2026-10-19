# -*- coding: utf-8 -*-
"""Заливка рейтингов «Ассоциаций» в приватный бакет Supabase Storage.

    $env:SUPABASE_SERVICE_KEY = "<секретный ключ проекта>"
    python tools/assoc/upload.py

Ключ берётся только из окружения: в коде и в репозитории его нет.
Бакет приватный, поэтому файлы читает лишь Edge Function под service_role.
"""

import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, 'out')

PROJECT_URL = os.environ.get('SUPABASE_URL', 'https://woiqekpuoddxixlrbvkp.supabase.co')
BUCKET = os.environ.get('ASSOC_BUCKET', 'assoc-ranks')


def request(method, path, data=None, content_type=None):
    key = os.environ.get('SUPABASE_SERVICE_KEY')
    if not key:
        sys.exit('Нет ключа: задайте SUPABASE_SERVICE_KEY в окружении')
    req = urllib.request.Request(PROJECT_URL + path, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + key)
    req.add_header('apikey', key)
    if content_type:
        req.add_header('Content-Type', content_type)
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, res.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    files = sorted(f for f in os.listdir(OUT_DIR) if f.endswith('.json.gz'))
    # Можно и через Supabase CLI одной командой:
    #   npx supabase storage cp -r tools/assoc/out ss:///assoc-ranks     #       --project-ref <ref> --experimental
    if not files:
        sys.exit('В out/ нет рейтингов — сначала запустите prepare.py ranks')

    ok = 0
    for n, name in enumerate(files, 1):
        with open(os.path.join(OUT_DIR, name), 'rb') as f:
            body = f.read()
        # upsert: повторная заливка заменяет файл, а не падает с ошибкой
        # Папка out/ и хеш-имена: Storage не принимает кириллицу в ключах,
        # а Edge Function считает такой же хеш от слова
        status, text = request(
            'POST', f'/storage/v1/object/{BUCKET}/out/{name}?upsert=true',
            data=body, content_type='application/gzip',
        )
        if status in (200, 201):
            ok += 1
            print(f'{n:3d}/{len(files)}  {name}  {len(body) / 1024:.0f} КБ')
        else:
            print(f'{n:3d}/{len(files)}  {name}  ОШИБКА {status}: {text[:200]}')
    print('залито файлов:', ok, 'из', len(files))


if __name__ == '__main__':
    main()
