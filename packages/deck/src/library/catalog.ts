/*
 * What is in the deck library, and where the files are.
 *
 * ## Why the catalog holds paths and not decks
 *
 * `@hadoku/deck` cannot read a file — it is bundled into the browser and has no
 * node builtins, which is the rule `index.ts` states for the whole package. So
 * the catalog is a manifest: it names the files, and whoever has a filesystem
 * (a test, a build step) or a fetch (the UI) reads them and hands the text to
 * `loadLibraryDeck`. That is the same shape `prebuilt.ts` chose and for the same
 * reason.
 *
 * ## Why so little is in here
 *
 * Each entry carries an id and a filename and nothing else. Name, format, date,
 * citation and provenance all live in the `.dck` file's own `[metadata]`
 * section, so there is exactly one copy of each fact and the file is the copy.
 * A catalog that also listed the player and the finish would be a second copy
 * free to drift from the first, and the drift would be invisible.
 *
 * What the collection-level rows DO carry — `format`, `date`, `source` — is
 * carried on purpose, because it is checkable: `library.test.ts` asserts every
 * deck file in a collection agrees with its collection's row, so a deck filed
 * under the wrong format fails the build rather than sitting there wrong.
 *
 * ## Wave 34: nine power-summer eras, replacing the old nine-collection library
 *
 * The library used to be eight mid-season tournament collections, all but one
 * from an 18-month window (2011-02 to 2012-08) — 49 decks, several of them the
 * same archetype four times over. The operator asked for the opposite shape:
 * one era per year, 2008-2016, each the Standard in force just before that
 * year's fall rotation, each with twelve decks searched for colour and style
 * spread rather than hand-picked from one event's Top 8.
 *
 * `docs/planning/deck-selection/` is where that selection happened —
 * `eras.json` names the nine snapshots, `selections/selection-<year>.json` has
 * the 96 decks `tools/select_decks.py` chose and why, `review/<year>.md` is the
 * human-readable report per era, and `review/README.md` has the rules. This
 * file is downstream of that selection: `build-library.ts` transcribes exactly
 * the `chosen` list, in order, into the `.dck` files below. Re-selecting is a
 * data edit to that tool, not an edit here.
 */

/** One deck file in a collection. */
export interface LibraryEntry {
  /** Stable id, used in reports and test names. */
  readonly id: string;
  /** File name inside the collection's directory. */
  readonly file: string;
}

/** A set of decks that share a format, a date and an event. */
export interface LibraryCollection {
  readonly id: string;
  /** Directory under {@link DECKS_ROOT}, relative to the repo root. */
  readonly directory: string;
  /** Human name of the event or source the decks came from. */
  readonly event: string;
  /** The format as Forge names it. Every deck's `Format` key must match. */
  readonly format: string;
  /** `YYYY-MM-DD`. Every deck's `Effective` key must match. */
  readonly date: string;
  /** Where the collection as a whole came from — the selection's own review doc. */
  readonly source: string;
  readonly decks: readonly LibraryEntry[];
}

/** The repo-root-relative directory the library lives in. */
export const DECKS_ROOT = 'decks';

/**
 * Slugify a player or archetype name for a library filename or id: strip
 * accents, lowercase, collapse everything that is not `[a-z0-9]` to one `-`.
 * `build-library.ts` uses this to derive both the `.dck` filename and the
 * entry id from the selection's own `player`/`archetype` strings, so the two
 * can never drift from each other by a hand-typed difference.
 */
export function slugifyForLibrary(s: string): string {
  const stripped = s.normalize('NFKD').replace(/\p{M}/gu, '');
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The 2008 power summer — `Standard (EVE)`, 2008-07-25 to 2008-10-03, the last
 * Standard snapshot before that fall's rotation. 21 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2008.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 3, U 6, B 5, R 5, G 4;
 * aggro 4, midrange 4, control 3, combo 1.
 */
export const POWER_SUMMER_2008_STANDARD: LibraryCollection = {
  id: 'power-summer-2008',
  directory: `${DECKS_ROOT}/standard-2008`,
  event: "2008 power summer \u2014 Standard (EVE), 2008-07-25 \u2192 2008-10-03",
  format: "Standard (EVE)",
  date: "2008-07-25",
  source: 'docs/planning/deck-selection/review/2008.md',
  decks: [
    { id: "power-2008-1-michael-jacob-red-deck-wins", file: "1-michael-jacob-red-deck-wins.dck" },
    { id: "power-2008-1-jonathan-randle-ub-faeries", file: "1-jonathan-randle-ub-faeries.dck" },
    { id: "power-2008-1-william-cavaglieri-torrent", file: "1-william-cavaglieri-torrent.dck" },
    { id: "power-2008-1-masashi-oiso-uw-blink-reveillark", file: "1-masashi-oiso-uw-blink-reveillark.dck" },
    { id: "power-2008-1-tom-van-lamoen-swans-control", file: "1-tom-van-lamoen-swans-control.dck" },
    { id: "power-2008-2-sam-black-elves", file: "2-sam-black-elves.dck" },
    { id: "power-2008-2-akihiro-takakuwa-gassy-knoll", file: "2-akihiro-takakuwa-gassy-knoll.dck" },
    { id: "power-2008-3-russ-j-davies-doran", file: "3-russ-j-davies-doran.dck" },
    { id: "power-2008-3-stephane-soubrier-merfolks", file: "3-stephane-soubrier-merfolks.dck" },
    { id: "power-2008-5-shouhei-yamamoto-4c-reveillark-control", file: "5-shouhei-yamamoto-4c-reveillark-control.dck" },
    { id: "power-2008-1-paul-cheon-uw-pickles", file: "1-paul-cheon-uw-pickles.dck" },
    { id: "power-2008-3-armin-birner-manaramp", file: "3-armin-birner-manaramp.dck" },
  ],
};

/**
 * The 2009 power summer — `Standard (M10)`, 2009-07-17 to 2009-10-02, the last
 * Standard snapshot before that fall's rotation. 4 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2009.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 4 chosen, one per archetype, searched for colour and style
 * spread: W 2, U 1, B 3, R 1, G 2;
 * aggro 3, midrange 0, control 1, combo 0.
 */
export const POWER_SUMMER_2009_STANDARD: LibraryCollection = {
  id: 'power-summer-2009',
  directory: `${DECKS_ROOT}/standard-2009`,
  event: "2009 power summer \u2014 Standard (M10), 2009-07-17 \u2192 2009-10-02",
  format: "Standard (M10)",
  date: "2009-07-17",
  source: 'docs/planning/deck-selection/review/2009.md',
  decks: [
    { id: "power-2009-1-mongilardi-gilles-elf-rock", file: "1-mongilardi-gilles-elf-rock.dck" },
    { id: "power-2009-2-jonathan-cano-jund-aggro", file: "2-jonathan-cano-jund-aggro.dck" },
    { id: "power-2009-3-guillaume-matignon-faeries", file: "3-guillaume-matignon-faeries.dck" },
    { id: "power-2009-3-hannes-kerem-kithkins", file: "3-hannes-kerem-kithkins.dck" },
  ],
};

/**
 * The 2010 power summer — `Standard (M11)`, 2010-07-16 to 2010-10-01, the last
 * Standard snapshot before that fall's rotation. 8 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2010.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 8 chosen, one per archetype, searched for colour and style
 * spread: W 2, U 6, B 3, R 4, G 3;
 * aggro 1, midrange 2, control 3, combo 2.
 */
export const POWER_SUMMER_2010_STANDARD: LibraryCollection = {
  id: 'power-summer-2010',
  directory: `${DECKS_ROOT}/standard-2010`,
  event: "2010 power summer \u2014 Standard (M11), 2010-07-16 \u2192 2010-10-01",
  format: "Standard (M11)",
  date: "2010-07-16",
  source: 'docs/planning/deck-selection/review/2010.md',
  decks: [
    { id: "power-2010-2-guillaume-matignon-ur-pyromancer", file: "2-guillaume-matignon-ur-pyromancer.dck" },
    { id: "power-2010-3-antoine-ruel-ug-polymorph", file: "3-antoine-ruel-ug-polymorph.dck" },
    { id: "power-2010-1-emanuele-giusti-jund", file: "1-emanuele-giusti-jund.dck" },
    { id: "power-2010-2-isaiah-ley-u-g-polymorph", file: "2-isaiah-ley-u-g-polymorph.dck" },
    { id: "power-2010-5-lucas-florent-turboland", file: "5-lucas-florent-turboland.dck" },
    { id: "power-2010-5-adam-fox-grixis-control", file: "5-adam-fox-grixis-control.dck" },
    { id: "power-2010-5-max-malesch-vampires", file: "5-max-malesch-vampires.dck" },
    { id: "power-2010-5-niels-viaene-open-filigree", file: "5-niels-viaene-open-filigree.dck" },
  ],
};

/**
 * The 2011 power summer — `Standard (M12)`, 2011-07-15 to 2011-09-30, the last
 * Standard snapshot before that fall's rotation. 23 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2011.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 4, U 4, B 2, R 5, G 5;
 * aggro 5, midrange 2, control 2, combo 3.
 *
 * Banned: Jace, the Mind Sculptor, Stoneforge Mystic.
 *
 * Ali Antrazi's UB Control (mtgtop8 deck 213699) is in the selection's
 * `chosen` list but is NOT here: its mtgtop8 export contains an unresolvable
 * `2 [] Unknown Card` line (found transcribing this era, wave 34 lane D), so it
 * cannot be transcribed. Swapped for Xinlin Ye's Elves, the next-best
 * alternate not already an archetype in this era
 * (`selections/selection-2011.json` records the swap).
 */
export const POWER_SUMMER_2011_STANDARD: LibraryCollection = {
  id: 'power-summer-2011',
  directory: `${DECKS_ROOT}/standard-2011`,
  event: "2011 power summer \u2014 Standard (M12), 2011-07-15 \u2192 2011-09-30",
  format: "Standard (M12)",
  date: "2011-07-15",
  source: 'docs/planning/deck-selection/review/2011.md',
  decks: [
    { id: "power-2011-1-marcello-calvetta-caw-blade", file: "1-marcello-calvetta-caw-blade.dck" },
    { id: "power-2011-1-xinlin-ye-elves", file: "1-xinlin-ye-elves.dck" },
    { id: "power-2011-1-daniel-royde-eldrazi-green", file: "1-daniel-royde-eldrazi-green.dck" },
    { id: "power-2011-1-ryuuichiro-ishida-tempered-steel", file: "1-ryuuichiro-ishida-tempered-steel.dck" },
    { id: "power-2011-1-marc-anderson-rug-twin-pod", file: "1-marc-anderson-rug-twin-pod.dck" },
    { id: "power-2011-1-joel-calafell-ur-twin-exarch", file: "1-joel-calafell-ur-twin-exarch.dck" },
    { id: "power-2011-1-helge-nelson-red-deck-wins", file: "1-helge-nelson-red-deck-wins.dck" },
    { id: "power-2011-1-pat-cox-valakut-ramp", file: "1-pat-cox-valakut-ramp.dck" },
    { id: "power-2011-1-luke-tsavousis-uw-control", file: "1-luke-tsavousis-uw-control.dck" },
    { id: "power-2011-1-james-combrink-br-vampires", file: "1-james-combrink-br-vampires.dck" },
    { id: "power-2011-2-fujimoto-tomoya-gw-pod", file: "2-fujimoto-tomoya-gw-pod.dck" },
    { id: "power-2011-1-brucehendrix-ub-infect", file: "1-brucehendrix-ub-infect.dck" },
  ],
};

/**
 * The 2012 power summer — `Standard (M13)`, 2012-07-13 to 2012-10-05, the last
 * Standard snapshot before that fall's rotation. 39 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2012.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 5, U 5, B 4, R 4, G 5;
 * aggro 4, midrange 4, control 2, combo 2.
 */
export const POWER_SUMMER_2012_STANDARD: LibraryCollection = {
  id: 'power-summer-2012',
  directory: `${DECKS_ROOT}/standard-2012`,
  event: "2012 power summer \u2014 Standard (M13), 2012-07-13 \u2192 2012-10-05",
  format: "Standard (M13)",
  date: "2012-07-13",
  source: 'docs/planning/deck-selection/review/2012.md',
  decks: [
    { id: "power-2012-1-todd-anderson-uw-delver", file: "1-todd-anderson-uw-delver.dck" },
    { id: "power-2012-1-caleb-durward-naya-pod", file: "1-caleb-durward-naya-pod.dck" },
    { id: "power-2012-1-han-kyu-br-zombies", file: "1-han-kyu-br-zombies.dck" },
    { id: "power-2012-1-cj-steele-infect", file: "1-cj-steele-infect.dck" },
    { id: "power-2012-1-michael-lee-gw-naya-aggro", file: "1-michael-lee-gw-naya-aggro.dck" },
    { id: "power-2012-1-john-cuvelier-kessig-titan", file: "1-john-cuvelier-kessig-titan.dck" },
    { id: "power-2012-1-jeremy-dombek-solar-flare", file: "1-jeremy-dombek-solar-flare.dck" },
    { id: "power-2012-1-levi-mochan-tezzeret-control", file: "1-levi-mochan-tezzeret-control.dck" },
    { id: "power-2012-2-samy-younis-kessig-u", file: "2-samy-younis-kessig-u.dck" },
    { id: "power-2012-1-doug-potter-ub-control", file: "1-doug-potter-ub-control.dck" },
    { id: "power-2012-1-mikael-conrow-gw-token", file: "1-mikael-conrow-gw-token.dck" },
    { id: "power-2012-1-adam-bubacz-zombie-pod", file: "1-adam-bubacz-zombie-pod.dck" },
  ],
};

/**
 * The 2013 power summer — `Standard (M14)`, 2013-07-19 to 2013-09-27, the last
 * Standard snapshot before that fall's rotation. 38 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2013.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 7, U 5, B 7, R 6, G 7;
 * aggro 4, midrange 3, control 3, combo 2.
 */
export const POWER_SUMMER_2013_STANDARD: LibraryCollection = {
  id: 'power-summer-2013',
  directory: `${DECKS_ROOT}/standard-2013`,
  event: "2013 power summer \u2014 Standard (M14), 2013-07-19 \u2192 2013-09-27",
  format: "Standard (M14)",
  date: "2013-07-19",
  source: 'docs/planning/deck-selection/review/2013.md',
  decks: [
    { id: "power-2013-1-sean-weihe-jund-midrange", file: "1-sean-weihe-jund-midrange.dck" },
    { id: "power-2013-1-adam-van-fleet-gruul-aggro", file: "1-adam-van-fleet-gruul-aggro.dck" },
    { id: "power-2013-1-nicholas-mudd-aristocrats", file: "1-nicholas-mudd-aristocrats.dck" },
    { id: "power-2013-1-tom-strong-reanimator", file: "1-tom-strong-reanimator.dck" },
    { id: "power-2013-1-jacobgagnon-uwr-midrange", file: "1-jacobgagnon-uwr-midrange.dck" },
    { id: "power-2013-1-ryan-hipp-uwx-midrange", file: "1-ryan-hipp-uwx-midrange.dck" },
    { id: "power-2013-1-reid-duke-bant-control", file: "1-reid-duke-bant-control.dck" },
    { id: "power-2013-1-ian-kendall-rakdos-aggro", file: "1-ian-kendall-rakdos-aggro.dck" },
    { id: "power-2013-1-joe-lossett-human-reanimator", file: "1-joe-lossett-human-reanimator.dck" },
    { id: "power-2013-1-todd-anderson-uwr-control", file: "1-todd-anderson-uwr-control.dck" },
    { id: "power-2013-1-othon-voutsis-golgari-control", file: "1-othon-voutsis-golgari-control.dck" },
    { id: "power-2013-1-thomas-mcveigh-bug-persist-aggro", file: "1-thomas-mcveigh-bug-persist-aggro.dck" },
  ],
};

/**
 * The 2014 power summer — `Standard (M15)`, 2014-07-18 to 2014-09-26, the last
 * Standard snapshot before that fall's rotation. 35 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2014.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 5, U 3, B 6, R 5, G 5;
 * aggro 5, midrange 3, control 4, combo 0.
 *
 * Two decks the selection chose are NOT here — both found transcribing this
 * era (wave 34 lane D), both for the same reason: an unresolvable
 * `[] Unknown Card` line in mtgtop8's own export.
 *
 *   - Rob Catton's UWr Control (mtgtop8 deck 238190) → Rosmarudin Faizal's
 *     Orzhov Control, the top-scoring alternate not already an archetype here.
 *   - Albert Bayrante's Reanimator (mtgtop8 deck 246524) → Jordan Welzbacher's
 *     Jund Aggro, the next clean alternate (no alternate for this era is
 *     combo-style, so the era loses its only combo deck).
 *
 * `selections/selection-2014.json` records both swaps.
 */
export const POWER_SUMMER_2014_STANDARD: LibraryCollection = {
  id: 'power-summer-2014',
  directory: `${DECKS_ROOT}/standard-2014`,
  event: "2014 power summer \u2014 Standard (M15), 2014-07-18 \u2192 2014-09-26",
  format: "Standard (M15)",
  date: "2014-07-18",
  source: 'docs/planning/deck-selection/review/2014.md',
  decks: [
    { id: "power-2014-1-mik-red-devotion-to-blue", file: "1-mik-red-devotion-to-blue.dck" },
    { id: "power-2014-1-dan-jessup-devotion-to-black", file: "1-dan-jessup-devotion-to-black.dck" },
    { id: "power-2014-1-scott-lipp-selesnya-aggro", file: "1-scott-lipp-selesnya-aggro.dck" },
    { id: "power-2014-1-manuel-orellana-red-deck-wins", file: "1-manuel-orellana-red-deck-wins.dck" },
    { id: "power-2014-1-jonas-zimmermann-golgari-control", file: "1-jonas-zimmermann-golgari-control.dck" },
    { id: "power-2014-1-omar-beldon-uw-control", file: "1-omar-beldon-uw-control.dck" },
    { id: "power-2014-1-gerard-fabiano-esper-control", file: "1-gerard-fabiano-esper-control.dck" },
    { id: "power-2014-1-neil-hartman-boros-aggro", file: "1-neil-hartman-boros-aggro.dck" },
    { id: "power-2014-1-zach-stern-gruul-team", file: "1-zach-stern-gruul-team.dck" },
    { id: "power-2014-1-hal-brady-devotion-to-green", file: "1-hal-brady-devotion-to-green.dck" },
    { id: "power-2014-1-rosmarudin-faizal-orzhov-control", file: "1-rosmarudin-faizal-orzhov-control.dck" },
    { id: "power-2014-1-jordan-welzbacher-jund-aggro", file: "1-jordan-welzbacher-jund-aggro.dck" },
  ],
};

/**
 * The 2015 power summer — `Standard (ORI)`, 2015-07-17 to 2015-10-02, the last
 * Standard snapshot before that fall's rotation. 39 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2015.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 6, U 5, B 6, R 6, G 5;
 * aggro 4, midrange 3, control 3, combo 2.
 */
export const POWER_SUMMER_2015_STANDARD: LibraryCollection = {
  id: 'power-summer-2015',
  directory: `${DECKS_ROOT}/standard-2015`,
  event: "2015 power summer \u2014 Standard (ORI), 2015-07-17 \u2192 2015-10-02",
  format: "Standard (ORI)",
  date: "2015-07-17",
  source: 'docs/planning/deck-selection/review/2015.md',
  decks: [
    { id: "power-2015-1-andrea-mengucci-abzan-midrange", file: "1-andrea-mengucci-abzan-midrange.dck" },
    { id: "power-2015-1-jory-white-red-deck-wins", file: "1-jory-white-red-deck-wins.dck" },
    { id: "power-2015-1-alex-bastecki-devotion-to-green", file: "1-alex-bastecki-devotion-to-green.dck" },
    { id: "power-2015-1-robert-sabol-jeskai-midrange", file: "1-robert-sabol-jeskai-midrange.dck" },
    { id: "power-2015-1-michael-deidolori-esper-control", file: "1-michael-deidolori-esper-control.dck" },
    { id: "power-2015-1-ryota09-ur-artifacts", file: "1-ryota09-ur-artifacts.dck" },
    { id: "power-2015-1-ray-tautic-abzan-rally", file: "1-ray-tautic-abzan-rally.dck" },
    { id: "power-2015-1-alejandro-dupuy-de-lome-mardu-aggro", file: "1-alejandro-dupuy-de-lome-mardu-aggro.dck" },
    { id: "power-2015-1-david-jones-abzan-control", file: "1-david-jones-abzan-control.dck" },
    { id: "power-2015-1-yoon-soo-han-ub-control", file: "1-yoon-soo-han-ub-control.dck" },
    { id: "power-2015-1-marco-panteghini-see-the-unwritten", file: "1-marco-panteghini-see-the-unwritten.dck" },
    { id: "power-2015-1-michael-earnshaw-jeskai-ascendancy", file: "1-michael-earnshaw-jeskai-ascendancy.dck" },
  ],
};

/**
 * The 2016 power summer — `Standard (EMN)`, 2016-07-22 to 2016-09-30, the last
 * Standard snapshot before that fall's rotation. 26 legal candidate decks from
 * that summer's Nationals, Pro Tours, Grand Prix and SCG/PTQ events (`docs/planning/
 * deck-selection/review/2016.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 5, U 5, B 5, R 5, G 6;
 * aggro 4, midrange 4, control 4, combo 0.
 */
export const POWER_SUMMER_2016_STANDARD: LibraryCollection = {
  id: 'power-summer-2016',
  directory: `${DECKS_ROOT}/standard-2016`,
  event: "2016 power summer \u2014 Standard (EMN), 2016-07-22 \u2192 2016-09-30",
  format: "Standard (EMN)",
  date: "2016-07-22",
  source: 'docs/planning/deck-selection/review/2016.md',
  decks: [
    { id: "power-2016-1-finespoo-collected-bant", file: "1-finespoo-collected-bant.dck" },
    { id: "power-2016-1-osyp-lebedowicz-selesnya-aggro", file: "1-osyp-lebedowicz-selesnya-aggro.dck" },
    { id: "power-2016-1-jacob-hagen-simic-ramp", file: "1-jacob-hagen-simic-ramp.dck" },
    { id: "power-2016-1-bradpitkeeper-weenie-white", file: "1-bradpitkeeper-weenie-white.dck" },
    { id: "power-2016-1-aya-grixis-control", file: "1-aya-grixis-control.dck" },
    { id: "power-2016-1-joshua-dickerson-green-ramp", file: "1-joshua-dickerson-green-ramp.dck" },
    { id: "power-2016-1-todd-anderson-izzet-machinegun", file: "1-todd-anderson-izzet-machinegun.dck" },
    { id: "power-2016-1-bradpitkeeper-mono-black-aggro", file: "1-bradpitkeeper-mono-black-aggro.dck" },
    { id: "power-2016-2-wakizaka-hironari-naya-pw", file: "2-wakizaka-hironari-naya-pw.dck" },
    { id: "power-2016-1-edvin-marsson-orzhov-control", file: "1-edvin-marsson-orzhov-control.dck" },
    { id: "power-2016-1-lucas-giuliani-golgari-control", file: "1-lucas-giuliani-golgari-control.dck" },
    { id: "power-2016-1-fujiwara-takashi-mardu-control", file: "1-fujiwara-takashi-mardu-control.dck" },
  ],
};

/** Every collection in the library, oldest era first. */
export const LIBRARY: readonly LibraryCollection[] = [
  POWER_SUMMER_2008_STANDARD,
  POWER_SUMMER_2009_STANDARD,
  POWER_SUMMER_2010_STANDARD,
  POWER_SUMMER_2011_STANDARD,
  POWER_SUMMER_2012_STANDARD,
  POWER_SUMMER_2013_STANDARD,
  POWER_SUMMER_2014_STANDARD,
  POWER_SUMMER_2015_STANDARD,
  POWER_SUMMER_2016_STANDARD,
];

/**
 * Where a deck's file is, relative to the repo root.
 *
 * A function rather than a field so the collection's directory is written once.
 * Always `/`-separated: these are repo paths, not host paths, and the caller
 * joins them with whatever its platform wants.
 */
export function deckPath(collection: LibraryCollection, entry: LibraryEntry): string {
  return `${collection.directory}/${entry.file}`;
}

/** Every deck file in the library, repo-root-relative, in catalog order. */
export function libraryDeckPaths(library: readonly LibraryCollection[] = LIBRARY): string[] {
  return library.flatMap((c) => c.decks.map((d) => deckPath(c, d)));
}

/**
 * The pool fixture for a collection, relative to the repo root.
 *
 * One fixture per collection date, named after the date rather than the
 * collection, because two collections from the same Standard share a pool and
 * regenerating it twice would be two chances to disagree. In this library every
 * era has its own unique date, so there is one fixture per era.
 */
export function poolFixturePath(date: string): string {
  return `${DECKS_ROOT}/pools/standard-${date}.generated.json`;
}

/**
 * Every date a pool is frozen for, which is every date a fixture file exists
 * for. `build-pool-fixture.ts`'s header says why each one is here — one per
 * era, its `Effective` date.
 *
 * Here rather than in that script because two OTHER things now read the list —
 * `build-deck-costs.ts` and the drift guard in `library.test.ts` — and that
 * script cannot be imported for it: it loads the 183 MB corpus at module scope.
 * A list of committed files belongs beside the function that names them anyway.
 */
export const POOL_FIXTURE_DATES: readonly string[] = LIBRARY.map((c) => c.date);
