# Deck selection review — "power summers", Standard 2003–2016, Modern and Legacy

One era per year per format: for Standard, the format in force **just before the fall rotation**, when the old block and the new one are legal together. Modern and Legacy do not rotate, so their eras are pinned to the same year’s Standard era’s own dates (wave 48, Settled) — same season window, snapshot taken from the latest dated Modern/Legacy format file on or before that date.

## How the decks were chosen

1. **Candidates:** every deck from a competitive-level event (Pro Tour, Worlds, Grand Prix, Nationals, SCG Opens, PTQs; not online dailies) in the season before that fall rotation, from [mtgtop8](https://www.mtgtop8.com). Events inside the summer window count more than earlier ones. A season whose competitive events cannot fill the era also takes mtgtop8’s **regular** events (local tournaments); they carry the fewest stars, so they only ever fill gaps.
2. **One deck per archetype**, the one that went furthest (a bigger event counts more). **No near-duplicates:** two lists count as the same deck when they share 60% of their cards, or 45% and the same colours, or 30% and the same archetype name.
3. **Legal in that era**, checked card by card against Forge's own format file (legal sets and bans) — ST's own dated Standard file, MO/LE's latest dated file on or before the era's snapshot date.
4. **Colour spread:** the chosen decks are searched so each of the five colours is played by about the same number of them (a colour may sit 2 decks off the mean for free). Colours are read from mana costs, not from the archetype name.
5. **Style spread:** at least 4 decks of each style when the era has them, at most 10 of any one, and the targets lean toward the rarer styles.
6. **Strength still counts:** within those limits the search maximises how well the decks actually placed. 24 decks per era where the season has them — **thin seasons are reported, not padded** (fewer than 24 legal candidates means a smaller era).
7. **Balance, but true to the season:** a colour or style that dominated an era’s candidate pool may take an extra slot or two — flagged per era below with its pool share as evidence, never invented to fill a colour/style the season barely played.
8. **The library only grows:** a re-run keeps every deck the era’s previous selection chose that is still a legal, distinct candidate, and fills around it — 12 per era became 24 on 2026-10-10 without dropping one.

**Legality is checked in Scryfall’s set codes.** Forge’s format files name sets in Forge’s codes and the card corpus is Scryfall’s; until 2026-10-10 the two were compared as-is, so every Conflux card (`CFX`/`CON`) and every Nemesis card in Legacy (`NMS`/`NEM`) read as illegal, and split cards (`Wear / Tear`) and accented names (`Jötun Grunt`) as unknown. `tools/analyze.py` maps the codes through Forge’s own edition files now.

Tunable in `tools/select_decks.py`; re-run and the review regenerates. **Style is a heuristic** (creature count, average cost, counterspells and sweepers, plus archetype names); each format section’s table shows how every deck was judged. Wrong ones can be fixed in `style-overrides.json` (Standard), `style-overrides-modern.json`, `style-overrides-legacy.json`.

**676 decks across 31 eras.**

## Standard eras

| era | format | window | distinct legal decks to choose from | chosen | W | U | B | R | G | aggro | midrange | control | combo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [2003](2003.md) | Standard (8ED) | 2003-09-01 → 2003-10-20 | 8 | 8 | 3 | 2 | 2 | 5 | 3 | 3 | 1 | 3 | 1 |
| [2004](2004.md) | Standard (5DN) | 2004-06-20 → 2004-10-20 | 25 | 24 | 7 | 8 | 6 | 13 | 8 | 5 | 10 | 9 | 0 |
| [2005](2005.md) | Standard (9ED) | 2005-08-20 → 2005-10-20 | 7 | 7 | 1 | 2 | 1 | 1 | 2 | 4 | 1 | 2 | 0 |
| [2006](2006.md) | Standard (CSP) | 2006-08-20 → 2006-10-20 | 28 | 24 | 10 | 12 | 9 | 10 | 11 | 10 | 6 | 8 | 0 |
| [2007](2007.md) | Standard (10E) | 2007-07-20 → 2007-10-20 | 27 | 24 | 10 | 12 | 9 | 11 | 12 | 6 | 8 | 6 | 4 |
| [2008](2008.md) | Standard (EVE) | 2008-07-25 → 2008-10-03 | 27 | 24 | 3 | 11 | 11 | 10 | 11 | 9 | 8 | 6 | 1 |
| [2009](2009.md) | Standard (M10) | 2009-07-17 → 2009-10-02 | 11 | 11 | 6 | 5 | 8 | 6 | 6 | 4 | 4 | 3 | 0 |
| [2010](2010.md) | Standard (M11) | 2010-07-16 → 2010-10-01 | 27 | 24 | 16 | 12 | 5 | 10 | 11 | 8 | 7 | 7 | 2 |
| [2011](2011.md) | Standard (M12) | 2011-07-15 → 2011-09-30 | 44 | 24 | 7 | 10 | 7 | 10 | 8 | 7 | 5 | 7 | 5 |
| [2012](2012.md) | Standard (M13) | 2012-07-13 → 2012-10-05 | 65 | 24 | 12 | 9 | 10 | 9 | 12 | 8 | 6 | 6 | 4 |
| [2013](2013.md) | Standard (M14) | 2013-07-19 → 2013-09-27 | 78 | 24 | 15 | 11 | 12 | 13 | 14 | 8 | 6 | 7 | 3 |
| [2014](2014.md) | Standard (M15) | 2014-07-18 → 2014-09-26 | 50 | 24 | 13 | 9 | 13 | 9 | 12 | 7 | 8 | 8 | 1 |
| [2015](2015.md) | Standard (ORI) | 2015-07-17 → 2015-10-02 | 75 | 24 | 10 | 11 | 11 | 13 | 13 | 8 | 8 | 5 | 3 |
| [2016](2016.md) | Standard (EMN) | 2016-07-22 → 2016-09-30 | 45 | 24 | 11 | 9 | 9 | 11 | 12 | 8 | 9 | 7 | 0 |
| **all** | | | | **290** | 124 | 123 | 113 | 131 | 135 | 95 | 87 | 84 | 24 |

### Standard: how each archetype was judged (style)

| era | deck | style | judged by |
| --- | --- | --- | --- |
| 2003 | Wake | control | cards |
| 2003 | UG Madness | midrange | default |
| 2003 | Black-white Control | control | label |
| 2003 | Red-green Beats | aggro | cards |
| 2003 | Goblins | aggro | label |
| 2003 | Goblin Bidding | aggro | label |
| 2003 | Astral Slide | control | cards |
| 2003 | Reanimator | combo | label |
| 2004 | Affinity | aggro | label |
| 2004 | Goblins | aggro | label |
| 2004 | UW Control | control | label |
| 2004 | Tooth And Nail | midrange | default |
| 2004 | Obliterate March | control | cards |
| 2004 | Rude March | midrange | default |
| 2004 | Red Land Loss | midrange | default |
| 2004 | RG Beasts with LL | midrange | default |
| 2004 | Death Cloud | midrange | default |
| 2004 | GW Astral Control | control | label |
| 2004 | RG Beats | midrange | default |
| 2004 | Read the Goblin Bidding | aggro | label |
| 2004 | BR Big Red | midrange | default |
| 2004 | Incubator Charbelcher | control | cards |
| 2004 | UR Obliterate | control | cards |
| 2004 | G/w Control | control | label |
| 2004 | Ponza | midrange | default |
| 2004 | Morphs Anonymous | aggro | cards |
| 2004 | BG Cemetery | midrange | default |
| 2004 | March Of The Machines | control | cards |
| 2004 | R/g Beasts | aggro | cards |
| 2004 | 26 Crazy Cards | midrange | default |
| 2004 | Naya Control | control | label |
| 2004 | KCI | control | cards |
| 2005 | Viridian Rats | aggro | cards |
| 2005 | Tooth and Nail | midrange | default |
| 2005 | Red Aggro | aggro | label |
| 2005 | Mono Blue Tron | control | cards |
| 2005 | Jushi Blue | control | cards |
| 2005 | White Weenie | aggro | label |
| 2005 | Mono Green Aggro | aggro | label |
| 2006 | Structure And Force | midrange | default |
| 2006 | Solar Flare | midrange | default |
| 2006 | Heartbeat | control | cards |
| 2006 | Sea Stompy | aggro | cards |
| 2006 | Wu Weenie | aggro | label |
| 2006 | Gruul Aggro | aggro | label |
| 2006 | Sand Burn | aggro | label |
| 2006 | Bg Demonfire | aggro | cards |
| 2006 | Snakes | midrange | default |
| 2006 | Izzetron | control | cards |
| 2006 | U/r Magnivore | control | cards |
| 2006 | Junk | aggro | cards |
| 2006 | Hand In Hand | aggro | cards |
| 2006 | Zoo | aggro | label |
| 2006 | Boros Aggro | aggro | label |
| 2006 | Ghazi Glare | midrange | default |
| 2006 | Gruul Beats | aggro | cards |
| 2006 | Enduring Ideal | control | cards |
| 2006 | Greater Good | midrange | default |
| 2006 | Orzhov Control | control | label |
| 2006 | Owling Mine | control | cards |
| 2006 | Critical Mass | midrange | default |
| 2006 | UB Control | control | label |
| 2006 | UR Tron | control | cards |
| 2007 | Goyf Rack | midrange | default |
| 2007 | Wur Blink | combo | label |
| 2007 | RDW 2k7 | aggro | label |
| 2007 | OmniChord | midrange | default |
| 2007 | Rakdos VI | midrange | default |
| 2007 | Angelfire | midrange | default |
| 2007 | Swath Storm | combo | label |
| 2007 | Dredge-Bridge II | combo | label |
| 2007 | Solar Flare IIII | midrange | default |
| 2007 | Project X | aggro | cards |
| 2007 | UBw Pickles | midrange | default |
| 2007 | MGA | aggro | cards |
| 2007 | UBr Teachings | control | cards |
| 2007 | Korlash Black | midrange | default |
| 2007 | Blink | combo | label |
| 2007 | UW Control | control | label |
| 2007 | UB Teachings - Dralnu Style | control | cards |
| 2007 | Rakdos 10 (Gargadon on Bob) | midrange | default |
| 2007 | Rg Aggro VII | aggro | label |
| 2007 | Glare | aggro | cards |
| 2007 | Uwr Control | control | label |
| 2007 | Glitering Wish Control/Seismic Loam Goyf | control | label |
| 2007 | Gruul II | aggro | cards |
| 2007 | Blanche Neige | control | cards |
| 2008 | Red Deck Wins | aggro | label |
| 2008 | UB Faeries | control | label |
| 2008 | Torrent | aggro | label |
| 2008 | UW Blink Reveillark | combo | label |
| 2008 | Swans Control | control | label |
| 2008 | Quick 'n Toast | control | label |
| 2008 | Elves | aggro | label |
| 2008 | Gassy Knoll | midrange | default |
| 2008 | Doran | midrange | default |
| 2008 | Merfolks | aggro | cards |
| 2008 | 4c Reveillark Control | control | label |
| 2008 | GR Aggro | aggro | label |
| 2008 | Doran Rock | aggro | cards |
| 2008 | UW Pickles | midrange | default |
| 2008 | MUC Guile | control | cards |
| 2008 | Mannequin | midrange | default |
| 2008 | ManaRamp | midrange | default |
| 2008 | Mana Ramp | midrange | default |
| 2008 | Tarmo Rack | midrange | default |
| 2008 | Teachings | control | cards |
| 2008 | Goblins | aggro | label |
| 2008 | Red Death | aggro | cards |
| 2008 | Rg Aggro | aggro | label |
| 2008 | Scryb & Force | midrange | default |
| 2009 | Cruel Control | control | label |
| 2009 | Elf Rock | aggro | cards |
| 2009 | Blightning | midrange | default |
| 2009 | Jund Aggro | aggro | label |
| 2009 | Faeries | control | label |
| 2009 | Red Deck Wins | aggro | label |
| 2009 | Time Sieve | control | cards |
| 2009 | Kithkins | aggro | label |
| 2009 | 5C Blood | midrange | default |
| 2009 | Big Druid Deck | midrange | default |
| 2009 | 5C Elementals | midrange | default |
| 2010 | UW Control | control | label |
| 2010 | Naya Lightsaber | aggro | cards |
| 2010 | UR Pyromancer | control | cards |
| 2010 | UG Polymorph | combo | label |
| 2010 | Jund | midrange | default |
| 2010 | Mythic Conscription | midrange | default |
| 2010 | Next Level Bant | midrange | default |
| 2010 | U/g Polymorph | combo | label |
| 2010 | Red Deck Wins | aggro | label |
| 2010 | Turboland | control | label |
| 2010 | Grixis Control | control | label |
| 2010 | Vampires | aggro | label |
| 2010 | UWr Walker | control | cards |
| 2010 | Naya | aggro | cards |
| 2010 | White Weenie | aggro | label |
| 2010 | Boros | aggro | cards |
| 2010 | Eldrazi Jund | midrange | default |
| 2010 | BGW Angels | midrange | default |
| 2010 | Open Filigree | midrange | default |
| 2010 | Mono W Tokens | aggro | cards |
| 2010 | Bant | midrange | default |
| 2010 | Brilliant Ultimatum | control | cards |
| 2010 | Naya Allies | aggro | cards |
| 2010 | Turbo Fog | control | cards |
| 2011 | Caw-Blade | control | cards |
| 2011 | Eldrazi Green | midrange | default |
| 2011 | Tempered Steel | aggro | label |
| 2011 | RUG Twin Pod | combo | label |
| 2011 | UR Twin Exarch | combo | label |
| 2011 | Red deck wins | aggro | label |
| 2011 | UB Control | control | label |
| 2011 | Valakut Ramp | midrange | default |
| 2011 | UW Control | control | label |
| 2011 | Br Vampires | aggro | label |
| 2011 | Elves | aggro | label |
| 2011 | Goblins Deck Wins | aggro | label |
| 2011 | Puresteel Paladin | midrange | default |
| 2011 | Pyromancer Ascension | control | cards |
| 2011 | GW Pod | combo | label |
| 2011 | Tezzeret Control | control | label |
| 2011 | UB Infect | aggro | label |
| 2011 | Elf Aggro | aggro | label |
| 2011 | UW Shape Anew | control | cards |
| 2011 | Mono Black Control | control | label |
| 2011 | Boros con Pod | combo | label |
| 2011 | Naya Pod | combo | label |
| 2011 | Big Jund | midrange | default |
| 2011 | Torpor Tezz | midrange | default |
| 2012 | UW Delver | aggro | label |
| 2012 | Naya Pod | combo | label |
| 2012 | BR Zombies | aggro | label |
| 2012 | Infect | aggro | label |
| 2012 | GW/Naya Aggro | aggro | label |
| 2012 | Kessig Titan | midrange | default |
| 2012 | Solar Flare | midrange | default |
| 2012 | Gr Aggro | aggro | label |
| 2012 | Tezzeret Control | control | label |
| 2012 | Naya Aggro | aggro | label |
| 2012 | Kessig U | midrange | default |
| 2012 | Genesis Wave | aggro | cards |
| 2012 | UB Control | control | label |
| 2012 | Esper Control | control | label |
| 2012 | GW Token | midrange | default |
| 2012 | Mono Black Infect | aggro | label |
| 2012 | FRites | midrange | default |
| 2012 | RUG Control | control | label |
| 2012 | Unsolar Flare | control | cards |
| 2012 | Birthing Pod | combo | label |
| 2012 | Zombie Pod | combo | label |
| 2012 | RUG Pod | combo | label |
| 2012 | Esper Midrange | midrange | default |
| 2012 | Mono Black Control | control | label |
| 2013 | Jund Midrange | midrange | default |
| 2013 | Gruul Aggro | aggro | label |
| 2013 | Aristocrats | aggro | cards |
| 2013 | Naya | aggro | cards |
| 2013 | Red Deck Wins | aggro | label |
| 2013 | Reanimator | combo | label |
| 2013 | UWr Midrange | midrange | default |
| 2013 | UWx Midrange | midrange | default |
| 2013 | Bant Hexproof | aggro | label |
| 2013 | Bant Control | control | label |
| 2013 | Rakdos Aggro | aggro | label |
| 2013 | Prime Speaker Bant | midrange | default |
| 2013 | Human Reanimator | combo | label |
| 2013 | Tokens | midrange | default |
| 2013 | UWr Control | control | label |
| 2013 | UWR Control | control | label |
| 2013 | Golgari Control | control | label |
| 2013 | Esper Control | control | label |
| 2013 | Rakdos Control | control | label |
| 2013 | BUG Persist Aggro | aggro | label |
| 2013 | Jund Aggro | aggro | label |
| 2013 | URG Control | control | label |
| 2013 | Weird Reanimator | combo | label |
| 2013 | 4CC Griffin | midrange | default |
| 2014 | Devotion to Blue | aggro | cards |
| 2014 | Devotion to Black | midrange | default |
| 2014 | Orzhov Control | control | label |
| 2014 | Selesnya Aggro | aggro | label |
| 2014 | Red Deck Wins | aggro | label |
| 2014 | Golgari Control | control | label |
| 2014 | UW Control | control | label |
| 2014 | Esper Control | control | label |
| 2014 | Boros Aggro | aggro | label |
| 2014 | Jund Aggro | aggro | label |
| 2014 | Gruul Team | midrange | default |
| 2014 | Devotion to Green | midrange | default |
| 2014 | Naya Aura | midrange | default |
| 2014 | Bant Control | control | label |
| 2014 | Boros  Aggro | aggro | label |
| 2014 | Jund | midrange | default |
| 2014 | WR Burn | aggro | label |
| 2014 | UWr Control | control | label |
| 2014 | Esper Midrange | midrange | default |
| 2014 | 4c PW Control | control | label |
| 2014 | Reanimator | combo | label |
| 2014 | Orzhov Devotion | midrange | default |
| 2014 | BUG Control | control | label |
| 2014 | Prime Speaker Bant | midrange | default |
| 2015 | Abzan Midrange | aggro | cards |
| 2015 | Devotion to Green | midrange | default |
| 2015 | Red Deck Wins | aggro | label |
| 2015 | Jeskai Midrange | midrange | default |
| 2015 | Mardu Aggro | aggro | label |
| 2015 | Esper Control | control | label |
| 2015 | UR Artifacts | aggro | cards |
| 2015 | Abzan Rally | combo | label |
| 2015 | Jeskai Tempo | midrange | default |
| 2015 | Abzan Control | control | label |
| 2015 | UB Control | control | label |
| 2015 | Gruul Deck Wins | midrange | default |
| 2015 | Boros Aggro | aggro | label |
| 2015 | Temur Aggro | aggro | label |
| 2015 | Sultai Whip | midrange | default |
| 2015 | Gruul Dragons | aggro | cards |
| 2015 | Sultai Control | control | label |
| 2015 | Jund | midrange | default |
| 2015 | Golgari Aggro | aggro | label |
| 2015 | Full Dragons | control | cards |
| 2015 | Naya Dragons | midrange | default |
| 2015 | See the Unwritten | midrange | default |
| 2015 | Jeskai Ascendancy | combo | label |
| 2015 | Sultai Reanimator | combo | label |
| 2016 | Collected Bant | midrange | default |
| 2016 | Selesnya Aggro | aggro | label |
| 2016 | Simic Ramp | midrange | default |
| 2016 | Weenie White | aggro | label |
| 2016 | Grixis Control | control | label |
| 2016 | Green Ramp | midrange | default |
| 2016 | Izzet Machinegun | aggro | label |
| 2016 | Mono Black Aggro | aggro | label |
| 2016 | Sultai Midrange | midrange | default |
| 2016 | Naya PW | midrange | default |
| 2016 | Orzhov Control | control | label |
| 2016 | Izzet Control | control | label |
| 2016 | 4c Rites | midrange | default |
| 2016 | Goggles Ramp | control | cards |
| 2016 | Golgari Control | control | label |
| 2016 | Orzhov Aggro | aggro | label |
| 2016 | Mardu Control | control | label |
| 2016 | Naya Aggro | aggro | label |
| 2016 | Mono U Prison | control | cards |
| 2016 | Azorius Midrange | midrange | default |
| 2016 | White Eldrazi | aggro | cards |
| 2016 | Boros Aggro | aggro | label |
| 2016 | Naya | midrange | default |
| 2016 | Jund | midrange | default |

## Modern eras

| era | format | window | distinct legal decks to choose from | chosen | W | U | B | R | G | aggro | midrange | control | combo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [2012](modern-2012.md) | Modern (M13) | 2012-07-13 → 2012-10-05 | 59 | 24 | 13 | 13 | 9 | 10 | 10 | 8 | 6 | 6 | 4 |
| [2013](modern-2013.md) | Modern (M14) | 2013-07-19 → 2013-09-27 | 49 | 24 | 12 | 12 | 9 | 11 | 12 | 9 | 4 | 5 | 6 |
| [2014](modern-2014.md) | Modern (M15) | 2014-07-18 → 2014-09-26 | 58 | 24 | 10 | 11 | 8 | 11 | 9 | 7 | 6 | 5 | 6 |
| [2015](modern-2015.md) | Modern (ORI) | 2015-07-17 → 2015-10-02 | 64 | 24 | 10 | 13 | 9 | 9 | 13 | 7 | 6 | 6 | 5 |
| [2016](modern-2016.md) | Modern (EMN) | 2016-07-22 → 2016-09-30 | 68 | 24 | 11 | 14 | 10 | 14 | 12 | 8 | 6 | 5 | 5 |
| **all** | | | | **120** | 56 | 63 | 45 | 55 | 56 | 39 | 28 | 27 | 26 |

### Modern: how each archetype was judged (style)

| era | deck | style | judged by |
| --- | --- | --- | --- |
| 2012 | Jund | aggro | cards |
| 2012 | Twin Exarch | combo | label |
| 2012 | Gr Tron | control | cards |
| 2012 | Birthing Pod | combo | label |
| 2012 | Affinity | aggro | label |
| 2012 | Caw-Blade | midrange | default |
| 2012 | Faeries | control | label |
| 2012 | Boros | aggro | cards |
| 2012 | Aggro Loam | aggro | label |
| 2012 | RUG Tempo | midrange | default |
| 2012 | UB Delver | aggro | label |
| 2012 | Red Deck Wins | aggro | label |
| 2012 | Living End | combo | override |
| 2012 | BW Tokens | midrange | default |
| 2012 | Gift Control | control | label |
| 2012 | Naya Zoo | aggro | label |
| 2012 | Next Level U | midrange | default |
| 2012 | Gifts Tron | control | cards |
| 2012 | GW Tokens | midrange | default |
| 2012 | UW Angel | midrange | default |
| 2012 | Doran | aggro | cards |
| 2012 | Esper Control | control | label |
| 2012 | Dredgevine | combo | label |
| 2012 | Gift Tron | control | cards |
| 2013 | Affinity | aggro | label |
| 2013 | Jund | aggro | cards |
| 2013 | Birthing Pod | combo | label |
| 2013 | UWr Midrange | control | cards |
| 2013 | Twin Exarch | combo | label |
| 2013 | Scapeshift | combo | label |
| 2013 | Gr Tron | control | cards |
| 2013 | Red Deck Wins | aggro | label |
| 2013 | Infect Combo | combo | label |
| 2013 | Gift Control | control | label |
| 2013 | UW Control | control | label |
| 2013 | Living End | combo | override |
| 2013 | Doran & Junk | aggro | cards |
| 2013 | Martyr Life | aggro | cards |
| 2013 | UW Angel | aggro | cards |
| 2013 | Delverless RUG | midrange | override |
| 2013 | Zombie | aggro | label |
| 2013 | BW Hatebear | aggro | cards |
| 2013 | Boros | aggro | cards |
| 2013 | UWx Midrange | control | cards |
| 2013 | UR Storm | combo | label |
| 2013 | Boom Naya | midrange | default |
| 2013 | Deathcloud | midrange | default |
| 2013 | Esper Tapout | midrange | default |
| 2014 | Birthing Pod | combo | label |
| 2014 | U Tron | control | cards |
| 2014 | Twin Exarch | combo | label |
| 2014 | Jund | midrange | default |
| 2014 | The Rock | midrange | default |
| 2014 | Scapeshift | combo | label |
| 2014 | UWr Midrange | midrange | default |
| 2014 | Hatebear | aggro | cards |
| 2014 | UW Midrange | aggro | cards |
| 2014 | Red Deck Wins | aggro | label |
| 2014 | Burn | aggro | label |
| 2014 | Gr Tron | control | cards |
| 2014 | Merfolk | aggro | cards |
| 2014 | UR Storm | combo | label |
| 2014 | Blue Moon | control | cards |
| 2014 | Ad Nauseam | combo | override |
| 2014 | Martyr Life | aggro | cards |
| 2014 | Mono vert stompy | aggro | cards |
| 2014 | Gruul Control | control | label |
| 2014 | Living End | combo | override |
| 2014 | Faeries | control | label |
| 2014 | Orzhov Midrange | midrange | default |
| 2014 | UW Gift Tron | midrange | default |
| 2014 | BW Tokens | midrange | default |
| 2015 | Affinity | aggro | label |
| 2015 | Jund | midrange | default |
| 2015 | Bloom Titan | midrange | default |
| 2015 | Gr Tron | control | cards |
| 2015 | Scapeshift | combo | label |
| 2015 | Zoo | aggro | label |
| 2015 | UWx Midrange | control | cards |
| 2015 | Living End | combo | override |
| 2015 | Evil Twin | combo | label |
| 2015 | UW Control Titan | control | label |
| 2015 | Tooth and Nail | midrange | default |
| 2015 | Merfolk | aggro | cards |
| 2015 | Infect | aggro | label |
| 2015 | BUG Control | control | label |
| 2015 | Esper Control | control | label |
| 2015 | Burn | aggro | label |
| 2015 | Podless Collected | combo | label |
| 2015 | Ad Nauseam | combo | override |
| 2015 | Elves | aggro | label |
| 2015 | Mono Green Titan | midrange | default |
| 2015 | Walk Machine | control | cards |
| 2015 | UR Aggro | aggro | label |
| 2015 | Abzan | midrange | default |
| 2015 | UWr Midrange | midrange | default |
| 2016 | Affinity | aggro | label |
| 2016 | Eldrazi Aggro | aggro | label |
| 2016 | Infect | aggro | label |
| 2016 | Scapeshift | combo | label |
| 2016 | Dredge | combo | label |
| 2016 | Abzan | midrange | default |
| 2016 | W/B Hatebear | aggro | cards |
| 2016 | Jund | midrange | default |
| 2016 | Merfolk | aggro | cards |
| 2016 | Ad Nauseam | combo | override |
| 2016 | Living End | combo | override |
| 2016 | Death's Shadow Zoo | aggro | label |
| 2016 | Grixis Delver | aggro | label |
| 2016 | Nahiri Control | control | label |
| 2016 | Mardu Nahiri | midrange | default |
| 2016 | Jeskai Control | control | label |
| 2016 | UWR Thopter Sword | control | cards |
| 2016 | RG Breach | midrange | default |
| 2016 | Grixis Control | control | label |
| 2016 | Bloomless Titan | midrange | default |
| 2016 | Kiki-Evolution | combo | label |
| 2016 | Esper Midrange | midrange | default |
| 2016 | B/G Elves | aggro | label |
| 2016 | UW Control | control | label |

## Legacy eras

| era | format | window | distinct legal decks to choose from | chosen | W | U | B | R | G | aggro | midrange | control | combo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [2005](legacy-2005.md) | Legacy (9ED) | 2005-08-20 → 2005-10-20 | 9 | 9 | 4 | 2 | 0 | 6 | 4 | 7 | 0 | 2 | 0 |
| [2006](legacy-2006.md) | Legacy (CSP) | 2006-08-20 → 2006-10-20 | 17 | 17 | 7 | 8 | 5 | 6 | 7 | 5 | 5 | 7 | 0 |
| [2007](legacy-2007.md) | Legacy (10E) | 2007-07-20 → 2007-10-20 | 27 | 24 | 9 | 12 | 9 | 8 | 11 | 9 | 4 | 7 | 4 |
| [2008](legacy-2008.md) | Legacy (EVE) | 2008-07-25 → 2008-10-03 | 69 | 24 | 10 | 14 | 13 | 10 | 12 | 8 | 7 | 5 | 4 |
| [2009](legacy-2009.md) | Legacy (M10) | 2009-07-17 → 2009-10-02 | 24 | 24 | 7 | 15 | 9 | 7 | 10 | 8 | 5 | 7 | 4 |
| [2010](legacy-2010.md) | Legacy (M11) | 2010-07-16 → 2010-10-01 | 44 | 24 | 9 | 12 | 8 | 9 | 12 | 8 | 5 | 7 | 4 |
| [2011](legacy-2011.md) | Legacy (M12) | 2011-07-15 → 2011-09-30 | 52 | 24 | 14 | 14 | 10 | 10 | 12 | 7 | 6 | 6 | 5 |
| [2012](legacy-2012.md) | Legacy (M13) | 2012-07-13 → 2012-10-05 | 59 | 24 | 8 | 12 | 10 | 10 | 10 | 7 | 6 | 6 | 5 |
| [2013](legacy-2013.md) | Legacy (M14) | 2013-07-19 → 2013-09-27 | 66 | 24 | 8 | 12 | 10 | 10 | 9 | 6 | 7 | 6 | 5 |
| [2014](legacy-2014.md) | Legacy (M15) | 2014-07-18 → 2014-09-26 | 58 | 24 | 8 | 12 | 10 | 9 | 12 | 7 | 7 | 5 | 5 |
| [2015](legacy-2015.md) | Legacy (ORI) | 2015-07-17 → 2015-10-02 | 58 | 24 | 9 | 12 | 11 | 8 | 10 | 6 | 6 | 7 | 5 |
| [2016](legacy-2016.md) | Legacy (EMN) | 2016-07-22 → 2016-09-30 | 60 | 24 | 8 | 12 | 12 | 8 | 10 | 6 | 8 | 5 | 5 |
| **all** | | | | **266** | 101 | 137 | 107 | 101 | 119 | 84 | 66 | 70 | 46 |

### Legacy: how each archetype was judged (style)

| era | deck | style | judged by |
| --- | --- | --- | --- |
| 2005 | R Vial Goblins | aggro | label |
| 2005 | Not Quite Gro | control | cards |
| 2005 | R Tiger Sligh | aggro | cards |
| 2005 | UW Landstill | control | cards |
| 2005 | Burn | aggro | label |
| 2005 | WRG Zoo | aggro | label |
| 2005 | RGSA | aggro | cards |
| 2005 | Crappy Survival Junk | aggro | cards |
| 2005 | Angel Stompy Variant | aggro | cards |
| 2006 | Solidarity | control | cards |
| 2006 | Goblins | aggro | label |
| 2006 | Flame Vault | control | cards |
| 2006 | Blue Skies | aggro | cards |
| 2006 | GAT | control | cards |
| 2006 | UGW Threshold | control | cards |
| 2006 | 5/3 | midrange | default |
| 2006 | Rogue Deadguy Ale: A Homebrew | midrange | default |
| 2006 | RG Survival | aggro | cards |
| 2006 | RecSur | aggro | cards |
| 2006 | Red-White Rift | control | cards |
| 2006 | Salvager | midrange | default |
| 2006 | ThreshGro | control | cards |
| 2006 | UW Control | control | label |
| 2006 | Boros Aggro | aggro | label |
| 2006 | Sligh | midrange | default |
| 2006 | Troll-A-Tog | midrange | default |
| 2007 | Thresh | control | cards |
| 2007 | Goblins | aggro | label |
| 2007 | Cephalid Breakfast | combo | override |
| 2007 | Survival | aggro | cards |
| 2007 | Kampelmann's täschchen ist sergej | control | cards |
| 2007 | Aggro Loam | aggro | label |
| 2007 | 3c Sligh | aggro | cards |
| 2007 | Landstill | control | cards |
| 2007 | Aluren | combo | override |
| 2007 | Lands | midrange | default |
| 2007 | Meat free Deck | midrange | default |
| 2007 | Belcher | combo | override |
| 2007 | UW Control | control | label |
| 2007 | Taiga | aggro | cards |
| 2007 | TES | combo | override |
| 2007 | Angel Stompy | aggro | cards |
| 2007 | MUC | control | cards |
| 2007 | Keiner mag Eugen.dec | control | cards |
| 2007 | UW Bärenmarke | aggro | cards |
| 2007 | Pikula | midrange | default |
| 2007 | Life from the Loam contrôle | midrange | default |
| 2007 | Elves ! | aggro | label |
| 2007 | Tog | control | cards |
| 2007 | Suicide Black | aggro | cards |
| 2008 | MeatHooks | aggro | cards |
| 2008 | Thresh | control | cards |
| 2008 | Ichorid | aggro | cards |
| 2008 | Aggro Loam | aggro | label |
| 2008 | Landstill | control | cards |
| 2008 | Survival | aggro | cards |
| 2008 | UGb Threshold | midrange | default |
| 2008 | BGW The Rock | aggro | cards |
| 2008 | Panzerfaust | midrange | default |
| 2008 | Purple Death | midrange | default |
| 2008 | Rgb Goblins | aggro | label |
| 2008 | RGb Goyf Sligh | aggro | cards |
| 2008 | UBg Big Fish | midrange | default |
| 2008 | LftL Aggro relou | aggro | label |
| 2008 | Reanimator | combo | label |
| 2008 | Belcher | combo | override |
| 2008 | Aluren | combo | override |
| 2008 | Armageddon Stax | control | cards |
| 2008 | iPop Negation | control | cards |
| 2008 | Eternal Garden | midrange | default |
| 2008 | Enduring Ideal | midrange | default |
| 2008 | Enchantress | control | cards |
| 2008 | TES | combo | override |
| 2008 | BWR Frikula | midrange | default |
| 2009 | Goyfslight | aggro | cards |
| 2009 | Uw Stax | control | cards |
| 2009 | Dragon Stompy | aggro | cards |
| 2009 | Next Level Blue | control | override |
| 2009 | Togless | control | cards |
| 2009 | Eternal Life | aggro | cards |
| 2009 | Dreadstill | control | cards |
| 2009 | Faerie Stompy | aggro | cards |
| 2009 | TES | combo | override |
| 2009 | 4c Fish | midrange | default |
| 2009 | ANT | combo | override |
| 2009 | BGw Rock | aggro | cards |
| 2009 | Seuil UGR old school | control | cards |
| 2009 | Solidarity aka Reset high tide | control | cards |
| 2009 | Eva Green | aggro | cards |
| 2009 | UGW thresh | midrange | default |
| 2009 | Tarmo Sligh | midrange | default |
| 2009 | Tarmo Pikula | midrange | default |
| 2009 | Imperial Painter | combo | override |
| 2009 | URg fish | midrange | default |
| 2009 | Elfball | aggro | cards |
| 2009 | Progenitus Survival | aggro | cards |
| 2009 | Dredge | combo | label |
| 2009 | UWb Landstill | control | cards |
| 2010 | GW Survival | aggro | cards |
| 2010 | 4-Color Supreme Blue | midrange | default |
| 2010 | Burning Animals | aggro | label |
| 2010 | Stacker (Mono Brown) | midrange | default |
| 2010 | Trinistax (Mono White) | control | cards |
| 2010 | Zoo | aggro | label |
| 2010 | Rw Burn | aggro | label |
| 2010 | Merfolk with black | aggro | cards |
| 2010 | Maverick | aggro | cards |
| 2010 | Axe Gang Fae | midrange | default |
| 2010 | Goblins | aggro | label |
| 2010 | Faeries | control | label |
| 2010 | ANT | combo | override |
| 2010 | Dredge | combo | label |
| 2010 | UW Landstill | control | cards |
| 2010 | Team America | control | cards |
| 2010 | Four-color Counterbalance | control | cards |
| 2010 | Ichorid | aggro | cards |
| 2010 | Show and Tell/Sneak Attack | control | cards |
| 2010 | Belcher | combo | override |
| 2010 | 42 lands | midrange | default |
| 2010 | Ad Nauseam Tendrils | control | cards |
| 2010 | Elf Combo | combo | label |
| 2010 | Hexmage Depths | midrange | default |
| 2011 | Team America | control | cards |
| 2011 | Zenith Maverick | aggro | cards |
| 2011 | Pro Zenith Bant | midrange | default |
| 2011 | Caw-Blade | control | cards |
| 2011 | RUG Order | control | cards |
| 2011 | Hive Mind | control | cards |
| 2011 | Spiral Tide | combo | override |
| 2011 | Aggro Loam | aggro | label |
| 2011 | Stoneblade | control | cards |
| 2011 | White Weenie | aggro | label |
| 2011 | Show & Tell | combo | override |
| 2011 | Dark Threshold | midrange | default |
| 2011 | Punishing zoo | aggro | label |
| 2011 | Dredge | combo | label |
| 2011 | Dark Horizon | midrange | default |
| 2011 | Ad Nauseam | midrange | default |
| 2011 | Zoo | aggro | label |
| 2011 | Goblins | aggro | label |
| 2011 | Sneak Attack | combo | override |
| 2011 | Burn ! | aggro | label |
| 2011 | Eternal Garden | midrange | default |
| 2011 | Cephalid Breakfast | combo | override |
| 2011 | Team Italia | midrange | default |
| 2011 | UB Control | control | label |
| 2012 | Reanimator | combo | label |
| 2012 | Goblins | aggro | label |
| 2012 | UW Miracles | control | cards |
| 2012 | Threshold (Canadian Ugr) | midrange | default |
| 2012 | Esper Stoneblade | control | cards |
| 2012 | Merfolk | aggro | cards |
| 2012 | Dredge | combo | label |
| 2012 | Sneak Attack | combo | override |
| 2012 | Eternal Garden | midrange | default |
| 2012 | TES | combo | override |
| 2012 | Bant | control | cards |
| 2012 | Weenie White | aggro | label |
| 2012 | 1 Land Belcher | midrange | default |
| 2012 | Naya Zoo | aggro | label |
| 2012 | Elves | aggro | label |
| 2012 | Spiral Tide | combo | override |
| 2012 | Aggro Loam | aggro | label |
| 2012 | Faestalker | control | cards |
| 2012 | TravES | control | cards |
| 2012 | MUD | midrange | default |
| 2012 | Burn | aggro | label |
| 2012 | Nic Fit  Valakut | midrange | default |
| 2012 | The Rock (Junk) | midrange | default |
| 2012 | Emrakul Enchantress | control | cards |
| 2013 | Elves | aggro | label |
| 2013 | UR Delver | aggro | label |
| 2013 | Painter | combo | override |
| 2013 | Goblins | aggro | label |
| 2013 | Jund | midrange | default |
| 2013 | Team America | midrange | default |
| 2013 | Sneak Show | combo | override |
| 2013 | Storm | combo | label |
| 2013 | Maverick | aggro | cards |
| 2013 | TES | combo | override |
| 2013 | Junk | midrange | default |
| 2013 | Tezzeret Control | control | label |
| 2013 | Hive Mind | control | cards |
| 2013 | UW Miracle | control | cards |
| 2013 | UWr Countertop | control | cards |
| 2013 | Zoo | aggro | label |
| 2013 | Death & Taxes | aggro | cards |
| 2013 | High Tide | control | cards |
| 2013 | Show and Tell | control | cards |
| 2013 | MUD | midrange | default |
| 2013 | Nic Fit | midrange | default |
| 2013 | Belcher | combo | override |
| 2013 | Patriot | midrange | default |
| 2013 | Pikula | midrange | default |
| 2014 | UW Miracles | control | cards |
| 2014 | Death & Taxes | aggro | cards |
| 2014 | Elves | aggro | label |
| 2014 | Berserk Poison | control | cards |
| 2014 | TES | combo | override |
| 2014 | Sneak Show | combo | override |
| 2014 | Patriot Aggro | aggro | label |
| 2014 | Burn | aggro | label |
| 2014 | Lands (Eternal Garden) | midrange | default |
| 2014 | Bant | midrange | default |
| 2014 | Imperial Painter | combo | override |
| 2014 | Bug Midrange | midrange | default |
| 2014 | Glam Loam | midrange | default |
| 2014 | Stoneblade | midrange | default |
| 2014 | BUG Control | control | label |
| 2014 | Titan Post | control | cards |
| 2014 | The Rock (Junk) | aggro | cards |
| 2014 | Jund | aggro | cards |
| 2014 | Dredge | combo | label |
| 2014 | Maverick | aggro | cards |
| 2014 | Belcher | combo | override |
| 2014 | Pikula | midrange | default |
| 2014 | MUD - Post | midrange | default |
| 2014 | Standstill Groovy | control | cards |
| 2015 | Omni - Show | control | cards |
| 2015 | Lands (Eternal Garden) | midrange | default |
| 2015 | UW Miracles | control | cards |
| 2015 | Death & Taxes | aggro | cards |
| 2015 | Elves | aggro | label |
| 2015 | Shardless BUG | midrange | default |
| 2015 | Painter | combo | override |
| 2015 | UR Delver | aggro | label |
| 2015 | Dredge | combo | label |
| 2015 | Monastery | control | cards |
| 2015 | UW Control | control | label |
| 2015 | Stoneblade | control | cards |
| 2015 | Storm | combo | label |
| 2015 | Maverick | aggro | cards |
| 2015 | Burn | aggro | label |
| 2015 | Jund | midrange | default |
| 2015 | The Rock (Junk) | midrange | default |
| 2015 | Goblins | aggro | label |
| 2015 | TES | combo | override |
| 2015 | Pox | midrange | default |
| 2015 | BUG Faeries | control | label |
| 2015 | Reanimator | combo | label |
| 2015 | Loam | midrange | default |
| 2015 | Enchantress | control | cards |
| 2016 | Storm | combo | label |
| 2016 | 4c Good Stuff | midrange | default |
| 2016 | Grixis Delver | aggro | label |
| 2016 | Eldrazi Aggro | aggro | label |
| 2016 | Death & Taxes | aggro | cards |
| 2016 | Loam | midrange | default |
| 2016 | Belcher | combo | override |
| 2016 | Nic Fit | midrange | default |
| 2016 | Deathblade | midrange | default |
| 2016 | Shardless BUG | midrange | default |
| 2016 | Elves | aggro | label |
| 2016 | Lands | midrange | default |
| 2016 | Dredge | combo | label |
| 2016 | Show and Tell | control | cards |
| 2016 | Aluren | combo | override |
| 2016 | MUD | midrange | default |
| 2016 | Reanimator | combo | label |
| 2016 | Stoneblade | control | cards |
| 2016 | Burn | aggro | label |
| 2016 | Enchantress | midrange | default |
| 2016 | High Tide | control | cards |
| 2016 | Grixis Control | control | label |
| 2016 | Maverick | aggro | cards |
| 2016 | Punishing Thing | control | cards |
