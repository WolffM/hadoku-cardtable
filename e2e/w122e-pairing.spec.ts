/**
 * Humans first (the operator, 2026-11-16, amending the full
 * Swiss): "humans first. In a pod with two or more humans, pair humans with
 * each other in every round where they have not met; a bot only takes a
 * human who has no human left to play."
 *
 * Measured against the real log of pod `r-67759762d971` (2026-11-17,
 * `/home/hadoku/.pm2/logs/cardtable-out.log`): 2 humans + 6 bots, both
 * humans seated first (seats 0-1) and the bots after (seats 2-7). Its
 * `pod-rounds-started` at 05:21:23Z paired 2 live tables (each human against
 * a bot, four seats over under the OLD across-the-table seat formula) and 2
 * bot games. Seated the SAME way here — adjacent, not manually placed
 * "across the table" — this is the scenario the fix changes: round 1 must
 * pair the two humans with EACH OTHER, not each with a bot.
 *
 * Draft to completion and build minimal decks (every bot's deck legal by
 * default), then press Play: `#dealPodRounds` deals round 1 at that point,
 * before any match is ever opened, so this never needs to draw a board or
 * play a game — only the room's own pod record, read back over the API.
 */
import { trimMainDeck } from './deckBuilder.ts';
import { arrangePod, draftUntilDone, fillWithAi, readyPod } from './podSeats.ts';
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromAddress } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

interface PodWire {
  pairings: { players: [string, string] }[];
  bye: string | null;
}
interface RoomWire {
  members: { id: string; name: string }[];
  game: { pod: PodWire | null };
}

test(
  titled('a two-human draft pod, seated adjacent (not across the table): round 1 pairs them with each other, not a bot'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(6 * 60_000);

    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    let alice: Player | undefined;
    let bob: Player | undefined;
    try {
      alice = await openFriend(browser, 'alice');
      bob = await openFriend(browser, 'bob');
      const players = [alice, bob];

      /* ── alice makes the pod, bob finds it ────────────────────────── */
      await alice.page.goto(`${origin}${PREFIX}/`);
      const podName = `e2e w122e pairing ${Date.now()}`;
      await submitCreateRoom(alice.page, { name: podName, gameType: 'draft' });
      const roomId = await roomIdFromAddress(alice.page);
      const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
      await bob.page.goto(roomUrl);
      await expect(bob.page.getByTestId('draft-lobby'), 'bob: joined the room').toBeVisible({ timeout: UI_TIMEOUT });

      // Real ids, the same way as `e2e/w72-pod.spec.ts` (the room's REAL id,
      // not the harness's device-tier fallback), and `PodSeats`' own
      // "which seat is mine" needs it resolved before `arrangePod` can seat them.
      const roomBody = (await alice.page.evaluate(
        (id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
        roomId,
      )) as RoomWire;
      for (const p of players) {
        const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
        if (me === undefined) throw new Error(`${p.name}: not found among the room's own members`);
        await p.context.route('**/session/whoami', (route) =>
          route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: `e2e-${p.name}` } }),
        );
        await p.page.reload();
        await resizeWindow(p.page, { width: 1280, height: 800 });
      }
      const aliceId = roomBody.members.find((m) => m.name === 'e2e-alice')!.id;
      const bobId = roomBody.members.find((m) => m.name === 'e2e-bob')!.id;

      /* ── seated ADJACENT (seats 0, 1) — deliberately not "across the table" ── */
      for (const p of players) await expect(p.page.getByTestId('pod-seats'), `${p.name}: the pod's 8 seats are up`).toBeVisible({ timeout: UI_TIMEOUT });
      await arrangePod([
        [alice.page, 0],
        [bob.page, 1],
      ]);
      for (const p of players) await expect(p.page.getByTestId('seat-stand'), `${p.name}: holds their own seat`).toBeVisible({ timeout: UI_TIMEOUT });

      for (const p of players) await readyPod(p.page);
      // Every remaining seat (2-7) fills with a bot — the pod's own six,
      // exactly the shape of the measured prod pod.
      await fillWithAi(alice.page, UI_TIMEOUT);
      for (const p of players) await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });

      await Promise.all(players.map((p) => draftUntilDone(p.page)));
      for (const p of players) {
        await expect(p.page.getByTestId('deck-editor'), `${p.name}: the finished draft opens the editor`).toBeVisible({ timeout: UI_TIMEOUT });
        await trimMainDeck(p.page, 40, p.name);
        await p.page.getByTestId('play-deck').click();
      }

      // Alice's Play waits on bob's; bob's deals round 1 — then the pod
      // screen starts each table by itself. Read the pod record back
      // rather than follow either page into a match: the pairing itself is
      // the thing under test.
      await expect
        .poll(
          async () => {
            const res = await alice!.context.request.get(`${origin}${PREFIX}/api/rooms/${roomId}`);
            const body = (await res.json()) as RoomWire;
            return body.game.pod?.pairings.length ?? 0;
          },
          { message: 'round 1 is dealt', timeout: UI_TIMEOUT },
        )
        .toBeGreaterThan(0);

      const res = await alice.context.request.get(`${origin}${PREFIX}/api/rooms/${roomId}`);
      const body = (await res.json()) as RoomWire;
      const pod = body.game.pod!;
      expect(pod.bye, '8 entrants, no bye').toBeNull();

      const theirTable = pod.pairings.find((p) => p.players.includes(aliceId) || p.players.includes(bobId));
      expect(theirTable, 'alice and bob are in some live round-1 pairing').not.toBeUndefined();
      expect(new Set(theirTable!.players), 'round 1 pairs the two humans with EACH OTHER, not with a bot').toEqual(new Set([aliceId, bobId]));
    } finally {
      // `stack.stop()` itself closes every open `openFriend` context
      // (`e2e/w72-pod.spec.ts`'s own note on why — closing them here too
      // would remove them from that registry first).
      await stack.stop();
    }
  },
);
