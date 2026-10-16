"""Turns selections/selection-<year>.json (and the modern-/legacy- equivalents) into
the review docs under review/: <year>.md / modern-<year>.md / legacy-<year>.md (every
chosen deck with its full list) and, once per wave (not per format — pass `--readme`
with no `--format`), README.md (the combined summary and the rules in plain words,
covering all three formats).

`--format MO|LE` writes ONLY that format's per-era docs, never README.md — three
lanes writing README.md at once is exactly the collision wave48's plan calls out.
README.md is lane T's alone, regenerated once at integration (`--readme`) after
every format's eras exist."""
import json, os, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(__file__))
import analyze, lists
import select_decks as S
from eras import eras as eras_for, selection_path, review_path

CN = {'W': 'White', 'U': 'Blue', 'B': 'Black', 'R': 'Red', 'G': 'Green'}
FAMILY_NAME = {'ST': 'Standard', 'MO': 'Modern', 'LE': 'Legacy'}

def key_cards(f, n=6):
    idx = analyze.IDX
    rows = [(q, idx[name]['cmc'] or 0, name) for name, q in f['names'].items()]
    rows.sort(key=lambda r: (-r[0], -r[1], r[2]))
    return ', '.join(f'{q}× {name}' for q, _, name in rows[:n])

def url(r, fmt='ST'): return f'https://www.mtgtop8.com/event?e={r["event"]}&d={r["deck"]}&f={fmt}'

def deck_name(r): return f'{r["archetype"]} ({r["player"]})'

def dominance_notes(sel):
    """'Balance, but true to the season' (wave48 Settled): a colour or style
    that DOMINATED the candidate pool may take an extra slot, and the review
    doc says so in one line — the evidence is its share of the era's
    candidates. `pool_colors`/`pool_styles` are the full legal, de-duplicated
    pool's own shares, persisted by `select_decks.py` alongside the
    selection; absent (an older selection file) means no note rather than a
    crash."""
    notes = []
    chosen = sel['chosen']
    n = len(chosen)
    if n == 0:
        return notes
    pool_colors = sel.get('pool_colors') or {}
    pool_styles = sel.get('pool_styles') or {}
    cols = Counter(c for r in chosen for c in r['f']['colors'])
    pc_tot = sum(pool_colors.values()) or 1
    for c in 'WUBRG':
        share = pool_colors.get(c, 0) / pc_tot
        extra = cols[c] - n / 5
        if share >= 0.28 and cols[c] > 0 and cols[c] == max(cols.values(), default=0) and extra > 1:
            notes.append(
                f'{CN[c]} dominated this era’s candidate pool ({share:.0%} of its colour pips) '
                f'and was given extra slots ({cols[c]} of {n} chosen).'
            )
    ps_tot = sum(pool_styles.values()) or 1
    st = Counter(r['style'] for r in chosen)
    for s in S.STYLES:
        share = pool_styles.get(s, 0) / ps_tot
        if share >= 0.40 and st[s] >= S.STYLE_CAP:
            notes.append(
                f'{s.capitalize()} dominated this era’s candidate pool ({share:.0%} of its decks) '
                f'and was given extra slots ({st[s]} of {n} chosen).'
            )
    return notes

def no_rotation_window(era):
    """Why a year with no set-dropping fall rotation is the format in force on August 1st."""
    if era['format'].startswith('Type 2'):
        return ('Type 2 had no autumn rotation this year, so the era is the format in force on August 1st, '
                'when Worlds was played')
    return ('Standard had no rotation this year — WotC moved it to a three-year rotation and the autumn set '
            'dropped nothing — so the era is the format in force on August 1st')

def era_doc(sel, fmt='ST'):
    era = sel['era']; out = []
    fam = FAMILY_NAME[fmt]
    out.append(f'# {era["year"]} — {era["format"]}\n')
    window = (
        no_rotation_window(era)
        if era.get('no_fall_rotation')
        else 'the last Standard before the fall rotation'
        if fmt == 'ST'
        else f'{fam} does not rotate; this snapshot is pinned to {era["year"]}’s Standard era’s own dates, Settled wave 48'
    )
    out.append(f'Format in force **{era["start"]} → {era["end"]}** ({window}). '
               f'Sets: {era["sets"]}. Banned: {", ".join(era["banned"]) or "none"}.'
               + (f' Restricted (one copy): {", ".join(era["restricted"])}.' if era.get('restricted') else '')
               + (' One copy of each legendary card.' if era.get('restricted_legendary') else '') + '\n')
    cols = Counter(c for r in sel['chosen'] for c in r['f']['colors']); st = Counter(r['style'] for r in sel['chosen'])
    out.append('**Balance of the chosen decks.** Colours (decks playing each): ' + ', '.join(f'{CN[c]} {cols[c]}' for c in 'WUBRG') +
               '. Styles: ' + ', '.join(f'{s} {st[s]}' for s in S.STYLES) + '.\n')
    for note in dominance_notes(sel):
        out.append(f'- {note}')
    if sel.get('pool_colors') or sel.get('pool_styles'):
        pc = sel.get('pool_colors') or {}; ps = sel.get('pool_styles') or {}
        out.append('\n**The candidate pool’s own shares** (before selection; {} legal decks): colours '.format(sel['pool_size']) +
                   ', '.join(f'{CN[c]} {pc.get(c, 0)}' for c in 'WUBRG') +
                   '. Styles: ' + ', '.join(f'{s} {ps.get(s, 0)}' for s in S.STYLES) + '.\n')
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
        main, side = lists.get(r['deck'], fmt)
        out.append(f'### {i}. {deck_name(r)}\n')
        out.append(f'{r["rank"]} at {r["event_name"]}, {r["date"]} · [mtgtop8]({url(r, fmt)}) · {"".join(r["f"]["colors"]) or "colourless"} · {r["style"]} (by {r["style_why"]}) · avg cost {r["f"]["avg_cmc"]}, {r["f"]["creatures"]} creatures\n')
        out.append('```\n' + '\n'.join(f'{n} {name}' for n, _, name in main) + '\n\nSideboard\n' + '\n'.join(f'{n} {name}' for n, _, name in side) + '\n```\n')
    return '\n'.join(out)

def era_link(fmt, year):
    i = {'ST': None, 'MO': 'modern', 'LE': 'legacy'}[fmt]
    return f'{year}.md' if i is None else f'{i}-{year}.md'

def family_table(fmt, sels):
    """One format's era table + style-judged table, same shape as wave 34's
    single-format README, generalised with a `fmt` heading and era links."""
    fam = FAMILY_NAME[fmt]
    o = [f'## {fam} eras\n',
         '| era | format | window | distinct legal decks to choose from | chosen | W | U | B | R | G | aggro | midrange | control | combo |\n'
         '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    tc = Counter(); ts = Counter(); n = 0
    for s in sels:
        e = s['era']; c = Counter(x for r in s['chosen'] for x in r['f']['colors']); st = Counter(r['style'] for r in s['chosen'])
        tc.update(c); ts.update(st); n += len(s['chosen'])
        o.append(f'| [{e["year"]}]({era_link(fmt, e["year"])}) | {e["format"]} | {e["start"]} → {e["end"]} | {s["pool_size"]} | {len(s["chosen"])} | ' +
                 ' | '.join(str(c[x]) for x in 'WUBRG') + ' | ' + ' | '.join(str(st[x]) for x in S.STYLES) + ' |')
    if sels:
        o.append(f'| **all** | | | | **{n}** | ' + ' | '.join(str(tc[x]) for x in 'WUBRG') + ' | ' + ' | '.join(str(ts[x]) for x in S.STYLES) + ' |\n')
    else:
        o.append('| *(no eras selected yet)* |\n')
    o.append(f'### {fam}: how each archetype was judged (style)\n')
    o.append('| era | deck | style | judged by |\n| --- | --- | --- | --- |')
    for s in sels:
        for r in s['chosen']:
            o.append(f'| {s["era"]["year"]} | {r["archetype"]} | {r["style"]} | {r["style_why"]} |')
    return '\n'.join(o) + '\n'

def readme(by_fmt):
    """`by_fmt`: {'ST': [selection, ...], 'MO': [...], 'LE': [...]}, oldest
    year first within each. Covers all three formats — the single-format
    version wave 34 wrote is gone; `family_table` is its generalisation."""
    total_decks = sum(len(s['chosen']) for v in by_fmt.values() for s in v)
    total_eras = sum(len(v) for v in by_fmt.values())
    years_st = [s['era']['year'] for s in by_fmt.get('ST', [])]
    span = f'{min(years_st)}–{max(years_st)}' if years_st else '2003–2016'
    o = [f'# Deck selection review — "power summers", Standard {span}, Modern and Legacy\n',
         'One era per year per format: for Standard, the format in force **just before the fall rotation**, when the old '
         'block and the new one are legal together. Type 2 in 1995 and 1996 had no autumn rotation and changed its '
         'restricted list between Worlds and the autumn set, so those two years take the format in force on August 1st; so does 2023, when WotC moved Standard to a three-year rotation and Wilds of Eldraine dropped no set. Modern and Legacy do not rotate, so their eras are pinned to the same '
         'year’s Standard era’s own dates (wave 48, Settled) — same season window, snapshot taken from the latest '
         'dated Modern/Legacy format file on or before that date.\n',
         '## How the decks were chosen\n',
         '1. **Candidates:** every deck from a competitive-level event (Pro Tour, Worlds, Grand Prix, Nationals, SCG Opens, PTQs; not online dailies) in the season before that fall rotation, from [mtgtop8](https://www.mtgtop8.com). Events inside the summer window count more than earlier ones. A season whose competitive events cannot fill the era also takes mtgtop8’s **regular** events (local tournaments); they carry the fewest stars, so they only ever fill gaps.',
         '2. **One deck per archetype**, the one that went furthest (a bigger event counts more). **No near-duplicates:** two lists count as the same deck when they share 60% of their cards, or 45% and the same colours, or 30% and the same archetype name.',
         '3. **Legal in that era**, checked card by card against Forge\'s own format file (legal sets, bans, and Type 2\'s restricted list and one-of-each-legendary rule) — ST\'s own dated Standard file, MO/LE\'s latest dated file on or before the era\'s snapshot date. **Loadable**, too: every card has a script in Forge at the pinned commit, or the deck could not be played here.',
         f'4. **Colour spread:** the chosen decks are searched so each of the five colours is played by about the same number of them (a colour may sit {S.COLOR_TOLERANCE} deck{"s" if S.COLOR_TOLERANCE != 1 else ""} off the mean for free). Colours are read from mana costs, not from the archetype name.',
         f'5. **Style spread:** at least {S.STYLE_FLOOR} decks of each style when the era has them, at most {S.STYLE_CAP} of any one, and the targets lean toward the rarer styles.',
         f'6. **Strength still counts:** within those limits the search maximises how well the decks actually placed. {S.N_DECKS} decks per era where the season has them — **thin seasons are reported, not padded** (fewer than {S.N_DECKS} legal candidates means a smaller era).',
         '7. **Balance, but true to the season:** a colour or style that dominated an era’s candidate pool may take an extra slot or two — flagged per era below with its pool share as evidence, never invented to fill a colour/style the season barely played.',
         '8. **The library only grows:** a re-run keeps every deck the era’s previous selection chose that is still a legal, distinct candidate, and fills around it — 12 per era became 24 on 2026-10-10 without dropping one.\n',
         '**Legality is checked in Scryfall’s set codes.** Forge’s format files name sets in Forge’s codes and the card corpus is Scryfall’s; until 2026-10-10 the two were compared as-is, so every Conflux card (`CFX`/`CON`) and every Nemesis card in Legacy (`NMS`/`NEM`) read as illegal, and split cards (`Wear / Tear`) and accented names (`Jötun Grunt`) as unknown. `tools/analyze.py` maps the codes through Forge’s own edition files now.\n',
         'Tunable in `tools/select_decks.py`; re-run and the review regenerates. **Style is a heuristic** (creature count, average cost, counterspells and sweepers, plus archetype names); each format section’s table shows how every deck was judged. Wrong ones can be fixed in `style-overrides.json` (Standard), `style-overrides-modern.json`, `style-overrides-legacy.json`.\n',
         f'**{total_decks} decks across {total_eras} eras.**\n']
    for fmt in ('ST', 'MO', 'LE'):
        o.append(family_table(fmt, by_fmt.get(fmt, [])))
    return '\n'.join(o)

if __name__ == '__main__':
    argv = sys.argv[1:]
    if '--readme' in argv:
        os.makedirs('review', exist_ok=True)
        by_fmt = {}
        for fmt in ('ST', 'MO', 'LE'):
            sels = []
            for e in eras_for(fmt):
                p = selection_path(fmt, e['year'])
                if os.path.exists(p):
                    sels.append(json.load(open(p)))
            by_fmt[fmt] = sels
        open('review/README.md', 'w').write(readme(by_fmt))
        print('wrote review/README.md:', {fmt: len(v) for fmt, v in by_fmt.items()})
    else:
        fmt = 'ST'
        if '--format' in argv:
            fmt = argv[argv.index('--format') + 1]
        os.makedirs('review', exist_ok=True)
        sels = []
        for e in eras_for(fmt):
            p = selection_path(fmt, e['year'])
            if os.path.exists(p):
                sels.append(json.load(open(p)))
        for s in sels:
            open(review_path(fmt, s['era']['year']), 'w').write(era_doc(s, fmt))
        print('wrote', len(sels), 'eras for', fmt)
