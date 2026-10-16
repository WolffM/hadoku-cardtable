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
 * The 1995 power summer — `Type 2 (CHR)`, 1995-07-01 to 1995-11-01, the format
 * in force on August 1st, Worlds’ month — Type 2 had no autumn rotation that
 * year. 9 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/1995.md` has the full table and the
 * ones dropped as illegal or near-duplicate); **Thin season: 9 chosen of 9
 * candidates.** One per archetype, searched for colour and style spread: W 3,
 * U 1, B 3, R 5, G 3; aggro 2, midrange 4, control 3, combo 0. Red dominated
 * this era’s candidate pool (33% of its colour pips) and was given extra slots
 * (5 of 9 chosen).
 */
export const POWER_SUMMER_1995_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-1995',
  directory: `${DECKS_ROOT}/standard-1995`,
  event: "1995 power summer — Type 2 (CHR), 1995-07-01 → 1995-11-01",
  format: "Type 2 (CHR)",
  date: "1995-07-01",
  source: 'docs/planning/deck-selection/review/1995.md',
  decks: [
    { id: "power-1995-1-mark-justice-gruul-aggro", file: "1-mark-justice-gruul-aggro.dck" },
    { id: "power-1995-2-henry-stern-vice-age", file: "2-henry-stern-vice-age.dck" },
    { id: "power-1995-3-mike-long-br-land-destruction", file: "3-mike-long-br-land-destruction.dck" },
    { id: "power-1995-1-alexander-blumke-rack-control", file: "1-alexander-blumke-rack-control.dck" },
    { id: "power-1995-4-peter-leiher-monoblack-discard", file: "4-peter-leiher-monoblack-discard.dck" },
    { id: "power-1995-11-scott-burke-disco-counterboat", file: "11-scott-burke-disco-counterboat.dck" },
    { id: "power-1995-2-marc-hernandez-wr-control", file: "2-marc-hernandez-wr-control.dck" },
    { id: "power-1995-5-ivan-curina-selesnya-aggro", file: "5-ivan-curina-selesnya-aggro.dck" },
    { id: "power-1995-5-andrea-redi-pre-sligh", file: "5-andrea-redi-pre-sligh.dck" },
  ],
};

/**
 * The 1996 power summer — `Type 2 (ALL)`, 1996-07-10 to 1996-10-01, the format
 * in force on August 1st, Worlds’ month — Type 2 had no autumn rotation that
 * year. 12 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/1996.md` has the full table and the
 * ones dropped as illegal or near-duplicate); **Thin season: 12 chosen of 12
 * candidates.** One per archetype, searched for colour and style spread: W 5,
 * U 1, B 5, R 6, G 4; aggro 5, midrange 5, control 2, combo 0. Red dominated
 * this era’s candidate pool (29% of its colour pips) and was given extra slots
 * (6 of 12 chosen).
 */
export const POWER_SUMMER_1996_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-1996',
  directory: `${DECKS_ROOT}/standard-1996`,
  event: "1996 power summer — Type 2 (ALL), 1996-07-10 → 1996-10-01",
  format: "Type 2 (ALL)",
  date: "1996-07-10",
  source: 'docs/planning/deck-selection/review/1996.md',
  decks: [
    { id: "power-1996-1-dennis-bentley-necropotence", file: "1-dennis-bentley-necropotence.dck" },
    { id: "power-1996-2-george-baxter-titania-s-lock", file: "2-george-baxter-titania-s-lock.dck" },
    { id: "power-1996-2-oliver-krebs-mardu-necropotence", file: "2-oliver-krebs-mardu-necropotence.dck" },
    { id: "power-1996-1-tom-chanpheng-blueless-weenie-white", file: "1-tom-chanpheng-blueless-weenie-white.dck" },
    { id: "power-1996-3-matthew-place-turbo-stasis", file: "3-matthew-place-turbo-stasis.dck" },
    { id: "power-1996-2-paul-sligh-sligh", file: "2-paul-sligh-sligh.dck" },
    { id: "power-1996-2-mark-justice-br-nevinyrral-s-necro", file: "2-mark-justice-br-nevinyrral-s-necro.dck" },
    { id: "power-1996-3-olle-rade-erhnam-gueddon", file: "3-olle-rade-erhnam-gueddon.dck" },
    { id: "power-1996-5-eric-tam-rg-ponza", file: "5-eric-tam-rg-ponza.dck" },
    { id: "power-1996-5-eric-tam-gwr-aggro", file: "5-eric-tam-gwr-aggro.dck" },
    { id: "power-1996-5-mark-justice-elkin-bottle-challenge-deck", file: "5-mark-justice-elkin-bottle-challenge-deck.dck" },
    { id: "power-1996-5-george-baxter-brg-aggro", file: "5-george-baxter-brg-aggro.dck" },
  ],
};

/**
 * The 1997 power summer — `Standard (WTH)`, 1997-07-01 to 1997-11-01, the last
 * Standard snapshot before that fall’s rotation. 12 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/1997.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 12 chosen of
 * 12 candidates.** One per archetype, searched for colour and style spread:
 * W 2, U 5, B 4, R 7, G 2; aggro 9, midrange 1, control 2, combo 0. Red
 * dominated this era’s candidate pool (35% of its colour pips) and was given
 * extra slots (7 of 12 chosen).
 */
export const POWER_SUMMER_1997_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-1997',
  directory: `${DECKS_ROOT}/standard-1997`,
  event: "1997 power summer — Standard (WTH), 1997-07-01 → 1997-11-01",
  format: "Standard (WTH)",
  date: "1997-07-01",
  source: 'docs/planning/deck-selection/review/1997.md',
  decks: [
    { id: "power-1997-1-justin-gary-ur-aggro", file: "1-justin-gary-ur-aggro.dck" },
    { id: "power-1997-2-kyle-bigos-4cb", file: "2-kyle-bigos-4cb.dck" },
    { id: "power-1997-1-cathy-nicoloff-5cgreen", file: "1-cathy-nicoloff-5cgreen.dck" },
    { id: "power-1997-3-jeff-butz-bone-dancer", file: "3-jeff-butz-bone-dancer.dck" },
    { id: "power-1997-1-jakub-slemr-black-five", file: "1-jakub-slemr-black-five.dck" },
    { id: "power-1997-5-jon-finkel-counter-post", file: "5-jon-finkel-counter-post.dck" },
    { id: "power-1997-2-janosch-kuhn-urw-aggro", file: "2-janosch-kuhn-urw-aggro.dck" },
    { id: "power-1997-3-svend-sparre-geertsen-stompy", file: "3-svend-sparre-geertsen-stompy.dck" },
    { id: "power-1997-3-paul-mccabe-ur-control", file: "3-paul-mccabe-ur-control.dck" },
    { id: "power-1997-5-john-chinnock-beatdown-necro", file: "5-john-chinnock-beatdown-necro.dck" },
    { id: "power-1997-day-1-undefeated-david-price-deadguy-red", file: "day-1-undefeated-david-price-deadguy-red.dck" },
    { id: "power-1997-day-1-undefeated-ju-neon-kim-red-deck-wins", file: "day-1-undefeated-ju-neon-kim-red-deck-wins.dck" },
  ],
};

/**
 * The 1998 power summer — `Standard (EXO)`, 1998-07-01 to 1998-11-01, the last
 * Standard snapshot before that fall’s rotation. 6 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/1998.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 6 chosen of 6
 * candidates.** One per archetype, searched for colour and style spread: W 1,
 * U 2, B 2, R 1, G 3; aggro 2, midrange 3, control 1, combo 0. Green dominated
 * this era’s candidate pool (33% of its colour pips) and was given extra slots
 * (3 of 6 chosen).
 */
export const POWER_SUMMER_1998_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-1998',
  directory: `${DECKS_ROOT}/standard-1998`,
  event: "1998 power summer — Standard (EXO), 1998-07-01 → 1998-11-01",
  format: "Standard (EXO)",
  date: "1998-07-01",
  source: 'docs/planning/deck-selection/review/1998.md',
  decks: [
    { id: "power-1998-1-matt-linde-white-weenie", file: "1-matt-linde-white-weenie.dck" },
    { id: "power-1998-2-mike-long-pros-bloom", file: "2-mike-long-pros-bloom.dck" },
    { id: "power-1998-3-bryce-currence-stupid-green-deck", file: "3-bryce-currence-stupid-green-deck.dck" },
    { id: "power-1998-3-jon-finkel-forbidian", file: "3-jon-finkel-forbidian.dck" },
    { id: "power-1998-1-brian-selden-recurring-survival", file: "1-brian-selden-recurring-survival.dck" },
    { id: "power-1998-5-andrew-pacifico-cursed-sligh", file: "5-andrew-pacifico-cursed-sligh.dck" },
  ],
};

/**
 * The 1999 power summer — `Standard (UDS)`, 1999-07-01 to 1999-11-01, the last
 * Standard snapshot before that fall’s rotation. 15 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/1999.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 15 chosen of
 * 15 candidates.** One per archetype, searched for colour and style spread:
 * W 2, U 7, B 7, R 2, G 6; aggro 4, midrange 6, control 5, combo 0. Blue
 * dominated this era’s candidate pool (29% of its colour pips) and was given
 * extra slots (7 of 15 chosen). Black dominated this era’s candidate pool (29%
 * of its colour pips) and was given extra slots (7 of 15 chosen).
 */
export const POWER_SUMMER_1999_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-1999',
  directory: `${DECKS_ROOT}/standard-1999`,
  event: "1999 power summer — Standard (UDS), 1999-07-01 → 1999-11-01",
  format: "Standard (UDS)",
  date: "1999-07-01",
  source: 'docs/planning/deck-selection/review/1999.md',
  decks: [
    { id: "power-1999-1-marc-rajotte-suicide-black", file: "1-marc-rajotte-suicide-black.dck" },
    { id: "power-1999-1-kyle-rose-white-weenie-white-lightning", file: "1-kyle-rose-white-weenie-white-lightning.dck" },
    { id: "power-1999-2-gary-krakower-black-control", file: "2-gary-krakower-black-control.dck" },
    { id: "power-1999-2-john-hunka-enchantress", file: "2-john-hunka-enchantress.dck" },
    { id: "power-1999-3-bruce-marsan-magpie", file: "3-bruce-marsan-magpie.dck" },
    { id: "power-1999-3-charles-kornblith-replenish-bargain", file: "3-charles-kornblith-replenish-bargain.dck" },
    { id: "power-1999-3-jurgen-hahn-trade-blossom", file: "3-jurgen-hahn-trade-blossom.dck" },
    { id: "power-1999-1-nicolai-herzog-stompy", file: "1-nicolai-herzog-stompy.dck" },
    { id: "power-1999-1-kai-budde-wildfire", file: "1-kai-budde-wildfire.dck" },
    { id: "power-1999-5-jeff-cunningham-living-death", file: "5-jeff-cunningham-living-death.dck" },
    { id: "power-1999-5-gabriel-tsang-bargain", file: "5-gabriel-tsang-bargain.dck" },
    { id: "power-1999-2-dirk-baberowski-abducted-drake", file: "2-dirk-baberowski-abducted-drake.dck" },
    { id: "power-1999-5-jamie-parke-mono-red-land-d", file: "5-jamie-parke-mono-red-land-d.dck" },
    { id: "power-1999-5-jakub-slemr-mono-black-midrange", file: "5-jakub-slemr-mono-black-midrange.dck" },
    { id: "power-1999-day-1-undefeated-xavier-curto-oath-into-thorn-elemental", file: "day-1-undefeated-xavier-curto-oath-into-thorn-elemental.dck" },
  ],
};

/**
 * The 2000 power summer — `Standard (PCY)`, 2000-07-01 to 2000-11-01, the last
 * Standard snapshot before that fall’s rotation. 16 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2000.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 16 chosen of
 * 16 candidates.** One per archetype, searched for colour and style spread:
 * W 5, U 5, B 3, R 5, G 5; aggro 3, midrange 10, control 3, combo 0. Midrange
 * dominated this era’s candidate pool (62% of its decks) and was given extra
 * slots (10 of 16 chosen).
 */
export const POWER_SUMMER_2000_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2000',
  directory: `${DECKS_ROOT}/standard-2000`,
  event: "2000 power summer — Standard (PCY), 2000-07-01 → 2000-11-01",
  format: "Standard (PCY)",
  date: "2000-07-01",
  source: 'docs/planning/deck-selection/review/2000.md',
  decks: [
    { id: "power-2000-1-john-stevens-trinity-green", file: "1-john-stevens-trinity-green.dck" },
    { id: "power-2000-1-ryan-fuller-stompy", file: "1-ryan-fuller-stompy.dck" },
    { id: "power-2000-1-jon-finkel-napster", file: "1-jon-finkel-napster.dck" },
    { id: "power-2000-2-matt-idoux-magpie", file: "2-matt-idoux-magpie.dck" },
    { id: "power-2000-3-jeremy-humphrey-replenish", file: "3-jeremy-humphrey-replenish.dck" },
    { id: "power-2000-2-chris-benafel-ponza", file: "2-chris-benafel-ponza.dck" },
    { id: "power-2000-1-masaya-mori-angry-hermit", file: "1-masaya-mori-angry-hermit.dck" },
    { id: "power-2000-1-jon-finkel-tinker", file: "1-jon-finkel-tinker.dck" },
    { id: "power-2000-5-tanis-tramontin-rebels", file: "5-tanis-tramontin-rebels.dck" },
    { id: "power-2000-5-dan-campisi-sneak-attack", file: "5-dan-campisi-sneak-attack.dck" },
    { id: "power-2000-1-jon-finkel-sabre-bargain", file: "1-jon-finkel-sabre-bargain.dck" },
    { id: "power-2000-5-mike-long-mono-blue-control", file: "5-mike-long-mono-blue-control.dck" },
    { id: "power-2000-3-ittoku-tanaka-mercenaries", file: "3-ittoku-tanaka-mercenaries.dck" },
    { id: "power-2000-5-nicolas-labarre-chimera", file: "5-nicolas-labarre-chimera.dck" },
    { id: "power-2000-5-satoshi-nakamura-squirrel-opposition", file: "5-satoshi-nakamura-squirrel-opposition.dck" },
    { id: "power-2000-5-alex-sousa-artifact-red", file: "5-alex-sousa-artifact-red.dck" },
  ],
};

/**
 * The 2001 power summer — `Standard (APC)`, 2001-07-01 to 2001-11-01, the last
 * Standard snapshot before that fall’s rotation. 20 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2001.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 20 chosen of
 * 20 candidates.** One per archetype, searched for colour and style spread:
 * W 4, U 11, B 8, R 11, G 3; aggro 4, midrange 11, control 5, combo 0. Blue
 * dominated this era’s candidate pool (30% of its colour pips) and was given
 * extra slots (11 of 20 chosen). Red dominated this era’s candidate pool (30%
 * of its colour pips) and was given extra slots (11 of 20 chosen). Midrange
 * dominated this era’s candidate pool (55% of its decks) and was given extra
 * slots (11 of 20 chosen).
 */
export const POWER_SUMMER_2001_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2001',
  directory: `${DECKS_ROOT}/standard-2001`,
  event: "2001 power summer — Standard (APC), 2001-07-01 → 2001-11-01",
  format: "Standard (APC)",
  date: "2001-07-01",
  source: 'docs/planning/deck-selection/review/2001.md',
  decks: [
    { id: "power-2001-1-terry-tsang-blue-skies", file: "1-terry-tsang-blue-skies.dck" },
    { id: "power-2001-1-trevor-blackwell-fires", file: "1-trevor-blackwell-fires.dck" },
    { id: "power-2001-1-reynerio-estacio-jr-counter-rebels", file: "1-reynerio-estacio-jr-counter-rebels.dck" },
    { id: "power-2001-2-felix-gonzales-orbosition", file: "2-felix-gonzales-orbosition.dck" },
    { id: "power-2001-2-brian-hegstad-uw-control", file: "2-brian-hegstad-uw-control.dck" },
    { id: "power-2001-2-stephan-valkyser-red-zone", file: "2-stephan-valkyser-red-zone.dck" },
    { id: "power-2001-2-laurent-pagorek-counter-crosis", file: "2-laurent-pagorek-counter-crosis.dck" },
    { id: "power-2001-1-tom-van-de-logt-machinehead", file: "1-tom-van-de-logt-machinehead.dck" },
    { id: "power-2001-5-jason-simard-nether-go", file: "5-jason-simard-nether-go.dck" },
    { id: "power-2001-5-ben-raymond-digger", file: "5-ben-raymond-digger.dck" },
    { id: "power-2001-3-mark-ziegner-rdw", file: "3-mark-ziegner-rdw.dck" },
    { id: "power-2001-3-masaya-mori-square-void", file: "3-masaya-mori-square-void.dck" },
    { id: "power-2001-3-david-bachmann-bridge-wildfire", file: "3-david-bachmann-bridge-wildfire.dck" },
    { id: "power-2001-5-alex-borteh-merfolk-opposition", file: "5-alex-borteh-merfolk-opposition.dck" },
    { id: "power-2001-5-mark-herrin-dromar-probe-go", file: "5-mark-herrin-dromar-probe-go.dck" },
    { id: "power-2001-5-bayani-manansala-jr-lovely-sunshine", file: "5-bayani-manansala-jr-lovely-sunshine.dck" },
    { id: "power-2001-5-yann-hamon-burning-bridge", file: "5-yann-hamon-burning-bridge.dck" },
    { id: "power-2001-3-victor-galimbertti-ponza", file: "3-victor-galimbertti-ponza.dck" },
    { id: "power-2001-5-john-ormerod-opposition", file: "5-john-ormerod-opposition.dck" },
    { id: "power-2001-5-satoshi-nakamura-ug-aggro-opposition", file: "5-satoshi-nakamura-ug-aggro-opposition.dck" },
  ],
};

/**
 * The 2002 power summer — `Standard (JUD)`, 2002-07-01 to 2002-11-01, the last
 * Standard snapshot before that fall’s rotation. 21 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2002.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 21 chosen of
 * 21 candidates.** One per archetype, searched for colour and style spread:
 * W 6, U 15, B 9, R 12, G 11; aggro 7, midrange 6, control 8, combo 0. Blue
 * dominated this era’s candidate pool (28% of its colour pips) and was given
 * extra slots (15 of 21 chosen).
 */
export const POWER_SUMMER_2002_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2002',
  directory: `${DECKS_ROOT}/standard-2002`,
  event: "2002 power summer — Standard (JUD), 2002-07-01 → 2002-11-01",
  format: "Standard (JUD)",
  date: "2002-07-01",
  source: 'docs/planning/deck-selection/review/2002.md',
  decks: [
    { id: "power-2002-1-gabriel-caligaris-psychatog", file: "1-gabriel-caligaris-psychatog.dck" },
    { id: "power-2002-1-eugene-harvey-squirrel-opposition-ugr", file: "1-eugene-harvey-squirrel-opposition-ugr.dck" },
    { id: "power-2002-1-jurgen-hahn-rug-madness", file: "1-jurgen-hahn-rug-madness.dck" },
    { id: "power-2002-1-eric-taylor-trenches", file: "1-eric-taylor-trenches.dck" },
    { id: "power-2002-1-sylvain-lauriol-white-braids", file: "1-sylvain-lauriol-white-braids.dck" },
    { id: "power-2002-2-felipe-desiderati-ug-threshold", file: "2-felipe-desiderati-ug-threshold.dck" },
    { id: "power-2002-2-jon-stern-rg-flashback", file: "2-jon-stern-rg-flashback.dck" },
    { id: "power-2002-1-sheng-hsun-hsia-hunting-grounds", file: "1-sheng-hsun-hsia-hunting-grounds.dck" },
    { id: "power-2002-3-yuuki-murakami-burning-tog", file: "3-yuuki-murakami-burning-tog.dck" },
    { id: "power-2002-5-hiroki-okamoto-mono-black-control", file: "5-hiroki-okamoto-mono-black-control.dck" },
    { id: "power-2002-5-william-baby-huey-jensen-battle-of-wits", file: "5-william-baby-huey-jensen-battle-of-wits.dck" },
    { id: "power-2002-5-david-petersen-4-color-braids", file: "5-david-petersen-4-color-braids.dck" },
    { id: "power-2002-2-mark-ziegner-burningtog", file: "2-mark-ziegner-burningtog.dck" },
    { id: "power-2002-9-brady-williams-threshold-enforcer", file: "9-brady-williams-threshold-enforcer.dck" },
    { id: "power-2002-9-anthony-justice-counter-burn", file: "9-anthony-justice-counter-burn.dck" },
    { id: "power-2002-3-brian-hegstad-enforcer-control", file: "3-brian-hegstad-enforcer-control.dck" },
    { id: "power-2002-5-rob-dougherty-balancing-tings", file: "5-rob-dougherty-balancing-tings.dck" },
    { id: "power-2002-other-klaus-huebert-nefarious-lich", file: "other-klaus-huebert-nefarious-lich.dck" },
    { id: "power-2002-other-gary-krakower-bw-bridge", file: "other-gary-krakower-bw-bridge.dck" },
    { id: "power-2002-other-brent-heaser-rug-ceta-sanctuary", file: "other-brent-heaser-rug-ceta-sanctuary.dck" },
    { id: "power-2002-9-franck-canu-five-color-green", file: "9-franck-canu-five-color-green.dck" },
  ],
};

/**
 * The 2003 power summer — `Standard (8ED)`, 2003-09-01 to 2003-10-20, the last
 * Standard snapshot before that fall’s rotation. 8 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2003.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 8 chosen of 8
 * candidates.** One per archetype, searched for colour and style spread: W 3,
 * U 2, B 2, R 5, G 3; aggro 3, midrange 1, control 3, combo 1. Red dominated
 * this era’s candidate pool (33% of its colour pips) and was given extra slots
 * (5 of 8 chosen).
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
 * Standard snapshot before that fall’s rotation. 25 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2004.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 7, U 8, B 6, R 13, G 8; aggro 5,
 * midrange 10, control 9, combo 0. Red dominated this era’s candidate pool (33%
 * of its colour pips) and was given extra slots (13 of 24 chosen). Midrange
 * dominated this era’s candidate pool (44% of its decks) and was given extra
 * slots (10 of 24 chosen).
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
    { id: "power-2004-2-michael-kotchoff-rg-beasts-with-ll", file: "2-michael-kotchoff-rg-beasts-with-ll.dck" },
    { id: "power-2004-3-masami-ibamoto-death-cloud", file: "3-masami-ibamoto-death-cloud.dck" },
    { id: "power-2004-3-zhen-x-gao-gw-astral-control", file: "3-zhen-x-gao-gw-astral-control.dck" },
    { id: "power-2004-3-luka-gasparac-rg-beats", file: "3-luka-gasparac-rg-beats.dck" },
    { id: "power-2004-3-alexandre-peset-read-the-goblin-bidding", file: "3-alexandre-peset-read-the-goblin-bidding.dck" },
    { id: "power-2004-3-ferran-vila-br-big-red", file: "3-ferran-vila-br-big-red.dck" },
    { id: "power-2004-3-eljko-vasic-incubator-charbelcher", file: "3-eljko-vasic-incubator-charbelcher.dck" },
    { id: "power-2004-3-neil-rigby-ur-obliterate", file: "3-neil-rigby-ur-obliterate.dck" },
    { id: "power-2004-2-bill-stead-g-w-control", file: "2-bill-stead-g-w-control.dck" },
    { id: "power-2004-2-lucas-ramirez-ponza", file: "2-lucas-ramirez-ponza.dck" },
    { id: "power-2004-5-sylvain-lauriol-morphs-anonymous", file: "5-sylvain-lauriol-morphs-anonymous.dck" },
    { id: "power-2004-5-iga-fritz-bg-cemetery", file: "5-iga-fritz-bg-cemetery.dck" },
    { id: "power-2004-3-ben-zoz-march-of-the-machines", file: "3-ben-zoz-march-of-the-machines.dck" },
    { id: "power-2004-5-michael-aitchison-r-g-beasts", file: "5-michael-aitchison-r-g-beasts.dck" },
    { id: "power-2004-5-tomohiro-yokosuka-26-crazy-cards", file: "5-tomohiro-yokosuka-26-crazy-cards.dck" },
    { id: "power-2004-5-pedro-de-diego-naya-control", file: "5-pedro-de-diego-naya-control.dck" },
    { id: "power-2004-3-manuel-bevand-kci", file: "3-manuel-bevand-kci.dck" },
  ],
};

/**
 * The 2005 power summer — `Standard (9ED)`, 2005-08-20 to 2005-10-20, the last
 * Standard snapshot before that fall’s rotation. 7 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2005.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 7 chosen of 7
 * candidates.** One per archetype, searched for colour and style spread: W 1,
 * U 2, B 1, R 1, G 2; aggro 4, midrange 1, control 2, combo 0.
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
 * Standard snapshot before that fall’s rotation. 28 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2006.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 12, B 9, R 10, G 11; aggro 10,
 * midrange 6, control 8, combo 0. Aggro dominated this era’s candidate pool
 * (50% of its decks) and was given extra slots (10 of 24 chosen).
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
    { id: "power-2006-1-guillaume-cardin-heartbeat", file: "1-guillaume-cardin-heartbeat.dck" },
    { id: "power-2006-1-kamiel-cornelissen-sea-stompy", file: "1-kamiel-cornelissen-sea-stompy.dck" },
    { id: "power-2006-1-sylvain-lauriol-wu-weenie", file: "1-sylvain-lauriol-wu-weenie.dck" },
    { id: "power-2006-1-romain-lisciandro-gruul-aggro", file: "1-romain-lisciandro-gruul-aggro.dck" },
    { id: "power-2006-3-hidenori-katayama-sand-burn", file: "3-hidenori-katayama-sand-burn.dck" },
    { id: "power-2006-3-ken-ishimaru-bg-demonfire", file: "3-ken-ishimaru-bg-demonfire.dck" },
    { id: "power-2006-2-mike-vasovski-snakes", file: "2-mike-vasovski-snakes.dck" },
    { id: "power-2006-2-benjamin-lundquist-izzetron", file: "2-benjamin-lundquist-izzetron.dck" },
    { id: "power-2006-2-amiel-tenenbaum-u-r-magnivore", file: "2-amiel-tenenbaum-u-r-magnivore.dck" },
    { id: "power-2006-2-robert-van-medevoort-junk", file: "2-robert-van-medevoort-junk.dck" },
    { id: "power-2006-3-nathon-braymore-hand-in-hand", file: "3-nathon-braymore-hand-in-hand.dck" },
    { id: "power-2006-3-jorg-unfried-zoo", file: "3-jorg-unfried-zoo.dck" },
    { id: "power-2006-3-tobias-henke-boros-aggro", file: "3-tobias-henke-boros-aggro.dck" },
    { id: "power-2006-1-katsuhiro-mori-ghazi-glare", file: "1-katsuhiro-mori-ghazi-glare.dck" },
    { id: "power-2006-1-mark-herberholz-gruul-beats", file: "1-mark-herberholz-gruul-beats.dck" },
    { id: "power-2006-5-holger-althues-enduring-ideal", file: "5-holger-althues-enduring-ideal.dck" },
    { id: "power-2006-4-stephane-roumanille-greater-good", file: "4-stephane-roumanille-greater-good.dck" },
    { id: "power-2006-5-tristan-guedj-orzhov-control", file: "5-tristan-guedj-orzhov-control.dck" },
    { id: "power-2006-3-tiago-chan-owling-mine", file: "3-tiago-chan-owling-mine.dck" },
    { id: "power-2006-5-ding-leong-critical-mass", file: "5-ding-leong-critical-mass.dck" },
    { id: "power-2006-5-marcio-carvalho-ub-control", file: "5-marcio-carvalho-ub-control.dck" },
    { id: "power-2006-day-1-undefeated-werner-cloete-ur-tron", file: "day-1-undefeated-werner-cloete-ur-tron.dck" },
  ],
};

/**
 * The 2007 power summer — `Standard (10E)`, 2007-07-20 to 2007-10-20, the last
 * Standard snapshot before that fall’s rotation. 27 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2007.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 12, B 9, R 11, G 12; aggro 6,
 * midrange 8, control 6, combo 4.
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
    { id: "power-2007-1-steven-aplin-rakdos-vi", file: "1-steven-aplin-rakdos-vi.dck" },
    { id: "power-2007-2-shaun-mclaren-angelfire", file: "2-shaun-mclaren-angelfire.dck" },
    { id: "power-2007-2-ren-ishikawa-swath-storm", file: "2-ren-ishikawa-swath-storm.dck" },
    { id: "power-2007-2-stuart-wright-dredge-bridge-ii", file: "2-stuart-wright-dredge-bridge-ii.dck" },
    { id: "power-2007-2-tim-he-solar-flare-iiii", file: "2-tim-he-solar-flare-iiii.dck" },
    { id: "power-2007-3-makoto-nagashima-project-x", file: "3-makoto-nagashima-project-x.dck" },
    { id: "power-2007-3-daniel-kramer-ubw-pickles", file: "3-daniel-kramer-ubw-pickles.dck" },
    { id: "power-2007-3-michael-jacob-mga", file: "3-michael-jacob-mga.dck" },
    { id: "power-2007-3-craig-chapman-ubr-teachings", file: "3-craig-chapman-ubr-teachings.dck" },
    { id: "power-2007-5-matthew-vienneau-korlash-black", file: "5-matthew-vienneau-korlash-black.dck" },
    { id: "power-2007-5-shuu-komuro-blink", file: "5-shuu-komuro-blink.dck" },
    { id: "power-2007-5-the-nameless-one-uw-control", file: "5-the-nameless-one-uw-control.dck" },
    { id: "power-2007-5-john-kolos-ub-teachings-dralnu-style", file: "5-john-kolos-ub-teachings-dralnu-style.dck" },
    { id: "power-2007-5-antonino-de-rosa-rakdos-10-gargadon-on-bob", file: "5-antonino-de-rosa-rakdos-10-gargadon-on-bob.dck" },
    { id: "power-2007-5-andrew-eckerman-rg-aggro-vii", file: "5-andrew-eckerman-rg-aggro-vii.dck" },
    { id: "power-2007-5-anatoli-lightfoot-glare", file: "5-anatoli-lightfoot-glare.dck" },
    { id: "power-2007-5-atsushi-wada-uwr-control", file: "5-atsushi-wada-uwr-control.dck" },
    { id: "power-2007-unranked-unknown-player-glitering-wish-control-seismic-loam-goyf", file: "unranked-unknown-player-glitering-wish-control-seismic-loam-goyf.dck" },
    { id: "power-2007-unranked-unknown-player-gruul-ii", file: "unranked-unknown-player-gruul-ii.dck" },
    { id: "power-2007-unranked-unknown-player-blanche-neige", file: "unranked-unknown-player-blanche-neige.dck" },
  ],
};

/**
 * The 2008 power summer — `Standard (EVE)`, 2008-07-25 to 2008-10-03, the last
 * Standard snapshot before that fall’s rotation. 27 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2008.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 3, U 11, B 11, R 10, G 11; aggro 9,
 * midrange 8, control 6, combo 1.
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
    { id: "power-2008-2-olivier-ruel-quick-n-toast", file: "2-olivier-ruel-quick-n-toast.dck" },
    { id: "power-2008-2-sam-black-elves", file: "2-sam-black-elves.dck" },
    { id: "power-2008-2-akihiro-takakuwa-gassy-knoll", file: "2-akihiro-takakuwa-gassy-knoll.dck" },
    { id: "power-2008-3-russ-j-davies-doran", file: "3-russ-j-davies-doran.dck" },
    { id: "power-2008-3-stephane-soubrier-merfolks", file: "3-stephane-soubrier-merfolks.dck" },
    { id: "power-2008-5-shouhei-yamamoto-4c-reveillark-control", file: "5-shouhei-yamamoto-4c-reveillark-control.dck" },
    { id: "power-2008-5-carl-dillahay-gr-aggro", file: "5-carl-dillahay-gr-aggro.dck" },
    { id: "power-2008-1-uri-peleg-doran-rock", file: "1-uri-peleg-doran-rock.dck" },
    { id: "power-2008-1-paul-cheon-uw-pickles", file: "1-paul-cheon-uw-pickles.dck" },
    { id: "power-2008-2-amiel-tenenbaum-muc-guile", file: "2-amiel-tenenbaum-muc-guile.dck" },
    { id: "power-2008-3-kotaro-otsuka-mannequin", file: "3-kotaro-otsuka-mannequin.dck" },
    { id: "power-2008-3-armin-birner-manaramp", file: "3-armin-birner-manaramp.dck" },
    { id: "power-2008-5-ivan-taroshi-fox-mana-ramp", file: "5-ivan-taroshi-fox-mana-ramp.dck" },
    { id: "power-2008-unranked-saul-aguado-tarmo-rack", file: "unranked-saul-aguado-tarmo-rack.dck" },
    { id: "power-2008-unranked-guillaume-wafo-tapa-teachings", file: "unranked-guillaume-wafo-tapa-teachings.dck" },
    { id: "power-2008-unranked-jerome-renevier-goblins", file: "unranked-jerome-renevier-goblins.dck" },
    { id: "power-2008-unranked-georgias-kapalas-red-death", file: "unranked-georgias-kapalas-red-death.dck" },
    { id: "power-2008-day-1-undefeated-andreas-szabo-rg-aggro", file: "day-1-undefeated-andreas-szabo-rg-aggro.dck" },
    { id: "power-2008-day-1-undefeated-przemek-oberbek-scryb-force", file: "day-1-undefeated-przemek-oberbek-scryb-force.dck" },
  ],
};

/**
 * The 2009 power summer — `Standard (M10)`, 2009-07-17 to 2009-10-02, the last
 * Standard snapshot before that fall’s rotation. 11 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2009.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 11 chosen of
 * 11 candidates.** One per archetype, searched for colour and style spread:
 * W 6, U 5, B 8, R 6, G 6; aggro 4, midrange 4, control 3, combo 0.
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
    { id: "power-2009-1-enric-marti-cruel-control", file: "1-enric-marti-cruel-control.dck" },
    { id: "power-2009-1-mongilardi-gilles-elf-rock", file: "1-mongilardi-gilles-elf-rock.dck" },
    { id: "power-2009-2-antoine-menard-blightning", file: "2-antoine-menard-blightning.dck" },
    { id: "power-2009-2-jonathan-cano-jund-aggro", file: "2-jonathan-cano-jund-aggro.dck" },
    { id: "power-2009-3-guillaume-matignon-faeries", file: "3-guillaume-matignon-faeries.dck" },
    { id: "power-2009-5-jose-garcia-red-deck-wins", file: "5-jose-garcia-red-deck-wins.dck" },
    { id: "power-2009-7-olivier-ruel-time-sieve", file: "7-olivier-ruel-time-sieve.dck" },
    { id: "power-2009-3-hannes-kerem-kithkins", file: "3-hannes-kerem-kithkins.dck" },
    { id: "power-2009-7-michael-jacob-5c-blood", file: "7-michael-jacob-5c-blood.dck" },
    { id: "power-2009-3-yuuma-shiota-big-druid-deck", file: "3-yuuma-shiota-big-druid-deck.dck" },
    { id: "power-2009-unranked-unknown-player-5c-elementals", file: "unranked-unknown-player-5c-elementals.dck" },
  ],
};

/**
 * The 2010 power summer — `Standard (M11)`, 2010-07-16 to 2010-10-01, the last
 * Standard snapshot before that fall’s rotation. 27 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2010.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 16, U 12, B 5, R 10, G 11; aggro 8,
 * midrange 7, control 7, combo 2. White dominated this era’s candidate pool
 * (30% of its colour pips) and was given extra slots (16 of 24 chosen).
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
    { id: "power-2010-1-julien-parez-uw-control", file: "1-julien-parez-uw-control.dck" },
    { id: "power-2010-1-cliff-weixler-naya-lightsaber", file: "1-cliff-weixler-naya-lightsaber.dck" },
    { id: "power-2010-2-guillaume-matignon-ur-pyromancer", file: "2-guillaume-matignon-ur-pyromancer.dck" },
    { id: "power-2010-3-antoine-ruel-ug-polymorph", file: "3-antoine-ruel-ug-polymorph.dck" },
    { id: "power-2010-1-emanuele-giusti-jund", file: "1-emanuele-giusti-jund.dck" },
    { id: "power-2010-1-naoki-nakada-mythic-conscription", file: "1-naoki-nakada-mythic-conscription.dck" },
    { id: "power-2010-1-brian-kibler-next-level-bant", file: "1-brian-kibler-next-level-bant.dck" },
    { id: "power-2010-2-isaiah-ley-u-g-polymorph", file: "2-isaiah-ley-u-g-polymorph.dck" },
    { id: "power-2010-5-pierre-jerome-meurisse-red-deck-wins", file: "5-pierre-jerome-meurisse-red-deck-wins.dck" },
    { id: "power-2010-5-lucas-florent-turboland", file: "5-lucas-florent-turboland.dck" },
    { id: "power-2010-5-adam-fox-grixis-control", file: "5-adam-fox-grixis-control.dck" },
    { id: "power-2010-5-max-malesch-vampires", file: "5-max-malesch-vampires.dck" },
    { id: "power-2010-2-makihito-mihara-uwr-walker", file: "2-makihito-mihara-uwr-walker.dck" },
    { id: "power-2010-3-terry-soh-naya", file: "3-terry-soh-naya.dck" },
    { id: "power-2010-3-craig-wescoe-white-weenie", file: "3-craig-wescoe-white-weenie.dck" },
    { id: "power-2010-3-bram-snepvangers-boros", file: "3-bram-snepvangers-boros.dck" },
    { id: "power-2010-1-jeremey-lochridge-eldrazi-jund", file: "1-jeremey-lochridge-eldrazi-jund.dck" },
    { id: "power-2010-5-daniel-grafensteiner-bgw-angels", file: "5-daniel-grafensteiner-bgw-angels.dck" },
    { id: "power-2010-5-niels-viaene-open-filigree", file: "5-niels-viaene-open-filigree.dck" },
    { id: "power-2010-5-william-cavaglieri-mono-w-tokens", file: "5-william-cavaglieri-mono-w-tokens.dck" },
    { id: "power-2010-5-manuel-bucher-bant", file: "5-manuel-bucher-bant.dck" },
    { id: "power-2010-4-james-nguyen-brilliant-ultimatum", file: "4-james-nguyen-brilliant-ultimatum.dck" },
    { id: "power-2010-day-1-undefeated-jeroen-aga-9-0-naya-allies", file: "day-1-undefeated-jeroen-aga-9-0-naya-allies.dck" },
    { id: "power-2010-day-1-undefeated-joel-calafell-turbo-fog", file: "day-1-undefeated-joel-calafell-turbo-fog.dck" },
  ],
};

/**
 * The 2011 power summer — `Standard (M12)`, 2011-07-15 to 2011-09-30, the last
 * Standard snapshot before that fall’s rotation. 44 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2011.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 7, U 10, B 7, R 10, G 8; aggro 7,
 * midrange 5, control 7, combo 5.
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
    { id: "power-2011-1-daniel-royde-eldrazi-green", file: "1-daniel-royde-eldrazi-green.dck" },
    { id: "power-2011-1-ryuuichiro-ishida-tempered-steel", file: "1-ryuuichiro-ishida-tempered-steel.dck" },
    { id: "power-2011-1-marc-anderson-rug-twin-pod", file: "1-marc-anderson-rug-twin-pod.dck" },
    { id: "power-2011-1-joel-calafell-ur-twin-exarch", file: "1-joel-calafell-ur-twin-exarch.dck" },
    { id: "power-2011-1-helge-nelson-red-deck-wins", file: "1-helge-nelson-red-deck-wins.dck" },
    { id: "power-2011-1-nicolas-de-nicola-ub-control", file: "1-nicolas-de-nicola-ub-control.dck" },
    { id: "power-2011-1-pat-cox-valakut-ramp", file: "1-pat-cox-valakut-ramp.dck" },
    { id: "power-2011-1-luke-tsavousis-uw-control", file: "1-luke-tsavousis-uw-control.dck" },
    { id: "power-2011-1-james-combrink-br-vampires", file: "1-james-combrink-br-vampires.dck" },
    { id: "power-2011-1-xinlin-ye-elves", file: "1-xinlin-ye-elves.dck" },
    { id: "power-2011-1-erik-landriz-goblins-deck-wins", file: "1-erik-landriz-goblins-deck-wins.dck" },
    { id: "power-2011-1-carlos-felipe-arellano-puresteel-paladin", file: "1-carlos-felipe-arellano-puresteel-paladin.dck" },
    { id: "power-2011-2-tobias-dreger-pyromancer-ascension", file: "2-tobias-dreger-pyromancer-ascension.dck" },
    { id: "power-2011-2-fujimoto-tomoya-gw-pod", file: "2-fujimoto-tomoya-gw-pod.dck" },
    { id: "power-2011-1-ben-rasmussan-tezzeret-control", file: "1-ben-rasmussan-tezzeret-control.dck" },
    { id: "power-2011-1-brucehendrix-ub-infect", file: "1-brucehendrix-ub-infect.dck" },
    { id: "power-2011-1-jeremy-king-elf-aggro", file: "1-jeremy-king-elf-aggro.dck" },
    { id: "power-2011-1-andrewhp-uw-shape-anew", file: "1-andrewhp-uw-shape-anew.dck" },
    { id: "power-2011-2-tom-reid-mono-black-control", file: "2-tom-reid-mono-black-control.dck" },
    { id: "power-2011-2-juan-pablo-alcalde-boros-con-pod", file: "2-juan-pablo-alcalde-boros-con-pod.dck" },
    { id: "power-2011-2-broderick-guzman-naya-pod", file: "2-broderick-guzman-naya-pod.dck" },
    { id: "power-2011-5-jeremie-ross-latour-big-jund", file: "5-jeremie-ross-latour-big-jund.dck" },
    { id: "power-2011-5-shouta-yasooka-torpor-tezz", file: "5-shouta-yasooka-torpor-tezz.dck" },
  ],
};

/**
 * The 2012 power summer — `Standard (M13)`, 2012-07-13 to 2012-10-05, the last
 * Standard snapshot before that fall’s rotation. 65 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2012.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 12, U 9, B 10, R 9, G 12; aggro 8,
 * midrange 6, control 6, combo 4.
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
    { id: "power-2012-1-mason-lange-gr-aggro", file: "1-mason-lange-gr-aggro.dck" },
    { id: "power-2012-1-levi-mochan-tezzeret-control", file: "1-levi-mochan-tezzeret-control.dck" },
    { id: "power-2012-2-lance-behrens-naya-aggro", file: "2-lance-behrens-naya-aggro.dck" },
    { id: "power-2012-2-samy-younis-kessig-u", file: "2-samy-younis-kessig-u.dck" },
    { id: "power-2012-2-kurt-crane-genesis-wave", file: "2-kurt-crane-genesis-wave.dck" },
    { id: "power-2012-1-doug-potter-ub-control", file: "1-doug-potter-ub-control.dck" },
    { id: "power-2012-1-gerald-leitzinger-esper-control", file: "1-gerald-leitzinger-esper-control.dck" },
    { id: "power-2012-1-mikael-conrow-gw-token", file: "1-mikael-conrow-gw-token.dck" },
    { id: "power-2012-1-joshua-saylor-mono-black-infect", file: "1-joshua-saylor-mono-black-infect.dck" },
    { id: "power-2012-1-austin-fritz-frites", file: "1-austin-fritz-frites.dck" },
    { id: "power-2012-1-travis-bailey-rug-control", file: "1-travis-bailey-rug-control.dck" },
    { id: "power-2012-1-pradeep-widana-pathirana-unsolar-flare", file: "1-pradeep-widana-pathirana-unsolar-flare.dck" },
    { id: "power-2012-1-john-seaton-birthing-pod", file: "1-john-seaton-birthing-pod.dck" },
    { id: "power-2012-1-adam-bubacz-zombie-pod", file: "1-adam-bubacz-zombie-pod.dck" },
    { id: "power-2012-1-nikos-michailidis-rug-pod", file: "1-nikos-michailidis-rug-pod.dck" },
    { id: "power-2012-1-yohan-dudognon-esper-midrange", file: "1-yohan-dudognon-esper-midrange.dck" },
    { id: "power-2012-5-ramon-nogueira-mono-black-control", file: "5-ramon-nogueira-mono-black-control.dck" },
  ],
};

/**
 * The 2013 power summer — `Standard (M14)`, 2013-07-19 to 2013-09-27, the last
 * Standard snapshot before that fall’s rotation. 78 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2013.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 15, U 11, B 12, R 13, G 14; aggro 8,
 * midrange 6, control 7, combo 3.
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
    { id: "power-2013-1-rudy-briksza-naya", file: "1-rudy-briksza-naya.dck" },
    { id: "power-2013-1-joseph-herrera-red-deck-wins", file: "1-joseph-herrera-red-deck-wins.dck" },
    { id: "power-2013-1-tom-strong-reanimator", file: "1-tom-strong-reanimator.dck" },
    { id: "power-2013-1-jacobgagnon-uwr-midrange", file: "1-jacobgagnon-uwr-midrange.dck" },
    { id: "power-2013-1-ryan-hipp-uwx-midrange", file: "1-ryan-hipp-uwx-midrange.dck" },
    { id: "power-2013-1-takahashi-jun-ya-bant-hexproof", file: "1-takahashi-jun-ya-bant-hexproof.dck" },
    { id: "power-2013-1-reid-duke-bant-control", file: "1-reid-duke-bant-control.dck" },
    { id: "power-2013-1-ian-kendall-rakdos-aggro", file: "1-ian-kendall-rakdos-aggro.dck" },
    { id: "power-2013-1-matt-sperling-prime-speaker-bant", file: "1-matt-sperling-prime-speaker-bant.dck" },
    { id: "power-2013-1-joe-lossett-human-reanimator", file: "1-joe-lossett-human-reanimator.dck" },
    { id: "power-2013-1-marc-blesso-tokens", file: "1-marc-blesso-tokens.dck" },
    { id: "power-2013-1-ken-min-yeoh-uwr-control", file: "1-ken-min-yeoh-uwr-control.dck" },
    { id: "power-2013-1-todd-anderson-uwr-control", file: "1-todd-anderson-uwr-control.dck" },
    { id: "power-2013-1-othon-voutsis-golgari-control", file: "1-othon-voutsis-golgari-control.dck" },
    { id: "power-2013-1-hiroaki-kitahara-esper-control", file: "1-hiroaki-kitahara-esper-control.dck" },
    { id: "power-2013-1-corey-camp-rakdos-control", file: "1-corey-camp-rakdos-control.dck" },
    { id: "power-2013-1-thomas-mcveigh-bug-persist-aggro", file: "1-thomas-mcveigh-bug-persist-aggro.dck" },
    { id: "power-2013-2-stephen-ruck-jund-aggro", file: "2-stephen-ruck-jund-aggro.dck" },
    { id: "power-2013-3-jeff-hoogland-urg-control", file: "3-jeff-hoogland-urg-control.dck" },
    { id: "power-2013-4-jonathan-phippen-weird-reanimator", file: "4-jonathan-phippen-weird-reanimator.dck" },
    { id: "power-2013-5-guillaume-louvel-4cc-griffin", file: "5-guillaume-louvel-4cc-griffin.dck" },
  ],
};

/**
 * The 2014 power summer — `Standard (M15)`, 2014-07-18 to 2014-09-26, the last
 * Standard snapshot before that fall’s rotation. 50 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2014.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 13, U 9, B 13, R 9, G 12; aggro 7,
 * midrange 8, control 8, combo 1.
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
    { id: "power-2014-1-rosmarudin-faizal-orzhov-control", file: "1-rosmarudin-faizal-orzhov-control.dck" },
    { id: "power-2014-1-scott-lipp-selesnya-aggro", file: "1-scott-lipp-selesnya-aggro.dck" },
    { id: "power-2014-1-manuel-orellana-red-deck-wins", file: "1-manuel-orellana-red-deck-wins.dck" },
    { id: "power-2014-1-jonas-zimmermann-golgari-control", file: "1-jonas-zimmermann-golgari-control.dck" },
    { id: "power-2014-1-omar-beldon-uw-control", file: "1-omar-beldon-uw-control.dck" },
    { id: "power-2014-1-gerard-fabiano-esper-control", file: "1-gerard-fabiano-esper-control.dck" },
    { id: "power-2014-1-neil-hartman-boros-aggro", file: "1-neil-hartman-boros-aggro.dck" },
    { id: "power-2014-1-jordan-welzbacher-jund-aggro", file: "1-jordan-welzbacher-jund-aggro.dck" },
    { id: "power-2014-1-zach-stern-gruul-team", file: "1-zach-stern-gruul-team.dck" },
    { id: "power-2014-1-hal-brady-devotion-to-green", file: "1-hal-brady-devotion-to-green.dck" },
    { id: "power-2014-1-rob-hunsaker-naya-aura", file: "1-rob-hunsaker-naya-aura.dck" },
    { id: "power-2014-1-frank-lepore-bant-control", file: "1-frank-lepore-bant-control.dck" },
    { id: "power-2014-1-ben-lundquist-boros-aggro", file: "1-ben-lundquist-boros-aggro.dck" },
    { id: "power-2014-1-josef-vlach-jund", file: "1-josef-vlach-jund.dck" },
    { id: "power-2014-1-jose-ortiz-wr-burn", file: "1-jose-ortiz-wr-burn.dck" },
    { id: "power-2014-1-trevor-humphries-uwr-control", file: "1-trevor-humphries-uwr-control.dck" },
    { id: "power-2014-1-dominic-musolino-esper-midrange", file: "1-dominic-musolino-esper-midrange.dck" },
    { id: "power-2014-1-ryan-reeves-4c-pw-control", file: "1-ryan-reeves-4c-pw-control.dck" },
    { id: "power-2014-2-justin-miller-reanimator", file: "2-justin-miller-reanimator.dck" },
    { id: "power-2014-2-jonathanbrostoff-orzhov-devotion", file: "2-jonathanbrostoff-orzhov-devotion.dck" },
    { id: "power-2014-3-brian-pentz-bug-control", file: "3-brian-pentz-bug-control.dck" },
    { id: "power-2014-4-chris-starr-prime-speaker-bant", file: "4-chris-starr-prime-speaker-bant.dck" },
  ],
};

/**
 * The 2015 power summer — `Standard (ORI)`, 2015-07-17 to 2015-10-02, the last
 * Standard snapshot before that fall’s rotation. 75 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2015.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 11, B 11, R 13, G 13; aggro 8,
 * midrange 8, control 5, combo 3.
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
    { id: "power-2015-1-alex-bastecki-devotion-to-green", file: "1-alex-bastecki-devotion-to-green.dck" },
    { id: "power-2015-1-jory-white-red-deck-wins", file: "1-jory-white-red-deck-wins.dck" },
    { id: "power-2015-1-robert-sabol-jeskai-midrange", file: "1-robert-sabol-jeskai-midrange.dck" },
    { id: "power-2015-1-alejandro-dupuy-de-lome-mardu-aggro", file: "1-alejandro-dupuy-de-lome-mardu-aggro.dck" },
    { id: "power-2015-1-michael-deidolori-esper-control", file: "1-michael-deidolori-esper-control.dck" },
    { id: "power-2015-1-ryota09-ur-artifacts", file: "1-ryota09-ur-artifacts.dck" },
    { id: "power-2015-1-ray-tautic-abzan-rally", file: "1-ray-tautic-abzan-rally.dck" },
    { id: "power-2015-1-andrew-johnson-jeskai-tempo", file: "1-andrew-johnson-jeskai-tempo.dck" },
    { id: "power-2015-1-david-jones-abzan-control", file: "1-david-jones-abzan-control.dck" },
    { id: "power-2015-1-yoon-soo-han-ub-control", file: "1-yoon-soo-han-ub-control.dck" },
    { id: "power-2015-1-yann-teoh-gruul-deck-wins", file: "1-yann-teoh-gruul-deck-wins.dck" },
    { id: "power-2015-1-kitajima-hiroyasu-boros-aggro", file: "1-kitajima-hiroyasu-boros-aggro.dck" },
    { id: "power-2015-1-philip-arcuni-temur-aggro", file: "1-philip-arcuni-temur-aggro.dck" },
    { id: "power-2015-1-eric-english-sultai-whip", file: "1-eric-english-sultai-whip.dck" },
    { id: "power-2015-1-eric-rill-gruul-dragons", file: "1-eric-rill-gruul-dragons.dck" },
    { id: "power-2015-1-michael-miller-sultai-control", file: "1-michael-miller-sultai-control.dck" },
    { id: "power-2015-1-ryan-overturf-jund", file: "1-ryan-overturf-jund.dck" },
    { id: "power-2015-1-kai-burnett-golgari-aggro", file: "1-kai-burnett-golgari-aggro.dck" },
    { id: "power-2015-1-michael-flores-full-dragons", file: "1-michael-flores-full-dragons.dck" },
    { id: "power-2015-1-ali-aintrazi-naya-dragons", file: "1-ali-aintrazi-naya-dragons.dck" },
    { id: "power-2015-1-marco-panteghini-see-the-unwritten", file: "1-marco-panteghini-see-the-unwritten.dck" },
    { id: "power-2015-1-michael-earnshaw-jeskai-ascendancy", file: "1-michael-earnshaw-jeskai-ascendancy.dck" },
    { id: "power-2015-2-reid-duke-sultai-reanimator", file: "2-reid-duke-sultai-reanimator.dck" },
  ],
};

/**
 * The 2016 power summer — `Standard (EMN)`, 2016-07-22 to 2016-09-30, the last
 * Standard snapshot before that fall’s rotation. 45 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2016.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 11, U 9, B 9, R 11, G 12; aggro 8,
 * midrange 9, control 7, combo 0.
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
    { id: "power-2016-2-ali-aintrazi-sultai-midrange", file: "2-ali-aintrazi-sultai-midrange.dck" },
    { id: "power-2016-2-wakizaka-hironari-naya-pw", file: "2-wakizaka-hironari-naya-pw.dck" },
    { id: "power-2016-1-edvin-marsson-orzhov-control", file: "1-edvin-marsson-orzhov-control.dck" },
    { id: "power-2016-1-james-ogier-izzet-control", file: "1-james-ogier-izzet-control.dck" },
    { id: "power-2016-1-lyu-li-ciang-4c-rites", file: "1-lyu-li-ciang-4c-rites.dck" },
    { id: "power-2016-1-aleksa-telaron-goggles-ramp", file: "1-aleksa-telaron-goggles-ramp.dck" },
    { id: "power-2016-1-lucas-giuliani-golgari-control", file: "1-lucas-giuliani-golgari-control.dck" },
    { id: "power-2016-1-takehana-tooru-orzhov-aggro", file: "1-takehana-tooru-orzhov-aggro.dck" },
    { id: "power-2016-1-fujiwara-takashi-mardu-control", file: "1-fujiwara-takashi-mardu-control.dck" },
    { id: "power-2016-1-luke-bradshaw-naya-aggro", file: "1-luke-bradshaw-naya-aggro.dck" },
    { id: "power-2016-1-eliott-boussaud-mono-u-prison", file: "1-eliott-boussaud-mono-u-prison.dck" },
    { id: "power-2016-1-alexis-gonzalez-azorius-midrange", file: "1-alexis-gonzalez-azorius-midrange.dck" },
    { id: "power-2016-1-devin-weiss-white-eldrazi", file: "1-devin-weiss-white-eldrazi.dck" },
    { id: "power-2016-1-miyauchi-makoto-boros-aggro", file: "1-miyauchi-makoto-boros-aggro.dck" },
    { id: "power-2016-1-michael-angelo-evangelio-naya", file: "1-michael-angelo-evangelio-naya.dck" },
    { id: "power-2016-3-bone55-jund", file: "3-bone55-jund.dck" },
  ],
};

/**
 * The 2017 power summer — `Standard (HOU)`, 2017-07-14 to 2017-09-29, the last
 * Standard snapshot before that fall’s rotation. 50 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2017.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 11, U 13, B 11, R 12, G 10; aggro 9,
 * midrange 7, control 8, combo 0.
 */
export const POWER_SUMMER_2017_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2017',
  directory: `${DECKS_ROOT}/standard-2017`,
  event: "2017 power summer \u2014 Standard (HOU), 2017-07-14 \u2192 2017-09-29",
  format: "Standard (HOU)",
  date: "2017-07-14",
  source: 'docs/planning/deck-selection/review/2017.md',
  decks: [
    { id: "power-2017-1-evgeniy-schetka-mardu-vehicles", file: "1-evgeniy-schetka-mardu-vehicles.dck" },
    { id: "power-2017-1-peter-snoha-mono-black-zombies", file: "1-peter-snoha-mono-black-zombies.dck" },
    { id: "power-2017-1-stephen-murray-temur-energy", file: "1-stephen-murray-temur-energy.dck" },
    { id: "power-2017-1-olivetti-azorius-aggro", file: "1-olivetti-azorius-aggro.dck" },
    { id: "power-2017-1-alain-bardini-boros-aggro", file: "1-alain-bardini-boros-aggro.dck" },
    { id: "power-2017-1-tomas-langer-gw-ramp", file: "1-tomas-langer-gw-ramp.dck" },
    { id: "power-2017-1-ryan-espano-uw-eldrazi", file: "1-ryan-espano-uw-eldrazi.dck" },
    { id: "power-2017-1-michael-hamilton-4-color-control", file: "1-michael-hamilton-4-color-control.dck" },
    { id: "power-2017-1-brennan-decandio-golgari-delirium", file: "1-brennan-decandio-golgari-delirium.dck" },
    { id: "power-2017-1-harane-kenta-emerge", file: "1-harane-kenta-emerge.dck" },
    { id: "power-2017-1-aziz-riphat-bg-constrictor", file: "1-aziz-riphat-bg-constrictor.dck" },
    { id: "power-2017-1-dmitri-shrum-orzhov-control", file: "1-dmitri-shrum-orzhov-control.dck" },
    { id: "power-2017-1-brian-coval-colossus-aggro-affinity", file: "1-brian-coval-colossus-aggro-affinity.dck" },
    { id: "power-2017-1-gavin-bennett-gruul-ramp", file: "1-gavin-bennett-gruul-ramp.dck" },
    { id: "power-2017-1-yong-il-park-rakdos-control", file: "1-yong-il-park-rakdos-control.dck" },
    { id: "power-2017-1-viet-tran-sultai-aggro", file: "1-viet-tran-sultai-aggro.dck" },
    { id: "power-2017-2-tirentu-uw-control", file: "2-tirentu-uw-control.dck" },
    { id: "power-2017-2-jonathan-rosum-w-u-monument", file: "2-jonathan-rosum-w-u-monument.dck" },
    { id: "power-2017-1-juan-pablo-barzola-izzet-control", file: "1-juan-pablo-barzola-izzet-control.dck" },
    { id: "power-2017-1-bradley-barclay-temur-tower", file: "1-bradley-barclay-temur-tower.dck" },
    { id: "power-2017-1-moriya-ryo-mardu-control", file: "1-moriya-ryo-mardu-control.dck" },
    { id: "power-2017-5-ruslan-kotunov-jeskai-gift", file: "5-ruslan-kotunov-jeskai-gift.dck" },
    { id: "power-2017-5-aziz-rhipat-sultai-midrange", file: "5-aziz-rhipat-sultai-midrange.dck" },
    { id: "power-2017-5-kevin-pass-naya-ramp", file: "5-kevin-pass-naya-ramp.dck" },
  ],
};

/**
 * The 2018 power summer — `Standard (M19)`, 2018-07-13 to 2018-10-05, the last
 * Standard snapshot before that fall’s rotation. 53 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2018.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 11, U 11, B 12, R 8, G 8; aggro 9,
 * midrange 8, control 7, combo 0.
 */
export const POWER_SUMMER_2018_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2018',
  directory: `${DECKS_ROOT}/standard-2018`,
  event: "2018 power summer \u2014 Standard (M19), 2018-07-13 \u2192 2018-10-05",
  format: "Standard (M19)",
  date: "2018-07-13",
  source: 'docs/planning/deck-selection/review/2018.md',
  decks: [
    { id: "power-2018-1-terribad-rakdos-aggro", file: "1-terribad-rakdos-aggro.dck" },
    { id: "power-2018-1-daniel-duffee-red-deck-wins", file: "1-daniel-duffee-red-deck-wins.dck" },
    { id: "power-2018-1-gabriel-joglar-uw-control", file: "1-gabriel-joglar-uw-control.dck" },
    { id: "power-2018-1-pappas-franck-esper-control", file: "1-pappas-franck-esper-control.dck" },
    { id: "power-2018-1-mun-tian-fa-dimir-midrange", file: "1-mun-tian-fa-dimir-midrange.dck" },
    { id: "power-2018-1-steve-noga-mono-green-aggro", file: "1-steve-noga-mono-green-aggro.dck" },
    { id: "power-2018-1-teerawish-kotesiri-orzhov-aggro", file: "1-teerawish-kotesiri-orzhov-aggro.dck" },
    { id: "power-2018-1-itou-atsushi-mono-blue-reservoir", file: "1-itou-atsushi-mono-blue-reservoir.dck" },
    { id: "power-2018-1-jeffcunningham-golgari-constrictor", file: "1-jeffcunningham-golgari-constrictor.dck" },
    { id: "power-2018-1-andrew-tenjum-grixis-control", file: "1-andrew-tenjum-grixis-control.dck" },
    { id: "power-2018-1-luciencool-mardu-vehicle", file: "1-luciencool-mardu-vehicle.dck" },
    { id: "power-2018-1-yuuki-ichikawa-god-pharaoh-s-gift-control", file: "1-yuuki-ichikawa-god-pharaoh-s-gift-control.dck" },
    { id: "power-2018-1-team5c-selesnya-aggro", file: "1-team5c-selesnya-aggro.dck" },
    { id: "power-2018-1-morgan-mclaughlin-orzhov-vehicles", file: "1-morgan-mclaughlin-orzhov-vehicles.dck" },
    { id: "power-2018-1-jethro-chanco-mono-black-aggro", file: "1-jethro-chanco-mono-black-aggro.dck" },
    { id: "power-2018-1-voltzwagon-dinosaurs", file: "1-voltzwagon-dinosaurs.dck" },
    { id: "power-2018-1-lighdar-wg-tokens", file: "1-lighdar-wg-tokens.dck" },
    { id: "power-2018-2-aekarash-sorakup-gruul-aggro", file: "2-aekarash-sorakup-gruul-aggro.dck" },
    { id: "power-2018-2-rithenium-wu", file: "2-rithenium-wu.dck" },
    { id: "power-2018-2-fabricio-rodrigues-bant-nexus", file: "2-fabricio-rodrigues-bant-nexus.dck" },
    { id: "power-2018-1-karlo-ledda-grixis", file: "1-karlo-ledda-grixis.dck" },
    { id: "power-2018-1-tonouchi-keita-orzhov-control", file: "1-tonouchi-keita-orzhov-control.dck" },
    { id: "power-2018-1-aaron-larson-selesnya-ramp", file: "1-aaron-larson-selesnya-ramp.dck" },
    { id: "power-2018-1-zac-elski-grixis-improvise", file: "1-zac-elski-grixis-improvise.dck" },
  ],
};

/**
 * The 2019 power summer — `Standard (2019-08-30)`, 2019-08-30 to 2019-10-04,
 * the last Standard snapshot before that fall’s rotation. 60 legal, distinct
 * candidate decks (`docs/planning/deck-selection/review/2019.md` has the full
 * table and the ones dropped as illegal or near-duplicate); 24 chosen. One per
 * archetype, searched for colour and style spread: W 13, U 13, B 10, R 10,
 * G 13; aggro 8, midrange 8, control 6, combo 2.
 */
export const POWER_SUMMER_2019_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2019',
  directory: `${DECKS_ROOT}/standard-2019`,
  event: "2019 power summer \u2014 Standard (2019-08-30), 2019-08-30 \u2192 2019-10-04",
  format: "Standard (2019-08-30)",
  date: "2019-08-30",
  source: 'docs/planning/deck-selection/review/2019.md',
  decks: [
    { id: "power-2019-1-carlos-romao-esper-control", file: "1-carlos-romao-esper-control.dck" },
    { id: "power-2019-1-djbmppwns-bant-aggro", file: "1-djbmppwns-bant-aggro.dck" },
    { id: "power-2019-1-kobayashi-ryohei-kethis-combo", file: "1-kobayashi-ryohei-kethis-combo.dck" },
    { id: "power-2019-1-martin-juza-rakdos-aggro", file: "1-martin-juza-rakdos-aggro.dck" },
    { id: "power-2019-1-kamo-riki-mono-green-aggro", file: "1-kamo-riki-mono-green-aggro.dck" },
    { id: "power-2019-1-aaron-barich-red-deck-wins", file: "1-aaron-barich-red-deck-wins.dck" },
    { id: "power-2019-1-rei-sato-golgari-aggro", file: "1-rei-sato-golgari-aggro.dck" },
    { id: "power-2019-1-shahar-shenhar-gruul-aggro", file: "1-shahar-shenhar-gruul-aggro.dck" },
    { id: "power-2019-1-adrian-sullivan-jeskai-control", file: "1-adrian-sullivan-jeskai-control.dck" },
    { id: "power-2019-1-sam-lawrence-nexus-reclamation", file: "1-sam-lawrence-nexus-reclamation.dck" },
    { id: "power-2019-1-james-lu-bant-scapeshift", file: "1-james-lu-bant-scapeshift.dck" },
    { id: "power-2019-1-kanyebest-orzhov-aggro", file: "1-kanyebest-orzhov-aggro.dck" },
    { id: "power-2019-1-brian-braun-duin-esper-precinct-one", file: "1-brian-braun-duin-esper-precinct-one.dck" },
    { id: "power-2019-1-diogo-martins-grixis-control", file: "1-diogo-martins-grixis-control.dck" },
    { id: "power-2019-1-janne-mikkonen-simic-nexus", file: "1-janne-mikkonen-simic-nexus.dck" },
    { id: "power-2019-1-schiaveto-boros-feather", file: "1-schiaveto-boros-feather.dck" },
    { id: "power-2019-1-alessandro-portaro-esper-midrange", file: "1-alessandro-portaro-esper-midrange.dck" },
    { id: "power-2019-1-zan-syed-jeskai-pw", file: "1-zan-syed-jeskai-pw.dck" },
    { id: "power-2019-1-kim-seok-hyun-bant-control", file: "1-kim-seok-hyun-bant-control.dck" },
    { id: "power-2019-1-jim-davis-command-the-dreadhorde", file: "1-jim-davis-command-the-dreadhorde.dck" },
    { id: "power-2019-1-jethro-amadeus-chanco-rg-dinos", file: "1-jethro-amadeus-chanco-rg-dinos.dck" },
    { id: "power-2019-1-edgar-tan-golgari-midrange", file: "1-edgar-tan-golgari-midrange.dck" },
    { id: "power-2019-1-benjo617-dinojund", file: "1-benjo617-dinojund.dck" },
    { id: "power-2019-1-tony-boozan-boros-angels", file: "1-tony-boozan-boros-angels.dck" },
  ],
};

/**
 * The 2020 power summer — `Standard (2020-08-03)`, 2020-08-03 to 2020-09-25,
 * the last Standard snapshot before that fall’s rotation. 46 legal, distinct
 * candidate decks (`docs/planning/deck-selection/review/2020.md` has the full
 * table and the ones dropped as illegal or near-duplicate); 24 chosen. One per
 * archetype, searched for colour and style spread: W 9, U 13, B 10, R 10, G 13;
 * aggro 10, midrange 7, control 7, combo 0. Aggro dominated this era’s
 * candidate pool (61% of its decks) and was given extra slots (10 of 24
 * chosen).
 */
export const POWER_SUMMER_2020_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2020',
  directory: `${DECKS_ROOT}/standard-2020`,
  event: "2020 power summer \u2014 Standard (2020-08-03), 2020-08-03 \u2192 2020-09-25",
  format: "Standard (2020-08-03)",
  date: "2020-08-03",
  source: 'docs/planning/deck-selection/review/2020.md',
  decks: [
    { id: "power-2020-1-ari-lax-sultai-control", file: "1-ari-lax-sultai-control.dck" },
    { id: "power-2020-1-sergey-tonkikh-adventure", file: "1-sergey-tonkikh-adventure.dck" },
    { id: "power-2020-1-takumi-yamasaki-temur-yorion-elementals", file: "1-takumi-yamasaki-temur-yorion-elementals.dck" },
    { id: "power-2020-1-rint-mono-green-aggro", file: "1-rint-mono-green-aggro.dck" },
    { id: "power-2020-1-paul-woo-red-deck-wins", file: "1-paul-woo-red-deck-wins.dck" },
    { id: "power-2020-1-hoshi-yuki-weenie-white", file: "1-hoshi-yuki-weenie-white.dck" },
    { id: "power-2020-1-ryan-fraking-rakdos-aggro", file: "1-ryan-fraking-rakdos-aggro.dck" },
    { id: "power-2020-1-case-johnson-winota", file: "1-case-johnson-winota.dck" },
    { id: "power-2020-1-yojiro-futamata-mono-black-aggro", file: "1-yojiro-futamata-mono-black-aggro.dck" },
    { id: "power-2020-1-sancho-temur-control", file: "1-sancho-temur-control.dck" },
    { id: "power-2020-1-toni-ramis-pascual-temur-flash-aggro", file: "1-toni-ramis-pascual-temur-flash-aggro.dck" },
    { id: "power-2020-1-hgrose-sultai-aggro", file: "1-hgrose-sultai-aggro.dck" },
    { id: "power-2020-1-chris-marshall-ugb", file: "1-chris-marshall-ugb.dck" },
    { id: "power-2020-1-lukas-dusek-jeskai-control", file: "1-lukas-dusek-jeskai-control.dck" },
    { id: "power-2020-1-gavin-bennett-gruul-aggro", file: "1-gavin-bennett-gruul-aggro.dck" },
    { id: "power-2020-1-carson-bell-selesnya-aggro", file: "1-carson-bell-selesnya-aggro.dck" },
    { id: "power-2020-5-david-besso-orzhov-doom", file: "5-david-besso-orzhov-doom.dck" },
    { id: "power-2020-3-harodt-loveday-4c-control", file: "3-harodt-loveday-4c-control.dck" },
    { id: "power-2020-3-yokokawa-yuuta-esper-doom-uro", file: "3-yokokawa-yuuta-esper-doom-uro.dck" },
    { id: "power-2020-3-brandon-pascal-sultai-flash", file: "3-brandon-pascal-sultai-flash.dck" },
    { id: "power-2020-2-joshua-claytor-ub-control", file: "2-joshua-claytor-ub-control.dck" },
    { id: "power-2020-2-theresa-connah-haymond-ww-all-that-glitters", file: "2-theresa-connah-haymond-ww-all-that-glitters.dck" },
    { id: "power-2020-5-itou-motoaki-esper-control", file: "5-itou-motoaki-esper-control.dck" },
    { id: "power-2020-8-synergizer-gyruda", file: "8-synergizer-gyruda.dck" },
  ],
};

/**
 * The 2021 power summer — `Standard (AFR)`, 2021-07-23 to 2021-09-24, the last
 * Standard snapshot before that fall’s rotation. 49 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2021.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 13, B 11, R 11, G 13; aggro 8,
 * midrange 7, control 9, combo 0.
 */
export const POWER_SUMMER_2021_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2021',
  directory: `${DECKS_ROOT}/standard-2021`,
  event: "2021 power summer \u2014 Standard (AFR), 2021-07-23 \u2192 2021-09-24",
  format: "Standard (AFR)",
  date: "2021-07-23",
  source: 'docs/planning/deck-selection/review/2021.md',
  decks: [
    { id: "power-2021-1-alexander-rosdahl-sultai-yorion-ultimatum", file: "1-alexander-rosdahl-sultai-yorion-ultimatum.dck" },
    { id: "power-2021-1-arne-huschenbeth-gruul-aggro", file: "1-arne-huschenbeth-gruul-aggro.dck" },
    { id: "power-2021-1-sam-pardee-naya-aggro", file: "1-sam-pardee-naya-aggro.dck" },
    { id: "power-2021-1-noriyuki-mori-izzet-control", file: "1-noriyuki-mori-izzet-control.dck" },
    { id: "power-2021-1-keisuke-sato-winota", file: "1-keisuke-sato-winota.dck" },
    { id: "power-2021-1-john-alexander-rakdos-aggro", file: "1-john-alexander-rakdos-aggro.dck" },
    { id: "power-2021-1-rumti-mono-green-aggro", file: "1-rumti-mono-green-aggro.dck" },
    { id: "power-2021-1-alexander-hayne-red-deck-wins", file: "1-alexander-hayne-red-deck-wins.dck" },
    { id: "power-2021-1-louis-samuel-deltour-dimir-mill", file: "1-louis-samuel-deltour-dimir-mill.dck" },
    { id: "power-2021-1-luca-magni-temur-lukka", file: "1-luca-magni-temur-lukka.dck" },
    { id: "power-2021-1-eli-loveman-weenie-white", file: "1-eli-loveman-weenie-white.dck" },
    { id: "power-2021-1-corey-burkhart-jeskai-cycling-aggro", file: "1-corey-burkhart-jeskai-cycling-aggro.dck" },
    { id: "power-2021-1-matthieu-avignon-jeskai-mutate", file: "1-matthieu-avignon-jeskai-mutate.dck" },
    { id: "power-2021-1-shintaro-ishimura-dimir-control", file: "1-shintaro-ishimura-dimir-control.dck" },
    { id: "power-2021-1-kenta-harane-sultai-control", file: "1-kenta-harane-sultai-control.dck" },
    { id: "power-2021-1-shintaro-ishimura-4c-yorion", file: "1-shintaro-ishimura-4c-yorion.dck" },
    { id: "power-2021-1-kotaro-senba-simic-aggro", file: "1-kotaro-senba-simic-aggro.dck" },
    { id: "power-2021-1-shintaro-ishimura-gyruda", file: "1-shintaro-ishimura-gyruda.dck" },
    { id: "power-2021-1-christoph-kremer-abzan-yorion", file: "1-christoph-kremer-abzan-yorion.dck" },
    { id: "power-2021-1-yamakawa-tomohiro-grixis-control", file: "1-yamakawa-tomohiro-grixis-control.dck" },
    { id: "power-2021-1-masui-shuryuu-abzan-yorion-midrange", file: "1-masui-shuryuu-abzan-yorion-midrange.dck" },
    { id: "power-2021-1-matsui-hiromichi-mono-blue-control", file: "1-matsui-hiromichi-mono-blue-control.dck" },
    { id: "power-2021-3-gabriel-silva-temur-ramp-ultimatum", file: "3-gabriel-silva-temur-ramp-ultimatum.dck" },
    { id: "power-2021-5-mystmin-orzhov-control", file: "5-mystmin-orzhov-control.dck" },
  ],
};

/**
 * The 2022 power summer — `Standard (SNC)`, 2022-04-29 to 2022-09-09, the last
 * Standard snapshot before that fall’s rotation. 56 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2022.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 13, U 11, B 11, R 11, G 9; aggro 9,
 * midrange 7, control 7, combo 1.
 */
export const POWER_SUMMER_2022_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2022',
  directory: `${DECKS_ROOT}/standard-2022`,
  event: "2022 power summer \u2014 Standard (SNC), 2022-04-29 \u2192 2022-09-09",
  format: "Standard (SNC)",
  date: "2022-04-29",
  source: 'docs/planning/deck-selection/review/2022.md',
  decks: [
    { id: "power-2022-1-sayama-tatsunosuke-jeskai-hinata", file: "1-sayama-tatsunosuke-jeskai-hinata.dck" },
    { id: "power-2022-1-miko-aj-drzewiecki-esper-aggro", file: "1-miko-aj-drzewiecki-esper-aggro.dck" },
    { id: "power-2022-1-kamezaki-sho-orzhov-aggro", file: "1-kamezaki-sho-orzhov-aggro.dck" },
    { id: "power-2022-1-helio-sampaio-weenie-white", file: "1-helio-sampaio-weenie-white.dck" },
    { id: "power-2022-1-cftsoc-jeskai-control", file: "1-cftsoc-jeskai-control.dck" },
    { id: "power-2022-1-hiroaki-taniguchi-temur-aggro", file: "1-hiroaki-taniguchi-temur-aggro.dck" },
    { id: "power-2022-1-jacopo-di-napoli-esper-control", file: "1-jacopo-di-napoli-esper-control.dck" },
    { id: "power-2022-1-paskardi-gruul-aggro", file: "1-paskardi-gruul-aggro.dck" },
    { id: "power-2022-1-lukas-dusek-uw-control", file: "1-lukas-dusek-uw-control.dck" },
    { id: "power-2022-1-sandoiche-jund", file: "1-sandoiche-jund.dck" },
    { id: "power-2022-1-shunki-saito-naya-runes-aggro", file: "1-shunki-saito-naya-runes-aggro.dck" },
    { id: "power-2022-1-julian-dominguez-boros-aggro", file: "1-julian-dominguez-boros-aggro.dck" },
    { id: "power-2022-1-sergey-sypachev-esper-raffine", file: "1-sergey-sypachev-esper-raffine.dck" },
    { id: "power-2022-1-levunga21-rakdos-aggro", file: "1-levunga21-rakdos-aggro.dck" },
    { id: "power-2022-1-miyazaki-yuichi-azorius-aggro", file: "1-miyazaki-yuichi-azorius-aggro.dck" },
    { id: "power-2022-1-lilium-temur-control", file: "1-lilium-temur-control.dck" },
    { id: "power-2022-1-kawabata-yuji-grixis-midrange", file: "1-kawabata-yuji-grixis-midrange.dck" },
    { id: "power-2022-1-yasuno-naoto-orzhov-control", file: "1-yasuno-naoto-orzhov-control.dck" },
    { id: "power-2022-1-nishimura-hiroshi-mono-black-control", file: "1-nishimura-hiroshi-mono-black-control.dck" },
    { id: "power-2022-1-yoshida-yutaro-golgari-control", file: "1-yoshida-yutaro-golgari-control.dck" },
    { id: "power-2022-1-danny-mullinax-selesnya-midrange", file: "1-danny-mullinax-selesnya-midrange.dck" },
    { id: "power-2022-1-minami-ryota-sultai-legends-midrange", file: "1-minami-ryota-sultai-legends-midrange.dck" },
    { id: "power-2022-2-guardianthesecond-azorius-midrange", file: "2-guardianthesecond-azorius-midrange.dck" },
    { id: "power-2022-unranked-kevin-mittertreiner-reanimator", file: "unranked-kevin-mittertreiner-reanimator.dck" },
  ],
};

/**
 * The 2023 power summer — `Standard (2023-05-29)`, 2023-05-29 to 2023-09-08,
 * the format in force on August 1st — WotC’s three-year rotation dropped no set
 * that autumn. 39 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/2023.md` has the full table and the
 * ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 12, U 11, B 11, R 8, G 8; aggro 10,
 * midrange 7, control 7, combo 0. Aggro dominated this era’s candidate pool
 * (51% of its decks) and was given extra slots (10 of 24 chosen).
 */
export const POWER_SUMMER_2023_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2023',
  directory: `${DECKS_ROOT}/standard-2023`,
  event: "2023 power summer \u2014 Standard (2023-05-29), 2023-05-29 \u2192 2023-09-08",
  format: "Standard (2023-05-29)",
  date: "2023-05-29",
  source: 'docs/planning/deck-selection/review/2023.md',
  decks: [
    { id: "power-2023-1-prophetoffire-esper-raffine", file: "1-prophetoffire-esper-raffine.dck" },
    { id: "power-2023-1-satou-rei-selesnya-aggro", file: "1-satou-rei-selesnya-aggro.dck" },
    { id: "power-2023-1-fujimoto-tomoya-red-deck-wins", file: "1-fujimoto-tomoya-red-deck-wins.dck" },
    { id: "power-2023-1-thaism-azorius-soldier", file: "1-thaism-azorius-soldier.dck" },
    { id: "power-2023-1-harada-shougo-4-5c-control", file: "1-harada-shougo-4-5c-control.dck" },
    { id: "power-2023-1-kobayashi-hiroyuki-dimir-aggro", file: "1-kobayashi-hiroyuki-dimir-aggro.dck" },
    { id: "power-2023-1-asakawa-tama-esper-control", file: "1-asakawa-tama-esper-control.dck" },
    { id: "power-2023-1-joaohnp-78481-orzhov-control", file: "1-joaohnp-78481-orzhov-control.dck" },
    { id: "power-2023-1-simon-arboleda-escobar-jeskai-control", file: "1-simon-arboleda-escobar-jeskai-control.dck" },
    { id: "power-2023-1-suzuki-yasuo-weenie-white", file: "1-suzuki-yasuo-weenie-white.dck" },
    { id: "power-2023-1-mogged-izzet-control", file: "1-mogged-izzet-control.dck" },
    { id: "power-2023-1-mtgholic-rakdos-midrange", file: "1-mtgholic-rakdos-midrange.dck" },
    { id: "power-2023-1-guiyote-bant-aggro", file: "1-guiyote-bant-aggro.dck" },
    { id: "power-2023-1-johnsnow-mono-blue-tempo", file: "1-johnsnow-mono-blue-tempo.dck" },
    { id: "power-2023-1-kayla-davison-simic-aggro", file: "1-kayla-davison-simic-aggro.dck" },
    { id: "power-2023-1-milikin-angels", file: "1-milikin-angels.dck" },
    { id: "power-2023-2-darth-xero-mardu-control", file: "2-darth-xero-mardu-control.dck" },
    { id: "power-2023-3-karatedom-golgari-aggro", file: "3-karatedom-golgari-aggro.dck" },
    { id: "power-2023-3-max-itso-martins-explosive-singularity", file: "3-max-itso-martins-explosive-singularity.dck" },
    { id: "power-2023-4-rex-iudex-5cc", file: "4-rex-iudex-5cc.dck" },
    { id: "power-2023-4-rex-iudex-mono-white-atraxa", file: "4-rex-iudex-mono-white-atraxa.dck" },
    { id: "power-2023-4-arianne-grixis-aggro", file: "4-arianne-grixis-aggro.dck" },
    { id: "power-2023-5-scott-spurlock-jund-aggro", file: "5-scott-spurlock-jund-aggro.dck" },
    { id: "power-2023-14-rex-iudex-golgari-control", file: "14-rex-iudex-golgari-control.dck" },
  ],
};

/**
 * The 2024 power summer — `Standard (OTJ)`, 2024-04-19 to 2024-08-02, the last
 * Standard snapshot before that fall’s rotation. 58 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/2024.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 11, U 12, B 13, R 9, G 10; aggro 10,
 * midrange 6, control 7, combo 1. Aggro dominated this era’s candidate pool
 * (47% of its decks) and was given extra slots (10 of 24 chosen).
 */
export const POWER_SUMMER_2024_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2024',
  directory: `${DECKS_ROOT}/standard-2024`,
  event: "2024 power summer \u2014 Standard (OTJ), 2024-04-19 \u2192 2024-08-02",
  format: "Standard (OTJ)",
  date: "2024-04-19",
  source: 'docs/planning/deck-selection/review/2024.md',
  decks: [
    { id: "power-2024-1-kenta-harane-esper-raffine", file: "1-kenta-harane-esper-raffine.dck" },
    { id: "power-2024-1-takanori-watanabe-boros-convoke", file: "1-takanori-watanabe-boros-convoke.dck" },
    { id: "power-2024-1-ken-min-yeoh-s-team-uw-control", file: "1-ken-min-yeoh-s-team-uw-control.dck" },
    { id: "power-2024-1-isogaya-leo-dimir-aggro", file: "1-isogaya-leo-dimir-aggro.dck" },
    { id: "power-2024-1-richie-ong-golgari-aggro", file: "1-richie-ong-golgari-aggro.dck" },
    { id: "power-2024-1-pedro-perrini-red-deck-wins", file: "1-pedro-perrini-red-deck-wins.dck" },
    { id: "power-2024-1-mason-buonadonna-4c-legends-aggro", file: "1-mason-buonadonna-4c-legends-aggro.dck" },
    { id: "power-2024-1-adam-weiss-gruul-aggro", file: "1-adam-weiss-gruul-aggro.dck" },
    { id: "power-2024-1-jonathan-shortall-temur-control", file: "1-jonathan-shortall-temur-control.dck" },
    { id: "power-2024-1-roter-erzengel-4-5c-control", file: "1-roter-erzengel-4-5c-control.dck" },
    { id: "power-2024-1-fermtg-orzhov-aggro", file: "1-fermtg-orzhov-aggro.dck" },
    { id: "power-2024-1-hannuki-yuya-rakdos-aggro", file: "1-hannuki-yuya-rakdos-aggro.dck" },
    { id: "power-2024-1-billsive-esper-control", file: "1-billsive-esper-control.dck" },
    { id: "power-2024-1-uri-roberto-domain", file: "1-uri-roberto-domain.dck" },
    { id: "power-2024-1-ashley-munoz-preyeses-zoetic-simic", file: "1-ashley-munoz-preyeses-zoetic-simic.dck" },
    { id: "power-2024-1-sasaki-shimon-jund-control", file: "1-sasaki-shimon-jund-control.dck" },
    { id: "power-2024-1-phoenix-flame-orzhov-aggro", file: "1-phoenix-flame-orzhov-aggro.dck" },
    { id: "power-2024-2-marco-cammilluzzi-dimir-control", file: "2-marco-cammilluzzi-dimir-control.dck" },
    { id: "power-2024-1-utsunomiya-takumi-splendid-reclamation", file: "1-utsunomiya-takumi-splendid-reclamation.dck" },
    { id: "power-2024-1-sakai-riki-jeskai-control", file: "1-sakai-riki-jeskai-control.dck" },
    { id: "power-2024-5-yun-suhan-azorius-tempo", file: "5-yun-suhan-azorius-tempo.dck" },
    { id: "power-2024-3-mohamed-binshams-rakdos", file: "3-mohamed-binshams-rakdos.dck" },
    { id: "power-2024-2-xfile-5cc", file: "2-xfile-5cc.dck" },
    { id: "power-2024-5-ryan-normandin-reanimator-rakdos-joins-up", file: "5-ryan-normandin-reanimator-rakdos-joins-up.dck" },
  ],
};

/**
 * The 2025 power summer — `Standard (2025-06-30)`, 2025-06-30 to 2025-08-01,
 * the last Standard snapshot before that fall’s rotation. 49 legal, distinct
 * candidate decks (`docs/planning/deck-selection/review/2025.md` has the full
 * table and the ones dropped as illegal or near-duplicate); 24 chosen. One per
 * archetype, searched for colour and style spread: W 13, U 9, B 13, R 10, G 10;
 * aggro 10, midrange 6, control 7, combo 1. Aggro dominated this era’s
 * candidate pool (59% of its decks) and was given extra slots (10 of 24
 * chosen).
 */
export const POWER_SUMMER_2025_STANDARD: LibraryCollection = {
  family: 'standard',
  id: 'power-summer-2025',
  directory: `${DECKS_ROOT}/standard-2025`,
  event: "2025 power summer \u2014 Standard (2025-06-30), 2025-06-30 \u2192 2025-08-01",
  format: "Standard (2025-06-30)",
  date: "2025-06-30",
  source: 'docs/planning/deck-selection/review/2025.md',
  decks: [
    { id: "power-2025-1-patxi-dimir-aggro", file: "1-patxi-dimir-aggro.dck" },
    { id: "power-2025-1-peter780108-uw-control", file: "1-peter780108-uw-control.dck" },
    { id: "power-2025-1-univerce-ur-soul-cauldron", file: "1-univerce-ur-soul-cauldron.dck" },
    { id: "power-2025-1-lucasg1ggs-golgari-aggro", file: "1-lucasg1ggs-golgari-aggro.dck" },
    { id: "power-2025-1-gazmon48-mono-white-control", file: "1-gazmon48-mono-white-control.dck" },
    { id: "power-2025-1-atmagic-mono-green-aggro", file: "1-atmagic-mono-green-aggro.dck" },
    { id: "power-2025-1-nakano-akinori-mono-black-aggro", file: "1-nakano-akinori-mono-black-aggro.dck" },
    { id: "power-2025-1-lucasg1ggs-boros-convoke", file: "1-lucasg1ggs-boros-convoke.dck" },
    { id: "power-2025-1-soulstrong-golgari-roots", file: "1-soulstrong-golgari-roots.dck" },
    { id: "power-2025-1-hifumin777-naya-aggro", file: "1-hifumin777-naya-aggro.dck" },
    { id: "power-2025-1-broeking-jeskai-eidetic-memory", file: "1-broeking-jeskai-eidetic-memory.dck" },
    { id: "power-2025-1-kai-nankoe-jeskai-control", file: "1-kai-nankoe-jeskai-control.dck" },
    { id: "power-2025-1-dr4ken-orzhov-midrange", file: "1-dr4ken-orzhov-midrange.dck" },
    { id: "power-2025-1-watadori-donnosuke-rakdos-aggro", file: "1-watadori-donnosuke-rakdos-aggro.dck" },
    { id: "power-2025-1-nikhilesh-mahendra-dimir-control", file: "1-nikhilesh-mahendra-dimir-control.dck" },
    { id: "power-2025-1-cown-selesnya-cage", file: "1-cown-selesnya-cage.dck" },
    { id: "power-2025-2-igor-karavayev-uw-artifacts", file: "2-igor-karavayev-uw-artifacts.dck" },
    { id: "power-2025-2-jesus-ramos-mardu-control", file: "2-jesus-ramos-mardu-control.dck" },
    { id: "power-2025-5-fukusuke-squirming-emergence", file: "5-fukusuke-squirming-emergence.dck" },
    { id: "power-2025-5-bcs8995-talented-otters", file: "5-bcs8995-talented-otters.dck" },
    { id: "power-2025-5-yusuke-kanazawa-abzan-control", file: "5-yusuke-kanazawa-abzan-control.dck" },
    { id: "power-2025-5-dmytro-konchakov-naya-yuna", file: "5-dmytro-konchakov-naya-yuna.dck" },
    { id: "power-2025-5-davimorais-4-5c-zur-control", file: "5-davimorais-4-5c-zur-control.dck" },
    { id: "power-2025-9-mavin-liu-reanimator", file: "9-mavin-liu-reanimator.dck" },
  ],
};

/*
 * Modern 2012-2016 (wave 48 §M) — Modern does not rotate, so each year's era
 * is pinned to that year's Standard era's own dates (Settled): the snapshot
 * is the latest Archived/Modern/ file on or before Standard's `start`, and
 * the season window is Standard's `season_start` -> `end`. Modern was created
 * in August 2011 and its first Pro Tour (Philadelphia, 2011-09-02) falls inside
 * Standard 2011's window, so 2011 is its first power summer (AF41).
 */

/**
 * The 2011 Modern power summer — `Modern (M12)`, 2011-07-15 to 2011-09-30,
 * pinned to Standard 2011’s own dates. 24 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2011.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 12, U 11, B 5, R 14, G 12; aggro 9,
 * midrange 6, control 6, combo 3.
 */
export const POWER_SUMMER_2011_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2011',
  directory: `${DECKS_ROOT}/modern-2011`,
  event: "2011 Modern power summer — Modern (M12), 2011-07-15 → 2011-09-30",
  format: "Modern (M12)",
  date: "2011-07-15",
  source: 'docs/planning/deck-selection/review/modern-2011.md',
  decks: [
    { id: "power-modern-2011-1-ero-sennin-zoo", file: "1-ero-sennin-zoo.dck" },
    { id: "power-modern-2011-1-arevalol-affinity", file: "1-arevalol-affinity.dck" },
    { id: "power-modern-2011-1-d-jdikez-birthing-pod", file: "1-d-jdikez-birthing-pod.dck" },
    { id: "power-modern-2011-1-j-killa-eldrazi-ramp", file: "1-j-killa-eldrazi-ramp.dck" },
    { id: "power-modern-2011-1-darking-merfolk", file: "1-darking-merfolk.dck" },
    { id: "power-modern-2011-1-burton911-g-b-rock", file: "1-burton911-g-b-rock.dck" },
    { id: "power-modern-2011-1-straca3-no-stick", file: "1-straca3-no-stick.dck" },
    { id: "power-modern-2011-1-pandote-jund", file: "1-pandote-jund.dck" },
    { id: "power-modern-2011-1-samuele-estratti-splinter-twin", file: "1-samuele-estratti-splinter-twin.dck" },
    { id: "power-modern-2011-2-manachuel-burn", file: "2-manachuel-burn.dck" },
    { id: "power-modern-2011-2-fanboy1-gw-aggro", file: "2-fanboy1-gw-aggro.dck" },
    { id: "power-modern-2011-2-d-uodax-ad-nauseam", file: "2-d-uodax-ad-nauseam.dck" },
    { id: "power-modern-2011-2-b-rasi-landfall", file: "2-b-rasi-landfall.dck" },
    { id: "power-modern-2011-2-mossivo1986-persist-zoo", file: "2-mossivo1986-persist-zoo.dck" },
    { id: "power-modern-2011-4-popoy-caw-blade", file: "4-popoy-caw-blade.dck" },
    { id: "power-modern-2011-5-whogshrog-zoo-5c", file: "5-whogshrog-zoo-5c.dck" },
    { id: "power-modern-2011-2-josh-utter-leyton-counter-cat", file: "2-josh-utter-leyton-counter-cat.dck" },
    { id: "power-modern-2011-6-d-sinner-bant", file: "6-d-sinner-bant.dck" },
    { id: "power-modern-2011-6-foxy-faerie", file: "6-foxy-faerie.dck" },
    { id: "power-modern-2011-7-ero-sennin-infect-combo", file: "7-ero-sennin-infect-combo.dck" },
    { id: "power-modern-2011-7-s-bullet-hive-mind", file: "7-s-bullet-hive-mind.dck" },
    { id: "power-modern-2011-8-mattmobius-br-control", file: "8-mattmobius-br-control.dck" },
    { id: "power-modern-2011-5-max-sjoblom-pyromancer-ascension", file: "5-max-sjoblom-pyromancer-ascension.dck" },
    { id: "power-modern-2011-5-jesse-hampton-breachpost", file: "5-jesse-hampton-breachpost.dck" },
  ],
};

/**
 * The 2012 Modern power summer — `Modern (M13)`, 2012-07-13 to 2012-10-05,
 * pinned to Standard 2012’s own dates. 59 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2012.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 13, U 13, B 9, R 10, G 10; aggro 8,
 * midrange 6, control 6, combo 4.
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
    { id: "power-modern-2012-2-valentin-chab-birthing-pod", file: "2-valentin-chab-birthing-pod.dck" },
    { id: "power-modern-2012-1-jeffrey-tang-affinity", file: "1-jeffrey-tang-affinity.dck" },
    { id: "power-modern-2012-1-brandon-ayers-caw-blade", file: "1-brandon-ayers-caw-blade.dck" },
    { id: "power-modern-2012-1-marco-dolazza-faeries", file: "1-marco-dolazza-faeries.dck" },
    { id: "power-modern-2012-1-timothy-thomason-boros", file: "1-timothy-thomason-boros.dck" },
    { id: "power-modern-2012-1-nicolas-cuenca-aggro-loam", file: "1-nicolas-cuenca-aggro-loam.dck" },
    { id: "power-modern-2012-1-stefano-meoni-rug-tempo", file: "1-stefano-meoni-rug-tempo.dck" },
    { id: "power-modern-2012-1-denis-stepanov-ub-delver", file: "1-denis-stepanov-ub-delver.dck" },
    { id: "power-modern-2012-1-andy-burden-red-deck-wins", file: "1-andy-burden-red-deck-wins.dck" },
    { id: "power-modern-2012-1-roberto-bonadeo-living-end", file: "1-roberto-bonadeo-living-end.dck" },
    { id: "power-modern-2012-1-henry-romero-bw-tokens", file: "1-henry-romero-bw-tokens.dck" },
    { id: "power-modern-2012-1-antoine-leblond-gift-control", file: "1-antoine-leblond-gift-control.dck" },
    { id: "power-modern-2012-1-pedro-martinho-naya-zoo", file: "1-pedro-martinho-naya-zoo.dck" },
    { id: "power-modern-2012-1-luca-ravagli-next-level-u", file: "1-luca-ravagli-next-level-u.dck" },
    { id: "power-modern-2012-1-matija-vlahovic-gifts-tron", file: "1-matija-vlahovic-gifts-tron.dck" },
    { id: "power-modern-2012-1-bobby-oleksy-gw-tokens", file: "1-bobby-oleksy-gw-tokens.dck" },
    { id: "power-modern-2012-1-tzu-ching-kuo-uw-angel", file: "1-tzu-ching-kuo-uw-angel.dck" },
    { id: "power-modern-2012-2-tyke-pope-doran", file: "2-tyke-pope-doran.dck" },
    { id: "power-modern-2012-2-myles-housman-esper-control", file: "2-myles-housman-esper-control.dck" },
    { id: "power-modern-2012-2-matej-zatlkaj-dredgevine", file: "2-matej-zatlkaj-dredgevine.dck" },
    { id: "power-modern-2012-5-john-alesi-gift-tron", file: "5-john-alesi-gift-tron.dck" },
  ],
};

/**
 * The 2013 Modern power summer — `Modern (M14)`, 2013-07-19 to 2013-09-27,
 * pinned to Standard 2013’s own dates. 49 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2013.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 12, U 12, B 9, R 11, G 12; aggro 9,
 * midrange 4, control 5, combo 6.
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
    { id: "power-modern-2013-1-caprioli-davide-affinity", file: "1-caprioli-davide-affinity.dck" },
    { id: "power-modern-2013-1-doug-potter-jund", file: "1-doug-potter-jund.dck" },
    { id: "power-modern-2013-1-jonas-zimmermann-birthing-pod", file: "1-jonas-zimmermann-birthing-pod.dck" },
    { id: "power-modern-2013-1-dmitrij-verev-uwr-midrange", file: "1-dmitrij-verev-uwr-midrange.dck" },
    { id: "power-modern-2013-1-giulio-pasqui-twin-exarch", file: "1-giulio-pasqui-twin-exarch.dck" },
    { id: "power-modern-2013-1-mattia-rizzi-scapeshift", file: "1-mattia-rizzi-scapeshift.dck" },
    { id: "power-modern-2013-1-daniel-ahlberg-gr-tron", file: "1-daniel-ahlberg-gr-tron.dck" },
    { id: "power-modern-2013-1-jasper-johnson-epstein-red-deck-wins", file: "1-jasper-johnson-epstein-red-deck-wins.dck" },
    { id: "power-modern-2013-1-wesley-hovanec-infect-combo", file: "1-wesley-hovanec-infect-combo.dck" },
    { id: "power-modern-2013-1-nick-cuenca-gift-control", file: "1-nick-cuenca-gift-control.dck" },
    { id: "power-modern-2013-1-chi-hoi-yim-uw-control", file: "1-chi-hoi-yim-uw-control.dck" },
    { id: "power-modern-2013-1-ajburn94-living-end", file: "1-ajburn94-living-end.dck" },
    { id: "power-modern-2013-1-tenaciousdealer-doran-junk", file: "1-tenaciousdealer-doran-junk.dck" },
    { id: "power-modern-2013-1-tim-muller-martyr-life", file: "1-tim-muller-martyr-life.dck" },
    { id: "power-modern-2013-1-rinnen-davide-uw-angel", file: "1-rinnen-davide-uw-angel.dck" },
    { id: "power-modern-2013-1-the-great-dustini-delverless-rug", file: "1-the-great-dustini-delverless-rug.dck" },
    { id: "power-modern-2013-1-gerald-jim-bob-sixkiller-zombie", file: "1-gerald-jim-bob-sixkiller-zombie.dck" },
    { id: "power-modern-2013-1-ferenc-nagy-bw-hatebear", file: "1-ferenc-nagy-bw-hatebear.dck" },
    { id: "power-modern-2013-1-wesley-bergen-boros", file: "1-wesley-bergen-boros.dck" },
    { id: "power-modern-2013-1-shahar-shenhar-uwx-midrange", file: "1-shahar-shenhar-uwx-midrange.dck" },
    { id: "power-modern-2013-3-ronco-matteo-ur-storm", file: "3-ronco-matteo-ur-storm.dck" },
    { id: "power-modern-2013-3-elia-rossi-boom-naya", file: "3-elia-rossi-boom-naya.dck" },
    { id: "power-modern-2013-5-sander-sepp-deathcloud", file: "5-sander-sepp-deathcloud.dck" },
    { id: "power-modern-2013-7-riccardo-bondani-esper-tapout", file: "7-riccardo-bondani-esper-tapout.dck" },
  ],
};

/**
 * The 2014 Modern power summer — `Modern (M15)`, 2014-07-18 to 2014-09-26,
 * pinned to Standard 2014’s own dates. 58 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2014.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 11, B 8, R 11, G 9; aggro 7,
 * midrange 6, control 5, combo 6.
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
    { id: "power-modern-2014-1-michele-ancona-birthing-pod", file: "1-michele-ancona-birthing-pod.dck" },
    { id: "power-modern-2014-1-giuseppe-reale-u-tron", file: "1-giuseppe-reale-u-tron.dck" },
    { id: "power-modern-2014-1-mathias-de-momi-twin-exarch", file: "1-mathias-de-momi-twin-exarch.dck" },
    { id: "power-modern-2014-1-stefano-vinci-jund", file: "1-stefano-vinci-jund.dck" },
    { id: "power-modern-2014-1-bryon-king-the-rock", file: "1-bryon-king-the-rock.dck" },
    { id: "power-modern-2014-1-simone-lampasona-scapeshift", file: "1-simone-lampasona-scapeshift.dck" },
    { id: "power-modern-2014-1-jason-qian-uwr-midrange", file: "1-jason-qian-uwr-midrange.dck" },
    { id: "power-modern-2014-1-serafin-wellinger-hatebear", file: "1-serafin-wellinger-hatebear.dck" },
    { id: "power-modern-2014-1-marco-santopadre-uw-midrange", file: "1-marco-santopadre-uw-midrange.dck" },
    { id: "power-modern-2014-1-douglas-mckay-red-deck-wins", file: "1-douglas-mckay-red-deck-wins.dck" },
    { id: "power-modern-2014-1-byron-king-burn", file: "1-byron-king-burn.dck" },
    { id: "power-modern-2014-1-oskar-wall-gr-tron", file: "1-oskar-wall-gr-tron.dck" },
    { id: "power-modern-2014-1-seamus-burke-merfolk", file: "1-seamus-burke-merfolk.dck" },
    { id: "power-modern-2014-1-mark-donaldson-ur-storm", file: "1-mark-donaldson-ur-storm.dck" },
    { id: "power-modern-2014-1-jim-still-blue-moon", file: "1-jim-still-blue-moon.dck" },
    { id: "power-modern-2014-1-neeraj-shukla-ad-nauseam", file: "1-neeraj-shukla-ad-nauseam.dck" },
    { id: "power-modern-2014-1-blake-sanford-martyr-life", file: "1-blake-sanford-martyr-life.dck" },
    { id: "power-modern-2014-1-benjamin-van-koekenbeek-mono-vert-stompy", file: "1-benjamin-van-koekenbeek-mono-vert-stompy.dck" },
    { id: "power-modern-2014-1-itou-manabu-gruul-control", file: "1-itou-manabu-gruul-control.dck" },
    { id: "power-modern-2014-2-valerio-bartolini-living-end", file: "2-valerio-bartolini-living-end.dck" },
    { id: "power-modern-2014-1-guillaume-matignon-faeries", file: "1-guillaume-matignon-faeries.dck" },
    { id: "power-modern-2014-1-christopher-dearing-orzhov-midrange", file: "1-christopher-dearing-orzhov-midrange.dck" },
    { id: "power-modern-2014-1-diony-idelfonso-uw-gift-tron", file: "1-diony-idelfonso-uw-gift-tron.dck" },
    { id: "power-modern-2014-3-yinan-zhang-bw-tokens", file: "3-yinan-zhang-bw-tokens.dck" },
  ],
};

/**
 * The 2015 Modern power summer — `Modern (ORI)`, 2015-07-17 to 2015-10-02,
 * pinned to Standard 2015’s own dates. 64 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2015.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 13, B 9, R 9, G 13; aggro 7,
 * midrange 6, control 6, combo 5.
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
    { id: "power-modern-2015-1-tom-martell-bloom-titan", file: "1-tom-martell-bloom-titan.dck" },
    { id: "power-modern-2015-1-huang-ta-chi-gr-tron", file: "1-huang-ta-chi-gr-tron.dck" },
    { id: "power-modern-2015-1-hunter-platt-scapeshift", file: "1-hunter-platt-scapeshift.dck" },
    { id: "power-modern-2015-1-barone-chris-zoo", file: "1-barone-chris-zoo.dck" },
    { id: "power-modern-2015-1-daniel-villamizar-uwx-midrange", file: "1-daniel-villamizar-uwx-midrange.dck" },
    { id: "power-modern-2015-1-martin-muller-living-end", file: "1-martin-muller-living-end.dck" },
    { id: "power-modern-2015-1-andrew-mironovich-evil-twin", file: "1-andrew-mironovich-evil-twin.dck" },
    { id: "power-modern-2015-1-phil-silberman-uw-control-titan", file: "1-phil-silberman-uw-control-titan.dck" },
    { id: "power-modern-2015-1-johan-verhulst-tooth-and-nail", file: "1-johan-verhulst-tooth-and-nail.dck" },
    { id: "power-modern-2015-1-dario-casati-merfolk", file: "1-dario-casati-merfolk.dck" },
    { id: "power-modern-2015-1-joel-heath-infect", file: "1-joel-heath-infect.dck" },
    { id: "power-modern-2015-1-gerard-fabiano-bug-control", file: "1-gerard-fabiano-bug-control.dck" },
    { id: "power-modern-2015-1-ichikawa-yuuki-esper-control", file: "1-ichikawa-yuuki-esper-control.dck" },
    { id: "power-modern-2015-1-chris-graves-burn", file: "1-chris-graves-burn.dck" },
    { id: "power-modern-2015-1-alessandra-ruiz-podless-collected", file: "1-alessandra-ruiz-podless-collected.dck" },
    { id: "power-modern-2015-1-jon-benavides-ad-nauseam", file: "1-jon-benavides-ad-nauseam.dck" },
    { id: "power-modern-2015-1-alexander-drapaylo-elves", file: "1-alexander-drapaylo-elves.dck" },
    { id: "power-modern-2015-1-oliver-biesgen-mono-green-titan", file: "1-oliver-biesgen-mono-green-titan.dck" },
    { id: "power-modern-2015-1-david-goldfarb-walk-machine", file: "1-david-goldfarb-walk-machine.dck" },
    { id: "power-modern-2015-1-deepfinesse-ur-aggro", file: "1-deepfinesse-ur-aggro.dck" },
    { id: "power-modern-2015-1-mathew-loong-abzan", file: "1-mathew-loong-abzan.dck" },
    { id: "power-modern-2015-1-lucas-hyttel-uwr-midrange", file: "1-lucas-hyttel-uwr-midrange.dck" },
  ],
};

/**
 * The 2016 Modern power summer — `Modern (EMN)`, 2016-07-22 to 2016-09-30,
 * pinned to Standard 2016’s own dates. 68 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2016.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 11, U 14, B 10, R 14, G 12; aggro 8,
 * midrange 6, control 5, combo 5.
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
    { id: "power-modern-2016-1-fabio-giaccio-merfolk", file: "1-fabio-giaccio-merfolk.dck" },
    { id: "power-modern-2016-1-alessandro-casamenti-ad-nauseam", file: "1-alessandro-casamenti-ad-nauseam.dck" },
    { id: "power-modern-2016-1-michael-rossi-living-end", file: "1-michael-rossi-living-end.dck" },
    { id: "power-modern-2016-1-simon-nielsen-death-s-shadow-zoo", file: "1-simon-nielsen-death-s-shadow-zoo.dck" },
    { id: "power-modern-2016-1-kevin-jones-grixis-delver", file: "1-kevin-jones-grixis-delver.dck" },
    { id: "power-modern-2016-1-jose-luis-echeverria-nahiri-control", file: "1-jose-luis-echeverria-nahiri-control.dck" },
    { id: "power-modern-2016-1-yu-yin-mardu-nahiri", file: "1-yu-yin-mardu-nahiri.dck" },
    { id: "power-modern-2016-1-satou-keisuke-jeskai-control", file: "1-satou-keisuke-jeskai-control.dck" },
    { id: "power-modern-2016-1-luis-gobern-uwr-thopter-sword", file: "1-luis-gobern-uwr-thopter-sword.dck" },
    { id: "power-modern-2016-1-damien-chabrier-rg-breach", file: "1-damien-chabrier-rg-breach.dck" },
    { id: "power-modern-2016-1-miguel-angel-ferrero-grixis-control", file: "1-miguel-angel-ferrero-grixis-control.dck" },
    { id: "power-modern-2016-1-nicolo-tassotti-bloomless-titan", file: "1-nicolo-tassotti-bloomless-titan.dck" },
    { id: "power-modern-2016-1-matthew-davidson-kiki-evolution", file: "1-matthew-davidson-kiki-evolution.dck" },
    { id: "power-modern-2016-1-saito-takaya-esper-midrange", file: "1-saito-takaya-esper-midrange.dck" },
    { id: "power-modern-2016-1-taylor-grant-b-g-elves", file: "1-taylor-grant-b-g-elves.dck" },
    { id: "power-modern-2016-1-avignon-uw-control", file: "1-avignon-uw-control.dck" },
  ],
};

/**
 * The 2017 Modern power summer — `Modern (HOU)`, 2017-07-14 to 2017-09-29,
 * pinned to Standard 2017’s own dates. 73 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2017.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 10, B 10, R 12, G 13; aggro 8,
 * midrange 7, control 5, combo 4.
 */
export const POWER_SUMMER_2017_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2017',
  directory: `${DECKS_ROOT}/modern-2017`,
  event: "2017 Modern power summer \u2014 Modern (HOU), 2017-07-14 \u2192 2017-09-29",
  format: "Modern (HOU)",
  date: "2017-07-14",
  source: 'docs/planning/deck-selection/review/modern-2017.md',
  decks: [
    { id: "power-modern-2017-1-jonas-nieke-affinity", file: "1-jonas-nieke-affinity.dck" },
    { id: "power-modern-2017-1-wordy333-dredge", file: "1-wordy333-dredge.dck" },
    { id: "power-modern-2017-1-dan-benipoyo-valakut", file: "1-dan-benipoyo-valakut.dck" },
    { id: "power-modern-2017-1-zturchan-junk", file: "1-zturchan-junk.dck" },
    { id: "power-modern-2017-1-dan-musser-eldra-tron", file: "1-dan-musser-eldra-tron.dck" },
    { id: "power-modern-2017-1-kazu-negri-ur-storm", file: "1-kazu-negri-ur-storm.dck" },
    { id: "power-modern-2017-1-anders-thiesen-titanshift", file: "1-anders-thiesen-titanshift.dck" },
    { id: "power-modern-2017-1-harlan-firer-uwr-midrange", file: "1-harlan-firer-uwr-midrange.dck" },
    { id: "power-modern-2017-1-brad-nelson-death-s-shadow", file: "1-brad-nelson-death-s-shadow.dck" },
    { id: "power-modern-2017-1-jonathan-sekenik-uw-control", file: "1-jonathan-sekenik-uw-control.dck" },
    { id: "power-modern-2017-1-brian-coval-hatebear", file: "1-brian-coval-hatebear.dck" },
    { id: "power-modern-2017-1-nicholas-byrd-ad-nauseam", file: "1-nicholas-byrd-ad-nauseam.dck" },
    { id: "power-modern-2017-1-kei-rong-death-s-shadow-aggro", file: "1-kei-rong-death-s-shadow-aggro.dck" },
    { id: "power-modern-2017-1-caleb-durward-collected-spirits", file: "1-caleb-durward-collected-spirits.dck" },
    { id: "power-modern-2017-1-michele-zino-jund", file: "1-michele-zino-jund.dck" },
    { id: "power-modern-2017-1-wilson-nunes-living-end", file: "1-wilson-nunes-living-end.dck" },
    { id: "power-modern-2017-1-kanister-lantern-control", file: "1-kanister-lantern-control.dck" },
    { id: "power-modern-2017-1-jeffhoogland-urzatron", file: "1-jeffhoogland-urzatron.dck" },
    { id: "power-modern-2017-1-rsanchez-collected-bant", file: "1-rsanchez-collected-bant.dck" },
    { id: "power-modern-2017-1-timothy-thomason-bant-knightfall", file: "1-timothy-thomason-bant-knightfall.dck" },
    { id: "power-modern-2017-1-yoshumotto-rakdos-control", file: "1-yoshumotto-rakdos-control.dck" },
    { id: "power-modern-2017-1-foo-pee-chun-azusa-amulet", file: "1-foo-pee-chun-azusa-amulet.dck" },
    { id: "power-modern-2017-1-ben-feingersh-bant-humans", file: "1-ben-feingersh-bant-humans.dck" },
    { id: "power-modern-2017-1-ryan-powell-esper-control", file: "1-ryan-powell-esper-control.dck" },
  ],
};

/**
 * The 2018 Modern power summer — `Modern (M19)`, 2018-07-13 to 2018-10-05,
 * pinned to Standard 2018’s own dates. 59 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2018.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 10, B 9, R 12, G 11; aggro 8,
 * midrange 7, control 5, combo 4.
 */
export const POWER_SUMMER_2018_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2018',
  directory: `${DECKS_ROOT}/modern-2018`,
  event: "2018 Modern power summer \u2014 Modern (M19), 2018-07-13 \u2192 2018-10-05",
  format: "Modern (M19)",
  date: "2018-07-13",
  source: 'docs/planning/deck-selection/review/modern-2018.md',
  decks: [
    { id: "power-modern-2018-1-william-courson-humans", file: "1-william-courson-humans.dck" },
    { id: "power-modern-2018-1-michael-olson-jund", file: "1-michael-olson-jund.dck" },
    { id: "power-modern-2018-1-joseph-terino-burn", file: "1-joseph-terino-burn.dck" },
    { id: "power-modern-2018-1-joey9fingas-hollow-one", file: "1-joey9fingas-hollow-one.dck" },
    { id: "power-modern-2018-1-andrew-lopez-jeskai-control", file: "1-andrew-lopez-jeskai-control.dck" },
    { id: "power-modern-2018-1-antonio-perez-urzatron", file: "1-antonio-perez-urzatron.dck" },
    { id: "power-modern-2018-1-thomas-mechin-uw-control", file: "1-thomas-mechin-uw-control.dck" },
    { id: "power-modern-2018-1-benjamin-lao-living-end", file: "1-benjamin-lao-living-end.dck" },
    { id: "power-modern-2018-1-john-tatian-infect", file: "1-john-tatian-infect.dck" },
    { id: "power-modern-2018-1-ondrej-strasky-bant-spirits", file: "1-ondrej-strasky-bant-spirits.dck" },
    { id: "power-modern-2018-1-lauri-pispa-hardened-modular", file: "1-lauri-pispa-hardened-modular.dck" },
    { id: "power-modern-2018-1-takaya-shouichi-selesnya-value", file: "1-takaya-shouichi-selesnya-value.dck" },
    { id: "power-modern-2018-1-david-peretti-ur-breach", file: "1-david-peretti-ur-breach.dck" },
    { id: "power-modern-2018-1-gobo2009-martyr-life", file: "1-gobo2009-martyr-life.dck" },
    { id: "power-modern-2018-1-bryan-haak-g-w-hexproof", file: "1-bryan-haak-g-w-hexproof.dck" },
    { id: "power-modern-2018-1-jose-echeverria-mardu-pyromancer", file: "1-jose-echeverria-mardu-pyromancer.dck" },
    { id: "power-modern-2018-1-matti-kuisma-dredge", file: "1-matti-kuisma-dredge.dck" },
    { id: "power-modern-2018-1-matt-hoey-ur-storm", file: "1-matt-hoey-ur-storm.dck" },
    { id: "power-modern-2018-1-adrian-malushaj-ad-nauseam", file: "1-adrian-malushaj-ad-nauseam.dck" },
    { id: "power-modern-2018-1-david-peretti-gruul-land-loss", file: "1-david-peretti-gruul-land-loss.dck" },
    { id: "power-modern-2018-1-vincenzo-balistreri-gr-eldrazi", file: "1-vincenzo-balistreri-gr-eldrazi.dck" },
    { id: "power-modern-2018-1-nicklas-krull-gift-control", file: "1-nicklas-krull-gift-control.dck" },
    { id: "power-modern-2018-1-ladislav-lezna-junk", file: "1-ladislav-lezna-junk.dck" },
    { id: "power-modern-2018-1-tony-decaro-8-rack", file: "1-tony-decaro-8-rack.dck" },
  ],
};

/**
 * The 2019 Modern power summer — `Modern (2019-08-30)`, 2019-08-30 to
 * 2019-10-04, pinned to Standard 2019’s own dates. 53 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/modern-2019.md` has the full
 * table and the ones dropped as illegal or near-duplicate); 24 chosen. One per
 * archetype, searched for colour and style spread: W 11, U 12, B 8, R 11, G 9;
 * aggro 8, midrange 7, control 5, combo 4.
 */
export const POWER_SUMMER_2019_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2019',
  directory: `${DECKS_ROOT}/modern-2019`,
  event: "2019 Modern power summer \u2014 Modern (2019-08-30), 2019-08-30 \u2192 2019-10-04",
  format: "Modern (2019-08-30)",
  date: "2019-08-30",
  source: 'docs/planning/deck-selection/review/modern-2019.md',
  decks: [
    { id: "power-modern-2019-1-jan-stadler-dredge", file: "1-jan-stadler-dredge.dck" },
    { id: "power-modern-2019-1-lev-ducenko-humans", file: "1-lev-ducenko-humans.dck" },
    { id: "power-modern-2019-1-kevin-brown-burn", file: "1-kevin-brown-burn.dck" },
    { id: "power-modern-2019-1-asnook-jund", file: "1-asnook-jund.dck" },
    { id: "power-modern-2019-1-anderson-leclair-urzatron", file: "1-anderson-leclair-urzatron.dck" },
    { id: "power-modern-2019-1-sean-belisle-urza", file: "1-sean-belisle-urza.dck" },
    { id: "power-modern-2019-1-volollo-death-s-shadow", file: "1-volollo-death-s-shadow.dck" },
    { id: "power-modern-2019-1-jakedurshimer-valakut", file: "1-jakedurshimer-valakut.dck" },
    { id: "power-modern-2019-1-joseph-karani-jeskai-stoneblade", file: "1-joseph-karani-jeskai-stoneblade.dck" },
    { id: "power-modern-2019-1-lennny-uw-control", file: "1-lennny-uw-control.dck" },
    { id: "power-modern-2019-1-andyscwilson-amulet-titan", file: "1-andyscwilson-amulet-titan.dck" },
    { id: "power-modern-2019-1-zachattack23-eldra-tron", file: "1-zachattack23-eldra-tron.dck" },
    { id: "power-modern-2019-1-theau-mery-hardened-scales", file: "1-theau-mery-hardened-scales.dck" },
    { id: "power-modern-2019-1-gregoris-soriente-ur-storm", file: "1-gregoris-soriente-ur-storm.dck" },
    { id: "power-modern-2019-1-yamaguchi-koutarou-martyr-life", file: "1-yamaguchi-koutarou-martyr-life.dck" },
    { id: "power-modern-2019-1-diego-moscoso-boggle", file: "1-diego-moscoso-boggle.dck" },
    { id: "power-modern-2019-1-ishizuki-takuya-ur-delver", file: "1-ishizuki-takuya-ur-delver.dck" },
    { id: "power-modern-2019-1-alexandre-pereira-devoted-druid-combo", file: "1-alexandre-pereira-devoted-druid-combo.dck" },
    { id: "power-modern-2019-1-satou-yusuke-eldritch-toolbox", file: "1-satou-yusuke-eldritch-toolbox.dck" },
    { id: "power-modern-2019-1-brian-garia-niv", file: "1-brian-garia-niv.dck" },
    { id: "power-modern-2019-1-djohar-gamboa-ad-nauseam", file: "1-djohar-gamboa-ad-nauseam.dck" },
    { id: "power-modern-2019-1-hasegawa-shunya-faeries", file: "1-hasegawa-shunya-faeries.dck" },
    { id: "power-modern-2019-1-bert-tong-ub-mill", file: "1-bert-tong-ub-mill.dck" },
    { id: "power-modern-2019-1-nick-pelowski-zur-s-weirding", file: "1-nick-pelowski-zur-s-weirding.dck" },
  ],
};

/**
 * The 2020 Modern power summer — `Modern (2020-07-13)`, 2020-08-03 to
 * 2020-09-25, pinned to Standard 2020’s own dates. 54 legal, distinct candidate
 * decks (`docs/planning/deck-selection/review/modern-2020.md` has the full
 * table and the ones dropped as illegal or near-duplicate); 24 chosen. One per
 * archetype, searched for colour and style spread: W 8, U 12, B 8, R 11, G 11;
 * aggro 8, midrange 6, control 5, combo 5.
 */
export const POWER_SUMMER_2020_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2020',
  directory: `${DECKS_ROOT}/modern-2020`,
  event: "2020 Modern power summer \u2014 Modern (2020-07-13), 2020-08-03 \u2192 2020-09-25",
  format: "Modern (2020-07-13)",
  date: "2020-08-03",
  source: 'docs/planning/deck-selection/review/modern-2020.md',
  decks: [
    { id: "power-modern-2020-1-lavaridge-temur-reclamation", file: "1-lavaridge-temur-reclamation.dck" },
    { id: "power-modern-2020-1-pootisgodsamongus-red-deck-wins", file: "1-pootisgodsamongus-red-deck-wins.dck" },
    { id: "power-modern-2020-1-bedell-amulet-titan", file: "1-bedell-amulet-titan.dck" },
    { id: "power-modern-2020-1-thetunnelingcat-eldra-tron", file: "1-thetunnelingcat-eldra-tron.dck" },
    { id: "power-modern-2020-1-coert-burn", file: "1-coert-burn.dck" },
    { id: "power-modern-2020-1-mercenario-dredge", file: "1-mercenario-dredge.dck" },
    { id: "power-modern-2020-1-joshicallsmefabo-humans", file: "1-joshicallsmefabo-humans.dck" },
    { id: "power-modern-2020-1-sharkcaster-mage-valakut", file: "1-sharkcaster-mage-valakut.dck" },
    { id: "power-modern-2020-1-ryan-donkin-ad-nauseam", file: "1-ryan-donkin-ad-nauseam.dck" },
    { id: "power-modern-2020-1-zonast-grixis-delver", file: "1-zonast-grixis-delver.dck" },
    { id: "power-modern-2020-1-arnaud-hocquemiller-w-u-stoneblade", file: "1-arnaud-hocquemiller-w-u-stoneblade.dck" },
    { id: "power-modern-2020-1-morita-masayuki-urzatron", file: "1-morita-masayuki-urzatron.dck" },
    { id: "power-modern-2020-1-albert62-jund", file: "1-albert62-jund.dck" },
    { id: "power-modern-2020-1-gigy-gruul-utopia", file: "1-gigy-gruul-utopia.dck" },
    { id: "power-modern-2020-1-immanuelkantrolgod-bant-control", file: "1-immanuelkantrolgod-bant-control.dck" },
    { id: "power-modern-2020-1-gerschi-rakdos-aggro", file: "1-gerschi-rakdos-aggro.dck" },
    { id: "power-modern-2020-1-pat-sultai-ninjas", file: "1-pat-sultai-ninjas.dck" },
    { id: "power-modern-2020-1-hugo87-ur-storm", file: "1-hugo87-ur-storm.dck" },
    { id: "power-modern-2020-1-headshot93-aura-hexproof", file: "1-headshot93-aura-hexproof.dck" },
    { id: "power-modern-2020-1-xfile-the-rock", file: "1-xfile-the-rock.dck" },
    { id: "power-modern-2020-1-shadow-pt-uw-control", file: "1-shadow-pt-uw-control.dck" },
    { id: "power-modern-2020-1-andy-michaud-twiddle-storm", file: "1-andy-michaud-twiddle-storm.dck" },
    { id: "power-modern-2020-1-sultai4lyfe-ub-control", file: "1-sultai4lyfe-ub-control.dck" },
    { id: "power-modern-2020-2-jack-cummins-allosaurus-combo", file: "2-jack-cummins-allosaurus-combo.dck" },
  ],
};

/**
 * The 2021 Modern power summer — `Modern (AFR)`, 2021-07-23 to 2021-09-24,
 * pinned to Standard 2021’s own dates. 70 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2021.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 13, B 9, R 12, G 11; aggro 9,
 * midrange 6, control 5, combo 4.
 */
export const POWER_SUMMER_2021_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2021',
  directory: `${DECKS_ROOT}/modern-2021`,
  event: "2021 Modern power summer \u2014 Modern (AFR), 2021-07-23 \u2192 2021-09-24",
  format: "Modern (AFR)",
  date: "2021-07-23",
  source: 'docs/planning/deck-selection/review/modern-2021.md',
  decks: [
    { id: "power-modern-2021-1-oscar-franco-living-end", file: "1-oscar-franco-living-end.dck" },
    { id: "power-modern-2021-1-micha-a-smo-ko-ur-murktide", file: "1-micha-a-smo-ko-ur-murktide.dck" },
    { id: "power-modern-2021-1-martin-eric-gauthier-heliod-life", file: "1-martin-eric-gauthier-heliod-life.dck" },
    { id: "power-modern-2021-1-sicsmoo-urzatron", file: "1-sicsmoo-urzatron.dck" },
    { id: "power-modern-2021-1-kazuya-takuwa-red-deck-wins", file: "1-kazuya-takuwa-red-deck-wins.dck" },
    { id: "power-modern-2021-1-yuuki-ichikawa-crashing-footfalls", file: "1-yuuki-ichikawa-crashing-footfalls.dck" },
    { id: "power-modern-2021-1-andrea-marra-grixis-food", file: "1-andrea-marra-grixis-food.dck" },
    { id: "power-modern-2021-1-friskifraska-orzhov-ephemerate", file: "1-friskifraska-orzhov-ephemerate.dck" },
    { id: "power-modern-2021-1-dreamsofashiok-eldra-tron", file: "1-dreamsofashiok-eldra-tron.dck" },
    { id: "power-modern-2021-1-kita-masahiro-dredge", file: "1-kita-masahiro-dredge.dck" },
    { id: "power-modern-2021-1-jared-robinson-jund", file: "1-jared-robinson-jund.dck" },
    { id: "power-modern-2021-1-triosk-uw-control", file: "1-triosk-uw-control.dck" },
    { id: "power-modern-2021-1-jonathan-goss-the-underworld-cookbook", file: "1-jonathan-goss-the-underworld-cookbook.dck" },
    { id: "power-modern-2021-1-magicofplayer1-4c-omnath", file: "1-magicofplayer1-4c-omnath.dck" },
    { id: "power-modern-2021-1-alexander-lapping-bant-control", file: "1-alexander-lapping-bant-control.dck" },
    { id: "power-modern-2021-1-alakai-breach", file: "1-alakai-breach.dck" },
    { id: "power-modern-2021-1-kitamura-shuuhei-zoo", file: "1-kitamura-shuuhei-zoo.dck" },
    { id: "power-modern-2021-1-tokunaga-hiroki-uwx-midrange", file: "1-tokunaga-hiroki-uwx-midrange.dck" },
    { id: "power-modern-2021-1-troy-taylor-grixis-creativity", file: "1-troy-taylor-grixis-creativity.dck" },
    { id: "power-modern-2021-1-axel-signargout-eldrazi-and-taxes", file: "1-axel-signargout-eldrazi-and-taxes.dck" },
    { id: "power-modern-2021-1-markus-julich-gb-yawgmoth", file: "1-markus-julich-gb-yawgmoth.dck" },
    { id: "power-modern-2021-1-nathaniel-snyder-gruul-food", file: "1-nathaniel-snyder-gruul-food.dck" },
    { id: "power-modern-2021-1-ihashi-toshiya-scapeshift", file: "1-ihashi-toshiya-scapeshift.dck" },
    { id: "power-modern-2021-1-paeng-paeng-ur-storm", file: "1-paeng-paeng-ur-storm.dck" },
  ],
};

/**
 * The 2022 Modern power summer — `Modern (SNC)`, 2022-04-29 to 2022-09-09,
 * pinned to Standard 2022’s own dates. 56 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2022.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 12, B 8, R 12, G 10; aggro 8,
 * midrange 8, control 4, combo 4.
 */
export const POWER_SUMMER_2022_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2022',
  directory: `${DECKS_ROOT}/modern-2022`,
  event: "2022 Modern power summer \u2014 Modern (SNC), 2022-04-29 \u2192 2022-09-09",
  format: "Modern (SNC)",
  date: "2022-04-29",
  source: 'docs/planning/deck-selection/review/modern-2022.md',
  decks: [
    { id: "power-modern-2022-1-maxx-kominowski-ur-aggro", file: "1-maxx-kominowski-ur-aggro.dck" },
    { id: "power-modern-2022-1-jordan-lidsky-hammer-time", file: "1-jordan-lidsky-hammer-time.dck" },
    { id: "power-modern-2022-1-will-kowalczyk-amulet-titan", file: "1-will-kowalczyk-amulet-titan.dck" },
    { id: "power-modern-2022-1-stormguyisme-living-end", file: "1-stormguyisme-living-end.dck" },
    { id: "power-modern-2022-1-zach-dubin-4c-yorion", file: "1-zach-dubin-4c-yorion.dck" },
    { id: "power-modern-2022-1-james-joash-primicias-crashing-footfalls-cascade", file: "1-james-joash-primicias-crashing-footfalls-cascade.dck" },
    { id: "power-modern-2022-1-shayne-brown-burn", file: "1-shayne-brown-burn.dck" },
    { id: "power-modern-2022-1-diego-mayo-creativity", file: "1-diego-mayo-creativity.dck" },
    { id: "power-modern-2022-1-david-johnson-creatures-toolbox", file: "1-david-johnson-creatures-toolbox.dck" },
    { id: "power-modern-2022-1-brady-munroe-urzatron", file: "1-brady-munroe-urzatron.dck" },
    { id: "power-modern-2022-1-ross-merriam-breach", file: "1-ross-merriam-breach.dck" },
    { id: "power-modern-2022-1-will-kreuger-valakut", file: "1-will-kreuger-valakut.dck" },
    { id: "power-modern-2022-1-dillon-evans-reanimator", file: "1-dillon-evans-reanimator.dck" },
    { id: "power-modern-2022-1-trick-bannon-goblins", file: "1-trick-bannon-goblins.dck" },
    { id: "power-modern-2022-1-alexandre-damiens-calibrated-blast", file: "1-alexandre-damiens-calibrated-blast.dck" },
    { id: "power-modern-2022-1-david-bishop-mono-blue-tempo", file: "1-david-bishop-mono-blue-tempo.dck" },
    { id: "power-modern-2022-1-raja-sulaiman-uw-control", file: "1-raja-sulaiman-uw-control.dck" },
    { id: "power-modern-2022-1-damian-del-nero-eldra-tron", file: "1-damian-del-nero-eldra-tron.dck" },
    { id: "power-modern-2022-1-tanahashi-takuya-ub-mill", file: "1-tanahashi-takuya-ub-mill.dck" },
    { id: "power-modern-2022-1-cole-cunningham-tron", file: "1-cole-cunningham-tron.dck" },
    { id: "power-modern-2022-1-ryan-barger-death-and-taxes", file: "1-ryan-barger-death-and-taxes.dck" },
    { id: "power-modern-2022-1-jack-komer-bring-to-scapeshift", file: "1-jack-komer-bring-to-scapeshift.dck" },
    { id: "power-modern-2022-1-rob-lyons-scapeshift", file: "1-rob-lyons-scapeshift.dck" },
    { id: "power-modern-2022-1-alan-07-4c-archon", file: "1-alan-07-4c-archon.dck" },
  ],
};

/**
 * The 2023 Modern power summer — `Modern (MAT)`, 2023-05-29 to 2023-09-08,
 * pinned to Standard 2023’s own dates. 41 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2023.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 9, U 13, B 10, R 13, G 10; aggro 9,
 * midrange 6, control 5, combo 4.
 */
export const POWER_SUMMER_2023_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2023',
  directory: `${DECKS_ROOT}/modern-2023`,
  event: "2023 Modern power summer \u2014 Modern (MAT), 2023-05-29 \u2192 2023-09-08",
  format: "Modern (MAT)",
  date: "2023-05-29",
  source: 'docs/planning/deck-selection/review/modern-2023.md',
  decks: [
    { id: "power-modern-2023-1-alessandro-stanizi-creativity", file: "1-alessandro-stanizi-creativity.dck" },
    { id: "power-modern-2023-1-bunny-gamble-omnath-rhinos", file: "1-bunny-gamble-omnath-rhinos.dck" },
    { id: "power-modern-2023-1-badzio-hardened-scales", file: "1-badzio-hardened-scales.dck" },
    { id: "power-modern-2023-1-nitta-shinya-hammer-time", file: "1-nitta-shinya-hammer-time.dck" },
    { id: "power-modern-2023-1-fingers1991-burn", file: "1-fingers1991-burn.dck" },
    { id: "power-modern-2023-1-tobias-weissenborn-breach", file: "1-tobias-weissenborn-breach.dck" },
    { id: "power-modern-2023-1-shimazaki-taichi-death-s-shadow", file: "1-shimazaki-taichi-death-s-shadow.dck" },
    { id: "power-modern-2023-1-shinbo-sotaro-jund", file: "1-shinbo-sotaro-jund.dck" },
    { id: "power-modern-2023-1-vinicius-maciel-mono-black-control", file: "1-vinicius-maciel-mono-black-control.dck" },
    { id: "power-modern-2023-1-maxime-odegaard-merfolk", file: "1-maxime-odegaard-merfolk.dck" },
    { id: "power-modern-2023-1-watoo-uw-control", file: "1-watoo-uw-control.dck" },
    { id: "power-modern-2023-1-betrix2688-creatures-toolbox", file: "1-betrix2688-creatures-toolbox.dck" },
    { id: "power-modern-2023-1-tibalt-of-red-sub-ub-mill", file: "1-tibalt-of-red-sub-ub-mill.dck" },
    { id: "power-modern-2023-1-pandatomik-instant-reanimator", file: "1-pandatomik-instant-reanimator.dck" },
    { id: "power-modern-2023-1-eldin-ibrahimovic-big-red", file: "1-eldin-ibrahimovic-big-red.dck" },
    { id: "power-modern-2023-1-magi-giovanni-bring-to-scapeshift", file: "1-magi-giovanni-bring-to-scapeshift.dck" },
    { id: "power-modern-2023-1-sakaino-yuuta-ww", file: "1-sakaino-yuuta-ww.dck" },
    { id: "power-modern-2023-1-michaelw1-mono-white-ephemerate", file: "1-michaelw1-mono-white-ephemerate.dck" },
    { id: "power-modern-2023-2-elijah-devesa-temur-rhino", file: "2-elijah-devesa-temur-rhino.dck" },
    { id: "power-modern-2023-3-jonathan-dolor-green-tron", file: "3-jonathan-dolor-green-tron.dck" },
    { id: "power-modern-2023-2-mrzippers-dredge", file: "2-mrzippers-dredge.dck" },
    { id: "power-modern-2023-2-ivan-espinosa-4-color-control", file: "2-ivan-espinosa-4-color-control.dck" },
    { id: "power-modern-2023-3-jay-jasper-flores-goryo-s-food", file: "3-jay-jasper-flores-goryo-s-food.dck" },
    { id: "power-modern-2023-33-takahisa-satou-reanimator", file: "33-takahisa-satou-reanimator.dck" },
  ],
};

/**
 * The 2024 Modern power summer — `Modern (OTJ)`, 2024-04-19 to 2024-08-02,
 * pinned to Standard 2024’s own dates. 40 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2024.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 12, B 10, R 12, G 9; aggro 8,
 * midrange 6, control 6, combo 4.
 */
export const POWER_SUMMER_2024_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2024',
  directory: `${DECKS_ROOT}/modern-2024`,
  event: "2024 Modern power summer \u2014 Modern (OTJ), 2024-04-19 \u2192 2024-08-02",
  format: "Modern (OTJ)",
  date: "2024-04-19",
  source: 'docs/planning/deck-selection/review/modern-2024.md',
  decks: [
    { id: "power-modern-2024-1-stefan-schutz-chord-toolbox", file: "1-stefan-schutz-chord-toolbox.dck" },
    { id: "power-modern-2024-1-lucasg1ggs-living-end", file: "1-lucasg1ggs-living-end.dck" },
    { id: "power-modern-2024-1-dfrank-amulet-titan", file: "1-dfrank-amulet-titan.dck" },
    { id: "power-modern-2024-1-alessandro-parisi-creativity", file: "1-alessandro-parisi-creativity.dck" },
    { id: "power-modern-2024-1-ken-min-yeoh-s-team-the-one-azorius", file: "1-ken-min-yeoh-s-team-the-one-azorius.dck" },
    { id: "power-modern-2024-1-vini-torres-uw-mill", file: "1-vini-torres-uw-mill.dck" },
    { id: "power-modern-2024-1-luis-kassel-temur-prowess", file: "1-luis-kassel-temur-prowess.dck" },
    { id: "power-modern-2024-1-naisirc-rakdos-aggro", file: "1-naisirc-rakdos-aggro.dck" },
    { id: "power-modern-2024-1-azja-5c-domain-aggro", file: "1-azja-5c-domain-aggro.dck" },
    { id: "power-modern-2024-1-claymoretobi-mono-black-control", file: "1-claymoretobi-mono-black-control.dck" },
    { id: "power-modern-2024-1-calmdownbronco-red-deck-wins", file: "1-calmdownbronco-red-deck-wins.dck" },
    { id: "power-modern-2024-1-mcwinsauce-jund", file: "1-mcwinsauce-jund.dck" },
    { id: "power-modern-2024-1-kurusu-4c-control", file: "1-kurusu-4c-control.dck" },
    { id: "power-modern-2024-1-ale-mtg-gruul-aggro", file: "1-ale-mtg-gruul-aggro.dck" },
    { id: "power-modern-2024-1-selfeisek-mono-black-scam", file: "1-selfeisek-mono-black-scam.dck" },
    { id: "power-modern-2024-1-stefanocanclini-scapeshift", file: "1-stefanocanclini-scapeshift.dck" },
    { id: "power-modern-2024-1-iaashadow-martyr-life", file: "1-iaashadow-martyr-life.dck" },
    { id: "power-modern-2024-1-supercow12653-ur-control", file: "1-supercow12653-ur-control.dck" },
    { id: "power-modern-2024-1-franklin-fulks-esper-goryo-s", file: "1-franklin-fulks-esper-goryo-s.dck" },
    { id: "power-modern-2024-1-qbeczkowo-reanimator", file: "1-qbeczkowo-reanimator.dck" },
    { id: "power-modern-2024-1-vinicius-castro-pasquetto-uw-control", file: "1-vinicius-castro-pasquetto-uw-control.dck" },
    { id: "power-modern-2024-1-benoit-jaques-elementals", file: "1-benoit-jaques-elementals.dck" },
    { id: "power-modern-2024-2-absoluteragez-burn", file: "2-absoluteragez-burn.dck" },
    { id: "power-modern-2024-3-screenwriterny-ad-nauseam", file: "3-screenwriterny-ad-nauseam.dck" },
  ],
};

/**
 * The 2025 Modern power summer — `Modern (FIN)`, 2025-06-30 to 2025-08-01,
 * pinned to Standard 2025’s own dates. 55 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/modern-2025.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 12, B 9, R 12, G 9; aggro 7,
 * midrange 7, control 6, combo 4.
 */
export const POWER_SUMMER_2025_MODERN: LibraryCollection = {
  family: 'modern',
  id: 'power-summer-modern-2025',
  directory: `${DECKS_ROOT}/modern-2025`,
  event: "2025 Modern power summer \u2014 Modern (FIN), 2025-06-30 \u2192 2025-08-01",
  format: "Modern (FIN)",
  date: "2025-06-30",
  source: 'docs/planning/deck-selection/review/modern-2025.md',
  decks: [
    { id: "power-modern-2025-1-mcwinsauce-esper-taxes", file: "1-mcwinsauce-esper-taxes.dck" },
    { id: "power-modern-2025-1-imthekiing-boros-energy", file: "1-imthekiing-boros-energy.dck" },
    { id: "power-modern-2025-1-hunter-ovington-broodscale-bloodchief", file: "1-hunter-ovington-broodscale-bloodchief.dck" },
    { id: "power-modern-2025-1-juanmaat-dimir-control", file: "1-juanmaat-dimir-control.dck" },
    { id: "power-modern-2025-1-houseofmanamtg-amulet-titan", file: "1-houseofmanamtg-amulet-titan.dck" },
    { id: "power-modern-2025-1-kageyama-hiroki-landless-belcher", file: "1-kageyama-hiroki-landless-belcher.dck" },
    { id: "power-modern-2025-1-o-danielakos-ur-cutter-prowess", file: "1-o-danielakos-ur-cutter-prowess.dck" },
    { id: "power-modern-2025-1-barczek-instant-reanimator", file: "1-barczek-instant-reanimator.dck" },
    { id: "power-modern-2025-1-meninooney-living-end", file: "1-meninooney-living-end.dck" },
    { id: "power-modern-2025-1-rerere-allosaurus-combo", file: "1-rerere-allosaurus-combo.dck" },
    { id: "power-modern-2025-1-victor-gomez-gonzalez-jeskai-control", file: "1-victor-gomez-gonzalez-jeskai-control.dck" },
    { id: "power-modern-2025-1-azax-ruby-storm", file: "1-azax-ruby-storm.dck" },
    { id: "power-modern-2025-1-holdtheelle-urzatron", file: "1-holdtheelle-urzatron.dck" },
    { id: "power-modern-2025-1-roland77-eldrazi-aggro", file: "1-roland77-eldrazi-aggro.dck" },
    { id: "power-modern-2025-1-adrien-venancio-simic-birthing-ritual", file: "1-adrien-venancio-simic-birthing-ritual.dck" },
    { id: "power-modern-2025-1-yungdingo-death-s-shadow", file: "1-yungdingo-death-s-shadow.dck" },
    { id: "power-modern-2025-1-auzzie51-mono-white-control", file: "1-auzzie51-mono-white-control.dck" },
    { id: "power-modern-2025-1-davide-ferroni-hammertime", file: "1-davide-ferroni-hammertime.dck" },
    { id: "power-modern-2025-1-adrien-pennard-ur-cutter", file: "1-adrien-pennard-ur-cutter.dck" },
    { id: "power-modern-2025-1-valerio-nevischi-grixis-control", file: "1-valerio-nevischi-grixis-control.dck" },
    { id: "power-modern-2025-1-linden-43-mardu-aggro", file: "1-linden-43-mardu-aggro.dck" },
    { id: "power-modern-2025-1-truehero-4-5c-control", file: "1-truehero-4-5c-control.dck" },
    { id: "power-modern-2025-1-nilo-herrero-chord-toolbox", file: "1-nilo-herrero-chord-toolbox.dck" },
    { id: "power-modern-2025-1-francesco-galati-monoblack-necro", file: "1-francesco-galati-monoblack-necro.dck" },
  ],
};

/**
 * The 2005 Legacy power summer — `Legacy (9ED)`, 2005-08-20 to 2005-10-20,
 * pinned to Standard 2005’s own dates. 9 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2005.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 9 chosen of 9
 * candidates.** One per archetype, searched for colour and style spread: W 4,
 * U 2, B 0, R 6, G 4; aggro 7, midrange 0, control 2, combo 0. Red dominated
 * this era’s candidate pool (38% of its colour pips) and was given extra slots
 * (6 of 9 chosen).
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
    { id: "power-legacy-2005-1-cavern-ninja-not-quite-gro", file: "1-cavern-ninja-not-quite-gro.dck" },
    { id: "power-legacy-2005-2-peter-franke-r-tiger-sligh", file: "2-peter-franke-r-tiger-sligh.dck" },
    { id: "power-legacy-2005-3-zvi-mowshowitz-uw-landstill", file: "3-zvi-mowshowitz-uw-landstill.dck" },
    { id: "power-legacy-2005-2-xenoq-burn", file: "2-xenoq-burn.dck" },
    { id: "power-legacy-2005-5-matt-holmen-wrg-zoo", file: "5-matt-holmen-wrg-zoo.dck" },
    { id: "power-legacy-2005-5-jeff-rgsa", file: "5-jeff-rgsa.dck" },
    { id: "power-legacy-2005-5-watcher487-crappy-survival-junk", file: "5-watcher487-crappy-survival-junk.dck" },
    { id: "power-legacy-2005-5-philip-stolze-angel-stompy-variant", file: "5-philip-stolze-angel-stompy-variant.dck" },
  ],
};

/**
 * The 2006 Legacy power summer — `Legacy (CSP)`, 2006-08-20 to 2006-10-20,
 * pinned to Standard 2006’s own dates. 17 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2006.md` has the full table and
 * the ones dropped as illegal or near-duplicate); **Thin season: 17 chosen of
 * 17 candidates.** One per archetype, searched for colour and style spread:
 * W 7, U 8, B 5, R 6, G 7; aggro 5, midrange 5, control 7, combo 0.
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
    { id: "power-legacy-2006-1-paul-mastriano-flame-vault", file: "1-paul-mastriano-flame-vault.dck" },
    { id: "power-legacy-2006-1-doug-dampingengine-mckay-blue-skies", file: "1-doug-dampingengine-mckay-blue-skies.dck" },
    { id: "power-legacy-2006-1-james-tang-gat", file: "1-james-tang-gat.dck" },
    { id: "power-legacy-2006-1-helmut-summersberger-ugw-threshold", file: "1-helmut-summersberger-ugw-threshold.dck" },
    { id: "power-legacy-2006-3-rick-jander78-argiro-5-3", file: "3-rick-jander78-argiro-5-3.dck" },
    { id: "power-legacy-2006-2-chris-pikula-rogue-deadguy-ale-a-homebrew", file: "2-chris-pikula-rogue-deadguy-ale-a-homebrew.dck" },
    { id: "power-legacy-2006-8-john-mulletus-lacasse-rg-survival", file: "8-john-mulletus-lacasse-rg-survival.dck" },
    { id: "power-legacy-2006-3-luca-verdiani-recsur", file: "3-luca-verdiani-recsur.dck" },
    { id: "power-legacy-2006-3-pasquale-ruggiero-red-white-rift", file: "3-pasquale-ruggiero-red-white-rift.dck" },
    { id: "power-legacy-2006-5-maximilian-bracht-salvager", file: "5-maximilian-bracht-salvager.dck" },
    { id: "power-legacy-2006-5-ben-goodman-threshgro", file: "5-ben-goodman-threshgro.dck" },
    { id: "power-legacy-2006-5-nicolas-francois-uw-control", file: "5-nicolas-francois-uw-control.dck" },
    { id: "power-legacy-2006-2-pokerface-boros-aggro", file: "2-pokerface-boros-aggro.dck" },
    { id: "power-legacy-2006-3-timmy-sligh", file: "3-timmy-sligh.dck" },
    { id: "power-legacy-2006-5-universalsnip-troll-a-tog", file: "5-universalsnip-troll-a-tog.dck" },
  ],
};

/**
 * The 2007 Legacy power summer — `Legacy (10E)`, 2007-07-20 to 2007-10-20,
 * pinned to Standard 2007’s own dates. 27 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2007.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 9, U 12, B 9, R 8, G 11; aggro 9,
 * midrange 4, control 7, combo 4.
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
    { id: "power-legacy-2007-1-makuta-eiji-thresh", file: "1-makuta-eiji-thresh.dck" },
    { id: "power-legacy-2007-1-andrea-maccagnani-goblins", file: "1-andrea-maccagnani-goblins.dck" },
    { id: "power-legacy-2007-1-alessandro-teneggi-cephalid-breakfast", file: "1-alessandro-teneggi-cephalid-breakfast.dck" },
    { id: "power-legacy-2007-1-christian-hottgen-survival", file: "1-christian-hottgen-survival.dck" },
    { id: "power-legacy-2007-1-markus-seine-kampelmann-s-taschchen-ist-sergej", file: "1-markus-seine-kampelmann-s-taschchen-ist-sergej.dck" },
    { id: "power-legacy-2007-1-anton-karlinski-aggro-loam", file: "1-anton-karlinski-aggro-loam.dck" },
    { id: "power-legacy-2007-1-osada-masahiro-3c-sligh", file: "1-osada-masahiro-3c-sligh.dck" },
    { id: "power-legacy-2007-2-matthias-druppel-landstill", file: "2-matthias-druppel-landstill.dck" },
    { id: "power-legacy-2007-2-koizumi-yohei-aluren", file: "2-koizumi-yohei-aluren.dck" },
    { id: "power-legacy-2007-2-ryan-trepanier-lands", file: "2-ryan-trepanier-lands.dck" },
    { id: "power-legacy-2007-2-dennis-kampelmann-meat-free-deck", file: "2-dennis-kampelmann-meat-free-deck.dck" },
    { id: "power-legacy-2007-3-tsuda-yuugo-belcher", file: "3-tsuda-yuugo-belcher.dck" },
    { id: "power-legacy-2007-3-stefano-maccagnani-uw-control", file: "3-stefano-maccagnani-uw-control.dck" },
    { id: "power-legacy-2007-2-tsuda-yuugo-taiga", file: "2-tsuda-yuugo-taiga.dck" },
    { id: "power-legacy-2007-5-simone-giovanetti-tes", file: "5-simone-giovanetti-tes.dck" },
    { id: "power-legacy-2007-5-matteo-luppi-angel-stompy", file: "5-matteo-luppi-angel-stompy.dck" },
    { id: "power-legacy-2007-5-takamizu-tomohiro-muc", file: "5-takamizu-tomohiro-muc.dck" },
    { id: "power-legacy-2007-5-philipp-volk-keiner-mag-eugen-dec", file: "5-philipp-volk-keiner-mag-eugen-dec.dck" },
    { id: "power-legacy-2007-5-michael-steinecke-uw-barenmarke", file: "5-michael-steinecke-uw-barenmarke.dck" },
    { id: "power-legacy-2007-5-ogasawara-sho-pikula", file: "5-ogasawara-sho-pikula.dck" },
    { id: "power-legacy-2007-5-simon-hohentanner-life-from-the-loam-controle", file: "5-simon-hohentanner-life-from-the-loam-controle.dck" },
    { id: "power-legacy-2007-5-oliver-voll-elves", file: "5-oliver-voll-elves.dck" },
    { id: "power-legacy-2007-5-kubotera-yuuki-tog", file: "5-kubotera-yuuki-tog.dck" },
    { id: "power-legacy-2007-3-bill-stark-suicide-black", file: "3-bill-stark-suicide-black.dck" },
  ],
};

/**
 * The 2008 Legacy power summer — `Legacy (EVE)`, 2008-07-25 to 2008-10-03,
 * pinned to Standard 2008’s own dates. 69 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2008.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 14, B 13, R 10, G 12; aggro 8,
 * midrange 7, control 5, combo 4.
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
    { id: "power-legacy-2008-1-blake-patrow-meathooks", file: "1-blake-patrow-meathooks.dck" },
    { id: "power-legacy-2008-1-tatiana-thresh", file: "1-tatiana-thresh.dck" },
    { id: "power-legacy-2008-1-alvise-gorghetto-ichorid", file: "1-alvise-gorghetto-ichorid.dck" },
    { id: "power-legacy-2008-1-christoph-weitkamp-aggro-loam", file: "1-christoph-weitkamp-aggro-loam.dck" },
    { id: "power-legacy-2008-1-jaime-cano-landstill", file: "1-jaime-cano-landstill.dck" },
    { id: "power-legacy-2008-1-brian-diefendorf-survival", file: "1-brian-diefendorf-survival.dck" },
    { id: "power-legacy-2008-1-oscar-mesegue-ugb-threshold", file: "1-oscar-mesegue-ugb-threshold.dck" },
    { id: "power-legacy-2008-1-leonardo-romano-bgw-the-rock", file: "1-leonardo-romano-bgw-the-rock.dck" },
    { id: "power-legacy-2008-1-dennis-rosinski-panzerfaust", file: "1-dennis-rosinski-panzerfaust.dck" },
    { id: "power-legacy-2008-1-yamazaki-keiji-purple-death", file: "1-yamazaki-keiji-purple-death.dck" },
    { id: "power-legacy-2008-1-guillem-ragull-rgb-goblins", file: "1-guillem-ragull-rgb-goblins.dck" },
    { id: "power-legacy-2008-1-markus-seine-rgb-goyf-sligh", file: "1-markus-seine-rgb-goyf-sligh.dck" },
    { id: "power-legacy-2008-1-ogasawara-sho-ubg-big-fish", file: "1-ogasawara-sho-ubg-big-fish.dck" },
    { id: "power-legacy-2008-1-baptist-matthys-lftl-aggro-relou", file: "1-baptist-matthys-lftl-aggro-relou.dck" },
    { id: "power-legacy-2008-1-rodrigo-gonzalez-reanimator", file: "1-rodrigo-gonzalez-reanimator.dck" },
    { id: "power-legacy-2008-3-matthew-elias-belcher", file: "3-matthew-elias-belcher.dck" },
    { id: "power-legacy-2008-2-mauro-grassi-aluren", file: "2-mauro-grassi-aluren.dck" },
    { id: "power-legacy-2008-2-abraham-urena-armageddon-stax", file: "2-abraham-urena-armageddon-stax.dck" },
    { id: "power-legacy-2008-2-jordi-amat-ipop-negation", file: "2-jordi-amat-ipop-negation.dck" },
    { id: "power-legacy-2008-2-pablo-david-diaz-eternal-garden", file: "2-pablo-david-diaz-eternal-garden.dck" },
    { id: "power-legacy-2008-3-carcara-giuseppe-enduring-ideal", file: "3-carcara-giuseppe-enduring-ideal.dck" },
    { id: "power-legacy-2008-3-tom-hens-enchantress", file: "3-tom-hens-enchantress.dck" },
    { id: "power-legacy-2008-5-matteus-lamers-tes", file: "5-matteus-lamers-tes.dck" },
    { id: "power-legacy-2008-5-david-yepez-bwr-frikula", file: "5-david-yepez-bwr-frikula.dck" },
  ],
};

/**
 * The 2009 Legacy power summer — `Legacy (M10)`, 2009-07-17 to 2009-10-02,
 * pinned to Standard 2009’s own dates. 24 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2009.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 7, U 15, B 9, R 7, G 10; aggro 8,
 * midrange 5, control 7, combo 4. Blue dominated this era’s candidate pool (31%
 * of its colour pips) and was given extra slots (15 of 24 chosen).
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
    { id: "power-legacy-2009-2-maxime-gilles-togless", file: "2-maxime-gilles-togless.dck" },
    { id: "power-legacy-2009-2-jean-mary-lejay-accart-eternal-life", file: "2-jean-mary-lejay-accart-eternal-life.dck" },
    { id: "power-legacy-2009-3-damien-colomb-dreadstill", file: "3-damien-colomb-dreadstill.dck" },
    { id: "power-legacy-2009-3-thibauld-kandri-faerie-stompy", file: "3-thibauld-kandri-faerie-stompy.dck" },
    { id: "power-legacy-2009-3-manuel-wolf-tes", file: "3-manuel-wolf-tes.dck" },
    { id: "power-legacy-2009-5-thomas-monnier-4c-fish", file: "5-thomas-monnier-4c-fish.dck" },
    { id: "power-legacy-2009-5-maxime-jourdan-ant", file: "5-maxime-jourdan-ant.dck" },
    { id: "power-legacy-2009-5-jean-luc-rivoire-bgw-rock", file: "5-jean-luc-rivoire-bgw-rock.dck" },
    { id: "power-legacy-2009-5-raphael-raphy-puleo-seuil-ugr-old-school", file: "5-raphael-raphy-puleo-seuil-ugr-old-school.dck" },
    { id: "power-legacy-2009-8-simon-ritzka-solidarity-aka-reset-high-tide", file: "8-simon-ritzka-solidarity-aka-reset-high-tide.dck" },
    { id: "power-legacy-2009-3-paul-rietzl-eva-green", file: "3-paul-rietzl-eva-green.dck" },
    { id: "power-legacy-2009-4-stefan-czolk-ugw-thresh", file: "4-stefan-czolk-ugw-thresh.dck" },
    { id: "power-legacy-2009-5-brian-six-tarmo-sligh", file: "5-brian-six-tarmo-sligh.dck" },
    { id: "power-legacy-2009-5-brian-kowal-tarmo-pikula", file: "5-brian-kowal-tarmo-pikula.dck" },
    { id: "power-legacy-2009-6-filiberto-piernoli-imperial-painter", file: "6-filiberto-piernoli-imperial-painter.dck" },
    { id: "power-legacy-2009-7-angelo-cadei-urg-fish", file: "7-angelo-cadei-urg-fish.dck" },
    { id: "power-legacy-2009-9-cyril-pitallot-elfball", file: "9-cyril-pitallot-elfball.dck" },
    { id: "power-legacy-2009-10-frederico-testa-progenitus-survival", file: "10-frederico-testa-progenitus-survival.dck" },
    { id: "power-legacy-2009-12-antonio-pint-dredge", file: "12-antonio-pint-dredge.dck" },
    { id: "power-legacy-2009-13-michael-danis-uwb-landstill", file: "13-michael-danis-uwb-landstill.dck" },
  ],
};

/**
 * The 2010 Legacy power summer — `Legacy (M11)`, 2010-07-16 to 2010-10-01,
 * pinned to Standard 2010’s own dates. 44 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2010.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 9, U 12, B 8, R 9, G 12; aggro 8,
 * midrange 5, control 7, combo 4. Blue dominated this era’s candidate pool (30%
 * of its colour pips) and was given extra slots (12 of 24 chosen).
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
    { id: "power-legacy-2010-1-stork-gw-survival", file: "1-stork-gw-survival.dck" },
    { id: "power-legacy-2010-1-jc-asehan-4-color-supreme-blue", file: "1-jc-asehan-4-color-supreme-blue.dck" },
    { id: "power-legacy-2010-1-eddy-pereira-burning-animals", file: "1-eddy-pereira-burning-animals.dck" },
    { id: "power-legacy-2010-1-venturini-stefano-stacker-mono-brown", file: "1-venturini-stefano-stacker-mono-brown.dck" },
    { id: "power-legacy-2010-1-brian-peters-trinistax-mono-white", file: "1-brian-peters-trinistax-mono-white.dck" },
    { id: "power-legacy-2010-1-kouta-hattori-zoo", file: "1-kouta-hattori-zoo.dck" },
    { id: "power-legacy-2010-1-reto-sormani-rw-burn", file: "1-reto-sormani-rw-burn.dck" },
    { id: "power-legacy-2010-1-tomoharu-saito-merfolk-with-black", file: "1-tomoharu-saito-merfolk-with-black.dck" },
    { id: "power-legacy-2010-2-eifferson-deboria-maverick", file: "2-eifferson-deboria-maverick.dck" },
    { id: "power-legacy-2010-3-dan-monzon-axe-gang-fae", file: "3-dan-monzon-axe-gang-fae.dck" },
    { id: "power-legacy-2010-2-camille-assassin-pouliquen-goblins", file: "2-camille-assassin-pouliquen-goblins.dck" },
    { id: "power-legacy-2010-2-nejc-fin-gar-faeries", file: "2-nejc-fin-gar-faeries.dck" },
    { id: "power-legacy-2010-5-frizork-ant", file: "5-frizork-ant.dck" },
    { id: "power-legacy-2010-5-mark-guevarra-dredge", file: "5-mark-guevarra-dredge.dck" },
    { id: "power-legacy-2010-2-marc-tobiasch-uw-landstill", file: "2-marc-tobiasch-uw-landstill.dck" },
    { id: "power-legacy-2010-2-shinya-satou-team-america", file: "2-shinya-satou-team-america.dck" },
    { id: "power-legacy-2010-2-tom-martell-four-color-counterbalance", file: "2-tom-martell-four-color-counterbalance.dck" },
    { id: "power-legacy-2010-3-nicola-cantarutti-ichorid", file: "3-nicola-cantarutti-ichorid.dck" },
    { id: "power-legacy-2010-3-yuuki-ookubo-show-and-tell-sneak-attack", file: "3-yuuki-ookubo-show-and-tell-sneak-attack.dck" },
    { id: "power-legacy-2010-6-cedric-phillips-belcher", file: "6-cedric-phillips-belcher.dck" },
    { id: "power-legacy-2010-7-chris-woltereck-42-lands", file: "7-chris-woltereck-42-lands.dck" },
    { id: "power-legacy-2010-5-yuu-saitou-ad-nauseam-tendrils", file: "5-yuu-saitou-ad-nauseam-tendrils.dck" },
    { id: "power-legacy-2010-5-yuuya-hosokawa-elf-combo", file: "5-yuuya-hosokawa-elf-combo.dck" },
    { id: "power-legacy-2010-8-ken-adams-hexmage-depths", file: "8-ken-adams-hexmage-depths.dck" },
  ],
};

/**
 * The 2011 Legacy power summer — `Legacy (M12)`, 2011-07-15 to 2011-09-30,
 * pinned to Standard 2011’s own dates. 52 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2011.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 14, U 14, B 10, R 10, G 12; aggro 7,
 * midrange 6, control 6, combo 5. Blue dominated this era’s candidate pool (29%
 * of its colour pips) and was given extra slots (14 of 24 chosen).
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
    { id: "power-legacy-2011-1-christoph-lemke-pensel-zenith-maverick", file: "1-christoph-lemke-pensel-zenith-maverick.dck" },
    { id: "power-legacy-2011-1-jose-angel-cantero-pro-zenith-bant", file: "1-jose-angel-cantero-pro-zenith-bant.dck" },
    { id: "power-legacy-2011-1-alberto-manchado-caw-blade", file: "1-alberto-manchado-caw-blade.dck" },
    { id: "power-legacy-2011-1-michael-mazzoletti-rug-order", file: "1-michael-mazzoletti-rug-order.dck" },
    { id: "power-legacy-2011-1-krings-stefan-hive-mind", file: "1-krings-stefan-hive-mind.dck" },
    { id: "power-legacy-2011-1-nicola-tizzoni-spiral-tide", file: "1-nicola-tizzoni-spiral-tide.dck" },
    { id: "power-legacy-2011-1-sylvain-grolleau-aggro-loam", file: "1-sylvain-grolleau-aggro-loam.dck" },
    { id: "power-legacy-2011-1-davide-christian-orazi-stoneblade", file: "1-davide-christian-orazi-stoneblade.dck" },
    { id: "power-legacy-2011-1-vojtech-mraz-white-weenie", file: "1-vojtech-mraz-white-weenie.dck" },
    { id: "power-legacy-2011-1-erik-manooshism-show-tell", file: "1-erik-manooshism-show-tell.dck" },
    { id: "power-legacy-2011-1-ghesini-andrea-dark-threshold", file: "1-ghesini-andrea-dark-threshold.dck" },
    { id: "power-legacy-2011-1-raul-carcelen-punishing-zoo", file: "1-raul-carcelen-punishing-zoo.dck" },
    { id: "power-legacy-2011-1-giusti-matteo-dredge", file: "1-giusti-matteo-dredge.dck" },
    { id: "power-legacy-2011-1-pierre-sommen-dark-horizon", file: "1-pierre-sommen-dark-horizon.dck" },
    { id: "power-legacy-2011-1-weston-brown-ad-nauseam", file: "1-weston-brown-ad-nauseam.dck" },
    { id: "power-legacy-2011-1-pat-cox-zoo", file: "1-pat-cox-zoo.dck" },
    { id: "power-legacy-2011-1-iain-bartolomei-goblins", file: "1-iain-bartolomei-goblins.dck" },
    { id: "power-legacy-2011-1-samuel-tharmaratnam-sneak-attack", file: "1-samuel-tharmaratnam-sneak-attack.dck" },
    { id: "power-legacy-2011-1-manuel-gomez-burn", file: "1-manuel-gomez-burn.dck" },
    { id: "power-legacy-2011-1-michael-caffrey-eternal-garden", file: "1-michael-caffrey-eternal-garden.dck" },
    { id: "power-legacy-2011-1-svatopluk-sejkora-cephalid-breakfast", file: "1-svatopluk-sejkora-cephalid-breakfast.dck" },
    { id: "power-legacy-2011-1-omar-rohner-team-italia", file: "1-omar-rohner-team-italia.dck" },
    { id: "power-legacy-2011-1-josh-cicio-ub-control", file: "1-josh-cicio-ub-control.dck" },
  ],
};

/**
 * The 2012 Legacy power summer — `Legacy (M13)`, 2012-07-13 to 2012-10-05,
 * pinned to Standard 2012’s own dates. 59 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2012.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 12, B 10, R 10, G 10; aggro 7,
 * midrange 6, control 6, combo 5.
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
    { id: "power-legacy-2012-1-alex-del-valle-reanimator", file: "1-alex-del-valle-reanimator.dck" },
    { id: "power-legacy-2012-1-max-tietze-goblins", file: "1-max-tietze-goblins.dck" },
    { id: "power-legacy-2012-1-michael-hetrick-uw-miracles", file: "1-michael-hetrick-uw-miracles.dck" },
    { id: "power-legacy-2012-1-todd-anderson-threshold-canadian-ugr", file: "1-todd-anderson-threshold-canadian-ugr.dck" },
    { id: "power-legacy-2012-1-vidianto-wijaya-esper-stoneblade", file: "1-vidianto-wijaya-esper-stoneblade.dck" },
    { id: "power-legacy-2012-1-joshua-cho-merfolk", file: "1-joshua-cho-merfolk.dck" },
    { id: "power-legacy-2012-1-mark-eilers-dredge", file: "1-mark-eilers-dredge.dck" },
    { id: "power-legacy-2012-1-jonathan-hickerson-sneak-attack", file: "1-jonathan-hickerson-sneak-attack.dck" },
    { id: "power-legacy-2012-1-bobby-kovacs-eternal-garden", file: "1-bobby-kovacs-eternal-garden.dck" },
    { id: "power-legacy-2012-1-fabrizio-marchi-tes", file: "1-fabrizio-marchi-tes.dck" },
    { id: "power-legacy-2012-1-nicolas-noirhomme-bant", file: "1-nicolas-noirhomme-bant.dck" },
    { id: "power-legacy-2012-1-ben-nash-weenie-white", file: "1-ben-nash-weenie-white.dck" },
    { id: "power-legacy-2012-2-corbin-rudnick-1-land-belcher", file: "2-corbin-rudnick-1-land-belcher.dck" },
    { id: "power-legacy-2012-2-ryan-lumpford-naya-zoo", file: "2-ryan-lumpford-naya-zoo.dck" },
    { id: "power-legacy-2012-1-shane-kovaleski-elves", file: "1-shane-kovaleski-elves.dck" },
    { id: "power-legacy-2012-1-andrea-ghesini-spiral-tide", file: "1-andrea-ghesini-spiral-tide.dck" },
    { id: "power-legacy-2012-1-corrado-anchisi-aggro-loam", file: "1-corrado-anchisi-aggro-loam.dck" },
    { id: "power-legacy-2012-1-joan-rubies-faestalker", file: "1-joan-rubies-faestalker.dck" },
    { id: "power-legacy-2012-1-umberto-vuolo-traves", file: "1-umberto-vuolo-traves.dck" },
    { id: "power-legacy-2012-2-eric-fry-mud", file: "2-eric-fry-mud.dck" },
    { id: "power-legacy-2012-2-benjamin-niehaus-burn", file: "2-benjamin-niehaus-burn.dck" },
    { id: "power-legacy-2012-2-lescarini-luigi-nic-fit-valakut", file: "2-lescarini-luigi-nic-fit-valakut.dck" },
    { id: "power-legacy-2012-4-andrea-martinelli-the-rock-junk", file: "4-andrea-martinelli-the-rock-junk.dck" },
    { id: "power-legacy-2012-5-travis-reed-emrakul-enchantress", file: "5-travis-reed-emrakul-enchantress.dck" },
  ],
};

/**
 * The 2013 Legacy power summer — `Legacy (M14)`, 2013-07-19 to 2013-09-27,
 * pinned to Standard 2013’s own dates. 66 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2013.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 12, B 10, R 10, G 9; aggro 6,
 * midrange 7, control 6, combo 5. Blue dominated this era’s candidate pool (29%
 * of its colour pips) and was given extra slots (12 of 24 chosen).
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
    { id: "power-legacy-2013-1-eric-rill-ur-delver", file: "1-eric-rill-ur-delver.dck" },
    { id: "power-legacy-2013-1-jonathan-suarez-painter", file: "1-jonathan-suarez-painter.dck" },
    { id: "power-legacy-2013-1-tobias-dreger-goblins", file: "1-tobias-dreger-goblins.dck" },
    { id: "power-legacy-2013-1-tony-chu-jund", file: "1-tony-chu-jund.dck" },
    { id: "power-legacy-2013-1-gerry-thompson-team-america", file: "1-gerry-thompson-team-america.dck" },
    { id: "power-legacy-2013-1-rune-j-rgensen-sneak-show", file: "1-rune-j-rgensen-sneak-show.dck" },
    { id: "power-legacy-2013-1-andreas-bendix-nielsen-storm", file: "1-andreas-bendix-nielsen-storm.dck" },
    { id: "power-legacy-2013-1-jack-wang-maverick", file: "1-jack-wang-maverick.dck" },
    { id: "power-legacy-2013-1-bryant-cook-tes", file: "1-bryant-cook-tes.dck" },
    { id: "power-legacy-2013-1-guillaume-perbet-junk", file: "1-guillaume-perbet-junk.dck" },
    { id: "power-legacy-2013-1-chris-andersen-tezzeret-control", file: "1-chris-andersen-tezzeret-control.dck" },
    { id: "power-legacy-2013-1-bryan-eleyet-hive-mind", file: "1-bryan-eleyet-hive-mind.dck" },
    { id: "power-legacy-2013-1-raphael-werder-uw-miracle", file: "1-raphael-werder-uw-miracle.dck" },
    { id: "power-legacy-2013-1-andreas-hartl-uwr-countertop", file: "1-andreas-hartl-uwr-countertop.dck" },
    { id: "power-legacy-2013-1-tokuyama-kouta-zoo", file: "1-tokuyama-kouta-zoo.dck" },
    { id: "power-legacy-2013-2-jonathan-kurpaska-death-taxes", file: "2-jonathan-kurpaska-death-taxes.dck" },
    { id: "power-legacy-2013-1-feline-longmore-high-tide", file: "1-feline-longmore-high-tide.dck" },
    { id: "power-legacy-2013-1-tony-murata-show-and-tell", file: "1-tony-murata-show-and-tell.dck" },
    { id: "power-legacy-2013-1-martin-pohlmeyer-mud", file: "1-martin-pohlmeyer-mud.dck" },
    { id: "power-legacy-2013-1-juan-miguel-carrascosa-nic-fit", file: "1-juan-miguel-carrascosa-nic-fit.dck" },
    { id: "power-legacy-2013-3-ben-perry-belcher", file: "3-ben-perry-belcher.dck" },
    { id: "power-legacy-2013-2-thomas-genzman-patriot", file: "2-thomas-genzman-patriot.dck" },
    { id: "power-legacy-2013-7-alex-waskelo-pikula", file: "7-alex-waskelo-pikula.dck" },
  ],
};

/**
 * The 2014 Legacy power summer — `Legacy (M15)`, 2014-07-18 to 2014-09-26,
 * pinned to Standard 2014’s own dates. 58 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2014.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 12, B 10, R 9, G 12; aggro 7,
 * midrange 7, control 5, combo 5.
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
    { id: "power-legacy-2014-1-tom-ross-berserk-poison", file: "1-tom-ross-berserk-poison.dck" },
    { id: "power-legacy-2014-1-andrea-bazzan-tes", file: "1-andrea-bazzan-tes.dck" },
    { id: "power-legacy-2014-1-yamamoto-kentarou-sneak-show", file: "1-yamamoto-kentarou-sneak-show.dck" },
    { id: "power-legacy-2014-1-dan-jordan-patriot-aggro", file: "1-dan-jordan-patriot-aggro.dck" },
    { id: "power-legacy-2014-1-bryan-cambidge-burn", file: "1-bryan-cambidge-burn.dck" },
    { id: "power-legacy-2014-1-kurt-speiss-lands-eternal-garden", file: "1-kurt-speiss-lands-eternal-garden.dck" },
    { id: "power-legacy-2014-1-reid-duke-bant", file: "1-reid-duke-bant.dck" },
    { id: "power-legacy-2014-1-greg-smith-imperial-painter", file: "1-greg-smith-imperial-painter.dck" },
    { id: "power-legacy-2014-1-phimus-pan-bug-midrange", file: "1-phimus-pan-bug-midrange.dck" },
    { id: "power-legacy-2014-1-kennen-haas-glam-loam", file: "1-kennen-haas-glam-loam.dck" },
    { id: "power-legacy-2014-1-kenji-mantani-stoneblade", file: "1-kenji-mantani-stoneblade.dck" },
    { id: "power-legacy-2014-1-farioli-giacomo-bug-control", file: "1-farioli-giacomo-bug-control.dck" },
    { id: "power-legacy-2014-1-tony-murata-titan-post", file: "1-tony-murata-titan-post.dck" },
    { id: "power-legacy-2014-1-misha-meihsl-the-rock-junk", file: "1-misha-meihsl-the-rock-junk.dck" },
    { id: "power-legacy-2014-2-dustin-shiles-jund", file: "2-dustin-shiles-jund.dck" },
    { id: "power-legacy-2014-1-romain-fenaux-briot-dredge", file: "1-romain-fenaux-briot-dredge.dck" },
    { id: "power-legacy-2014-1-sergi-juan-de-la-cruz-maverick", file: "1-sergi-juan-de-la-cruz-maverick.dck" },
    { id: "power-legacy-2014-1-ville-hallavo-belcher", file: "1-ville-hallavo-belcher.dck" },
    { id: "power-legacy-2014-1-robert-green-pikula", file: "1-robert-green-pikula.dck" },
    { id: "power-legacy-2014-1-simo-partinen-mud-post", file: "1-simo-partinen-mud-post.dck" },
    { id: "power-legacy-2014-1-claudio-bonanni-standstill-groovy", file: "1-claudio-bonanni-standstill-groovy.dck" },
  ],
};

/**
 * The 2015 Legacy power summer — `Legacy (ORI)`, 2015-07-17 to 2015-10-02,
 * pinned to Standard 2015’s own dates. 58 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2015.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 9, U 12, B 11, R 8, G 10; aggro 6,
 * midrange 6, control 7, combo 5. Blue dominated this era’s candidate pool (30%
 * of its colour pips) and was given extra slots (12 of 24 chosen).
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
    { id: "power-legacy-2015-1-josh-pelrine-omni-show", file: "1-josh-pelrine-omni-show.dck" },
    { id: "power-legacy-2015-1-alexander-lorenz-lands-eternal-garden", file: "1-alexander-lorenz-lands-eternal-garden.dck" },
    { id: "power-legacy-2015-1-kawakita-shirou-uw-miracles", file: "1-kawakita-shirou-uw-miracles.dck" },
    { id: "power-legacy-2015-1-kellen-pastore-death-taxes", file: "1-kellen-pastore-death-taxes.dck" },
    { id: "power-legacy-2015-1-bobby-colegrove-elves", file: "1-bobby-colegrove-elves.dck" },
    { id: "power-legacy-2015-1-tristan-polzl-shardless-bug", file: "1-tristan-polzl-shardless-bug.dck" },
    { id: "power-legacy-2015-1-jack-kitchen-painter", file: "1-jack-kitchen-painter.dck" },
    { id: "power-legacy-2015-1-logan-mize-ur-delver", file: "1-logan-mize-ur-delver.dck" },
    { id: "power-legacy-2015-1-joseph-moreno-dredge", file: "1-joseph-moreno-dredge.dck" },
    { id: "power-legacy-2015-1-evan-flynn-monastery", file: "1-evan-flynn-monastery.dck" },
    { id: "power-legacy-2015-1-miguel-alcoriza-uw-control", file: "1-miguel-alcoriza-uw-control.dck" },
    { id: "power-legacy-2015-2-shaheen-soorani-stoneblade", file: "2-shaheen-soorani-stoneblade.dck" },
    { id: "power-legacy-2015-1-jonathan-alexander-kurz-storm", file: "1-jonathan-alexander-kurz-storm.dck" },
    { id: "power-legacy-2015-1-kazuhiro-koge-maverick", file: "1-kazuhiro-koge-maverick.dck" },
    { id: "power-legacy-2015-1-matthew-vaughan-burn", file: "1-matthew-vaughan-burn.dck" },
    { id: "power-legacy-2015-1-bruno-valerio-jund", file: "1-bruno-valerio-jund.dck" },
    { id: "power-legacy-2015-1-dalibor-szegho-the-rock-junk", file: "1-dalibor-szegho-the-rock-junk.dck" },
    { id: "power-legacy-2015-1-aston-ramsden-goblins", file: "1-aston-ramsden-goblins.dck" },
    { id: "power-legacy-2015-1-pierre-melin-tes", file: "1-pierre-melin-tes.dck" },
    { id: "power-legacy-2015-1-teodor-suntburg-pox", file: "1-teodor-suntburg-pox.dck" },
    { id: "power-legacy-2015-1-borja-ceberio-bug-faeries", file: "1-borja-ceberio-bug-faeries.dck" },
    { id: "power-legacy-2015-2-irie-shun-reanimator", file: "2-irie-shun-reanimator.dck" },
    { id: "power-legacy-2015-2-simo-lagerspetz-loam", file: "2-simo-lagerspetz-loam.dck" },
    { id: "power-legacy-2015-5-curtis-wiemann-enchantress", file: "5-curtis-wiemann-enchantress.dck" },
  ],
};

/**
 * The 2016 Legacy power summer — `Legacy (EMN)`, 2016-07-22 to 2016-09-30,
 * pinned to Standard 2016’s own dates. 60 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2016.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 12, B 12, R 8, G 10; aggro 6,
 * midrange 8, control 5, combo 5.
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
    { id: "power-legacy-2016-1-brandon-osborne-storm", file: "1-brandon-osborne-storm.dck" },
    { id: "power-legacy-2016-1-tomas-mar-4c-good-stuff", file: "1-tomas-mar-4c-good-stuff.dck" },
    { id: "power-legacy-2016-1-noah-walker-grixis-delver", file: "1-noah-walker-grixis-delver.dck" },
    { id: "power-legacy-2016-1-anton-karlinski-eldrazi-aggro", file: "1-anton-karlinski-eldrazi-aggro.dck" },
    { id: "power-legacy-2016-1-jarrod-feight-death-taxes", file: "1-jarrod-feight-death-taxes.dck" },
    { id: "power-legacy-2016-1-niklas-kronberger-loam", file: "1-niklas-kronberger-loam.dck" },
    { id: "power-legacy-2016-1-isaac-castro-belcher", file: "1-isaac-castro-belcher.dck" },
    { id: "power-legacy-2016-1-nicola-guidi-nic-fit", file: "1-nicola-guidi-nic-fit.dck" },
    { id: "power-legacy-2016-1-jiaze-li-deathblade", file: "1-jiaze-li-deathblade.dck" },
    { id: "power-legacy-2016-1-ivan-espinosa-shardless-bug", file: "1-ivan-espinosa-shardless-bug.dck" },
    { id: "power-legacy-2016-1-jan-lenger-elves", file: "1-jan-lenger-elves.dck" },
    { id: "power-legacy-2016-1-hori-masataka-lands", file: "1-hori-masataka-lands.dck" },
    { id: "power-legacy-2016-1-damon-whitby-dredge", file: "1-damon-whitby-dredge.dck" },
    { id: "power-legacy-2016-1-tom-luckett-show-and-tell", file: "1-tom-luckett-show-and-tell.dck" },
    { id: "power-legacy-2016-1-matt-mccullough-aluren", file: "1-matt-mccullough-aluren.dck" },
    { id: "power-legacy-2016-1-demetrio-morselli-mud", file: "1-demetrio-morselli-mud.dck" },
    { id: "power-legacy-2016-2-chevallier-michel-reanimator", file: "2-chevallier-michel-reanimator.dck" },
    { id: "power-legacy-2016-1-andrea-ghesini-stoneblade", file: "1-andrea-ghesini-stoneblade.dck" },
    { id: "power-legacy-2016-1-robin-merckx-burn", file: "1-robin-merckx-burn.dck" },
    { id: "power-legacy-2016-1-jeremy-edwards-enchantress", file: "1-jeremy-edwards-enchantress.dck" },
    { id: "power-legacy-2016-1-anton-rantila-high-tide", file: "1-anton-rantila-high-tide.dck" },
    { id: "power-legacy-2016-1-joona-tiinus-grixis-control", file: "1-joona-tiinus-grixis-control.dck" },
    { id: "power-legacy-2016-2-fabian-gorzgen-maverick", file: "2-fabian-gorzgen-maverick.dck" },
    { id: "power-legacy-2016-2-niwa-hotaka-punishing-thing", file: "2-niwa-hotaka-punishing-thing.dck" },
  ],
};

/**
 * The 2017 Legacy power summer — `Legacy (HOU)`, 2017-07-14 to 2017-09-29,
 * pinned to Standard 2017’s own dates. 50 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2017.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 12, B 12, R 9, G 10; aggro 6,
 * midrange 8, control 6, combo 4.
 */
export const POWER_SUMMER_2017_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2017',
  directory: `${DECKS_ROOT}/legacy-2017`,
  event: "2017 Legacy power summer \u2014 Legacy (HOU), 2017-07-14 \u2192 2017-09-29",
  format: "Legacy (HOU)",
  date: "2017-07-14",
  source: 'docs/planning/deck-selection/review/legacy-2017.md',
  decks: [
    { id: "power-legacy-2017-1-kobayashi-tatsuumi-miracles", file: "1-kobayashi-tatsuumi-miracles.dck" },
    { id: "power-legacy-2017-1-eli-kasis-dark-depths", file: "1-eli-kasis-dark-depths.dck" },
    { id: "power-legacy-2017-1-dennis-zens-show-and-tell", file: "1-dennis-zens-show-and-tell.dck" },
    { id: "power-legacy-2017-1-michel-chevalier-reanimator", file: "1-michel-chevalier-reanimator.dck" },
    { id: "power-legacy-2017-1-alexander-barnett-aluren", file: "1-alexander-barnett-aluren.dck" },
    { id: "power-legacy-2017-1-julian23-elves", file: "1-julian23-elves.dck" },
    { id: "power-legacy-2017-1-tom-brown-4c-control", file: "1-tom-brown-4c-control.dck" },
    { id: "power-legacy-2017-1-robert-swiecki-storm", file: "1-robert-swiecki-storm.dck" },
    { id: "power-legacy-2017-1-alejandro-bustillo-stoneblade", file: "1-alejandro-bustillo-stoneblade.dck" },
    { id: "power-legacy-2017-1-sven-anders-karlsson-lands", file: "1-sven-anders-karlsson-lands.dck" },
    { id: "power-legacy-2017-1-nmks-eldrazi-aggro", file: "1-nmks-eldrazi-aggro.dck" },
    { id: "power-legacy-2017-1-chris-lates-death-and-taxes", file: "1-chris-lates-death-and-taxes.dck" },
    { id: "power-legacy-2017-1-sammy13-dragon-stompy", file: "1-sammy13-dragon-stompy.dck" },
    { id: "power-legacy-2017-1-butakov-loam", file: "1-butakov-loam.dck" },
    { id: "power-legacy-2017-1-yamashita-taiki-grixis-pyromancer", file: "1-yamashita-taiki-grixis-pyromancer.dck" },
    { id: "power-legacy-2017-1-andre-felipe-jund", file: "1-andre-felipe-jund.dck" },
    { id: "power-legacy-2017-1-zachary-koch-berserk-poison", file: "1-zachary-koch-berserk-poison.dck" },
    { id: "power-legacy-2017-1-callum-smith-merfolk", file: "1-callum-smith-merfolk.dck" },
    { id: "power-legacy-2017-1-tom-fischer-canadian-threshold", file: "1-tom-fischer-canadian-threshold.dck" },
    { id: "power-legacy-2017-1-nathan-sexton-four-color-leovold", file: "1-nathan-sexton-four-color-leovold.dck" },
    { id: "power-legacy-2017-1-jason-zudell-depths-combo", file: "1-jason-zudell-depths-combo.dck" },
    { id: "power-legacy-2017-1-zac-turgeon-all-in-red", file: "1-zac-turgeon-all-in-red.dck" },
    { id: "power-legacy-2017-1-peter-tragos-white-eldrazi", file: "1-peter-tragos-white-eldrazi.dck" },
    { id: "power-legacy-2017-1-joe-brennan-uwr-control", file: "1-joe-brennan-uwr-control.dck" },
  ],
};

/**
 * The 2018 Legacy power summer — `Legacy (M19)`, 2018-07-13 to 2018-10-05,
 * pinned to Standard 2018’s own dates. 43 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2018.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 7, U 11, B 11, R 8, G 7; aggro 6,
 * midrange 8, control 6, combo 4. Blue dominated this era’s candidate pool (33%
 * of its colour pips) and was given extra slots (11 of 24 chosen).
 */
export const POWER_SUMMER_2018_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2018',
  directory: `${DECKS_ROOT}/legacy-2018`,
  event: "2018 Legacy power summer \u2014 Legacy (M19), 2018-07-13 \u2192 2018-10-05",
  format: "Legacy (M19)",
  date: "2018-07-13",
  source: 'docs/planning/deck-selection/review/legacy-2018.md',
  decks: [
    { id: "power-legacy-2018-1-yohan-blanchard-miracles", file: "1-yohan-blanchard-miracles.dck" },
    { id: "power-legacy-2018-1-daniel-barkon-lands", file: "1-daniel-barkon-lands.dck" },
    { id: "power-legacy-2018-1-linus-valdemarsson-elves", file: "1-linus-valdemarsson-elves.dck" },
    { id: "power-legacy-2018-1-takahashi-masataka-storm", file: "1-takahashi-masataka-storm.dck" },
    { id: "power-legacy-2018-1-bryant-cook-tes", file: "1-bryant-cook-tes.dck" },
    { id: "power-legacy-2018-1-matthew-vook-four-color-loam", file: "1-matthew-vook-four-color-loam.dck" },
    { id: "power-legacy-2018-1-jonathan-job-death-taxes", file: "1-jonathan-job-death-taxes.dck" },
    { id: "power-legacy-2018-1-william-lo-dark-depths", file: "1-william-lo-dark-depths.dck" },
    { id: "power-legacy-2018-1-gary-campbell-dragon-stompy", file: "1-gary-campbell-dragon-stompy.dck" },
    { id: "power-legacy-2018-1-henrique-belumat-eldrazi", file: "1-henrique-belumat-eldrazi.dck" },
    { id: "power-legacy-2018-1-pedro-j-sanchez-uwx-control", file: "1-pedro-j-sanchez-uwx-control.dck" },
    { id: "power-legacy-2018-1-andrew-smelser-show-and-tell", file: "1-andrew-smelser-show-and-tell.dck" },
    { id: "power-legacy-2018-1-jacob-therrian-reanimator", file: "1-jacob-therrian-reanimator.dck" },
    { id: "power-legacy-2018-1-leastbean-canadian-threshold", file: "1-leastbean-canadian-threshold.dck" },
    { id: "power-legacy-2018-1-guilherme-figueira-goblins", file: "1-guilherme-figueira-goblins.dck" },
    { id: "power-legacy-2018-1-david-salus-steel-stompy", file: "1-david-salus-steel-stompy.dck" },
    { id: "power-legacy-2018-1-travis-parsley-pox", file: "1-travis-parsley-pox.dck" },
    { id: "power-legacy-2018-1-tony-murata-titan-post", file: "1-tony-murata-titan-post.dck" },
    { id: "power-legacy-2018-1-kjartan-uldahl-esper-control", file: "1-kjartan-uldahl-esper-control.dck" },
    { id: "power-legacy-2018-1-liu-zida-tezzeret-control", file: "1-liu-zida-tezzeret-control.dck" },
    { id: "power-legacy-2018-1-jeffrey-white-azorius-helm", file: "1-jeffrey-white-azorius-helm.dck" },
    { id: "power-legacy-2018-1-juan-amaral-dredge", file: "1-juan-amaral-dredge.dck" },
    { id: "power-legacy-2018-1-justin-luk-burn", file: "1-justin-luk-burn.dck" },
    { id: "power-legacy-2018-1-lukas-stahl-nic-fit", file: "1-lukas-stahl-nic-fit.dck" },
  ],
};

/**
 * The 2019 Legacy power summer — `Legacy (C19)`, 2019-08-30 to 2019-10-04,
 * pinned to Standard 2019’s own dates. 60 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2019.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 9, U 12, B 11, R 9, G 9; aggro 7,
 * midrange 8, control 5, combo 4.
 */
export const POWER_SUMMER_2019_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2019',
  directory: `${DECKS_ROOT}/legacy-2019`,
  event: "2019 Legacy power summer \u2014 Legacy (C19), 2019-08-30 \u2192 2019-10-04",
  format: "Legacy (C19)",
  date: "2019-08-30",
  source: 'docs/planning/deck-selection/review/legacy-2019.md',
  decks: [
    { id: "power-legacy-2019-1-aiden-brier-grixis-control", file: "1-aiden-brier-grixis-control.dck" },
    { id: "power-legacy-2019-1-cyrus-corman-gill-storm", file: "1-cyrus-corman-gill-storm.dck" },
    { id: "power-legacy-2019-1-jesse-inman-canadian-threshold", file: "1-jesse-inman-canadian-threshold.dck" },
    { id: "power-legacy-2019-1-joseph-horton-miracles", file: "1-joseph-horton-miracles.dck" },
    { id: "power-legacy-2019-1-koushou-tomoya-ur-delver", file: "1-koushou-tomoya-ur-delver.dck" },
    { id: "power-legacy-2019-1-brian-rogers-dark-depths", file: "1-brian-rogers-dark-depths.dck" },
    { id: "power-legacy-2019-1-tamir1313-stoneblade", file: "1-tamir1313-stoneblade.dck" },
    { id: "power-legacy-2019-1-justin-miller-show-and-tell", file: "1-justin-miller-show-and-tell.dck" },
    { id: "power-legacy-2019-1-teruya-kakumae-eldrazi-aggro", file: "1-teruya-kakumae-eldrazi-aggro.dck" },
    { id: "power-legacy-2019-1-ikeda-takahiro-dragon-stompy", file: "1-ikeda-takahiro-dragon-stompy.dck" },
    { id: "power-legacy-2019-1-christopher-minor-loam", file: "1-christopher-minor-loam.dck" },
    { id: "power-legacy-2019-1-liz-lynn-death-s-shadow", file: "1-liz-lynn-death-s-shadow.dck" },
    { id: "power-legacy-2019-1-iacopo-pineschi-lands", file: "1-iacopo-pineschi-lands.dck" },
    { id: "power-legacy-2019-1-mahfuzvangogh-dredge", file: "1-mahfuzvangogh-dredge.dck" },
    { id: "power-legacy-2019-1-xjcloud-bomberman", file: "1-xjcloud-bomberman.dck" },
    { id: "power-legacy-2019-1-shannon-peil-patriot-aggro", file: "1-shannon-peil-patriot-aggro.dck" },
    { id: "power-legacy-2019-1-yamanaka-kousuke-reanimator", file: "1-yamanaka-kousuke-reanimator.dck" },
    { id: "power-legacy-2019-1-mike-piscatelli-maverick", file: "1-mike-piscatelli-maverick.dck" },
    { id: "power-legacy-2019-1-brian-thomas-goblins", file: "1-brian-thomas-goblins.dck" },
    { id: "power-legacy-2019-1-bryant-cook-tes", file: "1-bryant-cook-tes.dck" },
    { id: "power-legacy-2019-1-danny-batterman-gw-depths", file: "1-danny-batterman-gw-depths.dck" },
    { id: "power-legacy-2019-1-meritt-elmasri-punishing-zoo", file: "1-meritt-elmasri-punishing-zoo.dck" },
    { id: "power-legacy-2019-1-tulio-souza-dead-daretti", file: "1-tulio-souza-dead-daretti.dck" },
    { id: "power-legacy-2019-1-sergey-loxmatii-lamzin-mono-green-post", file: "1-sergey-loxmatii-lamzin-mono-green-post.dck" },
  ],
};

/**
 * The 2020 Legacy power summer — `Legacy (JMP)`, 2020-08-03 to 2020-09-25,
 * pinned to Standard 2020’s own dates. 57 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2020.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 12, B 9, R 9, G 12; aggro 8,
 * midrange 6, control 5, combo 5. Blue dominated this era’s candidate pool (29%
 * of its colour pips) and was given extra slots (12 of 24 chosen).
 */
export const POWER_SUMMER_2020_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2020',
  directory: `${DECKS_ROOT}/legacy-2020`,
  event: "2020 Legacy power summer \u2014 Legacy (JMP), 2020-08-03 \u2192 2020-09-25",
  format: "Legacy (JMP)",
  date: "2020-08-03",
  source: 'docs/planning/deck-selection/review/legacy-2020.md',
  decks: [
    { id: "power-legacy-2020-1-nammersquats-hogaak", file: "1-nammersquats-hogaak.dck" },
    { id: "power-legacy-2020-1-giacomo-battaglia-lands", file: "1-giacomo-battaglia-lands.dck" },
    { id: "power-legacy-2020-1-bryant-cook-tes", file: "1-bryant-cook-tes.dck" },
    { id: "power-legacy-2020-1-manuel-danninger-canadian-threshold", file: "1-manuel-danninger-canadian-threshold.dck" },
    { id: "power-legacy-2020-1-hemsley-ur-delver", file: "1-hemsley-ur-delver.dck" },
    { id: "power-legacy-2020-1-daryl-ayers-death-taxes", file: "1-daryl-ayers-death-taxes.dck" },
    { id: "power-legacy-2020-1-jiho-4cc", file: "1-jiho-4cc.dck" },
    { id: "power-legacy-2020-1-marc-vogt-miracles", file: "1-marc-vogt-miracles.dck" },
    { id: "power-legacy-2020-1-marcelo-scatena-goblins", file: "1-marcelo-scatena-goblins.dck" },
    { id: "power-legacy-2020-1-lemasters-artifacts-blue", file: "1-lemasters-artifacts-blue.dck" },
    { id: "power-legacy-2020-1-komiyama-kenichirou-salvager-combo", file: "1-komiyama-kenichirou-salvager-combo.dck" },
    { id: "power-legacy-2020-1-sakuragi21722749-dark-depths", file: "1-sakuragi21722749-dark-depths.dck" },
    { id: "power-legacy-2020-1-takano-shigeki-elves", file: "1-takano-shigeki-elves.dck" },
    { id: "power-legacy-2020-1-andrew-fiedler-show-and-tell", file: "1-andrew-fiedler-show-and-tell.dck" },
    { id: "power-legacy-2020-1-nakamura-ryousuke-12-post", file: "1-nakamura-ryousuke-12-post.dck" },
    { id: "power-legacy-2020-1-wonderpreaux-reanimator", file: "1-wonderpreaux-reanimator.dck" },
    { id: "power-legacy-2020-1-mm-17-bant-control", file: "1-mm-17-bant-control.dck" },
    { id: "power-legacy-2020-1-taniguchi-hiroaki-aluren", file: "1-taniguchi-hiroaki-aluren.dck" },
    { id: "power-legacy-2020-1-allen-wu-uwx-control", file: "1-allen-wu-uwx-control.dck" },
    { id: "power-legacy-2020-1-luis-paiva-castaings-burn", file: "1-luis-paiva-castaings-burn.dck" },
    { id: "power-legacy-2020-1-chefen-painter", file: "1-chefen-painter.dck" },
    { id: "power-legacy-2020-1-tokuyama-kouta-zoo", file: "1-tokuyama-kouta-zoo.dck" },
    { id: "power-legacy-2020-1-alex-rouw-gw-maverick", file: "1-alex-rouw-gw-maverick.dck" },
    { id: "power-legacy-2020-1-diego-nunes-oko-foundry", file: "1-diego-nunes-oko-foundry.dck" },
  ],
};

/**
 * The 2021 Legacy power summer — `Legacy (AFR)`, 2021-07-23 to 2021-09-24,
 * pinned to Standard 2021’s own dates. 68 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2021.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 12, U 13, B 11, R 10, G 9; aggro 7,
 * midrange 6, control 6, combo 5. Blue dominated this era’s candidate pool (31%
 * of its colour pips) and was given extra slots (13 of 24 chosen).
 */
export const POWER_SUMMER_2021_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2021',
  directory: `${DECKS_ROOT}/legacy-2021`,
  event: "2021 Legacy power summer \u2014 Legacy (AFR), 2021-07-23 \u2192 2021-09-24",
  format: "Legacy (AFR)",
  date: "2021-07-23",
  source: 'docs/planning/deck-selection/review/legacy-2021.md',
  decks: [
    { id: "power-legacy-2021-1-julian23-patriot-aggro", file: "1-julian23-patriot-aggro.dck" },
    { id: "power-legacy-2021-1-paolo-busch-d-t-yorion", file: "1-paolo-busch-d-t-yorion.dck" },
    { id: "power-legacy-2021-1-takano-shigeki-ur-delver", file: "1-takano-shigeki-ur-delver.dck" },
    { id: "power-legacy-2021-1-shimada-hiroyuki-elves", file: "1-shimada-hiroyuki-elves.dck" },
    { id: "power-legacy-2021-1-stefano-sergi-reanimator", file: "1-stefano-sergi-reanimator.dck" },
    { id: "power-legacy-2021-1-jtl005-esper-vial", file: "1-jtl005-esper-vial.dck" },
    { id: "power-legacy-2021-1-anzid-4cc", file: "1-anzid-4cc.dck" },
    { id: "power-legacy-2021-1-albert-birckhead-hogaak", file: "1-albert-birckhead-hogaak.dck" },
    { id: "power-legacy-2021-1-jesse-james-adams-lands", file: "1-jesse-james-adams-lands.dck" },
    { id: "power-legacy-2021-1-inf-doomsday", file: "1-inf-doomsday.dck" },
    { id: "power-legacy-2021-1-mukai-takashi-sneak-show", file: "1-mukai-takashi-sneak-show.dck" },
    { id: "power-legacy-2021-1-bcs8995-stoneblade", file: "1-bcs8995-stoneblade.dck" },
    { id: "power-legacy-2021-1-tristanjwl-jeskai-ragavan", file: "1-tristanjwl-jeskai-ragavan.dck" },
    { id: "power-legacy-2021-1-tonyscapone-mono-red-storm", file: "1-tonyscapone-mono-red-storm.dck" },
    { id: "power-legacy-2021-1-giulio-gabellieri-selesnya-depths", file: "1-giulio-gabellieri-selesnya-depths.dck" },
    { id: "power-legacy-2021-1-callum-smith-imperial-painter", file: "1-callum-smith-imperial-painter.dck" },
    { id: "power-legacy-2021-1-mark-ehrhart-raga-jund", file: "1-mark-ehrhart-raga-jund.dck" },
    { id: "power-legacy-2021-1-tsuchiya-atsushi-jund-smog", file: "1-tsuchiya-atsushi-jund-smog.dck" },
    { id: "power-legacy-2021-1-wakayama-hayata-grixis-control-ragavan", file: "1-wakayama-hayata-grixis-control-ragavan.dck" },
    { id: "power-legacy-2021-1-yagi-hitoshi-dark-depths", file: "1-yagi-hitoshi-dark-depths.dck" },
    { id: "power-legacy-2021-1-kobayashi-tatsuumi-miracles", file: "1-kobayashi-tatsuumi-miracles.dck" },
    { id: "power-legacy-2021-1-rj-fischer-turbo-depths", file: "1-rj-fischer-turbo-depths.dck" },
    { id: "power-legacy-2021-1-katou-toshiya-breya-welder-control", file: "1-katou-toshiya-breya-welder-control.dck" },
    { id: "power-legacy-2021-1-zudin-rodion-pikula", file: "1-zudin-rodion-pikula.dck" },
  ],
};

/**
 * The 2022 Legacy power summer — `Legacy (SNC)`, 2022-04-29 to 2022-09-09,
 * pinned to Standard 2022’s own dates. 66 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2022.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 12, B 10, R 8, G 10; aggro 8,
 * midrange 6, control 5, combo 5.
 */
export const POWER_SUMMER_2022_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2022',
  directory: `${DECKS_ROOT}/legacy-2022`,
  event: "2022 Legacy power summer \u2014 Legacy (SNC), 2022-04-29 \u2192 2022-09-09",
  format: "Legacy (SNC)",
  date: "2022-04-29",
  source: 'docs/planning/deck-selection/review/legacy-2022.md',
  decks: [
    { id: "power-legacy-2022-1-theo-jung-ur-aggro", file: "1-theo-jung-ur-aggro.dck" },
    { id: "power-legacy-2022-1-cristobal-abril-death-taxes", file: "1-cristobal-abril-death-taxes.dck" },
    { id: "power-legacy-2022-1-zoe-uwx-control", file: "1-zoe-uwx-control.dck" },
    { id: "power-legacy-2022-1-ark4n-grixis-control", file: "1-ark4n-grixis-control.dck" },
    { id: "power-legacy-2022-1-javier-dominguez-cephalid-breakfast", file: "1-javier-dominguez-cephalid-breakfast.dck" },
    { id: "power-legacy-2022-1-william-asa-mono-r-prison", file: "1-william-asa-mono-r-prison.dck" },
    { id: "power-legacy-2022-1-nakamura-shuta-4c-leovold", file: "1-nakamura-shuta-4c-leovold.dck" },
    { id: "power-legacy-2022-1-takeuchi-daiki-elves", file: "1-takeuchi-daiki-elves.dck" },
    { id: "power-legacy-2022-1-kanbara-hokuto-reanimator", file: "1-kanbara-hokuto-reanimator.dck" },
    { id: "power-legacy-2022-1-danny-bambino-artifacts-blue", file: "1-danny-bambino-artifacts-blue.dck" },
    { id: "power-legacy-2022-1-gabriel-ebady-selesnya-depths", file: "1-gabriel-ebady-selesnya-depths.dck" },
    { id: "power-legacy-2022-1-bryant-cook-tes", file: "1-bryant-cook-tes.dck" },
    { id: "power-legacy-2022-1-kasagawa-yousuke-painter", file: "1-kasagawa-yousuke-painter.dck" },
    { id: "power-legacy-2022-1-william-jordan-dark-depths", file: "1-william-jordan-dark-depths.dck" },
    { id: "power-legacy-2022-1-takahashi-fumiya-sneak-show", file: "1-takahashi-fumiya-sneak-show.dck" },
    { id: "power-legacy-2022-1-kyle-lerch-patriot-aggro", file: "1-kyle-lerch-patriot-aggro.dck" },
    { id: "power-legacy-2022-1-danilo-kiyan-bg-depths", file: "1-danilo-kiyan-bg-depths.dck" },
    { id: "power-legacy-2022-1-matthew-harden-faeries", file: "1-matthew-harden-faeries.dck" },
    { id: "power-legacy-2022-1-fabrizio-bortoletto-oops-all-spells", file: "1-fabrizio-bortoletto-oops-all-spells.dck" },
    { id: "power-legacy-2022-1-matial-hirsila-grixis-day-s-undoing", file: "1-matial-hirsila-grixis-day-s-undoing.dck" },
    { id: "power-legacy-2022-1-ding-hui-eldrazi-post", file: "1-ding-hui-eldrazi-post.dck" },
    { id: "power-legacy-2022-1-naoya-koyano-titan-post", file: "1-naoya-koyano-titan-post.dck" },
    { id: "power-legacy-2022-1-saiki-takumi-eldrazi-aggro", file: "1-saiki-takumi-eldrazi-aggro.dck" },
    { id: "power-legacy-2022-1-daniel-martins-zoo", file: "1-daniel-martins-zoo.dck" },
  ],
};

/**
 * The 2023 Legacy power summer — `Legacy (MAT)`, 2023-05-29 to 2023-09-08,
 * pinned to Standard 2023’s own dates. 49 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2023.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 10, U 11, B 8, R 7, G 8; aggro 7,
 * midrange 8, control 5, combo 4. Blue dominated this era’s candidate pool (33%
 * of its colour pips) and was given extra slots (11 of 24 chosen).
 */
export const POWER_SUMMER_2023_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2023',
  directory: `${DECKS_ROOT}/legacy-2023`,
  event: "2023 Legacy power summer \u2014 Legacy (MAT), 2023-05-29 \u2192 2023-09-08",
  format: "Legacy (MAT)",
  date: "2023-05-29",
  source: 'docs/planning/deck-selection/review/legacy-2023.md',
  decks: [
    { id: "power-legacy-2023-1-john-ryan-hamilton-death-taxes", file: "1-john-ryan-hamilton-death-taxes.dck" },
    { id: "power-legacy-2023-1-luca-fasoli-doomsday", file: "1-luca-fasoli-doomsday.dck" },
    { id: "power-legacy-2023-1-rudabega-4cc", file: "1-rudabega-4cc.dck" },
    { id: "power-legacy-2023-1-tonyscapone-storm", file: "1-tonyscapone-storm.dck" },
    { id: "power-legacy-2023-1-nakamura-yuya-artifacts-blue", file: "1-nakamura-yuya-artifacts-blue.dck" },
    { id: "power-legacy-2023-1-krzysztof-mazurek-rug-delver", file: "1-krzysztof-mazurek-rug-delver.dck" },
    { id: "power-legacy-2023-1-hirota-takashi-canadian-midrange", file: "1-hirota-takashi-canadian-midrange.dck" },
    { id: "power-legacy-2023-1-katou-kazuma-reanimator", file: "1-katou-kazuma-reanimator.dck" },
    { id: "power-legacy-2023-1-utley26-painter", file: "1-utley26-painter.dck" },
    { id: "power-legacy-2023-1-ecobaronen-death-s-shadow", file: "1-ecobaronen-death-s-shadow.dck" },
    { id: "power-legacy-2023-1-hataue-tomoki-lands", file: "1-hataue-tomoki-lands.dck" },
    { id: "power-legacy-2023-1-angelo-cadei-uwx-control", file: "1-angelo-cadei-uwx-control.dck" },
    { id: "power-legacy-2023-1-danilo-kiyan-naya-depths", file: "1-danilo-kiyan-naya-depths.dck" },
    { id: "power-legacy-2023-1-romain-corgnolo-boros-initiative", file: "1-romain-corgnolo-boros-initiative.dck" },
    { id: "power-legacy-2023-1-rodrigo-sousa-maraja-miracles", file: "1-rodrigo-sousa-maraja-miracles.dck" },
    { id: "power-legacy-2023-1-aooaaooa-dark-depths", file: "1-aooaaooa-dark-depths.dck" },
    { id: "power-legacy-2023-1-giorgio-bresciani-maverick", file: "1-giorgio-bresciani-maverick.dck" },
    { id: "power-legacy-2023-1-andrei-prata-dark-maverick", file: "1-andrei-prata-dark-maverick.dck" },
    { id: "power-legacy-2023-1-chase-hoppe-elves", file: "1-chase-hoppe-elves.dck" },
    { id: "power-legacy-2023-1-crusherbotbg-hammer-time", file: "1-crusherbotbg-hammer-time.dck" },
    { id: "power-legacy-2023-1-andrea-boccia-grixis-control", file: "1-andrea-boccia-grixis-control.dck" },
    { id: "power-legacy-2023-1-jhon-o-keefe-mono-black-helm", file: "1-jhon-o-keefe-mono-black-helm.dck" },
    { id: "power-legacy-2023-1-susurrus-mtg-karn", file: "1-susurrus-mtg-karn.dck" },
    { id: "power-legacy-2023-1-ryan-hayes-bampo", file: "1-ryan-hayes-bampo.dck" },
  ],
};

/**
 * The 2024 Legacy power summer — `Legacy (OTJ)`, 2024-04-19 to 2024-08-02,
 * pinned to Standard 2024’s own dates. 48 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2024.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 8, U 11, B 9, R 7, G 9; aggro 7,
 * midrange 6, control 6, combo 5. Blue dominated this era’s candidate pool (34%
 * of its colour pips) and was given extra slots (11 of 24 chosen).
 */
export const POWER_SUMMER_2024_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2024',
  directory: `${DECKS_ROOT}/legacy-2024`,
  event: "2024 Legacy power summer \u2014 Legacy (OTJ), 2024-04-19 \u2192 2024-08-02",
  format: "Legacy (OTJ)",
  date: "2024-04-19",
  source: 'docs/planning/deck-selection/review/legacy-2024.md',
  decks: [
    { id: "power-legacy-2024-1-karatedom-ub-reanimator", file: "1-karatedom-ub-reanimator.dck" },
    { id: "power-legacy-2024-1-andrea-riva-canadian-druid", file: "1-andrea-riva-canadian-druid.dck" },
    { id: "power-legacy-2024-1-marco-montani-grixis-delver", file: "1-marco-montani-grixis-delver.dck" },
    { id: "power-legacy-2024-1-yanagi-toya-dark-depths", file: "1-yanagi-toya-dark-depths.dck" },
    { id: "power-legacy-2024-1-jumba-dragon-stompy", file: "1-jumba-dragon-stompy.dck" },
    { id: "power-legacy-2024-1-orlando-d-angelo-death-taxes", file: "1-orlando-d-angelo-death-taxes.dck" },
    { id: "power-legacy-2024-1-davi-erik-pereira-4-5c-control", file: "1-davi-erik-pereira-4-5c-control.dck" },
    { id: "power-legacy-2024-1-mike-lee-cephalid-breakfast", file: "1-mike-lee-cephalid-breakfast.dck" },
    { id: "power-legacy-2024-1-flossed-mono-black-scam", file: "1-flossed-mono-black-scam.dck" },
    { id: "power-legacy-2024-1-paulo-joustra-initiative-stompy", file: "1-paulo-joustra-initiative-stompy.dck" },
    { id: "power-legacy-2024-1-achillies27-maverick", file: "1-achillies27-maverick.dck" },
    { id: "power-legacy-2024-1-eureka22422-saga-storm", file: "1-eureka22422-saga-storm.dck" },
    { id: "power-legacy-2024-1-shiwasu-omni-show", file: "1-shiwasu-omni-show.dck" },
    { id: "power-legacy-2024-1-hammafist-esper-control", file: "1-hammafist-esper-control.dck" },
    { id: "power-legacy-2024-1-marcelo-burbulhan-sultai-beans", file: "1-marcelo-burbulhan-sultai-beans.dck" },
    { id: "power-legacy-2024-2-francesco-messina-lands", file: "2-francesco-messina-lands.dck" },
    { id: "power-legacy-2024-2-murata-naoyoshi-doomsday", file: "2-murata-naoyoshi-doomsday.dck" },
    { id: "power-legacy-2024-1-f2104-mississippi-river", file: "1-f2104-mississippi-river.dck" },
    { id: "power-legacy-2024-1-bresciani-giorgio-5c-control", file: "1-bresciani-giorgio-5c-control.dck" },
    { id: "power-legacy-2024-3-nakamura-ryotaro-painter", file: "3-nakamura-ryotaro-painter.dck" },
    { id: "power-legacy-2024-2-oppa-cradle-control", file: "2-oppa-cradle-control.dck" },
    { id: "power-legacy-2024-2-nakajima-takuhito-cloudpost-ramp", file: "2-nakajima-takuhito-cloudpost-ramp.dck" },
    { id: "power-legacy-2024-2-adachi-ryousuke-pox", file: "2-adachi-ryousuke-pox.dck" },
    { id: "power-legacy-2024-2-zoilo-marallag-rakdos-painter", file: "2-zoilo-marallag-rakdos-painter.dck" },
  ],
};

/**
 * The 2025 Legacy power summer — `Legacy (FIN)`, 2025-06-30 to 2025-08-01,
 * pinned to Standard 2025’s own dates. 62 legal, distinct candidate decks
 * (`docs/planning/deck-selection/review/legacy-2025.md` has the full table and
 * the ones dropped as illegal or near-duplicate); 24 chosen. One per archetype,
 * searched for colour and style spread: W 7, U 10, B 9, R 6, G 8; aggro 7,
 * midrange 6, control 6, combo 5. Blue dominated this era’s candidate pool (29%
 * of its colour pips) and was given extra slots (10 of 24 chosen).
 */
export const POWER_SUMMER_2025_LEGACY: LibraryCollection = {
  family: 'legacy',
  id: 'power-summer-legacy-2025',
  directory: `${DECKS_ROOT}/legacy-2025`,
  event: "2025 Legacy power summer \u2014 Legacy (FIN), 2025-06-30 \u2192 2025-08-01",
  format: "Legacy (FIN)",
  date: "2025-06-30",
  source: 'docs/planning/deck-selection/review/legacy-2025.md',
  decks: [
    { id: "power-legacy-2025-1-skpchino-ub-reanimator", file: "1-skpchino-ub-reanimator.dck" },
    { id: "power-legacy-2025-1-ivan-ibanez-lands", file: "1-ivan-ibanez-lands.dck" },
    { id: "power-legacy-2025-1-nathanlipetz-dimir-tempo", file: "1-nathanlipetz-dimir-tempo.dck" },
    { id: "power-legacy-2025-1-xanazero-painter", file: "1-xanazero-painter.dck" },
    { id: "power-legacy-2025-1-hiromi-kameshima-mystic-forge", file: "1-hiromi-kameshima-mystic-forge.dck" },
    { id: "power-legacy-2025-1-xerk-cephalid-breakfast", file: "1-xerk-cephalid-breakfast.dck" },
    { id: "power-legacy-2025-1-delightedhalfling-cradle-control", file: "1-delightedhalfling-cradle-control.dck" },
    { id: "power-legacy-2025-1-jonata-molteni-dark-maverick", file: "1-jonata-molteni-dark-maverick.dck" },
    { id: "power-legacy-2025-1-giorgio-bresciani-nadu-value", file: "1-giorgio-bresciani-nadu-value.dck" },
    { id: "power-legacy-2025-1-punishingwaterfalls-dragon-stompy", file: "1-punishingwaterfalls-dragon-stompy.dck" },
    { id: "power-legacy-2025-1-franmtg-eldrazi-aggro", file: "1-franmtg-eldrazi-aggro.dck" },
    { id: "power-legacy-2025-1-jibeta-jeskai-control", file: "1-jibeta-jeskai-control.dck" },
    { id: "power-legacy-2025-1-fredmcfred-4-5c-control", file: "1-fredmcfred-4-5c-control.dck" },
    { id: "power-legacy-2025-1-gabriel-braga-omnitell", file: "1-gabriel-braga-omnitell.dck" },
    { id: "power-legacy-2025-1-sebastien-fayand-death-and-taxes", file: "1-sebastien-fayand-death-and-taxes.dck" },
    { id: "power-legacy-2025-1-mahfuzvangogh-dredge", file: "1-mahfuzvangogh-dredge.dck" },
    { id: "power-legacy-2025-1-jaime-vazquez-villares-elves", file: "1-jaime-vazquez-villares-elves.dck" },
    { id: "power-legacy-2025-1-adam-gerwatowski-cradle-nadu", file: "1-adam-gerwatowski-cradle-nadu.dck" },
    { id: "power-legacy-2025-1-magic-dads71522-reanimator", file: "1-magic-dads71522-reanimator.dck" },
    { id: "power-legacy-2025-1-screenwriterny-uwx-control", file: "1-screenwriterny-uwx-control.dck" },
    { id: "power-legacy-2025-1-wonderpreaux-turbo-necro", file: "1-wonderpreaux-turbo-necro.dck" },
    { id: "power-legacy-2025-1-tamas-kukucska-artifacts-prison", file: "1-tamas-kukucska-artifacts-prison.dck" },
    { id: "power-legacy-2025-1-florent-jugnet-rakdos-discard", file: "1-florent-jugnet-rakdos-discard.dck" },
    { id: "power-legacy-2025-1-cole-harnish-boros-energy", file: "1-cole-harnish-boros-energy.dck" },
  ],
};


/** Every collection in the library, oldest era first. */
export const LIBRARY: readonly LibraryCollection[] = [
  POWER_SUMMER_1995_STANDARD,
  POWER_SUMMER_1996_STANDARD,
  POWER_SUMMER_1997_STANDARD,
  POWER_SUMMER_1998_STANDARD,
  POWER_SUMMER_1999_STANDARD,
  POWER_SUMMER_2000_STANDARD,
  POWER_SUMMER_2001_STANDARD,
  POWER_SUMMER_2002_STANDARD,
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
  POWER_SUMMER_2017_STANDARD,
  POWER_SUMMER_2018_STANDARD,
  POWER_SUMMER_2019_STANDARD,
  POWER_SUMMER_2020_STANDARD,
  POWER_SUMMER_2021_STANDARD,
  POWER_SUMMER_2022_STANDARD,
  POWER_SUMMER_2023_STANDARD,
  POWER_SUMMER_2024_STANDARD,
  POWER_SUMMER_2025_STANDARD,
  POWER_SUMMER_2011_MODERN,
  POWER_SUMMER_2012_MODERN,
  POWER_SUMMER_2013_MODERN,
  POWER_SUMMER_2014_MODERN,
  POWER_SUMMER_2015_MODERN,
  POWER_SUMMER_2016_MODERN,
  POWER_SUMMER_2017_MODERN,
  POWER_SUMMER_2018_MODERN,
  POWER_SUMMER_2019_MODERN,
  POWER_SUMMER_2020_MODERN,
  POWER_SUMMER_2021_MODERN,
  POWER_SUMMER_2022_MODERN,
  POWER_SUMMER_2023_MODERN,
  POWER_SUMMER_2024_MODERN,
  POWER_SUMMER_2025_MODERN,
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
  POWER_SUMMER_2017_LEGACY,
  POWER_SUMMER_2018_LEGACY,
  POWER_SUMMER_2019_LEGACY,
  POWER_SUMMER_2020_LEGACY,
  POWER_SUMMER_2021_LEGACY,
  POWER_SUMMER_2022_LEGACY,
  POWER_SUMMER_2023_LEGACY,
  POWER_SUMMER_2024_LEGACY,
  POWER_SUMMER_2025_LEGACY,
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
