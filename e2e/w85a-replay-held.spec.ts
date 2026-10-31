/**
 * A held card in a replay — wave 85 (w85a), from the trailer's cut 2: "the active player's held card
 * is drawn face down mid-drag in a replay; replays show hands face up".
 *
 * `w85a-held.state`: alice, in her first main phase, lifts Memnite, carries it over the board for a few
 * seconds and lets go on her battlefield; it is cast and resolves, and she concedes. Played back at
 * `#/replay/<id>`, the back her recorded pointer carries is drawn as Memnite's face, never a back. The
 * live board stays as it was: the other seat sees a back with no face while she holds it (the wire
 * names no held card, `apps/ui/src/play/live/presence.ts`'s `REPLAY_HELD_EVENT`).
 *
 * `[w85a]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { handCardNamed, makeTitled, offered } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Every stand-in back the board's overlay draws now: whether it shows a face, and whose. */
const backs = (page: Page): Promise<{ face: boolean; name: string | null }[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-board-overlay] .presence__back'), (b) => ({
      face: b.hasAttribute('data-face'),
      name: b.querySelector('.card__name')?.textContent?.trim() ?? null,
    })),
  );

test(titled('a replay draws the held card face up — the back the pointer carries is Memnite — while the live opponent only ever sees a back'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'w85a-held');
    const memnite = await expect
      .poll(() => handCardNamed(alice.page, 'Memnite'), { timeout: 45_000, message: 'Memnite is in her hand' })
      .not.toBeUndefined()
      .then(async () => (await handCardNamed(alice.page, 'Memnite'))!);
    await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'Memnite is offered' }).toContain(memnite);

    // A slow carry: lifted, moved across the board for ~3 s, let go on her battlefield. The first act
    // after a scenario start can be dropped (ledger AB15), so the carry is repeated while it is in hand.
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').first().boundingBox())!;
    const liveBacks: { face: boolean; name: string | null }[] = [];
    for (let attempt = 0; attempt < 3 && (await handCardNamed(alice.page, 'Memnite')) !== undefined; attempt += 1) {
      const box = (await alice.page.locator(`[data-board-card="${memnite}"]`).boundingBox())!;
      await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await alice.page.mouse.down();
      if ((await alice.page.locator(`[data-board-card="${memnite}"]`).getAttribute('data-cast-lift')) !== 'lifted') {
        await alice.page.mouse.up();
        await alice.page.waitForTimeout(1_000);
        continue;
      }
      for (let i = 0; i <= 12; i += 1) {
        await alice.page.mouse.move(field.x + field.width * (0.2 + i * 0.05), field.y + field.height * 0.45, { steps: 4 });
        await alice.page.waitForTimeout(250);
        liveBacks.push(...(await backs(bob.page)));
      }
      await alice.page.mouse.up();
      await expect
        .poll(async () => (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card', { hasText: 'Memnite' }).count()) > 0, { timeout: 15_000 })
        .toBe(true)
        .catch(() => undefined);
    }
    await expect(alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card', { hasText: 'Memnite' }), 'Memnite resolved onto her battlefield').toHaveCount(1, { timeout: 30_000 });
    console.log(`[w85a] live: bob saw ${liveBacks.length} back samples while she held it, faces ${liveBacks.filter((b) => b.face).length}`);
    expect(liveBacks.length, 'bob saw her held card').toBeGreaterThan(0);
    expect(liveBacks.filter((b) => b.face || b.name !== null), 'live: only ever a back, never a face').toEqual([]);

    await alice.page.getByTestId('live-concede').click();
    await alice.page.getByTestId('live-concede-yes').click();
    await expect(bob.page.getByTestId('game-result'), 'bob sees the result').toBeVisible({ timeout: 30_000 });

    let held = 0;
    await expect
      .poll(
        async () => {
          const res = await alice.context.request.get(`${stack.origin}${PREFIX}/api/replays/${matchId}`);
          if (!res.ok()) return res.status();
          const body = (await res.json()) as { presence: { presence: { held: boolean } }[] };
          held = body.presence.filter((p) => p.presence.held).length;
          return res.status();
        },
        { timeout: 30_000, message: 'the recording is served' },
      )
      .toBe(200);
    console.log(`[w85a] recording ${matchId}: ${held} held pointer lines`);
    expect(held, 'the carry is in the recording').toBeGreaterThan(0);

    const carol = await openFriend(browser, 'carol');
    await carol.page.goto(`${stack.origin}${PREFIX}/#/replay/${matchId}`);
    await expect(carol.page.getByTestId('replay-bar'), 'the transport bar').toBeVisible({ timeout: 30_000 });
    const seen: { face: boolean; name: string | null }[] = [];
    await expect
      .poll(
        async () => {
          seen.push(...(await backs(carol.page)));
          return (await carol.page.getByTestId('replay-bar-play').textContent()) === '↺';
        },
        { timeout: 120_000, intervals: [50], message: 'the replay plays to its end' },
      )
      .toBe(true);
    const faces = seen.filter((b) => b.face);
    console.log(`[w85a] replay: ${seen.length} back samples, ${faces.length} with a face, names ${JSON.stringify([...new Set(seen.map((b) => b.name))])}`);
    expect(seen.length, 'the replay drew her held card').toBeGreaterThan(0);
    expect(seen.filter((b) => !b.face), 'replay: the held card is never a bare back').toEqual([]);
    expect([...new Set(faces.map((b) => b.name))], 'the face is the card she held').toEqual(['Memnite']);
  } finally {
    await stack.stop();
  }
});
