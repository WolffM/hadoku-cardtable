/*
 * A prebuilt deck: a `.dck` plus the three things a `.dck` does not say about
 * itself — which format it is for, when that format was current, and what to
 * call it.
 *
 * ## Why the metadata lives inside the file
 *
 * Forge's deck header (`DeckFileHeader`,
 * forge-core/src/main/java/forge/deck/io/DeckFileHeader.java:34) declares
 * thirteen keys and none of them is a format or a date. `Deck Type` is close
 * and is not it: it holds a `DeckFormat` enum constant — `Constructed`,
 * `Limited` — not *"Standard as it stood on 2011-09-30"*, which is the thing
 * this repo actually wants to recreate.
 *
 * So we add two keys of our own, `Format` and `Effective`, and put them in the
 * file's own `[metadata]` section rather than in a sidecar. Three reasons:
 *
 *   1. `DeckFileHeader` reads its thirteen keys by name and ignores everything
 *      else (:36-56), so a deck carrying ours still loads in stock Forge. This
 *      was checked in the source, not assumed.
 *   2. `parseDck` keeps every `key=value` pair it sees and `writeDck` writes
 *      them all back, so the round trip is already free.
 *   3. One artifact. A prebuilt deck is a file the operator commits, moves and
 *      edits; a deck and a sidecar that can drift apart is two.
 *
 * The spelling of the two keys follows Forge's own format files, which is where
 * the data is going to come from: `forge-gui/res/formats/Archived/Standard/`
 * holds 155 dated Standard snapshots, each headed
 *
 *   Name:Standard (ISD)
 *   Subtype:Standard
 *   Effective:2011-09-30
 *   Sets:SOM, MBS, NPH, M12, ISD
 *
 * — so `Effective` is their word for the date, and reusing it means the deck
 * and the format it names spell the same field the same way.
 *
 * ## No filesystem
 *
 * `loadPrebuiltDeck` takes the deck's **text**. This package is bundled into
 * the browser, so it cannot read a file, and it does not need to: whoever has
 * the text — a build step, a fetch, an import — hands it over. Same discipline
 * as `formatIssues` taking a pool rather than importing one.
 */

import { parseDck, type DeckEntry, type DeckFile } from '@hadoku/carddata/dck';

import { deckFromDeckFile, type Deck, type DeckIssue } from './deck.ts';
import { dckSpelling, writeDck, type DckSpelling, type WriteDckOptions } from './dck-write.ts';
import { formatIssues, type FormatPool } from './format.ts';

/** Our metadata key for the format a deck is built for. */
export const PREBUILT_FORMAT_KEY = 'Format';
/**
 * Our metadata key for the date that format was current, `YYYY-MM-DD`. Named
 * after the `Effective:` line in Forge's own format files.
 */
export const PREBUILT_DATE_KEY = 'Effective';

/**
 * How `writeDck` should spell our two keys. `parseDck` lowercases metadata
 * keys, so without this a re-write would emit `format=` and `effective=`; a
 * deck loaded from text carries its own spelling and that one wins.
 */
const PREBUILT_SPELLING: DckSpelling = {
  metadataKeys: new Map([
    [PREBUILT_FORMAT_KEY.toLowerCase(), PREBUILT_FORMAT_KEY],
    [PREBUILT_DATE_KEY.toLowerCase(), PREBUILT_DATE_KEY],
  ]),
  sectionNames: new Map(),
};

/** Forge's format files write `Effective:2011-09-30`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A deck someone built, ready to play, with the format it was built for. */
export interface PrebuiltDeck {
  readonly name: string;
  /** The format's name, as the format pool spells it: `Standard (ISD)`. */
  readonly format: string;
  /** `YYYY-MM-DD` — when that format was current. */
  readonly date: string;
  /** The parsed file. Everything else on this interface is read out of it. */
  readonly file: DeckFile;
  /**
   * The header and metadata-key casing the source text used, so
   * `writePrebuiltDeck` puts the file back exactly as it found it. Empty for a
   * deck built by `prebuiltDeck` rather than loaded.
   */
  readonly spelling: DckSpelling;
}

/** Thrown when a `.dck` is not a usable prebuilt deck. */
export class PrebuiltDeckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrebuiltDeckError';
  }
}

/** Anything about a prebuilt deck that the file itself does not have to say. */
export interface PrebuiltDeckOverrides {
  readonly name?: string;
  readonly format?: string;
  readonly date?: string;
}

/**
 * Read a prebuilt deck out of `.dck` text.
 *
 * Name, format and date come from the file's `[metadata]` section (`Name`,
 * `Format`, `Effective`); anything passed in `overrides` wins, which is how a
 * deck whose file predates this convention still loads.
 *
 * Throws rather than returning a half-built deck, and names **every** missing
 * or malformed field in one message rather than the first — the same reason
 * `formatIssues` reports every issue. A deck that will not load is a broken
 * artifact, not a user mistake: it is fixed by editing the file, and the
 * message says exactly which lines to add.
 */
export function loadPrebuiltDeck(text: string, overrides: PrebuiltDeckOverrides = {}): PrebuiltDeck {
  const file = parseDck(text);
  const name = overrides.name ?? file.name ?? '';
  const format = overrides.format ?? file.metadata.get(PREBUILT_FORMAT_KEY.toLowerCase()) ?? '';
  const date = overrides.date ?? file.metadata.get(PREBUILT_DATE_KEY.toLowerCase()) ?? '';

  const missing: string[] = [];
  if (name.trim().length === 0) missing.push('a deck name (metadata key `Name`)');
  if (format.trim().length === 0) {
    missing.push(`a format (metadata key \`${PREBUILT_FORMAT_KEY}\`)`);
  }
  if (date.trim().length === 0) {
    missing.push(`a date (metadata key \`${PREBUILT_DATE_KEY}\`, YYYY-MM-DD)`);
  } else if (!ISO_DATE.test(date)) {
    missing.push(`a \`${PREBUILT_DATE_KEY}\` date of the form YYYY-MM-DD, not ${JSON.stringify(date)}`);
  }
  if (missing.length > 0) {
    throw new PrebuiltDeckError(`prebuilt deck needs ${missing.join(', and ')}`);
  }

  return { name, format, date, file, spelling: dckSpelling(text) };
}

/**
 * Build a prebuilt deck from card lists, with the metadata written into the
 * file so `writePrebuiltDeck` emits a single self-describing `.dck`.
 *
 * `Name` is written first, as `DeckSerializer.serializeDeck` writes it
 * (DeckSerializer.java:47).
 */
export function prebuiltDeck(
  meta: { readonly name: string; readonly format: string; readonly date: string },
  sections: ReadonlyMap<string, readonly DeckEntry[]>,
): PrebuiltDeck {
  if (!ISO_DATE.test(meta.date)) {
    throw new PrebuiltDeckError(
      `prebuilt deck date must be YYYY-MM-DD, got ${JSON.stringify(meta.date)}`,
    );
  }
  const metadata = new Map<string, string>([
    ['name', meta.name],
    [PREBUILT_FORMAT_KEY.toLowerCase(), meta.format],
    [PREBUILT_DATE_KEY.toLowerCase(), meta.date],
  ]);
  const file: DeckFile = { name: meta.name, metadata, sections: new Map(sections) };
  return { ...meta, file, spelling: PREBUILT_SPELLING };
}

/**
 * Write a prebuilt deck back to `.dck` text.
 *
 * Byte-identical to the text it was loaded from, because the deck keeps the
 * file's own header spelling and `writeDck` defaults to keeping empty sections
 * and the file's card order. That is the property the writer was built for and
 * this function only has to avoid breaking it.
 */
export function writePrebuiltDeck(deck: PrebuiltDeck, options: WriteDckOptions = {}): string {
  const spelling: DckSpelling = {
    // The file's own spelling wins over our canonical casing, so re-writing a
    // deck that wrote `format=` lowercase keeps it lowercase.
    metadataKeys: new Map([...PREBUILT_SPELLING.metadataKeys, ...deck.spelling.metadataKeys]),
    sectionNames: new Map([
      ...PREBUILT_SPELLING.sectionNames,
      ...deck.spelling.sectionNames,
    ]),
  };
  return writeDck(deck.file, { ...options, spelling: options.spelling ?? spelling });
}

/** The deck as a playable `Deck`: `[main]` maindeck, `[sideboard]` sideboard. */
export function prebuiltToDeck(deck: PrebuiltDeck): Deck {
  return deckFromDeckFile(deck.file, deck.name);
}

/**
 * Every way this prebuilt deck fails the format pool it is handed — which
 * cards, and why. Empty means it is legal and ready to play.
 *
 * The pool is an argument. This function does not look up `deck.format`
 * anywhere; the caller resolves the name to a pool and passes it, and if the
 * two disagree that is worth saying out loud, so a pool whose `name` differs
 * from the deck's `format` still validates and the messages name the pool.
 */
export function prebuiltIssues(deck: PrebuiltDeck, format: FormatPool): DeckIssue[] {
  return formatIssues(prebuiltToDeck(deck), format);
}
