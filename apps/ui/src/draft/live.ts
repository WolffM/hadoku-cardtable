/*
 * A live draft, driven in-process by `@hadoku/draft`.
 *
 * This is the fixture harness's replacement, and it deliberately produces the
 * *same thing* the fixtures did: a `DraftView` payload. `DraftScreen` cannot
 * tell the difference, which is the property the fixture lane was built to
 * preserve — swapping the source is a change here and nowhere else.
 *
 * ## Still no transport
 *
 * The engine runs in the browser tab, in the same process as the UI. There is
 * no socket, no room, and no server; `@wolffm/rooms-server` is not imported
 * here or anywhere in this app. When a server does appear, this module is what
 * it replaces: the engine moves behind a wire, `nextView()` becomes an incoming
 * event, and everything below `DraftScreen` stays as it is.
 *
 * ## Why the payload is re-parsed before it is used
 *
 * `viewFor` already returns a typed `DraftView`, so parsing it again looks
 * redundant. It is not: it runs the *semantic* rules too — the D13 no-images
 * control, the hidden-information checks, the cross-field invariants — over a
 * payload the engine just built. If the engine ever produces something that
 * would be rejected arriving over a wire, this fails in development rather than
 * shipping a payload nobody validated because it came from inside the house.
 */

import {
  createDraft,
  deal,
  pick as enginePick,
  runBots,
  viewFor,
  type DraftState,
} from '@hadoku/draft';
import type { PoolSource } from '@hadoku/shared';
import { expectDraftView } from './validate.ts';
import type { DraftCard, DraftView } from './types.ts';
import poolData from './pool.json';

/** The seat the local player occupies. Seat 0, so the pod reads naturally. */
export const MY_SEAT = 0;

interface PoolFile {
  cube: string;
  size: number;
  cards: DraftCard[];
}

const POOL = poolData as PoolFile;

/** Which cube the bundled pool came from, for the UI to name. */
export const CUBE_NAME: string = POOL.cube;
export const CUBE_SIZE: number = POOL.size;

export interface LiveDraft {
  engine: DraftState;
  view: DraftView;
}

/** The names the demo pod's bots and the local player get. */
const POD = [
  { participantId: 'dev:you', displayName: 'Drafter' },
];

/**
 * Start a draft on the bundled cube.
 *
 * Bots take the other seven seats but do NOT pick yet — the opening payload has
 * every seat at zero and a full fifteen-card pack, which is what pick 1 of a
 * draft actually looks like. They pick in `applyPick`, immediately after the
 * human's, which leaves them one pick ahead from then on: their pick completes
 * the round, the packs pass, and they take from the next pack before the human
 * has seen it. `waitingOn` is therefore the human's seat alone for the rest of
 * the draft, which is the right feel — the table waits for you, not you for it.
 */
export function startDraft(seed: string): LiveDraft {
  // One cube, all three rounds — the in-process harness never grows a second
  // source; `deal()` is still the one place packs are built, same as a room.
  const source: PoolSource = { kind: 'cube', cubeId: 'bundled' };
  const plan = { rounds: [source, source, source] as [PoolSource, PoolSource, PoolSource] };
  const engine = createDraft({
    draftId: `draft:${seed}`,
    epoch: `${seed}:1`,
    seed,
    packs: deal(plan, () => POOL.cards, seed, 8, 15),
    seatCount: 8,
    packCount: 3,
    packSize: 15,
    humans: POD,
    // A dropped drafter keeps their seat for two minutes rather than costing
    // the other seven the pod. Inert in this local harness — no one can drop —
    // but it is the value a server would use, so it is set where it belongs.
    reservationTtlMs: 120_000,
  });
  return { engine, view: validated(engine) };
}

/** Apply the local player's pick, then let the bots catch up. */
export function applyPick(draft: LiveDraft, cardId: string): LiveDraft {
  const result = enginePick(draft.engine, MY_SEAT, cardId);
  if (!result.ok) {
    // The engine rejects as a value; the UI has already blocked the illegal
    // cases it can see, so reaching here means the two disagree. Keep the old
    // state rather than guessing.
    return draft;
  }
  const { state } = runBots(result.state);
  return { engine: state, view: validated(state) };
}

/** Whether the draft has run out of packs. */
export function isComplete(draft: LiveDraft): boolean {
  return draft.engine.status === 'complete';
}

/** Every card the local player took, in pick order. */
export function myPool(draft: LiveDraft): DraftCard[] {
  return (draft.engine.pools[MY_SEAT] ?? []) as DraftCard[];
}

function validated(state: DraftState): DraftView {
  return expectDraftView(viewFor(state, MY_SEAT), 'live engine payload');
}
