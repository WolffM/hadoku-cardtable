/**
 * Wave 73 §B's acceptance (`docs/planning/wave73-2026-10-21.md`, Acceptance 1):
 * the draft room's leader picks the pod's cube, everyone seated sees it live,
 * and the first pack dealt is drawn from that cube's own list — pre-selection
 * (ruling 1 of `docs/planning/draft-pools-plan.md`). Then a cube Forge cannot
 * play is refused at selection (ruling 6): the picker shows what was tried,
 * Start stays disabled, and the room's plan is untouched.
 *
 * **Ordering decision:** the acceptance text lists the refused pick AFTER
 * "both start", but the picker is a LOBBY control — once the pod deals there
 * is nothing left to pick from, so a refused attempt made "after" a deal has
 * nothing to attach to. This spec makes it before the deal instead (still
 * after the good pick, so there is a plan for it to leave untouched) and
 * proves "the previous choice is still the room's plan" off BOB's screen —
 * he never attempted anything, so what he reads is the room's own broadcast
 * plan, not a local guess — then alice re-picks the good cube so the pod can
 * deal at all. Every other clause of Acceptance 1 is asserted exactly as written.
 *
 * This needs Forge: the verdict the leader's pick runs (`PUT
 * /api/rooms/:id/pod/plan`) is unavailable without a jar and refuses every
 * source (`docs/planning/wave73-2026-10-21.md` §A.6), so the whole spec runs
 * through `play/harness.ts`'s stack, the same as `w72-pod.spec.ts` and
 * `dr-draft-picks.spec.ts`, and skips the same way without one.
 *
 * ## The refused-cube half needs a harness change this lane does not own
 *
 * "A cube whose verdict is refused" has to be a real, selectable row in the
 * picker — the acceptance text says the picker SHOWS that name — so it must
 * come from the server's own `GET /api/pools/cubes`, not a value typed past
 * the UI. The only way to put one there without the real internet (Cube
 * Cobra) is to pre-seed the store's own directory with a fixture cube before
 * the server boots, which means `e2e/play/harness.ts`'s spawned server needs
 * a `CARDTABLE_CUBES_DIR` pointed at a per-stack directory this spec controls
 * — the same shape `CARDTABLE_ROOMS_DIR`/`CARDTABLE_DRAFTS_DIR` already get,
 * parallel to `PLAY_ROOMS_DIR`/`PLAY_DRAFTS_DIR` (`play/harness.ts` lines
 * ~96-118 for the constants, ~519-538 for the spawn env). That file is not on
 * this lane's row (it is not any lane's this wave), so this spec does not
 * edit it: see the README note below and the lane's own report for the exact
 * change. Until it exists, `TEST_CUBES_DIR` is undefined and the refused-cube
 * assertions are skipped with a loud note rather than silently absent.
 *
 * `TEST_FIXTURE_ROOT`'s own fixture is written here regardless, so wiring the
 * env var is the only thing standing between this and a green run of both
 * halves: `{ id, name, cubeCobraId, importedBy, importedAt, refreshedAt, cards }`
 * per `docs/planning/draft-pools-plan.md`'s "Cubes" design, with one card
 * holding a name Forge's card DB does not know.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { fillWithAi } from './podSeats.ts';
import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

/** A shortlisted cube's `{cube,size,cards}` file — A's `build-pool` output, read by its DISPLAY NAME rather than a guessed file stem. */
const CUBES_DIR = resolve(import.meta.dirname, '..', 'apps', 'server', 'pools', 'cubes');

interface CubeFile {
  cube: string;
  size: number;
  cards: { name: string }[];
}

function cubeFileNamed(name: string): CubeFile {
  const files = readdirSync(CUBES_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const data = JSON.parse(readFileSync(resolve(CUBES_DIR, file), 'utf8')) as CubeFile;
    if (data.cube === name) return data;
  }
  throw new Error(`no shortlisted cube file under ${CUBES_DIR} named ${JSON.stringify(name)} (found: ${files.join(', ')})`);
}

/** The cube radio for `name` — located by its drawn label, since the file stem (its `cubeId`) is A's own naming, not pinned here. */
function cubeRadio(page: Page, name: string) {
  return page.getByTestId('pool-picker-cubes').locator('label', { hasText: name }).locator('input[type="radio"]');
}

/** Every card name the viewer's open pack currently shows, off `CardTile`'s own `aria-label` ("Pick <name>"). */
async function packCardNames(page: Page): Promise<string[]> {
  const labels = await page.locator('[data-testid="pack"] [data-testid="card"]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.replace(/^Pick /, ''));
}

/**
 * A directory `e2e/play/harness.ts` does not yet point the server at — see
 * the file header. Written regardless, so wiring the one missing env var is
 * all that is left once it exists.
 */
const TEST_FIXTURE_ROOT = resolve(import.meta.dirname, '.run', 'draft-pools-cubes');
const UNPLAYABLE_NAME = 'Zzyzzyva, Card Forge Does Not Know';

function writeUnplayableCubeFixture(): void {
  rmSync(TEST_FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_FIXTURE_ROOT, { recursive: true });
  writeFileSync(
    resolve(TEST_FIXTURE_ROOT, 'e2e-unplayable.json'),
    JSON.stringify({
      id: 'e2e-unplayable',
      name: UNPLAYABLE_NAME,
      cubeCobraId: null,
      importedBy: 'fk:e2e-fixture',
      importedAt: new Date().toISOString(),
      refreshedAt: null,
      cards: [
        {
          cardId: 'c0',
          name: UNPLAYABLE_NAME,
          manaCost: ['1'],
          manaValue: 1,
          colors: [],
          typeLine: 'Creature',
          oracleText: '',
          setCode: 'TST',
          collectorNumber: '1',
          rarity: 'common',
        },
      ],
    }),
  );
}

test(
  titled("the leader picks the pod's cube, it is live for everyone seated, the first pack is drawn from it, and a Forge-unplayable cube is refused at selection"),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(6 * 60_000);

    // See the file header: set once harness.ts passes CARDTABLE_CUBES_DIR through.
    const testCubesDir = process.env.CARDTABLE_E2E_TEST_CUBES_DIR;
    if (testCubesDir !== undefined) writeUnplayableCubeFixture();
    else console.log('[draft-pools] CARDTABLE_E2E_TEST_CUBES_DIR is not set — the refused-cube half is skipped; see this file’s header for the exact harness change needed.');

    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    let alice: Player | undefined;
    let bob: Player | undefined;
    try {
      alice = await openFriend(browser, 'alice');
      bob = await openFriend(browser, 'bob');
      const players = [alice, bob];

      /* ── alice makes the draft room, bob finds it ────────────────────── */
      await alice.page.goto(`${origin}${PREFIX}/`);
      const roomName = `e2e draft-pools ${Date.now()}`;
      await submitCreateRoom(alice.page, { name: roomName, gameType: 'draft' });
      const roomId = await roomIdFromHash(alice.page);
      const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
      await bob.page.goto(roomUrl);
      for (const p of players) await expect(p.page.getByTestId('draft-lobby'), `${p.name}: joined the room`).toBeVisible({ timeout: UI_TIMEOUT });

      // "Which seat is mine" (and who the leader is) reads the room's own
      // member ids, not the harness's `e2e-<name>-id` — `w72-pod.spec.ts`'s own note.
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

      /* ── alice (the leader) picks a shortlisted cube; bob sees it live ── */
      for (const p of players) await expect(p.page.getByTestId('pool-picker-cubes'), `${p.name}: the pool picker is up`).toBeVisible({ timeout: UI_TIMEOUT });
      const LEGACY_CUBE = 'MTGO Legacy Cube 2021-08';
      await cubeRadio(alice.page, LEGACY_CUBE).click();
      await expect(alice.page.getByTestId('pool-picker-verdict'), "alice's pick checks out").toHaveAttribute('data-state', 'ready', { timeout: UI_TIMEOUT });
      await expect(cubeRadio(alice.page, LEGACY_CUBE), 'the picker shows it chosen').toBeChecked();
      await expect(cubeRadio(bob.page, LEGACY_CUBE), 'bob sees the same choice, with no reload').toBeChecked({ timeout: UI_TIMEOUT });

      /*
       * ── a cube Forge cannot play is refused at selection ──────────────
       *
       * Before the deal: once a plan is dealt it is final for the pod (the
       * picker is a LOBBY control), so "the previous choice is still the
       * room's plan" after a refused pick has to be proven here, not after
       * drafting has already started. `bob` never attempted anything, so HIS
       * screen — reading the room's own broadcast plan, not a local attempt —
       * is the proof that the real plan never moved.
       */
      if (testCubesDir !== undefined) {
        await expect(alice.page.getByTestId('pool-picker-cube-e2e-unplayable'), 'the injected test cube is listed').toBeVisible({ timeout: UI_TIMEOUT });
        await cubeRadio(alice.page, UNPLAYABLE_NAME).click();
        await expect(alice.page.getByTestId('pool-picker-verdict'), 'refused, naming the card Forge does not know').toHaveAttribute('data-state', 'refused', {
          timeout: UI_TIMEOUT,
        });
        await expect(alice.page.getByTestId('pool-picker-verdict')).toContainText(UNPLAYABLE_NAME);
        await expect(cubeRadio(alice.page, UNPLAYABLE_NAME), 'the picker shows the attempted name').toBeChecked();
        await expect(alice.page.getByTestId('ready-toggle'), 'Start is disabled').toBeDisabled();
        await expect(cubeRadio(bob.page, LEGACY_CUBE), 'the room’s own plan is untouched by alice’s refused attempt').toBeChecked();

        // Alice picks the good cube again — the one real way the picker ever
        // leaves a refused attempt, short of a reload (the server stores no
        // refused plan to recover from).
        await cubeRadio(alice.page, LEGACY_CUBE).click();
        await expect(alice.page.getByTestId('pool-picker-verdict'), 'ready again').toHaveAttribute('data-state', 'ready', { timeout: UI_TIMEOUT });
      } else {
        console.log('[draft-pools] CARDTABLE_E2E_TEST_CUBES_DIR is not set — the refused-cube half is skipped; see this file’s header for the exact harness change needed.');
      }

      /* ── both sit, ready, and the rest of the pod fills with AI ────────── */
      await alice.page.locator('[data-testid="pod-seat-sit"][data-seat="0"]').click();
      await bob.page.locator('[data-testid="pod-seat-sit"][data-seat="1"]').click();
      for (const p of players) await expect(p.page.getByTestId('pod-seat-stand'), `${p.name}: holds their own seat`).toBeVisible({ timeout: UI_TIMEOUT });
      for (const p of players) await p.page.getByTestId('ready-toggle').click();
      await fillWithAi(alice.page, UI_TIMEOUT);
      for (const p of players) await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });

      /* ── every card in alice's first pack is in the Legacy Cube's own list ── */
      await expect(alice.page.locator('[data-testid="pack"] [data-testid="card"]').first(), "alice's first pack is up").toBeVisible({ timeout: UI_TIMEOUT });
      const legacyCube = cubeFileNamed(LEGACY_CUBE);
      const legacyNames = new Set(legacyCube.cards.map((c) => c.name));
      const firstPack = await packCardNames(alice.page);
      expect(firstPack.length, 'the pack drew cards at all').toBeGreaterThan(0);
      for (const name of firstPack) expect(legacyNames.has(name), `${name} is in ${LEGACY_CUBE} (${legacyCube.size} cards)`).toBe(true);
    } finally {
      // `stack.stop()` closes every open `openFriend` context itself and renames
      // its video under `CARDTABLE_E2E_VIDEO=1` (`w72-pod.spec.ts`'s own note);
      // closing them here first would leave that footage unrenamed.
      await stack.stop();
    }
  },
);
