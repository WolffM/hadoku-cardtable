/**
 * Cut the committed fixture out of a real run's capture.
 *
 *   node make-fixture.ts            # after `playwright test` has run
 *
 * Reads `.run/{alice,bob}.captures.json` and keeps each context's raw
 * captures, in order and byte for byte, up to and including its first
 * `DRAFT_ENVELOPES` draft envelopes. Nothing in a kept capture is edited: the
 * point of the fixture is that it is what a browser actually received, so the
 * mutation tests in `isolation.test.ts` start from the real thing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventsIn, type RawCapture } from './frames.ts';
import { SERVER_TO_CLIENT } from './isolation.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRAFT_ENVELOPES = 8;

function cut(captures: readonly RawCapture[]): RawCapture[] {
  const out: RawCapture[] = [];
  let seen = 0;
  for (const c of captures) {
    if (seen >= DRAFT_ENVELOPES) break;
    out.push(c);
    seen += eventsIn(c).filter((e) => e.dir === 'in' && e.event === SERVER_TO_CLIENT).length;
  }
  return out;
}

const read = (name: string): RawCapture[] =>
  JSON.parse(readFileSync(resolve(HERE, '.run', `${name}.captures.json`), 'utf8')) as RawCapture[];

const fixture = {
  note:
    'Raw socket.io captures from a real run of draft.spec.ts: the first ' +
    `${DRAFT_ENVELOPES} draft envelopes each browser context received, unedited. ` +
    'Regenerate with `node make-fixture.ts`.',
  seats: { alice: 0, bob: 1 },
  alice: cut(read('alice')),
  bob: cut(read('bob')),
};

writeFileSync(resolve(HERE, 'fixtures', 'two-seat-captures.json'), `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`alice ${fixture.alice.length} captures, bob ${fixture.bob.length} captures`);
