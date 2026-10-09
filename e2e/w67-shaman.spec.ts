/**
 * w67-shaman — measurement, not a gate (playtest report, 2026-10-09):
 *
 *   "playing Viridian shaman with no available targets creates an awkward lag situation … i'm
 *   curious why this situation creates 2s~ of lag … when the card is released then my cursor can
 *   still move and i think there is still some logic somewhere that tries to look for the cursor
 *   when the animation starts rather than animating it to where the cursor was released."
 *
 * Alice drags Viridian Shaman (its enters trigger, "destroy target artifact", has no legal target)
 * from her hand and lets it go over her battlefield, then at once moves her pointer 300 px away
 * and keeps it moving for a few seconds. Both pages record, every animation frame, every drawn
 * stand-in of the card (the lift, the parked ghost, the stack card, the opponent's back, a flight
 * copy, the real battlefield card) and the pointer: alice's own, and bob's drawing of hers. The
 * server's probe-mode trace (`forge-frame`/`forge-command`/`wire-frame`) gives Forge's side.
 * Everything is printed as `[shaman]` lines — a green claw run keeps no artifacts.
 *
 * The one assertion is the end state: the Shaman stands on both boards.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offeredNamed, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const NAME = 'Viridian Shaman';

type Sample = { at: number; what: string; x: number; y: number; w: number; h: number; attrs: string };

/** Every animation frame: each stand-in of the card and each pointer, recorded when it changes. Wall-clock `at` (ms), so two pages line up. */
async function record(page: Page, name: string): Promise<void> {
  await page.evaluate((cardName) => {
    const w = window as unknown as { __shaman: Sample[]; __mouse: { x: number; y: number } | null };
    type Sample = { at: number; what: string; x: number; y: number; w: number; h: number; attrs: string };
    w.__shaman = [];
    w.__mouse = null;
    const now = () => performance.timeOrigin + performance.now();
    const last = new Map<string, string>();
    const push = (what: string, x: number, y: number, ww: number, h: number, attrs: string) => {
      const key = `${Math.round(x)},${Math.round(y)},${Math.round(ww)},${Math.round(h)},${attrs}`;
      if (last.get(what) === key) return;
      last.set(what, key);
      w.__shaman.push({ at: now(), what, x: Math.round(x), y: Math.round(y), w: Math.round(ww), h: Math.round(h), attrs });
    };
    const gone = (what: string) => {
      if (!last.has(what) || last.get(what) === 'gone') return;
      last.set(what, 'gone');
      w.__shaman.push({ at: now(), what, x: 0, y: 0, w: 0, h: 0, attrs: 'gone' });
    };
    window.addEventListener('pointermove', (e) => (w.__mouse = { x: e.clientX, y: e.clientY }), true);
    window.addEventListener('pointerdown', (e) => push('down', e.clientX, e.clientY, 0, 0, ''), true);
    window.addEventListener('pointerup', (e) => push('up', e.clientX, e.clientY, 0, 0, ''), true);
    const named = (el: Element) => el.querySelector('.card__name')?.textContent?.trim() === cardName;
    const attrsOf = (el: Element, names: string[]) =>
      names
        .filter((n) => el.hasAttribute(n))
        .map((n) => `${n}=${el.getAttribute(n)}`)
        .join(' ');
    const watch: [string, string, string[]][] = [
      ['lift', '[data-cast-lift]', ['data-cast-lift', 'data-cast-ghost', 'data-cast-landing']],
      ['ghost', '[data-cast-ghost]', ['data-cast-ghost', 'data-cast-lift']],
      ['stack', '[data-placed-spell]', ['data-mine']],
      ['back', '.presence__back', ['data-waiting', 'data-face']],
      ['handoff', '.presence__handoff', []],
      ['plift', '.presence__lift', []],
      ['cursor', '[data-board-overlay] .presence', []],
    ];
    const tick = () => {
      if (w.__mouse !== null) push('mouse', w.__mouse.x, w.__mouse.y, 0, 0, '');
      for (const [what, sel, names] of watch) {
        const els = Array.from(document.querySelectorAll(sel));
        if (els.length === 0) gone(what);
        els.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          push(els.length > 1 ? `${what}${i}` : what, r.left + r.width / 2, r.top + r.height / 2, r.width, r.height, attrsOf(el, names));
        });
      }
      const field = Array.from(document.querySelectorAll('[data-zone="battlefield"] [data-board-card]')).find(named);
      if (field === undefined) gone('field');
      else {
        const r = field.getBoundingClientRect();
        const style = getComputedStyle(field);
        push('field', r.left + r.width / 2, r.top + r.height / 2, r.width, r.height, `vis=${style.visibility} op=${style.opacity}`);
      }
      const hand = Array.from(document.querySelectorAll('[data-zone="hand"] [data-board-card]')).find(named);
      if (hand === undefined) gone('hand');
      else {
        const r = hand.getBoundingClientRect();
        push('hand', r.left + r.width / 2, r.top + r.height / 2, r.width, r.height, attrsOf(hand, ['data-cast-lift', 'data-selectable']));
      }
      const zone = document.querySelector('[data-zone="stack"]');
      push('stackcount', 0, 0, 0, 0, zone?.getAttribute('data-count') ?? 'none');
      const says = document.querySelector('[data-testid="live-says"]')?.textContent?.trim() ?? '';
      const prompt = document.querySelector('[data-testid="live-prompt"]')?.getAttribute('data-method') ?? '';
      push('says', 0, 0, 0, 0, `${says.slice(0, 70)}${prompt === '' ? '' : ` | prompt=${prompt}`}`);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, name);
}

const samples = (page: Page): Promise<Sample[]> => page.evaluate(() => (window as unknown as { __shaman: Sample[] }).__shaman);

const rel = (at: number, t0: number) => Math.round(at - t0);

test(titled('Viridian Shaman with no artifact to target: where the time goes from release to board, and what each screen draws meanwhile'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-shaman');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    let shaman: number | undefined;
    await expect.poll(async () => (shaman = await offeredNamed(alice.page, NAME)), { timeout: 60_000, message: 'alice is offered Viridian Shaman' }).not.toBeUndefined();
    await record(alice.page, NAME);
    await record(bob.page, NAME);
    const logFrom = serverLog(stack).length;

    // Anything the match asks of either seat is answered without moving alice's pointer (a dispatched
    // click), and stamped: a press is a phase of the timeline too.
    const presses: { at: number; who: string; what: string }[] = [];
    let pumping = true;
    const pump = (async () => {
      while (pumping) {
        const pay = alice.page.locator('[data-testid="live-payment-ok"]:enabled');
        if ((await pay.count()) > 0) {
          presses.push({ at: Date.now(), who: 'alice', what: 'payment auto' });
          await pay.first().dispatchEvent('click').catch(() => undefined);
        }
        const prompt = alice.page.getByTestId('live-prompt');
        if ((await prompt.count()) > 0) {
          const method = (await prompt.first().getAttribute('data-method').catch(() => null)) ?? '?';
          presses.push({ at: Date.now(), who: 'alice', what: `prompt ${method} (seen)` });
        }
        const bobOk = bob.page.locator('[data-testid="live-decision-ok"]:enabled');
        if ((await bobOk.count()) > 0) {
          presses.push({ at: Date.now(), who: 'bob', what: `ok "${(await bobOk.first().textContent().catch(() => '')) ?? ''}"` });
          await bobOk.first().dispatchEvent('click').catch(() => undefined);
        }
        await alice.page.waitForTimeout(100);
      }
    })();

    // The operator's gesture: press on the card, drag to the middle of her battlefield, let go, and
    // move the pointer 300 px away AT ONCE, then keep it drifting slowly for four seconds.
    const card = (await alice.page.locator(`[data-board-card="${shaman}"]`).boundingBox())!;
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const release = { x: Math.round(field.x + field.width * 0.4), y: Math.round(field.y + field.height * 0.5) };
    await alice.page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(release.x, release.y, { steps: 10 });
    await alice.page.mouse.up();
    const away = { x: release.x + 300, y: release.y - 40 };
    await alice.page.mouse.move(away.x, away.y, { steps: 6 });
    const drift = Date.now();
    for (let i = 0; Date.now() - drift < 4_000; i++) {
      await alice.page.mouse.move(away.x - i * 6, away.y + Math.round(30 * Math.sin(i / 4)), { steps: 2 });
      await alice.page.waitForTimeout(60);
    }

    const onBoard = (page: Page, mine: boolean) =>
      page.locator(`.seat${mine ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"] [data-board-card] .card__name`, { hasText: NAME });
    await expect(onBoard(alice.page, true), 'the Shaman is on alice’s battlefield').toHaveCount(1, { timeout: 20_000 });
    await expect(onBoard(bob.page, false), 'and on bob’s view of it').toHaveCount(1, { timeout: 20_000 });
    await alice.page.waitForTimeout(1_000);
    pumping = false;
    await pump;

    const mine = await samples(alice.page);
    const theirs = await samples(bob.page);
    const up = mine.find((s) => s.what === 'up');
    const t0 = up?.at ?? drift;
    console.log(`[shaman] release at ${release.x},${release.y} (alice px); pointer then to ${away.x},${away.y} and drifting; t0 = alice's pointerup`);

    // Forge's side: every frame, command and wire frame after the scenario was ready, relative to t0.
    const rows = serverLog(stack).slice(logFrom);
    for (const r of rows) {
      const at = Date.parse(String(r.t));
      if (Number.isNaN(at) || at < t0 - 3_000) continue;
      const { t: _t, svc: _svc, matchId: _m, evt, ...rest } = r;
      console.log(`[shaman] server ${rel(at, t0)}ms ${String(evt)} ${JSON.stringify(rest).slice(0, 260)}`);
    }
    for (const p of presses) console.log(`[shaman] press ${rel(p.at, t0)}ms ${p.who} ${p.what}`);

    // Each page's whole record from 500 ms before the release, one line per change.
    for (const [who, rec] of [['alice', mine], ['bob', theirs]] as const) {
      for (const s of rec) {
        if (s.at < t0 - 500) continue;
        const pos = s.w === 0 && s.h === 0 && s.x === 0 && s.y === 0 ? '' : ` ${s.x},${s.y}${s.w > 0 ? ` ${s.w}x${s.h}` : ''}`;
        console.log(`[shaman] ${who} ${rel(s.at, t0)}ms ${s.what}${pos}${s.attrs === '' ? '' : ` [${s.attrs}]`}`);
      }
    }

    // (b) — any drawn stand-in that, after the release, is nearer the pointer's CURRENT spot than the
    // release point and has left the release point by more than 40 px: it is chasing the pointer.
    const STANDINS = /^(lift|ghost|stack|back|handoff|plift)\d*$/;
    for (const [who, rec, pointerKind] of [['alice', mine, 'mouse'], ['bob', theirs, 'cursor']] as const) {
      const releasedAt = who === 'alice' ? release : (() => {
        const atRelease = rec.filter((s) => s.what === pointerKind && s.attrs !== 'gone' && s.at <= t0 + 150).at(-1);
        return atRelease === undefined ? null : { x: atRelease.x, y: atRelease.y };
      })();
      if (releasedAt === null) {
        console.log(`[shaman] chase ${who}: no pointer drawn near the release, cannot judge`);
        continue;
      }
      let pointer: { x: number; y: number } | null = null;
      const chased: string[] = [];
      for (const s of rec) {
        if (s.what === pointerKind && s.attrs !== 'gone') pointer = { x: s.x, y: s.y };
        if (s.at < t0 || !STANDINS.test(s.what) || s.attrs === 'gone' || pointer === null) continue;
        const fromRelease = Math.hypot(s.x - releasedAt.x, s.y - releasedAt.y);
        const fromPointer = Math.hypot(s.x - pointer.x, s.y - pointer.y);
        if (fromRelease > 40 && fromPointer < fromRelease) chased.push(`${rel(s.at, t0)}ms ${s.what} @${s.x},${s.y} pointer ${pointer.x},${pointer.y} release ${releasedAt.x},${releasedAt.y}`);
      }
      console.log(`[shaman] chase ${who}: ${chased.length} frame(s) nearer the pointer than the release point${chased.length === 0 ? '' : ` — ${chased.slice(0, 30).join(' | ')}`}`);
    }

    const firstField = (rec: Sample[]) => rec.find((s) => s.what === 'field' && s.attrs !== 'gone' && s.at >= t0);
    const fa = firstField(mine);
    const fb = firstField(theirs);
    console.log(`[shaman] summary: on alice's battlefield (DOM) at ${fa === undefined ? '?' : rel(fa.at, t0)}ms, on bob's at ${fb === undefined ? '?' : rel(fb.at, t0)}ms`);
  } finally {
    await stack.stop();
  }
});
