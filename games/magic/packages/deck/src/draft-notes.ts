/*
 * A drafted deck's `DraftNotes`: what cards noted during the draft, written
 * into the deck's `[metadata]` the way Forge's own draft writes it, because
 * Forge reads it from there when the match starts.
 *
 *   forge-gui/src/main/java/forge/gamemodes/limited/LimitedPlayer.java:61,89
 *       getSerializedDraftNotes: a card's notes joined with "," or, for the
 *       four names below, ";"
 *   forge-core/src/main/java/forge/deck/io/DeckSerializer.java:90
 *       serializeDraftNotes: "<card>:<joined>" pairs joined with " | "
 *   forge-core/src/main/java/forge/deck/io/DeckFileHeader.java:124
 *       extractDraftNotes: split on "|", each pair on its first ":", both trimmed
 *   forge-game/src/main/java/forge/game/Match.java:361
 *       the deck's notes become the player's
 */

/** The cards whose notes Forge joins and splits with ";": card names, which may hold a comma. */
const SEMICOLON_JOINED: ReadonlySet<string> = new Set(['Noble Banneret', 'Cogwork Grinder', 'Aether Searcher', 'Smuggler Captain']);

/**
 * The cards whose notes Forge matches against a card's name in the match
 * (CardProperty.java:2012-2035, `nameList.contains(card.getName())`).
 */
const MATCHED_BY_NAME: ReadonlySet<string> = new Set(['Noble Banneret', 'Aether Searcher', 'Smuggler Captain']);

/**
 * The cards whose notes Forge only counts (AbilityUtils.java:2476). What was
 * noted is never written: Forge sends a player's notes to every client, and
 * Cogwork Grinder's are the cards it removed face down.
 */
const COUNTED_ONLY: ReadonlySet<string> = new Set(['Cogwork Grinder']);

/** What the pair syntax cannot carry: its own separators and a line break. */
const UNWRITABLE = /[|\r\n]/;

/**
 * A noted card name, as every name Forge may know the card by. A two-faced card
 * is `Front // Back` in a draft; in a match Forge names it that way only when
 * it is a split card, and by its front face otherwise.
 */
function matchNames(name: string): string[] {
  const front = name.split(' // ')[0] ?? name;
  return front === name ? [name] : [name, front];
}

/** The value of a deck's `DraftNotes` line; empty when there is nothing to write. */
export function serializeDraftNotes(notes: Readonly<Record<string, readonly string[]>>): string {
  const pairs: string[] = [];
  for (const [card, noted] of Object.entries(notes)) {
    if (card.trim() === '' || card.includes(':') || UNWRITABLE.test(card)) continue;
    const separator = SEMICOLON_JOINED.has(card) ? ';' : ',';
    const values = noted
      .map((value) => value.trim())
      .filter((value) => value !== '' && !UNWRITABLE.test(value) && !(separator === ';' && value.includes(';')))
      .flatMap((value) => (MATCHED_BY_NAME.has(card) ? matchNames(value) : [COUNTED_ONLY.has(card) ? '1' : value]));
    if (values.length > 0) pairs.push(`${card}:${values.join(separator)}`);
  }
  return pairs.join(' | ');
}

const NOTES_LINE = /^\s*draftnotes\s*=/i;

/**
 * `.dck` text carrying exactly these notes: any `DraftNotes` line it had is
 * dropped, and one is written at the end of `[metadata]` when there is
 * something noted. Every other byte is kept. Text with no `[metadata]` section
 * is returned as it was (Forge would not load it).
 */
export function withDraftNotes(text: string, notes: Readonly<Record<string, readonly string[]>>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '[metadata]');
  if (start === -1) return text;
  let end = lines.findIndex((line, i) => i > start && line.trim().startsWith('['));
  if (end === -1) end = lines.length;

  const metadata = lines.slice(start + 1, end).filter((line) => !NOTES_LINE.test(line));
  const value = serializeDraftNotes(notes);
  if (value !== '') {
    // After the section's last line with something on it, ahead of any blank lines that close it.
    let last = metadata.length;
    while (last > 0 && metadata[last - 1]!.trim() === '') last -= 1;
    metadata.splice(last, 0, `DraftNotes=${value}`);
  }
  if (metadata.length === end - start - 1 && metadata.every((line, i) => line === lines[start + 1 + i])) return text;
  return [...lines.slice(0, start + 1), ...metadata, ...lines.slice(end)].join(eol);
}
