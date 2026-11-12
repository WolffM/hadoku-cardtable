import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * The host's Scryfall corpus: `cards.jsonl` + `manifest.json`, one copy per host, shared by the
 * server's catalog refresh, `scripts/land.sh` and every CLI that reads or writes the corpus.
 * `CARDTABLE_SCRYFALL_DIR` overrides it.
 */
export function corpusDir(): string {
  return process.env.CARDTABLE_SCRYFALL_DIR ?? resolve(homedir(), '.local/share/cardtable/scryfall');
}
