/*
 * Writer for Forge's `.dck` deck/cube file format — the inverse of
 * `@hadoku/carddata`'s `parseDck`.
 *
 * Like the parser, this is a reimplementation of Forge's own writer rather than
 * a guess, and every rule below cites the file it came from so the next person
 * can re-check it:
 *
 *   forge-core/src/main/java/forge/deck/io/DeckSerializer.java:43   serializeDeck
 *   forge-core/src/main/java/forge/deck/io/DeckFileHeader.java:38   metadata key names
 *   forge-core/src/main/java/forge/deck/CardPool.java:459           toCardList
 *   forge-core/src/main/java/forge/card/CardDb.java:130-197         CardRequest.compose
 *   forge-core/src/main/java/forge/card/CardDb.java:199             getFlagSegment
 *   forge-core/src/main/java/forge/deck/DeckSection.java:11         section names
 *   forge-core/src/main/java/forge/util/FileUtil.java:166           writeFile (trailing newline)
 *   forge-core/src/main/java/forge/util/TextUtil.java:256           enclosedBracket
 *
 * Two places where this writer deliberately does NOT do what
 * `DeckSerializer.serializeDeck` does, both for the same reason — a `DeckFile`
 * came out of `parseDck` and has to go back in unchanged:
 *
 *   1. Forge sorts each section's cards (`CardPool.toCardList` calls
 *      `sort(Entry.comparingByKey())`, CardPool.java:461) because a `CardPool`
 *      is a `HashMap`-backed multiset with no order of its own. `DeckFile`'s
 *      sections are arrays and already carry the file's order, so we keep it.
 *      This is not a cosmetic preference: re-sorting takes the number of
 *      vendored cubes this writer reproduces byte-for-byte from 78/95 down to
 *      20/95, because most of them are not in Forge's `PaperCard.compareTo`
 *      order to begin with.
 *   2. Forge skips empty sections (DeckSerializer.java:79). `parseDck` records
 *      a `[Sideboard]` header with no cards under it as an empty array, so
 *      dropping it would lose a key on the way back through. Default is to keep
 *      them; `emptySections: 'drop'` reproduces Forge exactly.
 *
 * Forge is GPL-3.0-or-later and so is this repo; this file is a
 * reimplementation of its behaviour, and the citations above are the point.
 */

import { DEFAULT_ART_INDEX, type CardRequest, type DeckEntry, type DeckFile } from '@hadoku/carddata';

/** Forge: `CardDb.NameSetSeparator` (CardDb.java:44). */
const NAME_SET_SEPARATOR = '|';
/** Forge: `CardDb.foilSuffix` (CardDb.java:43). */
const FOIL_SUFFIX = '+';
/** Forge: `CardDb.FlagPrefix` (CardDb.java:45). */
const FLAG_PREFIX = '#';
/** Forge: `CardDb.FlagSeparator` (CardDb.java:46) — a literal tab. */
const FLAG_SEPARATOR = '\t';
/** Forge: `ImageKeys.BACKFACE_POSTFIX` (ImageKeys.java:39). */
const BACKFACE_POSTFIX = '$alt';
/** Forge: `CardEdition.UNKNOWN_CODE` (CardEdition.java:264). */
const UNKNOWN_SET_CODE = '???';
/** Forge: `IPaperCard.NO_ART_INDEX` (IPaperCard.java:15). */
const NO_ART_INDEX = -1;
/** Forge: `CardDb.isArtIndex` caps at two digits (CardDb.java:216). */
const MAX_ART_INDEX = 99;

/**
 * The `DeckSection` enum's constant names, in declaration order
 * (DeckSection.java:12-21). `DeckSerializer` writes `s.getKey().toString()`
 * (DeckSerializer.java:81), which for a Java enum is the constant name, so
 * these are the spellings Forge itself emits. `parseDck` lowercases section
 * keys, so this table is how a lowercased key gets its canonical casing back.
 */
export const FORGE_SECTION_NAMES: readonly string[] = [
  'Main',
  'Sideboard',
  'Commander',
  'Avatar',
  'Planes',
  'Schemes',
  'Conspiracy',
  'Dungeon',
  'Attractions',
  'Contraptions',
];

/**
 * The metadata keys `DeckFileHeader` declares (DeckFileHeader.java:38-56),
 * including the three it only ever reads (`Player`, `Custom Pool`,
 * `PlayerType`). Same job as `FORGE_SECTION_NAMES`: `parseDck` lowercases
 * metadata keys, and this restores Forge's casing.
 */
export const FORGE_METADATA_KEYS: readonly string[] = [
  'Name',
  'Deck Type',
  'Source URL',
  'Tags',
  'DraftNotes',
  'KeyCards',
  'SleeveArt',
  'SleeveOffset',
  'Comment',
  'AiHints',
  'Player',
  'Custom Pool',
  'PlayerType',
];

const CANONICAL_SECTION_NAME = new Map(FORGE_SECTION_NAMES.map((n) => [n.toLowerCase(), n]));
const CANONICAL_METADATA_KEY = new Map(FORGE_METADATA_KEYS.map((k) => [k.toLowerCase(), k]));

/**
 * Whether to write the art-index segment when it carries no information.
 *
 * Forge's `CardRequest.compose` always writes it (CardDb.java:147-151), but its
 * parser defaults a missing art index to 1 (CardDb.java:284), so `Name|SET` and
 * `Name|SET|1` are the same request. Both forms are all over the shipped cubes:
 * 82 of the 95 write the short form and 13 write at least one long one. Neither
 * is recoverable from a parsed `CardRequest`, because Forge's own model does
 * not record which was written.
 *
 * - `'minimal'` (default) omits the segment when the art index is 1. Matches 78
 *   of the 95 vendored cubes byte-for-byte.
 * - `'always'` reproduces `compose` exactly. Matches 1 more.
 */
export type ArtIndexPolicy = 'minimal' | 'always';

/** Whether to emit a section header that has no cards under it. */
export type EmptySectionPolicy = 'keep' | 'drop';

/**
 * Original spelling of a file's section headers and metadata keys, keyed by the
 * lowercased form `parseDck` produces.
 *
 * `parseDck` lowercases both on the way in, and it is right to — the shipped
 * cubes write `[main]` 60 times and `[Main]` 35 times for the same section, so
 * lookups cannot care. But that means the casing is gone by the time a
 * `DeckFile` reaches this writer, and re-saving a file would churn every header
 * in it. Hand `writeDck` the spelling from `dckSpelling(sourceText)` and it
 * writes the file back the way it found it.
 */
export interface DckSpelling {
  readonly metadataKeys: ReadonlyMap<string, string>;
  readonly sectionNames: ReadonlyMap<string, string>;
}

export interface WriteDckOptions {
  readonly artIndex?: ArtIndexPolicy;
  readonly emptySections?: EmptySectionPolicy;
  readonly spelling?: DckSpelling;
  /**
   * Line terminator. Forge uses `System.lineSeparator()` (DeckSerializer.java:82)
   * and `PrintWriter.println` (FileUtil.java:169), so its output is
   * platform-dependent; every `.dck` Forge ships is LF, which is the default
   * here. Whatever you pick also terminates the last line, as `println` does.
   */
  readonly lineSeparator?: string;
}

/** Thrown when a deck cannot be written as a `.dck` that reads back unchanged. */
export class DckWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DckWriteError';
  }
}

/** Apache Commons `StringUtils.isNumeric`, as the parser has it. */
function isNumeric(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

/**
 * Compose the card-request half of a line: everything after the count.
 *
 * Mirrors `CardDb.CardRequest.compose` (CardDb.java:130-197), which builds
 * `name[+] | set | artIndex | [collectorNumber] | #{flags}` and relies on
 * `TextUtil.split`'s skipEmpty to swallow segments it left blank — which is why
 * a card with no set is written `Name||2` rather than `Name|2`. That exact
 * shape is asserted in the parser's own tests (`dck.test.ts`, "drops empty
 * segments, as Forge does").
 *
 * Throws rather than emit a line that would read back as something else. Every
 * such case is unreachable from a `parseDck` result — the 95 vendored cubes all
 * pass — so a throw here means a hand-built `CardRequest` that Forge's grammar
 * cannot express.
 */
export function composeCardRequest(card: CardRequest, artIndex: ArtIndexPolicy = 'minimal'): string {
  if (card.name.trim().length === 0) {
    throw new DckWriteError('card name is empty');
  }
  if (/[\n\r]/.test(card.name)) {
    throw new DckWriteError(`card name contains a line break: ${JSON.stringify(card.name)}`);
  }
  if (card.name.includes(NAME_SET_SEPARATOR)) {
    // Forge quietly re-parses such a name and keeps only the card-name part
    // (CardDb.java:141-143). Dropping the caller's data on the floor is worse
    // than refusing it, and `parseDck` can never produce one: it splits on `|`.
    throw new DckWriteError(`card name contains '|': ${JSON.stringify(card.name)}`);
  }

  // Forge: compose(cardName, isFoil) (CardDb.java:130) — it will not double a
  // `+` that is already there, and it strips one when the card is not foil.
  const bare = card.name.endsWith(FOIL_SUFFIX)
    ? card.name.slice(0, card.name.length - FOIL_SUFFIX.length)
    : card.name;
  const name = card.foil ? bare + FOIL_SUFFIX : bare;

  const setSegment = setCodeSegment(card);
  const setIsBlank = setSegment.length === 0;
  if (setIsBlank && card.artIndex === NO_ART_INDEX) {
    // Nothing safe can lead the request. `CardDb.isSetCode` is `!isNumeric`
    // (CardDb.java:220) and its test runs first (CardDb.java:255), so the first
    // surviving segment after the name is taken as the set code unless it is
    // numeric — and only the art index ever is. A bracketed collector number or
    // a `#{...}` flag segment would be swallowed as a set code. `parseDck`
    // documents the same quirk from the reading side; the writer cannot route
    // around it, it can only refuse.
    if (card.collectorNumber !== null) {
      throw new DckWriteError(
        `'${card.name}': a collector number with no set code cannot be written — it would read back as the set code '[${card.collectorNumber}]'`,
      );
    }
    if (card.flags !== null) {
      throw new DckWriteError(
        `'${card.name}': flags with no set code and no art index cannot be written — the flag segment would read back as the set code`,
      );
    }
  }
  const artSegment = artIndexSegment(card, artIndex, setIsBlank);
  const collectorSegment = collectorNumberSegment(card);
  const flagSegment = flagsSegment(card);

  // `TextUtil.split`'s skipEmpty drops every blank segment on the way back in
  // (TextUtil.java:110), so writing one is never load-bearing. The single blank
  // this writer does emit is the set placeholder in `Card||2` — Forge's own
  // compose leaves it there (CardDb.java:137) and the shipped cubes have it, so
  // keeping it is what makes a re-save byte-stable.
  const tail = [artSegment, collectorSegment, flagSegment].filter((s) => s.length > 0);
  const segments = tail.length > 0 ? [setSegment, ...tail] : setSegment.length > 0 ? [setSegment] : [];

  return name + segments.map((s) => NAME_SET_SEPARATOR + s).join('');
}

/**
 * Forge: `compose(cardName, setCode)` (CardDb.java:137) — a null, blank or
 * `???` set code becomes the empty string, which `TextUtil.split` then drops.
 */
function setCodeSegment(card: CardRequest): string {
  if (card.set === null || card.set.trim().length === 0 || card.set === UNKNOWN_SET_CODE) {
    return '';
  }
  if (card.set.includes(NAME_SET_SEPARATOR)) {
    throw new DckWriteError(`set code contains '|': ${JSON.stringify(card.set)}`);
  }
  if (isNumeric(card.set)) {
    // `CardDb.isSetCode` is `!isNumeric` (CardDb.java:220), so a numeric set
    // code would be read back as an art index instead.
    throw new DckWriteError(`set code is numeric and would parse as an art index: ${card.set}`);
  }
  return card.set;
}

/**
 * Forge always writes the art index (CardDb.java:149, after clamping it up to
 * `DEFAULT_ART_INDEX`). We write it when it carries information:
 *
 *   - never when the request has none (`NO_ART_INDEX`, which `parseDck` leaves
 *     in place when a collector number was given instead — CardDb.java:284);
 *   - always when a collector number follows it, since the parser only reaches
 *     the collector-number slot after the art-index slot (CardDb.java:255-262)
 *     and a gap there would shift the parse;
 *   - always when the back-face marker or a flag segment needs a non-empty
 *     segment ahead of it;
 *   - otherwise only when it is not the default, unless the policy says always.
 */
function artIndexSegment(card: CardRequest, policy: ArtIndexPolicy, setIsBlank: boolean): string {
  if (card.artIndex === NO_ART_INDEX) return '';

  if (!Number.isInteger(card.artIndex) || card.artIndex < DEFAULT_ART_INDEX) {
    // Forge clamps instead (CardDb.java:149), but with `NO_ART_INDEX` spelled
    // out as its own case above, anything left below 1 is a caller bug.
    throw new DckWriteError(`art index must be a positive integer or -1, got ${card.artIndex}`);
  }
  if (card.artIndex > MAX_ART_INDEX) {
    throw new DckWriteError(
      `art index ${card.artIndex} exceeds Forge's two-digit limit and would be ignored on re-read`,
    );
  }

  const required =
    policy === 'always' ||
    card.backFace ||
    card.artIndex !== DEFAULT_ART_INDEX ||
    card.collectorNumber !== null ||
    (card.flags !== null && setIsBlank);
  if (!required) return '';

  return String(card.artIndex) + (card.backFace ? BACKFACE_POSTFIX : '');
}

/** Forge: `preprocessCollectorNumber` (CardDb.java:188) — bracket it. */
function collectorNumberSegment(card: CardRequest): string {
  if (card.collectorNumber === null) return '';
  const cn = card.collectorNumber.trim();
  if (cn.includes(NAME_SET_SEPARATOR) || cn.includes(']')) {
    throw new DckWriteError(`collector number contains '|' or ']': ${JSON.stringify(cn)}`);
  }
  return `[${cn}]`;
}

/**
 * Forge: `getFlagSegment` (CardDb.java:199) — `#{key=value\tkey=value}`.
 *
 * The parser's legacy marked-colours form (`#W#U`, CardDb.java:296) is read as
 * `{markedColors: 'WU'}` and written back in brace form, which re-reads to the
 * same map. That is a normalisation, not a loss.
 */
function flagsSegment(card: CardRequest): string {
  if (card.flags === null) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(card.flags)) {
    if (key.includes(FLAG_SEPARATOR) || value.includes(FLAG_SEPARATOR)) {
      throw new DckWriteError(`flag ${JSON.stringify(key)} contains a tab, which separates flags`);
    }
    if (key.includes('=')) {
      throw new DckWriteError(`flag key ${JSON.stringify(key)} contains '=', which separates key from value`);
    }
    parts.push(`${key}=${value}`);
  }
  return `${FLAG_PREFIX}{${parts.join(FLAG_SEPARATOR)}}`;
}

/**
 * One card line. Forge: `CardPool.toCardList` (CardPool.java:463) writes
 * `count + " " + compose(card)` — the count is never omitted, even at 1.
 */
export function composeCardLine(entry: DeckEntry, artIndex: ArtIndexPolicy = 'minimal'): string {
  if (!Number.isInteger(entry.count) || entry.count < 0) {
    throw new DckWriteError(`card count must be a non-negative integer, got ${entry.count}`);
  }
  return `${entry.count} ${composeCardRequest(entry.card, artIndex)}`;
}

/** Serialise a `DeckFile` back to `.dck` text. */
export function writeDck(deck: DeckFile, options: WriteDckOptions = {}): string {
  const artIndex = options.artIndex ?? 'minimal';
  const emptySections = options.emptySections ?? 'keep';
  const eol = options.lineSeparator ?? '\n';
  const lines: string[] = [];

  // DeckSerializer.java:45 — the metadata header is written lowercase, and all
  // 95 shipped cubes have it that way, so it is not spelling-dependent.
  lines.push('[metadata]');
  for (const [key, value] of deck.metadata) {
    lines.push(`${metadataKeySpelling(key, options.spelling)}=${metadataValue(key, value)}`);
  }

  for (const [key, entries] of deck.sections) {
    if (key === 'metadata') continue;
    if (entries.length === 0 && emptySections === 'drop') continue;
    lines.push(`[${sectionSpelling(key, options.spelling)}]`);
    for (const entry of entries) lines.push(composeCardLine(entry, artIndex));
  }

  // FileUtil.writeFile uses println per element (FileUtil.java:169), so the
  // last line is terminated too.
  return lines.map((l) => l + eol).join('');
}

function metadataKeySpelling(key: string, spelling: DckSpelling | undefined): string {
  const asWritten = spelling?.metadataKeys.get(key);
  if (asWritten !== undefined) return asWritten;
  const canonical = CANONICAL_METADATA_KEY.get(key);
  if (canonical !== undefined) return canonical;
  if (key.includes('=')) {
    // `parseDck` splits on the first `=`, so a key containing one cannot survive.
    throw new DckWriteError(`metadata key ${JSON.stringify(key)} contains '='`);
  }
  return key;
}

/**
 * Forge strips newlines out of the name, source URL and comment before writing
 * them (DeckSerializer.java:47, 52, 56). It strips `\n` only, and so do we — a
 * bare `\r` survives Forge's write and is trimmed by `parseDck`'s line trim,
 * exactly as it is by `FileSection.parseSections` (FileSection.java:102).
 */
function metadataValue(key: string, value: string): string {
  const stripped = value.split('\n').join('');
  if (stripped.trim() !== stripped) {
    // `parseDck` trims metadata values, so leading/trailing space is not
    // recoverable. Writing it would silently disagree with the re-read.
    throw new DckWriteError(
      `metadata value for '${key}' has leading or trailing whitespace: ${JSON.stringify(stripped)}`,
    );
  }
  return stripped;
}

function sectionSpelling(key: string, spelling: DckSpelling | undefined): string {
  const asWritten = spelling?.sectionNames.get(key);
  if (asWritten !== undefined) return asWritten;
  const canonical = CANONICAL_SECTION_NAME.get(key);
  if (canonical !== undefined) return canonical;
  if (key.includes(']')) {
    throw new DckWriteError(`section name ${JSON.stringify(key)} contains ']'`);
  }
  return key;
}

/**
 * Recover the header and metadata-key spellings from a `.dck` file's own text,
 * so `writeDck` can put a file back the way it found it.
 *
 * Scans with the same rules `parseDck` uses (FileSection.java:102): trim, drop
 * `#` comments, `[name]` opens a section. The first spelling seen for a key
 * wins, which is how Forge's `parseSections` behaves too — it appends later
 * repeats of a header into the bucket the first one opened.
 */
export function dckSpelling(text: string): DckSpelling {
  const metadataKeys = new Map<string, string>();
  const sectionNames = new Map<string, string>();
  let inMetadata = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(FLAG_PREFIX)) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      const key = name.toLowerCase();
      inMetadata = key === 'metadata';
      if (!inMetadata && !sectionNames.has(key)) sectionNames.set(key, name);
      continue;
    }
    if (!inMetadata || line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const written = line.slice(0, eq).trim();
    const key = written.toLowerCase();
    if (!metadataKeys.has(key)) metadataKeys.set(key, written);
  }

  return { metadataKeys, sectionNames };
}
