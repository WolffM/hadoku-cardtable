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
 * ## The injected test cube
 *
 * "A cube whose verdict is refused" has to be a real, selectable row in the
 * picker — the acceptance text says the picker SHOWS that name — so it comes
 * from the server's own `GET /api/pools/cubes`, not a value typed past the
 * UI. `play/harness.ts`'s `PLAY_CUBES_DIR` is the spawned server's
 * `CARDTABLE_CUBES_DIR` (its import store); this spec writes a fixture
 * cube — one card holding a name Forge's card DB does not know — directly
 * into it, in `importDir/<id>.json`'s own on-disk shape
 * (`apps/server/src/pools/cubes.ts`, landed §C, `ffc26caf`): `{ id, name,
 * cubeCobraId, importedBy, importedAt, refreshedAt, verdict, cards }`, `cards`
 * the trimmed `{ name, scryfallId }` Cube Cobra projection — BEFORE
 * `startPlayStack` spawns the server, because `createCubeStore` reads that
 * directory once, at boot (`PLAY_CUBES_DIR`'s own comment). This runs every
 * time, with no gate: if the seeded cube is ever missing from the picker, that
 * is this spec failing, not skipping — a skip here would look exactly like a
 * pass.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { fillWithAi, readyPod } from './podSeats.ts';
import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, PLAY_CUBES_DIR, startPlayStack } from './play/harness.ts';
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

const UNPLAYABLE_ID = 'e2e-unplayable';
const UNPLAYABLE_NAME = 'Zzyzzyva, Card Forge Does Not Know';

/**
 * `PLAY_CUBES_DIR/<id>.json` — `importDir`'s own on-disk shape, per
 * `apps/server/src/pools/cubes.ts`'s `parseImportFile`: `id`/`name`/
 * `cubeCobraId`/`importedBy`/`importedAt` all strings (`cubeCobraId: null`
 * parses as "malformed" — confirmed by reading `parseImportFile` after it
 * rejected a first draft of this fixture), `cards` the TRIMMED Cube Cobra
 * projection (`{ name, scryfallId }`, never the derived `DraftCard[]`) — the
 * catalog resolves gameplay text by name at load, which is exactly how a
 * name it does not know (this fixture's whole point) produces `missingText`
 * rather than a shape error. Must run BEFORE `startPlayStack`: the store
 * reads this directory once, at the spawned server's own boot
 * (`PLAY_CUBES_DIR`'s own comment in `play/harness.ts`).
 */
function seedUnplayableCube(): void {
  rmSync(PLAY_CUBES_DIR, { recursive: true, force: true });
  mkdirSync(PLAY_CUBES_DIR, { recursive: true });
  writeFileSync(
    resolve(PLAY_CUBES_DIR, `${UNPLAYABLE_ID}.json`),
    JSON.stringify({
      id: UNPLAYABLE_ID,
      name: UNPLAYABLE_NAME,
      cubeCobraId: 'e2e-fixture',
      importedBy: 'fk:e2e-fixture',
      importedAt: new Date().toISOString(),
      refreshedAt: null,
      verdict: null,
      cards: [{ name: UNPLAYABLE_NAME, scryfallId: null }],
    }),
  );
}

test(
  titled("the leader picks the pod's cube, it is live for everyone seated, the first pack is drawn from it, and a Forge-unplayable cube is refused at selection"),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(6 * 60_000);

    seedUnplayableCube();

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
      await expect(alice.page.getByTestId(`pool-picker-cube-${UNPLAYABLE_ID}`), 'the injected test cube is listed').toBeVisible({ timeout: UI_TIMEOUT });
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

      /* ── both sit, ready, and the rest of the pod fills with AI ────────── */
      await alice.page.locator('[data-testid="pod-seat-sit"][data-seat="0"]').click();
      await bob.page.locator('[data-testid="pod-seat-sit"][data-seat="1"]').click();
      for (const p of players) await expect(p.page.getByTestId('pod-seat-stand'), `${p.name}: holds their own seat`).toBeVisible({ timeout: UI_TIMEOUT });
      for (const p of players) await readyPod(p.page);
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
