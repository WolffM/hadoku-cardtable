"""Pick the decks for each era by rule. Every rule is a constant below so it can be argued
with. Writes selections/selection-<year>.json; report.py turns those into the review doc.

  1. one deck per archetype (the one that went furthest, weighted by how big the event was)
  2. no near-duplicates (>= DUP_JACCARD of the same main-deck cards): the better finish stays
  3. legal in the era's Standard, from the cards (bans and sets from Forge's own format file)
  4. colour spread: all five colours played by roughly the same number of decks, with room to
     lean toward what was best
  5. style spread: floors for the rarest styles, a cap on the most common
"""
import json, math, os, random, sys
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(__file__))
import analyze, lists

N_DECKS = 12
LABELS_CONSIDERED = 55          # archetypes (best deck each) examined per era
TRIES_PER_LABEL = 4             # next-best deck of a label when the best is illegal
DUP_JACCARD = 0.70
STAR_W = {5: 1.25, 4: 1.05, 3: 0.85, 2: 0.65, 1: 0.45, 0: 0.25}
SUMMER_W, EARLIER_W = 1.0, 0.8  # decks from the summer window outrank the same finish earlier in the season
A_STRENGTH, B_COLOR, C_STYLE = 1.0, 1.0, 1.0
COLOR_TOLERANCE = 1             # how far a colour's deck count may sit from the mean before it costs anything
STYLE_FLOOR, STYLE_CAP = 2, 5
STYLES = ['aggro', 'midrange', 'control', 'combo']

def place_num(rank):
    m = __import__('re').match(r'\d+', rank or '')
    return int(m.group(0)) if m else 99

def strength(r):
    place_w = 1 / (1 + 0.5 * math.log2(max(1, place_num(r['rank']))))
    return STAR_W.get(r['stars'], 0.25) * place_w * (SUMMER_W if r['summer'] else EARLIER_W)

def objective(sel, items, style_target):
    s = sum(items[i]['s'] for i in sel) / max(1e-9, items[0]['s'] if False else 1)
    pres = Counter()
    for i in sel:
        for c in items[i]['f']['colors']:
            pres[c] += 1
    tot = sum(pres.values()); t = tot / 5
    cpen = sum(max(0, abs(pres[c] - t) - COLOR_TOLERANCE) ** 2 for c in 'WUBRG')
    sc = Counter(items[i]['style'] for i in sel)
    spen = 0.0
    for st in STYLES:
        n = sc[st]
        if style_target['has'][st]:
            spen += 3.0 * max(0, STYLE_FLOOR - n) ** 2
        spen += 2.0 * max(0, n - STYLE_CAP) ** 2
        spen += 0.5 * (n - style_target['t'][st]) ** 2
    return A_STRENGTH * s - B_COLOR * cpen - C_STYLE * spen

def search(items, style_target, n, restarts=120, seed=7):
    rng = random.Random(seed); idx = list(range(len(items)))
    best, bestv = None, -1e9
    top = sorted(idx, key=lambda i: -items[i]['s'])
    for r in range(restarts):
        sel = set(top[:n]) if r == 0 else set(rng.sample(top[:max(n + 6, 30)], n))
        v = objective(sel, items, style_target)
        improved = True
        while improved:
            improved = False
            for a in list(sel):
                for b in idx:
                    if b in sel: continue
                    cand = (sel - {a}) | {b}
                    cv = objective(cand, items, style_target)
                    if cv > v + 1e-9:
                        sel, v, improved = cand, cv, True
                        break
                if improved: break
        if v > bestv: best, bestv = set(sel), v
    return sorted(best, key=lambda i: -items[i]['s']), bestv

def run(era, overrides):
    import html
    d = json.load(open(f'cache/candidates-{era["year"]}.json'))['decks']
    for r in d:
        for k in ('archetype', 'player', 'event_name'): r[k] = html.unescape(r[k]).replace('\xa0', ' ').strip()
    by = defaultdict(list)
    for r in d:
        r['s'] = strength(r); by[r['archetype']].append(r)
    labels = sorted(by, key=lambda L: (-max(x['s'] for x in by[L]), -len(by[L])))[:LABELS_CONSIDERED]
    rejected, items = [], []
    for L in labels:
        tries = 0
        for r in sorted(by[L], key=lambda x: -x['s'])[:TRIES_PER_LABEL]:
            tries += 1
            main, side = lists.get(r['deck'])
            ill, unk = analyze.legality(main, side, era, set(era['banned']))
            if ill or unk:
                rejected.append({'archetype': L, 'deck': r['deck'], 'player': r['player'], 'why': (ill + [f'unknown card: {u}' for u in unk])[:3]})
                continue
            f = analyze.features(main)
            style, why = analyze.classify(L, f, overrides)
            items.append({**r, 'f': f, 'style': style, 'style_why': why, 'main': main, 'side': side, 'label_count': len(by[L])})
            break
    items.sort(key=lambda x: -x['s'])
    kept, dups = [], []
    for it in items:
        twin = next((k for k in kept if analyze.same_deck(it['archetype'], it['f']['names'], it['f']['colors'],
                                                         k['archetype'], k['f']['names'], k['f']['colors'])), None)
        if twin: dups.append({'dropped': it['archetype'], 'player': it['player'], 'kept': twin['archetype'], 'kept_player': twin['player']})
        else: kept.append(it)
    items = kept
    smax = max(i['s'] for i in items)
    for i in items: i['s'] = i['s'] / smax
    share = Counter()
    for r in d: share[analyze.classify(r['archetype'], {'creatures': 0, 'spells': 1, 'counters': 0, 'sweepers': 0, 'draw': 0, 'avg_cmc': 3}, overrides)[0]] += 1
    pool = Counter(i['style'] for i in items)
    tot = sum(pool.values())
    style_target = {'has': {s: pool[s] >= STYLE_FLOOR for s in STYLES},
                    't': {s: N_DECKS * (0.5 * 0.25 + 0.5 * pool[s] / tot) for s in STYLES}}
    sel, val = search(items, style_target, min(N_DECKS, len(items)))
    return era, items, sel, val, rejected, dups

if __name__ == '__main__':
    ov = json.load(open('style-overrides.json')) if os.path.exists('style-overrides.json') else {}
    eras = json.load(open('eras.json'))
    years = [int(a) for a in sys.argv[1:]] or [e['year'] for e in eras]
    for era in eras:
        if era['year'] not in years: continue
        era, items, sel, val, rejected, dups = run(era, ov)
        def slim(i): return {k: v for k, v in i.items() if k not in ('main', 'side')}
        json.dump({'era': era, 'chosen': [slim(items[i]) for i in sel],
                   'alternates': [slim(i) for j, i in enumerate(items) if j not in sel][:12],
                   'pool_size': len(items), 'rejected_illegal': rejected, 'duplicates_dropped': dups, 'objective': val},
                  open(f'selections/selection-{era["year"]}.json', 'w'), indent=1)
        cols = Counter(c for i in sel for c in items[i]['f']['colors']); st = Counter(items[i]['style'] for i in sel)
        print(era['year'], era['format'], 'pool', len(items), 'illegal', len(rejected), 'dups', len(dups),
              '| colours', dict(sorted(cols.items())), '| styles', dict(st), flush=True)
