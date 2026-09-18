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
  /** Where the collection as a whole came from. */
  readonly source: string;
  readonly decks: readonly LibraryEntry[];
}

/** The repo-root-relative directory the library lives in. */
export const DECKS_ROOT = 'decks';

/**
 * Pro Tour Paris 2011, the Standard portion — the complete Top 8.
 *
 * Chosen because it is a **complete, closed set** rather than a hand-picked
 * eight: "the Top 8 of one event" has an unambiguous membership test, so nobody
 * has to wonder which decks were left out or why. It is also the format this
 * repo's own tooling can say the most about — the snapshot in force is
 * `Standard (MBS)`, effective 2011-02-04, and the very next rotation row
 * (2011-07-01) bans two cards that four of these eight decks play, which makes
 * the library its own regression test for the ban path.
 *
 * Four of the eight are the same archetype. That is not sampling laziness; it
 * is what that Top 8 was. Caw-Blade broke out at this tournament.
 */
export const PT_PARIS_2011_STANDARD: LibraryCollection = {
  id: 'pt-paris-2011-standard',
  directory: `${DECKS_ROOT}/standard-2011-02-13-pt-paris`,
  event: 'Pro Tour Paris 2011, Standard portion, Top 8',
  format: 'Standard (MBS)',
  date: '2011-02-13',
  source: 'https://www.mtgtop8.com/event?e=1016&f=ST',
  decks: [
    { id: 'pt-paris-2011-1-ben-stark', file: '1-ben-stark-mystic-caw-go.dck' },
    { id: 'pt-paris-2011-2-paul-rietzl', file: '2-paul-rietzl-boros-landfall.dck' },
    { id: 'pt-paris-2011-3-vincent-lemoine', file: '3-vincent-lemoine-boros-landfall.dck' },
    { id: 'pt-paris-2011-4-naoki-nakada', file: '4-naoki-nakada-mystic-caw-go.dck' },
    { id: 'pt-paris-2011-5-nico-bohny', file: '5-nico-bohny-fauna-quest.dck' },
    { id: 'pt-paris-2011-6-tom-martell', file: '6-tom-martell-mystic-caw-go.dck' },
    { id: 'pt-paris-2011-7-shintaro-ishimura', file: '7-shintaro-ishimura-mystic-caw-go.dck' },
    { id: 'pt-paris-2011-8-patrick-chapin', file: '8-patrick-chapin-tezzeret-control.dck' },
  ],
};


/**
 * Pro Tour Dark Ascension 2012, the Standard portion — the complete Top 8.
 *
 * The second collection, and chosen for a reason the first cannot serve: the
 * operator's first real test is **playing a Standard game against someone**, in
 * the window between New Phyrexia and Return to Ravnica. Paris 2011 is a
 * different format (Scars/Zendikar, pre-New Phyrexia) and four of its eight
 * decks are illegal after the 2011-07-01 bans, which makes it a fine ban-path
 * regression test and a poor thing to actually play.
 *
 * The snapshot in force is `Standard (DKA)` — **SOM, MBS, NPH, M12, ISD, DKA,
 * no bans** — which is the Innistrad-era format at its most recognisable:
 * Kessig Wolf Run ramp, three flavours of Delver, and Birthing Pod.
 *
 * Five archetypes across eight decks, so two people can pick genuinely
 * different decks. As with Paris, this is a complete Top 8 rather than a
 * hand-picked eight: membership has an unambiguous test.
 *
 * Every card was resolved against the real corpus restricted to those six sets
 * before the files were written — **zero cards failed**, which is why the set
 * code on every line is derived rather than guessed.
 */
export const PT_DARK_ASCENSION_2012_STANDARD: LibraryCollection = {
  id: 'pt-dark-ascension-2012-standard',
  directory: `${DECKS_ROOT}/standard-2012-02-12-pt-dark-ascension`,
  event: 'Pro Tour Dark Ascension 2012, Standard portion, Top 8',
  format: 'Standard (DKA)',
  date: '2012-02-12',
  source: 'https://www.mtgtop8.com/event?e=2518&f=ST',
  decks: [
    { id: 'pt-dka-2012-1-brian-kibler', file: '1-brian-kibler-kessig-titan.dck' },
    { id: 'pt-dka-2012-2-paulo-vitor-damo-da-rosa', file: '2-paulo-vitor-damo-da-rosa-kessig-titan.dck' },
    { id: 'pt-dka-2012-3-mamoru-nagai', file: '3-mamoru-nagai-black-kessig.dck' },
    { id: 'pt-dka-2012-4-jon-finkel', file: '4-jon-finkel-uwb-delver.dck' },
    { id: 'pt-dka-2012-5-lukas-blohon', file: '5-lukas-blohon-naya-pod.dck' },
    { id: 'pt-dka-2012-6-matthew-costa', file: '6-matthew-costa-uw-delver.dck' },
    { id: 'pt-dka-2012-7-denniz-rachid', file: '7-denniz-rachid-uw-human-delver.dck' },
    { id: 'pt-dka-2012-8-jelger-wiegersma', file: '8-jelger-wiegersma-uwb-delver.dck' },
  ],
};


/**
 * Worlds 2011, San Francisco, the Standard portion — the complete Top 8.
 *
 * The Innistrad-era format (`Standard (ISD)`: SOM, MBS, NPH, M12, ISD), which
 * is the window between the New Phyrexia bans and Dark Ascension. Added for the
 * operator's request for roughly five decks per era across the New
 * Phyrexia-to-Return to Ravnica span.
 *
 * ## Two things about this Top 8 that are real, and are not transcription slips
 *
 * **Four of the eight are byte-identical.** Woods, Damo da Rosa, Scott-Vargas
 * and Utter-Leyton all played the same 75-card Tempered Steel list. That is the
 * Channel Fireball team deck, and the duplication is the historical fact rather
 * than a copy-paste: the files are kept separate because the collection is "the
 * Top 8", whose membership test is unambiguous, and dropping three would make a
 * reader wonder what was cut.
 *
 * **There is no black deck.** Basics across all eight are Plains, Island,
 * Mountain and Forest — no Swamp anywhere. Black is represented in the library
 * by the Dark Ascension collection (Nagai's Black Kessig, and two UWb Delver
 * lists), but *this era* has no black entry, and an era-level colour sweep
 * should expect that rather than treat it as missing data.
 *
 * Every card was resolved against the real corpus restricted to the five legal
 * sets before the files were written; zero failed.
 */
export const WORLDS_2011_STANDARD: LibraryCollection = {
  id: 'worlds-2011-standard',
  directory: `${DECKS_ROOT}/standard-2011-11-20-worlds`,
  event: 'Worlds 2011 (San Francisco), Standard portion, Top 8',
  format: 'Standard (ISD)',
  date: '2011-11-20',
  source: 'https://www.mtgtop8.com/event?e=2245&f=ST',
  decks: [
    { id: 'worlds-2011-1-junya-iyanaga', file: '1-junya-iyanaga-kessig-titan.dck' },
    { id: 'worlds-2011-2-richard-bland', file: '2-richard-bland-gw-aggro.dck' },
    { id: 'worlds-2011-3-david-caplan', file: '3-david-caplan-red-deck-wins.dck' },
    { id: 'worlds-2011-4-conley-woods', file: '4-conley-woods-tempered-steel.dck' },
    { id: 'worlds-2011-5-craig-wescoe', file: '5-craig-wescoe-saint-ww-with-leaks.dck' },
    { id: 'worlds-2011-6-paulo-vitor-damo-da-rosa', file: '6-paulo-vitor-damo-da-rosa-tempered-steel.dck' },
    { id: 'worlds-2011-7-luis-scott-vargas', file: '7-luis-scott-vargas-tempered-steel.dck' },
    { id: 'worlds-2011-8-josh-utter-leyton', file: '8-josh-utter-leyton-tempered-steel.dck' },
  ],
};


/**
 * Grand Prix Hiroshima 2011 — one deck, and the only collection here that is
 * NOT a complete Top 8.
 *
 * ## Why one deck, and what its membership rule is
 *
 * The other collections are "the Top 8 of one event", whose membership has an
 * unambiguous test. This one's rule is different and is stated so it is equally
 * unambiguous: **the black deck the ISD era was otherwise missing.**
 *
 * Worlds 2011's Top 8 — the era's other collection — plays no Swamp at all
 * across eight decks. That is a true fact about that tournament rather than a
 * gap in transcription, but it left the library unable to offer a black deck in
 * `Standard (ISD)`. Asahara's Solar Flare, 3rd-4th at GP Hiroshima three weeks
 * earlier and in the same format, fills it: three Swamps, Liliana of the Veil,
 * Doom Blade and Unburial Rites.
 *
 * It is WUB rather than two colours. Searched for a strictly two-colour or
 * mono-black deck in the era and did not find one at a comparable finish —
 * ISD-era Standard's black deck *was* Solar Flare. Recorded rather than left
 * implied, so nobody re-runs that search.
 *
 * ## The maindeck is 61 cards, and that is correct
 *
 * Asahara registered 61. It is legal (60 is a minimum, not a target) and it is
 * what mtgtop8 holds. A validator that rounds it to 60 is wrong, not the deck.
 *
 * ## Its pool file duplicates Worlds 2011's
 *
 * Both dates resolve to the same snapshot — `Standard (ISD)`, effective
 * 2011-09-30 — so `standard-2011-10-30` and `standard-2011-11-20` have
 * identical card lists. Kept separate because a collection is validated against
 * its own date, and giving this one Worlds' date to save a file would put an
 * October event under a November heading.
 */
export const GP_HIROSHIMA_2011_STANDARD: LibraryCollection = {
  id: 'gp-hiroshima-2011-standard',
  directory: `${DECKS_ROOT}/standard-2011-10-30-gp-hiroshima`,
  event: "Grand Prix Hiroshima 2011, Standard — the era's black deck",
  format: 'Standard (ISD)',
  date: '2011-10-30',
  source: 'https://www.mtgtop8.com/event?e=2171&f=ST',
  decks: [{ id: 'gp-hiroshima-2011-3-akira-asahara', file: '3-akira-asahara-solar-flare.dck' }],
};

/** Every collection in the library, oldest format first. */
export const LIBRARY: readonly LibraryCollection[] = [
  PT_PARIS_2011_STANDARD,
  GP_HIROSHIMA_2011_STANDARD,
  WORLDS_2011_STANDARD,
  PT_DARK_ASCENSION_2012_STANDARD,
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
 * regenerating it twice would be two chances to disagree.
 */
export function poolFixturePath(date: string): string {
  return `${DECKS_ROOT}/pools/standard-${date}.generated.json`;
}
