"""mtgtop8 deck lists (.dec export), cached on disk outside the repo so a re-run never
re-fetches. Parses 'N [SET] Name' and 'SB: N [SET] Name' lines.

The cache is keyed by deck id ALONE (not by format): mtgtop8 deck ids are
global, so the same cached export answers for whichever format asked for it,
and the cache is intentionally SHARED across all three lanes/formats this
wave (crawl.py's own header says the same) — never give it a per-lane path.
`f=` in the export URL is only a filename hint on mtgtop8's side; it does not
change which deck is returned, so varying it does not require widening the
cache key."""
import os, re, time, urllib.request

CACHE = os.path.expanduser('~/.cache/cardtable-deck-selection/deck-cache')
UA = 'hadoku-cardtable/0.1 (deck library selection)'
# The set may be empty: mtgtop8 writes `2 [] Unknown Card` for a card it could not identify,
# and skipping that line made a 58-card list read as complete and legal.
LINE = re.compile(r'^(?:(SB):\s*)?(\d+)\s+\[([A-Za-z0-9]*)\]\s+(\S.*)$')

def fetch(deck_id, fmt='ST'):
    os.makedirs(CACHE, exist_ok=True)
    path = f'{CACHE}/{deck_id}.dec'
    if not os.path.exists(path):
        req = urllib.request.Request(f'https://www.mtgtop8.com/dec?d={deck_id}&f={fmt}', headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=40) as r:
            raw = r.read()
            # mtgtop8's export is Latin-1: decoding it as UTF-8 turned `Jötun Grunt` into
            # `J\ufffdtun Grunt`, a card no corpus has.
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError:
                text = raw.decode('cp1252')
            open(path, 'w', encoding='utf-8').write(text)
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

def get(deck_id, fmt='ST'):
    return parse(fetch(deck_id, fmt))

if __name__ == '__main__':
    m, s = get(212091)
    print(sum(n for n, _, _ in m), 'main', sum(n for n, _, _ in s), 'side', m[:2])
