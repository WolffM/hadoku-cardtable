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
 * ## Reading rarity (and a face) from the wire, never the screen
 *
 * Rarity and "is this a DFC" come off each pack card's own `rarity`/`faces`
 * fields, read straight from the draft socket's own `draft:s2c` frame — the
 * exact `DraftCard[]` the server dealt, never re-derived.
 *
 * An EARLIER version of this spec re-looked a card up by bare NAME against
 * the whole catalog file (`$CARDTABLE_CATALOG`'s `{cards}` map) to get its
 * rarity, on the theory that "the catalog's rarity" meant reading the
 * catalog file directly rather than the wire. That broke live: the
 * catalog's by-NAME map holds one entry per name — ONE printing's rarity —
 * and a card reprinted at a different rarity elsewhere (`Diregraf Ghoul`
 * resolved to its promo printing, `PISD`, not Innistrad's own) made the
 * pack look wrong when it was not. The wire's `rarity` is the field for
 * the EXACT printing `catalog.byPrinting` resolved for THIS pack
 * (`apps/server/src/http/rooms.ts`'s `resolveBoosterCard`), which is the
 * only rarity this spec can trust — "the catalog's rarity", read off the
 * card the catalog itself produced, not a second, looser lookup by name.
 */
import { expect, test, type Browser, type Page, type WebSocket } from '@playwright/test';

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

interface WireCard {
  name: string;
  rarity: string;
  faces?: unknown[];
  setCode: string;
}

/**
 * Captures the viewer's own open pack straight off the draft socket's
 * `draft:s2c` frames (`packages/shared/src/wire.ts`'s `DRAFT_CHANNEL`,
 * `DraftStateMessage`/`DraftPatchMessage`) — the server's own `DraftCard[]`,
 * never the DOM and never a second lookup by name (see the file header).
 *
 * Must be attached BEFORE the draft socket connects (right after the page
 * is created, well before the pod deals) — `page.on('websocket', …)` only
 * sees sockets opened AFTER it is registered.
 */
function attachPackCapture(page: Page): { latest: () => readonly WireCard[] | null } {
  let latest: readonly WireCard[] | null = null;
  page.on('websocket', (ws: WebSocket) => {
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string' || !f.payload.startsWith('42') || !f.payload.includes('"draft:s2c"')) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(f.payload.slice(f.payload.indexOf('[')));
      } catch {
        return; // not a full JSON frame (e.g. a torn chunk) — ignore, the next frame carries the same state again
      }
      const msg = (decoded as [string, { view?: { viewer?: { kind?: string; pack?: WireCard[] } } }])[1];
      const viewer = msg.view?.viewer;
      if (viewer?.kind === 'seat' && Array.isArray(viewer.pack)) latest = viewer.pack;
    });
  });
  return { latest: () => latest };
}

/** Poll `capture.latest()`, or `null` once `timeout` elapses with nothing captured. */
async function pollLatest(capture: { latest: () => readonly WireCard[] | null }, timeout: number): Promise<readonly WireCard[] | null> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = capture.latest();
    if (found !== null) return found;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * `capture.latest()`, waited for, with one reload as a fallback.
 *
 * CDP's websocket frame capture (`page.on('websocket')`) can occasionally
 * miss the one frame a draft page ever sends before any pick — a known
 * Playwright/CDP timing gap, not a torn JSON chunk (seen live: the DOM
 * already showed a full 15-card pack while `capture.latest()` stayed
 * `null`). A reload's own `join` is a GUARANTEED fresh, complete baseline
 * (`packages/shared/src/wire.ts`'s own doc: "a client joining mid-stream…
 * its snapshot… is what establishes the baseline"), and `page.on('websocket',
 * …)` survives a reload on the same `Page` object, so the SAME capture
 * catches it the second time.
 */
async function capturedPack(page: Page, capture: { latest: () => readonly WireCard[] | null }): Promise<readonly WireCard[]> {
  const first = await pollLatest(capture, 5_000);
  if (first !== null) return first;
  await page.reload();
  await waitForPack(page, 'the reloaded seat');
  const second = await pollLatest(capture, 5_000);
  if (second !== null) return second;
  throw new Error("no draft:s2c state frame carrying a seat's pack was ever captured, even after a reload");
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

/** The five basic land names — the one card Forge's own booster recipe can source from a DIFFERENT set (see `waitForPackFromSet`'s own note). */
const BASIC_LAND_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);

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
        { cause: err },
      );
    }
    const podError = page.getByTestId('pod-error');
    if ((await podError.count()) > 0) {
      throw new Error(`${who}: the pod shows an error instead of a pack: ${(await podError.textContent()) ?? '(no text)'}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Wait for the viewer's pack to be a NEW round's — not merely "a pack is
 * visible" (`waitForPack`), which a round boundary can pass trivially: the
 * `[data-testid="pack"]` element is already on screen from the PREVIOUS
 * round and stays mounted across the boundary, so `toBeVisible` alone
 * cannot tell "still round 2's pack, one socket round trip behind" from
 * "round 3's own pack, printed in ARB" (hit live: the round-3 assertion ran
 * one frame too early and read round 2's own ALA cards). Polls the pack's
 * own `data-set` attributes until every card is the expected code, the
 * same signal `packCardSets` reads, never a blind snapshot right after a
 * visibility check.
 *
 * `landCode` is Forge's own real-product quirk, confirmed in
 * `forge-gui/res/editions/Alara Reborn.txt`: `Booster=10 Common, 3
 * Uncommon, 1 RareMythic, 1 BasicLand ALA` — Alara Reborn printed no basic
 * lands of its own, so Forge's own booster template deals one from Shards
 * of Alara, by name in the edition file, not a bug anywhere in this repo.
 * Defaults to `code` (no exception) for a set whose own basics are its own.
 */
async function waitForPackFromSet(page: Page, who: string, code: string, landCode: string = code, timeout = UI_TIMEOUT): Promise<void> {
  await waitForPack(page, who, timeout);
  await expect
    .poll(
      async () => {
        const names = await packCardNames(page);
        const sets = await packCardSets(page);
        if (names.length !== 15 || sets.length !== 15) return [`${names.length}/${sets.length} cards (want 15 each)`];
        return names
          .map((name, i) => ({ name, set: sets[i] }))
          .filter(({ name, set }) => (BASIC_LAND_NAMES.has(name) ? set !== code && set !== landCode : set !== code))
          .map(({ name, set }) => `${name} (${set})`);
      },
      { timeout, message: `${who}: never settled on an all-${code} pack (a basic land may be ${landCode})` },
    )
    .toEqual([]);
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
      // Attached now, well before the pod deals — see attachPackCapture's own note.
      const alicePack = attachPackCapture(alice.page);

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

      /*
       * ── alice's first pack is Forge's ISD collation: 1 rare/mythic, 3
       * uncommon, 1 DFC — from the catalog, never the screen ──
       *
       * Innistrad's own recipe (`Booster=9 Common:!dfc, 3 Uncommon:!dfc, 1
       * RareMythic:!dfc, 1 dfc, 1 BasicLand`): the three rarity-named slots
       * are each `:!dfc` — they never emit the pack's own DFC — but the
       * `dfc` slot itself draws from a sheet with NO rarity filter, so the
       * double-faced card can itself be common, uncommon, rare or mythic,
       * independently. Counting "every card whose rarity is uncommon" over
       * the WHOLE 15 therefore double-counts whenever the DFC happens to
       * land on "uncommon" (seen live: Gatstaf Shepherd // Gatstaf Howler,
       * an uncommon DFC, made 4 "uncommon" cards look like a wrong pack).
       * The DFC is found FIRST and set aside; the three rarity counts are
       * checked over the other 14 — the `:!dfc` slots' own cards.
       */
      await waitForPack(alice.page, "alice's first pack");
      const names = await packCardNames(alice.page);
      expect(names.length, 'the pack drew cards at all (DOM)').toBe(15);
      const entries = await capturedPack(alice.page, alicePack);
      expect(entries.length, `the pack drew cards at all (wire): ${JSON.stringify(entries.map((e) => e.name))}`).toBe(15);
      const summary = entries.map((e) => e.name).join(', ');
      const dfcs = entries.filter((e) => Array.isArray(e.faces) && e.faces.length > 0);
      expect(dfcs.length, `exactly one double-faced card (names: ${summary})`).toBe(1);
      const nonDfc = entries.filter((e) => !(Array.isArray(e.faces) && e.faces.length > 0));
      const rareOrMythic = nonDfc.filter((e) => e.rarity === 'rare' || e.rarity === 'mythic');
      const uncommons = nonDfc.filter((e) => e.rarity === 'uncommon');
      expect(rareOrMythic.length, `exactly one non-DFC rare/mythic (names: ${summary})`).toBe(1);
      expect(uncommons.length, `exactly three non-DFC uncommons (names: ${summary})`).toBe(3);
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
      await waitForPackFromSet(alice.page, "alice's round-1 pack", ALA.code);

      /* ── pick every card of rounds 1 and 2 (30 picks) to reach round 3 ── */
      await Promise.all([pickUntil(alice.page, 30), pickUntil(bob.page, 30)]);

      /* ── round 3's first pack is every card printed in ARB ── */
      await waitForPackFromSet(alice.page, "alice's round-3 pack", ARB.code, ALA.code);
    } finally {
      await stack.stop();
    }
  },
);
