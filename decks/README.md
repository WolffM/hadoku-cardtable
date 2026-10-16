# `decks/` — real decks from past Standard, Modern and Legacy formats

Decklists as they were actually played, in Forge `.dck` form, each carrying the
format it is legal in, the date that format was current, and **the URL the list
was copied from**. A deck nobody can trace is a deck nobody can correct, so
`loadLibraryDeck` refuses one without a citation.

The code that reads these lives in `packages/deck/src/library/`.

## What is here

Forty power-summer eras across three formats, 811 decks total. Standard:
1995-2016, each the Standard in force just **before that year's fall
rotation** (old block and new block legal together) — except Type 2 in 1995
and 1996, which had no fall rotation and changed its restricted list between
Worlds and the autumn set, so those two take the format in force on August
1st. Modern (2011-2016) and Legacy (2005-2016) do not rotate, so each year's
era is pinned to the SAME dates that year's Standard era uses (wave 48,
Settled) — the snapshot is the latest Archived/Modern or Archived/Legacy file
on or before that date, and Modern/Legacy and Standard eras of the same year
sit side by side:

```
standard-1995/   Type 2 (CHR), 1995-07-01     (9 decks — thin season)
standard-1996/   Type 2 (ALL), 1996-07-10     (12 decks — thin season)
standard-1997/   Standard (WTH), 1997-07-01   (12 decks — thin season)
standard-1998/   Standard (EXO), 1998-07-01   (6 decks — thin season)
standard-1999/   Standard (UDS), 1999-07-01   (15 decks — thin season)
standard-2000/   Standard (PCY), 2000-07-01   (16 decks — thin season)
standard-2001/   Standard (APC), 2001-07-01   (20 decks — thin season)
standard-2002/   Standard (JUD), 2002-07-01   (21 decks — thin season)
standard-2003/   Standard (8ED), 2003-09-01   (8 decks — thin season)
standard-2004/   Standard (5DN), 2004-06-20   (24 decks)
standard-2005/   Standard (9ED), 2005-08-20   (7 decks — thin season)
standard-2006/   Standard (CSP), 2006-08-20   (24 decks)
standard-2007/   Standard (10E), 2007-07-20   (24 decks)
standard-2008/   Standard (EVE), 2008-07-25   (24 decks)
standard-2009/   Standard (M10), 2009-07-17   (11 decks — thin season)
standard-2010/   Standard (M11), 2010-07-16   (24 decks)
standard-2011/   Standard (M12), 2011-07-15   (24 decks)
standard-2012/   Standard (M13), 2012-07-13   (24 decks)
standard-2013/   Standard (M14), 2013-07-19   (24 decks)
standard-2014/   Standard (M15), 2014-07-18   (24 decks)
standard-2015/   Standard (ORI), 2015-07-17   (24 decks)
standard-2016/   Standard (EMN), 2016-07-22   (24 decks)
modern-2011/     Modern (M12), 2011-07-15     (24 decks)
modern-2012/     Modern (M13), 2012-07-13     (24 decks)
modern-2013/     Modern (M14), 2013-07-19     (24 decks)
modern-2014/     Modern (M15), 2014-07-18     (24 decks)
modern-2015/     Modern (ORI), 2015-07-17     (24 decks)
modern-2016/     Modern (EMN), 2016-07-22     (24 decks)
legacy-2005/     Legacy (9ED), 2005-08-20     (9 decks — thin season)
legacy-2006/     Legacy (CSP), 2006-08-20     (17 decks — thin season)
legacy-2007/     Legacy (10E), 2007-07-20     (24 decks)
legacy-2008/     Legacy (EVE), 2008-07-25     (24 decks)
legacy-2009/     Legacy (M10), 2009-07-17     (24 decks)
legacy-2010/     Legacy (M11), 2010-07-16     (24 decks)
legacy-2011/     Legacy (M12), 2011-07-15     (24 decks)
legacy-2012/     Legacy (M13), 2012-07-13     (24 decks)
legacy-2013/     Legacy (M14), 2013-07-19     (24 decks)
legacy-2014/     Legacy (M15), 2014-07-18     (24 decks)
legacy-2015/     Legacy (ORI), 2015-07-17     (24 decks)
legacy-2016/     Legacy (EMN), 2016-07-22     (24 decks)
pools/           GENERATED card pools, so the tests need no corpus
```

The catalog (`packages/deck/src/library/catalog.ts`) carries each era's
rationale; this file carries the tables. The *selection* — which decks these
are and why — lives one level up, in `docs/planning/deck-selection/`:
`eras.json`/`eras-modern.json`/`eras-legacy.json` name the snapshots,
`selections/selection[-<family>]-<year>.json` has the chosen decks and the
ones rejected (illegal, or a near-duplicate), `review/<year>.md` (and
`review/modern-<year>.md`, `review/legacy-<year>.md`) is the human-readable
report per era, and `review/README.md` has the rules the whole selection ran
on, across all three formats. **Re-selecting is a data edit there and a
re-run of `select_decks.py`, not a hand edit here.**

### Wave 34: replaced the old library wholesale; wave 48: three formats

Before wave 34 the picker's "eras" were eight mid-season tournament
collections, 49 decks, mostly crammed into one 18-month window
(2011-02 to 2012-08) with several of them the same archetype four times over —
and the date `2011-07-01`, a TEST fixture for the ban path, leaked into the
picker as a ninth "era" alongside them. The operator asked for the opposite
shape: one era per year, twelve decks each (where the season has them),
searched for colour and style spread rather than copied wholesale from one
event's Top 8. Wave 48 (operator: *"can we go backwards another 5yrs for
standard decks? and then also backfill modern & legacy as well?"*) extended
Standard back to 2003 and added Modern and Legacy on the same selection
strategy. `docs/planning/deck-selection/review/README.md` has the selection's
own rules, for all three formats.

### 2026-10-10: 24 per era, and every one of the 338 kept

The operator: *"it looks like generally speaking we have 12 decks for each
year. can you try to get 24?"* — same selection rules, twice the slots, and the
decks already here locked in (`select_decks.py` rule 6). Doing it found the
pools had been smaller than the seasons, for reasons that were bugs, not
scarcity:

- **Set codes.** The legality check compared Forge's set codes with the
  corpus's Scryfall ones as-is, so every Conflux card (`CFX`/`CON`) read as
  illegal — Standard 2009 had kept 4 decks of 89, and Modern lost Path to
  Exile in every era — as did Nemesis (`NMS`/`NEM`, Daze) in Legacy.
- **Names.** mtgtop8 spells split cards `Wear / Tear` and serves Latin-1, so
  split cards and `Jötun Grunt` read as unknown.
- **Incomplete lists.** `2 [] Unknown Card` lines were skipped, so a 58-card
  list passed as complete; and one Legacy list carried Brainstorm on two lines,
  8 copies. Both are rejected at selection now (60+ main, 15 sideboard, four
  copies).
- **Timeshifted reprints.** `build-library.ts` placed Time Spiral timeshifted
  reprints from a hand list of twenty; fourteen more turned up, so it reads
  Forge's own edition files instead.

Seasons that still have fewer than 24 distinct legal decks on mtgtop8 — its
competitive events and, for these, its regular ones too — are reported, not
padded: Standard 2003 (8), 2005 (7) and 2009 (11, most of that season predates
M10 and plays 10E), Legacy 2005 (9) and 2006 (17).

### 2026-10-13: as far back as the data goes

The operator: *"let's go further back with the formats, try to back as far as
possible."* What decides how far:

- **Legality data reaches 1993.** Forge's archive has Type 2/Standard from
  `1995-01-10`, Type 1.5/Legacy from `1996-05-01`, Type 1/Vintage from
  `1993-08-05` and Extended from `1997-07-01`; the gate can judge any of them.
- **Decks are the limit.** mtgtop8 — the one source this library uses, so every
  list stays citable — has Standard events from 1994 (Worlds 1994, before any
  Type 2 snapshot exists, so not an era), Modern from its first summer (2011),
  **no Legacy before 2005** (no Type 1.5 event at all) and Vintage from 2002.
  So Standard now starts at 1995 and Modern at 2011; Legacy stays at 2005.
- **Every year 1995-2002 is thin.** mtgtop8 holds two to thirteen events a
  year then (Nationals, Worlds, a Pro Tour or two), and no regular events, so
  each era has every legal, distinct list it has and no padding.
- **Type 2's own rules.** 1995 and 1996 had a restricted list, and 1995 a
  one-of-each-legendary rule; the selection and the pool fixtures both carry
  them (`restricted` in the fixture), so the gate refuses a fifth Ivory Tower
  as Forge would.
- **Two transcription cases** the older exports bring: `[] Force of Will` (no
  set) and `[PR] Arcane Denial` (a code no Forge edition has), both in one
  1996 list. `build-library.ts` places either at the newest of the era's legal
  sets Forge prints the card in (Alliances, for both).

### Colour and style, per era, and every deck

`docs/planning/deck-selection/review/README.md` has each era's colour and style
counts, and `review/<year>.md` (`review/modern-<year>.md`,
`review/legacy-<year>.md`) has every chosen deck with its finish, event,
colours, style and source. Both are generated by `tools/report.py` from the
selection. This file used to carry a hand-made copy of both — 31 tables and
338 rows — which doubling the library would have made 676 rows to keep in step
by hand, so the copy is gone and the generated docs are the one source.

### Regenerating what is derived from the library

After a selection or catalogue change, from the repo root (none needs the
corpus or the network):

```sh
node packages/deck/src/library/build-deck-costs.ts    # deck-costs.generated.ts: every played card's cost
node packages/deck/src/library/build-deck-styles.ts   # deck-styles.generated.ts: every deck's play style
```

`build-deck-styles.ts` joins each `.dck` (by its `Source URL`'s mtgtop8 deck
id) to the `style` its era's `selections/selection[-<family>]-<year>.json`
gave it, overrides already applied; the deck picker draws it as a tag. Both
maps are re-derived by their tests on every run, so forgetting either is red,
and a catalogued deck with no style in its selection fails the build.

### Three decks the selection chose could not be transcribed

Found doing it, not invented: three mtgtop8 exports in the `chosen` lists
contain a card Forge's own transcription cannot resolve to a real printing,
which `build-library.ts` throws on rather than guess at. Each was replaced by
the next alternate in its own era's selection file that did not duplicate an
archetype already chosen; the swap is recorded in the selection file itself
(`swapped_out_reason` on the rejected entry) and in `catalog.ts`'s doc comment
for that era.

| Era | Rejected | Why | Replaced with |
| --- | --- | --- | --- |
| 2011 | Ali Antrazi, UB Control (mtgtop8 213699) | `2 [] Unknown Card` in the maindeck | Xinlin Ye, Elves (mtgtop8 213651) |
| 2014 | Rob Catton, UWr Control (mtgtop8 238190) | `SB: 2 [] Unknown Card` in the sideboard | Rosmarudin Faizal, Orzhov Control (mtgtop8 246643) |
| 2014 | Albert Bayrante, Reanimator (mtgtop8 246524) | `2 [] Unknown Card` in the maindeck | Jordan Welzbacher, Jund Aggro (mtgtop8 233978) |

2014 loses its only combo-style deck this way: no alternate left in that era's
selection is combo-style, so swapping in a second one would have meant picking
a worse-scoring deck purely to keep the category, which the selection's own
rule does not ask for.

### Two transcription fixups found checking against Forge itself

`validate-library.ts` (the real corpus) reported 0 issues on every version of
this library. These two were found by a SEPARATE check that nothing else in
this repo runs by hand: every `(name, set)` pair the library plays, resolved
against **Forge's own card database** at the pinned jar
(`apps/server/src/http/library-resolve.jvm.test.ts`), which catches a set code
the corpus is indifferent to but Forge itself is not.

- **mtgtop8 spells Coldsnap `[CS]`**; the corpus and every other code in this
  library spell it `CSP`. Forge actually accepts both (`CS` is Coldsnap's
  `Code2` in Forge's own edition file) so this one is cosmetic, but normalising
  it keeps the whole transcription consistent with the corpus. Checked directly
  against the pinned jar before concluding that — see `build-library.ts`'s
  `SET_CODE_FIXUPS` doc comment.
- **Six Time Spiral "timeshifted" reprints** — Avalanche Riders, Disintegrate,
  Lord of Atlantis, Pendelhaven, Shadow Guildmage, Wall of Roots — mtgtop8
  exports all under the main set's code, `[TSP]`. Forge has NO Time Spiral
  printing of any of them; all six exist only on the timeshifted bonus sheet,
  which Forge (and Scryfall) catalogue as its own edition, `TSB`. This one is
  real: `CardDb.getCardFromSet` returns null for all six under `TSP`, checked
  directly. `build-library.ts`'s `CARD_SET_FIXUPS` has the per-card fix.

Both are in `packages/carddata/data/cards.jsonl` as `tsb`/`csp` printings
respectively, within the 2008 era's legal sets either way, so neither fixup
changes which cards are LEGAL — only which printing Forge resolves them to.
