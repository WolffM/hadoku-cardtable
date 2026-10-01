"""mtgtop8 deck lists (.dec export), cached on disk outside the repo so a re-run never
re-fetches. Parses 'N [SET] Name' and 'SB: N [SET] Name' lines."""
import os, re, time, urllib.request

CACHE = '/tmp/claude-1000/deck-cache'
UA = 'hadoku-cardtable/0.1 (deck library selection)'
LINE = re.compile(r'^(?:(SB):\s*)?(\d+)\s+\[([A-Za-z0-9]+)\]\s+(\S.*)$')

def fetch(deck_id):
    os.makedirs(CACHE, exist_ok=True)
    path = f'{CACHE}/{deck_id}.dec'
    if not os.path.exists(path):
        req = urllib.request.Request(f'https://www.mtgtop8.com/dec?d={deck_id}&f=ST', headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=40) as r:
            open(path, 'w', encoding='utf-8').write(r.read().decode('utf-8', 'replace'))
        time.sleep(0.4)
    return open(path, encoding='utf-8').read()

def parse(text):
    main, side = [], []
    for raw in text.splitlines():
        t = raw.strip()
        if not t or t.startswith('//'):
            continue
        m = LINE.match(t)
        if not m:
            continue
        sb, n, st, name = m.groups()
        (side if sb else main).append((int(n), st.upper(), name.strip()))
    return main, side

def get(deck_id):
    return parse(fetch(deck_id))

if __name__ == '__main__':
    m, s = get(212091)
    print(sum(n for n, _, _ in m), 'main', sum(n for n, _, _ in s), 'side', m[:2])
