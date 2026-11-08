/*
 * Transcribes a real MTGO tournament field — decklists, pairings, standings —
 * into library collections under `decks/`, one collection per event.
 *
 * The source is `fbettega/MTG_decklistcache`, the open JSON cache of MTGO,
 * Melee, Topdeck and Manatraders tournament data (one JSON per event, holding
 * every decklist with results, the round-by-round pairings and the final
 * standings). Unlike `build-library.ts`, which reads the hand-curated output
 * of a deck-selection pass, this reads the WHOLE field of a named event: the
 * point is playing the tournament, not curating it.
 *
 * Run from the repo root:
 *
 *   node packages/deck/src/library/build-tournament-library.ts \
 *     --tournament=/path/to/modern-challenge-32-2026-02-0712832522.json \
 *     --family=modern
 *
 * Writes `decks/tournament-<family>-<date>-<slug>/<NN>-<player>-<finish>.dck`,
 * one `.dck` per decklist in the cache JSON, plus `tournament.json` — the
 * event's own pairings and standings, kept verbatim so a tournament runner can
 * replay the real Swiss rounds against the real field without re-deriving them
 * from deck files.
 *
 * ## What this script does NOT do
 *
 * It does not check legality. `validate-library.ts` already validates a
 * directory of decks against a dated pool (`--family --date --dir`), and a
 * conversion that silently dropped a card should fail a validation run, not be
 * patched up by the converter — the same split `build-library.ts` keeps from
 * `validate-library.ts`, for the same reason.
 *
 * It does not add collections to `catalog.ts`. `catalog.ts` is committed data
 * with per-collection provenance and a review doc behind it; a tournament
 * import adds its collection the same way wave 48's lanes M and L did —
 * transcribe first, integrate after review. Until then the collection is
 * validated directly (`--dir` mode) and never reaches the picker.
 *
 * ## Deck cache shape (MTG_decklistcache `CacheItem`)
 *
 *   Tournament: {Date, Name, Uri, Formats}          Formats is a single string
 *   Decks: [{Date, Player, Result, AnchorUri, Mainboard, Sideboard}]
 *          Mainboard/Sideboard: [{Count, CardName}]
 *   Rounds: [{RoundName, Matches: [{Player1, Player2, Result}]}]
 *   Standings: [{Rank, Player, Points, Wins, Losses, Draws, OMWP, GWP, OGWP}]
 *
 * mtgo.com decklists name cards the way MTGO does: official English card
 * names, no set codes. Forge's card database resolves a bare name when the
 * printing is unambiguous, so the `.dck` writer emits `Name|A` (name with
 * Forge's any-edition art index) and lets the engine pick the printing — the
 * same call `dck-write.ts` makes for a `CardRequest` with no set.
 *
 * ## Why pairings go in the collection
 *
 * A tournament is more than its decklists: the event's own pairings are what
 * makes "did I beat the real field's real rounds" answerable. They are
 * committed next to the decks (verbatim cache JSON, plus the standings) so the
 * data a Swiss runner needs is one file, not a re-fetch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ART_INDEX, type DeckEntry, type DeckFile } from '@hadoku/carddata/dck';

import { writeDck, type DckSpelling } from '../dck-write.ts';
import { PREBUILT_DATE_KEY, PREBUILT_FORMAT_KEY } from '../prebuilt.ts';
import { DECKS_ROOT, slugifyForLibrary, type FormatFamily } from './catalog.ts';
import { formatAtFamily } from '@hadoku/carddata/formats';
import { LIBRARY_ARCHETYPE_KEY, LIBRARY_PILOT_KEY, LIBRARY_PROVENANCE_KEY, LIBRARY_SOURCE_KEY } from './library.ts';

/** `packages/deck/src/library` → the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The format families a tournament can be imported into. */
const FAMILIES: readonly FormatFamily[] = ['standard', 'modern', 'legacy'];

/**
 * `Format` and `Effective` are ours (see `build-library.ts`'s note); the same
 * casing fixups apply so `loadPrebuiltDeck` reads the files back.
 */
const TOURNAMENT_SPELLING: DckSpelling = {
  metadataKeys: new Map([
    [PREBUILT_FORMAT_KEY.toLowerCase(), PREBUILT_FORMAT_KEY],
    [PREBUILT_DATE_KEY.toLowerCase(), PREBUILT_DATE_KEY],
    [LIBRARY_ARCHETYPE_KEY.toLowerCase(), LIBRARY_ARCHETYPE_KEY],
    [LIBRARY_PILOT_KEY.toLowerCase(), LIBRARY_PILOT_KEY],
  ]),
  sectionNames: new Map(),
};

/** One cached decklist. */
interface CacheDeck {
  readonly Date?: string;
  readonly Player: string;
  readonly Result: string;
  readonly AnchorUri?: string;
  readonly Mainboard: readonly CacheCard[];
  readonly Sideboard: readonly CacheCard[];
}

interface CacheCard {
  readonly Count: number;
  readonly CardName: string;
}

/** One cached round: Swiss pairings with match results. */
interface CacheRound {
  readonly RoundName: string;
  readonly Matches: readonly CacheMatch[];
}

interface CacheMatch {
  readonly Player1: string;
  readonly Player2: string;
  /** `"2-0-0"` (wins-losses-draws) or `"0-0-0"` for a bye — the cache's own shape, kept verbatim. */
  readonly Result: string;
}

/** One cached standing row. */
interface CacheStanding {
  readonly Rank: number;
  readonly Player: string;
  readonly Points: number;
  readonly Wins: number;
  readonly Losses: number;
  readonly Draws: number;
  readonly OMWP?: number;
  readonly GWP?: number;
  readonly OGWP?: number;
}

/** The event metadata the cache carries under `Tournament` (older files: top-level keys). */
interface CacheEvent {
  readonly Date: string;
  readonly Name: string;
  readonly Uri: string;
  readonly Formats?: string;
}

/** The MTG_decklistcache `CacheItem` shape, fields this script reads. */
interface CacheItem {
  readonly Tournament?: CacheEvent;
  readonly Date?: string;
  readonly Name?: string;
  readonly Decks: readonly CacheDeck[];
  readonly Rounds?: readonly CacheRound[];
  readonly Standings?: readonly CacheStanding[];
}

function arg(name: string, argv: readonly string[]): string | null {
  const prefix = `--${name}=`;
  for (const a of argv) if (a.startsWith(prefix)) return a.slice(prefix.length);
  return null;
}

function usage(): never {
  throw new Error(
    'usage: build-tournament-library.ts --tournament=<MTG_decklistcache json> --family=<standard|modern|legacy>',
  );
}

/** `'1st Place'` → `'1'`, `'5th-8th Place'` → `'5'`; a non-placing string is slugified as-is. */
function rankPrefix(result: string): string {
  const m = /^(\d+)(?:st|nd|rd|th)/.exec(result.trim());
  return m !== null ? String(Number(m[1])) : slugifyForLibrary(result) || 'x';
}

/** `"1st Place"` → `"1st"`; `"9th-16th Place"` → `"9th-16th"`; anything else passes through. */
function finishOf(result: string): string {
  return result.replace(/\s+Place(s)?$/i, '').trim();
}

function totalCount(entries: readonly DeckEntry[]): number {
  return entries.reduce((sum, e) => sum + e.count, 0);
}

function toEntries(cards: readonly CacheCard[], what: string, section: string): DeckEntry[] {
  const entries: DeckEntry[] = [];
  for (const card of cards) {
    if (!Number.isInteger(card.Count) || card.Count <= 0) {
      throw new Error(`${what}: ${section} entry ${JSON.stringify(card)} has no usable Count`);
    }
    const name = card.CardName.trim();
    if (name.length === 0) throw new Error(`${what}: ${section} entry with empty CardName`);
    entries.push({
      count: card.Count,
      card: {
        name,
        set: null,
        collectorNumber: null,
        artIndex: DEFAULT_ART_INDEX,
        foil: false,
        backFace: false,
        flags: null,
      },
    });
  }
  return entries;
}

function buildDeckFile(
  format: string,
  date: string,
  deck: CacheDeck,
  event: CacheEvent,
): DeckFile {
  const player = deck.Player;
  const finish = finishOf(deck.Result);
  const name = `${player} — ${event.Name ?? 'tournament'}`.slice(0, 120);
  const sourceUri = deck.AnchorUri ?? event.Uri ?? 'unknown-source';
  const metadata = new Map<string, string>([
    ['name', name],
    [LIBRARY_PILOT_KEY.toLowerCase(), player],
    // The cache carries no archetype; the pilot's own slug keeps the required
    // key present without inventing a classification nobody verified.
    [LIBRARY_ARCHETYPE_KEY.toLowerCase(), 'unclassified'],
    ['deck type', 'Constructed'],
    [PREBUILT_FORMAT_KEY.toLowerCase(), format],
    [PREBUILT_DATE_KEY.toLowerCase(), date],
    [LIBRARY_SOURCE_KEY.toLowerCase(), sourceUri],
    [
      LIBRARY_PROVENANCE_KEY.toLowerCase(),
      `${event.Name ?? 'Tournament'} (${date}): ${player}, ${finish}. Transcribed from MTG_decklistcache (${sourceUri}).`,
    ],
  ]);

  const main = toEntries(deck.Mainboard, player, 'Mainboard');
  if (main.length === 0) throw new Error(`${player}: cache deck has no mainboard`);
  const sections = new Map<string, readonly DeckEntry[]>([['main', main]]);
  const sideboard = toEntries(deck.Sideboard ?? [], player, 'Sideboard');
  if (sideboard.length > 0) sections.set('sideboard', sideboard);

  return { name, metadata, sections };
}

/** The collection directory for one imported event: `decks/tournament-<family>-<date>-<slug>/`. */
export function tournamentDirectoryName(family: FormatFamily, date: string, eventName: string): string {
  return `${DECKS_ROOT}/tournament-${family}-${date}-${slugifyForLibrary(eventName).slice(0, 40)}`;
}

/** The file one player's deck is written to inside the collection directory. */
export function tournamentDeckFileName(deck: CacheDeck): string {
  return `${rankPrefix(deck.Result)}-${slugifyForLibrary(deck.Player)}.dck`;
}

/**
 * Runs the import. Exported so the test can drive the pure pieces and so the
 * CLI body below the guard stays side-effect-free on import — the same
 * `import.meta.main` convention `sync-cards.ts` states and `scripts/release/
 * collect.ts` uses.
 */
export async function runImport(argv: readonly string[]): Promise<void> {
  const tournamentPath = arg('tournament', argv);
  const family = arg('family', argv) as FormatFamily | null;
  if (tournamentPath === null || family === null || !FAMILIES.includes(family)) usage();

  const raw = JSON.parse(readFileSync(tournamentPath!, 'utf8')) as CacheItem;
  const event = raw.Tournament ?? { Date: raw.Date ?? '', Name: raw.Name ?? 'tournament', Uri: '' };
  if (typeof event.Date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(event.Date)) {
    throw new Error(`${tournamentPath}: no Tournament.Date — cannot pin an era`);
  }
  const date = event.Date.slice(0, 10);
  const eventName = event.Name ?? 'tournament';
  // The FORMAT NAME, not the family string: a deck's `Format` metadata is
  // checked against its collection's row (`library.test.ts`) and against the
  // pool a fixture thaws (`libraryPoolMismatch`), and both carry the snapshot
  // name `formatAtFamily` answers — `Modern (ECL)`, never `modern`. Refused
  // dates (before the family existed, past the transcribed table) stop the
  // import: a deck that cannot name its own format is not a deck to write.
  const formatAnswer = formatAtFamily(family!, date);
  if (!formatAnswer.ok) {
    throw new Error(`${family} ${date}: formatAtFamily refused — ${formatAnswer.reason}`);
  }
  const formatName = formatAnswer.name;
  const outDir = join(REPO_ROOT, tournamentDirectoryName(family!, date, eventName));
  mkdirSync(outDir, { recursive: true });

  const players = new Set(raw.Decks.map((d) => d.Player));
  if (players.size !== raw.Decks.length) {
    throw new Error(`${tournamentPath}: duplicate Player entries (${String(raw.Decks.length)} decks, ${String(players.size)} players)`);
  }

  console.log(`== ${eventName} (${date}, ${family}) — ${String(raw.Decks.length)} decks`);

  const written: string[] = [];
  const failures: string[] = [];
  for (const deck of raw.Decks) {
    const fileName = tournamentDeckFileName(deck);
    const target = join(outDir, fileName);
    try {
      const file = buildDeckFile(formatName, date, deck, event);
      writeFileSync(target, writeDck(file, { spelling: TOURNAMENT_SPELLING }), 'utf8');
      written.push(fileName);
      console.log(
        `  ${fileName}: main ${String(totalCount(file.sections.get('main') ?? []))}, sideboard ${String(totalCount(file.sections.get('sideboard') ?? []))}`,
      );
    } catch (err) {
      failures.push(`${fileName}: ${(err as Error).message}`);
    }
  }

  // Pairings + standings, verbatim. The pairings a Swiss runner replays are the
  // event's own; re-deriving them from deck results would be a second,
  // lossier copy of a record that already exists.
  const record = {
    $comment:
      'GENERATED by packages/deck/src/library/build-tournament-library.ts from fbettega/MTG_decklistcache. ' +
      'Committed so a tournament runner can replay the real Swiss rounds against the real field. Do not hand-edit.',
    event: { name: eventName, date, uri: event.Uri ?? '', format: formatName },
    source: tournamentPath,
    pairings: raw.Rounds ?? [],
    standings: raw.Standings ?? [],
  };
  const recordPath = join(outDir, 'tournament.json');
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  console.log(
    `wrote ${String(written.length)}/${String(raw.Decks.length)} decks + pairings (${String(record.pairings.length)} rounds, ${String(record.standings.length)} standings) to ${tournamentDirectoryName(family!, date, eventName)}`,
  );
  if (failures.length > 0) {
    console.error(`FAILURES (${String(failures.length)}):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  }
  if (!existsSync(recordPath)) throw new Error('tournament.json was not written');
}

if (import.meta.main) await runImport(process.argv.slice(2));
