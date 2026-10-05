/*
 * Transcribes the deck library from mtgtop8's own exports into the `.dck`
 * files under `decks/`.
 *
 * Run from the repo root, once, when the library changes:
 *
 *   node packages/deck/src/library/build-library.ts                 # every era
 *   node packages/deck/src/library/build-library.ts --only=2011     # one era
 *
 * ## What it reads
 *
 * The nine power-summer eras this wave replaced the old library with
 * (`docs/planning/deck-selection/eras.json`) and, for each, the `chosen` list
 * `tools/select_decks.py` wrote (`docs/planning/deck-selection/selections/
 * selection-<year>.json` — deck id, event id, archetype, player, event name
 * and finish for each of the 96 decks the selection chose; `review/README.md`
 * has the rules it chose them by). Nothing here re-selects: this script is a
 * parse from the selection's own numbers to committed files, same as the
 * collections it replaces were a parse from a hand-picked Top 8 to committed
 * files.
 *
 * ## Why a script and not hand-typed files
 *
 * Because a hand-typed decklist is a decklist nobody can check. This script
 * fetches mtgtop8's machine-readable export for each deck id, so the
 * transcription step is a parse rather than a person, and re-running it
 * against the same ids reproduces the same bytes. The `Source URL` written
 * into every file is the exact page the list came off.
 *
 * ## The cache
 *
 * mtgtop8 is one fetch per deck and this library is 96 decks, so a re-run
 * reads a local cache first (`--cache=<dir>`, default `/tmp/deck-export-cache`)
 * and only reaches the network for an id it has not seen, writing what it
 * fetches back into the cache for next time. Polite either way: one request
 * every 500ms when the network is actually used. Nothing else in this lane
 * needs the network, and CI never runs this script.
 *
 * ## What it does NOT do
 *
 * It does not check legality. `validate-library.ts` does that, against the
 * real corpus, and keeping them apart is deliberate: a fetch that silently
 * dropped a card should fail a validation run, not be patched up by the
 * fetcher. It also does not choose which decks go in the library — that is
 * `tools/select_decks.py`'s job, and this script is downstream of its output.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeckEntry, DeckFile } from '@hadoku/carddata/dck';

import { writeDck, type DckSpelling } from '../dck-write.ts';
import { PREBUILT_DATE_KEY, PREBUILT_FORMAT_KEY } from '../prebuilt.ts';
import { LIBRARY, slugifyForLibrary, type FormatFamily, type LibraryCollection } from './catalog.ts';
import { LIBRARY_PROVENANCE_KEY, LIBRARY_SOURCE_KEY } from './library.ts';

/** `packages/deck/src/library` → the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SELECTIONS_DIR = join(REPO_ROOT, 'docs', 'planning', 'deck-selection', 'selections');
const DEFAULT_CACHE = '/tmp/deck-export-cache';

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
 * mtgtop8 set codes this library's 1151 distinct (card, set) pairs have needed
 * to correct, found by checking every one against Forge's own card database at
 * the pinned jar (not against the corpus — see below for why that is not the
 * same question).
 *
 * **Blanket fixups**, applied regardless of card name. mtgtop8 spells most
 * sets the three letters Scryfall and Forge both use — 39 of the 40 distinct
 * codes this library's decks use agreed outright. The one that did not:
 * Coldsnap. mtgtop8 exports it `[CS]`; the real corpus's own `set` field for
 * every Coldsnap printing is `csp`, and every other code already agrees with
 * that corpus, so `CS` is normalised to match it. (Forge itself is actually
 * lenient here — `CardEdition`'s `Code2=CS` for Coldsnap means Forge's own
 * `getCard(name, "CS")` already resolves correctly, checked directly against
 * the pinned jar. The fixup is for consistency with the corpus and with the
 * other 39 codes, not because Forge would otherwise fail.)
 */
const SET_CODE_FIXUPS: ReadonlyMap<string, string> = new Map([['CS', 'CSP']]);

/**
 * **Per-card fixups** — mtgtop8 labels a reprint under the main set's code
 * when the card was actually only reprinted on that set's "timeshifted" bonus
 * sheet, which Forge (and Scryfall) catalogue as a SEPARATE edition. Found the
 * same way as the blanket fixups: checking every (card, set) pair this library
 * uses against Forge's own card database — `CardDb.getCardFromSet` returns
 * null for exactly these six under `TSP`, because Forge has no Time Spiral
 * printing of them at all, only a Time Spiral TIMESHIFTED (`TSB`) one. mtgtop8
 * exports all six as `[TSP] <name>` regardless; the corpus confirms `tsb` is
 * each one's only printing inside the 2008 era's legal sets.
 *
 * Keyed by `"Name|WRONG_SET"` so a fix never touches a different card that
 * happens to share a set code with one of these.
 */
const CARD_SET_FIXUPS: ReadonlyMap<string, string> = new Map([
  ['Avalanche Riders|TSP', 'TSB'],
  ['Disintegrate|TSP', 'TSB'],
  ['Lord of Atlantis|TSP', 'TSB'],
  ['Pendelhaven|TSP', 'TSB'],
  ['Shadow Guildmage|TSP', 'TSB'],
  ['Wall of Roots|TSP', 'TSB'],
]);

/** One deck the selection chose, as `selection-<year>.json` records it. */
interface ChosenDeck {
  readonly deck: number;
  readonly event: number;
  readonly archetype: string;
  readonly player: string;
  readonly event_name: string;
  readonly rank: string;
}

interface SelectionFile {
  readonly era: { readonly year: number; readonly format: string; readonly start: string };
  readonly chosen: readonly ChosenDeck[];
}

/** `'1'` → `'1st'`, `'3-4'` → `'3rd-4th'`, `'5-8'` → `'5th-8th'`. Ranks never exceed 8 in this selection. */
function ordinal(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return `${String(n)}st`;
  if (n % 10 === 2 && n % 100 !== 12) return `${String(n)}nd`;
  if (n % 10 === 3 && n % 100 !== 13) return `${String(n)}rd`;
  return `${String(n)}th`;
}

function placingOf(rank: string): string {
  return rank
    .split('-')
    .map((part) => ordinal(Number(part)))
    .join('-');
}

/** The leading number of a (possibly joint) rank — `'5-8'` → `5`. Used as the filename's sort prefix. */
function rankNumber(rank: string): number {
  return Number(rank.split('-')[0]);
}

/** mtgtop8's plain-text export for one deck. `f=` is only a filename hint. */
function exportUrl(deckId: number): string {
  return `https://www.mtgtop8.com/dec?d=${String(deckId)}&f=ST`;
}

/** The page a human should open to check the list. */
function deckPageUrl(eventId: number, deckId: number): string {
  return `https://www.mtgtop8.com/event?e=${String(eventId)}&d=${String(deckId)}&f=ST`;
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
    const [, count, rawSet, rawName] = matched;
    const name = (rawName as string).trim();
    const upperSet = (rawSet as string).toUpperCase();
    const blanketFixed = SET_CODE_FIXUPS.get(upperSet) ?? upperSet;
    const set = CARD_SET_FIXUPS.get(`${name}|${upperSet}`) ?? blanketFixed;
    const entry: DeckEntry = {
      count: Number(count),
      card: {
        name,
        set,
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

/** What `buildDeckFile` needs off a collection — satisfied by a catalogued
 * `LibraryCollection` or by a bare `{format, date}` for an era not yet
 * catalogued (`--family` + `--only` on a format `T` has not integrated yet). */
interface FormatAndDate {
  readonly format: string;
  readonly date: string;
}

function buildDeckFile(
  collection: FormatAndDate,
  source: ChosenDeck,
  list: DecList,
): DeckFile {
  const name = `${source.archetype} (${source.player})`;
  const placing = placingOf(source.rank);
  // Insertion order is the written order, so this is the header layout:
  // what the deck is, then what it is legal in, then where it came from.
  const metadata = new Map<string, string>([
    ['name', name],
    ['deck type', 'Constructed'],
    [PREBUILT_FORMAT_KEY.toLowerCase(), collection.format],
    [PREBUILT_DATE_KEY.toLowerCase(), collection.date],
    [LIBRARY_SOURCE_KEY.toLowerCase(), deckPageUrl(source.event, source.deck)],
    [
      LIBRARY_PROVENANCE_KEY.toLowerCase(),
      `${source.event_name}: ${source.player}, ${placing}, ${source.archetype}. Transcribed from mtgtop8 deck ${String(source.deck)}.`,
    ],
  ]);

  const sections = new Map<string, readonly DeckEntry[]>([['main', list.main]]);
  if (list.sideboard.length > 0) sections.set('sideboard', list.sideboard);

  return { name, metadata, sections };
}

/** The file this deck is written to, repo-root-relative-within-its-collection. */
export function fileNameFor(source: ChosenDeck): string {
  return `${String(rankNumber(source.rank))}-${slugifyForLibrary(source.player)}-${slugifyForLibrary(source.archetype)}.dck`;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'hadoku-cardtable/0.1 (deck library build)' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  return await response.text();
}

/** Delay between network fetches, so a cold cache is still polite. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cachedExport(deckId: number, cacheDir: string): Promise<string> {
  const cachePath = join(cacheDir, `${String(deckId)}.dec`);
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');

  const text = await fetchText(exportUrl(deckId));
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, text, 'utf8');
  await sleep(500);
  return text;
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) if (a.startsWith(prefix)) return a.slice(prefix.length);
  return null;
}

/** A collection's year, off its own `Effective` date — `'2008-07-25'` → `2008`. No separate field to drift from it. */
function yearOf(collection: LibraryCollection): string {
  return collection.date.slice(0, 4);
}

/** The selection file `select_decks.py`/`report.py` write for a family and year — `tools/eras.py`'s naming helpers, mirrored. */
function selectionFileName(family: FormatFamily, year: string): string {
  return family === 'standard' ? `selection-${year}.json` : `selection-${family}-${year}.json`;
}

/** One (family, year) era to transcribe, whether or not it is in `catalog.ts` yet. */
interface Job {
  readonly label: string;
  readonly directory: string;
  readonly format: string;
  readonly date: string;
  readonly chosen: readonly ChosenDeck[];
  /** The catalogued collection, so file names can be checked for drift — `null` for an era `--family` is transcribing ahead of T's integration step (wave 48 §T step 4). */
  readonly catalogued: LibraryCollection | null;
}

/**
 * `--family=standard` (the default) loops every catalogued Standard era,
 * exactly as this script always has — `--only` is unchanged, byte for byte
 * the same selection and output paths as before `--family` existed.
 *
 * `--family=modern` or `--family=legacy` transcribes era(s) NOT YET in
 * `catalog.ts` — lanes M and L run this, against their own
 * `selections/selection-<family>-<year>.json` and `decks/<family>-<year>/`,
 * before T's integration step adds them to `LIBRARY`. `--only` is then
 * required (there is no `LIBRARY` entry to discover years from) and may be a
 * comma list: `--family=modern --only=2012,2013`.
 */
function buildJobs(family: FormatFamily, only: string | null): Job[] {
  if (family === 'standard') {
    const wanted = only === null ? null : only.split(',');
    const collections = LIBRARY.filter(
      (c) => c.family === 'standard' && (wanted === null || wanted.includes(yearOf(c))),
    );
    if (collections.length === 0) {
      throw new Error(`--only=${String(only)} names no Standard era this script transcribes`);
    }
    return collections.map((c) => {
      const selectionPath = join(SELECTIONS_DIR, selectionFileName('standard', yearOf(c)));
      const selection = JSON.parse(readFileSync(selectionPath, 'utf8')) as SelectionFile;
      return {
        label: c.id,
        directory: c.directory,
        format: c.format,
        date: c.date,
        chosen: selection.chosen,
        catalogued: c,
      };
    });
  }

  if (only === null) {
    throw new Error(`--family=${family} needs --only=<year[,year...]> — it is not catalogued yet, so there is no LIBRARY to discover years from`);
  }
  return only.split(',').map((year) => {
    const catalogued = LIBRARY.find((c) => c.family === family && yearOf(c) === year) ?? null;
    const selectionPath = join(SELECTIONS_DIR, selectionFileName(family, year));
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8')) as SelectionFile;
    return {
      label: catalogued?.id ?? `${family}-${year}`,
      directory: catalogued?.directory ?? `${family}-${year}`,
      format: catalogued?.format ?? selection.era.format,
      date: catalogued?.date ?? selection.era.start,
      chosen: selection.chosen,
      catalogued,
    };
  });
}

async function main(): Promise<void> {
  const family = (arg('family') ?? 'standard') as FormatFamily;
  const only = arg('only');
  const cacheDir = arg('cache') ?? DEFAULT_CACHE;
  const jobs = buildJobs(family, only);

  for (const job of jobs) {
    const outDir = join(REPO_ROOT, job.directory);
    mkdirSync(outDir, { recursive: true });
    console.log(
      `== ${job.label} (${String(job.chosen.length)} decks)${job.catalogued === null ? ' [not in catalog.ts yet]' : ''}`,
    );

    for (const source of job.chosen) {
      const what = `${source.player} (mtgtop8 ${String(source.deck)})`;
      const text = await cachedExport(source.deck, cacheDir);
      const list = parseDecExport(text, what);
      const file = buildDeckFile({ format: job.format, date: job.date }, source, list);
      const fileName = fileNameFor(source);
      if (job.catalogued !== null) {
        const entry = job.catalogued.decks.find((d) => d.file === fileName);
        if (entry === undefined) {
          throw new Error(`${what}: ${fileName} is not in catalog.ts's ${job.catalogued.id} — catalog.ts and the selection have drifted`);
        }
      }

      const target = join(REPO_ROOT, job.directory, fileName);
      writeFileSync(target, writeDck(file, { spelling: LIBRARY_SPELLING }), 'utf8');
      console.log(
        `  ${fileName}: main ${String(totalCount(list.main))}, sideboard ${String(totalCount(list.sideboard))}`,
      );
    }
  }
}

await main();
