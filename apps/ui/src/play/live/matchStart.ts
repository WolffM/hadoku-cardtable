/**
 * Into a match the room has just started, with its `g.match-start` sound (the
 * operator, 2026-10-11: *"a 'start of game' sound that plays before the
 * coinflip … when both players are ready and the room is initiated"*).
 *
 * It sounds here, at the hand-off from the room (both ready, Start, Rematch,
 * a bot game) and not on the match screen, because only this moment knows the
 * match is new: a reload or a rejoin opens the same screen on a match already
 * under way. Once per match on this page, however many paths ask (the starting
 * screen's own answer and its follow of the room's `matchId` both arrive).
 */
import { roomsClient, type RoomView } from '../../rooms/api.ts';
import { navigate } from '../../screens/route.ts';
import { playRole } from '../../sound/index.ts';
import { closeMatch, subscribe, type LiveMatch } from './match.ts';

const sounded = new Set<string>();
/** Every match this page has been carried into, by a room or a start. */
const followed = new Set<string>();
/** Every table of a room's rounds this page has been carried to. */
const tablesFollowed = new Set<string>();

/**
 * A room carries its players into a match ONCE (the operator, 2026-10-19: *"the
 * initial force into the game should only happen once when the game starts"*):
 * whoever goes back to the room from it stays there, and goes back in from the
 * room's own link. A reload is a new page, and is carried in once again.
 */
export function followMatchOnce(matchId: string, isNew: boolean): void {
  if (followed.has(matchId)) return;
  if (isNew) openNewMatch(matchId);
  else {
    followed.add(matchId);
    enter(matchId);
  }
}

/**
 * A paired player is carried to their own table page ONCE per pairing, as a
 * match is (the tracker's reconciliation of the two rulings above with ruling 8,
 * `docs/planning/tournament-mode-plan.md`): back on the hub by choice, they stay.
 */
export function followTableOnce(roomId: string, tableId: string, atTable: string | undefined): void {
  if (tablesFollowed.has(tableId)) return;
  tablesFollowed.add(tableId);
  // Already there counts: leaving it for the hub is by choice.
  if (atTable !== tableId) navigate({ kind: 'room', roomId, tableId });
}

export function openNewMatch(matchId: string): void {
  followed.add(matchId);
  if (!sounded.has(matchId)) {
    sounded.add(matchId);
    playRole('g.match-start');
  }
  enter(matchId);
}

/*
 * ## The walk from the room to the board (the operator, 2026-10-28)
 *
 * *"theres a brief transition between sitting down and playing that looks ugly? seems like a
 * loading screen."* It was one: the route changed the moment the room said a match existed, and
 * the match screen then spent the socket's handshake, the join and the first snapshot drawing an
 * empty shell and "Connecting…" (`e2e/w79d-boot.spec.ts` measured ~200 ms of it locally).
 *
 * So the match is opened HERE, while the room is still on the screen, and the route changes once
 * the board has something to draw: its first state, or the refusal it will say instead. The match
 * screen adopts that same handle ({@link takeWarmMatch}), so nothing connects twice. The page also
 * holds a match's board back until it knows the match's room (`App.tsx`, `useMatchRoomId`), so that
 * is asked here too and the route changes with both answers in hand ({@link knownRoomOfMatch}).
 * Every way into
 * a new match — both Ready, a table's pairing, Rematch, a bot game, the room list — comes through
 * {@link enter}, so they all walk the same way. A page opened on a match URL (a reload, a link)
 * has no room to keep up and still says "Connecting…" while it joins.
 */

/** How long the room stays up for a board that has not drawn; after it the match screen says why. */
export const BOARD_WAIT_MS = 5_000;

/** How the page opens a match. The match screen registers it; with none, the route changes at once. */
let opener: ((matchId: string) => LiveMatch) | null = null;
/** Matches opened before their screen, waiting to be adopted by it. */
const warm = new Map<string, LiveMatch>();
/** Each entered match's room, as the server answered it (`null`: none). */
const roomsKnown = new Map<string, RoomView | null>();

/** The room of a match this page entered, once the server has answered; `undefined` until then. */
export function knownRoomOfMatch(matchId: string): RoomView | null | undefined {
  return roomsKnown.get(matchId);
}

export function warmMatchesWith(open: ((matchId: string) => LiveMatch) | null): void {
  opener = open;
}

/** The handle {@link enter} opened for this match, handed over once: the screen owns it from here. */
export function takeWarmMatch(matchId: string): LiveMatch | null {
  const match = warm.get(matchId) ?? null;
  warm.delete(matchId);
  return match;
}

function enter(matchId: string): void {
  if (opener === null) {
    navigate({ kind: 'match', matchId });
    return;
  }
  if (warm.has(matchId)) return;
  const match = opener(matchId);
  warm.set(matchId, match);
  let roomAnswered = false;
  let gone = false;
  const go = (): void => {
    if (gone) return;
    gone = true;
    stop();
    clearTimeout(timer);
    navigate({ kind: 'match', matchId });
    // Still not adopted long after: the page went somewhere else, and the handle is nobody's.
    setTimeout(() => {
      if (warm.get(matchId) === match) closeMatch(takeWarmMatch(matchId)!);
    }, BOARD_WAIT_MS);
  };
  const settled = (): void => {
    if (roomAnswered && (match.view !== null || match.lastError !== null)) go();
  };
  const stop = subscribe(match, settled);
  const timer = setTimeout(go, BOARD_WAIT_MS);
  const answered = (room: RoomView | null | undefined): void => {
    if (room !== undefined) roomsKnown.set(matchId, room);
    roomAnswered = true;
    settled();
  };
  // A failed ask is not "no room": the page asks again for itself.
  roomsClient()
    .roomOfMatch(matchId)
    .then(answered, () => answered(undefined));
}

/** A fresh page's memory — what each test stands for. */
export function forgetMatchesFollowed(): void {
  followed.clear();
  tablesFollowed.clear();
  for (const match of warm.values()) closeMatch(match);
  warm.clear();
  roomsKnown.clear();
}

/** Whether this page sounded the match's start, for the match's own sound telemetry. */
export function matchStartSounded(matchId: string): boolean {
  return sounded.has(matchId);
}
