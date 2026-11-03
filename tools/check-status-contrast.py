# -*- coding: utf-8 -*-
"""Контраст статусов и акцента по всем гаммам, светлая и тёмная схема."""
import re, sys

src = open('app.css', 'rb').read().decode('utf-8-sig').replace(chr(13), '')

def hex2rgb(h):
    h = h.strip().lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def rgb_of(s):
    s = s.strip().rstrip(';').strip()
    if s.startswith('#'):
        return hex2rgb(s)
    return tuple(int(x) for x in s.split(','))

# --- гаммы ---
blocks = re.findall(r'\[data-gamma="(\w+)"\]\s*\{(.*?)\n\}', src, re.S)
gamma = {}
for name, body in blocks:
    d = dict(re.findall(r'(--[\w-]+):\s*([^;]+);', body))
    if name not in gamma:
        gamma[name] = {}
    gamma[name].update(d)
gamma['blue'] = gamma.get('blue', {})

# base statuses
base_block = re.search(r':root \{\n(  --status-hot-rgb.*?)\n\}', src, re.S).group(1)
light_block = re.search(r'\[data-bs-theme=light\] \{\n(  --status-hot-rgb.*?)\n\}', src, re.S).group(1)
STATUS_DARK = dict(re.findall(r'(--[\w-]+):\s*([^;]+);', base_block))
STATUS_LIGHT = dict(re.findall(r'(--[\w-]+):\s*([^;]+);', light_block))

# per-gamma status overrides
ov = re.findall(r'\[data-gamma="(\w+)"\](\[data-bs-theme=light\])?\s*\{\n((?:\s*--status[^}]*?))\}', src, re.S)
G_STATUS = {}
for name, light, body in ov:
    d = dict(re.findall(r'(--[\w-]+):\s*([^;]+);', body))
    if not d:
        continue
    G_STATUS.setdefault(name, {}).setdefault('light' if light else 'dark', {}).update(d)

def lum(c):
    def f(v):
        v = v / 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = [f(x) for x in c]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)

def over(fg, alpha, bg):
    return tuple(fg[i] * alpha + bg[i] * (1 - alpha) for i in range(3))

def hue(c):
    r, g, b = [x / 255.0 for x in c]
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if d == 0:
        return None
    if mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h * 60

FILL_A = {'dark': 0.12, 'light': 0.10}
fails = []
rows = []
for name in sorted(gamma):
    for scheme in ('dark', 'light'):
        p = 'g-d-' if scheme == 'dark' else 'g-l-'
        g = gamma[name]
        if not g.get('--' + p + 'accent'):
            continue
        accent = rgb_of(g['--' + p + 'accent'])
        page = rgb_of(g['--' + p + 'bg'])
        text = hex2rgb('#ffffff') if scheme == 'dark' else hex2rgb('#1c1c1e')
        st = dict(STATUS_DARK if scheme == 'dark' else STATUS_LIGHT)
        st.update(G_STATUS.get(name, {}).get(scheme, {}))
        for s in ('hot', 'soon', 'done', 'zachet', 'cert'):
            rgbv = rgb_of(st['--status-%s-rgb' % s])
            line = hex2rgb(st['--status-%s-text' % s])
            card = over(rgbv, FILL_A[scheme], page)
            pill = over(rgbv, 0.20, card)
            r_line = ratio(line, pill)          # текст таблетки
            r_text = ratio(text, card)          # текст карточки
            dh = None
            ha, hs = hue(accent), hue(line)
            if ha is not None and hs is not None:
                dh = min(abs(ha - hs), 360 - abs(ha - hs))
            rows.append((name, scheme, s, r_line, r_text, dh))
            if r_line < 4.5 or r_text < 4.5:
                fails.append((name, scheme, s, round(r_line, 2), round(r_text, 2)))

print('%-11s %-5s %-7s %6s %6s %6s' % ('гамма', 'схема', 'статус', 'текст', 'карт.', 'Δtone'))
for r in rows:
    mark = '' if r[3] >= 4.5 and r[4] >= 4.5 else '  <<< AA'
    print('%-11s %-5s %-7s %6.2f %6.2f %6s%s' % (r[0], r[1], r[2], r[3], r[4], ('%.0f' % r[5]) if r[5] is not None else '-', mark))
print()
print('Провалов AA: %d' % len(fails))
for f in fails:
    print('  ', f)
# близость статуса к акценту по тону
print()
print('Статусы ближе 45 град. к акценту:')
near = [r for r in rows if r[5] is not None and r[5] < 45]
for r in near:
    print('  %-11s %-5s %-7s Δ=%.0f' % (r[0], r[1], r[2], r[5]))
if not near:
    print('  нет')

# ===== Уведомления (.nt-*): тип -> статус, непрочитанное / прочитанное =====
# Фон карточки = surface-2 + заливка типа (unread: .10, read: .05).
# Проверяем: основной текст (unread) и вторичный (read, подпись) на карточке,
# пометку типа на плашке (.12 unread, .08 read).
INFO = {
    'dark': re.search(r':root \{ --status-info-rgb: ([\d, ]+); --status-info-line: (#\w+); --status-info-text: (#\w+); \}', src).groups(),
    'light': re.search(r'\[data-bs-theme=light\] \{ --status-info-rgb: ([\d, ]+); --status-info-line: (#\w+); --status-info-text: (#\w+); \}', src).groups(),
}
SECOND = {'dark': hex2rgb(re.search(r'--color-text-secondary:\s*(#\w+)', src).group(1)),
          'light': hex2rgb(re.findall(r'--color-text-secondary:\s*(#\w+)', src)[1])}
NT = {'success': 'done', 'warning': 'soon', 'error': 'hot', 'achievement': 'zachet', 'info': None}
nt_fails, nt_min = [], {}
for name in sorted(gamma):
    for scheme in ('dark', 'light'):
        p = 'g-d-' if scheme == 'dark' else 'g-l-'
        g = gamma[name]
        if not g.get('--' + p + 'surface-2'):
            continue
        surf = rgb_of(g['--' + p + 'surface-2'])
        text = hex2rgb('#ffffff') if scheme == 'dark' else hex2rgb('#1c1c1e')
        st = dict(STATUS_DARK if scheme == 'dark' else STATUS_LIGHT)
        st.update(G_STATUS.get(name, {}).get(scheme, {}))
        for t, s in NT.items():
            if s:
                rgbv, tc = rgb_of(st['--status-%s-rgb' % s]), hex2rgb(st['--status-%s-text' % s])
            else:
                rgbv, tc = rgb_of(INFO[scheme][0]), hex2rgb(INFO[scheme][2])
            for state, a_card, a_pill, body in (('unread', 0.10, 0.12, text), ('read', 0.05, 0.08, SECOND[scheme])):
                card = over(rgbv, a_card, surf)
                pill = over(rgbv, a_pill, card)
                for what, r in (('текст', ratio(body, card)), ('подпись', ratio(SECOND[scheme], card)), ('пометка', ratio(tc, pill))):
                    key = (scheme, t, state, what)
                    nt_min[key] = min(nt_min.get(key, 99), r)
                    if r < 4.5:
                        nt_fails.append((name, scheme, t, state, what, round(r, 2)))
print()
print('Уведомления: минимум по всем гаммам')
for k in sorted(nt_min):
    print('  %-5s %-11s %-7s %-8s %5.2f%s' % (k + (nt_min[k], '' if nt_min[k] >= 4.5 else '  <<< AA')))
print('Провалов AA в уведомлениях: %d' % len(nt_fails))
for f in nt_fails:
    print('  ', f)
