# `decks/` — real decks from past Standard formats

Decklists as they were actually played, in Forge `.dck` form, each carrying the
format it is legal in, the date that format was current, and **the URL the list
was copied from**. A deck nobody can trace is a deck nobody can correct, so
`loadLibraryDeck` refuses one without a citation.

The code that reads these lives in `packages/deck/src/library/`.

## What is here

```
standard-2011-02-13-pt-paris/   Pro Tour Paris 2011, Standard, the complete Top 8 (8 decks)
pools/                          GENERATED card pools, so the tests need no corpus
```

### `standard-2011-02-13-pt-paris/`

Eight decks: the whole Top 8 of the Standard portion of Pro Tour Paris 2011,
in finishing order. A complete Top 8 rather than a hand-picked eight, because
"the Top 8 of one event" has an unambiguous membership test and nobody has to
wonder what was left out. Four of the eight are Mystic Caw Go; that is what the
Top 8 was.

| # | Player | Archetype | Source |
| - | ------ | --------- | ------ |
| 1st | Ben Stark | Mystic Caw Go | [mtgtop8 209238](https://www.mtgtop8.com/event?e=1016&d=209238&f=ST) |
| 2nd | Paul Rietzl | Boros Landfall | [mtgtop8 209239](https://www.mtgtop8.com/event?e=1016&d=209239&f=ST) |
| 3rd-4th | Vincent Lemoine | Boros Landfall | [mtgtop8 209236](https://www.mtgtop8.com/event?e=1016&d=209236&f=ST) |
| 3rd-4th | Naoki Nakada | Mystic Caw Go | [mtgtop8 209242](https://www.mtgtop8.com/event?e=1016&d=209242&f=ST) |
| 5th-8th | Nico Bohny | Fauna Quest | [mtgtop8 209237](https://www.mtgtop8.com/event?e=1016&d=209237&f=ST) |
| 5th-8th | Tom Martell | Mystic Caw Go | [mtgtop8 209241](https://www.mtgtop8.com/event?e=1016&d=209241&f=ST) |
| 5th-8th | Shintaro Ishimura | Mystic Caw Go | [mtgtop8 209243](https://www.mtgtop8.com/event?e=1016&d=209243&f=ST) |
| 5th-8th | Patrick Chapin | Tezzeret Control | [mtgtop8 209240](https://www.mtgtop8.com/event?e=1016&d=209240&f=ST) |

Event page: <https://www.mtgtop8.com/event?e=1016&f=ST>.

Each file repeats its own row in its `[metadata]` section, which is the copy
that counts — the table above is a convenience and the files are the data.

**The date.** Every file carries `Effective=2011-02-13`, the date mtgtop8 files
the event under. The tournament ran 11-13 February 2011 and the Standard rounds
were on the first two days, so 11 February would be defensible too; the source's
own date was chosen so the deck and the citation cannot disagree. It makes no
difference to legality — the snapshot in force is `Standard (MBS)`, effective
2011-02-04 and superseded 2011-05-13, and all three dates fall inside it.

**Cross-check.** The MTG Salvation archive thread for this Top 8 was read as a
second source. It agrees with mtgtop8 exactly on seven of the eight lists. On
Ben Stark's it reads one Sword of Body and Mind in the maindeck where mtgtop8
reads one Sword of Feast and Famine (both agree on the sideboard's Sword of
Body and Mind). That single card is unresolved: the thread is behind Cloudflare
and could not be read directly, and web.archive.org was returning 503 during
this work, so the official coverage page could not be consulted. The committed
file follows mtgtop8, which is the cited source. Either card is legal in the
format, so this does not affect any validation result.

### `pools/`

**GENERATED — do not hand-edit.** Each file is a `standardPoolAt` result
computed against the real Scryfall corpus and frozen, so
`packages/deck/src/library/library.test.ts` can validate real decklists against
a real pool in CI, where `packages/carddata/data/cards.jsonl` (183 MB,
gitignored) does not exist. The same posture, and the same reason, as
`packages/carddata/src/formats/standard-pool.json`. Regenerate with:

```sh
node --max-old-space-size=6144 packages/deck/src/library/build-pool-fixture.ts \
  --cards=<path to cards.jsonl>
```

| File | Format | Cards | Banned |
| ---- | ------ | ----- | ------ |
| `standard-2011-02-13.generated.json` | Standard (MBS), effective 2011-02-04 | 1204 | — |
| `standard-2011-07-01.generated.json` | Standard (2011-07-01), effective 2011-07-01 | 1367 | Jace, the Mind Sculptor; Stoneforge Mystic |

The second pool is not decoration. It is the Standard that banned Jace and
Stoneforge, and all eight of these decks play at least one of the two — so the
library carries its own real-data proof that the ban path reports the right
card, without anything being tampered with.

## Re-deriving the decks

```sh
node packages/deck/src/library/build-library.ts      # needs the network
```

It fetches mtgtop8's own plain-text export for each deck id and writes the
`.dck` through `writeDck`, so the committed files are by construction in the
form the loader puts back out — `library.test.ts` asserts that round trip
byte-for-byte.

## Checking them against the real corpus

```sh
node --max-old-space-size=6144 packages/deck/src/library/validate-library.ts \
  --cards=<path to cards.jsonl>              # exit 0: every deck legal on its own date
node --max-old-space-size=6144 packages/deck/src/library/validate-library.ts \
  --cards=<path to cards.jsonl> --date=2011-07-01   # exit 1: 12 banned-card issues, by name
```

## House rules that apply here

- **A `.dck` is text and stays text.** No card images, ever — not a byte, not a
  URL. `.gitignore` refuses `*.jpg`, `*.png` and `cards/` and that half is
  absolute.
- **No WotC trademarks.** Card names are the names of the cards; nothing here
  reproduces mana symbols, set symbols or card frames.
