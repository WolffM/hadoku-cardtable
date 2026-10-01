"""Turns selections/selection-<year>.json into the review docs under review/: README.md (the
summary and the rules in plain words) and <year>.md (every chosen deck with its full list)."""
import json, os, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(__file__))
import analyze, lists
import select_decks as S

CN = {'W': 'White', 'U': 'Blue', 'B': 'Black', 'R': 'Red', 'G': 'Green'}

def key_cards(f, n=6):
    idx = analyze.IDX
    rows = [(q, idx[name]['cmc'] or 0, name) for name, q in f['names'].items()]
    rows.sort(key=lambda r: (-r[0], -r[1], r[2]))
    return ', '.join(f'{q}× {name}' for q, _, name in rows[:n])

def url(r): return f'https://www.mtgtop8.com/event?e={r["event"]}&d={r["deck"]}&f=ST'

def deck_name(r): return f'{r["archetype"]} ({r["player"]})'

def era_doc(sel):
    era = sel['era']; out = []
    out.append(f'# {era["year"]} — {era["format"]}\n')
    out.append(f'Format in force **{era["start"]} → {era["end"]}** (the last Standard before the fall rotation). '
               f'Sets: {era["sets"]}. Banned: {", ".join(era["banned"]) or "none"}.\n')
    cols = Counter(c for r in sel['chosen'] for c in r['f']['colors']); st = Counter(r['style'] for r in sel['chosen'])
    out.append('**Balance of the chosen decks.** Colours (decks playing each): ' + ', '.join(f'{CN[c]} {cols[c]}' for c in 'WUBRG') +
               '. Styles: ' + ', '.join(f'{s} {st[s]}' for s in S.STYLES) + '.\n')
    out.append('| # | deck | finish | colours | style | the list is built around |\n| --- | --- | --- | --- | --- | --- |')
    for i, r in enumerate(sel['chosen'], 1):
        fin = f'{r["rank"]} · {r["event_name"]} · {r["date"]}' + (' ★' * r['stars'] if r['stars'] else '')
        out.append(f'| {i} | **{deck_name(r)}** | {fin} | {"".join(r["f"]["colors"]) or "colourless"} | {r["style"]} | {key_cards(r["f"])} |')
    out.append('\n## Alternates (next best, not chosen)\n')
    out.append('| deck | finish | colours | style |\n| --- | --- | --- | --- |')
    for r in sel['alternates']:
        out.append(f'| {deck_name(r)} | {r["rank"]} · {r["event_name"]} · {r["date"]} | {"".join(r["f"]["colors"]) or "colourless"} | {r["style"]} |')
    if sel['duplicates_dropped']:
        out.append('\n## Dropped as near-duplicates (same cards, worse finish)\n')
        for d in sel['duplicates_dropped']:
            out.append(f'- {d["dropped"]} ({d["player"]}) → kept {d["kept"]} ({d["kept_player"]})')
    if sel['rejected_illegal']:
        out.append('\n## Skipped as illegal in this era\n')
        for d in sel['rejected_illegal'][:25]:
            out.append(f'- {d["archetype"]} ({d["player"]}): {"; ".join(d["why"])}')
    out.append('\n---\n\n## The lists\n')
    for i, r in enumerate(sel['chosen'], 1):
        main, side = lists.get(r['deck'])
        out.append(f'### {i}. {deck_name(r)}\n')
        out.append(f'{r["rank"]} at {r["event_name"]}, {r["date"]} · [mtgtop8]({url(r)}) · {"".join(r["f"]["colors"]) or "colourless"} · {r["style"]} (by {r["style_why"]}) · avg cost {r["f"]["avg_cmc"]}, {r["f"]["creatures"]} creatures\n')
        out.append('```\n' + '\n'.join(f'{n} {name}' for n, _, name in main) + '\n\nSideboard\n' + '\n'.join(f'{n} {name}' for n, _, name in side) + '\n```\n')
    return '\n'.join(out)

def readme(sels):
    o = ['# Deck selection review — Standard "power summers" 2008–2016\n',
         'One era per year: the Standard in force **just before the fall rotation**, when the old block and the new one are legal together. '
         'Replaces the nine mid-season eras (several of which were the same set twice, or a ban with no new set).\n',
         '## How the decks were chosen\n',
         '1. **Candidates:** every Standard deck from a competitive-level event (Pro Tour, Worlds, Grand Prix, Nationals, SCG Opens, PTQs; not online dailies) in the season before that fall rotation, from [mtgtop8](https://www.mtgtop8.com). Events inside the summer window count more than earlier ones. Summers 2009 and 2010 have almost nothing in the summer itself (mtgtop8 has a few Nationals), so those eras lean on earlier-season decks that are still legal.',
         '2. **One deck per archetype**, the one that went furthest (a bigger event counts more). **No near-duplicates:** two lists count as the same deck when they share 60% of their cards, or 45% and the same colours, or 30% and the same archetype name (so "RDW" and "Red Deck Wins", or four Tempered Steel lists, collapse to the one that placed best).',
         '3. **Legal in that era**, checked card by card against Forge\'s own format file (legal sets and bans). A deck that played a card later banned, or a core set that had already rotated, is skipped. That is why 2009 and 2010 are small: mtgtop8 has only a few Nationals in those two summers, and most earlier-season decks carry cards that were illegal by July.',
         f'4. **Colour spread:** the chosen decks are searched so each of the five colours is played by about the same number of them (a colour may sit one deck off the mean for free). Colours are read from mana costs, not from the archetype name.',
         f'5. **Style spread:** at least {S.STYLE_FLOOR} decks of each style when the era has them, at most {S.STYLE_CAP} of any one, and the targets lean toward the rarer styles.',
         f'6. **Strength still counts:** within those limits the search maximises how well the decks actually placed. {S.N_DECKS} decks per era.\n',
         'Tunable in `tools/select_decks.py`; re-run and the review regenerates. **Style is a heuristic** (creature count, average cost, counterspells and sweepers, plus archetype names); the classification table below shows how each deck was judged. Wrong ones can be fixed in `style-overrides.json`.\n',
         '## The nine eras\n',
         '| era | format | window | distinct legal decks to choose from | chosen | W | U | B | R | G | aggro | midrange | control | combo |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    tc = Counter(); ts = Counter(); n = 0
    for s in sels:
        e = s['era']; c = Counter(x for r in s['chosen'] for x in r['f']['colors']); st = Counter(r['style'] for r in s['chosen'])
        tc.update(c); ts.update(st); n += len(s['chosen'])
        o.append(f'| [{e["year"]}]({e["year"]}.md) | {e["format"]} | {e["start"]} → {e["end"]} | {s["pool_size"]} | {len(s["chosen"])} | ' + ' | '.join(str(c[x]) for x in 'WUBRG') + ' | ' + ' | '.join(str(st[x]) for x in S.STYLES) + ' |')
    o.append(f'| **all** | | | | **{n}** | ' + ' | '.join(str(tc[x]) for x in 'WUBRG') + ' | ' + ' | '.join(str(ts[x]) for x in S.STYLES) + ' |\n')
    o.append('## How each archetype was judged (style)\n')
    o.append('| era | deck | style | judged by |\n| --- | --- | --- | --- |')
    for s in sels:
        for r in s['chosen']:
            o.append(f'| {s["era"]["year"]} | {r["archetype"]} | {r["style"]} | {r["style_why"]} |')
    return '\n'.join(o) + '\n'

if __name__ == '__main__':
    os.makedirs('review', exist_ok=True)
    sels = [json.load(open(f'selections/selection-{y}.json')) for y in range(2008, 2017) if os.path.exists(f'selections/selection-{y}.json')]
    for s in sels:
        open(f'review/{s["era"]["year"]}.md', 'w').write(era_doc(s))
    open('review/README.md', 'w').write(readme(sels))
    print('wrote', len(sels), 'eras')
