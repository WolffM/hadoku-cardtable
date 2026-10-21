/**
 * The sound builder, end to end, against the REAL built server — admin can
 * place a take and have it survive a reload; a friend gets the screens to
 * listen to and no editor. Then the match-music review (`#/sounds/music`): a
 * friend picks, submits, and finds the submission restored and on disk.
 *
 * Operator, 2026-10-05: *"somewhat concerned about this being an artifact
 * rather than a real thing on my site… let's do the server-hosted sounds for
 * the builder."* This is the proof that it is one: `#/sounds` is a route in
 * the real built app, `/api/sounds/*` is a router on the real built server,
 * and what gets saved lives in a file under the server's own data directory
 * rather than in an artifact's database.
 *
 * ## The synthetic catalogue, and why it is built here rather than imported
 *
 * `docs/handoff/snapshot/` is a read-only reference (CLAUDE.md, the wave
 * file): nothing here reads it, and nothing commits audio. The harness
 * (`e2e/harness.ts`) leaves `CARDTABLE_SOUNDS_DIR` unset, so the server's
 * default — `resolve(logDir, '../data/sounds')`, `logDir` being
 * `<RUN_DIR>/logs` — resolves to `<RUN_DIR>/data/sounds`, the same `data/`
 * sibling `draft.spec.ts`'s room store already lives under. `beforeAll` writes
 * two "take" files there plus a `catalogue.json` naming them, so the server's
 * `/api/sounds/catalogue` answers with a real (if tiny) catalogue on every
 * run. The directory is wiped first: unlike the room list, nothing about this
 * spec wants yesterday's assignment to still be on a cell.
 *
 * **The two "takes" are a few deterministic placeholder bytes, not real
 * audio, and that is deliberate.** CI runs this spec on the fleet's CI runners
 * (`ci.yml`'s "E2E — two friends draft one pod" job), not on the host, and
 * nothing establishes that those runners have `ffmpeg` on `PATH` — a spec that
 * shells out to generate a silent Opus file would turn main red on a missing
 * binary that has nothing to do with the product. This spec asserts
 * PLACEMENT and PERSISTENCE (a take's path is accepted, saved, and survives a
 * reload), never playback or decoding, so undecodable bytes behind a real
 * `.ogg`-shaped path prove exactly as much. The `pageerror` collector below is
 * the check that clicking a pill with garbage bytes behind it stays inside
 * the mixer's own fail-soft catch (`sound/mixer.ts`) rather than surfacing as
 * a page-level exception.
 *
 * ## The admin identity
 *
 * The stand-in edge hardcoded tier `friend` for everyone in `FRIENDS` — true
 * before this wave, because nothing needed more. `identities.ts` now carries
 * an optional `tier` per identity (`edge.ts` stamps `identity.tier ?? 'friend'`,
 * so every identity that does not set one is exactly as before) and one new
 * `admin` entry. That is the full extent of the change outside this file.
 *
 * ## What is NOT proven here
 *
 * `apps/server/src/http/sounds.test.ts` (lane S) is the place for traversal
 * attempts, a malformed cell, and the 403/400 shapes in detail; this spec
 * only needs the two outcomes a real browser sees — an editable grid, or
 * nothing.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

test.describe.configure({ mode: 'serial' });

const RUN_DIR = resolve(import.meta.dirname, '.run');
const SOUNDS_DIR = resolve(RUN_DIR, 'data', 'sounds');
const TAKES_DIR = resolve(SOUNDS_DIR, 'takes', 'w50-test');

const TAKE_A = 'w50-test/take-a.ogg';
const TAKE_B = 'w50-test/take-b.ogg';
/** The W match-music slot: one assigned track and one generated take, named the way the catalogue names them. */
const MUSIC_CELL = 'music.match.W|play';
const MUSIC_WEB = 'w50-music/take-web.ogg';
const MUSIC_GEN = 'w50-music/take-jig.ogg';
/** A role cell: on the builder's default Roles tab, and played by the sandbox's opening. */
const CELL = 'g.draw|play';

test.beforeAll(async () => {
  await rm(SOUNDS_DIR, { recursive: true, force: true });
  await mkdir(TAKES_DIR, { recursive: true });
  // Not real audio — see the header. Distinct, deterministic bytes per file,
  // just enough that two different takes are not byte-identical by accident.
  await writeFile(resolve(TAKES_DIR, 'take-a.ogg'), Buffer.from('w50 placeholder take a'));
  await writeFile(resolve(TAKES_DIR, 'take-b.ogg'), Buffer.from('w50 placeholder take b'));
  await mkdir(resolve(SOUNDS_DIR, 'takes', 'w50-music'), { recursive: true });
  await writeFile(resolve(SOUNDS_DIR, 'takes', MUSIC_WEB), Buffer.from('w50 placeholder music web'));
  await writeFile(resolve(SOUNDS_DIR, 'takes', MUSIC_GEN), Buffer.from('w50 placeholder music jig'));
  const catalogue = {
    takes: [
      {
        file: TAKE_A,
        sound: 'w50-test',
        name: 'w50 test',
        group: 'w50 test',
        section: 'Library',
        label: 'w50 test · a',
        seconds: 0.3,
        prompt: 'placeholder a (not real audio — see the file header)',
      },
      {
        file: TAKE_B,
        sound: 'w50-test',
        name: 'w50 test',
        group: 'w50 test',
        section: 'Library',
        label: 'w50 test · b',
        seconds: 0.3,
        prompt: 'placeholder b (not real audio — see the file header)',
      },
      {
        file: MUSIC_WEB,
        sound: 'w50-music-web',
        name: 'w50 web track',
        group: 'Music',
        section: 'Music',
        label: 'w50 web track',
        seconds: 0.3,
        prompt: 'placeholder music (not real audio — see the file header)',
      },
      {
        file: MUSIC_GEN,
        sound: 'w50-music-jig',
        name: 'W · w50 jig',
        group: 'Music',
        section: 'Music',
        label: 'W · w50 jig',
        seconds: 0.3,
        prompt: 'placeholder music (not real audio — see the file header)',
      },
    ],
  };
  await writeFile(resolve(SOUNDS_DIR, 'catalogue.json'), JSON.stringify(catalogue));
  await writeFile(resolve(SOUNDS_DIR, 'assignments.json'), JSON.stringify({ cells: { [MUSIC_CELL]: [MUSIC_WEB] }, gains: {} }));
});

interface Friend {
  context: BrowserContext;
  page: Page;
}

async function open(browser: Browser, name: string): Promise<Friend> {
  const context = await browser.newContext();
  await context.addCookies([
    { name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  return { context, page };
}

test('admin can place a take and reload to find it saved; a friend listens and edits nothing', async ({ browser }) => {
  const admin = await open(browser, 'admin');
  const friend = await open(browser, 'bob');

  // Nothing on this page should ever throw as an uncaught page-level error —
  // in particular, clicking a pill whose bytes are not real audio must stay
  // inside the mixer's own fail-soft `catch` (`sound/mixer.ts`) rather than
  // surfacing here. Attached to the ADMIN page, the only one that
  // clicks a pill.
  const pageErrors: Error[] = [];
  admin.page.on('pageerror', (err) => pageErrors.push(err));

  try {
    // ── the friend first: the screens are friend tier, writes are not ────
    await friend.page.goto(`${PREFIX}/#/sounds`);
    await expect(friend.page.getByRole('heading', { name: 'Sound Builder' })).toBeVisible();
    // A pill to hear, and nothing that picks up, removes, levels or queues.
    await expect(friend.page.getByRole('button', { name: 'w50 test · a: play' })).toBeVisible();
    await expect(friend.page.getByRole('button', { name: /play and pick up/ })).toHaveCount(0);
    await expect(friend.page.getByRole('button', { name: 'Queue' })).toHaveCount(0);
    await expect(friend.page.locator('.sound-builder__pill-remove')).toHaveCount(0);
    await expect(friend.page.locator('input[type="range"]')).toHaveCount(0);
    // And the gate is the SERVER's, not just the screen's own choice not to
    // render: the friend's own request for the assignments says so too.
    const friendAssignments = await friend.page.request.get(`${PREFIX}/api/sounds/assignments`);
    expect(friendAssignments.ok()).toBe(true);
    expect((await friendAssignments.json()).canEdit).toBe(false);

    // ── the admin: the real editor, with the real synthetic catalogue ────
    await admin.page.goto(`${PREFIX}/#/sounds`);
    await expect(admin.page.getByRole('heading', { name: 'Sound Builder' })).toBeVisible();

    const pill = admin.page.getByRole('button', { name: 'w50 test · a: play and pick up' });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');

    const cell = admin.page.locator(`[data-cell="${CELL}"]`);
    // The cell draws the take at once and saves it behind (`SoundBuilder.tsx`'s `persist`), so
    // nothing on screen says the save is done: no `data-unsaved` reads the same before the PUT
    // has answered as after it succeeded. A reload in that gap lost the save (CI `check` on
    // 80394f32 and 5b386ac5). The server's own answer is the signal.
    const saved = admin.page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/sounds/assignments/${encodeURIComponent(CELL)}`),
    );
    await cell.click();

    // Placed: the bin pill shows the placed dot, and the cell holds the take.
    await expect(pill).toHaveAttribute('data-placed', '');
    await expect(cell.locator('.sound-builder__pill--placed')).toContainText('w50 test · a');
    expect((await saved).status(), 'the server stored the cell').toBe(200);
    await expect(cell).not.toHaveAttribute('data-unsaved', '');

    // The save is server-hosted, not client state: reload and it is still there.
    await admin.page.reload();
    await expect(admin.page.getByRole('heading', { name: 'Sound Builder' })).toBeVisible();
    const reloadedCell = admin.page.locator(`[data-cell="${CELL}"]`);
    const reloadedPlaced = reloadedCell.locator('.sound-builder__pill--placed');
    await expect(reloadedPlaced).toContainText('w50 test · a');
    // Click the PLACED pill too: a second path (`onPlayPill`, not the bin's
    // pick-up click) that fetches the same not-really-audio bytes and plays
    // them through the mixer.
    await reloadedPlaced.click();

    // ── the sandbox: the same assignments, played as a scenario ──────────
    await friend.page.goto(`${PREFIX}/#/sounds/sandbox`);
    await expect(friend.page.getByRole('heading', { name: 'Sound Sandbox' })).toBeVisible();
    await expect(friend.page.getByRole('columnheader', { name: 'Gain' })).toHaveCount(0);

    await admin.page.getByRole('link', { name: 'Sandbox' }).click();
    await expect(admin.page.getByRole('heading', { name: 'Sound Sandbox' })).toBeVisible();
    await admin.page.getByRole('button', { name: 'Opening hands' }).click();
    await admin.page.getByRole('button', { name: 'Play' }).click();
    // A draw beat fired and named the take it played: the assignment above,
    // through the planner, into the row.
    await expect(admin.page.locator('tr[data-fired]').filter({ hasText: 'w50 test · a' }).first()).toBeVisible();

    // Every play — the bin pill, the placed pill, the scenario — ran against
    // bytes that are not real audio, and none reached here: the mixer's
    // fail-soft `catch` held each time.
    expect(pageErrors).toEqual([]);
  } finally {
    await admin.context.close();
    await friend.context.close();
  }
});

test('a friend reviews the match music: picks both lanes, submits, finds it restored and on disk, then resets to a blank round', async ({ browser }) => {
  const friend = await open(browser, 'bob');
  const pageErrors: Error[] = [];
  friend.page.on('pageerror', (err) => pageErrors.push(err));
  try {
    await friend.page.goto(`${PREFIX}/#/sounds`);
    await friend.page.getByRole('link', { name: 'Music' }).click();
    await expect(friend.page.getByRole('heading', { name: 'Match Music' })).toBeVisible();
    await expect(friend.page.getByTestId('music-review-slot')).toHaveCount(15);

    const slot = friend.page.locator(`[data-testid="music-review-slot"][data-cell="${MUSIC_CELL}"]`);
    await expect(slot.locator('.music-review__track')).toHaveCount(2);
    await expect(slot.locator('.music-review__track').first()).toHaveAttribute('data-current', '');
    // Not real audio: the play has to fail soft, never as a page error.
    await slot.getByRole('button', { name: 'Play W · w50 jig' }).click();
    await slot.getByRole('button', { name: 'Pick W · w50 jig' }).click();
    await slot.getByRole('button', { name: 'Pick w50 web track' }).click();
    await slot.getByRole('group', { name: 'Rate w50 web track' }).getByRole('button', { name: 'No' }).click();
    await slot.getByRole('textbox', { name: 'W note' }).fill('the jig');

    const submit = friend.page.getByTestId('music-review-submit');
    const stored = friend.page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/sounds/music-review'));
    await submit.click();
    expect((await stored).status(), 'the server stored the review').toBe(200);
    await expect(submit).toHaveAttribute('data-state', 'saved');

    await friend.page.reload();
    await expect(friend.page.getByRole('heading', { name: 'Match Music' })).toBeVisible();
    await expect(slot.getByRole('button', { name: 'Pick W · w50 jig' })).toHaveAttribute('aria-pressed', 'true');
    await expect(slot.getByRole('button', { name: 'Pick w50 web track' })).toHaveAttribute('aria-pressed', 'true');
    await expect(slot.getByRole('textbox', { name: 'W note' })).toHaveValue('the jig');
    await expect(submit).toHaveAttribute('data-state', 'saved');

    const lines = (await readFile(resolve(SOUNDS_DIR, 'music-reviews.jsonl'), 'utf8')).trimEnd().split('\n');
    const last = JSON.parse(lines.at(-1)!) as { userId: string; slots: Record<string, unknown> };
    expect(last.userId).toBe('e2e-bob-id');
    expect(last.slots).toEqual({
      [MUSIC_CELL]: { picks: [MUSIC_GEN, MUSIC_WEB], ratings: { [MUSIC_WEB]: 'no' }, note: 'the jig' },
    });

    // Reset, pressed twice: a blank form that a reload does not fill back in, and the file as it was.
    const reset = friend.page.getByTestId('music-review-reset');
    await reset.click();
    await expect(reset).toHaveAttribute('data-armed', '');
    await reset.click();
    const said = '[data-testid="music-review-pick"][aria-pressed="true"], .music-review__rate[aria-pressed="true"]';
    await expect(slot.locator(said)).toHaveCount(0);
    await expect(slot.getByRole('textbox', { name: 'W note' })).toHaveValue('');
    await friend.page.reload();
    await expect(friend.page.getByRole('heading', { name: 'Match Music' })).toBeVisible();
    await expect(friend.page.locator(said)).toHaveCount(0);
    await expect(submit).toBeDisabled();
    expect((await readFile(resolve(SOUNDS_DIR, 'music-reviews.jsonl'), 'utf8')).trimEnd().split('\n')).toEqual(lines);
    expect(pageErrors).toEqual([]);
  } finally {
    await friend.context.close();
  }
});
