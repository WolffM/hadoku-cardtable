/**
 * Wave 74 §F's acceptance (`docs/planning/wave74-2026-10-21.md`, Acceptance 1):
 * a draft room's leader picks a SET source — realistic or set-cube — instead
 * of a cube, live for everyone seated, and a custom plan can give each of the
 * three rounds its own source (ruling 5 of `docs/planning/draft-pools-plan.md`:
 * "shards of alara + alara reborn in one draft").
 *
 * Two scenes, each its own room (the picker is a lobby-only control, same
 * reasoning as `draft-pools.spec.ts`'s own header):
 *
 *  1. Alice picks Set → Innistrad → Realistic. Bob, seated, sees it live with
 *     no reload. They fill the rest with AI and deal. Alice's first pack is
 *     Forge's own ISD collation — one rare or mythic, three uncommons, one
 *     double-faced card — asserted from the CATALOG's rarity for each card
 *     name the pack holds, never from the rarity letter `CardTile` draws on
 *     screen (`forge/forge-gui/res/editions/Innistrad.txt`: `Booster=9
 *     Common:!dfc, 3 Uncommon:!dfc, 1 RareMythic:!dfc, 1 dfc, 1 BasicLand`).
 *  2. A new room, Custom: round 1 Shards of Alara (realistic), round 2 Shards
 *     of Alara (realistic), round 3 Alara Reborn (realistic). Every card in
 *     Alice's round-1 first pack is printed in ALA and every card in her
 *     round-3 first pack is printed in ARB — read off each pack card's own
 *     `data-set` attribute (`ManaPip.tsx`'s `SetSymbol`), never its rendered
 *     set-symbol glyph. Getting there needs every pick of rounds 1 and 2 made
 *     (30 picks, both seated humans), the same `pickUntil` idiom
 *     `dr-draft-picks.spec.ts` already uses per spec file rather than a third
 *     copy in a shared module.
 *
 * Needs Forge, the same reasoning `draft-pools.spec.ts` gives: the verdict a
 * pick runs (`PUT /api/rooms/:id/pod/plan`) refuses every source without a
 * jar, so this runs through `play/harness.ts`'s real stack and skips the same
 * way without one.
 *
 * ## Reading rarity from the catalog, not the screen
 *
 * `CardCatalog.byName` (`apps/server/src/pools/catalog.ts`) resolves a name to
 * its `DraftCard`, built once at server boot from the SAME file this reads
 * directly: `$CARDTABLE_CATALOG` (default `~/.local/share/cardtable/catalog/cards.json`),
 * `{ cards: Record<canonicalKey, DraftCard>, aliases }`. Rather than re-deriving
 * the server's own name-folding (`@hadoku/carddata`'s `normaliseName`/`foldName`,
 * not importable from `e2e/` — no `@hadoku/*` symlink there), this matches on
 * each entry's own `.name` field, which is the exact printed name the pack's
 * `aria-label` ("Pick <name>") already carries — the same field, read twice
 * from two independent places, is the whole point of a catalog cross-check.
 */
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { readyPod } from './podSeats.ts';
import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

const ISD = { code: 'ISD', name: 'Innistrad' };
const ALA = { code: 'ALA', name: 'Shards of Alara' };
const ARB = { code: 'ARB', name: 'Alara Reborn' };

interface CatalogCard {
  name: string;
  rarity: string;
  faces?: unknown[];
}

/** `$CARDTABLE_CATALOG`'s own `{cards}` map, by VALUE rather than by its (folded) key — see the file header. */
function loadCatalog(): CatalogCard[] {
  const path = process.env.CARDTABLE_CATALOG ?? resolve(homedir(), '.local/share/cardtable/catalog/cards.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as { cards?: Record<string, unknown> };
  return Object.values(file.cards ?? {}) as CatalogCard[];
}

function catalogEntry(catalog: CatalogCard[], name: string): CatalogCard {
  const found = catalog.find((c) => c.name === name);
  if (found === undefined) throw new Error(`the catalog has no entry named ${JSON.stringify(name)}`);
  return found;
}

/** Every card name the viewer's open pack currently shows, off `CardTile`'s own `aria-label` ("Pick <name>"). */
async function packCardNames(page: Page): Promise<string[]> {
  const labels = await page.locator('[data-testid="pack"] [data-testid="card"]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.replace(/^Pick /, ''));
}

/** Every pack card's OWN printing set, off `SetSymbol`'s `data-set` attribute — never the glyph it draws. */
async function packCardSets(page: Page): Promise<string[]> {
  return page.locator('[data-testid="pack"] [data-testid="card"] .setsym').evaluateAll((els) => els.map((el) => el.getAttribute('data-set') ?? ''));
}

/**
 * Wait for the viewer's pack to render, failing with a message that NAMES
 * the stuck state rather than Playwright's bare "element not found".
 *
 * Found live (2026-10-22): a server bug (`apps/server/src/index.ts`'s
 * `poolResolver.cards` returning `[]` for a realistic round, which fed
 * `CubeMeta.size: 0` into a wire schema requiring `positive()`) left the pod
 * on its loading skeleton forever — `apps/ui/src/draft/socket.ts`'s
 * `ingest()` silently drops a state message that fails
 * `safeParseServerMessage` (counted in `stats.invalid`/`lastInvalid`, never
 * surfaced anywhere) and `table` never leaves `null`, so `PodScreen.tsx`'s
 * `DraftSkeleton` (`data-testid="pod-waiting"`) never ends — no console
 * error, no crash, no server fault logged. A bare `toBeVisible` timeout on
 * the pack read "element(s) not found" with nothing pointing at why.
 *
 * Reading `stats.invalid` itself would need new client instrumentation —
 * `PodScreen.tsx` is explicitly "owned by nobody this wave" and
 * `draft/socket.ts` is not this lane's row either — so this reads only what
 * is already in the DOM: whether the skeleton is STILL up is enough to name
 * this failure instead of guessing at it.
 */
async function waitForPack(page: Page, who: string, timeout = UI_TIMEOUT): Promise<void> {
  const pack = page.locator('[data-testid="pack"] [data-testid="card"]').first();
  try {
    await expect(pack, `${who}: the pack is up`).toBeVisible({ timeout });
    return;
  } catch (err) {
    if ((await page.getByTestId('pod-waiting').count()) > 0) {
      throw new Error(
        `${who}: the pod dealt, but stayed on its loading skeleton (data-testid="pod-waiting") for over ${timeout}ms — the draft view never reached this seat. Check apps/ui/src/draft/socket.ts's ingest(): a rejected state message (stats.invalid > 0) leaves the pack unset forever, with no error drawn on screen.`,
      );
    }
    const podError = page.getByTestId('pod-error');
    if ((await podError.count()) > 0) {
      throw new Error(`${who}: the pod shows an error instead of a pack: ${(await podError.textContent()) ?? '(no text)'}`);
    }
    throw err;
  }
}

/** The set radio for `code` — the picker's own test id, which this spec controls (`PoolPicker.tsx`). */
function setRadio(page: Page, code: string) {
  return page.getByTestId(`pool-picker-sets-${code}`);
}

function styleRadio(page: Page, style: 'realistic' | 'set-cube') {
  return page.getByTestId(`pool-picker-style-${style}`);
}

/** Picks the first enabled pack card, paced under the server's pick rate limit, until the pool holds `n` (or the draft ends). Same idiom `dr-draft-picks.spec.ts` uses, per-spec rather than a third shared copy. */
async function pickUntil(page: Page, n: number): Promise<void> {
  for (;;) {
    const next = await page.waitForFunction(
      (want) => {
        if (window.location.hash.startsWith('#/deck/')) return 'done';
        const count = Number(document.querySelector('[data-testid="pool-count"]')?.textContent ?? '0');
        if (count >= want) return 'enough';
        return document.querySelector('[data-testid="pack"] button[data-testid="card"]:not([disabled])') !== null ? 'pick' : null;
      },
      n,
      { timeout: 120_000, polling: 50 },
    );
    if ((await next.jsonValue()) !== 'pick') return;
    await page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first().click();
    await page.waitForTimeout(400);
  }
}

async function enterTwoPlayerDraftRoom(browser: Browser, origin: string, roomName: string): Promise<{ alice: Player; bob: Player; roomId: string }> {
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  const players = [alice, bob];

  await alice.page.goto(`${origin}${PREFIX}/`);
  await submitCreateRoom(alice.page, { name: roomName, gameType: 'draft' });
  const roomId = await roomIdFromHash(alice.page);
  const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
  await bob.page.goto(roomUrl);
  for (const p of players) await expect(p.page.getByTestId('draft-lobby'), `${p.name}: joined the room`).toBeVisible({ timeout: UI_TIMEOUT });

  // "Which seat is mine" (and who the leader is) reads the room's own member
  // ids, not the harness's `e2e-<name>-id` — `draft-pools.spec.ts`'s own note.
  const roomBody = (await alice.page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as { members: { id: string; name: string }[] };
  for (const p of players) {
    const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
    if (me === undefined) throw new Error(`${p.name}: not found among the room’s own members`);
    await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'friend', name: `e2e-${p.name}` } }));
    await p.page.reload();
    await resizeWindow(p.page, { width: 1280, height: 800 });
  }
  return { alice, bob, roomId };
}

async function sitAndReady(alice: Player, bob: Player): Promise<void> {
  await alice.page.locator('[data-testid="pod-seat-sit"][data-seat="0"]').click();
  await bob.page.locator('[data-testid="pod-seat-sit"][data-seat="1"]').click();
  for (const p of [alice, bob]) await expect(p.page.getByTestId('pod-seat-stand'), `${p.name}: holds their own seat`).toBeVisible({ timeout: UI_TIMEOUT });
  for (const p of [alice, bob]) await readyPod(p.page);
}

/** Every remaining open seat taken by AI, from alice's screen — `podSeats.ts`'s `fillWithAi`, inlined here because this spec needs to interleave it with set-tab assertions `fillWithAi` has no hook for. */
async function fillRestWithAi(page: Page, timeout = UI_TIMEOUT): Promise<void> {
  const ai = page.getByTestId('pod-seat-ai');
  const dealt = page.getByTestId('pod');
  const deadline = Date.now() + timeout * 4;
  while ((await dealt.count()) === 0) {
    if (Date.now() > deadline) throw new Error('the pod never dealt with every seat filled');
    const n = await ai.count();
    if (n === 0) {
      await page.waitForTimeout(100);
      continue;
    }
    await ai.first().click({ timeout: 2_000 }).catch(() => undefined);
    await expect
      .poll(async () => ((await dealt.count()) > 0 ? 0 : await ai.count()), { timeout, message: 'the seat takes the AI' })
      .toBeLessThan(n);
  }
}

test(
  titled('the leader picks a set source (realistic), live for everyone seated, and the first pack is the set’s own Forge collation'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(6 * 60_000);

    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    let alice: Player | undefined;
    let bob: Player | undefined;
    try {
      const entered = await enterTwoPlayerDraftRoom(browser, origin, `e2e draft-sets isd ${Date.now()}`);
      alice = entered.alice;
      bob = entered.bob;
      const players = [alice, bob];

      /* ── alice (the leader) opens the Set tab and picks Innistrad · Realistic ── */
      for (const p of players) await expect(p.page.getByTestId('pool-picker'), `${p.name}: the pool picker is up`).toBeVisible({ timeout: UI_TIMEOUT });
      await alice.page.getByTestId('pool-picker-tab-set').click();
      await expect(alice.page.getByTestId('pool-picker-sets'), 'the set list is up').toBeVisible({ timeout: UI_TIMEOUT });
      await setRadio(alice.page, ISD.code).click();
      await styleRadio(alice.page, 'realistic').click();
      await expect(alice.page.getByTestId('pool-picker-verdict'), "alice's pick checks out").toHaveAttribute('data-state', 'ready', { timeout: UI_TIMEOUT });

      /* ── bob, who never touched a tab, sees the same set live ── */
      await expect(bob.page.getByTestId('pool-picker-tab-set'), 'bob’s picker followed alice onto the Set tab, with no reload').toHaveAttribute('aria-selected', 'true', { timeout: UI_TIMEOUT });
      await expect(setRadio(bob.page, ISD.code), 'bob sees Innistrad chosen').toBeChecked({ timeout: UI_TIMEOUT });
      await expect(styleRadio(bob.page, 'realistic'), 'bob sees Realistic chosen').toBeChecked();

      /* ── both sit, ready, and the rest of the pod fills with AI ── */
      await sitAndReady(alice, bob);
      await fillRestWithAi(alice.page, UI_TIMEOUT);
      for (const p of players) await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });

      /* ── alice's first pack is Forge's ISD collation: 1 rare/mythic, 3 uncommon, 1 DFC — from the catalog, never the screen ── */
      await waitForPack(alice.page, "alice's first pack");
      const names = await packCardNames(alice.page);
      expect(names.length, 'the pack drew cards at all').toBe(15);
      const catalog = loadCatalog();
      const entries = names.map((n) => catalogEntry(catalog, n));
      const rareOrMythic = entries.filter((e) => e.rarity === 'rare' || e.rarity === 'mythic');
      const uncommons = entries.filter((e) => e.rarity === 'uncommon');
      const dfcs = entries.filter((e) => Array.isArray(e.faces) && e.faces.length > 0);
      expect(rareOrMythic.length, `exactly one rare/mythic (names: ${names.join(', ')})`).toBe(1);
      expect(uncommons.length, `exactly three uncommons (names: ${names.join(', ')})`).toBe(3);
      expect(dfcs.length, `exactly one double-faced card (names: ${names.join(', ')})`).toBe(1);
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('a custom plan gives each round its own set source: round 1 and 2 deal Shards of Alara, round 3 deals Alara Reborn'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    let alice: Player | undefined;
    let bob: Player | undefined;
    try {
      const entered = await enterTwoPlayerDraftRoom(browser, origin, `e2e draft-sets custom ${Date.now()}`);
      alice = entered.alice;
      bob = entered.bob;

      /* ── alice builds the custom plan: ALA realistic / ALA realistic / ARB realistic ── */
      await expect(alice.page.getByTestId('pool-picker'), 'the pool picker is up').toBeVisible({ timeout: UI_TIMEOUT });
      await alice.page.getByTestId('pool-picker-tab-custom').click();
      await expect(alice.page.getByTestId('pool-picker-custom-round-0'), 'the custom rounds are up').toBeVisible({ timeout: UI_TIMEOUT });

      const rounds: { round: number; set: typeof ALA }[] = [
        { round: 0, set: ALA },
        { round: 1, set: ALA },
        { round: 2, set: ARB },
      ];
      for (const { round, set } of rounds) {
        await alice.page.getByTestId(`pool-picker-custom-round-${round}-type-set`).click();
        await alice.page.getByTestId(`pool-picker-custom-round-${round}-sets-${set.code}`).click();
        await alice.page.getByTestId(`pool-picker-custom-round-${round}-style-realistic`).click();
      }
      await expect(alice.page.getByTestId('pool-picker-verdict'), 'the custom plan checks out').toHaveAttribute('data-state', 'ready', { timeout: UI_TIMEOUT });

      /* ── both sit, ready, and the rest of the pod fills with AI ── */
      await sitAndReady(alice, bob);
      await fillRestWithAi(alice.page, UI_TIMEOUT);
      for (const p of [alice, bob]) await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });

      /* ── round 1's first pack is every card printed in ALA ── */
      await waitForPack(alice.page, "alice's round-1 pack");
      const round1Sets = await packCardSets(alice.page);
      expect(round1Sets.length, 'round 1 drew cards at all').toBe(15);
      for (const code of round1Sets) expect(code, `round 1’s card is printed in ${ALA.code}`).toBe(ALA.code);

      /* ── pick every card of rounds 1 and 2 (30 picks) to reach round 3 ── */
      await Promise.all([pickUntil(alice.page, 30), pickUntil(bob.page, 30)]);

      /* ── round 3's first pack is every card printed in ARB ── */
      await waitForPack(alice.page, "alice's round-3 pack");
      const round3Sets = await packCardSets(alice.page);
      expect(round3Sets.length, 'round 3 drew cards at all').toBe(15);
      for (const code of round3Sets) expect(code, `round 3’s card is printed in ${ARB.code}`).toBe(ARB.code);
    } finally {
      await stack.stop();
    }
  },
);
