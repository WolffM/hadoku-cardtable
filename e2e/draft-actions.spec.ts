/**
 * Cards that change the draft itself, in a real room (`@hadoku/draft`'s
 * `actions.ts`): Cogwork Librarian is drafted face up for the whole table to
 * see, buys its drafter a second card from a later pack, and goes into that
 * pack, where the next seat finds it and drafts it face up in turn.
 *
 * ## The seeded cube
 *
 * No cube on a claw holds the card, so this spec writes its own into the
 * server's import store before the stack boots (`draft-pools.spec.ts` has the
 * mechanism): half Cogwork Librarians, half distinct Innistrad cards, both
 * from the stack's catalog fixture. With half of every pack a Librarian the
 * first pack in front of alice holds one however the cube is shuffled, and a
 * card that is NOT a Librarian is a name that occurs once in the whole draft,
 * which is what lets the pack bob receives be told apart from any other.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { fillWithAi, readyPod, sitPodAt } from './podSeats.ts';
import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromAddress } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, PLAY_CATALOG, PLAY_CUBES_DIR, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
/** A bot seat's pick is on a clock, and a pack reaches a person through up to six of them. */
const PACK_TIMEOUT = 90_000;

const CUBE_ID = 'e2e-librarians';
const CUBE_NAME = 'E2E Librarians';
const LIBRARIAN = 'Cogwork Librarian';
/** Eight seats, three packs of fifteen. */
const CUBE_SIZE = 360;

function seedLibrarianCube(): void {
  const catalog = JSON.parse(readFileSync(PLAY_CATALOG, 'utf8')) as { cards: Record<string, { name: string; setCode: string; typeLine: string }> };
  const others = Object.values(catalog.cards)
    .filter((c) => c.setCode === 'ISD' && !c.typeLine.startsWith('Basic Land'))
    .map((c) => c.name)
    .sort()
    .slice(0, CUBE_SIZE / 2);
  if (others.length < CUBE_SIZE / 2) throw new Error(`the catalog fixture has only ${others.length} Innistrad cards`);
  const names = [...others, ...Array.from({ length: CUBE_SIZE / 2 }, () => LIBRARIAN)];
  rmSync(PLAY_CUBES_DIR, { recursive: true, force: true });
  mkdirSync(PLAY_CUBES_DIR, { recursive: true });
  writeFileSync(
    resolve(PLAY_CUBES_DIR, `${CUBE_ID}.json`),
    JSON.stringify({
      id: CUBE_ID,
      name: CUBE_NAME,
      cubeCobraId: 'e2e-fixture',
      importedBy: 'fk:e2e-fixture',
      importedAt: new Date().toISOString(),
      refreshedAt: null,
      verdict: null,
      cards: names.map((name) => ({ name, scryfallId: null })),
    }),
  );
}

const packCards = (page: Page) => page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])');

/** The names in the pack in front of the viewer, off each tile's own label ("Pick <name>"). */
async function packNames(page: Page): Promise<string[]> {
  const labels = await packCards(page).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.replace(/^Pick /, ''));
}

/** Waits for a pack of exactly `size` cards to be in front of the viewer, and returns its names. */
async function packOfSize(page: Page, size: number, what: string): Promise<string[]> {
  await expect(packCards(page), what).toHaveCount(size, { timeout: PACK_TIMEOUT });
  return packNames(page);
}

const pickNamed = (page: Page, name: string) => packCards(page).and(page.getByLabel(`Pick ${name}`, { exact: true })).first().click();

const librarians = (names: readonly string[]) => names.filter((n) => n === LIBRARIAN).length;

test(
  titled('Cogwork Librarian is drafted face up, buys a second card from a later pack, and goes into that pack for the next seat'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedLibrarianCube();

    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];

      /* ── a draft room on the seeded cube, alice at seat 0 and bob at seat 1, the rest AI ── */
      await alice.page.goto(`${origin}${PREFIX}/`);
      await submitCreateRoom(alice.page, { name: `e2e draft-actions ${Date.now()}`, gameType: 'draft' });
      const roomId = await roomIdFromAddress(alice.page);
      await bob.page.goto(`${origin}${PREFIX}/#/room/${roomId}`);
      for (const p of players) await expect(p.page.getByTestId('draft-lobby'), `${p.name}: joined the room`).toBeVisible({ timeout: UI_TIMEOUT });

      // Which seat is whose reads the room's own member ids (`draft-pools.spec.ts`'s own note).
      const roomBody = (await alice.page.evaluate(
        (id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
        roomId,
      )) as { members: { id: string; name: string }[] };
      for (const p of players) {
        const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
        if (me === undefined) throw new Error(`${p.name}: not found among the room’s own members`);
        await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: `e2e-${p.name}` } }));
        await p.page.reload();
        await resizeWindow(p.page, { width: 1280, height: 800 });
      }

      await expect(alice.page.getByTestId(`pool-picker-cubes-${CUBE_ID}`), 'the seeded cube is listed').toBeVisible({ timeout: UI_TIMEOUT });
      await alice.page.getByTestId('pool-picker-cubes').locator('label', { hasText: CUBE_NAME }).locator('input[type="radio"]').click();
      await expect(alice.page.getByTestId('pool-picker-verdict'), 'Forge plays every card in it').toHaveAttribute('data-state', 'ready', { timeout: UI_TIMEOUT });

      await sitPodAt(alice.page, 0);
      await sitPodAt(bob.page, 1);
      for (const p of players) await readyPod(p.page);
      await fillWithAi(alice.page, UI_TIMEOUT);
      for (const p of players) {
        await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });
        // The grid: every card is a tile a click lands on (`podSeats.ts`'s `draftUntilDone`).
        const grid = p.page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
        if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
      }

      /* ── alice drafts a Librarian: it lies face up in front of her seat, on both screens ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(librarians(first), 'the first pack holds a Librarian').toBeGreaterThan(0);
      await expect(alice.page.getByTestId('extra-pick'), 'nothing to use before she holds one').toHaveCount(0);
      for (const p of players) await expect(p.page.getByTestId('face-up'), `${p.name}: nothing is face up yet`).toHaveCount(0);
      await pickNamed(alice.page, LIBRARIAN);
      for (const p of players) {
        await expect(p.page.getByTestId('face-up-0'), `${p.name}: sees alice's Librarian face up`).toContainText(LIBRARIAN, { timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('face-up').locator('li'), `${p.name}: and no other seat's`).toHaveCount(1);
      }
      await expect(alice.page.getByTestId('pool-count')).toHaveText('1');

      /* ── her next pack: the Librarian's own control, two cards for one pick ── */
      const second = await packOfSize(alice.page, 14, "alice's second pack, one card lighter from the seat before her");
      const [a, b] = second.filter((n) => n !== LIBRARIAN);
      if (a === undefined || b === undefined) throw new Error(`the second pack has fewer than two cards that are not Librarians: ${second.join(', ')}`);
      const control = alice.page.getByTestId('extra-pick');
      await expect(control, 'the Librarian offers itself').toHaveText(LIBRARIAN, { timeout: UI_TIMEOUT });
      await expect(control).toHaveAttribute('aria-pressed', 'false');
      await expect(bob.page.getByTestId('extra-pick'), 'only to its own drafter').toHaveCount(0);
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');

      await pickNamed(alice.page, a);
      await expect(alice.page.locator('[data-testid="pack"] .pack__slot[data-chosen]'), 'the first card is held, not taken').toHaveCount(1);
      await expect(packCards(alice.page), 'the pack is still in front of her').toHaveCount(14);
      await expect(alice.page.getByTestId('pool-count')).toHaveText('1');
      await pickNamed(alice.page, b);

      // Two cards in, the Librarian out: a pool of two, neither of them the Librarian.
      await expect(alice.page.getByTestId('pool-count'), 'both cards are hers and the Librarian is gone').toHaveText('2', { timeout: UI_TIMEOUT });
      const pool = alice.page.getByTestId('pool');
      for (const name of [a, b]) await expect(pool.getByText(name, { exact: true }).first(), `${name} is in her pool`).toBeVisible();
      await expect(pool.getByText(LIBRARIAN, { exact: true }), 'the Librarian left her pool').toHaveCount(0);
      for (const p of players) await expect(p.page.getByTestId('face-up'), `${p.name}: nothing is face up any more`).toHaveCount(0, { timeout: UI_TIMEOUT });

      /* ── bob is passed that pack: thirteen cards, one Librarian more, neither card she took ── */
      await packOfSize(bob.page, 15, "bob's own first pack");
      await packCards(bob.page).first().click();
      const passedFirst = await packOfSize(bob.page, 14, "alice's first pack, passed to bob");
      expect(librarians(passedFirst), 'less the Librarian she drafted').toBe(librarians(first) - 1);
      await pickNamed(bob.page, passedFirst.find((n) => n !== LIBRARIAN) ?? LIBRARIAN);
      const passedSecond = await packOfSize(bob.page, 13, "alice's second pack, passed to bob");
      expect(librarians(passedSecond), 'her Librarian is in it').toBe(librarians(second) + 1);
      expect(passedSecond, 'and the two cards she took are not').not.toEqual(expect.arrayContaining([a]));
      expect(passedSecond).not.toEqual(expect.arrayContaining([b]));

      /* ── bob drafts a Librarian from it: face up in front of his seat now, on both screens ── */
      await pickNamed(bob.page, LIBRARIAN);
      for (const p of players) {
        await expect(p.page.getByTestId('face-up-1'), `${p.name}: sees bob's Librarian face up`).toContainText(LIBRARIAN, { timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('face-up-0'), `${p.name}: and none in front of alice`).toHaveCount(0);
      }
    } finally {
      await stack.stop();
    }
  },
);
