"""What a deck list is, from the cards in it: legal in an era or not, which colours it
really plays (mana-cost pips, not the archetype's name), and which style it plays like."""
import json, math, re
from collections import Counter
from cards import load, is_land, BASICS

IDX = load()
COLORS = 'WUBRG'

def era_rules(era):
    sets = {s.strip().upper() for s in era['sets'].split(',')}
    banned = set(era.get('banned') or [])
    return sets, banned

def legality(main, side, era, banned):
    sets = {s.strip().upper() for s in era['sets'].split(',')}
    illegal, unknown = [], []
    for n, st, name in main + side:
        if name in BASICS:
            continue
        e = IDX.get(name)
        if e is None:
            unknown.append(name); continue
        if name in banned or e['name'] in banned:
            illegal.append(f'{name} (banned)'); continue
        if not (e['sets'] & sets):
            illegal.append(f'{name} (not in legal sets)')
    return sorted(set(illegal)), sorted(set(unknown))

PIP = re.compile(r'\{([^}]+)\}')

def pips(mana_cost):
    c = Counter()
    for sym in PIP.findall(mana_cost or ''):
        parts = sym.split('/')
        cols = [p for p in parts if p in COLORS]
        if not cols:
            continue
        if 'P' in parts and len(cols) == 1:
            continue                   # Phyrexian: payable with life, so it says nothing about the colours played
        else:
            for col in cols:
                c[col] += 1 / len(cols)  # hybrid counts split
    return c

def features(main):
    tot = Counter(); spells = creatures = counters = sweepers = draw = burn = 0
    cmc_sum = 0.0; lands = 0
    names = Counter()
    for n, st, name in main:
        e = IDX.get(name)
        if e is None:
            continue
        if is_land(e):
            lands += n
            continue
        names[e['name']] += n
        spells += n
        t = e['type'] or ''; x = (e['text'] or '').lower()
        cmc_sum += n * (e['cmc'] or 0)
        for col, v in pips(e['mana_cost']).items():
            tot[col] += v * n
        if 'Creature' in t and not ('add {' in x and (e['cmc'] or 0) <= 2):
            creatures += n
        if 'counter target' in x:
            counters += n
        if re.search(r'destroy all|all creatures|each creature|deals \d+ damage to each', x):
            sweepers += n
        if re.search(r'draw (a|two|three|x|\d+) cards?', x) and 'Creature' not in t:
            draw += n
        if re.search(r'damage to (any target|target)', x) and 'Creature' not in t:
            burn += n
    total_pips = sum(tot.values()) or 1
    share = {c: tot[c] / total_pips for c in COLORS}
    cols = [c for c in COLORS if share[c] >= 0.10 and tot[c] >= 4]
    return {'spells': spells, 'lands': lands, 'creatures': creatures, 'counters': counters, 'sweepers': sweepers,
            'draw': draw, 'burn': burn, 'avg_cmc': round(cmc_sum / spells, 2) if spells else 0,
            'pips': {c: round(tot[c], 1) for c in COLORS}, 'colors': cols, 'names': dict(names)}

COMBO_KW = ['combo', 'twin', 'exarch', 'storm', 'reanimator', 'kiki', 'ascendancy', 'scapeshift', 'pod', 'doomsday',
            'dredge', 'blink', 'rally', 'eggs', 'lotus', 'polymorph']
AGGRO_KW = ['aggro', 'burn', 'zoo', 'red deck', 'rdw', 'vampire', 'goblin', 'humans', 'hexproof', 'heroic', 'infect',
            'delver', 'affinity', 'tempered', 'weenie', 'warriors', 'kithkin', 'zombie', 'elves', 'torrent', 'machinegun']
CONTROL_KW = ['control', 'draw-go', 'draw go', 'cruel', 'faeries', 'sphinx', 'wrath', 'toast', 'mill', 'turboland']

def classify(label, f, overrides):
    """Explicit words in the label first (an archetype's own name is the best evidence we
    have), then what the 60 cards say."""
    if label in overrides:
        return overrides[label], 'override'
    L = label.lower()
    if any(k in L for k in COMBO_KW):
        return 'combo', 'label'
    if any(k in L for k in AGGRO_KW):
        return 'aggro', 'label'
    if any(k in L for k in CONTROL_KW):
        return 'control', 'label'
    cr = f['creatures']
    if cr <= 10 and (f['counters'] >= 4 or (f['sweepers'] >= 4 and cr <= 8) or f['draw'] >= 9):
        return 'control', 'cards'
    if cr >= 16 and f['avg_cmc'] <= 2.7:
        return 'aggro', 'cards'
    return 'midrange', 'default'

# Words that name a colour pair, a size or a style rather than the deck.
FAMILY_STOP = {'uw', 'wu', 'ub', 'bu', 'ur', 'ru', 'ug', 'gu', 'wb', 'bw', 'wr', 'rw', 'wg', 'gw', 'br', 'rb', 'bg', 'gb', 'rg', 'gr',
               'mono', '4c', '5c', '3c', 'control', 'aggro', 'midrange', 'deck', 'wins', 'ramp', 'the', 'of', 'and', 'to', 'x',
               'white', 'blue', 'black', 'red', 'green', 'esper', 'bant', 'jund', 'naya', 'grixis', 'abzan', 'mardu', 'jeskai',
               'sultai', 'temur', 'azorius', 'dimir', 'rakdos', 'gruul', 'selesnya', 'orzhov', 'izzet', 'golgari', 'boros', 'simic',
               'team', 'aggro/', 'variant', 'uwr', 'uwx', 'wub', 'wug', 'ubr', 'brg', 'wbg', 'urg', 'bug', 'rug', 'gwu', 'gw/naya'}
ALIAS = {'rdw': 'redeckwins', 'red': 'redeckwins'}

def family(label):
    L = label.lower().replace('red deck wins', 'rdw')
    words = [w for w in re.findall(r"[a-z0-9']+", L) if w not in FAMILY_STOP and len(w) > 1]
    return {ALIAS.get(w, w) for w in words}

def same_deck(a_label, a_names, a_cols, b_label, b_names, b_cols, jacc=None):
    j = jaccard(a_names, b_names) if jacc is None else jacc
    if j >= 0.60:
        return True
    if set(a_cols) == set(b_cols) and j >= 0.45:
        return True
    if family(a_label) & family(b_label) and j >= 0.30:
        return True
    return False

def jaccard(a, b):
    A, B = set(a), set(b)
    return len(A & B) / len(A | B) if A | B else 0.0
