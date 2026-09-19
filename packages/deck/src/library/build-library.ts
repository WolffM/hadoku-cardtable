/*
 * Transcribes library collections from mtgtop8's own exports into the `.dck`
 * files under `decks/`.
 *
 * Run from the repo root, once, when the library changes:
 *
 *   node packages/deck/src/library/build-library.ts                 # every collection below
 *   node packages/deck/src/library/build-library.ts --only=<id>     # one collection, by catalog id
 *
 * It covers the collections listed in `SOURCES`, which is every collection
 * transcribed by this script: PT Paris 2011 and the four SCG Open collections
 * added for the NPH, M12, AVR and M13 eras. Worlds 2011, GP Hiroshima 2011 and
 * PT Dark Ascension 2012 were transcribed by hand from the same source before
 * this script took a list, and are not re-derived here.
 *
 * It needs the network; nothing else in this lane does, and CI never runs it.
 * The committed `.dck` files are the artefact.
 *
 * ## Why a script and not hand-typed files
 *
 * Because a hand-typed decklist is a decklist nobody can check. This script
 * fetches mtgtop8's machine-readable export for each deck id, so the
 * transcription step is a parse rather than a person, and re-running it against
 * the same ids reproduces the same bytes. The `Source URL` written into every
 * file is the exact page the list came off.
 *
 * ## Why it writes through `writeDck`
 *
 * So the committed files are, by construction, in the exact form
 * `loadPrebuiltDeck` → `writePrebuiltDeck` puts back out. `library.test.ts`
 * asserts that round trip byte-for-byte on every file; had the files been
 * written by string concatenation, that assertion would have been testing this
 * script's formatting rather than the writer.
 *
 * ## What it does NOT do
 *
 * It does not check legality. `validate-library.ts` does that, against the real
 * corpus, and keeping them apart is deliberate: a fetch that silently dropped a
 * card should fail a validation run, not be patched up by the fetcher.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeckEntry, DeckFile } from '@hadoku/carddata/dck';

import { writeDck, type DckSpelling } from '../dck-write.ts';
import {
  PT_PARIS_2011_STANDARD,
  SCG_INDIANAPOLIS_2012_STANDARD,
  SCG_KANSAS_CITY_2012_STANDARD,
  SCG_ORLANDO_2011_STANDARD,
  SCG_RICHMOND_2011_STANDARD,
  deckPath,
  type LibraryCollection,
} from './catalog.ts';
import { LIBRARY_PROVENANCE_KEY, LIBRARY_SOURCE_KEY } from './library.ts';
import { PREBUILT_DATE_KEY, PREBUILT_FORMAT_KEY } from '../prebuilt.ts';

/** `packages/deck/src/library` → the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * `Format` and `Effective` are ours, so `dck-write.ts`'s `FORGE_METADATA_KEYS`
 * has no canonical casing for them and a bare `writeDck` would emit `format=`
 * and `effective=`. `writePrebuiltDeck` restores the casing on the way back out
 * of an already-loaded deck; this is the same map on the way in, so the files
 * this script writes are already in the form the round trip produces.
 *
 * `Source URL`, `Comment`, `Name` and `Deck Type` need no entry — they are
 * Forge's own keys and the writer canonicalises them itself.
 */
const LIBRARY_SPELLING: DckSpelling = {
  metadataKeys: new Map([
    [PREBUILT_FORMAT_KEY.toLowerCase(), PREBUILT_FORMAT_KEY],
    [PREBUILT_DATE_KEY.toLowerCase(), PREBUILT_DATE_KEY],
  ]),
  sectionNames: new Map(),
};

/**
 * One deck as mtgtop8 files it. `deckId` is the `d=` parameter on the event
 * page; `placing` and `player` are read off that page's Top 8 table.
 */
interface SourceDeck {
  readonly file: string;
  readonly deckId: number;
  readonly player: string;
  readonly placing: string;
  readonly archetype: string;
}

/** A catalog collection and the mtgtop8 event its decks came off. */
interface SourceCollection {
  readonly collection: LibraryCollection;
  readonly eventId: number;
  readonly decks: readonly SourceDeck[];
}

/**
 * Pro Tour Paris 2011's Top 8, in finishing order, as
 * https://www.mtgtop8.com/event?e=1016&f=ST lists them. Placings are joint from
 * third down, which is how a single-elimination Top 8 is reported and how the
 * source reports it.
 */
const PT_PARIS_2011_TOP_8: readonly SourceDeck[] = [
  { file: '1-ben-stark-mystic-caw-go.dck', deckId: 209238, player: 'Ben Stark', placing: '1st', archetype: 'Mystic Caw Go' },
  { file: '2-paul-rietzl-boros-landfall.dck', deckId: 209239, player: 'Paul Rietzl', placing: '2nd', archetype: 'Boros Landfall' },
  { file: '3-vincent-lemoine-boros-landfall.dck', deckId: 209236, player: 'Vincent Lemoine', placing: '3rd-4th', archetype: 'Boros Landfall' },
  { file: '4-naoki-nakada-mystic-caw-go.dck', deckId: 209242, player: 'Naoki Nakada', placing: '3rd-4th', archetype: 'Mystic Caw Go' },
  { file: '5-nico-bohny-fauna-quest.dck', deckId: 209237, player: 'Nico Bohny', placing: '5th-8th', archetype: 'Fauna Quest' },
  { file: '6-tom-martell-mystic-caw-go.dck', deckId: 209241, player: 'Tom Martell', placing: '5th-8th', archetype: 'Mystic Caw Go' },
  { file: '7-shintaro-ishimura-mystic-caw-go.dck', deckId: 209243, player: 'Shintaro Ishimura', placing: '5th-8th', archetype: 'Mystic Caw Go' },
  { file: '8-patrick-chapin-tezzeret-control.dck', deckId: 209240, player: 'Patrick Chapin', placing: '5th-8th', archetype: 'Tezzeret Control' },
];

/*
 * The four era collections. Each is the Top 8 of one StarCityGames Open, cut
 * to the best-placed deck of each archetype as mtgtop8 names it (see
 * `catalog.ts` for why). Placings, players and archetype labels are copied off
 * the event page; the archetype label is mtgtop8's own, verbatim.
 */

/** SCG Open Orlando, 2011-05-14 — https://www.mtgtop8.com/event?e=1571&f=ST */
const SCG_ORLANDO_2011: readonly SourceDeck[] = [
  { file: '1-edgar-flores-caw-blade.dck', deckId: 212091, player: 'Edgar Flores', placing: '1st', archetype: 'Caw-Blade' },
  { file: '2-michael-strunk-grixis-twin-exarch.dck', deckId: 212092, player: 'Michael Strunk', placing: '2nd', archetype: 'Grixis Twin Exarch' },
  { file: '3-tim-landale-rug-twin-exarch.dck', deckId: 212093, player: 'Tim Landale', placing: '3rd', archetype: 'RUG Twin Exarch' },
  { file: '4-kitt-holland-kozilek-caw-blade.dck', deckId: 212094, player: 'Kitt Holland', placing: '4th', archetype: 'Kozilek Caw-Blade' },
  { file: '7-aadil-qadir-br-vampires.dck', deckId: 212097, player: 'Aadil Qadir', placing: '7th', archetype: 'Br Vampires' },
  { file: '8-miguel-rondon-valakut-ramp.dck', deckId: 212098, player: 'Miguel Rondon', placing: '8th', archetype: 'Valakut Ramp' },
];

/** SCG Open Richmond, 2011-08-14 — https://www.mtgtop8.com/event?e=1910&f=ST */
const SCG_RICHMOND_2011: readonly SourceDeck[] = [
  { file: '1-pat-cox-valakut-ramp.dck', deckId: 213773, player: 'Pat Cox', placing: '1st', archetype: 'Valakut Ramp' },
  { file: '2-kyle-rose-caw-blade.dck', deckId: 213774, player: 'Kyle Rose', placing: '2nd', archetype: 'Caw-Blade' },
  { file: '3-shaheen-soorani-ub-control.dck', deckId: 213775, player: 'Shaheen Soorani', placing: '3rd-4th', archetype: 'UB Control' },
  { file: '5-thomas-cole-boros-landfall.dck', deckId: 213779, player: 'Thomas Cole', placing: '5th-8th', archetype: 'Boros Landfall' },
  { file: '5-robbie-auchter-red-deck-wins.dck', deckId: 213777, player: 'Robbie Auchter', placing: '5th-8th', archetype: 'Red Deck Wins' },
  { file: '5-ian-shore-rug-pod.dck', deckId: 213780, player: 'Ian Shore', placing: '5th-8th', archetype: 'RUG Pod' },
];

/** SCG Open Indianapolis, 2012-06-16 — https://www.mtgtop8.com/event?e=2767&f=ST */
const SCG_INDIANAPOLIS_2012: readonly SourceDeck[] = [
  { file: '1-ross-merriam-uw-delver.dck', deckId: 217906, player: 'Ross Merriam', placing: '1st', archetype: 'UW Delver' },
  { file: '2-michael-marlow-bu-zombies.dck', deckId: 217907, player: 'Michael Marlow', placing: '2nd', archetype: 'BU Zombies' },
  { file: '3-dan-musser-rug-pod.dck', deckId: 217910, player: 'Dan Musser', placing: '3rd-4th', archetype: 'RUG Pod' },
  { file: '5-logan-mize-kessig-titan.dck', deckId: 217912, player: 'Logan Mize', placing: '5th-8th', archetype: 'Kessig Titan' },
  { file: '5-robbie-cordell-solar-flare.dck', deckId: 217909, player: 'Robbie Cordell', placing: '5th-8th', archetype: 'Solar Flare' },
  { file: '5-ian-farnung-tezzeret-control.dck', deckId: 217913, player: 'Ian Farnung', placing: '5th-8th', archetype: 'Tezzeret Control' },
];

/** SCG Open Kansas City, 2012-08-11 — https://www.mtgtop8.com/event?e=2814&f=ST */
const SCG_KANSAS_CITY_2012: readonly SourceDeck[] = [
  { file: '1-mike-prokop-uw-delver.dck', deckId: 218164, player: 'Mike Prokop', placing: '1st', archetype: 'UW Delver' },
  { file: '2-nick-marriott-mono-green-infect.dck', deckId: 218165, player: 'Nick Marriott', placing: '2nd', archetype: 'Mono Green Infect' },
  { file: '3-robert-berni-blue-kessig.dck', deckId: 218167, player: 'Robert Berni', placing: '3rd-4th', archetype: 'Blue Kessig' },
  { file: '3-eric-holmes-naya-pod.dck', deckId: 218166, player: 'Eric Holmes', placing: '3rd-4th', archetype: 'Naya Pod' },
  { file: '5-scott-ouderkirk-gr-aggro.dck', deckId: 218169, player: 'Scott Ouderkirk', placing: '5th-8th', archetype: 'Gr Aggro' },
  { file: '5-matthew-dennis-zombie-pod.dck', deckId: 218171, player: 'Matthew Dennis', placing: '5th-8th', archetype: 'Zombie Pod' },
];

const SOURCES: readonly SourceCollection[] = [
  { collection: PT_PARIS_2011_STANDARD, eventId: 1016, decks: PT_PARIS_2011_TOP_8 },
  { collection: SCG_ORLANDO_2011_STANDARD, eventId: 1571, decks: SCG_ORLANDO_2011 },
  { collection: SCG_RICHMOND_2011_STANDARD, eventId: 1910, decks: SCG_RICHMOND_2011 },
  { collection: SCG_INDIANAPOLIS_2012_STANDARD, eventId: 2767, decks: SCG_INDIANAPOLIS_2012 },
  { collection: SCG_KANSAS_CITY_2012_STANDARD, eventId: 2814, decks: SCG_KANSAS_CITY_2012 },
];

/** mtgtop8's plain-text export for one deck. `f=` is only a filename hint. */
function exportUrl(deckId: number): string {
  return `https://www.mtgtop8.com/dec?d=${deckId}&f=ST`;
}

/** The page a human should open to check the list. */
function deckPageUrl(eventId: number, deckId: number): string {
  return `https://www.mtgtop8.com/event?e=${eventId}&d=${deckId}&f=ST`;
}

/**
 * One line of an mtgtop8 `.dec` export: `4 [M11] Squadron Hawk`, with sideboard
 * lines prefixed `SB:`. Comments start `//`.
 */
const DEC_LINE = /^(\d+)\s+\[([A-Za-z0-9]+)\]\s+(\S.*)$/;

interface DecList {
  readonly main: DeckEntry[];
  readonly sideboard: DeckEntry[];
}

function parseDecExport(text: string, what: string): DecList {
  const main: DeckEntry[] = [];
  const sideboard: DeckEntry[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) continue;

    const isSideboard = trimmed.startsWith('SB:');
    const body = isSideboard ? trimmed.slice(3).trim() : trimmed;
    const matched = DEC_LINE.exec(body);
    if (matched === null) {
      throw new Error(`${what}: cannot parse export line ${JSON.stringify(raw)}`);
    }
    const [, count, set, name] = matched;
    const entry: DeckEntry = {
      count: Number(count),
      card: {
        name: name.trim(),
        set: set.toUpperCase(),
        collectorNumber: null,
        artIndex: 1,
        foil: false,
        backFace: false,
        flags: null,
      },
    };
    (isSideboard ? sideboard : main).push(entry);
  }

  if (main.length === 0) throw new Error(`${what}: export has no maindeck`);
  return { main, sideboard };
}

function totalCount(entries: readonly DeckEntry[]): number {
  return entries.reduce((sum, e) => sum + e.count, 0);
}

function buildDeckFile(
  collection: LibraryCollection,
  source: SourceDeck,
  eventId: number,
  list: DecList,
): DeckFile {
  const name = `${source.archetype} (${source.player})`;
  // Insertion order is the written order, so this is the header layout:
  // what the deck is, then what it is legal in, then where it came from.
  const metadata = new Map<string, string>([
    ['name', name],
    ['deck type', 'Constructed'],
    [PREBUILT_FORMAT_KEY.toLowerCase(), collection.format],
    [PREBUILT_DATE_KEY.toLowerCase(), collection.date],
    [LIBRARY_SOURCE_KEY.toLowerCase(), deckPageUrl(eventId, source.deckId)],
    [
      LIBRARY_PROVENANCE_KEY.toLowerCase(),
      `${collection.event}: ${source.player}, ${source.placing}, ${source.archetype}. Transcribed from mtgtop8 deck ${source.deckId}.`,
    ],
  ]);

  const sections = new Map<string, readonly DeckEntry[]>([['main', list.main]]);
  if (list.sideboard.length > 0) sections.set('sideboard', list.sideboard);

  return { name, metadata, sections };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'hadoku-cardtable/0.1 (deck library build)' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  return await response.text();
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) if (a.startsWith(prefix)) return a.slice(prefix.length);
  return null;
}

async function main(): Promise<void> {
  const only = arg('only');
  const chosen = SOURCES.filter((s) => only === null || s.collection.id === only);
  if (chosen.length === 0) throw new Error(`--only=${String(only)} names no collection this script transcribes`);

  for (const { collection, eventId, decks } of chosen) {
    const outDir = join(REPO_ROOT, collection.directory);
    mkdirSync(outDir, { recursive: true });
    console.log(`== ${collection.id}`);

    for (const source of decks) {
      const what = `${source.player} (mtgtop8 ${String(source.deckId)})`;
      const list = parseDecExport(await fetchText(exportUrl(source.deckId)), what);
      const file = buildDeckFile(collection, source, eventId, list);
      const entry = collection.decks.find((d) => d.file === source.file);
      if (entry === undefined) throw new Error(`${what}: ${source.file} is not in the catalog`);

      const target = join(REPO_ROOT, deckPath(collection, entry));
      writeFileSync(target, writeDck(file, { spelling: LIBRARY_SPELLING }), 'utf8');
      console.log(
        `${source.file}: main ${String(totalCount(list.main))}, sideboard ${String(totalCount(list.sideboard))}`,
      );
    }
  }
}

await main();
