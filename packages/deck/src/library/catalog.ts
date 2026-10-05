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

/**
 * The three format families the deck library draws eras from (wave 48).
 * Standard rotates its own sets; Modern and Legacy do not, and their eras are
 * pinned to the same year's Standard era's dates (Settled, wave48 plan) —
 * `@hadoku/carddata/formats`' `formatPoolAt` dispatches on this same union.
 */
export type FormatFamily = 'standard' | 'modern' | 'legacy';

/** A set of decks that share a format, a date and an event. */
export interface LibraryCollection {
  readonly id: string;
  /** Which format family this era's pool and legality come from. */
  readonly family: FormatFamily;
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

/**
 * The id a collection's era answers to over the wire — `apps/server/src/http/
 * library.ts` keys a format by this today for Standard (the bare date, so a
 * stored room or an e2e spec that pins `2016-07-22` keeps working unchanged),
 * and now needs one for Modern and Legacy too, which cannot be the bare date
 * alone: Modern 2012 and Legacy 2012 share Standard 2012's date (Settled) and
 * would collide. Non-standard families are prefixed; Standard is not.
 */
export function formatIdOf(c: { readonly family: FormatFamily; readonly date: string }): string {
  return c.family === 'standard' ? c.date : `${c.family}-${c.date}`;
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
 * The 2003 power summer — `Standard (8ED)`, 2003-09-01 to 2003-10-20, the last
 * Standard snapshot before that fall's rotation. 8 legal candidate decks from
 * that summer's Nationals, Pro Tours and Grand Prix events (`docs/planning/
 * deck-selection/review/2003.md` has the full table and the ones dropped as illegal or
 * near-duplicate); **thin season — 8 chosen of 8 candidates**, one per archetype,
 * searched for colour and style spread: W 3, U 2, B 2, R 5, G 3;
 * aggro 3, midrange 1, control 3, combo 1. Red dominated this era's candidate
 * pool (5 of 8 legal decks played it) and was given extra slots — wave 48 §T,
 * "balance, but true to the season".
 */
export const POWER_SUMMER_2003_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2003',
  directory: `${DECKS_ROOT}/standard-2003`,
  event: "2003 power summer — Standard (8ED), 2003-09-01 → 2003-10-20",
  format: "Standard (8ED)",
  date: "2003-09-01",
  source: 'docs/planning/deck-selection/review/2003.md',
  decks: [
    { id: "power-2003-1-marco-blume-wake", file: "1-marco-blume-wake.dck" },
    { id: "power-2003-2-michael-groves-ug-madness", file: "2-michael-groves-ug-madness.dck" },
    { id: "power-2003-2-matt-linde-black-white-control", file: "2-matt-linde-black-white-control.dck" },
    { id: "power-2003-3-joshua-wagener-red-green-beats", file: "3-joshua-wagener-red-green-beats.dck" },
    { id: "power-2003-3-keith-mclaughlin-goblins", file: "3-keith-mclaughlin-goblins.dck" },
    { id: "power-2003-5-zvi-mowshowitz-goblin-bidding", file: "5-zvi-mowshowitz-goblin-bidding.dck" },
    { id: "power-2003-5-gabe-walls-astral-slide", file: "5-gabe-walls-astral-slide.dck" },
    { id: "power-2003-5-peer-kroger-reanimator", file: "5-peer-kroger-reanimator.dck" },
  ],
};

/**
 * The 2004 power summer — `Standard (5DN)`, 2004-06-20 to 2004-10-20, the last
 * Standard snapshot before that fall's rotation. 25 legal candidate decks from
 * that summer's Nationals and Grand Prix events (`docs/planning/
 * deck-selection/review/2004.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 4, U 4, B 4, R 5, G 4;
 * aggro 3, midrange 5, control 4, combo 0.
 */
export const POWER_SUMMER_2004_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2004',
  directory: `${DECKS_ROOT}/standard-2004`,
  event: "2004 power summer — Standard (5DN), 2004-06-20 → 2004-10-20",
  format: "Standard (5DN)",
  date: "2004-06-20",
  source: 'docs/planning/deck-selection/review/2004.md',
  decks: [
    { id: "power-2004-1-masahiko-morita-affinity", file: "1-masahiko-morita-affinity.dck" },
    { id: "power-2004-1-tatsunori-kishi-goblins", file: "1-tatsunori-kishi-goblins.dck" },
    { id: "power-2004-1-tim-he-uw-control", file: "1-tim-he-uw-control.dck" },
    { id: "power-2004-1-john-ormerod-tooth-and-nail", file: "1-john-ormerod-tooth-and-nail.dck" },
    { id: "power-2004-1-jingpeng-zhang-obliterate-march", file: "1-jingpeng-zhang-obliterate-march.dck" },
    { id: "power-2004-1-domingo-ottati-rude-march", file: "1-domingo-ottati-rude-march.dck" },
    { id: "power-2004-2-gabriel-nassif-red-land-loss", file: "2-gabriel-nassif-red-land-loss.dck" },
    { id: "power-2004-3-masami-ibamoto-death-cloud", file: "3-masami-ibamoto-death-cloud.dck" },
    { id: "power-2004-3-zhen-x-gao-gw-astral-control", file: "3-zhen-x-gao-gw-astral-control.dck" },
    { id: "power-2004-3-alexandre-peset-read-the-goblin-bidding", file: "3-alexandre-peset-read-the-goblin-bidding.dck" },
    { id: "power-2004-2-bill-stead-g-w-control", file: "2-bill-stead-g-w-control.dck" },
    { id: "power-2004-5-iga-fritz-bg-cemetery", file: "5-iga-fritz-bg-cemetery.dck" },
  ],
};

/**
 * The 2005 power summer — `Standard (9ED)`, 2005-08-20 to 2005-10-20, the last
 * Standard snapshot before that fall's rotation. 7 legal candidate decks from
 * that summer's Nationals events (`docs/planning/
 * deck-selection/review/2005.md` has the full table and the ones dropped as illegal or
 * near-duplicate); **thin season — 7 chosen of 7 candidates**, one per archetype,
 * searched for colour and style spread: W 1, U 2, B 1, R 1, G 2;
 * aggro 4, midrange 1, control 2, combo 0.
 */
export const POWER_SUMMER_2005_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2005',
  directory: `${DECKS_ROOT}/standard-2005`,
  event: "2005 power summer — Standard (9ED), 2005-08-20 → 2005-10-20",
  format: "Standard (9ED)",
  date: "2005-08-20",
  source: 'docs/planning/deck-selection/review/2005.md',
  decks: [
    { id: "power-2005-1-jason-olynyk-viridian-rats", file: "1-jason-olynyk-viridian-rats.dck" },
    { id: "power-2005-1-takuma-morofuji-tooth-and-nail", file: "1-takuma-morofuji-tooth-and-nail.dck" },
    { id: "power-2005-1-douwe-van-noordenburg-red-aggro", file: "1-douwe-van-noordenburg-red-aggro.dck" },
    { id: "power-2005-3-masashi-oiso-mono-blue-tron", file: "3-masashi-oiso-mono-blue-tron.dck" },
    { id: "power-2005-2-neil-reeves-jushi-blue", file: "2-neil-reeves-jushi-blue.dck" },
    { id: "power-2005-3-michael-patnik-white-weenie", file: "3-michael-patnik-white-weenie.dck" },
    { id: "power-2005-5-rudy-meyer-mono-green-aggro", file: "5-rudy-meyer-mono-green-aggro.dck" },
  ],
};

/**
 * The 2006 power summer — `Standard (CSP)`, 2006-08-20 to 2006-10-20, the last
 * Standard snapshot before that fall's rotation. 27 legal candidate decks from
 * that summer's Nationals and regional events (`docs/planning/
 * deck-selection/review/2006.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 6, U 6, B 5, R 5, G 4;
 * aggro 5, midrange 3, control 4, combo 0.
 */
export const POWER_SUMMER_2006_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2006',
  directory: `${DECKS_ROOT}/standard-2006`,
  event: "2006 power summer — Standard (CSP), 2006-08-20 → 2006-10-20",
  format: "Standard (CSP)",
  date: "2006-08-20",
  source: 'docs/planning/deck-selection/review/2006.md',
  decks: [
    { id: "power-2006-1-katsuhiro-mori-structure-and-force", file: "1-katsuhiro-mori-structure-and-force.dck" },
    { id: "power-2006-1-paul-cheon-solar-flare", file: "1-paul-cheon-solar-flare.dck" },
    { id: "power-2006-1-kamiel-cornelissen-sea-stompy", file: "1-kamiel-cornelissen-sea-stompy.dck" },
    { id: "power-2006-1-sylvain-lauriol-wu-weenie", file: "1-sylvain-lauriol-wu-weenie.dck" },
    { id: "power-2006-1-romain-lisciandro-gruul-aggro", file: "1-romain-lisciandro-gruul-aggro.dck" },
    { id: "power-2006-3-hidenori-katayama-sand-burn", file: "3-hidenori-katayama-sand-burn.dck" },
    { id: "power-2006-2-benjamin-lundquist-izzetron", file: "2-benjamin-lundquist-izzetron.dck" },
    { id: "power-2006-2-amiel-tenenbaum-u-r-magnivore", file: "2-amiel-tenenbaum-u-r-magnivore.dck" },
    { id: "power-2006-2-robert-van-medevoort-junk", file: "2-robert-van-medevoort-junk.dck" },
    { id: "power-2006-1-katsuhiro-mori-ghazi-glare", file: "1-katsuhiro-mori-ghazi-glare.dck" },
    { id: "power-2006-5-holger-althues-enduring-ideal", file: "5-holger-althues-enduring-ideal.dck" },
    { id: "power-2006-5-tristan-guedj-orzhov-control", file: "5-tristan-guedj-orzhov-control.dck" },
  ],
};

/**
 * The 2007 power summer — `Standard (10E)`, 2007-07-20 to 2007-10-20, the last
 * Standard snapshot before that fall's rotation. 21 legal candidate decks from
 * that summer's Nationals events (`docs/planning/
 * deck-selection/review/2007.md` has the full table and the ones dropped as illegal or
 * near-duplicate); 12 chosen, one per archetype, searched for colour and style
 * spread: W 5, U 7, B 5, R 6, G 6;
 * aggro 3, midrange 4, control 2, combo 3.
 */
export const POWER_SUMMER_2007_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2007',
  directory: `${DECKS_ROOT}/standard-2007`,
  event: "2007 power summer — Standard (10E), 2007-07-20 → 2007-10-20",
  format: "Standard (10E)",
  date: "2007-07-20",
  source: 'docs/planning/deck-selection/review/2007.md',
  decks: [
    { id: "power-2007-1-masaya-kitayama-goyf-rack", file: "1-masaya-kitayama-goyf-rack.dck" },
    { id: "power-2007-1-andrew-ting-a-kee-wur-blink", file: "1-andrew-ting-a-kee-wur-blink.dck" },
    { id: "power-2007-1-craig-the-prof-jones-rdw-2k7", file: "1-craig-the-prof-jones-rdw-2k7.dck" },
    { id: "power-2007-1-luis-scott-vargas-omnichord", file: "1-luis-scott-vargas-omnichord.dck" },
    { id: "power-2007-2-shaun-mclaren-angelfire", file: "2-shaun-mclaren-angelfire.dck" },
    { id: "power-2007-2-ren-ishikawa-swath-storm", file: "2-ren-ishikawa-swath-storm.dck" },
    { id: "power-2007-2-stuart-wright-dredge-bridge-ii", file: "2-stuart-wright-dredge-bridge-ii.dck" },
    { id: "power-2007-3-makoto-nagashima-project-x", file: "3-makoto-nagashima-project-x.dck" },
    { id: "power-2007-3-craig-chapman-ubr-teachings", file: "3-craig-chapman-ubr-teachings.dck" },
    { id: "power-2007-5-the-nameless-one-uw-control", file: "5-the-nameless-one-uw-control.dck" },
    { id: "power-2007-5-antonino-de-rosa-rakdos-10-gargadon-on-bob", file: "5-antonino-de-rosa-rakdos-10-gargadon-on-bob.dck" },
    { id: "power-2007-5-anatoli-lightfoot-glare", file: "5-anatoli-lightfoot-glare.dck" },
  ],
};

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
  family: 'standard',
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
  family: 'standard',
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
  family: 'standard',
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
  family: 'standard',
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
  family: 'standard',
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
  family: 'standard',
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
  family: 'standard',
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
  family: 'standard',
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
  family: 'standard',
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

/*
 * Modern 2012-2016 (wave 48 §M) — Modern does not rotate, so each year's era
 * is pinned to that year's Standard era's own dates (Settled): the snapshot
 * is the latest Archived/Modern/ file on or before Standard's `start`, and
 * the season window is Standard's `season_start` -> `end`. Modern was created
 * August 2011, so 2012 is its first power summer.
 */

/**
 * The 2012 Modern power summer — `Modern (M13)`, 2012-07-13 to 2012-10-05
 * (Standard 2012's own dates). 14 legal candidate decks (`docs/planning/
 * deck-selection/review/modern-2012.md` has the full table); 12 chosen, one
 * per archetype, searched for colour and style spread: W 2, U 7, B 5, R 7, G 6;
 * aggro 4, midrange 2, control 3, combo 3.
 */
export const POWER_SUMMER_2012_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2012',
  directory: `${DECKS_ROOT}/modern-2012`,
  event: "2012 Modern power summer — Modern (M13), 2012-07-13 → 2012-10-05",
  format: "Modern (M13)",
  date: "2012-07-13",
  source: 'docs/planning/deck-selection/review/modern-2012.md',
  decks: [
    { id: "power-modern-2012-1-david-d-esposito-jund", file: "1-david-d-esposito-jund.dck" },
    { id: "power-modern-2012-1-gallinari-samuele-twin-exarch", file: "1-gallinari-samuele-twin-exarch.dck" },
    { id: "power-modern-2012-1-lorenzo-marinuzzi-gr-tron", file: "1-lorenzo-marinuzzi-gr-tron.dck" },
    { id: "power-modern-2012-1-jeffrey-tang-affinity", file: "1-jeffrey-tang-affinity.dck" },
    { id: "power-modern-2012-1-marco-dolazza-faeries", file: "1-marco-dolazza-faeries.dck" },
    { id: "power-modern-2012-1-nicolas-cuenca-aggro-loam", file: "1-nicolas-cuenca-aggro-loam.dck" },
    { id: "power-modern-2012-1-stefano-meoni-rug-tempo", file: "1-stefano-meoni-rug-tempo.dck" },
    { id: "power-modern-2012-1-andy-burden-red-deck-wins", file: "1-andy-burden-red-deck-wins.dck" },
    { id: "power-modern-2012-1-roberto-bonadeo-living-end", file: "1-roberto-bonadeo-living-end.dck" },
    { id: "power-modern-2012-1-luca-ravagli-next-level-u", file: "1-luca-ravagli-next-level-u.dck" },
    { id: "power-modern-2012-2-matej-zatlkaj-dredgevine", file: "2-matej-zatlkaj-dredgevine.dck" },
    { id: "power-modern-2012-5-john-alesi-gift-tron", file: "5-john-alesi-gift-tron.dck" },
  ],
};

/**
 * The 2013 Modern power summer — `Modern (M14)`, 2013-07-19 to 2013-09-27
 * (Standard 2013's own dates). 36 legal candidate decks (`docs/planning/
 * deck-selection/review/modern-2013.md` has the full table); 12 chosen, one
 * per archetype, searched for colour and style spread: W 6, U 5, B 4, R 6, G 6;
 * aggro 5, midrange 1, control 3, combo 3.
 */
export const POWER_SUMMER_2013_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2013',
  directory: `${DECKS_ROOT}/modern-2013`,
  event: "2013 Modern power summer — Modern (M14), 2013-07-19 → 2013-09-27",
  format: "Modern (M14)",
  date: "2013-07-19",
  source: 'docs/planning/deck-selection/review/modern-2013.md',
  decks: [
    { id: "power-modern-2013-1-doug-potter-jund", file: "1-doug-potter-jund.dck" },
    { id: "power-modern-2013-1-dmitrij-verev-uwr-midrange", file: "1-dmitrij-verev-uwr-midrange.dck" },
    { id: "power-modern-2013-1-giulio-pasqui-twin-exarch", file: "1-giulio-pasqui-twin-exarch.dck" },
    { id: "power-modern-2013-1-daniel-ahlberg-gr-tron", file: "1-daniel-ahlberg-gr-tron.dck" },
    { id: "power-modern-2013-1-chi-hoi-yim-uw-control", file: "1-chi-hoi-yim-uw-control.dck" },
    { id: "power-modern-2013-1-ajburn94-living-end", file: "1-ajburn94-living-end.dck" },
    { id: "power-modern-2013-1-tenaciousdealer-doran-junk", file: "1-tenaciousdealer-doran-junk.dck" },
    { id: "power-modern-2013-1-tim-muller-martyr-life", file: "1-tim-muller-martyr-life.dck" },
    { id: "power-modern-2013-1-the-great-dustini-delverless-rug", file: "1-the-great-dustini-delverless-rug.dck" },
    { id: "power-modern-2013-1-ferenc-nagy-bw-hatebear", file: "1-ferenc-nagy-bw-hatebear.dck" },
    { id: "power-modern-2013-1-wesley-bergen-boros", file: "1-wesley-bergen-boros.dck" },
    { id: "power-modern-2013-1-mattia-rizzi-scapeshift", file: "1-mattia-rizzi-scapeshift.dck" },
  ],
};

/**
 * The 2014 Modern power summer — `Modern (M15)`, 2014-07-18 to 2014-09-26
 * (Standard 2014's own dates). 27 legal candidate decks (`docs/planning/
 * deck-selection/review/modern-2014.md` has the full table); 12 chosen, one
 * per archetype, searched for colour and style spread: W 4, U 5, B 4, R 6, G 6;
 * aggro 4, midrange 2, control 3, combo 3.
 */
export const POWER_SUMMER_2014_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2014',
  directory: `${DECKS_ROOT}/modern-2014`,
  event: "2014 Modern power summer — Modern (M15), 2014-07-18 → 2014-09-26",
  format: "Modern (M15)",
  date: "2014-07-18",
  source: 'docs/planning/deck-selection/review/modern-2014.md',
  decks: [
    { id: "power-modern-2014-1-giuseppe-reale-u-tron", file: "1-giuseppe-reale-u-tron.dck" },
    { id: "power-modern-2014-1-stefano-vinci-jund", file: "1-stefano-vinci-jund.dck" },
    { id: "power-modern-2014-1-bryon-king-the-rock", file: "1-bryon-king-the-rock.dck" },
    { id: "power-modern-2014-1-simone-lampasona-scapeshift", file: "1-simone-lampasona-scapeshift.dck" },
    { id: "power-modern-2014-1-marco-santopadre-uw-midrange", file: "1-marco-santopadre-uw-midrange.dck" },
    { id: "power-modern-2014-1-byron-king-burn", file: "1-byron-king-burn.dck" },
    { id: "power-modern-2014-1-oskar-wall-gr-tron", file: "1-oskar-wall-gr-tron.dck" },
    { id: "power-modern-2014-1-seamus-burke-merfolk", file: "1-seamus-burke-merfolk.dck" },
    { id: "power-modern-2014-1-neeraj-shukla-ad-nauseam", file: "1-neeraj-shukla-ad-nauseam.dck" },
    { id: "power-modern-2014-1-blake-sanford-martyr-life", file: "1-blake-sanford-martyr-life.dck" },
    { id: "power-modern-2014-1-itou-manabu-gruul-control", file: "1-itou-manabu-gruul-control.dck" },
    { id: "power-modern-2014-2-valerio-bartolini-living-end", file: "2-valerio-bartolini-living-end.dck" },
  ],
};

/**
 * The 2015 Modern power summer — `Modern (ORI)`, 2015-07-17 to 2015-10-02
 * (Standard 2015's own dates). 35 legal candidate decks (`docs/planning/
 * deck-selection/review/modern-2015.md` has the full table); 12 chosen, one
 * per archetype, searched for colour and style spread: W 4, U 6, B 4, R 5, G 6;
 * aggro 4, midrange 2, control 3, combo 3.
 */
export const POWER_SUMMER_2015_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2015',
  directory: `${DECKS_ROOT}/modern-2015`,
  event: "2015 Modern power summer — Modern (ORI), 2015-07-17 → 2015-10-02",
  format: "Modern (ORI)",
  date: "2015-07-17",
  source: 'docs/planning/deck-selection/review/modern-2015.md',
  decks: [
    { id: "power-modern-2015-1-michael-sjamputra-affinity", file: "1-michael-sjamputra-affinity.dck" },
    { id: "power-modern-2015-1-joseph-herrera-jund", file: "1-joseph-herrera-jund.dck" },
    { id: "power-modern-2015-1-huang-ta-chi-gr-tron", file: "1-huang-ta-chi-gr-tron.dck" },
    { id: "power-modern-2015-1-hunter-platt-scapeshift", file: "1-hunter-platt-scapeshift.dck" },
    { id: "power-modern-2015-1-barone-chris-zoo", file: "1-barone-chris-zoo.dck" },
    { id: "power-modern-2015-1-daniel-villamizar-uwx-midrange", file: "1-daniel-villamizar-uwx-midrange.dck" },
    { id: "power-modern-2015-1-martin-muller-living-end", file: "1-martin-muller-living-end.dck" },
    { id: "power-modern-2015-1-andrew-mironovich-evil-twin", file: "1-andrew-mironovich-evil-twin.dck" },
    { id: "power-modern-2015-1-phil-silberman-uw-control-titan", file: "1-phil-silberman-uw-control-titan.dck" },
    { id: "power-modern-2015-1-johan-verhulst-tooth-and-nail", file: "1-johan-verhulst-tooth-and-nail.dck" },
    { id: "power-modern-2015-1-dario-casati-merfolk", file: "1-dario-casati-merfolk.dck" },
    { id: "power-modern-2015-1-deepfinesse-ur-aggro", file: "1-deepfinesse-ur-aggro.dck" },
  ],
};

/**
 * The 2016 Modern power summer — `Modern (EMN)`, 2016-07-22 to 2016-09-30
 * (Standard 2016's own dates). 30 legal candidate decks (`docs/planning/
 * deck-selection/review/modern-2016.md` has the full table); 12 chosen, one
 * per archetype, searched for colour and style spread: W 6, U 7, B 5, R 5, G 7;
 * aggro 4, midrange 4, control 1, combo 3.
 */
export const POWER_SUMMER_2016_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2016',
  directory: `${DECKS_ROOT}/modern-2016`,
  event: "2016 Modern power summer — Modern (EMN), 2016-07-22 → 2016-09-30",
  format: "Modern (EMN)",
  date: "2016-07-22",
  source: 'docs/planning/deck-selection/review/modern-2016.md',
  decks: [
    { id: "power-modern-2016-1-steven-martin-affinity", file: "1-steven-martin-affinity.dck" },
    { id: "power-modern-2016-1-bsweitz-eldrazi-aggro", file: "1-bsweitz-eldrazi-aggro.dck" },
    { id: "power-modern-2016-1-jan-ang-infect", file: "1-jan-ang-infect.dck" },
    { id: "power-modern-2016-1-bernardo-santos-scapeshift", file: "1-bernardo-santos-scapeshift.dck" },
    { id: "power-modern-2016-1-miguel-angel-nu-ez-dredge", file: "1-miguel-angel-nu-ez-dredge.dck" },
    { id: "power-modern-2016-1-thiago-saporito-abzan", file: "1-thiago-saporito-abzan.dck" },
    { id: "power-modern-2016-1-tang-kobe-w-b-hatebear", file: "1-tang-kobe-w-b-hatebear.dck" },
    { id: "power-modern-2016-1-lukas-mittendorfer-jund", file: "1-lukas-mittendorfer-jund.dck" },
    { id: "power-modern-2016-1-alessandro-casamenti-ad-nauseam", file: "1-alessandro-casamenti-ad-nauseam.dck" },
    { id: "power-modern-2016-1-damien-chabrier-rg-breach", file: "1-damien-chabrier-rg-breach.dck" },
    { id: "power-modern-2016-1-saito-takaya-esper-midrange", file: "1-saito-takaya-esper-midrange.dck" },
    { id: "power-modern-2016-1-avignon-uw-control", file: "1-avignon-uw-control.dck" },
  ],
};

/**
 * The 2005 Legacy power summer — `Legacy (9ED)`, 2005-08-20 to 2005-10-20
 * (Standard 2005's own dates). 4 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2005.md` has the full table); 4 chosen.
 */
export const POWER_SUMMER_2005_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2005',
  directory: `${DECKS_ROOT}/legacy-2005`,
  event: "2005 Legacy power summer \u2014 Legacy (9ED), 2005-08-20 \u2192 2005-10-20",
  format: "Legacy (9ED)",
  date: "2005-08-20",
  source: 'docs/planning/deck-selection/review/legacy-2005.md',
  decks: [
    { id: "power-legacy-2005-1-michael-riley-r-vial-goblins", file: "1-michael-riley-r-vial-goblins.dck" },
    { id: "power-legacy-2005-2-peter-franke-r-tiger-sligh", file: "2-peter-franke-r-tiger-sligh.dck" },
    { id: "power-legacy-2005-3-zvi-mowshowitz-uw-landstill", file: "3-zvi-mowshowitz-uw-landstill.dck" },
    { id: "power-legacy-2005-2-xenoq-burn", file: "2-xenoq-burn.dck" },
  ],
};

/**
 * The 2006 Legacy power summer — `Legacy (CSP)`, 2006-08-20 to 2006-10-20
 * (Standard 2006's own dates). 8 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2006.md` has the full table); 7 chosen.
 */
export const POWER_SUMMER_2006_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2006',
  directory: `${DECKS_ROOT}/legacy-2006`,
  event: "2006 Legacy power summer \u2014 Legacy (CSP), 2006-08-20 \u2192 2006-10-20",
  format: "Legacy (CSP)",
  date: "2006-08-20",
  source: 'docs/planning/deck-selection/review/legacy-2006.md',
  decks: [
    { id: "power-legacy-2006-1-mike-herbig-herbig-solidarity", file: "1-mike-herbig-herbig-solidarity.dck" },
    { id: "power-legacy-2006-1-tom-smart-goblins", file: "1-tom-smart-goblins.dck" },
    { id: "power-legacy-2006-1-james-tang-gat", file: "1-james-tang-gat.dck" },
    { id: "power-legacy-2006-2-chris-pikula-rogue-deadguy-ale-a-homebrew", file: "2-chris-pikula-rogue-deadguy-ale-a-homebrew.dck" },
    { id: "power-legacy-2006-3-luca-verdiani-recsur", file: "3-luca-verdiani-recsur.dck" },
    { id: "power-legacy-2006-3-pasquale-ruggiero-red-white-rift", file: "3-pasquale-ruggiero-red-white-rift.dck" },
    { id: "power-legacy-2006-5-maximilian-bracht-salvager", file: "5-maximilian-bracht-salvager.dck" },
  ],
};

/**
 * The 2007 Legacy power summer — `Legacy (10E)`, 2007-07-20 to 2007-10-20
 * (Standard 2007's own dates). 19 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2007.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2007_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2007',
  directory: `${DECKS_ROOT}/legacy-2007`,
  event: "2007 Legacy power summer \u2014 Legacy (10E), 2007-07-20 \u2192 2007-10-20",
  format: "Legacy (10E)",
  date: "2007-07-20",
  source: 'docs/planning/deck-selection/review/legacy-2007.md',
  decks: [
    { id: "power-legacy-2007-1-andrea-maccagnani-goblins", file: "1-andrea-maccagnani-goblins.dck" },
    { id: "power-legacy-2007-1-alessandro-teneggi-cephalid-breakfast", file: "1-alessandro-teneggi-cephalid-breakfast.dck" },
    { id: "power-legacy-2007-1-christian-hottgen-survival", file: "1-christian-hottgen-survival.dck" },
    { id: "power-legacy-2007-1-anton-karlinski-aggro-loam", file: "1-anton-karlinski-aggro-loam.dck" },
    { id: "power-legacy-2007-1-osada-masahiro-3c-sligh", file: "1-osada-masahiro-3c-sligh.dck" },
    { id: "power-legacy-2007-2-matthias-druppel-landstill", file: "2-matthias-druppel-landstill.dck" },
    { id: "power-legacy-2007-2-koizumi-yohei-aluren", file: "2-koizumi-yohei-aluren.dck" },
    { id: "power-legacy-2007-2-ryan-trepanier-lands", file: "2-ryan-trepanier-lands.dck" },
    { id: "power-legacy-2007-3-tsuda-yuugo-belcher", file: "3-tsuda-yuugo-belcher.dck" },
    { id: "power-legacy-2007-3-stefano-maccagnani-uw-control", file: "3-stefano-maccagnani-uw-control.dck" },
    { id: "power-legacy-2007-5-takamizu-tomohiro-muc", file: "5-takamizu-tomohiro-muc.dck" },
    { id: "power-legacy-2007-5-ogasawara-sho-pikula", file: "5-ogasawara-sho-pikula.dck" },
  ],
};

/**
 * The 2008 Legacy power summer — `Legacy (EVE)`, 2008-07-25 to 2008-10-03
 * (Standard 2008's own dates). 26 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2008.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2008_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2008',
  directory: `${DECKS_ROOT}/legacy-2008`,
  event: "2008 Legacy power summer \u2014 Legacy (EVE), 2008-07-25 \u2192 2008-10-03",
  format: "Legacy (EVE)",
  date: "2008-07-25",
  source: 'docs/planning/deck-selection/review/legacy-2008.md',
  decks: [
    { id: "power-legacy-2008-1-alvise-gorghetto-ichorid", file: "1-alvise-gorghetto-ichorid.dck" },
    { id: "power-legacy-2008-1-jaime-cano-landstill", file: "1-jaime-cano-landstill.dck" },
    { id: "power-legacy-2008-1-leonardo-romano-bgw-the-rock", file: "1-leonardo-romano-bgw-the-rock.dck" },
    { id: "power-legacy-2008-1-yamazaki-keiji-purple-death", file: "1-yamazaki-keiji-purple-death.dck" },
    { id: "power-legacy-2008-1-guillem-ragull-rgb-goblins", file: "1-guillem-ragull-rgb-goblins.dck" },
    { id: "power-legacy-2008-1-markus-seine-rgb-goyf-sligh", file: "1-markus-seine-rgb-goyf-sligh.dck" },
    { id: "power-legacy-2008-1-baptist-matthys-lftl-aggro-relou", file: "1-baptist-matthys-lftl-aggro-relou.dck" },
    { id: "power-legacy-2008-1-rodrigo-gonzalez-reanimator", file: "1-rodrigo-gonzalez-reanimator.dck" },
    { id: "power-legacy-2008-3-matthew-elias-belcher", file: "3-matthew-elias-belcher.dck" },
    { id: "power-legacy-2008-2-jordi-amat-ipop-negation", file: "2-jordi-amat-ipop-negation.dck" },
    { id: "power-legacy-2008-2-pablo-david-diaz-eternal-garden", file: "2-pablo-david-diaz-eternal-garden.dck" },
    { id: "power-legacy-2008-3-carcara-giuseppe-enduring-ideal", file: "3-carcara-giuseppe-enduring-ideal.dck" },
  ],
};

/**
 * The 2009 Legacy power summer — `Legacy (M10)`, 2009-07-17 to 2009-10-02
 * (Standard 2009's own dates). 16 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2009.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2009_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2009',
  directory: `${DECKS_ROOT}/legacy-2009`,
  event: "2009 Legacy power summer \u2014 Legacy (M10), 2009-07-17 \u2192 2009-10-02",
  format: "Legacy (M10)",
  date: "2009-07-17",
  source: 'docs/planning/deck-selection/review/legacy-2009.md',
  decks: [
    { id: "power-legacy-2009-1-frederic-joe-la-loose-perez-goyfslight", file: "1-frederic-joe-la-loose-perez-goyfslight.dck" },
    { id: "power-legacy-2009-1-quentin-gouedard-uw-stax", file: "1-quentin-gouedard-uw-stax.dck" },
    { id: "power-legacy-2009-1-francesco-dalla-via-dragon-stompy", file: "1-francesco-dalla-via-dragon-stompy.dck" },
    { id: "power-legacy-2009-1-gabriel-nassif-next-level-blue", file: "1-gabriel-nassif-next-level-blue.dck" },
    { id: "power-legacy-2009-2-jean-mary-lejay-accart-eternal-life", file: "2-jean-mary-lejay-accart-eternal-life.dck" },
    { id: "power-legacy-2009-3-manuel-wolf-tes", file: "3-manuel-wolf-tes.dck" },
    { id: "power-legacy-2009-5-maxime-jourdan-ant", file: "5-maxime-jourdan-ant.dck" },
    { id: "power-legacy-2009-5-jean-luc-rivoire-bgw-rock", file: "5-jean-luc-rivoire-bgw-rock.dck" },
    { id: "power-legacy-2009-5-brian-six-tarmo-sligh", file: "5-brian-six-tarmo-sligh.dck" },
    { id: "power-legacy-2009-5-brian-kowal-tarmo-pikula", file: "5-brian-kowal-tarmo-pikula.dck" },
    { id: "power-legacy-2009-6-filiberto-piernoli-imperial-painter", file: "6-filiberto-piernoli-imperial-painter.dck" },
    { id: "power-legacy-2009-13-michael-danis-uwb-landstill", file: "13-michael-danis-uwb-landstill.dck" },
  ],
};

/**
 * The 2010 Legacy power summer — `Legacy (M11)`, 2010-07-16 to 2010-10-01
 * (Standard 2010's own dates). 22 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2010.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2010_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2010',
  directory: `${DECKS_ROOT}/legacy-2010`,
  event: "2010 Legacy power summer \u2014 Legacy (M11), 2010-07-16 \u2192 2010-10-01",
  format: "Legacy (M11)",
  date: "2010-07-16",
  source: 'docs/planning/deck-selection/review/legacy-2010.md',
  decks: [
    { id: "power-legacy-2010-1-eddy-pereira-burning-animals", file: "1-eddy-pereira-burning-animals.dck" },
    { id: "power-legacy-2010-1-reto-sormani-rw-burn", file: "1-reto-sormani-rw-burn.dck" },
    { id: "power-legacy-2010-3-dan-monzon-axe-gang-fae", file: "3-dan-monzon-axe-gang-fae.dck" },
    { id: "power-legacy-2010-2-camille-assassin-pouliquen-goblins", file: "2-camille-assassin-pouliquen-goblins.dck" },
    { id: "power-legacy-2010-5-frizork-ant", file: "5-frizork-ant.dck" },
    { id: "power-legacy-2010-2-marc-tobiasch-uw-landstill", file: "2-marc-tobiasch-uw-landstill.dck" },
    { id: "power-legacy-2010-2-tom-martell-four-color-counterbalance", file: "2-tom-martell-four-color-counterbalance.dck" },
    { id: "power-legacy-2010-3-nicola-cantarutti-ichorid", file: "3-nicola-cantarutti-ichorid.dck" },
    { id: "power-legacy-2010-6-cedric-phillips-belcher", file: "6-cedric-phillips-belcher.dck" },
    { id: "power-legacy-2010-7-chris-woltereck-42-lands", file: "7-chris-woltereck-42-lands.dck" },
    { id: "power-legacy-2010-5-yuu-saitou-ad-nauseam-tendrils", file: "5-yuu-saitou-ad-nauseam-tendrils.dck" },
    { id: "power-legacy-2010-5-yuuya-hosokawa-elf-combo", file: "5-yuuya-hosokawa-elf-combo.dck" },
  ],
};

/**
 * The 2011 Legacy power summer — `Legacy (M12)`, 2011-07-15 to 2011-09-30
 * (Standard 2011's own dates). 27 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2011.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2011_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2011',
  directory: `${DECKS_ROOT}/legacy-2011`,
  event: "2011 Legacy power summer \u2014 Legacy (M12), 2011-07-15 \u2192 2011-09-30",
  format: "Legacy (M12)",
  date: "2011-07-15",
  source: 'docs/planning/deck-selection/review/legacy-2011.md',
  decks: [
    { id: "power-legacy-2011-1-gerry-thompson-team-america", file: "1-gerry-thompson-team-america.dck" },
    { id: "power-legacy-2011-1-alberto-manchado-caw-blade", file: "1-alberto-manchado-caw-blade.dck" },
    { id: "power-legacy-2011-1-krings-stefan-hive-mind", file: "1-krings-stefan-hive-mind.dck" },
    { id: "power-legacy-2011-1-vojtech-mraz-white-weenie", file: "1-vojtech-mraz-white-weenie.dck" },
    { id: "power-legacy-2011-1-erik-manooshism-show-tell", file: "1-erik-manooshism-show-tell.dck" },
    { id: "power-legacy-2011-1-ghesini-andrea-dark-threshold", file: "1-ghesini-andrea-dark-threshold.dck" },
    { id: "power-legacy-2011-1-pierre-sommen-dark-horizon", file: "1-pierre-sommen-dark-horizon.dck" },
    { id: "power-legacy-2011-1-pat-cox-zoo", file: "1-pat-cox-zoo.dck" },
    { id: "power-legacy-2011-1-iain-bartolomei-goblins", file: "1-iain-bartolomei-goblins.dck" },
    { id: "power-legacy-2011-1-manuel-gomez-burn", file: "1-manuel-gomez-burn.dck" },
    { id: "power-legacy-2011-1-michael-caffrey-eternal-garden", file: "1-michael-caffrey-eternal-garden.dck" },
    { id: "power-legacy-2011-1-svatopluk-sejkora-cephalid-breakfast", file: "1-svatopluk-sejkora-cephalid-breakfast.dck" },
  ],
};

/**
 * The 2012 Legacy power summer — `Legacy (M13)`, 2012-07-13 to 2012-10-05
 * (Standard 2012's own dates). 22 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2012.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2012_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2012',
  directory: `${DECKS_ROOT}/legacy-2012`,
  event: "2012 Legacy power summer \u2014 Legacy (M13), 2012-07-13 \u2192 2012-10-05",
  format: "Legacy (M13)",
  date: "2012-07-13",
  source: 'docs/planning/deck-selection/review/legacy-2012.md',
  decks: [
    { id: "power-legacy-2012-1-max-tietze-goblins", file: "1-max-tietze-goblins.dck" },
    { id: "power-legacy-2012-1-michael-hetrick-uw-miracles", file: "1-michael-hetrick-uw-miracles.dck" },
    { id: "power-legacy-2012-1-vidianto-wijaya-esper-stoneblade", file: "1-vidianto-wijaya-esper-stoneblade.dck" },
    { id: "power-legacy-2012-1-mark-eilers-dredge", file: "1-mark-eilers-dredge.dck" },
    { id: "power-legacy-2012-1-jonathan-hickerson-sneak-attack", file: "1-jonathan-hickerson-sneak-attack.dck" },
    { id: "power-legacy-2012-1-bobby-kovacs-eternal-garden", file: "1-bobby-kovacs-eternal-garden.dck" },
    { id: "power-legacy-2012-1-shane-kovaleski-elves", file: "1-shane-kovaleski-elves.dck" },
    { id: "power-legacy-2012-1-corrado-anchisi-aggro-loam", file: "1-corrado-anchisi-aggro-loam.dck" },
    { id: "power-legacy-2012-1-umberto-vuolo-traves", file: "1-umberto-vuolo-traves.dck" },
    { id: "power-legacy-2012-2-eric-fry-mud", file: "2-eric-fry-mud.dck" },
    { id: "power-legacy-2012-2-benjamin-niehaus-burn", file: "2-benjamin-niehaus-burn.dck" },
    { id: "power-legacy-2012-4-andrea-martinelli-the-rock-junk", file: "4-andrea-martinelli-the-rock-junk.dck" },
  ],
};

/**
 * The 2013 Legacy power summer — `Legacy (M14)`, 2013-07-19 to 2013-09-27
 * (Standard 2013's own dates). 28 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2013.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2013_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2013',
  directory: `${DECKS_ROOT}/legacy-2013`,
  event: "2013 Legacy power summer \u2014 Legacy (M14), 2013-07-19 \u2192 2013-09-27",
  format: "Legacy (M14)",
  date: "2013-07-19",
  source: 'docs/planning/deck-selection/review/legacy-2013.md',
  decks: [
    { id: "power-legacy-2013-1-reid-duke-elves", file: "1-reid-duke-elves.dck" },
    { id: "power-legacy-2013-1-jonathan-suarez-painter", file: "1-jonathan-suarez-painter.dck" },
    { id: "power-legacy-2013-1-tobias-dreger-goblins", file: "1-tobias-dreger-goblins.dck" },
    { id: "power-legacy-2013-1-tony-chu-jund", file: "1-tony-chu-jund.dck" },
    { id: "power-legacy-2013-1-gerry-thompson-team-america", file: "1-gerry-thompson-team-america.dck" },
    { id: "power-legacy-2013-1-rune-j-rgensen-sneak-show", file: "1-rune-j-rgensen-sneak-show.dck" },
    { id: "power-legacy-2013-1-bryant-cook-tes", file: "1-bryant-cook-tes.dck" },
    { id: "power-legacy-2013-1-guillaume-perbet-junk", file: "1-guillaume-perbet-junk.dck" },
    { id: "power-legacy-2013-1-chris-andersen-tezzeret-control", file: "1-chris-andersen-tezzeret-control.dck" },
    { id: "power-legacy-2013-1-raphael-werder-uw-miracle", file: "1-raphael-werder-uw-miracle.dck" },
    { id: "power-legacy-2013-2-jonathan-kurpaska-death-taxes", file: "2-jonathan-kurpaska-death-taxes.dck" },
    { id: "power-legacy-2013-2-thomas-genzman-patriot", file: "2-thomas-genzman-patriot.dck" },
  ],
};

/**
 * The 2014 Legacy power summer — `Legacy (M15)`, 2014-07-18 to 2014-09-26
 * (Standard 2014's own dates). 29 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2014.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2014_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2014',
  directory: `${DECKS_ROOT}/legacy-2014`,
  event: "2014 Legacy power summer \u2014 Legacy (M15), 2014-07-18 \u2192 2014-09-26",
  format: "Legacy (M15)",
  date: "2014-07-18",
  source: 'docs/planning/deck-selection/review/legacy-2014.md',
  decks: [
    { id: "power-legacy-2014-1-shane-remelt-uw-miracles", file: "1-shane-remelt-uw-miracles.dck" },
    { id: "power-legacy-2014-1-colin-logan-death-taxes", file: "1-colin-logan-death-taxes.dck" },
    { id: "power-legacy-2014-1-steve-medanic-elves", file: "1-steve-medanic-elves.dck" },
    { id: "power-legacy-2014-1-yamamoto-kentarou-sneak-show", file: "1-yamamoto-kentarou-sneak-show.dck" },
    { id: "power-legacy-2014-1-bryan-cambidge-burn", file: "1-bryan-cambidge-burn.dck" },
    { id: "power-legacy-2014-1-kurt-speiss-lands-eternal-garden", file: "1-kurt-speiss-lands-eternal-garden.dck" },
    { id: "power-legacy-2014-1-greg-smith-imperial-painter", file: "1-greg-smith-imperial-painter.dck" },
    { id: "power-legacy-2014-1-phimus-pan-bug-midrange", file: "1-phimus-pan-bug-midrange.dck" },
    { id: "power-legacy-2014-1-kennen-haas-glam-loam", file: "1-kennen-haas-glam-loam.dck" },
    { id: "power-legacy-2014-1-kenji-mantani-stoneblade", file: "1-kenji-mantani-stoneblade.dck" },
    { id: "power-legacy-2014-1-misha-meihsl-the-rock-junk", file: "1-misha-meihsl-the-rock-junk.dck" },
    { id: "power-legacy-2014-1-romain-fenaux-briot-dredge", file: "1-romain-fenaux-briot-dredge.dck" },
  ],
};

/**
 * The 2015 Legacy power summer — `Legacy (ORI)`, 2015-07-17 to 2015-10-02
 * (Standard 2015's own dates). 19 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2015.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2015_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2015',
  directory: `${DECKS_ROOT}/legacy-2015`,
  event: "2015 Legacy power summer \u2014 Legacy (ORI), 2015-07-17 \u2192 2015-10-02",
  format: "Legacy (ORI)",
  date: "2015-07-17",
  source: 'docs/planning/deck-selection/review/legacy-2015.md',
  decks: [
    { id: "power-legacy-2015-1-alexander-lorenz-lands-eternal-garden", file: "1-alexander-lorenz-lands-eternal-garden.dck" },
    { id: "power-legacy-2015-1-kellen-pastore-death-taxes", file: "1-kellen-pastore-death-taxes.dck" },
    { id: "power-legacy-2015-1-bobby-colegrove-elves", file: "1-bobby-colegrove-elves.dck" },
    { id: "power-legacy-2015-1-tristan-polzl-shardless-bug", file: "1-tristan-polzl-shardless-bug.dck" },
    { id: "power-legacy-2015-1-jack-kitchen-painter", file: "1-jack-kitchen-painter.dck" },
    { id: "power-legacy-2015-1-logan-mize-ur-delver", file: "1-logan-mize-ur-delver.dck" },
    { id: "power-legacy-2015-1-joseph-moreno-dredge", file: "1-joseph-moreno-dredge.dck" },
    { id: "power-legacy-2015-1-jonathan-alexander-kurz-storm", file: "1-jonathan-alexander-kurz-storm.dck" },
    { id: "power-legacy-2015-1-kazuhiro-koge-maverick", file: "1-kazuhiro-koge-maverick.dck" },
    { id: "power-legacy-2015-1-bruno-valerio-jund", file: "1-bruno-valerio-jund.dck" },
    { id: "power-legacy-2015-1-dalibor-szegho-the-rock-junk", file: "1-dalibor-szegho-the-rock-junk.dck" },
    { id: "power-legacy-2015-2-irie-shun-reanimator", file: "2-irie-shun-reanimator.dck" },
  ],
};

/**
 * The 2016 Legacy power summer — `Legacy (EMN)`, 2016-07-22 to 2016-09-30
 * (Standard 2016's own dates). 25 legal candidate decks (`docs/planning/
 * deck-selection/review/legacy-2016.md` has the full table); 12 chosen.
 */
export const POWER_SUMMER_2016_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2016',
  directory: `${DECKS_ROOT}/legacy-2016`,
  event: "2016 Legacy power summer \u2014 Legacy (EMN), 2016-07-22 \u2192 2016-09-30",
  format: "Legacy (EMN)",
  date: "2016-07-22",
  source: 'docs/planning/deck-selection/review/legacy-2016.md',
  decks: [
    { id: "power-legacy-2016-1-noah-walker-grixis-delver", file: "1-noah-walker-grixis-delver.dck" },
    { id: "power-legacy-2016-1-anton-karlinski-eldrazi-aggro", file: "1-anton-karlinski-eldrazi-aggro.dck" },
    { id: "power-legacy-2016-1-jarrod-feight-death-taxes", file: "1-jarrod-feight-death-taxes.dck" },
    { id: "power-legacy-2016-1-niklas-kronberger-loam", file: "1-niklas-kronberger-loam.dck" },
    { id: "power-legacy-2016-1-nicola-guidi-nic-fit", file: "1-nicola-guidi-nic-fit.dck" },
    { id: "power-legacy-2016-1-ivan-espinosa-shardless-bug", file: "1-ivan-espinosa-shardless-bug.dck" },
    { id: "power-legacy-2016-1-jan-lenger-elves", file: "1-jan-lenger-elves.dck" },
    { id: "power-legacy-2016-1-hori-masataka-lands", file: "1-hori-masataka-lands.dck" },
    { id: "power-legacy-2016-1-damon-whitby-dredge", file: "1-damon-whitby-dredge.dck" },
    { id: "power-legacy-2016-1-demetrio-morselli-mud", file: "1-demetrio-morselli-mud.dck" },
    { id: "power-legacy-2016-2-chevallier-michel-reanimator", file: "2-chevallier-michel-reanimator.dck" },
    { id: "power-legacy-2016-1-andrea-ghesini-stoneblade", file: "1-andrea-ghesini-stoneblade.dck" },
  ],
};


/** Every collection in the library, oldest era first. */
export const LIBRARY: readonly LibraryCollection[] = [
  POWER_SUMMER_2003_STANDARD,
  POWER_SUMMER_2004_STANDARD,
  POWER_SUMMER_2005_STANDARD,
  POWER_SUMMER_2006_STANDARD,
  POWER_SUMMER_2007_STANDARD,
  POWER_SUMMER_2008_STANDARD,
  POWER_SUMMER_2009_STANDARD,
  POWER_SUMMER_2010_STANDARD,
  POWER_SUMMER_2011_STANDARD,
  POWER_SUMMER_2012_STANDARD,
  POWER_SUMMER_2013_STANDARD,
  POWER_SUMMER_2014_STANDARD,
  POWER_SUMMER_2015_STANDARD,
  POWER_SUMMER_2016_STANDARD,
  POWER_SUMMER_2012_MODERN,
  POWER_SUMMER_2013_MODERN,
  POWER_SUMMER_2014_MODERN,
  POWER_SUMMER_2015_MODERN,
  POWER_SUMMER_2016_MODERN,
  POWER_SUMMER_2005_LEGACY,
  POWER_SUMMER_2006_LEGACY,
  POWER_SUMMER_2007_LEGACY,
  POWER_SUMMER_2008_LEGACY,
  POWER_SUMMER_2009_LEGACY,
  POWER_SUMMER_2010_LEGACY,
  POWER_SUMMER_2011_LEGACY,
  POWER_SUMMER_2012_LEGACY,
  POWER_SUMMER_2013_LEGACY,
  POWER_SUMMER_2014_LEGACY,
  POWER_SUMMER_2015_LEGACY,
  POWER_SUMMER_2016_LEGACY,
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
 * One fixture per (family, date) pair, named after both rather than the date
 * alone, because wave 48 pins Modern and Legacy eras to the SAME dates
 * Standard's own eras use (Settled) — Modern 2012 and Standard 2012 share
 * `2012-07-13` but need two different pools, Modern's wider by far. Named
 * after the collection date rather than the collection id, same as before,
 * because two collections in one family from the same date would share a
 * pool and regenerating it twice would be two chances to disagree — not
 * reached in this library, where every (family, date) pair is unique.
 *
 * `family` defaults to `'standard'`, so every existing call site —
 * `poolFixturePath(date)`, Standard's own usage throughout this package —
 * is unchanged: `decks/pools/standard-<date>.generated.json`, exactly the
 * path it wrote before `family` existed.
 */
export function poolFixturePath(date: string, family: FormatFamily = 'standard'): string {
  return `${DECKS_ROOT}/pools/${family}-${date}.generated.json`;
}

/**
 * Every date a pool is frozen for, which is every date a Standard fixture
 * file exists for. `build-pool-fixture.ts`'s header says why each one is
 * here — one per era, its `Effective` date.
 *
 * Here rather than in that script because two OTHER things now read the list —
 * `build-deck-costs.ts` and the drift guard in `library.test.ts` — and that
 * script cannot be imported for it: it loads the 183 MB corpus at module scope.
 * A list of committed files belongs beside the function that names them anyway.
 *
 * Kept for backward compatibility (every existing reader of this export still
 * gets exactly what it got before Modern and Legacy existed). It is dates
 * ACROSS EVERY FAMILY, so once the catalog grows past Standard a caller that
 * needs "all Standard dates" filters `LIBRARY` by `family === 'standard'`
 * itself, and a caller that needs "every (family, date) a fixture exists for"
 * uses {@link POOL_FIXTURE_KEYS} instead, which does not collapse two
 * families that share a date into one entry.
 */
export const POOL_FIXTURE_DATES: readonly string[] = LIBRARY.map((c) => c.date);

/**
 * Every (family, date) pair a pool is frozen for — one per collection,
 * unlike {@link POOL_FIXTURE_DATES}, which collapses two collections that
 * happen to share a date (Modern 2012 and Standard 2012, by design) into one
 * entry. `build-pool-fixture.ts`, `build-deck-costs.ts` and `library.test.ts`
 * use this one once the catalog holds more than Standard.
 */
export interface PoolFixtureKey {
  readonly family: FormatFamily;
  readonly date: string;
}

export const POOL_FIXTURE_KEYS: readonly PoolFixtureKey[] = LIBRARY.map((c) => ({
  family: c.family,
  date: c.date,
}));
