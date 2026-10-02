# `decks/` — real decks from past Standard formats

Decklists as they were actually played, in Forge `.dck` form, each carrying the
format it is legal in, the date that format was current, and **the URL the list
was copied from**. A deck nobody can trace is a deck nobody can correct, so
`loadLibraryDeck` refuses one without a citation.

The code that reads these lives in `packages/deck/src/library/`.

## What is here

Nine power-summer eras — one per year, 2008-2016, each the Standard in force
just **before that year's fall rotation** (old block and new block legal
together), 96 decks total:

```
standard-2008/   Standard (EVE), 2008-07-25   (12 decks)
standard-2009/   Standard (M10), 2009-07-17   (4 decks)
standard-2010/   Standard (M11), 2010-07-16   (8 decks)
standard-2011/   Standard (M12), 2011-07-15   (12 decks)
standard-2012/   Standard (M13), 2012-07-13   (12 decks)
standard-2013/   Standard (M14), 2013-07-19   (12 decks)
standard-2014/   Standard (M15), 2014-07-18   (12 decks)
standard-2015/   Standard (ORI), 2015-07-17   (12 decks)
standard-2016/   Standard (EMN), 2016-07-22   (12 decks)
pools/           GENERATED card pools, so the tests need no corpus
```

The catalog (`packages/deck/src/library/catalog.ts`) carries each era's
rationale; this file carries the tables. The *selection* — which decks these
are and why — lives one level up, in `docs/planning/deck-selection/`:
`eras.json` names the nine snapshots, `selections/selection-<year>.json` has
the chosen decks and the ones it rejected (illegal, or a near-duplicate),
`review/<year>.md` is the human-readable report per era, and `review/README.md`
has the rules the whole selection ran on. **Re-selecting is a data edit there
and a re-run of `select_decks.py`, not a hand edit here.**

### Wave 34: replaced the old library wholesale

Before this wave the picker's "eras" were eight mid-season tournament
collections, 49 decks, mostly crammed into one 18-month window
(2011-02 to 2012-08) with several of them the same archetype four times over —
and the date `2011-07-01`, a TEST fixture for the ban path, leaked into the
picker as a ninth "era" alongside them. The operator asked for the opposite
shape: one era per year across the full 2008-2016 window, twelve decks each
(where the season has them), searched for colour and style spread rather than
copied wholesale from one event's Top 8. `docs/planning/deck-selection/
review/README.md` has the selection's own rules.

### Colour and style, per era

`review/README.md`'s own table, reproduced here because it is the fact this
library's five-colour test (`library.test.ts`) checks:

| Era | Format | Window | Candidates | Chosen | W | U | B | R | G | aggro | midrange | control | combo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [2008](../docs/planning/deck-selection/review/2008.md) | Standard (EVE) | 2008-07-25 → 2008-10-03 | 21 | 12 | 3 | 6 | 5 | 5 | 4 | 4 | 4 | 3 | 1 |
| [2009](../docs/planning/deck-selection/review/2009.md) | Standard (M10) | 2009-07-17 → 2009-10-02 | 4 | 4 | 2 | 1 | 3 | 1 | 2 | 3 | 0 | 1 | 0 |
| [2010](../docs/planning/deck-selection/review/2010.md) | Standard (M11) | 2010-07-16 → 2010-10-01 | 8 | 8 | 2 | 6 | 3 | 4 | 3 | 1 | 2 | 3 | 2 |
| [2011](../docs/planning/deck-selection/review/2011.md) | Standard (M12) | 2011-07-15 → 2011-09-30 | 23 | 12 | 4 | 4 | 2 | 5 | 5 | 5 | 2 | 2 | 3 |
| [2012](../docs/planning/deck-selection/review/2012.md) | Standard (M13) | 2012-07-13 → 2012-10-05 | 39 | 12 | 5 | 5 | 4 | 4 | 5 | 4 | 4 | 2 | 2 |
| [2013](../docs/planning/deck-selection/review/2013.md) | Standard (M14) | 2013-07-19 → 2013-09-27 | 38 | 12 | 7 | 5 | 7 | 6 | 7 | 4 | 3 | 3 | 2 |
| [2014](../docs/planning/deck-selection/review/2014.md) | Standard (M15) | 2014-07-18 → 2014-09-26 | 35 | 12 | 5 | 3 | 6 | 5 | 5 | 5 | 3 | 4 | 0 |
| [2015](../docs/planning/deck-selection/review/2015.md) | Standard (ORI) | 2015-07-17 → 2015-10-02 | 39 | 12 | 6 | 5 | 6 | 6 | 5 | 4 | 3 | 3 | 2 |
| [2016](../docs/planning/deck-selection/review/2016.md) | Standard (EMN) | 2016-07-22 → 2016-09-30 | 26 | 12 | 5 | 5 | 5 | 5 | 6 | 4 | 4 | 4 | 0 |
| **all** | | | | **96** | 39 | 40 | 41 | 41 | 42 | 34 | 25 | 25 | 12 |

2011 and 2014's columns are updated from the review doc's own numbers (below)
for the two decks this wave swapped out during transcription — the review was
written before those swaps and is not re-run here; re-running
`select_decks.py` would need to be told about the two failures first.

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

### Deck tables, era by era

**2008 — Standard (EVE)**, 2008-07-25 → 2008-10-03 (12 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 1st | Michael Jacob | Red Deck Wins | BR | Nationals - US 2008 | [mtgtop8 124467](https://www.mtgtop8.com/event?e=378&d=124467&f=ST) |
| 1st | Jonathan Randle | UB Faeries | UB | Nationals - Great Britain 2008 | [mtgtop8 603827](https://www.mtgtop8.com/event?e=54377&d=603827&f=ST) |
| 1st | William Cavaglieri | Torrent | BR | Nationals - Italy 2008 | [mtgtop8 124447](https://www.mtgtop8.com/event?e=379&d=124447&f=ST) |
| 1st | Masashi Oiso | UW Blink Reveillark | WU | Nationals - Japan 2008 | [mtgtop8 604753](https://www.mtgtop8.com/event?e=54478&d=604753&f=ST) |
| 1st | Tom Van Lamoen | Swans Control | UR | Nationals - Netherlands 2008 | [mtgtop8 603835](https://www.mtgtop8.com/event?e=54378&d=603835&f=ST) |
| 2nd | Sam Black | Elves | BG | Nationals - US 2008 | [mtgtop8 124468](https://www.mtgtop8.com/event?e=378&d=124468&f=ST) |
| 2nd | Akihiro Takakuwa | Gassy Knoll | R | Nationals - Japan 2008 | [mtgtop8 604754](https://www.mtgtop8.com/event?e=54478&d=604754&f=ST) |
| 3rd-4th | Russ J Davies | Doran | BG | Nationals - Great Britain 2008 | [mtgtop8 603830](https://www.mtgtop8.com/event?e=54377&d=603830&f=ST) |
| 3rd-4th | Stéphane Soubrier | Merfolks | U | Nationals - France 2008 | [mtgtop8 124461](https://www.mtgtop8.com/event?e=380&d=124461&f=ST) |
| 5th-8th | Shouhei Yamamoto | 4c Reveillark Control | WUG | Nationals - Japan 2008 | [mtgtop8 604760](https://www.mtgtop8.com/event?e=54478&d=604760&f=ST) |
| 1st | Paul Cheon | UW Pickles | WU | Grand Prix Krakow 2007 | [mtgtop8 106455](https://www.mtgtop8.com/event?e=56&d=106455&f=ST) |
| 3rd | Armin Birner | ManaRamp | RG | Grand Prix Krakow 2007 | [mtgtop8 106457](https://www.mtgtop8.com/event?e=56&d=106457&f=ST) |

**2009 — Standard (M10)**, 2009-07-17 → 2009-10-02 (4 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 1st | Mongilardi Gilles | Elf Rock | WBG | Nationals - France 2009 | [mtgtop8 151389](https://www.mtgtop8.com/event?e=439&d=151389&f=ST) |
| 2nd | Jonathan Cano | Jund Aggro | BRG | Nationals - Spain 2009 | [mtgtop8 435791](https://www.mtgtop8.com/event?e=30116&d=435791&f=ST) |
| 3rd | Guillaume Matignon | Faeries | UB | Nationals - France 2009 | [mtgtop8 151391](https://www.mtgtop8.com/event?e=439&d=151391&f=ST) |
| 3rd-4th | Hannes Kerem | Kithkins | W | Worlds 2008 (Memphis) | [mtgtop8 132879](https://www.mtgtop8.com/event?e=396&d=132879&f=ST) |

**2010 — Standard (M11)**, 2010-07-16 → 2010-10-01 (8 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 2nd | Guillaume Matignon | UR Pyromancer | UR | Championnat de France 2010 | [mtgtop8 193665](https://www.mtgtop8.com/event?e=459&d=193665&f=ST) |
| 3rd | Antoine Ruel | UG Polymorph | U | Championnat de France 2010 | [mtgtop8 193749](https://www.mtgtop8.com/event?e=459&d=193749&f=ST) |
| 1st | Emanuele Giusti | Jund | BRG | Grand Prix Bruxelles 2010 | [mtgtop8 258639](https://www.mtgtop8.com/event?e=10215&d=258639&f=ST) |
| 2nd | Isaiah Ley | U/g Polymorph | WUG | PTQ Amsterdam 2010 @ Orlando (Florida) | [mtgtop8 600898](https://www.mtgtop8.com/event?e=53972&d=600898&f=ST) |
| 5th-8th | Lucas Florent | Turboland | UG | Championnat de France 2010 | [mtgtop8 193668](https://www.mtgtop8.com/event?e=459&d=193668&f=ST) |
| 5th-8th | Adam Fox | Grixis Control | UBR | PTQ Amsterdam 2010 @ Orlando (Florida) | [mtgtop8 600901](https://www.mtgtop8.com/event?e=53972&d=600901&f=ST) |
| 5th-8th | Max Malesch | Vampires | BR | PTQ Amsterdam 2010 @ Orlando (Florida) | [mtgtop8 600902](https://www.mtgtop8.com/event?e=53972&d=600902&f=ST) |
| 5th-8th | Niels Viaene | Open Filigree | WU | Pro Tour San Diego 2010 | [mtgtop8 174124](https://www.mtgtop8.com/event?e=448&d=174124&f=ST) |

**2011 — Standard (M12)**, 2011-07-15 → 2011-09-30 (12 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 1st | Marcello Calvetta | Caw-Blade | WU | Nationals - Italy 2011 | [mtgtop8 213604](https://www.mtgtop8.com/event?e=1878&d=213604&f=ST) |
| 1st | Xinlin Ye | Elves | G | PTQ Philadelphia (Providence, Rhode Island) | [mtgtop8 213651](https://www.mtgtop8.com/event?e=1887&d=213651&f=ST) |
| 1st | Daniel Royde | Eldrazi Green | G | Nationals - Great Britain 2011 | [mtgtop8 213859](https://www.mtgtop8.com/event?e=1921&d=213859&f=ST) |
| 1st | Ryuuichiro Ishida | Tempered Steel | W | Nationals - Japan 2011 | [mtgtop8 213356](https://www.mtgtop8.com/event?e=1831&d=213356&f=ST) |
| 1st | Marc Anderson | RUG Twin Pod | URG | Nationals - Canada 2011 | [mtgtop8 213851](https://www.mtgtop8.com/event?e=1920&d=213851&f=ST) |
| 1st | Joel Calafell | UR Twin Exarch | UR | Nationals - Spain 2011 | [mtgtop8 213794](https://www.mtgtop8.com/event?e=1913&d=213794&f=ST) |
| 1st | Helge Nelson | Red deck wins | R | Nationals - Germany 2011 | [mtgtop8 213802](https://www.mtgtop8.com/event?e=1914&d=213802&f=ST) |
| 1st | Pat Cox | Valakut Ramp | RG | Star City Games Open Richmond | [mtgtop8 213773](https://www.mtgtop8.com/event?e=1910&d=213773&f=ST) |
| 1st | Luke Tsavousis | UW Control | WU | Nationals 2011 - New Zealand | [mtgtop8 213599](https://www.mtgtop8.com/event?e=1877&d=213599&f=ST) |
| 1st | James Combrink | Br Vampires | BR | Nationals 2011 - South Africa | [mtgtop8 214170](https://www.mtgtop8.com/event?e=1992&d=214170&f=ST) |
| 2nd | Fujimoto Tomoya | GW Pod | WG | Nationals - Japan 2011 | [mtgtop8 213355](https://www.mtgtop8.com/event?e=1831&d=213355&f=ST) |
| 1st | Brucehendrix | UB Infect | B | Magic-League Standard Trial | [mtgtop8 210343](https://www.mtgtop8.com/event?e=1230&d=210343&f=ST) |

**2012 — Standard (M13)**, 2012-07-13 → 2012-10-05 (12 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 1st | Todd Anderson | UW Delver | WU | Starcitygames Invitational: Atlanta | [mtgtop8 221004](https://www.mtgtop8.com/event?e=3408&d=221004&f=ST) |
| 1st | Caleb Durward | Naya Pod | WRG | Starcitygames Open Series: St. Louis | [mtgtop8 218061](https://www.mtgtop8.com/event?e=2799&d=218061&f=ST) |
| 1st | Han Kyu | BR Zombies | BR | Starcitygames Open Series: Las Vegas | [mtgtop8 218093](https://www.mtgtop8.com/event?e=2803&d=218093&f=ST) |
| 1st | CJ Steele | Infect | G | Friday Night Magic Championship @ Gen Con | [mtgtop8 218967](https://www.mtgtop8.com/event?e=2996&d=218967&f=ST) |
| 1st | Michael Lee | GW/Naya Aggro | WG | Starcitygames Open Series: Denver | [mtgtop8 219371](https://www.mtgtop8.com/event?e=3077&d=219371&f=ST) |
| 1st | John Cuvelier | Kessig Titan | RG | Starcitygames Open Series: Orlando | [mtgtop8 217700](https://www.mtgtop8.com/event?e=2740&d=217700&f=ST) |
| 1st | Jeremy Dombek | Solar Flare | WU | Starcitygames Open Series: Worcester | [mtgtop8 217870](https://www.mtgtop8.com/event?e=2762&d=217870&f=ST) |
| 1st | Levi Mochan | Tezzeret Control | UBR | PTQ Seattle (Manchester, England) | [mtgtop8 218144](https://www.mtgtop8.com/event?e=2811&d=218144&f=ST) |
| 2nd | Samy Younis | Kessig U | UG | Friday Night Magic Championship @ Gen Con | [mtgtop8 218966](https://www.mtgtop8.com/event?e=2996&d=218966&f=ST) |
| 1st | Doug Potter | UB Control | UB | States 2011 - Alberta | [mtgtop8 214807](https://www.mtgtop8.com/event?e=2137&d=214807&f=ST) |
| 1st | Mikael Conrow | GW Token | W | States 2011 - Virginia | [mtgtop8 214601](https://www.mtgtop8.com/event?e=2092&d=214601&f=ST) |
| 1st | Adam Bubacz | Zombie Pod | B | WMCQ'12 (Lodz, Poland) | [mtgtop8 217751](https://www.mtgtop8.com/event?e=2747&d=217751&f=ST) |

**2013 — Standard (M14)**, 2013-07-19 → 2013-09-27 (12 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 1st | Sean Weihe | Jund Midrange | BRG | Starcitygames Open Series: Minneapolis | [mtgtop8 231154](https://www.mtgtop8.com/event?e=5397&d=231154&f=ST) |
| 1st | Adam Van Fleet | Gruul Aggro | RG | Starcitygames Open Series: Philadelphia | [mtgtop8 232445](https://www.mtgtop8.com/event?e=5601&d=232445&f=ST) |
| 1st | nicholas mudd | Aristocrats | WB | Starcitygames Open Series: Cincinnati | [mtgtop8 232145](https://www.mtgtop8.com/event?e=5555&d=232145&f=ST) |
| 1st | Tom Strong | Reanimator | WBG | 2013 TCGplayer Open 5K - Boston | [mtgtop8 229438](https://www.mtgtop8.com/event?e=5101&d=229438&f=ST) |
| 1st | JacobGagnon | UWr Midrange | WUR | 2013 TCGplayer Open 5K - Providence | [mtgtop8 227448](https://www.mtgtop8.com/event?e=4754&d=227448&f=ST) |
| 1st | Ryan Hipp | UWx Midrange | WUR | TCGplayer MaxPoint 50k Championship - 12/1/12 | [mtgtop8 222978](https://www.mtgtop8.com/event?e=3867&d=222978&f=ST) |
| 1st | Reid Duke | Bant Control | WUG | Starcitygames Invitational: Los Angeles | [mtgtop8 223512](https://www.mtgtop8.com/event?e=3976&d=223512&f=ST) |
| 1st | Ian Kendall | Rakdos Aggro | BR | Starcitygames Open Series: Los Angeles | [mtgtop8 223517](https://www.mtgtop8.com/event?e=3977&d=223517&f=ST) |
| 1st | Joe Lossett | Human Reanimator | WBRG | Starcitygames Open Series: San Diego | [mtgtop8 224468](https://www.mtgtop8.com/event?e=4187&d=224468&f=ST) |
| 1st | Todd Anderson | UWR Control | WU | Starcitygames Open : Cincinnati | [mtgtop8 221569](https://www.mtgtop8.com/event?e=3570&d=221569&f=ST) |
| 1st | Othon Voutsis | Golgari Control | BG | Topdecker.gr - Balkan Magic 1k | [mtgtop8 232822](https://www.mtgtop8.com/event?e=5661&d=232822&f=ST) |
| 1st | Thomas McVeigh | BUG Persist Aggro | UBG | Grand Prix Trial London Winners | [mtgtop8 225223](https://www.mtgtop8.com/event?e=4326&d=225223&f=ST) |

**2014 — Standard (M15)**, 2014-07-18 → 2014-09-26 (12 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 1st | Mik Red | Devotion to Blue | UB | WMCQ - Philippines #1 | [mtgtop8 246522](https://www.mtgtop8.com/event?e=8074&d=246522&f=ST) |
| 1st | Dan Jessup | Devotion to Black | B | Starcitygames Open Series: Baltimore | [mtgtop8 245126](https://www.mtgtop8.com/event?e=7839&d=245126&f=ST) |
| 1st | Scott Lipp | Selesnya Aggro | WG | Starcitygames Open Series: Kansas City | [mtgtop8 245535](https://www.mtgtop8.com/event?e=7915&d=245535&f=ST) |
| 1st | Manuel Orellana | Red Deck Wins | R | StarCityGames.com Standard - Atlanta | [mtgtop8 247035](https://www.mtgtop8.com/event?e=8168&d=247035&f=ST) |
| 1st | Jonas Zimmermann | Golgari Control | BG | WMCQ - Hanau, Germany | [mtgtop8 246532](https://www.mtgtop8.com/event?e=8076&d=246532&f=ST) |
| 1st | Omar Beldon | UW Control | WU | CMT2014  Toronto | [mtgtop8 241955](https://www.mtgtop8.com/event?e=7323&d=241955&f=ST) |
| 1st | Gerard Fabiano | Esper Control | WUB | Starcitygames Open Series: Worcester | [mtgtop8 244573](https://www.mtgtop8.com/event?e=7746&d=244573&f=ST) |
| 1st | Neil Hartman | Boros Aggro | WR | Starcitygames Open Series: Seattle | [mtgtop8 239470](https://www.mtgtop8.com/event?e=6869&d=239470&f=ST) |
| 1st | Zach Stern | Gruul Team | RG | Starcitygames Open Series: Milwaukee | [mtgtop8 233753](https://www.mtgtop8.com/event?e=5810&d=233753&f=ST) |
| 1st | Hal Brady | Devotion to Green | RG | Starcitygames Open Series: Dallas | [mtgtop8 234696](https://www.mtgtop8.com/event?e=5981&d=234696&f=ST) |
| 1st | Rosmarudin Faizal | Orzhov Control | WB | WMCQ - Singapore #2 | [mtgtop8 246643](https://www.mtgtop8.com/event?e=8094&d=246643&f=ST) |
| 1st | Jordan Welzbacher | Jund Aggro | BRG | Michigan State Championship 2013 | [mtgtop8 233978](https://www.mtgtop8.com/event?e=5854&d=233978&f=ST) |

**2015 — Standard (ORI)**, 2015-07-17 → 2015-10-02 (12 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 1st | Andrea Mengucci | Abzan Midrange | WBG | WMCQ 1 - Italy | [mtgtop8 259324](https://www.mtgtop8.com/event?e=10377&d=259324&f=ST) |
| 1st | Jory White | Red Deck Wins | R | SCG Standard Open - Milwaukee | [mtgtop8 260298](https://www.mtgtop8.com/event?e=10534&d=260298&f=ST) |
| 1st | Alex Bastecki | Devotion to Green | RG | SCG Invitational Somerset | [mtgtop8 259417](https://www.mtgtop8.com/event?e=10386&d=259417&f=ST) |
| 1st | Robert Sabol | Jeskai Midrange | WUR | SCG Standard Open Somerset | [mtgtop8 259368](https://www.mtgtop8.com/event?e=10383&d=259368&f=ST) |
| 1st | Michael Deidolori | Esper Control | UB | SCG Standard Open Worcester | [mtgtop8 260057](https://www.mtgtop8.com/event?e=10488&d=260057&f=ST) |
| 1st | ryota09 | UR Artifacts | UR | MTGO Standard Champs (#8654170) | [mtgtop8 259388](https://www.mtgtop8.com/event?e=10384&d=259388&f=ST) |
| 1st | Ray Tautic | Abzan Rally | WBG | SCG Standard Open - Richmond | [mtgtop8 258338](https://www.mtgtop8.com/event?e=10133&d=258338&f=ST) |
| 1st | Alejandro Dupuy de Lome | Mardu Aggro | WBR | WMCQ 1 - Spain | [mtgtop8 259578](https://www.mtgtop8.com/event?e=10409&d=259578&f=ST) |
| 1st | David Jones | Abzan Control | WBG | RPTQ Vancouver @ Greensboro | [mtgtop8 255724](https://www.mtgtop8.com/event?e=9689&d=255724&f=ST) |
| 1st | Yoon Soo Han | UB Control | UB | PTQ - Tarukiru Dragon Kiden (Japan) | [mtgtop8 252157](https://www.mtgtop8.com/event?e=9129&d=252157&f=ST) |
| 1st | Marco Panteghini | See the Unwritten | G | RPTQ Vancouver @ Roma (Italy) | [mtgtop8 255344](https://www.mtgtop8.com/event?e=9634&d=255344&f=ST) |
| 1st | Michael Earnshaw | Jeskai Ascendancy | WUR | Grand Prix Toronto 2015 - Trial Winners | [mtgtop8 255564](https://www.mtgtop8.com/event?e=9663&d=255564&f=ST) |

**2016 — Standard (EMN)**, 2016-07-22 → 2016-09-30 (12 decks)

| Finish | Player | Archetype | Colours | Event | Source |
| --- | --- | --- | --- | --- | --- |
| 1st | Finespoo | Collected Bant | WUG | MTGO Standard MOCS | [mtgtop8 279191](https://www.mtgtop8.com/event?e=13472&d=279191&f=ST) |
| 1st | Osyp Lebedowicz | Selesnya Aggro | WG | StarCityGames.com Open Baltimore | [mtgtop8 277153](https://www.mtgtop8.com/event?e=13174&d=277153&f=ST) |
| 1st | Jacob Hagen | Simic Ramp | UG | StarCityGames.com Standard - Richmond | [mtgtop8 278960](https://www.mtgtop8.com/event?e=13444&d=278960&f=ST) |
| 1st | BradPitKeeper | Weenie White | W | MTGO Standard MOCS | [mtgtop8 275022](https://www.mtgtop8.com/event?e=12896&d=275022&f=ST) |
| 1st | Aya_ | Grixis Control | UBR | MTGO Standard Champs | [mtgtop8 272579](https://www.mtgtop8.com/event?e=12568&d=272579&f=ST) |
| 1st | Joshua Dickerson | Green Ramp | RG | StarCityGames.com Standard Open - Columbus | [mtgtop8 269873](https://www.mtgtop8.com/event?e=12173&d=269873&f=ST) |
| 1st | Todd Anderson | Izzet Machinegun | UR | SCG Classic - Syracuse | [mtgtop8 278382](https://www.mtgtop8.com/event?e=13370&d=278382&f=ST) |
| 1st | BradPitKeeper | Mono Black Aggro | UB | MTGO Standard PTQ | [mtgtop8 278999](https://www.mtgtop8.com/event?e=13451&d=278999&f=ST) |
| 2nd | Wakizaka Hironari | Naya PW | WRG | 7th Standard God Challenger Finals | [mtgtop8 277757](https://www.mtgtop8.com/event?e=13253&d=277757&f=ST) |
| 1st | Edvin Marsson | Orzhov Control | WB | Grand Prix Manchester 2016 - Trial Winners | [mtgtop8 272415](https://www.mtgtop8.com/event?e=12550&d=272415&f=ST) |
| 1st | Lucas Giuliani | Golgari Control | BG | Grand Prix Toronto 2016 - Trial Winners | [mtgtop8 270517](https://www.mtgtop8.com/event?e=12251&d=270517&f=ST) |
| 1st | Fujiwara Takashi | Mardu Control | BR | Standard @ Hareruya | [mtgtop8 270468](https://www.mtgtop8.com/event?e=12243&d=270468&f=ST) |

## `pools/`

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
| `standard-2008-07-25.generated.json` | Standard (EVE), effective 2008-07-25 | 2146 | — |
| `standard-2009-07-17.generated.json` | Standard (M10), effective 2009-07-17 | 1624 | — |
| `standard-2010-07-16.generated.json` | Standard (M11), effective 2010-07-16 | 1477 | — |
| `standard-2011-07-15.generated.json` | Standard (M12), effective 2011-07-15 | 1511 | Jace, the Mind Sculptor; Stoneforge Mystic |
| `standard-2012-07-13.generated.json` | Standard (M13), effective 2012-07-13 | 1592 | — |
| `standard-2013-07-19.generated.json` | Standard (M14), effective 2013-07-19 | 1686 | — |
| `standard-2014-07-18.generated.json` | Standard (M15), effective 2014-07-18 | 1653 | — |
| `standard-2015-07-17.generated.json` | Standard (ORI), effective 2015-07-17 | 1702 | — |
| `standard-2016-07-22.generated.json` | Standard (EMN), effective 2016-07-22 | 1441 | — |

The 2011 pool is not decoration: 2010's UG Polymorph (Antoine Ruel) plays four
Jace, the Mind Sculptor, legal when it was played and banned the moment this
pool's Standard takes effect a year later — `library.test.ts`'s "the failure
path" checks that real cross-era history reports the right card, with no
tampering.

## Re-deriving the decks

```sh
node packages/deck/src/library/build-library.ts                  # every era, needs the network
node packages/deck/src/library/build-library.ts --only=2011       # one era, by year
node packages/deck/src/library/build-library.ts --cache=<dir>     # a local .dec export cache, checked first
```

It reads `docs/planning/deck-selection/eras.json` and that era's
`selections/selection-<year>.json`, fetches mtgtop8's own plain-text export for
each `chosen` deck id (or reads it from the cache), and writes the `.dck`
through `writeDck`, so the committed files are by construction in the form the
loader puts back out — `library.test.ts` asserts that round trip byte-for-byte.
It throws rather than guess at a line it cannot parse (which is how the three
swaps above were found) and applies the two fixups above during the parse,
never by editing a Forge file.

## Checking them against the real corpus

```sh
node --max-old-space-size=6144 packages/deck/src/library/validate-library.ts \
  --cards=<path to cards.jsonl>              # exit 0: every deck legal on its own date (96 decks, 0 issues)
```

## Checking them against Forge itself

```sh
CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
  pnpm exec vitest run apps/server/src/http/library-resolve.jvm.test.ts   # every (name,set) pair, exact printing
CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
  pnpm exec vitest run apps/server/src/http/library-match.jvm.test.ts     # a real match per era, serially
```

## House rules that apply here

- **A `.dck` is text and stays text.** No card images, ever — not a byte, not a
  URL. `.gitignore` refuses `*.jpg`, `*.png` and `cards/` and that half is
  absolute.
- **No WotC trademarks.** Card names are the names of the cards; nothing here
  reproduces mana symbols, set symbols or card frames.
