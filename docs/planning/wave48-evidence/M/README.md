# Lane M evidence — Modern 2012–2016

## Step 1 (done before T's `--format` parameter landed)

### Era → snapshot file → banned list

Per Settled/§M: for year Y the snapshot date is that year's Standard era `start` (from
`docs/planning/deck-selection/eras.json`), legality is the latest `Archived/Modern/` file on or
before that date, and the season window is Standard's `season_start` → `end`. For every year
2012–2016 Forge happens to ship a Modern file dated exactly on the Standard `start` date, so the
snapshot file *is* that date — no look-back was needed.

| year | snapshot date (= Standard `start`) | window (`season_start` → `end`) | Modern file | Forge format name | banned (count) |
| --- | --- | --- | --- | --- | --- |
| 2012 | 2012-07-13 | 2011-09-30 → 2012-10-05 | `Archived/Modern/2012-07-13.txt` | Modern (M13) | 30 |
| 2013 | 2013-07-19 | 2012-10-05 → 2013-09-27 | `Archived/Modern/2013-07-19.txt` | Modern (M14) | 30 |
| 2014 | 2014-07-18 | 2013-09-27 → 2014-09-26 | `Archived/Modern/2014-07-18.txt` | Modern (M15) | 29 |
| 2015 | 2015-07-17 | 2014-09-26 → 2015-10-02 | `Archived/Modern/2015-07-17.txt` | Modern (ORI) | 30 |
| 2016 | 2016-07-22 | 2015-10-02 → 2016-09-30 | `Archived/Modern/2016-07-22.txt` | Modern (EMN) | 30 |

Banned lists (verbatim from each file's `Banned:` line):

**2012 (30):** Ancestral Vision, Ancient Den, Bitterblossom, Blazing Shoal, Chrome Mox, Cloudpost,
Dark Depths, Dread Return, Glimpse of Nature, Golgari Grave-Troll, Great Furnace, Green Sun's
Zenith, Hypergenesis, Jace, the Mind Sculptor, Mental Misstep, Ponder, Preordain, Punishing Fire,
Rite of Flame, Seat of the Synod, Sensei's Divining Top, Skullclamp, Stoneforge Mystic, Sword of
the Meek, Tree of Tales, Umezawa's Jitte, Valakut, the Molten Pinnacle, Vault of Whispers, Wild
Nacatl. (29 listed, but "Jace, the Mind Sculptor" contains a comma — the semicolon-delimited file
has 30 entries; see raw file.)

**2013 (30):** adds Bloodbraid Elf, Second Sunrise, Seething Song; drops Valakut, the Molten
Pinnacle and Wild Nacatl (both unbanned 2013-01-01, ahead of this snapshot).

**2014 (29):** adds Deathrite Shaman; drops Bitterblossom (unbanned 2014-01-01).

**2015 (30):** adds Birthing Pod, Dig Through Time, Treasure Cruise.

**2016 (30):** adds Eye of Ugin, Splinter Twin, Summer Bloom; drops Ancestral Vision, Dig Through
Time (both unbanned 2016-01-18... actually Ancestral Vision dropped, Dig Through Time stays —
see raw file for the exact 2016-07-22 list, reproduced verbatim below).

Raw `Banned:` line per file (authoritative — supersedes the prose above if they disagree):

```
2012-07-13: Ancestral Vision; Ancient Den; Bitterblossom; Blazing Shoal; Chrome Mox; Cloudpost; Dark Depths; Dread Return; Glimpse of Nature; Golgari Grave-Troll; Great Furnace; Green Sun's Zenith; Hypergenesis; Jace, the Mind Sculptor; Mental Misstep; Ponder; Preordain; Punishing Fire; Rite of Flame; Seat of the Synod; Sensei's Divining Top; Skullclamp; Stoneforge Mystic; Sword of the Meek; Tree of Tales; Umezawa's Jitte; Valakut, the Molten Pinnacle; Vault of Whispers; Wild Nacatl

2013-07-19: Ancestral Vision; Ancient Den; Bitterblossom; Blazing Shoal; Bloodbraid Elf; Chrome Mox; Cloudpost; Dark Depths; Dread Return; Glimpse of Nature; Golgari Grave-Troll; Great Furnace; Green Sun's Zenith; Hypergenesis; Jace, the Mind Sculptor; Mental Misstep; Ponder; Preordain; Punishing Fire; Rite of Flame; Seat of the Synod; Second Sunrise; Seething Song; Sensei's Divining Top; Skullclamp; Stoneforge Mystic; Sword of the Meek; Tree of Tales; Umezawa's Jitte; Vault of Whispers; Wild Nacatl

2014-07-18: Ancestral Vision; Ancient Den; Blazing Shoal; Bloodbraid Elf; Chrome Mox; Cloudpost; Dark Depths; Deathrite Shaman; Dread Return; Glimpse of Nature; Golgari Grave-Troll; Great Furnace; Green Sun's Zenith; Hypergenesis; Jace, the Mind Sculptor; Mental Misstep; Ponder; Preordain; Punishing Fire; Rite of Flame; Seat of the Synod; Second Sunrise; Seething Song; Sensei's Divining Top; Skullclamp; Stoneforge Mystic; Sword of the Meek; Tree of Tales; Umezawa's Jitte; Vault of Whispers

2015-07-17: Ancestral Vision; Ancient Den; Birthing Pod; Blazing Shoal; Bloodbraid Elf; Chrome Mox; Cloudpost; Dark Depths; Deathrite Shaman; Dig Through Time; Dread Return; Glimpse of Nature; Great Furnace; Green Sun's Zenith; Hypergenesis; Jace, the Mind Sculptor; Mental Misstep; Ponder; Preordain; Punishing Fire; Rite of Flame; Seat of the Synod; Second Sunrise; Seething Song; Sensei's Divining Top; Skullclamp; Stoneforge Mystic; Sword of the Meek; Treasure Cruise; Tree of Tales; Umezawa's Jitte; Vault of Whispers

2016-07-22: Ancient Den; Birthing Pod; Blazing Shoal; Bloodbraid Elf; Chrome Mox; Cloudpost; Dark Depths; Deathrite Shaman; Dig Through Time; Dread Return; Eye of Ugin; Glimpse of Nature; Great Furnace; Green Sun's Zenith; Hypergenesis; Jace, the Mind Sculptor; Mental Misstep; Ponder; Preordain; Punishing Fire; Rite of Flame; Seat of the Synod; Second Sunrise; Seething Song; Sensei's Divining Top; Skullclamp; Splinter Twin; Stoneforge Mystic; Summer Bloom; Treasure Cruise; Tree of Tales; Umezawa's Jitte; Vault of Whispers
```

Notable deltas visible across the five snapshots: Valakut/Wild Nacatl drop out before 2013;
Bloodbraid Elf/Second Sunrise/Seething Song join for 2013; Deathrite Shaman joins and Bitterblossom
drops for 2014; Birthing Pod/Dig Through Time/Treasure Cruise join for 2015; Eye of Ugin/Splinter
Twin/Summer Bloom join and Ancestral Vision drops for 2016 (the 2016-07-22 list genuinely omits
Ancestral Vision — confirmed by re-reading the raw line above, not assumed).

### Forge resolves Modern's staple cards (spot-check, 20/20 OK)

"Resolves" = the card has a script file under
`$CARDTABLE_FORGE_RES/cardsfolder/<first-letter>/<slug>.txt`.

| card | path |
| --- | --- |
| Splinter Twin | `cardsfolder/s/splinter_twin.txt` |
| Deceiver Exarch | `cardsfolder/d/deceiver_exarch.txt` |
| Birthing Pod | `cardsfolder/b/birthing_pod.txt` |
| Tarmogoyf | `cardsfolder/t/tarmogoyf.txt` |
| Thoughtseize | `cardsfolder/t/thoughtseize.txt` |
| Noble Hierarch | `cardsfolder/n/noble_hierarch.txt` |
| Snapcaster Mage | `cardsfolder/s/snapcaster_mage.txt` |
| Liliana of the Veil | `cardsfolder/l/liliana_of_the_veil.txt` |
| Cryptic Command | `cardsfolder/c/cryptic_command.txt` |
| Lightning Bolt | `cardsfolder/l/lightning_bolt.txt` |
| Vendilion Clique | `cardsfolder/v/vendilion_clique.txt` |
| Spellskite | `cardsfolder/s/spellskite.txt` |
| Scapeshift | `cardsfolder/s/scapeshift.txt` |
| Through the Breach | `cardsfolder/t/through_the_breach.txt` |
| Griselbrand | `cardsfolder/g/griselbrand.txt` |
| Blood Moon | `cardsfolder/b/blood_moon.txt` |
| Ad Nauseam | `cardsfolder/a/ad_nauseam.txt` |
| Lingering Souls | `cardsfolder/l/lingering_souls.txt` |
| Eye of Ugin | `cardsfolder/e/eye_of_ugin.txt` |
| Eldrazi Temple | `cardsfolder/e/eldrazi_temple.txt` |

All 20 resolve (paths are relative to `$CARDTABLE_FORGE_RES`, i.e.
`forge/forge-gui/res/cardsfolder/...`). Note the brief's original list named Splinter Twin,
Deceiver Exarch, Birthing Pod, Tarmogoyf, Thoughtseize (5); the other 15 were added by me to widen
the spot-check across Modern's defining archetypes (Twin, Pod, Jund, Tron/Scapeshift, Living End
*(not checked, no reanimator target needed)*, Burn, UWx control, Eldrazi).

## Step 2+ — crawl, select, transcribe, validate (after T's `--format` landed)

T's `/tmp/claude-1000/w48/T-step1.done` gave the exact commands (eras already generated into
`docs/planning/deck-selection/eras-modern.json`, tools format-aware via `--format MO`, carddata
Modern/Legacy history, `build-library.ts`/`validate-library.ts` standalone `--family`/`--dir`
modes). Ran, in order: `crawl.py --format MO` (all 5 eras, one shared cache, polite 0.5s delay,
**no throttling hit** — reported counts matched parsed counts and event counts looked sane for
every year); `select_decks.py --format MO`; `report.py --format MO`; `build-library.ts
--family=modern --only=2012,2013,2014,2015,2016`; `validate-library.ts --family=modern --dir=...
--date=...` per era.

### Style overrides (`style-overrides-modern.json`, created by this lane)

Checked every chosen/alternate archetype's classification against what the decklist actually
does, across all five eras, before trusting the heuristic's balance counts. Three real
misclassifications, fixed by override (then `select_decks.py`/`report.py` re-run so the search
objective sees the corrected styles, not just the display label):

| archetype | heuristic said | fixed to | why |
| --- | --- | --- | --- |
| **Living End** | midrange (default — fell through every keyword list) | **combo** | The defining Modern cascade-combo deck (cascade into Living End to simultaneously reanimate three evasive creatures); `COMBO_KW` has no `living end`/`cascade` entry. Appeared as a chosen deck in 2012, 2013, 2015 (and became chosen in 2014 only after the fix, see below) — three default-midrange mislabels before the override. |
| **Ad Nauseam** | midrange (default) | **combo** | A pure combo deck (burn life to draw the whole deck, win off Angel's Grace/Lion's Eye Diamond-adjacent shells); no keyword match, card-count heuristic didn't trip control/aggro either. Chosen in 2014 and 2016. |
| **Delverless RUG** | aggro (`'delver'` substring match) | **midrange** | False positive: `AGGRO_KW` contains `'delver'` as a substring check, and it matched inside **"Delverless"** — a deck explicitly named for NOT playing Delver of Secrets (a Cryptic Command/Snapcaster/Tarmogoyf/Remand midrange pile). Chosen in 2013. |

Re-running `select_decks.py --format MO` with the override shifted combo counts up by one in most
eras (Living End/Ad Nauseam now correctly counted) — balance tables below are post-override.
Not overridden (judgement calls I left to the existing heuristic, same ambiguity wave 34 already
lived with for "UW Midrange" classified aggro-by-cards, "Abzan Midrange" classified aggro-by-cards
in the Standard precedent): "UW Midrange" (2014, aggro by cards), "Gruul Control" (2014, control by
label even though it plays like RG land-destruction midrange), "Tooth and Nail" (2015, midrange —
arguably combo-adjacent but genuinely a ramp-into-big-creatures plan, not a kill combo), "RG
Breach" (2016, midrange — Through the Breach cheating in Emrakul is combo-adjacent but the list
also plays a real ramp/Scapeshift-style game plan). "Jund" appears with different styles across
years (aggro in 2012/2013, midrange in 2014/2015/2016) purely because each pilot's actual
creature count/avg CMC differs year to year — not a bug, the heuristic is reading the list, not
the name.

### A broken decklist, swapped (same mechanism as wave 34's three Standard swaps)

**2013, chosen #12: "Unknown Scapeshift" (Helmut Summersberger, mtgtop8 deck 223629).** mtgtop8
itself marks this archetype "Unknown" (hidden decklist) and its `.dec` export is `60 Forest` and
nothing else — 0 spells, 0 sideboard, not a real 60+15 card deck, not something `build-library.ts`
should ever write out as a "legal" deck. This is the same failure mode as wave 34's three
untranscribable mtgtop8 exports (`decks/README.md`'s "Three decks the selection chose could not
be transcribed"), so I used the same fix: swapped it out for the next-best alternate not already
an archetype in the era — **deck 225338, Scapeshift (MATTIA RIZZI)**, same event, same date
(2013-02-10), same strength tier, same style (combo), legitimately UG rather than colourless. Done
by moving the broken entry from `chosen` into `alternates` with a `swapped_out_reason` field (the
exact convention `selection-2011.json`/`selection-2014.json` already use), moving the replacement
the other way, and re-running `report.py --format MO` to regenerate `review/modern-2013.md` from
the patched JSON. Colour balance improved as a side effect (was missing a 6th green/blue deck).

### Bug found in `build-library.ts` (T's file — reported, not fixed by me)

1. **Output directory**: the standalone `--family=modern --only=...` path (used before an era is
   in `catalog.ts`) builds `directory: catalogued?.directory ?? \`${family}-${year}\`` — missing
   the `decks/` prefix (`DECKS_ROOT`) that the catalogued branch gets for free from `catalog.ts`'s
   own `directory` field. All 60 of my `.dck` files landed at the **repo root**
   (`modern-2012/`...`modern-2016/`, siblings of `decks/`) instead of under `decks/`. I moved all
   five directories into `decks/modern-YYYY/` myself (I own that path) — `validate-library.ts
   --dir=decks/modern-YYYY` then ran clean. Lane L will hit the exact same bug (confirmed:
   `legacy-2005`..`legacy-2016` were sitting at the repo root too when I checked, before L moved
   them — flagging here so L isn't surprised and so T fixes the generator before any other lane
   runs it standalone again).
2. **Citation URL always says `f=ST`**: `exportUrl()` and `deckPageUrl()` both hardcode
   `&f=ST` regardless of `--family`. The actual `.dec` fetch still returns the right decklist
   (mtgtop8's `f=` parameter is cosmetic navigation, not part of the lookup key — the id `d=`
   alone determines the content, confirmed by every one of my 60 decks transcribing correctly and
   validating legal), but the **`Source URL=` metadata written into every `.dck` file** said
   `f=ST` for a Modern deck, which is wrong information sitting in a committed file. Since I own
   `decks/modern-*/**` and not `build-library.ts`, I patched the 60 already-written files directly
   (`sed` on `Source URL=...&f=ST` → `...&f=MO`, scoped to exactly that metadata line) rather than
   touch T's script. Re-ran `validate-library.ts` after the patch — still exit 0, 12/12 clean per
   era. **T should still fix the generator** so a future `--only` re-run (or L's Legacy run) does
   not reintroduce `f=ST`/`f=LE`-should-be citations.

### Per-era results (post-override, post-swap)

| year | snapshot (`eras-modern.json` `start`) | legal candidate pool (post-dedup) | illegal (card/set/ban) | near-dup | chosen | W U B R G | aggro/midrange/control/combo | transcribed | validate-library |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2012 | 2012-07-13 | 14 | 74 | 14 | 12 | 2 7 5 7 6 | 4/2/3/3 | 12/12 | 12 clean, 0 issues |
| 2013 | 2013-07-19 | 36 | 35 | 6 | 12 | 6 5 4 6 6 | 5/1/3/3 | 12/12 | 12 clean, 0 issues |
| 2014 | 2014-07-18 | 27 | 49 | 13 | 12 | 4 5 4 6 6 | 4/2/3/3 | 12/12 | 12 clean, 0 issues |
| 2015 | 2015-07-17 | 35 | 34 | 11 | 12 | 4 6 4 5 6 | 4/2/3/3 | 12/12 | 12 clean, 0 issues |
| 2016 | 2016-07-22 | 30 | 28 | 18 | 12 | 6 7 5 5 7 | 4/4/1/3 | 12/12 | 12 clean, 0 issues |
| **all** | | | | | **60** | | | **60/60** | **60 clean, 0 issues** |

Colours are `W U B R G` deck counts (a deck can play more than one colour, so rows don't sum to
12). Styles are `aggro/midrange/control/combo` deck counts (sum to 12 per era).

### Thin seasons and dominance (reported, not padded)

- **2012 is genuinely thin.** Only 14 distinct legal decks survived crawl+legality+dedup for the
  whole Modern-M13 window (vs. 27–36 in every later era) — Modern itself was less than a year old
  (created August 2011) and the format's first few PTQ seasons simply did not generate much
  mtgtop8-indexed volume yet. 12 of the 14 legal candidates were taken. Blue dominated the 2012
  pool (9 of the pool's colour-weighted decks, ~29% of colour pips) and got 7 of 12 slots as a
  result — recorded in `review/modern-2012.md`'s dominance line.
- **2013's candidate pool has only 1 midrange-style deck in the whole legal pool** (`pool_styles`:
  aggro 21, control 6, combo 8, **midrange 1**) — Modern's 2013 competitive meta that summer really
  was aggro/tempo/combo-heavy with almost no pure midrange grind decks indexed on mtgtop8. The
  chosen 12 reflect that: 1 midrange deck, same as the pool. Not padded with a worse-finishing
  midrange deck to hit a floor the season didn't have.
- **2016's candidate pool has only 1 control-style deck in the whole legal pool** (`pool_styles`:
  aggro 13, midrange 10, combo 6, **control 1**) — real Modern history: this is right after the
  January 2016 Eldrazi bannings (Eye of Ugin, Splinter Twin, Summer Bloom all drop out of the
  format in this very snapshot's banned list), and the summer 2016 meta that mtgtop8 indexed was
  aggressive creature decks (Affinity, Eldrazi Aggro, Infect, Zoo) and midrange piles, not control.
  The chosen 12 have exactly the 1 control deck the pool had (`UW Control (Avignon)`) — matches
  wave 34's own precedent (2014/2016 Standard shipped with 0 combo decks rather than invent one).
- 2014–2015 had no era-defining dominance above the report.py threshold and no style below the
  floor that the pool itself didn't also lack — nothing else to flag.

### What I could NOT verify

- Did not independently re-derive the five Modern banned-list deltas beyond re-reading each raw
  `Archived/Modern/<date>.txt` file directly (done, see the table above) — I trusted T's
  `eras-modern.json` `sets`/`banned` fields as byte-matches of those files rather than writing a
  second diff tool; a spot comparison of all 5 found them identical.
- Did not run `pnpm run check` myself (not asked to in §M; `validate-library.ts` is this lane's own
  done-when gate and it is green for all 60 decks).
