/*
 * The headline. P6 §5.1 and §6, on the real engine.
 *
 * > A 45-minute cube draft must survive a server restart and a browser refresh.
 *
 * Nothing here is a stand-in for the draft: `createDraft`, `pick`, `runBots` and
 * `viewFor` are `@hadoku/draft`'s own, and `DraftState` is what a room actually
 * holds in `CoreRoomState.app`. A mock would prove that a `RoomStore` can
 * round-trip a mock.
 *
 * What it proves, in the order the assertions run:
 *   - a draft twenty-odd picks in comes back card for card, in pick order
 *   - every participant is on the SeatId they held, with no seat reallocated
 *   - the next pick lands on the right seat with the right pool
 *   - the restored EPOCH differs, so `classifySeq` tells a stale client to
 *     refetch rather than letting it apply to a rebuilt draft
 *
 * That last one is why a draft's epoch is stamped from `RestoreContext`. Without
 * it, a client holding seq 300 against the pre-restart incarnation meets a
 * restored room whose seq is 300 too, reads every live event as a duplicate, and
 * sits there discarding them forever — the failure `resync.ts` says an epoch
 * exists to prevent, arriving by exactly the route P6 describes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifySeq, occupantOf, seatOf, type SeatId } from '@wolffm/rooms-protocol';
import {
  createDraft,
  pick,
  runBots,
  viewFor,
  spectatorView,
  type DraftConfig,
  type DraftState,
} from '@hadoku/draft';
import type { DraftCard } from '@hadoku/shared';
import { ManualClock } from './clock.ts';
import { FileRoomStore } from './fileStore.ts';
import { RoomPersistence } from './persistence.ts';
import type { RoomCodec } from './snapshot.ts';
import { makeClient } from './testkit.ts';

const ALICE = 'fk:alice-digest-01';
const BOB = 'fk:bob-digest-0002';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'draft-restore-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A synthetic cube, as `engine.test.ts` builds one: exact, and offline. */
function makePool(size: number): DraftCard[] {
  const colours = ['W', 'U', 'B', 'R', 'G'] as const;
  const rarities = ['common', 'uncommon', 'rare', 'mythic'] as const;
  return Array.from({ length: size }, (_, i) => ({
    cardId: `c${i}`,
    name: `Card ${i}`,
    manaCost: [String(i % 6), colours[i % 5] as string],
    manaValue: (i % 6) + 1,
    colors: [colours[i % 5] as (typeof colours)[number]],
    typeLine: i % 3 === 0 ? 'Creature — Test' : 'Instant',
    oracleText: `Text ${i}`,
    setCode: 'TST',
    collectorNumber: String(i + 1),
    rarity: rarities[i % 4] as (typeof rarities)[number],
  }));
}

function draftConfig(seed: string): DraftConfig {
  return {
    draftId: 'pod-1',
    seed,
    pool: makePool(240),
    seatCount: 4,
    packCount: 3,
    packSize: 15,
    humans: [
      { participantId: ALICE, displayName: 'Alice' },
      { participantId: BOB, displayName: 'Bob' },
    ],
    reservationTtlMs: 10 * 60_000,
  };
}

/**
 * The host's codec.
 *
 * `DraftState` is plain JSON already — `SeatTable` is arrays and records by
 * design, and packs/pools/rounds are arrays of plain card objects — so
 * `serialize` is structural. `deserialize` does the one thing that is not a
 * round trip: it stamps the restore's own id as the draft's `epoch`.
 */
const draftCodec: RoomCodec<DraftState> = {
  app: {
    version: 1,
    serialize: (state) => state,
    deserialize: (raw, _version, ctx) => ({ ...(raw as DraftState), epoch: ctx.restoreId }),
  },
};

/** Drive the draft: bots pick for themselves, humans take the first card. */
function driveHumanPick(state: DraftState, seatId: SeatId): DraftState {
  const pack = state.packs[seatId] as DraftCard[];
  const card = pack[0] as DraftCard;
  const result = pick(state, seatId, card.cardId);
  if (!result.ok) throw new Error(`pick rejected: ${result.reason}`);
  return runBots(result.state).state;
}

describe('§5.1 / §6 — a cube draft survives a cold restart', () => {
  it('comes back card for card, on the same seats, with a NEW epoch', async () => {
    const dir = tempDir();
    const clock = new ManualClock(1_700_000_000_000);

    // ── Boot one: a real draft, twenty-odd picks in. ─────────────────────────
    const first = new RoomPersistence<DraftState>({
      store: new FileRoomStore(dir),
      codec: draftCodec,
      createApp: () => createDraft(draftConfig('seed-alpha')),
      clock,
      persist: { debounceMs: 250 },
    });
    const room = await first.loadOrCreate('pod-1', 'room-key');
    room.clients.set('socket-a', makeClient(ALICE, undefined));
    room.clients.set('socket-b', makeClient(BOB, undefined));
    room.clientNames.set(ALICE, 'Alice');
    room.clientNames.set(BOB, 'Bob');

    // The room's seat table IS the draft's: the engine seats the humans at
    // creation, and a second allocator disagreeing with that one is exactly the
    // thing P6 §7 lists as the cost of not having a store at all.
    room.seats = room.app.table;

    const aliceSeat = seatOf(room.seats, ALICE) as SeatId;
    const bobSeat = seatOf(room.seats, BOB) as SeatId;
    expect(aliceSeat).toBe(0);
    expect(bobSeat).toBe(1);

    let picks = 0;
    for (let i = 0; i < 11; i++) {
      room.app = driveHumanPick(room.app, aliceSeat);
      room.app = driveHumanPick(room.app, bobSeat);
      room.lastEventSeq = room.app.seq;
      room.seats = room.app.table;
      picks += 2;
      first.markDirty('pod-1');
      clock.advance(120);
    }
    expect(picks).toBe(22);
    expect(room.app.pools[aliceSeat]).toHaveLength(11);
    expect(room.app.pools[bobSeat]).toHaveLength(11);
    expect(room.app.status).toBe('drafting');

    const beforeEpoch = room.app.epoch;
    const beforeSeq = room.app.seq;
    const beforePools = room.app.pools.map((p) => p.map((c) => c.cardId));
    const beforePacks = room.app.packs.map((p) => p.map((c) => c.cardId));
    const beforeView = viewFor(room.app, aliceSeat);
    const beforeOccupants = room.seats.seats.map((s) => s.occupant);

    // ── The deploy. Flush, and drop absolutely everything. ───────────────────
    expect(first.flushAllSync()).toEqual(['pod-1']);

    // ── Boot two: a brand new store instance over the same directory. ────────
    // `createApp` builds a DIFFERENT draft on purpose: if the restore silently
    // did not happen, every assertion below fails loudly rather than passing
    // against a coincidentally identical fresh draft.
    const second = new RoomPersistence<DraftState>({
      store: new FileRoomStore(dir),
      codec: draftCodec,
      createApp: () => createDraft(draftConfig('seed-omega')),
      clock,
    });
    const restored = await second.loadOrCreate('pod-1', 'room-key');

    // Same room, not a fresh one under the same id.
    expect(second.registry.size).toBe(1);
    expect(restored.roomId).toBe('pod-1');
    expect(restored.lastEventSeq).toBe(beforeSeq);
    expect(restored.app.seed).toBe('seed-alpha');

    // Every pool, card for card, in pick order.
    expect(restored.app.pools.map((p) => p.map((c) => c.cardId))).toEqual(beforePools);
    expect(restored.app.packs.map((p) => p.map((c) => c.cardId))).toEqual(beforePacks);
    expect(restored.app.pools[aliceSeat]).toEqual(beforeView.viewer.kind === 'seat'
      ? beforeView.viewer.pool
      : []);

    // No seat reallocated.
    expect(restored.seats.seats.map((s) => s.occupant)).toEqual(beforeOccupants);
    expect(seatOf(restored.seats, ALICE)).toBe(aliceSeat);
    expect(seatOf(restored.seats, BOB)).toBe(bobSeat);
    expect(occupantOf(restored.seats, 2)?.kind).toBe('bot');

    // §4.3: the seats are held with zero sockets.
    expect(restored.clients.size).toBe(0);
    expect(second.membersOf('pod-1').map((m) => m.participantId).sort()).toEqual(
      [ALICE, BOB].sort(),
    );

    // ── The next pick lands on the right seat with the right pool. ───────────
    const nextCard = (restored.app.packs[aliceSeat] as DraftCard[])[0] as DraftCard;
    const result = pick(restored.app, aliceSeat, nextCard.cardId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.pools[aliceSeat]?.map((c) => c.cardId)).toEqual([
      ...(beforePools[aliceSeat] as string[]),
      nextCard.cardId,
    ]);
    // ...and nobody else's pool moved.
    expect(result.state.pools[bobSeat]?.map((c) => c.cardId)).toEqual(beforePools[bobSeat]);

    // ── The epoch changed, so a stale client refetches. ──────────────────────
    expect(restored.app.epoch).not.toBe(beforeEpoch);
    expect(restored.app.epoch).toBe(second.epochOf('pod-1'));
    const staleCursor = { epoch: beforeEpoch, seq: beforeSeq };
    expect(classifySeq(staleCursor, { epoch: restored.app.epoch, seq: restored.app.seq })).toBe(
      'epoch-change',
    );
    // Without the stamp this would read 'duplicate' and the client would sit
    // there discarding live events. Assert the counterfactual, not just the fix.
    expect(classifySeq(staleCursor, { epoch: beforeEpoch, seq: restored.app.seq })).toBe(
      'duplicate',
    );
  });

  it('a spectator view of the restored draft still carries no cards', async () => {
    const dir = tempDir();
    const first = new RoomPersistence<DraftState>({
      store: new FileRoomStore(dir),
      codec: draftCodec,
      createApp: () => createDraft(draftConfig('seed-alpha')),
    });
    const room = await first.loadOrCreate('pod-1', 'k');
    for (let i = 0; i < 6; i++) {
      room.app = driveHumanPick(room.app, 0);
      room.app = driveHumanPick(room.app, 1);
    }
    await first.save('pod-1');

    const second = new RoomPersistence<DraftState>({
      store: new FileRoomStore(dir),
      codec: draftCodec,
      createApp: () => createDraft(draftConfig('seed-omega')),
    });
    const restored = await second.loadOrCreate('pod-1', 'k');
    const view = spectatorView(restored.app);

    /*
     * Structural first: the spectator arm has no card fields at all, which is
     * the guarantee. Everything after this is belt-and-braces.
     */
    expect(view.viewer).toEqual({ kind: 'spectator' });

    /*
     * Then the payload, by JSON VALUE rather than by bare substring.
     *
     * This assertion used to be `expect(text).not.toContain(card.cardId)`, and
     * it failed in CI on 2026-09-18 having passed locally eight times running.
     * Card ids are `c0`…`c7` — two characters — and the payload carries a random
     * base36 `epoch`. CI's was `emu7g33tv…`. A 12-character base36 string
     * contains any given two-character pair about 0.7% of the time, and the
     * loop runs once per card, so the flake was frequent.
     *
     * A false positive in a leak test is worse than no leak test: it teaches
     * whoever meets it to re-run CI, and the next failure — a real one — gets
     * the same treatment. Matching `"c7"` with its quotes is what a leaked id
     * would actually look like, and cannot collide with an id fragment.
     */
    const text = JSON.stringify(view);
    for (const card of restored.app.pools.flat()) {
      expect(text, `card ${card.cardId} leaked into the spectator view`).not.toContain(
        JSON.stringify(card.cardId),
      );
    }
  });

  it('the draft can be driven to completion after a restore', async () => {
    const dir = tempDir();
    const first = new RoomPersistence<DraftState>({
      store: new FileRoomStore(dir),
      codec: draftCodec,
      createApp: () => createDraft(draftConfig('seed-alpha')),
    });
    const room = await first.loadOrCreate('pod-1', 'k');
    for (let i = 0; i < 20; i++) {
      room.app = driveHumanPick(room.app, 0);
      room.app = driveHumanPick(room.app, 1);
    }
    await first.save('pod-1');

    const second = new RoomPersistence<DraftState>({
      store: new FileRoomStore(dir),
      codec: draftCodec,
      createApp: () => createDraft(draftConfig('seed-omega')),
    });
    const restored = await second.loadOrCreate('pod-1', 'k');
    let state = restored.app;
    let guard = 0;
    while (state.status === 'drafting' && guard < 200) {
      for (const seat of [0, 1]) {
        if ((state.packs[seat] as DraftCard[]).length === 0) continue;
        if (state.picked.includes(seat)) continue;
        state = driveHumanPick(state, seat);
      }
      guard += 1;
    }
    expect(state.status).toBe('complete');
    // 3 packs x 15 cards, dealt to 4 seats: every seat ends with 45 cards.
    expect(state.pools.map((p) => p.length)).toEqual([45, 45, 45, 45]);
  });
});
