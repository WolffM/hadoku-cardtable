/**
 * What a real-room test of a card that changes the draft is written with
 * (`draft-actions.spec.ts` and its per-family siblings): a seeded cube that
 * puts the card under test in the first pack, a dealt pod of two people and
 * six AI, and readers for the pack, the public log and a card's controls.
 *
 * ## The seeded cube
 *
 * No cube on a claw holds these cards, so a spec writes its own into the
 * server's import store before the stack boots (`draft-pools.spec.ts` has the
 * mechanism): half copies of the card under test, half distinct Innistrad
 * cards, both from the stack's catalog fixture (`fixtures/build-sets-catalog.ts`
 * keeps every card with a draft action by name). With half of every pack that
 * card, the first pack in front of alice holds one however the cube is
 * shuffled, and any other card is a name that occurs once in the whole draft,
 * which is what lets the pack bob receives be told apart from any other. A
 * cube with `spare` cards more than the pod deals leaves a pack unopened.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { pickRadio } from './click-trail.ts';
import { fillWithAi, readyPod, sitPodAt } from './podSeats.ts';
import { PREFIX } from './identities.ts';
import { resizeWindow, roomIdFromAddress } from './play/board.ts';
import type { Friend as Player } from './play/browser.ts';
import { PLAY_CATALOG, PLAY_CUBES_DIR } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

export const UI_TIMEOUT = 30_000;
/** A bot seat's pick is on a clock, and a pack reaches a person through up to six of them. */
export const PACK_TIMEOUT = 90_000;

export const CUBE_ID = 'e2e-draft-actions';
export const CUBE_NAME = 'E2E Draft Actions';
/** Eight seats, three packs of fifteen. */
const CUBE_SIZE = 360;

/**
 * A cube of `CUBE_SIZE + spare` cards: `copies` of them are `name` (half of the
 * dealt size unless told), the rest Innistrad cards, distinct for as long as
 * the catalog has more (it has for half a cube). A test whose card must be
 * scarce asks for fewer copies, and then looks for it pack by pack.
 */
export function seedCube(name: string, spare = 0, copies = CUBE_SIZE / 2): void {
  const catalog = JSON.parse(readFileSync(PLAY_CATALOG, 'utf8')) as { cards: Record<string, { name: string; setCode: string; typeLine: string }> };
  const wanted = CUBE_SIZE - copies + spare;
  const innistrad = Object.values(catalog.cards)
    .filter((c) => c.setCode === 'ISD' && !c.typeLine.startsWith('Basic Land'))
    .map((c) => c.name)
    .sort();
  if (innistrad.length < CUBE_SIZE / 2) throw new Error(`the catalog fixture has only ${innistrad.length} Innistrad cards`);
  const others = Array.from({ length: wanted }, (_, i) => innistrad[i % innistrad.length]!);
  const names = [...others, ...Array.from({ length: copies }, () => name)];
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

export const packCards = (page: Page) => page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])');

/** The names in the pack in front of the viewer, off each tile's own label ("Pick <name>"). */
export async function packNames(page: Page): Promise<string[]> {
  const labels = await packCards(page).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.replace(/^Pick /, ''));
}

/** Waits for a pack of exactly `size` cards to be in front of the viewer, and returns its names. */
export async function packOfSize(page: Page, size: number, what: string): Promise<string[]> {
  await expect(packCards(page), what).toHaveCount(size, { timeout: PACK_TIMEOUT });
  return packNames(page);
}

export const pickNamed = (page: Page, name: string) => packCards(page).and(page.getByLabel(`Pick ${name}`, { exact: true })).first().click();

export const useOf = (page: Page, name: string) => page.locator(`[data-testid="draft-use"][data-card="${name}"]`);
export const logLines = (page: Page) => page.getByTestId('draft-log').locator('li');

/** A draft room on the seeded cube, dealt: alice at seat 0, bob at seat 1, AI in the rest, both on the pack grid. */
export async function dealPod(alice: Player, bob: Player, origin: string): Promise<void> {
  const players = [alice, bob];
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
  // The picker is the room's plan, so checked means the server stored it. The verdict alone proves nothing:
  // the default cube already reads ready (CI, 11-22..11-24: four pods dealt on the default cube, no plan PUT).
  await pickRadio(alice.page, `pool-picker-cubes-${CUBE_ID}`, 'the room’s plan is the seeded cube', UI_TIMEOUT);
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
}
