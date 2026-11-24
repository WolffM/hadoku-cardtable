/**
 * Wave 127's acceptance, the operator's sentence: "what we actually need here is a sorting/filtering
 * bar that lets us sort the cube/sets differently. we'll need popularity data and the users
 * favorites to get piped through".
 *
 * The same sequence twice, on the draft room's picker and on the Library's Cubes tab: star a cube
 * and reload, and the starred cube sits first; choose Most drafted, and the cube with the most
 * recorded drafts sits first after the starred one (and first once it is unstarred); type part of
 * a name, and only the matching cube remains.
 *
 * ## What it seeds, before the server boots
 *
 * - Three imported cubes in `PLAY_CUBES_DIR` (the import store, read once at boot, as
 *   `draft-pools.spec.ts` seeds it), imported a day apart, so Newest (the default, the server's own
 *   order) draws Charlie, Bravo, Alpha. The Library lists an imported cube whoever drafted from it.
 * - The draft record (`games/magic/server/src/history/drafts.ts`): `<stateDir>/history/drafts.jsonl`,
 *   one completed draft of Charlie and three of Bravo, so Most drafted draws Bravo, Charlie, Alpha.
 *   The stack gets its own state dir (`CARDTABLE_STATE_DIR`), so the record, and alice's stars in
 *   `users/`, start empty every run.
 *
 * Needs a jar only because `startPlayStack` is the stack a spec can seed before boot.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, PLAY_CUBES_DIR, RUN_DIR, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

const STATE_DIR = resolve(RUN_DIR, 'w127-state');

const ALPHA = { id: 'cc-e2e-sort-alpha', name: 'E2E Sort Alpha' };
const BRAVO = { id: 'cc-e2e-sort-bravo', name: 'E2E Sort Bravo' };
const CHARLIE = { id: 'cc-e2e-sort-charlie', name: 'E2E Sort Charlie' };
const DAY = 24 * 60 * 60 * 1000;

function seedCubes(): void {
  rmSync(PLAY_CUBES_DIR, { recursive: true, force: true });
  mkdirSync(PLAY_CUBES_DIR, { recursive: true });
  const now = Date.now();
  [ALPHA, BRAVO, CHARLIE].forEach((cube, i) => {
    writeFileSync(
      resolve(PLAY_CUBES_DIR, `${cube.id}.json`),
      JSON.stringify({
        id: cube.id,
        name: cube.name,
        cubeCobraId: cube.id.slice('cc-'.length),
        importedBy: 'fk:e2e-fixture',
        // Alpha oldest, Charlie newest.
        importedAt: new Date(now - (3 - i) * DAY).toISOString(),
        refreshedAt: null,
        verdict: null,
        // From the stack's catalog fixture (Innistrad), which a claw has text for.
        cards: ['Abattoir Ghoul', "Avacyn's Pilgrim"].map((name) => ({ name, scryfallId: null })),
      }),
    );
  });
}

/** `drafts` completed drafts of `cube`, as the draft record keeps one. */
function draftsOf(cube: { id: string; name: string }, drafts: number): string[] {
  return Array.from({ length: drafts }, (_, i) => {
    const endedAt = Date.now() - (i + 1) * 60_000;
    const round = { kind: 'cube', cubeId: cube.id, name: cube.name, origin: 'cubecobra' };
    return JSON.stringify({
      v: 1,
      draftId: `e2e-${cube.id}-${String(i)}`,
      roomId: `r-e2e-${cube.id}-${String(i)}`,
      pod: null,
      eventId: null,
      rounds: [round, round, round],
      seats: [{ kind: 'bot', userId: null, displayName: 'Bot 1', picks: 45 }],
      startedAt: endedAt - 20 * 60_000,
      endedAt,
      durationMs: 20 * 60_000,
      outcome: 'complete',
    });
  });
}

function seedDraftRecord(): void {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(resolve(STATE_DIR, 'history'), { recursive: true });
  writeFileSync(resolve(STATE_DIR, 'history', 'drafts.jsonl'), [...draftsOf(CHARLIE, 1), ...draftsOf(BRAVO, 3)].map((l) => `${l}\n`).join(''));
}

/** A press on a card's star, and the server's answer to it, so a reload after it reads the star back. */
async function star(page: Page, card: Locator, on: boolean): Promise<void> {
  const button = card.getByTestId('pool-star');
  const answered = page.waitForResponse((r) => r.url().includes('/api/me/pool-favourites/') && r.request().method() === 'PUT');
  await button.click();
  expect((await answered).status(), 'the server kept the star').toBe(200);
  await expect(button).toHaveAttribute('aria-pressed', on ? 'true' : 'false');
}

/* ── the room's picker ─────────────────────────────────────────────────── */

/** The picker's cube ids, in the order it draws them. */
const pickerOrder = (page: Page): Promise<string[]> =>
  page
    .getByTestId('pool-picker-cubes')
    .locator('input[type="radio"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('value') ?? ''));

const pickerCard = (page: Page, id: string): Locator => page.getByTestId('pool-picker-cubes').locator('label', { has: page.getByTestId(`pool-picker-cubes-${id}`) });

/* ── the Library's Cubes tab ───────────────────────────────────────────── */

const libraryOrder = (page: Page): Promise<string[]> =>
  page.locator('[data-testid^="inventory-cube-"]').evaluateAll((els) => els.map((el) => (el.getAttribute('data-testid') ?? '').slice('inventory-cube-'.length)));

test(
  titled('w127: a starred cube sits first after a reload, Most drafted puts the most drafted cube first, and part of a name leaves only the cubes it names, in the room’s picker and on the Library’s Cubes tab'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);

    seedCubes();
    seedDraftRecord();
    const stack = await startPlayStack(forge, { env: { CARDTABLE_STATE_DIR: STATE_DIR } });
    const origin = stack.origin;
    let alice: Player | undefined;
    try {
      alice = await openFriend(browser, 'alice');
      const page = alice.page;
      await resizeWindow(page, { width: 1280, height: 800 });

      /* ── the room's picker ─────────────────────────────────────────── */
      await page.goto(`${origin}${PREFIX}/`);
      await submitCreateRoom(page, { name: `e2e w127 pool sort ${String(Date.now())}`, gameType: 'draft' });
      await expect(page.getByTestId('pool-picker-cubes'), 'the pool picker is up').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(page.getByTestId(`pool-picker-cubes-${ALPHA.id}`), 'the seeded cubes are listed').toBeAttached({ timeout: UI_TIMEOUT });
      await expect.poll(() => pickerOrder(page), 'Newest is the default: the newest import first').toEqual(expect.arrayContaining([CHARLIE.id, BRAVO.id, ALPHA.id]));
      expect((await pickerOrder(page)).slice(0, 3), 'Newest, the server’s own order').toEqual([CHARLIE.id, BRAVO.id, ALPHA.id]);
      await expect(page.getByTestId('pool-picker-cubes-sort')).toHaveValue('newest');

      await star(page, pickerCard(page, ALPHA.id), true);
      await page.reload();
      await expect(page.getByTestId(`pool-picker-cubes-${ALPHA.id}`), 'the picker is back').toBeAttached({ timeout: UI_TIMEOUT });
      await expect.poll(async () => (await pickerOrder(page))[0], 'the starred cube sits first after a reload').toBe(ALPHA.id);
      await expect(pickerCard(page, ALPHA.id).getByTestId('pool-star')).toHaveAttribute('aria-pressed', 'true');

      await page.getByTestId('pool-picker-cubes-sort').selectOption('drafted');
      await expect.poll(async () => (await pickerOrder(page)).slice(0, 2), 'Most drafted: the starred cube, then the most drafted').toEqual([ALPHA.id, BRAVO.id]);
      await star(page, pickerCard(page, ALPHA.id), false);
      await expect.poll(async () => (await pickerOrder(page)).slice(0, 2), 'unstarred, the most drafted cube sits first').toEqual([BRAVO.id, CHARLIE.id]);

      await page.getByTestId('pool-picker-cubes-search').fill('ort charl');
      await expect.poll(() => pickerOrder(page), 'part of a name: only the cube it names').toEqual([CHARLIE.id]);
      await page.getByTestId('pool-picker-cubes-search').fill('');

      /* ── the Library's Cubes tab ───────────────────────────────────── */
      await page.goto(`${origin}${PREFIX}/#/library/cubes`);
      await expect(page.getByTestId(`inventory-cube-${ALPHA.id}`), 'the Library lists the seeded cubes').toBeVisible({ timeout: UI_TIMEOUT });
      await expect.poll(() => libraryOrder(page), 'Newest is the default').toEqual([CHARLIE.id, BRAVO.id, ALPHA.id]);
      await expect(page.getByTestId('library-cubes-sort')).toHaveValue('newest');

      await star(page, page.getByTestId(`inventory-cube-${ALPHA.id}`), true);
      await page.reload();
      await expect(page.getByTestId(`inventory-cube-${ALPHA.id}`)).toBeVisible({ timeout: UI_TIMEOUT });
      await expect.poll(() => libraryOrder(page), 'the starred cube sits first after a reload').toEqual([ALPHA.id, CHARLIE.id, BRAVO.id]);

      await page.getByTestId('library-cubes-sort').selectOption('drafted');
      await expect.poll(() => libraryOrder(page), 'Most drafted: the starred cube, then by drafts').toEqual([ALPHA.id, BRAVO.id, CHARLIE.id]);
      await star(page, page.getByTestId(`inventory-cube-${ALPHA.id}`), false);
      await expect.poll(() => libraryOrder(page), 'unstarred, the most drafted cube sits first').toEqual([BRAVO.id, CHARLIE.id, ALPHA.id]);

      await page.getByTestId('library-cubes-search').fill('ort charl');
      await expect.poll(() => libraryOrder(page), 'part of a name: only the cube it names').toEqual([CHARLIE.id]);
    } finally {
      await alice?.context.close();
      await stack.stop();
    }
  },
);
