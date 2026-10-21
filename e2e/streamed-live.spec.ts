/**
 * A streamed room with REAL containers behind it, driven by two real browsers.
 *
 * `room-mode.spec.ts` is the containerless half: it aborts every `/stream/**`
 * request so CI, which has no docker, stays green. Everything downstream of
 * that abort was therefore unproven — the allocator had never once started a
 * container outside a dry run, and "ready for a human to test" rested on unit
 * tests of a script that had never run for real.
 *
 * This spec is that half. It lets the seats probe for real, so the server
 * provisions, and then asks the only question that matters: **is a person
 * looking at Forge?** Not at our own SPA framed inside itself (what the
 * containerless failure mode produces, 200 and all), and not at a spinner.
 *
 * ## It skips itself rather than failing where it cannot run
 *
 * CI has no docker and no image. A red there would say "the product is broken"
 * when it means "this machine cannot host a container", so the preconditions
 * are checked and the spec skips with the reason named.
 *
 * ## What it is allowed to touch
 *
 * Only `cardtable-e2e-room-*` on ports 6300+ — see `streamNamespace.ts` for why
 * that namespace exists and what sharing production's would destroy. The
 * teardown removes what this run created, by name, and asserts the host is as
 * it was found: the bench and any production room containers are never listed,
 * let alone removed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { STREAM_NAME_PREFIX } from './streamNamespace.ts';
import { createStreamedRoomByApi, submitCreateRoom } from './play/rooms.ts';

const run = promisify(execFile);

test.describe.configure({ mode: 'serial' });

/** Containers this run is responsible for, whatever happens to the assertions. */
const created = new Set<string>();

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: 60_000 });
  return stdout.trim();
}

/** Our containers for ONE room — the only count a test should assert on. */
async function mine(roomId: string): Promise<string[]> {
  return (await ours()).filter((n) => n.startsWith(`${STREAM_NAME_PREFIX}-${roomId}-`));
}

/**
 * Every docker NETWORK this harness owns. Same prefix rule as the containers,
 * so a sweep can never see production's or the friend-demo bench's.
 */
async function ourNetworks(): Promise<string[]> {
  const out = await docker(['network', 'ls', '--format', '{{.Name}}']);
  return out === '' ? [] : out.split('\n').filter((n) => n.startsWith(STREAM_NAME_PREFIX));
}

/** Every container on this host whose name is OURS. Never production's. */
async function ours(): Promise<string[]> {
  const out = await docker(['ps', '-a', '--format', '{{.Names}}']);
  return out === '' ? [] : out.split('\n').filter((n) => n.startsWith(STREAM_NAME_PREFIX));
}

let usableMemo: string | null | undefined;

/**
 * Why this machine cannot host a container, or null if it can.
 *
 * Memoised because `afterAll` asks too, and it must reach the same verdict as
 * the tests did — on the fleet's CI CI runners `docker` is INSTALLED but the runner
 * has no permission on the daemon socket, so a naive teardown shells
 * `docker ps`, gets "permission denied", and reds a run in which every test
 * correctly skipped. That is exactly how this spec first broke CI.
 */
async function dockerUsable(): Promise<string | null> {
  if (usableMemo !== undefined) return usableMemo;
  usableMemo = await computeDockerUsable();
  return usableMemo;
}

async function computeDockerUsable(): Promise<string | null> {
  try {
    // `docker version` talks to the DAEMON, so it fails on a host where the
    // binary exists but the socket is not ours — which is the case CI has.
    await docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    return 'no usable docker on this machine (absent, or no permission on the daemon socket)';
  }
  const image = process.env.CARDTABLE_STREAM_IMAGE ?? 'cardtable-stream-spike:w14';
  const found = await docker(['images', '-q', image]);
  return found === '' ? `the stream image ${image} is not built here` : null;
}

interface Friend {
  name: string;
  context: BrowserContext;
  page: Page;
  blocked: string[];
}

async function open(browser: Browser, name: string): Promise<Friend> {
  const context = await browser.newContext();
  await context.addCookies([
    { name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  const friend: Friend = { name, context, page, blocked: [] };

  // Nothing leaves the machine. Note what is NOT blocked here, unlike
  // room-mode.spec.ts: `/stream/**` is allowed through, which is the point.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') {
      friend.blocked.push(url.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return friend;
}

async function createStreamedRoom(f: Friend, name: string): Promise<string> {
  await f.page.goto(`${PREFIX}/`);
  await expect(f.page.getByTestId('room-create-open')).toBeVisible();
  // The form offers no client any more (2026-10-10); the API still makes a streamed room.
  await createStreamedRoomByApi(f.page, name);
  await f.page.waitForFunction(() => /^#\/room\/[a-z0-9-]+$/.test(window.location.hash), null, { timeout: 20_000 });
  return (await f.page.evaluate(() => window.location.hash)).replace('#/room/', '');
}

test.afterAll(async () => {
  // Inert where docker is not ours to talk to: nothing can have been created,
  // and asking anyway is what turned a fully-skipped CI run red.
  if ((await dockerUsable()) !== null) {
    expect(created.size, 'containers were created on a host with no usable docker').toBe(0);
    return;
  }
  // Otherwise unconditional: a failed assertion must not leave 1.25 GiB per
  // seat running on the machine that hosts production.
  for (const name of created) {
    await docker(['rm', '-f', name]).catch(() => '');
  }
  expect(await ours(), 'this run left containers behind').toEqual([]);

  // ── and the NETWORKS, which are the leak nobody saw ──────────────────────
  // Every streamed room gets its own docker network, and removing a container
  // does not remove the network it was on. Twenty-two of them accumulated on
  // this host between 2026-09-18 and 2026-09-25 — one per e2e run — until
  // docker refused to make another: `all predefined address pools have been
  // fully subnetted`, which fails provisioning for EVERY service on the
  // machine, not just this one. A container census cannot see this; the
  // network census below can.
  for (const net of await ourNetworks()) {
    await docker(['network', 'rm', net]).catch(() => '');
  }
  expect(await ourNetworks(), 'this run left docker networks behind').toEqual([]);
});

test('two friends, one streamed room: the server provisions, and each seat frames real Forge', async ({
  browser,
}) => {
  const why = await dockerUsable();
  test.skip(why !== null, why ?? '');
  test.setTimeout(5 * 60_000);

  // The host as we found it. Production's containers and the bench must be
  // untouched at the end, so they are recorded rather than assumed.
  const foreignBefore = (await docker(['ps', '-a', '--format', '{{.Names}}']))
    .split('\n')
    .filter((n) => n !== '' && !n.startsWith(STREAM_NAME_PREFIX));

  const alice = await open(browser, 'alice');
  const roomId = await createStreamedRoom(alice, `e2e live ${Date.now()}`);

  const bob = await open(browser, 'bob');
  await bob.page.goto(`${PREFIX}/#/room/${roomId}`);

  // A constructed room provisions two seats regardless of who has arrived
  // (`streamedSeats` in index.ts), so both browsers should end up framed.
  for (const f of [alice, bob]) {
    await expect(f.page.getByTestId('room-streams'), `${f.name} sees the streams card`).toBeVisible();
  }

  // The seats start honest — no container exists yet at this instant.
  await expect(alice.page.getByTestId('stream-seat').first()).toBeVisible();

  // ── the server provisions, for real ──────────────────────────────────────
  // The probe is fire-and-forget and the seat re-asks every STREAM_PROBE_MS,
  // so this waits on the CONTAINERS, which is the fact under test.
  // Wait for ALL of them, not merely one: `streamedSeats` gives a constructed
  // room two seats whoever has arrived, and polling for "at least one" let the
  // SECOND `docker run` land during the NEXT test's window — which is how this
  // spec failed in a full-suite run and passed every time on its own.
  await expect
    .poll(async () => (await mine(roomId)).length, {
      message: 'the server never started this room’s containers',
      timeout: 120_000,
      intervals: [1000],
    })
    .toBe(2);
  for (const n of await mine(roomId)) created.add(n);

  // Named for the room and the seat, so an operator reading `docker ps` can
  // tell which room a gigabyte belongs to.
  expect((await mine(roomId)).sort()).toEqual([
    `${STREAM_NAME_PREFIX}-${roomId}-0`,
    `${STREAM_NAME_PREFIX}-${roomId}-1`,
  ]);

  // ── and a person is looking at Forge ─────────────────────────────────────
  // The frame appearing is the UI's claim; what is INSIDE it is the product.
  const frame = alice.page.getByTestId('stream-frame').first();
  await expect(frame, 'no seat ever framed a stream').toBeVisible({ timeout: 120_000 });

  const inner = alice.page.frameLocator('[data-testid="stream-frame"]').first();
  // noVNC's own canvas, served by websockify inside the container. With no
  // container the SPA fallback answers 200 with OUR index.html, so this
  // locator existing at all is the first half of the proof.
  const canvas = inner.locator('canvas').first();
  await expect(canvas, 'the frame is not noVNC').toBeAttached({ timeout: 120_000 });
  // Belt and braces: our own app must not be what got framed.
  await expect(inner.locator('#root')).toHaveCount(0);

  // The second half, and the one that means a PERSON sees something: noVNC
  // sizes its canvas to the remote framebuffer only once RFB has connected and
  // painted. An unconnected noVNC page has the same canvas at 0x0 — which is
  // exactly what "it looks like it loaded but the screen is black" is — so the
  // size is the difference between a page that loaded and a desktop that is
  // actually streaming. The container's screen is 1280x800.
  await expect
    .poll(
      async () => {
        const box = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
        return Math.min(box.w, box.h);
      },
      { message: 'noVNC framed but never painted a desktop', timeout: 120_000, intervals: [1000] },
    )
    .toBeGreaterThan(100);
  // Printed because a human reading a CI log wants the one fact this spec
  // exists to establish, not just a tick.
  const size = await canvas.evaluate((el: HTMLCanvasElement) => `${String(el.width)}x${String(el.height)}`);
  const status = await inner.locator('#noVNC_status').textContent().catch(() => null);
  console.log(`[live stream] alice's seat: ${size} desktop — noVNC says ${JSON.stringify(status)}`);

  // Both friends, not just the creator: a streamed room is one screen EACH,
  // and a second seat proves the per-seat allocation rather than one shared
  // window two people fight over.
  const bobFrame = bob.page.frameLocator('[data-testid="stream-frame"]').first().locator('canvas').first();
  await expect(bobFrame, 'bob never got his own screen').toBeAttached({ timeout: 120_000 });
  await expect
    .poll(async () => bobFrame.evaluate((el: HTMLCanvasElement) => el.width), {
      message: 'bob framed but never painted',
      timeout: 120_000,
      intervals: [1000],
    })
    .toBeGreaterThan(100);

  // ── the gate still holds with a live container behind it ────────────────
  // The dangerous moment for a tier check is when the thing it guards actually
  // exists. A caller with no session is `public`, and must get the same 404 as
  // a path that is not there — never a 403, never the stream.
  const anon = await browser.newContext();
  const res = await anon.request.get(`${EDGE_ORIGIN}${PREFIX}/stream/${roomId}/0/`, { maxRedirects: 0 });
  const body = (await res.text()).slice(0, 120);
  expect(res.status(), `an unauthenticated caller reached a live stream (body: ${body})`).toBe(404);
  await anon.close();

  // Nothing reached off this machine, and nothing that was not ours moved.
  expect(alice.blocked, 'alice made an off-host request').toEqual([]);
  expect(bob.blocked, 'bob made an off-host request').toEqual([]);
  const foreignAfter = (await docker(['ps', '-a', '--format', '{{.Names}}']))
    .split('\n')
    .filter((n) => n !== '' && !n.startsWith(STREAM_NAME_PREFIX));
  expect(foreignAfter.sort(), 'a container this test does not own was disturbed').toEqual(foreignBefore.sort());

  await alice.context.close();
  await bob.context.close();
});

test('a builtin room costs no container at all', async ({ browser }) => {
  const why = await dockerUsable();
  test.skip(why !== null, why ?? '');

  const alice = await open(browser, 'alice');
  await alice.page.goto(`${PREFIX}/`);
  await submitCreateRoom(alice.page, { name: `e2e builtin ${Date.now()}` });
  await expect(alice.page.getByTestId('deck-mine')).toBeVisible();
  const roomId = (await alice.page.evaluate(() => window.location.hash)).replace('#/room/', '');

  // The whole economic argument for the toggle: our table starts nothing. Held
  // long enough that a fire-and-forget provision would have landed. Scoped to
  // THIS room rather than a host-wide census, so another test's allocation
  // landing in this window cannot be mistaken for one of ours.
  await alice.page.waitForTimeout(5000);
  expect(await mine(roomId), 'a builtin room started a container').toEqual([]);

  await alice.context.close();
});
