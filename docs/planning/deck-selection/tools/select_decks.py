"""Pick the decks for each era by rule. Every rule is a constant below so it can be argued
with. Writes selections/selection-<year>.json; report.py turns those into the review doc.

  1. one deck per archetype (the one that went furthest, weighted by how big the event was)
  2. no near-duplicates (>= DUP_JACCARD of the same main-deck cards): the better finish stays
  3. legal in the era's Standard, from the cards (bans and sets from Forge's own format file)
  4. colour spread: all five colours played by roughly the same number of decks, with room to
     lean toward what was best
  5. style spread: floors for the rarest styles, a cap on the most common
  6. the decks already in the library stay: a re-run reads the era's previous selection and
     keeps every deck it chose that is still a legal, distinct candidate, filling around them
"""
import json, math, os, random, sys
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(__file__))
import analyze, lists
from eras import eras as eras_for, cache_path, selection_path, style_overrides_path

N_DECKS = 24                    # 12 until 2026-10-10 (operator: "can you try to get 24?")
LABELS_CONSIDERED = 120         # archetypes (best deck each) examined per era; 55 at 12 decks
TRIES_PER_LABEL = 4             # next-best deck of a label when the best is illegal
DUP_JACCARD = 0.70
STAR_W = {5: 1.25, 4: 1.05, 3: 0.85, 2: 0.65, 1: 0.45, 0: 0.25}
SUMMER_W, EARLIER_W = 1.0, 0.8  # decks from the summer window outrank the same finish earlier in the season
A_STRENGTH, B_COLOR, C_STYLE = 1.0, 1.0, 1.0
# The spread rules scale with N_DECKS: at 12 they were 1, 2 and 5.
COLOR_TOLERANCE = N_DECKS // 12  # how far a colour's deck count may sit from the mean before it costs anything
STYLE_FLOOR, STYLE_CAP = N_DECKS // 6, N_DECKS * 5 // 12
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

def search(items, style_target, n, locked=frozenset(), restarts=120, seed=7):
    rng = random.Random(seed); idx = list(range(len(items)))
    best, bestv = None, -1e9
    top = [i for i in sorted(idx, key=lambda i: -items[i]['s']) if i not in locked]
    free = n - len(locked)
    for r in range(restarts):
        sel = set(locked) | (set(top[:free]) if r == 0 else set(rng.sample(top[:max(free + 6, 30)], min(free, len(top)))))
        v = objective(sel, items, style_target)
        improved = True
        while improved:
            improved = False
            for a in [i for i in sel if i not in locked]:
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

def run(era, overrides, fmt='ST', keep=frozenset()):
    import html
    d = json.load(open(cache_path(fmt, era['year'])))['decks']
    for r in d:
        for k in ('archetype', 'player', 'event_name'): r[k] = html.unescape(r[k]).replace('\xa0', ' ').strip()
        # Older events' rows carry their page's section as a tag (`[Top 8 - T2] Gruul II`)
        # and sometimes no player at all; the list itself is real and cited by its URL.
        r['archetype'] = __import__('re').sub(r'^(?:\[[^\]]*\]\s*)+', '', r['archetype']) or r['archetype']
        # A trailing country (`Tzu-Ching Kuo (Chinese Taipei)`) breaks the library's own
        # `Archetype (Player)` deck name.
        r['player'] = __import__('re').sub(r'\s*\([^()]*\)$', '', r['player']) or 'unknown player'
    by = defaultdict(list)
    for r in d:
        r['s'] = strength(r); by[r['archetype']].append(r)
    labels = sorted(by, key=lambda L: (-max(x['s'] for x in by[L]), -len(by[L])))[:LABELS_CONSIDERED]
    rejected, items = [], []
    for L in labels:
        tries = 0
        # A deck the library already has is its label's representative while it is legal:
        # one deck per archetype, and the one people have been playing.
        for r in sorted(by[L], key=lambda x: (x['deck'] not in keep, -x['s']))[:TRIES_PER_LABEL]:
            tries += 1
            main, side = lists.get(r['deck'], fmt)
            n_main, n_side = sum(n for n, _, _ in main), sum(n for n, _, _ in side)
            if n_main < 60 or n_side > 15:
                rejected.append({'archetype': L, 'deck': r['deck'], 'player': r['player'], 'why': [f'incomplete list: {n_main} main, {n_side} sideboard']})
                continue
            ill, unk = analyze.legality(main, side, era, set(era['banned']))
            ill += analyze.over_copy_limit(main, side)
            if ill or unk:
                rejected.append({'archetype': L, 'deck': r['deck'], 'player': r['player'], 'why': (ill + [f'unknown card: {u}' for u in unk])[:3]})
                continue
            f = analyze.features(main)
            if f['spells'] < 8:
                # mtgtop8 records a finish without its list as 60 basics (Modern 2013's
                # `Unknown Scapeshift` was 60 Forest). A real land deck still plays 18+.
                rejected.append({'archetype': L, 'deck': r['deck'], 'player': r['player'], 'why': [f'placeholder list: {f["spells"]} nonland cards']})
                continue
            style, why = analyze.classify(L, f, overrides)
            items.append({**r, 'f': f, 'style': style, 'style_why': why, 'main': main, 'side': side, 'label_count': len(by[L])})
            break
    # Kept decks claim their place first, so a newly legal list cannot drop one as its twin.
    items.sort(key=lambda x: (x['deck'] not in keep, -x['s']))
    kept, dups = [], []
    for it in items:
        twin = next((k for k in kept if analyze.same_deck(it['archetype'], it['f']['names'], it['f']['colors'],
                                                         k['archetype'], k['f']['names'], k['f']['colors'])), None)
        if twin: dups.append({'dropped': it['archetype'], 'player': it['player'], 'kept': twin['archetype'], 'kept_player': twin['player']})
        else: kept.append(it)
    items = sorted(kept, key=lambda x: -x['s'])
    smax = max(i['s'] for i in items)
    for i in items: i['s'] = i['s'] / smax
    share = Counter()
    for r in d: share[analyze.classify(r['archetype'], {'creatures': 0, 'spells': 1, 'counters': 0, 'sweepers': 0, 'draw': 0, 'avg_cmc': 3}, overrides)[0]] += 1
    pool = Counter(i['style'] for i in items)
    tot = sum(pool.values())
    style_target = {'has': {s: pool[s] >= STYLE_FLOOR for s in STYLES},
                    't': {s: N_DECKS * (0.5 * 0.25 + 0.5 * pool[s] / tot) for s in STYLES}}
    locked = frozenset(i for i, it in enumerate(items) if it['deck'] in keep)
    sel, val = search(items, style_target, min(N_DECKS, len(items)), locked)
    lost = sorted(set(keep) - {it['deck'] for it in items})
    # The full legal, de-duplicated pool's own colour/style shares — kept
    # alongside the selection (not recomputed by report.py) so "balance, but
    # true to the season" (wave48 Settled) can be checked against the real
    # meta: a colour/style that DOMINATED the candidate pool is the evidence
    # for giving it an extra slot, and the review doc shows both side by side.
    pool_colors = dict(Counter(c for i in items for c in i['f']['colors']))
    pool_styles = dict(pool)
    return era, items, sel, val, rejected, dups, pool_colors, pool_styles, lost

if __name__ == '__main__':
    argv = sys.argv[1:]
    fmt = 'ST'
    if '--format' in argv:
        i = argv.index('--format'); fmt = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    ov_path = style_overrides_path(fmt)
    ov = json.load(open(ov_path)) if os.path.exists(ov_path) else {}
    eras_list = eras_for(fmt)
    years = [int(a) for a in argv] or [e['year'] for e in eras_list]
    os.makedirs('selections', exist_ok=True)
    for era in eras_list:
        if era['year'] not in years: continue
        prev = selection_path(fmt, era['year'])
        keep = frozenset(c['deck'] for c in json.load(open(prev))['chosen']) if os.path.exists(prev) else frozenset()
        era, items, sel, val, rejected, dups, pool_colors, pool_styles, lost = run(era, ov, fmt, keep)
        def slim(i): return {k: v for k, v in i.items() if k not in ('main', 'side')}
        json.dump({'era': era, 'chosen': [slim(items[i]) for i in sel],
                   'alternates': [slim(i) for j, i in enumerate(items) if j not in sel][:12],
                   'pool_size': len(items), 'rejected_illegal': rejected, 'duplicates_dropped': dups, 'objective': val,
                   'pool_colors': pool_colors, 'pool_styles': pool_styles, 'kept_lost': lost},
                  open(selection_path(fmt, era['year']), 'w'), indent=1)
        cols = Counter(c for i in sel for c in items[i]['f']['colors']); st = Counter(items[i]['style'] for i in sel)
        if lost: print('  LOST previously chosen decks:', lost, flush=True)
        print(era['year'], era['format'], 'pool', len(items), 'illegal', len(rejected), 'dups', len(dups),
              '| colours', dict(sorted(cols.items())), '| styles', dict(st), flush=True)
