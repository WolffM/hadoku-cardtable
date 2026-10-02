# Deck selection review — Standard "power summers" 2008–2016

One era per year: the Standard in force **just before the fall rotation**, when the old block and the new one are legal together. Replaces the nine mid-season eras (several of which were the same set twice, or a ban with no new set).

## How the decks were chosen

1. **Candidates:** every Standard deck from a competitive-level event (Pro Tour, Worlds, Grand Prix, Nationals, SCG Opens, PTQs; not online dailies) in the season before that fall rotation, from [mtgtop8](https://www.mtgtop8.com). Events inside the summer window count more than earlier ones. Summers 2009 and 2010 have almost nothing in the summer itself (mtgtop8 has a few Nationals), so those eras lean on earlier-season decks that are still legal.
2. **One deck per archetype**, the one that went furthest (a bigger event counts more). **No near-duplicates:** two lists count as the same deck when they share 60% of their cards, or 45% and the same colours, or 30% and the same archetype name (so "RDW" and "Red Deck Wins", or four Tempered Steel lists, collapse to the one that placed best).
3. **Legal in that era**, checked card by card against Forge's own format file (legal sets and bans). A deck that played a card later banned, or a core set that had already rotated, is skipped. That is why 2009 and 2010 are small: mtgtop8 has only a few Nationals in those two summers, and most earlier-season decks carry cards that were illegal by July.
4. **Colour spread:** the chosen decks are searched so each of the five colours is played by about the same number of them (a colour may sit one deck off the mean for free). Colours are read from mana costs, not from the archetype name.
5. **Style spread:** at least 2 decks of each style when the era has them, at most 5 of any one, and the targets lean toward the rarer styles.
6. **Strength still counts:** within those limits the search maximises how well the decks actually placed. 12 decks per era.

Tunable in `tools/select_decks.py`; re-run and the review regenerates. **Style is a heuristic** (creature count, average cost, counterspells and sweepers, plus archetype names); the classification table below shows how each deck was judged. Wrong ones can be fixed in `style-overrides.json`.

## The nine eras

| era | format | window | distinct legal decks to choose from | chosen | W | U | B | R | G | aggro | midrange | control | combo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [2008](2008.md) | Standard (EVE) | 2008-07-25 → 2008-10-03 | 21 | 12 | 3 | 6 | 5 | 5 | 4 | 4 | 4 | 3 | 1 |
| [2009](2009.md) | Standard (M10) | 2009-07-17 → 2009-10-02 | 4 | 4 | 2 | 1 | 3 | 1 | 2 | 3 | 0 | 1 | 0 |
| [2010](2010.md) | Standard (M11) | 2010-07-16 → 2010-10-01 | 8 | 8 | 2 | 6 | 3 | 4 | 3 | 1 | 2 | 3 | 2 |
| [2011](2011.md) | Standard (M12) | 2011-07-15 → 2011-09-30 | 23 | 12 | 4 | 4 | 2 | 5 | 5 | 5 | 2 | 2 | 3 |
| [2012](2012.md) | Standard (M13) | 2012-07-13 → 2012-10-05 | 39 | 12 | 5 | 5 | 4 | 4 | 5 | 4 | 4 | 2 | 2 |
| [2013](2013.md) | Standard (M14) | 2013-07-19 → 2013-09-27 | 38 | 12 | 7 | 5 | 7 | 6 | 7 | 4 | 3 | 3 | 2 |
| [2014](2014.md) | Standard (M15) | 2014-07-18 → 2014-09-26 | 35 | 12 | 5 | 3 | 6 | 5 | 5 | 5 | 3 | 4 | 0 |
| [2015](2015.md) | Standard (ORI) | 2015-07-17 → 2015-10-02 | 39 | 12 | 6 | 5 | 6 | 6 | 5 | 4 | 3 | 3 | 2 |
| [2016](2016.md) | Standard (EMN) | 2016-07-22 → 2016-09-30 | 26 | 12 | 5 | 5 | 5 | 5 | 6 | 4 | 4 | 4 | 0 |
| **all** | | | | **96** | 39 | 40 | 41 | 41 | 42 | 34 | 25 | 25 | 12 |

## How each archetype was judged (style)

| era | deck | style | judged by |
| --- | --- | --- | --- |
| 2008 | Red Deck Wins | aggro | label |
| 2008 | UB Faeries | control | label |
| 2008 | Torrent | aggro | label |
| 2008 | UW Blink Reveillark | combo | label |
| 2008 | Swans Control | control | label |
| 2008 | Elves | aggro | label |
| 2008 | Gassy Knoll | midrange | default |
| 2008 | Doran | midrange | default |
| 2008 | Merfolks | aggro | cards |
| 2008 | 4c Reveillark Control | control | label |
| 2008 | UW Pickles | midrange | default |
| 2008 | ManaRamp | midrange | default |
| 2009 | Elf Rock | aggro | cards |
| 2009 | Jund Aggro | aggro | label |
| 2009 | Faeries | control | label |
| 2009 | Kithkins | aggro | label |
| 2010 | UR Pyromancer | control | cards |
| 2010 | UG Polymorph | combo | label |
| 2010 | Jund | midrange | default |
| 2010 | U/g Polymorph | combo | label |
| 2010 | Turboland | control | label |
| 2010 | Grixis Control | control | label |
| 2010 | Vampires | aggro | label |
| 2010 | Open Filigree | midrange | default |
| 2011 | Caw-Blade | control | cards |
| 2011 | Elves | aggro | label |
| 2011 | Eldrazi Green | midrange | default |
| 2011 | Tempered Steel | aggro | label |
| 2011 | RUG Twin Pod | combo | label |
| 2011 | UR Twin Exarch | combo | label |
| 2011 | Red deck wins | aggro | label |
| 2011 | Valakut Ramp | midrange | default |
| 2011 | UW Control | control | label |
| 2011 | Br Vampires | aggro | label |
| 2011 | GW Pod | combo | label |
| 2011 | UB Infect | aggro | label |
| 2012 | UW Delver | aggro | label |
| 2012 | Naya Pod | combo | label |
| 2012 | BR Zombies | aggro | label |
| 2012 | Infect | aggro | label |
| 2012 | GW/Naya Aggro | aggro | label |
| 2012 | Kessig Titan | midrange | default |
| 2012 | Solar Flare | midrange | default |
| 2012 | Tezzeret Control | control | label |
| 2012 | Kessig U | midrange | default |
| 2012 | UB Control | control | label |
| 2012 | GW Token | midrange | default |
| 2012 | Zombie Pod | combo | label |
| 2013 | Jund Midrange | midrange | default |
| 2013 | Gruul Aggro | aggro | label |
| 2013 | Aristocrats | aggro | cards |
| 2013 | Reanimator | combo | label |
| 2013 | UWr Midrange | midrange | default |
| 2013 | UWx Midrange | midrange | default |
| 2013 | Bant Control | control | label |
| 2013 | Rakdos Aggro | aggro | label |
| 2013 | Human Reanimator | combo | label |
| 2013 | UWR Control | control | label |
| 2013 | Golgari Control | control | label |
| 2013 | BUG Persist Aggro | aggro | label |
| 2014 | Devotion to Blue | aggro | cards |
| 2014 | Devotion to Black | midrange | default |
| 2014 | Selesnya Aggro | aggro | label |
| 2014 | Red Deck Wins | aggro | label |
| 2014 | Golgari Control | control | label |
| 2014 | UW Control | control | label |
| 2014 | Esper Control | control | label |
| 2014 | Boros Aggro | aggro | label |
| 2014 | Gruul Team | midrange | default |
| 2014 | Devotion to Green | midrange | default |
| 2014 | Orzhov Control | control | label |
| 2014 | Jund Aggro | aggro | label |
| 2015 | Abzan Midrange | aggro | cards |
| 2015 | Red Deck Wins | aggro | label |
| 2015 | Devotion to Green | midrange | default |
| 2015 | Jeskai Midrange | midrange | default |
| 2015 | Esper Control | control | label |
| 2015 | UR Artifacts | aggro | cards |
| 2015 | Abzan Rally | combo | label |
| 2015 | Mardu Aggro | aggro | label |
| 2015 | Abzan Control | control | label |
| 2015 | UB Control | control | label |
| 2015 | See the Unwritten | midrange | default |
| 2015 | Jeskai Ascendancy | combo | label |
| 2016 | Collected Bant | midrange | default |
| 2016 | Selesnya Aggro | aggro | label |
| 2016 | Simic Ramp | midrange | default |
| 2016 | Weenie White | aggro | label |
| 2016 | Grixis Control | control | label |
| 2016 | Green Ramp | midrange | default |
| 2016 | Izzet Machinegun | aggro | label |
| 2016 | Mono Black Aggro | aggro | label |
| 2016 | Naya PW | midrange | default |
| 2016 | Orzhov Control | control | label |
| 2016 | Golgari Control | control | label |
| 2016 | Mardu Control | control | label |
