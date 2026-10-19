# -*- coding: utf-8 -*-
"""Подготовка словаря и рейтингов близости для игры «Ассоциации».

Запускается только на компьютере администратора. В репозиторий попадает
сам скрипт, список загаданных слов и стоп-лист; модель и готовые рейтинги —
нет (они тяжёлые и лежат в приватном бакете Supabase).

Шаги:
    python tools/assoc/prepare.py dict     — собрать словарь существительных
    python tools/assoc/prepare.py ranks    — посчитать рейтинги для слов из targets.txt
    python tools/assoc/prepare.py check     — проверить готовые файлы

Что откуда:
    Navec (MIT, natasha/navec) — статические эмбеддинги русских слов, 50 МБ,
        500 тыс. слов, 300 измерений. Модель кладётся в tools/assoc/model/.
    pymorphy3 (MIT) со словарями pymorphy3-dicts-ru — данные словарей под
        Creative Commons Attribution-Share Alike 3.0 (OpenCorpora).
    wordfreq (MIT) — частотность слов, по ней отбираем самые ходовые.
"""

import gzip
import hashlib
import json
import os
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'model', 'navec_hudlit_v1_12B_500K_300d_100q.tar')
DICT_PATH = os.path.join(HERE, 'dict.txt')
TARGETS_PATH = os.path.join(HERE, 'targets.txt')
STOP_PATH = os.path.join(HERE, 'stopwords.txt')
OUT_DIR = os.path.join(HERE, 'out')

DICT_SIZE = 40000          # столько существительных оставляем в словаре
FREQ_POOL = 200000         # из скольких частых слов отбираем
MIN_LEN = 3

# Пометки, по которым слово в словарь не идёт: имена, фамилии, отчества,
# географические названия, организации, торговые марки и сокращения.
BAD_GRAMMEMES = {'Name', 'Surn', 'Patr', 'Geox', 'Orgn', 'Trad', 'Abbr', 'Infr', 'Slng', 'Arch', 'Erro'}


def norm(word):
    """ё → е, нижний регистр, без краёв."""
    return unicodedata.normalize('NFC', str(word)).strip().lower().replace('ё', 'е')


def key_of(word):
    """Имя файла в бакете. Storage не принимает кириллицу в ключах, поэтому
    имя — это sha-256 от нормализованного слова. Edge Function считает ровно
    такой же хеш, а читаемый список слов лежит рядом в index.json."""
    return hashlib.sha256(norm(word).encode('utf-8')).hexdigest()[:32]


def is_cyrillic(word):
    return bool(word) and all('а' <= c <= 'я' or c == '-' for c in word)


def load_stop():
    """Стоп-лист: грубые и обидные слова. Сравниваем по началу слова,
    чтобы отсечь и формы, и однокоренные."""
    if not os.path.exists(STOP_PATH):
        return []
    with open(STOP_PATH, encoding='utf-8-sig') as f:
        return [norm(line) for line in f if line.strip() and not line.startswith('#')]


def stopped(word, roots):
    return any(word.startswith(root) for root in roots)


def build_dict():
    from navec import Navec
    from wordfreq import top_n_list
    import pymorphy3

    navec = Navec.load(MODEL)
    morph = pymorphy3.MorphAnalyzer()
    roots = load_stop()
    print('модель:', len(navec.vocab.words), 'слов; стоп-лист:', len(roots), 'корней')

    # Сначала самые частые слова (их список у wordfreq конечный — 200 тысяч),
    # потом остальные существительные из модели по алфавиту: так в словаре
    # оказываются и ходовые слова, и редкие, которые игрок может ввести.
    source = list(top_n_list('ru', FREQ_POOL)) + list(navec.vocab.words)

    seen = set()
    out = []
    for raw in source:
        word = norm(raw)
        if len(word) < MIN_LEN or not is_cyrillic(word) or word in seen:
            continue
        if stopped(word, roots):
            continue
        # Слово должно быть и в модели: без вектора рейтинг не посчитать
        if word not in navec:
            continue

        # Самый вероятный разбор должен быть существительным: иначе в словарь
        # попадают слова, которые существительные лишь на бумаге — «тут»,
        # «перед», «спасибо», «весь».
        if 'NOUN' not in morph.parse(raw)[0].tag:
            continue
        # Слово годится, если хоть один его разбор — существительное в
        # начальной форме. Брать только самый вероятный разбор нельзя: у
        # неодушевлённых слов винительный падеж совпадает с именительным, и
        # pymorphy для «стол» и «окно» первым отдаёт именно винительный.
        if not any(
            'NOUN' in p.tag
            and norm(p.normal_form) == word
            and not any(g in p.tag for g in BAD_GRAMMEMES)
            for p in morph.parse(raw)
        ):
            continue

        seen.add(word)
        out.append(word)
        if len(out) >= DICT_SIZE:
            break

    with open(DICT_PATH, 'w', encoding='utf-8-sig', newline='\n') as f:
        f.write('\n'.join(out) + '\n')
    print('словарь:', len(out), 'слов →', DICT_PATH)
    print('первые 20:', ', '.join(out[:20]))


def read_dict():
    with open(DICT_PATH, encoding='utf-8-sig') as f:
        return [norm(line) for line in f if line.strip()]


def read_targets():
    with open(TARGETS_PATH, encoding='utf-8-sig') as f:
        return [norm(line) for line in f if line.strip() and not line.startswith('#')]


def build_ranks():
    """Для каждого загаданного слова — все слова словаря по убыванию близости.

    Формат файла: { "word": "<загаданное>", "words": [...по местам...] }.
    Место слова — его индекс + 1, поэтому само загаданное слово стоит первым.
    """
    import numpy as np
    from navec import Navec

    navec = Navec.load(MODEL)
    words = read_dict()
    targets = read_targets()
    os.makedirs(OUT_DIR, exist_ok=True)

    done = []
    matrix = np.stack([navec[w] for w in words]).astype('float32')
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    index = {w: i for i, w in enumerate(words)}

    for n, target in enumerate(targets, 1):
        if target not in index:
            print('ПРОПУЩЕНО (нет в словаре):', target)
            continue
        vec = matrix[index[target]]
        sims = matrix @ vec
        order = np.argsort(-sims, kind='stable')
        ranked = [words[i] for i in order]
        assert ranked[0] == target, target + ': загаданное слово должно быть первым'

        path = os.path.join(OUT_DIR, key_of(target) + '.json.gz')
        with gzip.open(path, 'wt', encoding='utf-8') as f:
            json.dump({'word': target, 'words': ranked}, f, ensure_ascii=False)
        size = os.path.getsize(path) / 1024
        done.append(target)
        print(f'{n:3d}/{len(targets)}  {target:<16} {size:6.0f} КБ  ближайшие: ' +
              ', '.join(ranked[1:6]))

    # Список слов: по нему админка показывает, что можно загадать, не
    # перебирая бакет и не раскрывая имена файлов
    with gzip.open(os.path.join(OUT_DIR, 'index.json.gz'), 'wt', encoding='utf-8') as f:
        json.dump({'words': sorted(done)}, f, ensure_ascii=False)
    print('индекс:', len(done), 'слов')


def check():
    words = read_dict()
    targets = read_targets()
    roots = load_stop()
    print('словарь:', len(words), 'слов, уникальных:', len(set(words)))
    print('загаданных слов:', len(targets))
    missing = [t for t in targets if t not in set(words)]
    print('нет в словаре:', missing if missing else 'все на месте')
    bad = [w for w in words if stopped(w, roots)]
    print('стоп-слов в словаре:', bad if bad else 'нет')
    if os.path.isdir(OUT_DIR):
        files = sorted(os.listdir(OUT_DIR))
        total = sum(os.path.getsize(os.path.join(OUT_DIR, f)) for f in files) / 1048576
        print('готовых рейтингов:', len(files), f'({total:.1f} МБ)')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    command = sys.argv[1] if len(sys.argv) > 1 else 'check'
    if command == 'dict':
        build_dict()
    elif command == 'ranks':
        build_ranks()
    else:
        check()
