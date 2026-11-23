/**
 * Bringing your own cube into a draft room, both ways the import box takes one:
 * a Cube Cobra link and a pasted card list.
 *
 * For each: the import is the room's pick at once (no second press on its
 * tile), the cards Forge cannot play are named, "Draft without them" leaves a
 * pool that deals, and the cube is kept: the Library's Cubes tab lists it afterwards.
 * Then the pasted list is drafted, and every card of the first pack is one of
 * its own.
 *
 * Needs Forge, like `draft-pools.spec.ts` (the verdict is Forge's), and runs
 * through the same stack. Cube Cobra is a stand-in on this machine
 * (`CARDTABLE_E2E_CUBECOBRA_ORIGIN`): the server fetches a cube's JSON itself,
 * so nothing a browser routes could answer for it, and a test must not depend
 * on cubecobra.com. `pools/cubecobra.test.ts` reads a real response's shape.
 */
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { fillWithAi, readyPod, sitPodAt } from './podSeats.ts';
import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromAddress } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, PLAY_CUBES_DIR, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

/** A name Forge's card DB does not have, in both imports: what "Draft without them" leaves out. */
const UNKNOWN_CARD = 'Zzyzzyva, Card Forge Does Not Know';

const COBRA_ID = 'e2e-cobra';
const COBRA_NAME = 'E2E Cobra Cube';
const COBRA_CARDS = [UNKNOWN_CARD, 'Abattoir Ghoul', "Avacyn's Pilgrim"];

const LIST_NAME = 'E2E Kitchen Table';
/** Enough for a full pod's three rounds (8 seats x 45), from the sets the stack's catalog fixture has text for. */
const LIST_SIZE = 400;

/**
 * The fixture catalog's own cards, less the basic lands (a cube is singleton), the two-faced cards (a pack names a card
 * by its front) and its one Alchemy card (set `YMID`): an import leaves Alchemy out, so it would not be counted.
 */
function catalogNames(): string[] {
  const catalog = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', 'sets-catalog.json'), 'utf8')) as {
    cards: Record<string, { name: string; typeLine: string; setCode: string }>;
  };
  return Object.values(catalog.cards)
    .filter((c) => !c.typeLine.startsWith('Basic') && !c.name.includes(' // ') && c.setCode !== 'YMID')
    .map((c) => c.name);
}

/** The list as a person would paste it: three of the spellings `pools/cube-list.ts` reads, a comment, a blank line and the unknown card. */
function pastedList(names: readonly string[]): string {
  const lines = names.map((name, i) => (i % 3 === 0 ? name : i % 3 === 1 ? `1 ${name}` : `1x ${name} (ISD) ${String(i)}`));
  return ['# my cube', ...lines.slice(0, 200), '', ...lines.slice(200), `1 ${UNKNOWN_CARD}`].join('\n');
}

/** Cube Cobra's `cubeJSON`, for the one cube this spec imports; 404 for any other, as the real one answers. */
async function startCubeCobra(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url !== `/cube/api/cubeJSON/${COBRA_ID}`) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: COBRA_NAME, cards: { mainboard: COBRA_CARDS.map((name) => ({ details: { name } })), maybeboard: [{ details: { name: 'Abbey Griffin' } }] } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

/** The cube tile for `name`, by its drawn label: a pasted list's id is the server's own. */
function cubeRadio(page: Page, name: string) {
  return page.getByTestId('pool-picker-cubes').locator('label', { hasText: name }).locator('input[type="radio"]');
}

async function packCardNames(page: Page): Promise<string[]> {
  const labels = await page.locator('[data-testid="pack"] [data-testid="card"]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.replace(/^Pick /, ''));
}

test(
  titled('a Cube Cobra link and a pasted list each become the room’s cube at once, name what Forge cannot play, draft without it, and are kept in the inventory'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(6 * 60_000);

    // The store reads this directory once, at boot: an import left by an earlier run would be in the picker.
    rmSync(PLAY_CUBES_DIR, { recursive: true, force: true });
    const cubeCobra = await startCubeCobra();
    const stack = await startPlayStack(forge, { env: { CARDTABLE_E2E_CUBECOBRA_ORIGIN: `http://127.0.0.1:${String((cubeCobra.address() as AddressInfo).port)}` } });
    const origin = stack.origin;
    let alice: Player | undefined;
    try {
      alice = await openFriend(browser, 'alice');
      const page = alice.page;

      await page.goto(`${origin}${PREFIX}/`);
      await submitCreateRoom(page, { name: `e2e cube-import ${String(Date.now())}`, gameType: 'draft' });
      const roomId = await roomIdFromAddress(page);
      await expect(page.getByTestId('draft-lobby'), 'alice is in her room').toBeVisible({ timeout: UI_TIMEOUT });

      // "Which seat is mine" reads the room's own member id (`draft-pools.spec.ts`'s note).
      const roomBody = (await page.evaluate(
        (id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
        roomId,
      )) as { members: { id: string; name: string }[] };
      const me = roomBody.members.find((m) => m.name === 'e2e-alice');
      if (me === undefined) throw new Error('alice is not among the room’s own members');
      await alice.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: 'e2e-alice' } }));
      await page.reload();
      await resizeWindow(page, { width: 1280, height: 800 });
      await expect(page.getByTestId('pool-picker-cubes'), 'the pool picker is up').toBeVisible({ timeout: UI_TIMEOUT });
      const verdict = page.getByTestId('pool-picker-verdict');
      await expect(verdict, 'the room’s first plan checks out').toHaveAttribute('data-state', 'ready', { timeout: UI_TIMEOUT });

      /* ── a Cube Cobra link, by one of the cube's pages that is not its overview ── */
      await page.getByTestId('pool-picker-import-link').fill(`https://cubecobra.com/cube/playtest/${COBRA_ID}`);
      await expect(page.getByTestId('pool-picker-import-name'), 'a link brings its own name').toHaveCount(0);
      await page.getByTestId('pool-picker-import-go').click();
      await expect(page.getByTestId('pool-picker-refusal'), 'the import is checked at once, with no press on its tile').toContainText(UNKNOWN_CARD, { timeout: UI_TIMEOUT });
      await expect(page.getByTestId(`pool-picker-cubes-cc-${COBRA_ID}`), 'the imported cube is the one chosen').toBeChecked();
      await expect(cubeRadio(page, COBRA_NAME), 'under Cube Cobra’s own name for it').toBeChecked();
      await page.getByTestId('pool-picker-refusal-without').click();
      await expect(verdict, 'the mainboard less the unknown card: the maybeboard is not the cube').toHaveText('2 cards', { timeout: UI_TIMEOUT });
      await expect(verdict).toHaveAttribute('data-state', 'ready');

      /* ── a pasted list ──────────────────────────────────────────────── */
      const listNames = catalogNames().slice(0, LIST_SIZE);
      expect(listNames, 'the fixture catalog has enough cards for a pod').toHaveLength(LIST_SIZE);
      await page.getByTestId('pool-picker-import-link').fill(pastedList(listNames));
      await expect(page.getByTestId('pool-picker-import-go'), 'a list needs its name first').toBeDisabled();
      await page.getByTestId('pool-picker-import-name').fill(LIST_NAME);
      await page.getByTestId('pool-picker-import-go').click();
      await expect(page.getByTestId('pool-picker-refusal'), 'the list is checked at once').toContainText(UNKNOWN_CARD, { timeout: UI_TIMEOUT });
      await expect(cubeRadio(page, LIST_NAME), 'the pasted list is the one chosen').toBeChecked();
      await page.getByTestId('pool-picker-refusal-without').click();
      await expect(verdict, 'every line but the unknown card, whichever way it was spelled').toHaveText(`${String(LIST_SIZE)} cards`, { timeout: UI_TIMEOUT });
      await expect(verdict).toHaveAttribute('data-state', 'ready');

      /* ── both are kept: the Library's Cubes tab lists them, the list with no refresh ── */
      const inventory = await alice.context.newPage();
      await inventory.goto(`${origin}${PREFIX}/#/library/cubes`);
      const kept = inventory.locator('[data-testid^="inventory-cube-"]');
      await expect(kept.filter({ hasText: COBRA_NAME }), 'the Cube Cobra import is kept').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(inventory.getByTestId(`inventory-refresh-cc-${COBRA_ID}`), 'a Cube Cobra cube can be read again').toBeVisible();
      const keptList = kept.filter({ hasText: LIST_NAME });
      await expect(keptList, 'the pasted list is kept').toBeVisible();
      await expect(keptList, 'the unknown card is still in the saved list: only this draft left it out').toContainText(`${String(LIST_SIZE + 1)} cards`);
      await expect(keptList.locator('[data-testid^="inventory-refresh-"]'), 'a list has nothing to refresh from').toHaveCount(0);
      await expect(keptList, 'its importer is named, not shown as an id').toContainText('e2e-alice');
      await expect(keptList).not.toContainText('fk:');
      // The page knows the cube is alice's from the server's answer, not from comparing ids of its own.
      await expect(keptList.locator('[data-testid^="inventory-delete-"]'), 'its importer may delete it').toBeVisible();
      await inventory.close();

      /* ── the pasted list drafts: the first pack is its own cards ───────── */
      await sitPodAt(page, 0);
      await expect(page.getByTestId('seat-stand'), 'alice holds her seat').toBeVisible({ timeout: UI_TIMEOUT });
      await readyPod(page);
      await fillWithAi(page, UI_TIMEOUT);
      await expect(page.getByTestId('pod'), 'the pod is dealt').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(page.locator('[data-testid="pack"] [data-testid="card"]').first(), 'the first pack is up').toBeVisible({ timeout: UI_TIMEOUT });
      const firstPack = await packCardNames(page);
      expect(firstPack.length, 'the pack drew cards at all').toBeGreaterThan(0);
      const listed = new Set(listNames);
      for (const name of firstPack) expect(listed.has(name), `${name} is in the pasted list`).toBe(true);
    } finally {
      await stack.stop();
      await new Promise<void>((done) => cubeCobra.close(() => done()));
    }
  },
);
