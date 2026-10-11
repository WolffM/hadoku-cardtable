"""Candidate decks per era from mtgtop8's search: every deck from a
competitive-level event (Pro, Major, Competitive; not the online dailies) inside the
era's window, for any of the three formats (`--format ST|MO|LE` — mtgtop8's own codes,
verified directly against the site: f=ST is "Standard events", f=MO "Modern events",
f=LE "Legacy events"). Writes candidates-<year>.json for ST (wave 34's name, kept),
candidates-modern-<year>.json / candidates-legacy-<year>.json for the other two, under
`eras.CACHE_DIR` (`eras.py`'s naming helpers). Shared cache across all three lanes/formats —
never per-lane. Polite: one request every 0.5 s, never parallel; stop crawling at the
first sign of throttling (HTTP 429/503, repeated timeouts) rather than retrying."""
import html, json, os, re, sys, time, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from eras import eras, cache_path, CACHE_DIR

UA = 'hadoku-cardtable/0.1 (deck library selection; contact: repo owner)'

def post(fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request('https://www.mtgtop8.com/search', data=data, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('latin-1')

def dmy(iso, minus_one=False):
    import datetime
    d = datetime.date.fromisoformat(iso)
    if minus_one: d -= datetime.timedelta(days=1)
    return d.strftime('%d/%m/%Y')

def crawl(era, fmt='ST', levels='PMC'):
    out, page, total = [], 1, None
    while True:
        f = {'format': fmt, 'date_start': dmy(era['season_start']), 'date_end': dmy(era['end'], True), 'MD_check': '1', 'current_page': str(page)}
        for L in levels: f[f'compet_check[{L}]'] = '1'
        h = post(f)
        if total is None:
            m = re.search(r'([\d,]+)\s*(?:decks|results)', h)
            total = int(m.group(1).replace(',', '')) if m else 0
        rows = re.findall(r'<tr[^>]*class=hover_tr[^>]*>(.*?)</tr>', h, re.S)
        got = 0
        for r in rows:
            m = re.search(rf'<a href=event\?e=(\d+)&d=(\d+)&f={fmt}>([^<]*)</a></td>\s*<td class=G12><a[^>]*>([^<]*)</a></td>\s*<td class=S12>[^<]*</td>\s*<td class=S11><a href=event\?e=\d+&f={fmt}>([^<]*)</a></td>\s*<td align=center>((?:<img[^>]*>)*)</td>\s*<td class=S12 align=center>([^<]*)</td>\s*<td class=S11>([^<]*)</td>', r)
            if not m: continue
            e, d, arch, player, event, stars, rank, date = m.groups()
            dd, mm, yy = date.split('/')
            out.append({'deck': int(d), 'event': int(e), 'archetype': html.unescape(arch).strip(), 'player': html.unescape(player).strip(),
                        'event_name': re.sub(r'\s+', ' ', html.unescape(event)).strip(), 'stars': stars.count('star'),
                        'rank': rank.strip(), 'date': f'20{yy}-{mm}-{dd}', 'summer': f'20{yy}-{mm}-{dd}' >= era['start']})
            got += 1
        if got == 0 or len(out) >= total or page > 80: break
        page += 1; time.sleep(0.5)
    return total, out

if __name__ == '__main__':
    argv = sys.argv[1:]
    fmt = 'ST'
    if '--format' in argv: fmt = argv[argv.index('--format') + 1]
    # `--levels PMCR` adds mtgtop8's Regular events (local tournaments) for an era whose
    # competitive events hold too few distinct decks — the operator, 2026-10-10: "i'm happy
    # to take a bad set of 24 and then weed out a handful of weak ones per era". They carry
    # the fewest stars, so `select_decks.strength` ranks them below every competitive finish.
    levels = argv[argv.index('--levels') + 1] if '--levels' in argv else 'PMC'
    years = [int(a) for a in argv if a.isdigit()]
    os.makedirs(CACHE_DIR, exist_ok=True)
    for era in eras(fmt):
        if years and era['year'] not in years: continue
        t, rows = crawl(era, fmt, levels)
        json.dump({'era': era, 'levels': levels, 'total': t, 'decks': rows}, open(cache_path(fmt, era['year']), 'w'), indent=1)
        evs = {(r['event'], r['event_name'], r['stars']) for r in rows}
        print(era['year'], era['format'], 'reported', t, 'parsed', len(rows), 'events', len(evs), flush=True)
        time.sleep(0.5)
