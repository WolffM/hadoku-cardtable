/**
 * Clip: a cube draft. A pod of eight (seven AI), the pack fanned and swept through, a few picks, the grid,
 * and a double-faced card turned over in the inspector with the mouse wheel.
 */
import { test, type Page } from '@playwright/test';

import { fillWithAi, readyPod } from '../podSeats.ts';
import { submitCreateRoom } from '../play/rooms.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { until } from './drive.ts';
import { HERO, openPromoFriend, startFilm, TAGS } from './rig.ts';

const PREFIX = '/cardtable';

const pickable = (page: Page) => page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])');
const poolCount = async (page: Page): Promise<number> => Number((await page.getByTestId('pool-count').textContent().catch(() => '0')) ?? '0');

/** Take the first card on offer, then wait for the next pack (the server paces picks). */
async function pickOne(page: Page): Promise<void> {
  const before = await poolCount(page);
  await until('a card is on offer', async () => (await pickable(page).count()) > 0, 90_000, 100);
  // The fan overlaps its cards, so a pointer press lands on a neighbour (the cursor is not in the footage);
  // and a fan card opens on its first press and is picked on the next (`PackView.tsx`), the grid's on one.
  const card = pickable(page).first();
  await card.evaluate((b) => (b as HTMLButtonElement).click());
  await page.waitForTimeout(500);
  if ((await poolCount(page)) === before && (await card.count()) > 0) await card.evaluate((b) => (b as HTMLButtonElement).click()).catch(() => undefined);
  await until('the pick landed', async () => (await poolCount(page)) > before, 30_000, 100);
  await page.waitForTimeout(350);
}

test('draft: the pod, fan and grid, a card turned over', async () => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const film = await startFilm('draft');
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const hero = await openPromoFriend(film.hero, HERO, { filmed: true });
    const page = hero.page;
    await page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(page, { name: 'Vintage Cube Night', gameType: 'draft' });
    await page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    const roomId = page.url().split('/room/')[1]!;
    // "Which seat is mine" reads `/session/whoami`, which the e2e edge does not serve (`dr-draft-picks.spec.ts`).
    const room = (await (await hero.context.request.get(`${stack.origin}${PREFIX}/api/rooms/${roomId}`)).json()) as { members: { id: string; name: string }[] };
    const me = room.members.find((m) => m.name === TAGS[HERO])!;
    await hero.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'friend', name: TAGS[HERO] } }));
    await page.reload();
    await page.getByTestId('pod-seats').waitFor({ timeout: 30_000 });
    await film.beat(1_500);
    await film.roll();
    film.mark('lobby');
    await film.beat(1_500);
    await page.locator('[data-testid="pod-seat-sit"][data-seat="0"]').click();
    await film.beat(800);
    await readyPod(page);
    await fillWithAi(page, 30_000);
    film.mark('pod');
    await page.getByTestId('pod').waitFor({ timeout: 60_000 });
    await until('the first pack', async () => (await pickable(page).count()) > 0, 90_000, 100);
    await film.beat(1_200);

    // The fan: sweep the pointer along it and wheel through it.
    film.mark('fan');
    const fanBtn = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'fan' });
    if ((await fanBtn.getAttribute('aria-pressed')) !== 'true') await fanBtn.click();
    await film.beat(700);
    const pack = await page.getByTestId('pack').boundingBox();
    if (pack !== null) {
      const y = pack.y + pack.height * 0.55;
      await page.mouse.move(pack.x + pack.width * 0.25, y, { steps: 12 });
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(420);
      }
      await page.mouse.move(pack.x + pack.width * 0.7, y, { steps: 30 });
      await page.waitForTimeout(800);
    }
    film.mark('picks');
    for (let i = 0; i < 3; i++) await pickOne(page);

    // The grid, and a double-faced card turned over in the inspector.
    film.mark('grid');
    await page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' }).click();
    await film.beat(1_200);
    // A transformed card: its other face is its own Scryfall back image — not a split card's halves, nor a
    // token it makes (`withRelatedFaces` draws both of those as faces too).
    const transformer = async (): Promise<string | null> =>
      page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('[data-testid="pack"] [data-testid="card"][data-faces]'))) {
          const faces = document.querySelector(`[data-faces-of="${el.getAttribute('data-faces')}"]`);
          if (faces?.querySelector('img[src*="/back/"]') != null) return el.getAttribute('data-card-id');
        }
        return null;
      });
    for (let i = 0; i < 30 && (await transformer()) === null; i++) await pickOne(page);
    const id = await transformer();
    const faced = page.locator(`[data-testid="pack"] [data-testid="card"][data-card-id="${id}"]`).first();
    if (id !== null) {
      film.mark('flip');
      const box = (await faced.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
      await page.waitForTimeout(1_400);
      for (const dy of [120, 120, -120]) {
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(1_300);
      }
      console.log(`[promo:draft] turned over: ${(await faced.locator('.card__name').first().textContent())?.trim()}`);
    } else {
      console.warn('[promo:draft] no double-faced card came by in thirty packs');
    }
    film.mark('end');
    await film.beat(1_500);
  } finally {
    await film.stop();
    await stack?.stop();
  }
});
