/*
 * The committed Tier C fixture — a real game's packet stream, not a board
 * someone typed in.
 *
 * ## Provenance
 *
 * `fixtures/tierc-game1-seq1-27.json` is the first 27 `DeltaPacket`s a real
 * Forge client received in one real two-player match, in the exact JSON
 * encoding of Wave 7's spike (`scripts/spike/tierc/src/JsonDelta.java`,
 * `packetToJson` with no object limit). One packet per line.
 *
 * - **Harness:** `scripts/spike/tierc/run.sh capture -Dtierc.games=1`, the
 *   committed spike, unmodified except for one added hook in
 *   `CapturePhase.CapturingGui.applyDelta` that writes every packet whole
 *   (the committed `sample-*.json` keep 3–4 objects per map and carry no
 *   `CardView` at all, so no board can be drawn from them). Run 2026-09-17
 *   against Forge `2cd497cf`, 0 failed / 8 passed, every value round-tripped.
 *   The hook is `fixtures/capture-hook.patch` (apply it to a scratch copy of
 *   the spike, never to `scripts/spike/`, and pass `-Dlanec.dumpDir=<dir>` —
 *   it has no null-guard and throws without the property).
 * - **The match:** `Bob (Capturing)` (player 0, the remote client whose stream
 *   this is — deck "Ral, Caller of Storms") vs `Alice (Host AI)` (player 1 —
 *   deck "Master Blaster"). Decks are the harness's random precons.
 * - **The state at seq 27:** turn 14, `MAIN1`, Bob's turn. Bob is on 2 life
 *   and has cast Direct Current at Alice's Goblin Replica; Fire Urchin's
 *   trigger sits on top of it. Two items on the stack, 5 and 8 permanents,
 *   3 cards in each graveyard, nothing exiled. (The game ran to seq 33, turn
 *   17; Bob lost.)
 *
 * ## What was trimmed, and what was not
 *
 * Shape is untouched: every packet, key, tag and value that remains is exactly
 * as captured. Two things were removed, and each packet's `_truncatedTo` says
 * which:
 *
 * 1. **The events arm is emptied** (`events: []`, 1,350 items over 27 packets,
 *    ~550 KB of base64 Java serialization). Lane B owns that arm; the board
 *    renders state.
 * 2. **Seq 1's `newObjects` drops the 186 objects (93 cards + their card-state
 *    views) that are still in a library at seq 27** — the opening sync sends
 *    all 120 cards of both decks. The `Library` id lists are untouched, so the
 *    counts are real; no later packet addresses a dropped object (checked).
 *
 * ## Which player is the viewer
 *
 * Player 0. That comes from `openView(myPlayers)`, which is not a delta packet,
 * so it is recorded here rather than in the fixture.
 */

import game1 from './fixtures/tierc-game1-seq1-27.json';
import { toBoardView, type BoardView } from './adapter.ts';
import { foldPackets } from './fold.ts';
import { expectWirePackets, type WirePacket } from './wire.ts';

export interface PlayFixture {
  /** Path under `src/play/fixtures/`, so a failure names a real file. */
  file: string;
  label: string;
  viewerPlayerId: number;
  raw: unknown;
}

export const PLAY_FIXTURES: readonly PlayFixture[] = [
  {
    file: 'tierc-game1-seq1-27.json',
    label: 'Turn 14, main 1 — Direct Current on the stack under a trigger',
    viewerPlayerId: 0,
    raw: game1,
  },
];

export function loadPackets(fixture: PlayFixture): WirePacket[] {
  return expectWirePackets(fixture.raw, fixture.file);
}

/** Fold a fixture's whole stream and adapt it for its viewer. */
export function boardFromFixture(fixture: PlayFixture): BoardView {
  const { state, seq } = foldPackets(loadPackets(fixture));
  return toBoardView(state, seq, { viewerPlayerId: fixture.viewerPlayerId });
}
