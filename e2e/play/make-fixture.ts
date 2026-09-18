/**
 * Cut `fixtures/two-seat-play.json` from a live run's captures.
 *
 *   node e2e/play/make-fixture.ts      # after a run of play.spec.ts with a Forge
 *
 * For each browser: every message up to and including its first match snapshot,
 * then the next `S2C_AFTER` server→client events — unedited, raw text only. The
 * cut keeps both opening hands (in each seat's own snapshot) and the first
 * deltas, which is what `fixture.ts`'s mutations need.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { RawCapture } from '../frames.ts';
import { isSnapshot, playMessagesOf } from './frames.ts';
import { FIXTURE_FILE, store } from './fixture.ts';

const RUN_DIR = resolve(import.meta.dirname, '..', '.run');
const S2C_AFTER = 12;

const summary = JSON.parse(readFileSync(resolve(RUN_DIR, 'play-summary.json'), 'utf8')) as { matchId: string; choice: unknown };

const logs = (['alice', 'bob'] as const).map((name, seat) => {
  const captures = JSON.parse(readFileSync(resolve(RUN_DIR, `play-${name}.captures.json`), 'utf8')) as RawCapture[];
  const all = playMessagesOf(captures).filter((m) => m.kind !== 'other');
  const snap = all.findIndex((m) => m.dir === 'in' && m.kind === 'ack' && isSnapshot(m.msg));
  if (snap < 0) throw new Error(`${name}: no snapshot in the capture`);
  let after = 0;
  const cut = all.filter((m, i) => {
    if (i <= snap) return true;
    if (after >= S2C_AFTER) return false;
    if (m.dir === 'in' && m.kind === 's2c') after += 1;
    return true;
  });
  return { name, seat, messages: cut.map(store) };
});

const out = { source: `play.spec.ts live run, match ${summary.matchId}, decks ${JSON.stringify(summary.choice)}`, logs };
writeFileSync(FIXTURE_FILE, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${FIXTURE_FILE}: ${logs.map((l) => `${l.name} ${l.messages.length} messages`).join(', ')}`);
