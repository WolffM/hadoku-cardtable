/**
 * The room's client mode, end to end, against the REAL built server.
 *
 * D19a settled that which client a room runs is the ROOM's property, chosen
 * once at create and never again. This drives that through the product path a
 * person uses: the front page's create form, the POST it sends, the room it
 * lands you in, and the list everyone else reads before they join.
 *
 * ## It needs no containers, on purpose
 *
 * CI has no docker and no stream containers, and must stay green. So the
 * streamed room here is asserted on the thing that is true without them: each
 * seat states that it is **waiting for the stream**. That is not a weaker
 * check — it is the check for the environment this runs in, and it is the one
 * that catches the failure that would otherwise ship. With no containers the
 * server's SPA fallback answers every `/stream/**` path with our own
 * `index.html` and HTTP 200, so a seat that trusted `res.ok` would frame the
 * cardtable app inside itself and call it a stream. The waiting line being
 * there is the proof that it did not.
 *
 * ## Both game types, one form
 *
 * Since w23 the room list is the only front door, so this create form is the
 * only place a draft is started from — the "Start a pod" button and the
 * paste-an-id box are gone. The draft option is therefore selectable and
 * plainly labelled, which is asserted beside the mode choice below; what
 * happens after you pick it is `e2e/draft.spec.ts`'s whole subject. The rooms
 * made here stay `constructed-1v1`, because client mode is what they are about.
 *
 * ## The seat's probe is aborted in the browser, deliberately
 *
 * Touching `/stream/<roomKey>/<seat>/` for a streamed room is what makes the
 * server PROVISION that room's containers (`stream/alloc.ts`, fire-and-forget
 * by design). On this host that is a real `docker run` per seat and about
 * 2.5 GiB — from a test, on the machine that also runs production cardtable
 * and the friend demo's bench. So the probe is aborted at the browser, and
 * the path it asked for is asserted instead: `/cardtable/stream/<room>/<seat>/`,
 * same-origin, room-keyed, one per seat. An aborted probe is exactly what a
 * machine with no containers looks like from inside the page, which is the
 * state this spec is here to pin.
 *
 * ## What is NOT proven here
 *
 * A seat with a live container behind it, and the server's own 503 for a seat
 * it has not provisioned. Both need the allocation this spec declines to
 * trigger. `apps/ui/src/screens/constructed.test.ts` drives the up-and-framed
 * branch against a stubbed stream; a live one is the stream lane's ground.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

test.describe.configure({ mode: 'serial' });

interface Friend {
  name: string;
  context: BrowserContext;
  page: Page;
  /** Every `POST /api/rooms` body this browser sent, in order. */
  creates: Record<string, unknown>[];
  /** Requests that tried to leave 127.0.0.1 — blocked, and asserted on. */
  blocked: string[];
  /** Stream paths the page asked for — aborted, and asserted on. See the header. */
  streamProbes: string[];
}

/** Hosts card art may come from (CLAUDE.md, D15; unrestricted since D18) — the same set `draft.spec.ts` excuses. */
const ART_HOSTS = new Set(['cdn.hadoku.me', 'cards.scryfall.io']);

async function open(browser: Browser, name: string): Promise<Friend> {
  const context = await browser.newContext();
  await context.addCookies([
    { name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  const friend: Friend = { name, context, page, creates: [], blocked: [], streamProbes: [] };

  // Nothing leaves the machine — including anything a stream frame might pull.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') {
      friend.blocked.push(url.href);
      return route.abort('blockedbyclient');
    }
    // The seat's stream probe. Answering it would make the server provision
    // this room's containers for real; see the header.
    if (url.pathname.startsWith(`${PREFIX}/stream/`)) {
      friend.streamProbes.push(url.pathname);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().endsWith('/api/rooms')) return;
    const body = req.postData();
    if (body !== null) friend.creates.push(JSON.parse(body) as Record<string, unknown>);
  });

  return friend;
}

/** The room id the app navigated to, off the hash a person could copy. */
async function roomIdFromHash(page: Page): Promise<string> {
  await page.waitForFunction(() => /^#\/room\/[a-z0-9-]+$/.test(window.location.hash), null, { timeout: 20_000 });
  const hash = await page.evaluate(() => window.location.hash);
  return hash.replace('#/room/', '');
}

/** Fills the create form, picks a mode, submits, and returns the new room's id. */
async function createRoom(f: Friend, name: string, mode: 'builtin' | 'streamed'): Promise<string> {
  await f.page.goto(`${PREFIX}/`);
  await expect(f.page.getByTestId('room-create')).toBeVisible();

  // The choice is visible BEFORE the room is made, and our table is the one
  // already picked — no hidden default, and never streamed by accident. Labels
  // only: the UI states the choice, it does not explain it.
  await expect(f.page.getByTestId('room-create-mode-builtin')).toBeChecked();
  await expect(f.page.getByTestId('room-create-mode-streamed')).not.toBeChecked();
  await expect(f.page.getByTestId('room-create-mode')).toContainText('Our table');
  await expect(f.page.getByTestId('room-create-mode')).toContainText('Forge’s full client');

  // Both game types are pickable now (w23): a draft is a room like any other,
  // so the draft option is no longer disabled and no longer says "coming soon".
  // `e2e/draft.spec.ts` is what drafts through it; this is the form's own proof
  // that the door is open, next to the modes it already checks.
  const draftOption = f.page.locator('[data-testid="room-create-type"] option[value="draft"]');
  await expect(draftOption).not.toBeDisabled();
  await expect(draftOption).toHaveText('Draft');

  await f.page.getByTestId('room-create-name').fill(name);
  await f.page.getByTestId('room-create-type').selectOption('constructed-1v1');
  await f.page.getByTestId(`room-create-mode-${mode}`).check();
  await f.page.getByTestId('room-create-submit').click();

  const id = await roomIdFromHash(f.page);
  // What actually went on the wire, not what the form was showing.
  expect(f.creates.at(-1)).toMatchObject({ name, gameType: 'constructed-1v1', clientMode: mode });
  return id;
}

const rowFor = (page: Page, roomId: string) =>
  page.locator(`[data-testid="room-row"][data-room-id="${roomId}"]`);

test.describe('the room decides which client', () => {
  test('a builtin room is our table, a streamed room is one screen per seat, and the list says which', async ({
    browser,
  }) => {
    const alice = await open(browser, 'alice');

    /* ── our table ────────────────────────────────────────────────────── */

    const builtinId = await createRoom(alice, `e2e builtin ${Date.now()}`, 'builtin');
    await expect(alice.page.getByTestId('constructed')).toBeVisible();
    // The mode in the header, and the deck picker a builtin room has always had.
    await expect(alice.page.getByTestId('room-client-mode')).toHaveText(
      'Constructed 1v1',
    );
    await expect(alice.page.getByTestId('deck-mine')).toBeVisible();
    await expect(alice.page.getByTestId('room-players')).toBeVisible();
    await expect(alice.page.getByTestId('room-streams')).toHaveCount(0);

    /* ── Forge's full client ──────────────────────────────────────────── */

    const streamedId = await createRoom(alice, `e2e streamed ${Date.now()}`, 'streamed');
    await expect(alice.page.getByTestId('constructed')).toBeVisible();
    await expect(alice.page.getByTestId('room-client-mode')).toContainText('Forge’s full client');
    await expect(alice.page.getByTestId('room-streams')).toBeVisible();

    // The creator is a member, so there is one seat, and it is honest about
    // having no container behind it. Never a spinner, never a frame of us.
    const seats = alice.page.getByTestId('stream-seat');
    await expect(seats).toHaveCount(1);
    await expect(alice.page.getByTestId('stream-waiting')).toHaveText(
      'No screen yet.',
    );
    await expect(alice.page.getByTestId('stream-frame')).toHaveCount(0);

    // And it asked the right server for it: room-keyed, seat-keyed, same-origin
    // — and for `vnc.html`, not the seat's ROOT. websockify answers the root
    // with a directory listing, so a seat that asked for it framed a file index
    // and never connected. `e2e/streamed-live.spec.ts` is what caught that,
    // because it is the one that lets the probe through to a real container.
    await expect.poll(() => alice.streamProbes.length).toBeGreaterThan(0);
    expect(new Set(alice.streamProbes)).toEqual(
      new Set([`${PREFIX}/stream/${streamedId}/0/vnc.html`]),
    );

    // And none of the builtin table is here: a streamed room loads no deck.
    await expect(alice.page.getByTestId('deck-mine')).toHaveCount(0);
    await expect(alice.page.getByTestId('ready-toggle')).toHaveCount(0);

    /* ── the list, read by somebody who was not there ─────────────────── */

    const bob = await open(browser, 'bob');
    await bob.page.goto(`${PREFIX}/`);
    await expect(rowFor(bob.page, builtinId)).toBeVisible();
    await expect(rowFor(bob.page, streamedId)).toBeVisible();
    await expect(rowFor(bob.page, builtinId).getByTestId('room-mode')).toHaveText('our table');
    await expect(rowFor(bob.page, streamedId).getByTestId('room-mode')).toHaveText('streamed Forge');

    // Nothing reached for anything off this machine EXCEPT card art — and even
    // that never left: every off-loopback request is aborted above, so "blocked"
    // means ATTEMPTED. Art from the two art hosts is the product working (D15,
    // D18), and `draft.spec.ts` has always excused it the same way
    // (`ART_HOSTS`). This spec used to demand an empty list and passed only by
    // racing the deck chooser: it left the builtin room the instant
    // `deck-mine` was visible, and `deck-mine` was visible with ZERO rows while
    // `Random` lived inside it and gave it height. Moving Random above the list
    // (operator, 2026-09-30) made an empty list zero-height, so the spec now
    // waits for the 29 rows — whose art it then sees. Measured at both commits:
    // given 1.5 s, the old layout attempts the same 19 art URLs. The race was
    // hiding them; this names them.
    const notArt = (urls: readonly string[]) => urls.filter((u) => !ART_HOSTS.has(new URL(u).hostname));
    expect(notArt(alice.blocked), 'alice made an off-host request that is not card art').toEqual([]);
    expect(notArt(bob.blocked), 'bob made an off-host request that is not card art').toEqual([]);
    // And the builtin room never asked for a stream at all — a room that is
    // our table costs no container, which is the whole point of the toggle.
    expect(alice.streamProbes.some((p) => p.includes(builtinId))).toBe(false);

    await alice.context.close();
    await bob.context.close();
  });
});
