/**
 * Split & randomize (wave 84 §w84b), against the real built server: a draft room of 9 is one list of seats,
 * and only once everyone is ready does its leader get Split & randomize (the operator, 2026-10-31: *"it would
 * be nice to have a 'split & randomize' button after everyone readies up and before the drafting actually
 * starts. that would give everyone time to go to their own rooms."*). The split is 5 + 4, every browser shows
 * the pods with its own marked, and a moment later each drafter lands in their own pod's draft.
 *
 * Alice leads and Bob joins in real browsers; seven more drafters join, sit and ready over HTTP alone, each
 * on its own session. They never open the draft, so each pod's table counts its humans as dealt: Alice's
 * draft shows her own pod's size, Bob's his.
 *
 * `[w84b]` lines are the evidence: the seats, the pods, each browser's draft table.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import { PREFIX, SESSION_COOKIE } from './identities.ts';
import { makeTitled, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { routeRealIdentity, sit } from './play/tournament.ts';
import { readyPod } from './podSeats.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

interface PodBody {
  members: { id: string; name: string }[];
  pod: { phase: string; seats: ({ memberId: string } | null)[]; pods?: string[][] } | null;
}

async function roomBody(f: Friend, roomId: string): Promise<PodBody> {
  return (await f.page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as PodBody;
}

/** A drafter with no browser: their own session, joined, seated in the first open seat (or one more), and ready. */
async function drafterOverHttp(browser: import('@playwright/test').Browser, origin: string, roomId: string, name: string): Promise<APIRequestContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  const api = `${origin}${PREFIX}/api/rooms/${roomId}`;
  for (const [path, data] of [['join', {}], ['pod/sit', {}], ['ready', { ready: true }]] as const) {
    const res = await context.request.post(`${api}/${path}`, { data });
    expect(res.status(), `${name}: ${path}`).toBe(200);
  }
  return context.request;
}

test(titled('nine drafters: the leader splits the ready room 5 + 4 at random, and each lands in their own pod’s draft'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `w84b split ${Date.now()}`, gameType: 'draft' });
    const roomId = await roomIdFromHash(alice.page);
    await bob.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(bob.page.getByTestId('draft-lobby'), 'bob: joined the room').toBeVisible({ timeout: UI_TIMEOUT });
    for (const p of [alice, bob]) await routeRealIdentity(p, roomId);
    await sit(alice, 0);
    await sit(bob, 1);
    for (let i = 3; i <= 9; i++) await drafterOverHttp(browser, stack.origin, roomId, `drafter${i}`);

    // One list of nine seats, no pod in sight.
    await expect(alice.page.getByTestId('pod-seat-8'), 'alice: the ninth seat').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('pod-seats')).not.toContainText(/Pod \d/);
    const seated = await roomBody(alice, roomId);
    console.log(`[w84b] seats: ${seated.pod?.seats.map((s) => s?.memberId ?? '-').join(' ')}`);
    expect(seated.pod?.seats).toHaveLength(9);

    // Not until everyone is ready, and only for the leader.
    await readyPod(bob.page);
    await expect(alice.page.getByTestId('ready-toggle'), 'alice: not ready yet').toBeEnabled({ timeout: 60_000 });
    await expect(alice.page.getByTestId('pod-split'), 'alice: no split before she is ready').toHaveCount(0);
    await readyPod(alice.page);
    await expect(alice.page.getByTestId('pod-split'), 'alice: the room is ready to split').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(bob.page.getByTestId('pod-split'), 'bob: the split is the leader’s').toHaveCount(0);
    // A room past 8 does not deal by itself.
    await expect(alice.page.getByTestId('pod')).toHaveCount(0);

    await alice.page.getByTestId('pod-split').click();
    for (const p of [alice, bob]) {
      await expect(p.page.getByTestId('pod-split-pods'), `${p.name}: the pods are shown`).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(p.page.locator('[data-testid^="pod-split-pod-"][data-mine]'), `${p.name}: their own pod is marked`).toHaveCount(1);
    }
    const split = await roomBody(alice, roomId);
    const pods = split.pod?.pods ?? [];
    console.log(`[w84b] pods: ${JSON.stringify(pods)}`);
    expect(pods.map((p) => p.length)).toEqual([5, 4]);
    expect(new Set(pods.flat())).toEqual(new Set(seated.pod?.seats.flatMap((s) => (s === null ? [] : [s.memberId]))));

    // A moment later each lands in their own pod's draft: a table of that pod's humans, AI filling it to 8.
    for (const p of [alice, bob]) {
      await expect(p.page.getByTestId('pod'), `${p.name}: in the draft`).toBeVisible({ timeout: UI_TIMEOUT });
      const me = split.members.find((m) => m.name === `e2e-${p.name}`)!.id;
      const mine = pods.find((pod) => pod.includes(me))!;
      const tally = p.page.getByTestId('pod-tally');
      await expect(tally, `${p.name}: their own pod's table`).toHaveText(new RegExp(`^${mine.length} people · ${8 - mine.length} bots`), { timeout: UI_TIMEOUT });
      console.log(`[w84b] ${p.name} in pod ${pods.indexOf(mine) + 1}: ${await tally.textContent()}`);
    }
  } finally {
    await stack.stop();
  }
});
