"""Candidate decks per era from mtgtop8's search: every Standard deck from a
competitive-level event (Pro, Major, Competitive; not the online dailies) inside the
era's window. Writes cache/candidates-<year>.json (gitignored; re-crawl to regenerate). Polite: one request every 0.5 s."""
import html, json, os, re, sys, time, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from eras import eras

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

def crawl(era, levels='PMC'):
    out, page, total = [], 1, None
    while True:
        f = {'format': 'ST', 'date_start': dmy(era['season_start']), 'date_end': dmy(era['end'], True), 'MD_check': '1', 'current_page': str(page)}
        for L in levels: f[f'compet_check[{L}]'] = '1'
        h = post(f)
        if total is None:
            m = re.search(r'([\d,]+)\s*(?:decks|results)', h)
            total = int(m.group(1).replace(',', '')) if m else 0
        rows = re.findall(r'<tr[^>]*class=hover_tr[^>]*>(.*?)</tr>', h, re.S)
        got = 0
        for r in rows:
            m = re.search(r'<a href=event\?e=(\d+)&d=(\d+)&f=ST>([^<]*)</a></td>\s*<td class=G12><a[^>]*>([^<]*)</a></td>\s*<td class=S12>[^<]*</td>\s*<td class=S11><a href=event\?e=\d+&f=ST>([^<]*)</a></td>\s*<td align=center>((?:<img[^>]*>)*)</td>\s*<td class=S12 align=center>([^<]*)</td>\s*<td class=S11>([^<]*)</td>', r)
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
    os.makedirs('cache', exist_ok=True)
    for era in eras():
        t, rows = crawl(era)
        json.dump({'era': era, 'total': t, 'decks': rows}, open(f'cache/candidates-{era["year"]}.json', 'w'), indent=1)
        evs = {(r['event'], r['event_name'], r['stars']) for r in rows}
        print(era['year'], era['format'], 'reported', t, 'parsed', len(rows), 'events', len(evs), flush=True)
        time.sleep(0.5)
