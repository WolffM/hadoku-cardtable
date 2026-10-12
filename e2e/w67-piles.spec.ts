/**
 * Alice's huge graveyard, on `w67-piles.state`: 31 cards with Think Twice buried in the middle, and
 * Forge offers its flashback. One match, three of the operator's asks.
 *
 * The pile view. The operator, 2026-10-09: *"i need some solution for when the graveyard and exile get
 * very large. i dont necessarily want to make them scrollable, but i do need a way to reach certain
 * cards which is currently impossible."* In the pile on the board Think Twice's name strip is squeezed
 * to nothing, so it cannot be hovered or clicked. Clicking the pile opens a view of every card in it:
 * hovering Think Twice there opens the one inspector, clicking it picks it up (the view gives way to
 * it) and a click on the table casts its flashback. Esc and a click outside close it; bob's pile opens
 * the same way on alice's screen; nothing of it reaches bob's screen.
 *
 * The inspector and the view. The operator, 2026-10-10: *"when expand graveyard/exile is clicked can
 * we dispose the currently expanded card being shown? and also make sure the cursor has to exit the
 * current expand trigger zone before it can trigger a new expand?"* Alice hovers the top card of her
 * graveyard (the inspector opens on it) and clicks it (the pile view opens): the inspector is gone at
 * once. A small move inside that card brings nothing back. A card in the open view is read as usual,
 * beside the view; coming back onto the graveyard card after leaving it reads that card again.
 *
 * Art. The operator, 2026-10-09: *"i really dont want a no-art card to show ever"*. Bob's page holds
 * Think Twice's art back (a CDN on a cold fetch) while every other card's art arrives at once; from
 * alice's pick-up click until the stack has emptied, bob's page must never draw a stack card face
 * without its art. Then the art arrives and nothing is left on the board.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offeredNamed, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const view = (page: Page) => page.getByTestId('pile-view');
const inspector = (page: Page) => page.locator('[data-inspect]');
const pile = (page: Page, owner: 'you' | 'them') => page.locator(`.seat [data-zone="graveyard"][data-owner="${owner}"]`);

/** The page never scrolls: the document and the board both fit their boxes. */
const scrolls = (page: Page) =>
  page.evaluate(() => {
    const doc = document.scrollingElement!;
    const board = document.querySelector<HTMLElement>('.board')!;
    return {
      doc: doc.scrollWidth > doc.clientWidth || doc.scrollHeight > doc.clientHeight,
      board: board.scrollWidth > board.clientWidth || board.scrollHeight > board.clientHeight,
    };
  });

/** How much of a buried card the pile leaves visible, and whether the pointer at the middle of that strip is on it. */
const strip = (page: Page, id: number) =>
  page.evaluate((cardId) => {
    const li = document.querySelector<HTMLElement>(`.seat [data-zone="graveyard"] li[data-card-id="${cardId}"]`)!;
    const next = li.nextElementSibling as HTMLElement | null;
    const box = li.getBoundingClientRect();
    const px = next === null ? box.height : Math.max(0, next.getBoundingClientRect().top - box.top);
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + px / 2);
    return { px: Math.round(px * 10) / 10, x: box.left + box.width / 2, y: box.top + px / 2, hit: at?.closest('li[data-card-id]')?.getAttribute('data-card-id') ?? null };
  }, id);

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The graveyard card with the most of itself showing, not one Forge offers: its id, name and the middle of what shows. */
const topCard = (page: Page) =>
  page.evaluate(() => {
    const lis = Array.from(document.querySelectorAll<HTMLElement>('.seat [data-zone="graveyard"][data-owner="you"] li[data-card-id]'));
    let best: { id: string; name: string; x: number; y: number; px: number } | null = null;
    for (const li of lis) {
      if (li.querySelector('[data-selectable="true"]') !== null || li.getAttribute('data-selectable') === 'true') continue;
      const next = li.nextElementSibling as HTMLElement | null;
      const box = li.getBoundingClientRect();
      const px = next === null ? box.height : Math.max(0, next.getBoundingClientRect().top - box.top);
      if (best === null || px > best.px) {
        best = { id: li.getAttribute('data-card-id')!, name: li.querySelector('.card__name')?.textContent?.trim() ?? '', x: box.left + box.width / 2, y: box.top + px / 2, px };
      }
    }
    return best;
  });

/** A card-sized image, as text (never image bytes). */
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>';

type Frame = { t: number; placed: number; backs: number; noArt: string[] };

/** Bob's page: one entry per animation frame whose drawing changed — the placed stack cards, and any face among them drawn without its art. */
async function recordBob(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    (window as unknown as { __art: () => Frame[] }).__art = () => frames;
    let last = '';
    const tick = (): void => {
      const placed = Array.from(document.querySelectorAll('[data-placed-spell]'));
      const frame: Frame = {
        t: Date.now(),
        placed: placed.length,
        backs: placed.filter((el) => el.querySelector('[data-card-back]') !== null).length,
        noArt: placed
          .flatMap((el) => Array.from(el.querySelectorAll('.card')))
          .filter((card) => {
            const img = card.querySelector('img.card__art') as HTMLImageElement | null;
            return img === null || img.style.display === 'none' || !img.complete || img.naturalWidth === 0;
          })
          .map((card) => card.querySelector('.card__name')?.textContent ?? '?'),
      };
      const key = JSON.stringify({ ...frame, t: 0 });
      if (key !== last) {
        last = key;
        frames.push(frame);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test(titled('a huge graveyard opens as a pile view: the inspector gives way to it, a buried flashback card is read and cast from it, and the other screen never draws it without its art'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-piles');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    let twice: number | undefined;
    await expect
      .poll(async () => (twice = await offeredNamed(alice.page, 'Think Twice')), { timeout: 60_000, message: "alice is offered Think Twice's flashback from her graveyard" })
      .not.toBeUndefined();
    const id = twice!;
    await expect(pile(alice.page, 'you')).toHaveAttribute('data-count', '31');
    await expect(pile(alice.page, 'them')).toHaveAttribute('data-count', '20');

    // Think Twice's art URL, read off the tile bob's screen already draws in her graveyard.
    const twiceArt = await bob.page.locator(`.seat [data-zone="graveyard"][data-owner="them"] li[data-card-id="${id}"] img.card__art`).evaluate((img) => (img as HTMLImageElement).src);
    expect(twiceArt, "bob's screen names Think Twice's art").toMatch(/^https:/);

    // The harness blocks every request off 127.0.0.1. Bob's page answers each art URL with a stand-in at
    // once — except Think Twice's, held until `release`. Then a reload, so his page starts cold.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const requests: { t: number; twice: boolean }[] = [];
    await bob.page.route(/^https:\/\/(cards\.scryfall\.io|cdn\.hadoku\.me)\//, async (route) => {
      const isTwice = route.request().url() === twiceArt;
      requests.push({ t: Date.now(), twice: isTwice });
      if (isTwice) await held;
      await route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN });
    });
    await bob.page.reload();
    await expect(bob.page.locator('.seat [data-zone="graveyard"][data-owner="them"]'), 'bob is back at the table').toHaveAttribute('data-count', '31', { timeout: 30_000 });
    await bob.page.waitForTimeout(1500);
    await recordBob(bob.page);

    // (a) On the board the buried card is out of reach: its strip is squeezed to a few px. (A pointer placed to
    // the pixel still finds it — the red on main, 2026-10-09, measured 3.5 px — but no hand does.)
    const s = await strip(alice.page, id);
    await alice.page.mouse.move(s.x, s.y);
    await alice.page.waitForTimeout(300);
    const seenOnBoard = (await inspector(alice.page).count()) > 0 ? ((await inspector(alice.page).locator('.card__name').first().textContent()) ?? '') : '';
    console.log(`[piles] board strip of Think Twice #${id}: ${s.px}px, pointer at its middle is on #${s.hit}, inspector shows "${seenOnBoard}"`);
    expect(s.px, 'the buried card is squeezed out of reach on the board').toBeLessThan(6);
    await alice.page.mouse.move(640, 400);

    // (d) Bob's pile, on alice's screen: every one of his cards, Llanowar Elves among them; nothing on bob's screen.
    const theirs = (await pile(alice.page, 'them').boundingBox())!;
    await alice.page.mouse.click(theirs.x + theirs.width / 2, theirs.y + 4);
    await expect(view(alice.page), "clicking bob's graveyard opens its pile view").toHaveCount(1, { timeout: 5_000 });
    await expect(view(alice.page).locator('li[data-card-id]')).toHaveCount(20);
    await expect(view(alice.page).locator('.card__name', { hasText: 'Llanowar Elves' })).toHaveCount(1);
    await expect(view(bob.page), "alice's pile view is hers alone").toHaveCount(0);
    console.log(`[piles] bob's pile view on alice's screen: ${await view(alice.page).locator('li[data-card-id]').count()} cards, bob's screen shows ${await view(bob.page).count()} views`);

    // (c) Esc closes it; so does a click outside.
    await alice.page.keyboard.press('Escape');
    await expect(view(alice.page), 'Esc closes the pile view').toHaveCount(0, { timeout: 2_000 });
    await alice.page.mouse.click(theirs.x + theirs.width / 2, theirs.y + 4);
    await expect(view(alice.page)).toHaveCount(1, { timeout: 5_000 });
    // Outside: a point of her own battlefield the panel does not cover.
    const open = (await view(alice.page).boundingBox())!;
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const outside = [field.x + field.width - 8, field.x + 8, field.x + field.width / 2]
      .map((x) => ({ x, y: field.y + 8 }))
      .find((p) => p.x < open.x || p.x > open.x + open.width || p.y < open.y || p.y > open.y + open.height)!;
    console.log(`[piles] bob's pile view at ${Math.round(open.x)},${Math.round(open.y)} ${Math.round(open.width)}×${Math.round(open.height)}; clicking outside at ${Math.round(outside.x)},${Math.round(outside.y)}`);
    await alice.page.mouse.click(outside.x, outside.y);
    await expect(view(alice.page), 'a click outside closes the pile view').toHaveCount(0, { timeout: 2_000 });
    console.log('[piles] Esc and a click outside each close the view');

    // The inspector gives way to her pile view, and stays away until the pointer leaves the card.
    {
      const top = (await topCard(alice.page))!;
      expect(top, 'a graveyard card shows enough of itself to point at').not.toBeNull();
      console.log(`[w69-pile] graveyard card ${top.name} #${top.id}: ${Math.round(top.px)}px showing, pointer at ${Math.round(top.x)},${Math.round(top.y)}`);

      // Hover: the one inspector reads it.
      await alice.page.mouse.move(top.x, top.y, { steps: 4 });
      await expect(inspector(alice.page).locator('.card__name'), 'hovering the graveyard card opens the inspector on it').toHaveText(top.name, { timeout: 3_000 });

      // Click: the pile view opens and the inspector is gone at once.
      await alice.page.mouse.click(top.x, top.y);
      await expect(view(alice.page), 'clicking the graveyard opens its pile view').toHaveCount(1, { timeout: 5_000 });
      const panel = (await view(alice.page).boundingBox())!;
      const still = await inspector(alice.page).count();
      const shown = still > 0 ? await inspector(alice.page).first().boundingBox() : null;
      console.log(
        `[w69-pile] pile view open at ${Math.round(panel.x)},${Math.round(panel.y)} ${Math.round(panel.width)}×${Math.round(panel.height)}; inspector panels ${still}` +
          (shown === null ? '' : `, covering ${Math.round(overlap(shown, panel))}px² of the view`),
      );
      await expect(inspector(alice.page), 'the inspector is put away the moment the pile view opens').toHaveCount(0, { timeout: 500 });

      // A small move inside the same card brings nothing back.
      for (const [dx, dy] of [
        [2, 0],
        [-3, 1],
        [4, -1],
      ] as const) {
        await alice.page.mouse.move(top.x + dx, top.y + dy);
        await alice.page.waitForTimeout(150);
      }
      const afterNudge = await inspector(alice.page).count();
      console.log(`[w69-pile] after three small moves inside ${top.name}: inspector panels ${afterNudge}`);
      expect(afterNudge, 'a small move inside the clicked card does not bring the inspector back').toBe(0);

      // A card in the open view is read as usual, beside the view.
      const inView = view(alice.page).locator('li[data-card-id]').nth(3);
      const vb = (await inView.boundingBox())!;
      const inViewName = ((await inView.locator('.card__name').first().textContent()) ?? '').trim();
      await alice.page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2, { steps: 6 });
      await expect(inspector(alice.page).locator('.card__name'), 'a card in the view is read in the inspector').toHaveText(inViewName, { timeout: 3_000 });
      const beside = (await inspector(alice.page).boundingBox())!;
      console.log(`[w69-pile] hovering ${inViewName} in the view: inspector covers ${Math.round(overlap(beside, panel))}px² of the view`);
      expect(overlap(beside, panel), 'the inspector stands beside the view').toBe(0);

      // Back onto the graveyard card after leaving it: read again.
      await alice.page.mouse.move(top.x, top.y, { steps: 6 });
      await expect(inspector(alice.page).locator('.card__name'), 'coming back onto the graveyard card reads it again').toHaveText(top.name, { timeout: 3_000 });
      console.log(`[w69-pile] back on ${top.name} after leaving it: inspector reads "${(await inspector(alice.page).locator('.card__name').textContent()) ?? ''}"`);
    }
    await alice.page.keyboard.press('Escape');
    await expect(view(alice.page), 'Esc closes her pile view').toHaveCount(0, { timeout: 2_000 });

    // (b) Alice's own pile: every card at a readable size, nothing scrolls, Think Twice is hovered and cast.
    const mine = (await pile(alice.page, 'you')).locator('li[data-card-id]').first();
    const first = (await mine.boundingBox())!;
    await alice.page.mouse.click(first.x + first.width / 2, first.y + 3);
    await expect(view(alice.page), 'clicking her graveyard opens its pile view').toHaveCount(1, { timeout: 5_000 });
    await expect(view(alice.page).locator('li[data-card-id]')).toHaveCount(31);
    const inView = view(alice.page).locator(`li[data-card-id="${id}"]`);
    const box = (await inView.boundingBox())!;
    const panel = (await view(alice.page).boundingBox())!;
    const overflow = await scrolls(alice.page);
    console.log(`[piles] alice's pile view: 31 cards, Think Twice drawn ${Math.round(box.width)}×${Math.round(box.height)}px, panel ${Math.round(panel.width)}×${Math.round(panel.height)} at ${Math.round(panel.x)},${Math.round(panel.y)}, scrolls doc=${overflow.doc} board=${overflow.board}`);
    expect(box.width, 'the buried card is drawn whole in the view').toBeGreaterThanOrEqual(40);
    expect(overflow, 'the pile view makes nothing scroll').toEqual({ doc: false, board: false });
    await expect(inView, 'the offered card is offered in the view too').toHaveAttribute('data-selectable', 'true');

    await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(inspector(alice.page).locator('.card__name'), 'hovering it in the view opens the inspector on it').toHaveText('Think Twice', { timeout: 3_000 });
    console.log('[piles] hovering Think Twice in the view shows it in the inspector');
    // The one inspector stands clear of the open view, as it does of an open decision window.
    const shown = (await inspector(alice.page).boundingBox())!;
    const rect = (b: { x: number; y: number; width: number; height: number }): string =>
      `${Math.round(b.x)},${Math.round(b.y)}–${Math.round(b.x + b.width)},${Math.round(b.y + b.height)}`;
    const overlapW = Math.max(0, Math.min(shown.x + shown.width, panel.x + panel.width) - Math.max(shown.x, panel.x));
    const overlapH = Math.max(0, Math.min(shown.y + shown.height, panel.y + panel.height) - Math.max(shown.y, panel.y));
    console.log(`[piles] inspector ${rect(shown)}, pile view ${rect(panel)}, overlap ${Math.round(overlapW)}×${Math.round(overlapH)}px`);
    expect(overlapW * overlapH, 'the inspector covers the pile view').toBe(0);

    // A click picks the offered card up, as a hand card's does, and the view gives way to it; the next
    // press, on the table, is the release that casts it.
    const clickedAt = Date.now();
    await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(view(alice.page), 'picking the card up closes the view').toHaveCount(0, { timeout: 3_000 });
    await expect(alice.page.locator(`.seat [data-zone="graveyard"] li[data-card-id="${id}"]`), 'Think Twice is in her hand').toHaveAttribute('data-cast-lift', 'lifted');
    await alice.page.mouse.click(field.x + field.width / 2, field.y + field.height / 2);

    await expect
      .poll(async () => (await bob.page.locator('.seat [data-zone="exile"][data-owner="them"] .card__name', { hasText: 'Think Twice' }).count()) > 0, {
        timeout: 20_000,
        message: "Think Twice's flashback resolves into her exile on bob's screen",
      })
      .toBe(true);
    await expect.poll(() => stackCount(bob.page), { timeout: 10_000, message: 'the stack is empty' }).toBe(0);
    const heldUntil = Date.now();
    release();
    await bob.page.waitForTimeout(1000);

    const frames = (await bob.page.evaluate(() => (window as unknown as { __art: () => Frame[] }).__art())).filter((f) => f.t >= clickedAt);
    const line = (f: Frame): string => `${f.t - clickedAt}ms placed ${f.placed} backs ${f.backs}${f.noArt.length > 0 ? ` NO-ART[${f.noArt.join(';')}]` : ''}`;
    console.log(`[click-art] bob's frames from alice's click: ${frames.map(line).join(' → ')}`);
    const twiceAsked = requests.filter((r) => r.twice);
    console.log(
      `[click-art] Think Twice's art asked ${twiceAsked.length}× (${twiceAsked.map((r) => `${r.t - clickedAt}ms`).join(', ')}), held until ${heldUntil - clickedAt}ms; ${requests.length} art requests in all`,
    );
    const noArt = frames.filter((f) => f.noArt.length > 0);
    console.log(`[click-art] ${noArt.length} frame(s) with a stack face missing its art${noArt[0] === undefined ? '' : `, first at ${noArt[0].t - clickedAt}ms`}`);
    expect(frames.some((f) => f.placed > 0), "bob's screen drew her spell on the stack").toBe(true);
    expect(noArt.map(line), 'bob sees a stack card face without its art').toEqual([]);
    expect(frames.at(-1)?.placed ?? 0, 'nothing of hers is left on the stack once it resolved').toBe(0);
  } finally {
    await stack.stop();
  }
});
