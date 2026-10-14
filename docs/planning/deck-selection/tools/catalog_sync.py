"""Rewrite each era's entry in packages/deck/src/library/catalog.ts from its selection file:
the doc comment's numbers and the `decks` list. The selection is the source of truth
(README.md: "re-selecting is a data edit there and a re-run of select_decks.py"); this
keeps the catalog from being a second, hand-typed copy of it. Run after select_decks.py
and before build-library.ts, which refuses a deck file the catalog does not list.

  python3 tools/catalog_sync.py          # from docs/planning/deck-selection
"""
import json, os, re, sys, unicodedata
from collections import Counter
sys.path.insert(0, os.path.dirname(__file__))
import select_decks as S
from eras import selection_path, review_path
from report import dominance_notes, CN

CATALOG = os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'packages', 'deck', 'src', 'library', 'catalog.ts')
FAMILY = {'STANDARD': ('ST', 'standard', ''), 'MODERN': ('MO', 'modern', 'modern-'), 'LEGACY': ('LE', 'legacy', 'legacy-')}
BLOCK = re.compile(r'/\*\*\n(?: \*(?: [^\n]*)?\n)+ \*/\nexport const POWER_SUMMER_(\d{4})_(STANDARD|MODERN|LEGACY): LibraryCollection = \{\n((?:(?!\n\};)[\s\S])*)\n\};')


def slug(s):
    """`slugifyForLibrary` in catalog.ts, the same steps."""
    s = ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
    return re.sub(r'^-+|-+$', '', re.sub(r'[^a-z0-9]+', '-', s.lower()))


def rank_prefix(rank):
    """`rankPrefix` in build-library.ts: a finish's leading number, or the finish itself
    slugged when mtgtop8 gives words (`Day 1 undefeated`) or nothing (`unranked`)."""
    m = re.match(r'\d+', rank or '')
    return str(int(m.group(0))) if m else (slug(rank) or 'unranked')


def file_name(d):
    """`fileNameFor` in build-library.ts."""
    return f"{rank_prefix(d['rank'])}-{slug(d['player'])}-{slug(d['archetype'])}.dck"


def comment(sel, fam_name, fmt):
    era, chosen = sel['era'], sel['chosen']
    cols = Counter(c for r in chosen for c in r['f']['colors'])
    st = Counter(r['style'] for r in chosen)
    where = ('the format in force on August 1st, Worlds’ month — Type 2 had no autumn rotation that year'
             if era.get('no_fall_rotation')
             else 'the last Standard snapshot before that fall’s rotation' if fmt == 'ST'
             else f'pinned to Standard {era["year"]}’s own dates')
    n, pool = len(chosen), sel['pool_size']
    thin = f' **Thin season: {n} chosen of {pool} candidates.**' if n < S.N_DECKS else f' {n} chosen.'
    text = (f'The {era["year"]} {fam_name}power summer — `{era["format"]}`, {era["start"]} to {era["end"]}, {where}. '
            f'{pool} legal, distinct candidate decks (`docs/planning/deck-selection/{review_path(fmt, era["year"])}` '
            f'has the full table and the ones dropped as illegal or near-duplicate);{thin} One per archetype, '
            f'searched for colour and style spread: ' + ', '.join(f'{c} {cols[c]}' for c in 'WUBRG') + '; '
            + ', '.join(f'{s} {st[s]}' for s in S.STYLES) + '.')
    for note in dominance_notes(sel):
        text += ' ' + note
    lines, line = [], ''
    # A colour or a style keeps its count on its line: `W 3,` is one word to the wrap.
    words = re.sub(r'(\b(?:[WUBRG]|aggro|midrange|control|combo)) (\d+)', '\\1\0\\2', text).split(' ')
    for word in (w.replace('\0', ' ') for w in words):
        if line and len(line) + 1 + len(word) > 77:
            lines.append(line); line = word
        else:
            line = f'{line} {word}' if line else word
    lines.append(line)
    return '/**\n' + ''.join(f' * {l}\n' for l in lines) + ' */'


def sync(src):
    def one(m):
        year, fam = int(m.group(1)), m.group(2)
        fmt, family, infix = FAMILY[fam]
        sel = json.load(open(selection_path(fmt, year)))
        body = m.group(3)
        decks = ''.join(f'    {{ id: "power-{infix}{year}-{file_name(d)[:-4]}", file: "{file_name(d)}" }},\n' for d in sel['chosen'])
        body, k = re.subn(r'  decks: \[\n.*?  \],', lambda _: f'  decks: [\n{decks}  ],', body, flags=re.S)
        assert k == 1, f'{fam} {year}: no decks list'
        fam_name = '' if fmt == 'ST' else f'{family.capitalize()} '
        return f'{comment(sel, fam_name, fmt)}\nexport const POWER_SUMMER_{year}_{fam}: LibraryCollection = {{\n{body}\n}};'
    out, k = BLOCK.subn(one, src)
    return out, k


if __name__ == '__main__':
    src = open(CATALOG).read()
    out, k = sync(src)
    open(CATALOG, 'w').write(out)
    print(k, 'eras synced')
