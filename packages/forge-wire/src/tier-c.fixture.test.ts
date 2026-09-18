/*
 * The contract between the board and the wire: every packet in the UI's
 * committed Tier C fixture must parse under this package's schema.
 *
 * The fixture (`apps/ui/src/play/fixtures/`) is a real match's packet stream,
 * and the board renders from it without importing this package. Without this
 * test the two could drift apart and both stay green. `_truncatedTo` is the
 * fixture's trim annotation, not wire data, so it is asserted present and then
 * stripped — the same treatment `tier-c.test.ts` gives the spike's samples.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DeltaPacketSchema, GameStateSchema } from './tier-c.ts';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/ui/src/play/fixtures/tierc-game1-seq1-27.json',
);

function loadPackets(): Record<string, unknown>[] {
  const packets = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>[];
  return packets.map((p) => {
    expect(p).toHaveProperty('_truncatedTo');
    const { _truncatedTo: _, ...wire } = p;
    return wire;
  });
}

describe('the UI board fixture against the Tier C schema', () => {
  it('every packet parses as a DeltaPacket', () => {
    const packets = loadPackets();
    expect(packets).toHaveLength(27);
    for (const packet of packets) {
      expect(DeltaPacketSchema.safeParse(packet).success).toBe(true);
    }
  });

  it('the opening sync parses as a GameState', () => {
    const [first] = loadPackets();
    expect(GameStateSchema.safeParse(first?.newObjects).success).toBe(true);
  });

  it('a retagged value in the fixture fails, with the path named', () => {
    const packets = loadPackets();
    const mutated = JSON.parse(JSON.stringify(packets[4]).replace('"t":"int"', '"t":"ref"')) as unknown;
    const result = DeltaPacketSchema.safeParse(mutated);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path.join('.')).toBe('newObjects.21.Owner.t');
  });
});
