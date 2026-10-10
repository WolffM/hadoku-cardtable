/*
 * A real game as a sandbox scenario: the committed Tier C capture, folded one
 * packet at a time and run through the same deriver the live board uses
 * (`play/live/sound-events.ts`). What the sandbox plays here is exactly what
 * the table would play for those views, not a hand-written guess at it.
 *
 * The capture is sparse (27 packets over 14 turns), so each packet is spaced
 * evenly rather than at its real time. Loaded on demand by the sandbox: the
 * capture is 141 KB and only this admin screen wants it.
 */

import { SOUND_ROLES } from '@hadoku/shared';

import { toBoardView, type BoardView } from '../play/adapter.ts';
import { loadPackets, PLAY_FIXTURES } from '../play/fixtures.ts';
import { foldPackets } from '../play/fold.ts';
import { deriveSoundEvents } from '../play/live/sound-events.ts';
import type { Beat, Scenario } from './scenarios.ts';

/** Between two captured packets. */
const PACKET_GAP_MS = 1600;

export function capturedGameScenario(): Scenario {
  const fixture = PLAY_FIXTURES[0]!;
  const packets = loadPackets(fixture);
  const beats: Beat[] = [];
  let prev: BoardView | null = null;
  for (let k = 1; k <= packets.length; k++) {
    const { state, seq } = foldPackets(packets.slice(0, k));
    const next = toBoardView(state, seq, { viewerPlayerId: fixture.viewerPlayerId });
    const at = (k - 1) * PACKET_GAP_MS;
    for (const e of deriveSoundEvents(prev, next)) {
      beats.push({
        at: at + (e.delayMs ?? 0),
        role: e.role,
        label: `T${next.turn} ${SOUND_ROLES.get(e.role)?.name ?? e.role}`,
        seat: e.seat,
        colourCell: e.colourCell ?? null,
      });
    }
    prev = next;
  }
  return { id: 'captured', name: 'Captured game', beats: beats.sort((a, b) => a.at - b.at) };
}
