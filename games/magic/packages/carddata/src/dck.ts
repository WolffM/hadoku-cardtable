/*
 * Parser for Forge's `.dck` deck/cube file format.
 *
 * This is a faithful TypeScript reimplementation of Forge's own reader, not a
 * guess at the format. Every rule below was read out of the vendored Forge
 * source; the file and line are cited at each rule so the next person can
 * re-check it rather than trust this comment:
 *
 *   forge-core/src/main/java/forge/util/FileSection.java:102   parseSections
 *   forge-core/src/main/java/forge/deck/CardPool.java:413,435  card-line regex
 *   forge-core/src/main/java/forge/card/CardDb.java:237        CardRequest.fromString
 *   forge-core/src/main/java/forge/util/TextUtil.java:110      split (skipEmpty)
 *   forge-core/src/main/java/forge/item/IPaperCard.java:13     placeholders
 *
 * Forge is GPL-3.0-or-later and so is this repo; this file is a reimplementation
 * of its behaviour, and the citations above are the point, not decoration.
 */

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
/** Forge: `IPaperCard.DEFAULT_ART_INDEX` (IPaperCard.java:14). */
export const DEFAULT_ART_INDEX = 1;

/**
 * One card reference, as written on a single line of a `.dck` section.
 *
 * `set`/`collectorNumber` are `null` rather than Forge's `???`/`N.A.` sentinel
 * strings — the sentinels exist in Java because the field is a bare `String`,
 * and reproducing them here would only invite someone to compare against the
 * wrong thing.
 */
export interface CardRequest {
  /** Card name exactly as written, with any foil `+` suffix already removed. */
  readonly name: string;
  /** Three-or-so-letter set code, or `null` when the line named no set. */
  readonly set: string | null;
  /** 1-based art index. Defaults to 1 when neither art index nor collector number is given. */
  readonly artIndex: number;
  /** Collector number from a `[...]` segment, without the brackets. */
  readonly collectorNumber: string | null;
  /** True when the name carried Forge's trailing `+`. */
  readonly foil: boolean;
  /** Whether the art index referred to a double-faced card's back face (`$alt`). */
  readonly backFace: boolean;
  /** Parsed `#{...}` flag segment, or `null` when absent. */
  readonly flags: Readonly<Record<string, string>> | null;
}

/** A card line: a count and the card it refers to. */
export interface DeckEntry {
  readonly count: number;
  readonly card: CardRequest;
}

/** A parsed `.dck` file. */
export interface DeckFile {
  /** The `Name=` metadata value, or `null` if the file declared none. */
  readonly name: string | null;
  /** Every `key=value` pair from the `[metadata]` section, keys lowercased. */
  readonly metadata: ReadonlyMap<string, string>;
  /** Card sections keyed by lowercased section name (`main`, `sideboard`, ...). */
  readonly sections: ReadonlyMap<string, readonly DeckEntry[]>;
}

/**
 * Apache Commons `StringUtils.isNumeric`: every character is a digit, and the
 * empty string is NOT numeric. Forge leans on both halves of that.
 */
function isNumeric(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

/** Forge `CardDb.isSetCode` (CardDb.java:220) — anything non-numeric counts. */
function isSetCode(s: string): boolean {
  return !isNumeric(s);
}

/** Forge `CardDb.isArtIndex` (CardDb.java:216) — numeric, at most two digits. */
function isArtIndex(s: string): boolean {
  return isNumeric(s) && s.length <= 2;
}

/** Forge `CardDb.isCollectorNumber` (CardDb.java:208). */
function isCollectorNumber(s: string): boolean {
  return s.startsWith('[') && s.endsWith(']');
}

/**
 * Forge `TextUtil.split(input, '|')` (TextUtil.java:83 → 110 with skipEmpty=true).
 * Empty segments are dropped, so `Name||1` yields `['Name', '1']`.
 */
function splitSkipEmpty(input: string, delimiter: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === delimiter) {
      if (i > start) out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (input.length > start) out.push(input.slice(start));
  return out;
}

/** Forge `CardDb.parseRequestFlags` (CardDb.java:289). */
function parseFlags(flagText: string): Record<string, string> | null {
  const text = flagText.trim();
  if (text.length === 0) return null;

  if (!text.startsWith('{')) {
    // Legacy form for marked colors, e.g. "W#B#R". Forge normalises these
    // through ColorSet; we keep the raw text rather than half-reimplement a
    // colour model this package has no other use for.
    return { markedColors: text.split(FLAG_PREFIX).join('') };
  }

  const inner = text.slice(1, -1);
  const flags: Record<string, string> = {};
  for (const part of inner.split(FLAG_SEPARATOR)) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    // No '=' means a boolean flag, per Forge's comment at CardDb.java:306.
    if (eq === -1) flags[part] = 'true';
    else flags[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return flags;
}

/**
 * Parse one card-request string (everything after the count) into its parts.
 *
 * Mirrors `CardDb.CardRequest.fromString` (CardDb.java:237), including its
 * ordering quirk: the set-code test runs first and accepts anything
 * non-numeric, so a line written `Name|[42]` — collector number with no set —
 * is read by Forge as the *set code* `[42]`. That is faithful, not a bug here;
 * none of the 95 vendored cubes exercise it, and diverging would make us
 * disagree with the engine that owns the format.
 *
 * Forge's `artPrefs` lookup (CardDb.java:275, a per-user "preferred art"
 * preference consulted when no set is given) is deliberately not reproduced:
 * it is interactive client state, not part of the file format.
 */
export function parseCardRequest(request: string): CardRequest {
  const info = splitSkipEmpty(request, NAME_SET_SEPARATOR);
  if (info.length === 0) {
    return {
      name: '',
      set: null,
      artIndex: DEFAULT_ART_INDEX,
      collectorNumber: null,
      foil: false,
      backFace: false,
      flags: null,
    };
  }

  let name = info[0];
  let foil = false;
  // Forge tests the trimmed name but slices the untrimmed one (CardDb.java:249).
  if (name.trim().endsWith(FOIL_SUFFIX)) {
    name = name.slice(0, name.length - FOIL_SUFFIX.length);
    foil = true;
  }

  let index = 1;
  let set: string | null = null;
  let artIndex = -1; // Forge's IPaperCard.NO_ART_INDEX
  let collectorNumber: string | null = null;
  let backFace = false;
  let flags: Record<string, string> | null = null;

  if (index < info.length && isSetCode(info[index])) {
    set = info[index];
    index++;
  }
  if (index < info.length) {
    const stripped = info[index].split(BACKFACE_POSTFIX).join('');
    if (isArtIndex(stripped)) {
      artIndex = Number.parseInt(stripped, 10);
      backFace = info[index] !== stripped;
      index++;
    }
  }
  if (index < info.length && isCollectorNumber(info[index])) {
    collectorNumber = info[index].slice(1, -1);
    index++;
  }
  if (index < info.length && info[index].startsWith(FLAG_PREFIX)) {
    flags = parseFlags(info[index].slice(FLAG_PREFIX.length));
  }

  if (set === UNKNOWN_SET_CODE) set = null;
  // Forge CardDb.java:284 — only default the art index if neither it nor a
  // collector number was supplied.
  if (collectorNumber === null && artIndex === -1) artIndex = DEFAULT_ART_INDEX;

  return { name, set, artIndex, collectorNumber, foil, backFace, flags };
}

/**
 * Parse one card line. Returns `null` for comments and blanks.
 *
 * Forge `CardPool.processCardList` (CardPool.java:435) with the pattern from
 * CardPool.java:413, `((\d+)\s+)?(.*?)`: an optional leading count (default 1)
 * followed by the card request. Lines starting with `;` or `#` are comments.
 */
export function parseCardLine(rawLine: string): DeckEntry | null {
  if (rawLine.startsWith(';') || rawLine.startsWith(FLAG_PREFIX)) return null;

  const line = rawLine.trim();
  const m = /^(?:([0-9]+)\s+)?([\s\S]*)$/.exec(line);
  if (m === null) return null;

  const request = m[2];
  if (request.trim().length === 0) return null;

  const count = m[1] === undefined ? 1 : Number.parseInt(m[1], 10);
  return { count, card: parseCardRequest(request) };
}

/**
 * Split a `.dck` file into its `[bracketed]` sections.
 *
 * Forge `FileSection.parseSections` (FileSection.java:102): lines are trimmed,
 * `#` comments dropped, `[name]` opens a section, and anything appearing before
 * the first section header is discarded outright.
 */
function parseSections(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(FLAG_PREFIX)) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      // Section names vary in case across the vendored cubes ([main] 60×,
      // [Main] 35×, [Sideboard] 10×, [sideboard] 2×), so key them lowercased.
      const key = line.slice(1, -1).trim().toLowerCase();
      let bucket = result.get(key);
      if (bucket === undefined) {
        bucket = [];
        result.set(key, bucket);
      }
      current = bucket;
    } else if (current !== null && line.length > 0) {
      current.push(line);
    }
  }
  return result;
}

/** Parse the full text of a `.dck` file. */
export function parseDck(text: string): DeckFile {
  const raw = parseSections(text);

  const metadata = new Map<string, string>();
  for (const line of raw.get('metadata') ?? []) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    metadata.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }

  const sections = new Map<string, readonly DeckEntry[]>();
  for (const [key, lines] of raw) {
    if (key === 'metadata') continue;
    const entries: DeckEntry[] = [];
    for (const line of lines) {
      const entry = parseCardLine(line);
      if (entry !== null) entries.push(entry);
    }
    sections.set(key, entries);
  }

  return { name: metadata.get('name') ?? null, metadata, sections };
}

/** Total card count in a section, summing the per-line counts. */
export function countCards(deck: DeckFile, section = 'main'): number {
  let total = 0;
  for (const entry of deck.sections.get(section) ?? []) total += entry.count;
  return total;
}

/** Number of distinct card lines in a section (a singleton cube's "size"). */
export function countEntries(deck: DeckFile, section = 'main'): number {
  return (deck.sections.get(section) ?? []).length;
}
