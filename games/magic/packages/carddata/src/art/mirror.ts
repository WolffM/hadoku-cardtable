/*
 * The art mirror's log: which CDN object holds each card image we copied.
 *
 * `upload-art` copies every printing's image from Scryfall to `cdn.hadoku.me`
 * and appends one line per copy — `{"id":"<scryfallId>[#back]","key":"<sha256>.jpg"}`
 * — to a JSONL file outside the repo (`~/.local/share/cardtable/art/mirror.jsonl`,
 * beside the card catalog it was built from). Appending, never rewriting, is what
 * keeps a 100k-line job resumable and cheap: a killed run loses the line in flight.
 *
 * The server reads it into a map and hands each card's key to the browser with its
 * id, so the bundle never carries it. The committed `art-manifest.json` stays the
 * hand-made layer on top: a row there (repointing a card) wins over the mirror.
 *
 * No Node APIs: the parse is pure so the CLI, the server and the tests share it.
 */

import { isCdnKey } from './index.ts';

export interface MirrorLine {
  readonly id: string;
  readonly key: string;
}

/** One line of the log, newline included. */
export function mirrorLine(line: MirrorLine): string {
  return `${JSON.stringify({ id: line.id, key: line.key })}\n`;
}

/**
 * Every id → key in the log; a later line for the same id wins. A line that is not
 * JSON, or whose key the resolver would refuse, is skipped and counted: a torn last
 * line from a killed run is expected, anything more is worth a look.
 */
export function parseMirrorLog(text: string): { keys: Map<string, string>; skipped: number } {
  const keys = new Map<string, string>();
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped++;
      continue;
    }
    const { id, key } = (parsed ?? {}) as Partial<MirrorLine>;
    if (typeof id !== 'string' || id === '' || !isCdnKey(key)) {
      skipped++;
      continue;
    }
    keys.set(id, key as string);
  }
  return { keys, skipped };
}
