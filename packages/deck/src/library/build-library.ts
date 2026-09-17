/*
 * Transcribes the Pro Tour Paris 2011 Top 8 from mtgtop8's own exports into the
 * `.dck` files under `decks/`.
 *
 * Run from the repo root, once, when the library changes:
 *
 *   node packages/deck/src/library/build-library.ts
 *
 * It needs the network; nothing else in this lane does, and CI never runs it.
 * The committed `.dck` files are the artefact.
 *
 * ## Why a script and not eight hand-typed files
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
import { PT_PARIS_2011_STANDARD, deckPath, type LibraryCollection } from './catalog.ts';
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

async function main(): Promise<void> {
  const collection = PT_PARIS_2011_STANDARD;
  const eventId = 1016;
  const outDir = join(REPO_ROOT, collection.directory);
  mkdirSync(outDir, { recursive: true });

  for (const source of PT_PARIS_2011_TOP_8) {
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

await main();
