/**
 * A tournament room's own moves, through the UI: the leader opens it and turns Tournament on, entrants
 * sit, pick a deck and ready, and a loser concedes a game. Shared by every tournament spec.
 */
import { expect, type Browser } from '@playwright/test';

import { PREFIX } from '../identities.ts';
import { resizeWindow, roomIdFromHash } from './board.ts';
import { openFriend, type Friend } from './browser.ts';
import { submitCreateRoom } from './rooms.ts';

const UI_TIMEOUT = 30_000;

/** Routes `/session/whoami` to this member's own real id, and reloads so `useWhoami()` re-resolves it — `e2e/w72-pod.spec.ts`'s own fix for "which seat is mine" (`PodSeats`). */
export async function routeRealIdentity(p: Friend, roomId: string): Promise<void> {
  const roomBody = (await p.page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as { members: { id: string; name: string }[] };
  const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
  if (me === undefined) throw new Error(`${p.name}: not found among the room’s own members`);
  await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'friend', name: `e2e-${p.name}` } }));
  await p.page.reload();
  await resizeWindow(p.page, { width: 1280, height: 800 });
}

/** Alice leads, Bob joins, both identified for real, both resized — the shared opening every test here starts with. */
export async function openRoomWithLeader(browser: Browser, origin: string, roomName: string): Promise<{ roomId: string; roomUrl: string; alice: Friend; bob: Friend }> {
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  await alice.page.goto(`${origin}${PREFIX}/`);
  await submitCreateRoom(alice.page, { name: roomName, gameType: 'constructed-1v1', mode: 'classic' });
  const roomId = await roomIdFromHash(alice.page);
  const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
  await bob.page.goto(roomUrl);
  await expect(bob.page.getByTestId('constructed'), 'bob: joined the room').toBeVisible({ timeout: UI_TIMEOUT });
  for (const p of [alice, bob]) await routeRealIdentity(p, roomId);
  return { roomId, roomUrl, alice, bob };
}

/** Turns Tournament on and sets Decks — the leader's own two controls, both read live on every browser. */
export async function enableTournament(alice: Friend, bob: Friend, decks: 'locked' | 'per-round'): Promise<void> {
  // A controlled radio: click, then wait for the room to say so (`toBeChecked`).
  await alice.page.getByTestId('room-event-tournament').click();
  await expect(alice.page.getByTestId('room-event-tournament')).toBeChecked();
  for (const p of [alice, bob]) await expect(p.page.getByTestId('tournament-lobby'), `${p.name}: the pod lobby replaces the 1v1 seats`).toBeVisible({ timeout: UI_TIMEOUT });
  if (decks === 'per-round') {
    // Decks is a Match rule: open them, choose, close.
    await alice.page.getByTestId('match-rules').click();
    await alice.page.getByTestId('tournament-decks-per-round').click();
    await expect(alice.page.getByTestId('tournament-decks-per-round')).toBeChecked();
    await alice.page.getByTestId('match-rules-popover-close').click();
  }
}

/**
 * Sits the given seat — by its own seat number (`e2e/w72-pod.spec.ts`'s own
 * way of sitting several players down without a race over which "open seat"
 * is whose), nothing else. `sitPod` is one of ruling 7's own trigger points
 * (`#maybeLockTournament`), but seating alone never completes the field —
 * only a human's OWN readiness (Classic: a deck; Random/Gauntlet: Ready) can.
 */
export async function sit(p: Friend, seat: number): Promise<void> {
  await p.page.locator(`[data-testid="pod-seat-sit"][data-seat="${seat}"]`).click();
  await expect(p.page.getByTestId('pod-seat-stand'), `${p.name}: holds a pod seat`).toBeVisible({ timeout: UI_TIMEOUT });
}

/**
 * Picks the first legal deck on offer — Classic's OWN readiness condition
 * for the lock (`room/lobby.ts`'s `#lockTournament`: `hasLegalSeatDeck`,
 * never the Ready button). Ruling 7's own lock is not instrumented on the
 * deck PUT itself (`http/routes.ts`, outside this lane's claim), so picking
 * a deck alone never fires it — but it means this player now COUNTS as
 * ready for it, whether or not they ever press Ready, the next time
 * anything else does (another sit, an AI seated, anyone's own Ready).
 */
export async function pickDeck(p: Friend): Promise<void> {
  await expect(p.page.getByTestId('deck-mine'), `${p.name}: the tournament lobby’s own deck chooser`).toBeVisible({ timeout: UI_TIMEOUT });
  const tile = p.page.getByTestId('deck-mine').getByTestId('deck-option').first();
  await tile.click();
  await expect(p.page.getByTestId('ready-toggle'), `${p.name}: a legal deck enables Ready`).toBeEnabled({ timeout: UI_TIMEOUT });
}

/** Sits, then picks a deck. */
async function sitPick(p: Friend, seat: number): Promise<void> {
  await sit(p, seat);
  await pickDeck(p);
}

/**
 * Presses Ready — one of ruling 7's own trigger points. For Classic this is
 * NOT what the lock itself waits on (the deck already is, `pickDeck`'s own
 * doc), so by the time this player already holds one, EITHER seat's own
 * Ready can be the one that completes the field; the lock may fire inside
 * THIS very click, racing the UI past ever painting "pressed" before the
 * screen moves on to the round — so this does not assert the pressed state,
 * only that the click landed. Callers prove the lock's own effect downstream
 * (the round starting, the lobby seats gone, standings), not this button.
 */
export async function ready(p: Friend): Promise<void> {
  await p.page.getByTestId('ready-toggle').click();
}

/** `sitPick` then `ready`, in one call — most callers want both. */
export async function sitPickReady(p: Friend, seat: number): Promise<void> {
  await sitPick(p, seat);
  await ready(p);
}

/** Concedes a game and waits for the result — `e2e/w72-pod.spec.ts`'s own fast way to settle a series. */
export async function concedeToResult(loser: Friend, winner: Friend): Promise<void> {
  await loser.page.getByTestId('live-concede').click();
  await loser.page.getByTestId('live-concede-yes').click();
  await expect(winner.page.getByTestId('game-result')).toBeVisible({ timeout: UI_TIMEOUT });
}
