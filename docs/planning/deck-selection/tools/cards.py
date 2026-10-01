"""Card facts by name from the repo's own corpus (packages/carddata/data/cards.jsonl,
gitignored, read from the main checkout). Indexed by full name AND by front face, since
mtgtop8 lists a double-faced card by its front."""
import json, os, pickle, re

CORPUS = os.environ.get('CARDS_JSONL', '/home/hadoku/repos/hadoku-cardtable/packages/carddata/data/cards.jsonl')
CACHE = '/tmp/claude-1000/cards-index.pkl'
BASICS = {'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Snow-Covered Plains', 'Snow-Covered Island',
          'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest', 'Wastes'}

def load():
    if os.path.exists(CACHE):
        return pickle.load(open(CACHE, 'rb'))
    idx = {}
    with open(CORPUS) as f:
        for line in f:
            d = json.loads(line)
            if d.get('digital') or d.get('layout') in ('token', 'emblem', 'art_series'):
                continue
            keys = {d['name']}
            if ' // ' in d['name']:
                keys.add(d['name'].split(' // ')[0])
            for k in keys:
                e = idx.get(k)
                if e is None:
                    e = idx[k] = {'name': d['name'], 'sets': set(), 'colors': None, 'mana_cost': None,
                                  'cmc': None, 'type': None, 'text': None, 'produced': set()}
                e['sets'].add(d['set'].upper())
                if e['type'] is None:
                    face = d
                    e['colors'] = d.get('colors') or (d.get('card_faces') or [{}])[0].get('colors') or []
                    f0 = (d.get('card_faces') or [{}])[0]
                    e['mana_cost'] = d.get('mana_cost') or f0.get('mana_cost') or ''
                    e['cmc'] = d.get('cmc') or 0
                    e['type'] = d.get('type_line') or f0.get('type_line') or ''
                    e['text'] = d.get('oracle_text') or f0.get('oracle_text') or ''
                for m in d.get('produced_mana') or []:
                    e['produced'].add(m)
    pickle.dump(idx, open(CACHE, 'wb'))
    return idx

def is_land(e):
    return 'Land' in (e['type'] or '')

if __name__ == '__main__':
    idx = load()
    print(len(idx), 'names')
    for n in ('Delver of Secrets', 'Fire // Ice', 'Squadron Hawk', 'Sylvok Lifestaff', 'Tarmogoyf', 'Gitaxian Probe'):
        e = idx.get(n); print(n, '->', e and (e['name'], e['colors'], e['mana_cost'], sorted(e['sets'])[:6]))
