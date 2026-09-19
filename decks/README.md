# `decks/` — real decks from past Standard formats

Decklists as they were actually played, in Forge `.dck` form, each carrying the
format it is legal in, the date that format was current, and **the URL the list
was copied from**. A deck nobody can trace is a deck nobody can correct, so
`loadLibraryDeck` refuses one without a citation.

The code that reads these lives in `packages/deck/src/library/`.

## What is here

```
standard-2011-02-13-pt-paris/            Pro Tour Paris 2011, Standard (MBS), complete Top 8 (8 decks)
standard-2011-05-14-scg-orlando/         SCG Open Orlando 2011, Standard (NPH), one per archetype (6)
standard-2011-08-14-scg-richmond/        SCG Open Richmond 2011, Standard (M12), one per archetype (6)
standard-2011-10-30-gp-hiroshima/        GP Hiroshima 2011, Standard (ISD), the era's black deck (1)
standard-2011-11-20-worlds/              Worlds 2011, Standard (ISD), complete Top 8 (8)
standard-2012-02-12-pt-dark-ascension/   PT Dark Ascension 2012, Standard (DKA), complete Top 8 (8)
standard-2012-06-16-scg-indianapolis/    SCG Open Indianapolis 2012, Standard (AVR), one per archetype (6)
standard-2012-08-11-scg-kansas-city/     SCG Open Kansas City 2012, Standard (M13), one per archetype (6)
pools/                                   GENERATED card pools, so the tests need no corpus
```

The catalog (`packages/deck/src/library/catalog.ts`) carries each collection's
rationale; this file carries the tables.

### Coverage of the window

The operator's window is New Phyrexia to Return to Ravnica, 2011-05-13 to
2012-10-05. Every Standard snapshot in it now has decks, and every era's set
fields all five colours by basic land — both are asserted in `library.test.ts`.

| Effective | Era | Collection | Decks |
| --- | --- | --- | --- |
| 2011-02-04 | Standard (MBS) — *before the window* | PT Paris 2011 | 8 |
| 2011-05-13 | Standard (NPH) | SCG Open Orlando 2011 | 6 |
| 2011-07-15 | Standard (M12) | SCG Open Richmond 2011 | 6 |
| 2011-09-30 | Standard (ISD) | GP Hiroshima 2011 + Worlds 2011 | 1 + 8 |
| 2012-02-03 | Standard (DKA) | PT Dark Ascension 2012 | 8 |
| 2012-05-04 | Standard (AVR) | SCG Open Indianapolis 2012 | 6 |
| 2012-07-13 | Standard (M13) | SCG Open Kansas City 2012 | 6 |

`Standard (2011-07-01)` — the two-week row between NPH and M12 that banned
Jace, the Mind Sculptor and Stoneforge Mystic — has a pool and no collection; it
is the library's ban-path fixture, not an era anyone played a season in.

### The four era collections

Each is **one StarCityGames Open's Top 8, cut to the best-placed deck of each
archetype as mtgtop8 labels it** — so a mirror-heavy Top 8 (four Caw-Blades,
five Delvers) yields the decks that can actually play each other, and the rule
still leaves nobody choosing. The archetype is mtgtop8's label verbatim; joint
placings resolve in the order the event page lists them. Opens rather than
Grand Prix because, era by era, the Open was the event whose cut fielded all
five colours; `catalog.ts` names the GPs that were checked and what each lacked.

All four were transcribed by `build-library.ts` from mtgtop8's own export and
checked against the real corpus with `validate-library.ts` (0 issues).

**Standard (NPH)** — [SCG Open Orlando, 2011-05-14](https://www.mtgtop8.com/event?e=1571&f=ST), 318 players

| # | Player | Archetype | Colours | Source |
| - | ------ | --------- | ------- | ------ |
| 1st | Edgar Flores | Caw-Blade | WU | [mtgtop8 212091](https://www.mtgtop8.com/event?e=1571&d=212091&f=ST) |
| 2nd | Michael Strunk | Grixis Twin Exarch | UBR | [mtgtop8 212092](https://www.mtgtop8.com/event?e=1571&d=212092&f=ST) |
| 3rd | Tim Landale | RUG Twin Exarch | URG | [mtgtop8 212093](https://www.mtgtop8.com/event?e=1571&d=212093&f=ST) |
| 4th | Kitt Holland | Kozilek Caw-Blade | WUB | [mtgtop8 212094](https://www.mtgtop8.com/event?e=1571&d=212094&f=ST) |
| 7th | Aadil Qadir | Br Vampires | BR | [mtgtop8 212097](https://www.mtgtop8.com/event?e=1571&d=212097&f=ST) |
| 8th | Miguel Rondon | Valakut Ramp | RG | [mtgtop8 212098](https://www.mtgtop8.com/event?e=1571&d=212098&f=ST) |

**Standard (M12)** — [SCG Open Richmond, 2011-08-14](https://www.mtgtop8.com/event?e=1910&f=ST), 411 players

| # | Player | Archetype | Colours | Source |
| - | ------ | --------- | ------- | ------ |
| 1st | Pat Cox | Valakut Ramp | RG | [mtgtop8 213773](https://www.mtgtop8.com/event?e=1910&d=213773&f=ST) |
| 2nd | Kyle Rose | Caw-Blade | WU | [mtgtop8 213774](https://www.mtgtop8.com/event?e=1910&d=213774&f=ST) |
| 3rd-4th | Shaheen Soorani | UB Control | UB | [mtgtop8 213775](https://www.mtgtop8.com/event?e=1910&d=213775&f=ST) |
| 5th-8th | Thomas Cole | Boros Landfall | WR | [mtgtop8 213779](https://www.mtgtop8.com/event?e=1910&d=213779&f=ST) |
| 5th-8th | Robbie Auchter | Red Deck Wins | R | [mtgtop8 213777](https://www.mtgtop8.com/event?e=1910&d=213777&f=ST) |
| 5th-8th | Ian Shore | RUG Pod | URG | [mtgtop8 213780](https://www.mtgtop8.com/event?e=1910&d=213780&f=ST) |

Cole's maindeck is 62 cards, as registered.

**Standard (AVR)** — [SCG Open Indianapolis, 2012-06-16](https://www.mtgtop8.com/event?e=2767&f=ST), 497 players

| # | Player | Archetype | Colours | Source |
| - | ------ | --------- | ------- | ------ |
| 1st | Ross Merriam | UW Delver | WU | [mtgtop8 217906](https://www.mtgtop8.com/event?e=2767&d=217906&f=ST) |
| 2nd | Michael Marlow | BU Zombies | UB | [mtgtop8 217907](https://www.mtgtop8.com/event?e=2767&d=217907&f=ST) |
| 3rd-4th | Dan Musser | RUG Pod | URG | [mtgtop8 217910](https://www.mtgtop8.com/event?e=2767&d=217910&f=ST) |
| 5th-8th | Logan Mize | Kessig Titan | RG | [mtgtop8 217912](https://www.mtgtop8.com/event?e=2767&d=217912&f=ST) |
| 5th-8th | Robbie Cordell | Solar Flare | WUB | [mtgtop8 217909](https://www.mtgtop8.com/event?e=2767&d=217909&f=ST) |
| 5th-8th | Ian Farnung | Tezzeret Control | UB | [mtgtop8 217913](https://www.mtgtop8.com/event?e=2767&d=217913&f=ST) |

Marlow's maindeck is 61 cards, as registered.

**Standard (M13)** — [SCG Open Kansas City, 2012-08-11](https://www.mtgtop8.com/event?e=2814&f=ST), 396 players

| # | Player | Archetype | Colours | Source |
| - | ------ | --------- | ------- | ------ |
| 1st | Mike Prokop | UW Delver | WU | [mtgtop8 218164](https://www.mtgtop8.com/event?e=2814&d=218164&f=ST) |
| 2nd | Nick Marriott | Mono Green Infect | G | [mtgtop8 218165](https://www.mtgtop8.com/event?e=2814&d=218165&f=ST) |
| 3rd-4th | Robert Berni | Blue Kessig | URG | [mtgtop8 218167](https://www.mtgtop8.com/event?e=2814&d=218167&f=ST) |
| 3rd-4th | Eric Holmes | Naya Pod | WRG | [mtgtop8 218166](https://www.mtgtop8.com/event?e=2814&d=218166&f=ST) |
| 5th-8th | Scott Ouderkirk | Gr Aggro | RG | [mtgtop8 218169](https://www.mtgtop8.com/event?e=2814&d=218169&f=ST) |
| 5th-8th | Matthew Dennis | Zombie Pod | UBG | [mtgtop8 218171](https://www.mtgtop8.com/event?e=2814&d=218171&f=ST) |

"Colours" is the colours the mana base is built to cast, read off basics and
dual lands. It is a summary for a person picking a deck; the test's five-colour
check reads basic lands only, because card colour misleads (Phyrexian mana puts
Dismember and Gitaxian Probe in decks that never tap black or blue).

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
| `standard-2011-05-14.generated.json` | Standard (NPH), effective 2011-05-13 | 1369 | — |
| `standard-2011-07-01.generated.json` | Standard (2011-07-01), effective 2011-07-01 | 1367 | Jace, the Mind Sculptor; Stoneforge Mystic |
| `standard-2011-08-14.generated.json` | Standard (M12), effective 2011-07-15 | 1511 | Jace, the Mind Sculptor; Stoneforge Mystic |
| `standard-2011-10-30.generated.json` | Standard (ISD), effective 2011-09-30 | 1021 | — |
| `standard-2011-11-20.generated.json` | Standard (ISD), effective 2011-09-30 | 1021 | — |
| `standard-2012-02-12.generated.json` | Standard (DKA), effective 2012-02-03 | 1177 | — |
| `standard-2012-06-16.generated.json` | Standard (AVR), effective 2012-05-04 | 1405 | — |
| `standard-2012-08-11.generated.json` | Standard (M13), effective 2012-07-13 | 1592 | — |

The second pool is not decoration. It is the Standard that banned Jace and
Stoneforge, and all eight of these decks play at least one of the two — so the
library carries its own real-data proof that the ban path reports the right
card, without anything being tampered with.

## Re-deriving the decks

```sh
node packages/deck/src/library/build-library.ts      # needs the network
```

`--only=<collection id>` limits it to one collection. It covers PT Paris and
the four SCG Open collections; re-running it over PT Paris on 2026-09-18
reproduced all eight committed files byte-for-byte. It fetches mtgtop8's own
plain-text export for each deck id and writes the
`.dck` through `writeDck`, so the committed files are by construction in the
form the loader puts back out — `library.test.ts` asserts that round trip
byte-for-byte.

## Checking them against the real corpus

```sh
node --max-old-space-size=6144 packages/deck/src/library/validate-library.ts \
  --cards=<path to cards.jsonl>              # exit 0: every deck legal on its own date (49 decks, 0 issues)
node --max-old-space-size=6144 packages/deck/src/library/validate-library.ts \
  --cards=<path to cards.jsonl> --date=2011-07-01   # exit 1: 12 banned-card issues, by name
```

## House rules that apply here

- **A `.dck` is text and stays text.** No card images, ever — not a byte, not a
  URL. `.gitignore` refuses `*.jpg`, `*.png` and `cards/` and that half is
  absolute.
- **No WotC trademarks.** Card names are the names of the cards; nothing here
  reproduces mana symbols, set symbols or card frames.
