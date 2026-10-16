/*
 * Transcribes the deck library from mtgtop8's own exports into the `.dck`
 * files under `decks/`.
 *
 * Run from the repo root, once, when the library changes:
 *
 *   node packages/deck/src/library/build-library.ts                 # every era
 *   node packages/deck/src/library/build-library.ts --only=2011     # one era
 *
 * `--forge-res=<dir>` names Forge's res tree (default `forge/forge-gui/res`
 * here); it reads the edition files that place timeshifted reprints.
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
 * reads a local cache first (`--cache=<dir>`, default
 * `~/.cache/cardtable-deck-selection/deck-cache`, the one `tools/lists.py` fills)
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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeckEntry, DeckFile } from '@hadoku/carddata/dck';

import { writeDck, type DckSpelling } from '../dck-write.ts';
import { PREBUILT_DATE_KEY, PREBUILT_FORMAT_KEY } from '../prebuilt.ts';
import { DECKS_ROOT, LIBRARY, slugifyForLibrary, type FormatFamily, type LibraryCollection } from './catalog.ts';

/** mtgtop8's own format codes, verified directly against the site (wave 48 §T handshake). */
const MTGTOP8_FORMAT_CODE: Readonly<Record<FormatFamily, string>> = {
  standard: 'ST',
  modern: 'MO',
  legacy: 'LE',
};
import { LIBRARY_ARCHETYPE_KEY, LIBRARY_PILOT_KEY, LIBRARY_PROVENANCE_KEY, LIBRARY_SOURCE_KEY } from './library.ts';

/** `packages/deck/src/library` → the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SELECTIONS_DIR = join(REPO_ROOT, 'docs', 'planning', 'deck-selection', 'selections');
/** On disk, not tmpfs, and shared with `tools/lists.py`: the selection has already fetched every deck this writes. */
const DEFAULT_CACHE = join(homedir(), '.cache', 'cardtable-deck-selection', 'deck-cache');

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
    [LIBRARY_ARCHETYPE_KEY.toLowerCase(), LIBRARY_ARCHETYPE_KEY],
    [LIBRARY_PILOT_KEY.toLowerCase(), LIBRARY_PILOT_KEY],
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
 * **Timeshifted reprints** — mtgtop8 labels a reprint under the main set's code
 * when the card was only reprinted on that set's "timeshifted" bonus sheet,
 * which Forge (and Scryfall) catalogue as a SEPARATE edition:
 * `CardDb.getCardFromSet` returns null for `Akroma, Angel of Wrath|TSP`,
 * because Forge has no Time Spiral printing of it, only a Time Spiral
 * Timeshifted (`TSB`) one. Found by `library-resolve.jvm.test.ts`.
 *
 * This was a hand-kept list of twenty cards until 2026-10-10, when doubling the
 * library found fourteen more. It is derived from Forge's own edition files
 * now: a card exported as `TSP` that Forge prints in `TSB` and not in `TSP` is
 * the `TSB` printing.
 */
function timeshiftedOnly(printings: EditionPrintings): ReadonlySet<string> {
  const main = printings.get('TSP') ?? new Set<string>();
  return new Set([...(printings.get('TSB') ?? [])].filter((n) => !main.has(n)));
}

/** Forge set code → the card names its edition file prints. */
type EditionPrintings = ReadonlyMap<string, ReadonlySet<string>>;

function editionPrintings(forgeRes: string): EditionPrintings {
  const out = new Map<string, Set<string>>();
  const dir = join(forgeRes, 'editions');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.txt')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const code = /^Code=(\S+)$/m.exec(text)?.[1]?.toUpperCase();
    if (code === undefined) continue;
    // mtgtop8 spells pre-2003 sets with Forge's two-letter `Code2` (`4E`, `IA`).
    const code2 = /^Code2=(\S+)$/m.exec(text)?.[1]?.toUpperCase();
    const names = new Set<string>();
    for (const line of text.slice(text.indexOf('[cards]')).split(/\r?\n/)) {
      const matched = /^\S+\s+\S+\s+(.+?)(?:\s+@.*)?$/.exec(line.trim());
      if (matched !== null && line.trim() !== '[cards]') names.add(matched[1] as string);
    }
    out.set(code, names);
    if (code2 !== undefined && !out.has(code2)) out.set(code2, names);
  }
  return out;
}

/**
 * **A blank or unknown set** — mtgtop8 writes `4 [] Force of Will` when its own
 * record of the printing is missing, and `[PR]` for a code no Forge edition
 * carries (both in one 1996 Nationals list). The name is a real card and the
 * deck was legal in its era, so the card was printed in one of the era's
 * sets: the newest of them that Forge's edition files print it in is the
 * printing. A name no era set prints stays an error, like `[] Unknown Card`.
 */
function eraPrinting(name: string, eraSets: readonly string[], printings: EditionPrintings): string | null {
  for (const code of [...eraSets].reverse()) if (printings.get(code)?.has(name) === true) return code;
  return null;
}

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
  readonly era: { readonly year: number; readonly format: string; readonly start: string; readonly sets: string };
  readonly chosen: readonly ChosenDeck[];
}

/** `'1'` → `'1st'`, `'3-4'` → `'3rd-4th'`, `'5-8'` → `'5th-8th'`. */
function ordinal(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return `${String(n)}st`;
  if (n % 10 === 2 && n % 100 !== 12) return `${String(n)}nd`;
  if (n % 10 === 3 && n % 100 !== 13) return `${String(n)}rd`;
  return `${String(n)}th`;
}

/** A finish mtgtop8 gives as a placing (`1`, `3-4`); older events also give words (`Day 1 undefeated`) or nothing. */
const PLACING = /^\d+(?:-\d+)?$/;

function placingOf(rank: string): string {
  if (!PLACING.test(rank)) return rank === '' ? 'unranked' : rank;
  return rank
    .split('-')
    .map((part) => ordinal(Number(part)))
    .join('-');
}

/** The filename's sort prefix: a placing's leading number (`'5-8'` → `5`), else the finish's own words, slugged. */
function rankPrefix(rank: string): string {
  if (PLACING.test(rank)) return String(Number(rank.split('-')[0]));
  return slugifyForLibrary(rank) || 'unranked';
}

/** mtgtop8's plain-text export for one deck. `f=` is only a filename hint, but it must still name the real format — a Modern/Legacy deck fetched under `f=ST` still returns the right cards, but writes a wrong Source URL into the `.dck`. */
function exportUrl(deckId: number, fmtCode: string): string {
  return `https://www.mtgtop8.com/dec?d=${String(deckId)}&f=${fmtCode}`;
}

/** The page a human should open to check the list. */
function deckPageUrl(eventId: number, deckId: number, fmtCode: string): string {
  return `https://www.mtgtop8.com/event?e=${String(eventId)}&d=${String(deckId)}&f=${fmtCode}`;
}

/**
 * One line of an mtgtop8 `.dec` export: `4 [M11] Squadron Hawk`, with sideboard
 * lines prefixed `SB:`. Comments start `//`.
 */
const DEC_LINE = /^(\d+)\s+\[([A-Za-z0-9]*)\]\s+(\S.*)$/;

interface DecList {
  readonly main: DeckEntry[];
  readonly sideboard: DeckEntry[];
}

interface ExportContext {
  readonly timeshifted: ReadonlySet<string>;
  readonly printings: EditionPrintings;
  /** The era's legal sets, Forge codes, oldest first. */
  readonly eraSets: readonly string[];
}

function parseDecExport(text: string, what: string, ctx: ExportContext): DecList {
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
    // mtgtop8 spells a split card `Fire / Ice`; Forge and Scryfall spell it `Fire // Ice`.
    const name = (rawName as string).trim().replace(' / ', ' // ');
    const upperSet = (rawSet as string).toUpperCase();
    const blanketFixed = SET_CODE_FIXUPS.get(upperSet) ?? upperSet;
    const set =
      upperSet === '' || !ctx.printings.has(blanketFixed)
        ? eraPrinting(name, ctx.eraSets, ctx.printings)
        : upperSet === 'TSP' && ctx.timeshifted.has(name)
          ? 'TSB'
          : blanketFixed;
    if (set === null) throw new Error(`${what}: ${JSON.stringify(raw)} names no set, and no set of the era prints ${name}`);
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
  fmtCode: string,
): DeckFile {
  const name = `${source.archetype} (${source.player})`;
  const placing = placingOf(source.rank);
  // Insertion order is the written order, so this is the header layout:
  // what the deck is, then what it is legal in, then where it came from.
  const metadata = new Map<string, string>([
    ['name', name],
    [LIBRARY_ARCHETYPE_KEY.toLowerCase(), source.archetype],
    [LIBRARY_PILOT_KEY.toLowerCase(), source.player],
    ['deck type', 'Constructed'],
    [PREBUILT_FORMAT_KEY.toLowerCase(), collection.format],
    [PREBUILT_DATE_KEY.toLowerCase(), collection.date],
    [LIBRARY_SOURCE_KEY.toLowerCase(), deckPageUrl(source.event, source.deck, fmtCode)],
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
  return `${rankPrefix(source.rank)}-${slugifyForLibrary(source.player)}-${slugifyForLibrary(source.archetype)}.dck`;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'hadoku-cardtable/0.1 (deck library build)' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  // mtgtop8's export is Latin-1, and `response.text()` decodes as UTF-8: `Jötun Grunt`
  // came out as `J\uFFFDtun Grunt`. Strict UTF-8 first, Windows-1252 when that fails.
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Delay between network fetches, so a cold cache is still polite. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cachedExport(deckId: number, cacheDir: string, fmtCode: string): Promise<string> {
  const cachePath = join(cacheDir, `${String(deckId)}.dec`);
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');

  const text = await fetchText(exportUrl(deckId, fmtCode));
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
  /** The era's legal sets, Forge codes, as its format file lists them. */
  readonly eraSets: readonly string[];
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
function setsOf(selection: SelectionFile): string[] {
  return selection.era.sets.split(',').map((code) => code.trim().toUpperCase());
}

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
        eraSets: setsOf(selection),
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
      directory: catalogued?.directory ?? `${DECKS_ROOT}/${family}-${year}`,
      format: catalogued?.format ?? selection.era.format,
      date: catalogued?.date ?? selection.era.start,
      chosen: selection.chosen,
      eraSets: setsOf(selection),
      catalogued,
    };
  });
}

async function main(): Promise<void> {
  const family = (arg('family') ?? 'standard') as FormatFamily;
  const only = arg('only');
  const cacheDir = arg('cache') ?? DEFAULT_CACHE;
  // Forge's res tree, read-only, for its edition files. A worktree has none of
  // its own (`forge/` is the deploy tree's), so point it at one that does.
  const forgeRes = arg('forge-res') ?? join(REPO_ROOT, 'forge', 'forge-gui', 'res');
  if (!existsSync(join(forgeRes, 'editions'))) {
    throw new Error(`${forgeRes} has no editions/ — pass --forge-res=<a checkout with forge/>/forge/forge-gui/res`);
  }
  const printings = editionPrintings(forgeRes);
  const timeshifted = timeshiftedOnly(printings);
  const jobs = buildJobs(family, only);
  const fmtCode = MTGTOP8_FORMAT_CODE[family];

  for (const job of jobs) {
    const outDir = join(REPO_ROOT, job.directory);
    mkdirSync(outDir, { recursive: true });
    console.log(
      `== ${job.label} (${String(job.chosen.length)} decks)${job.catalogued === null ? ' [not in catalog.ts yet]' : ''}`,
    );

    for (const source of job.chosen) {
      const what = `${source.player} (mtgtop8 ${String(source.deck)})`;
      const text = await cachedExport(source.deck, cacheDir, fmtCode);
      const list = parseDecExport(text, what, { timeshifted, printings, eraSets: job.eraSets });
      const file = buildDeckFile({ format: job.format, date: job.date }, source, list, fmtCode);
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
