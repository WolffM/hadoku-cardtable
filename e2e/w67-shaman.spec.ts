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
 * Everything is printed as `[shaman] <run>` lines — a green claw run keeps no artifacts.
 *
 * Three runs: the Shaman as reported; Grizzly Bears (a vanilla 2/2, no trigger) as the baseline the
 * Shaman's extra cost is read against; and the Shaman with bob holding priority for 2 s while it is
 * on the stack — a long wait like the reported one, for anything that drifts toward the pointer
 * meanwhile. The one assertion is the end state: the creature stands on both boards.
 *
 * A fourth run makes the race the operator hit (w67, 2026-10-10) happen every time instead of one
 * run in three: bob's socket holds what the server sends him from alice's release until Forge has
 * her spell on the stack, then hands him the placement and, 40 ms after it — early in the back's
 * 300 ms glide into its gap — Forge's frames: Forge answering faster than the glide, as on a quick claw.
 */
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';

import { makeTitled, offeredNamed, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

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
          // A hidden element (a placed spell still pending, a carried card) has a box but is not drawn.
          const hidden = getComputedStyle(el).visibility === 'hidden' ? 'hidden' : '';
          const attrs = [attrsOf(el, names), hidden].filter((a) => a !== '').join(' ');
          push(els.length > 1 ? `${what}${i}` : what, r.left + r.width / 2, r.top + r.height / 2, r.width, r.height, attrs);
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

type Run = {
  /** Printed on every evidence line after `[shaman]`. */
  label: string;
  scenario: string;
  card: string;
  /** Bob holds priority (full control) this long after the release, then passes; 0: the server passes for him. */
  bobHoldsMs: number;
  /** Bob's screen gets Forge's frames 40 ms after her placement, early in the back's glide, whenever Forge answered (`gateSocket`). */
  midGlide: boolean;
};

/** What the server sends a page, held while `holding` and let through in order on `flush`. */
interface Gate {
  holding: boolean;
  /** Sends everything held up to and including the last message that contains `marker`; false when none does. */
  flushThrough(marker: string): boolean;
  flushAll(): void;
}

async function gateSocket(page: Page): Promise<Gate> {
  const held: { to: WebSocketRoute; message: string | Buffer }[] = [];
  const gate: Gate = {
    holding: false,
    flushThrough(marker) {
      const last = held.findLastIndex((h) => typeof h.message === 'string' && h.message.includes(marker));
      if (last < 0) return false;
      for (const h of held.splice(0, last + 1)) h.to.send(h.message);
      return true;
    },
    flushAll() {
      for (const h of held.splice(0)) h.to.send(h.message);
      gate.holding = false;
    },
  };
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (gate.holding) held.push({ to: ws, message });
      else ws.send(message);
    });
  });
  return gate;
}

/** Distance from `p` to the segment `a`–`b`. */
function offSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const k = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
}

async function measure(browser: Browser, jar: { jar: string; res: string }, run: Run): Promise<void> {
  const stack = await startPlayStack(jar);
  const say = (line: string) => console.log(`[shaman] ${run.label} ${line}`);
  try {
    let gate: Gate | null = null;
    const { alice, bob } = await startScenarioMatch(browser, stack, run.scenario, {
      beforeBob: async (page) => {
        if (run.midGlide) gate = await gateSocket(page);
      },
    });
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    if (run.bobHoldsMs > 0) {
      await bob.page.getByTestId('live-full-control').click();
      await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    }
    let cardId: number | undefined;
    await expect.poll(async () => (cardId = await offeredNamed(alice.page, run.card)), { timeout: 60_000, message: `alice is offered ${run.card}` }).not.toBeUndefined();
    await record(alice.page, run.card);
    await record(bob.page, run.card);
    const logFrom = serverLog(stack).length;

    // Anything the match asks of either seat is answered without moving alice's pointer (a dispatched
    // click), and stamped: a press is a phase of the timeline too.
    const presses: { at: number; who: string; what: string }[] = [];
    let releasedAt = Number.POSITIVE_INFINITY;
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
        if ((await bobOk.count()) > 0 && Date.now() - releasedAt >= run.bobHoldsMs) {
          presses.push({ at: Date.now(), who: 'bob', what: `ok "${(await bobOk.first().textContent().catch(() => '')) ?? ''}"` });
          await bobOk.first().dispatchEvent('click').catch(() => undefined);
        }
        await alice.page.waitForTimeout(100);
      }
    })();

    // The operator's gesture: press on the card, drag to the middle of her battlefield, let go, and
    // move the pointer 300 px away AT ONCE, then keep it drifting slowly for four seconds.
    const card = (await alice.page.locator(`[data-board-card="${cardId}"]`).boundingBox())!;
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const release = { x: Math.round(field.x + field.width * 0.4), y: Math.round(field.y + field.height * 0.5) };
    await alice.page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(release.x, release.y, { steps: 10 });
    const held = gate as Gate | null;
    if (held !== null) held.holding = true;
    await alice.page.mouse.up();
    releasedAt = Date.now();
    const gated = (async () => {
      if (held === null) return;
      // Forge has her spell on the stack once her own screen draws it there.
      await expect(alice.page.locator('[data-placed-spell][data-mine]'), 'Forge has her spell on the stack').toHaveCount(1, { timeout: 15_000 });
      expect(held.flushThrough('"forge:placement"'), 'bob’s socket held her placement').toBe(true);
      const placed = Date.now();
      await alice.page.waitForTimeout(40);
      held.flushAll();
      say(`gate: bob got her placement at ${placed - releasedAt}ms after the release, Forge's frames at ${Date.now() - releasedAt}ms`);
    })();
    const away = { x: release.x + 300, y: release.y - 40 };
    await alice.page.mouse.move(away.x, away.y, { steps: 6 });
    const drift = Date.now();
    for (let i = 0; Date.now() - drift < 4_000 + run.bobHoldsMs; i++) {
      await alice.page.mouse.move(away.x - i * 6, away.y + Math.round(30 * Math.sin(i / 4)), { steps: 2 });
      await alice.page.waitForTimeout(60);
    }
    await gated;

    const onBoard = (page: Page, mine: boolean) =>
      page.locator(`.seat${mine ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"] [data-board-card] .card__name`, { hasText: run.card });
    await expect(onBoard(alice.page, true), `${run.card} is on alice’s battlefield`).toHaveCount(1, { timeout: 20_000 });
    await expect(onBoard(bob.page, false), 'and on bob’s view of it').toHaveCount(1, { timeout: 20_000 });
    // Still for longer than presence's CLEARED_GRACE_MS (1.5 s): a back left standing on bob's screen
    // that only a pointer-free stretch takes down shows its end here.
    const stillFrom = Date.now();
    await alice.page.waitForTimeout(3_000);
    pumping = false;
    await pump;

    const mine = await samples(alice.page);
    const theirs = await samples(bob.page);
    const t0 = mine.find((s) => s.what === 'up')?.at ?? releasedAt;
    say(`release at ${release.x},${release.y} (alice px); pointer then to ${away.x},${away.y} and drifting; t0 = alice's pointerup`);

    // Forge's side: every frame, command and wire frame from 3 s before the release, relative to t0.
    for (const r of serverLog(stack).slice(logFrom)) {
      const at = Date.parse(String(r.t));
      if (Number.isNaN(at) || at < t0 - 3_000) continue;
      const { t: _t, svc: _svc, matchId: _m, evt, ...rest } = r;
      say(`server ${rel(at, t0)}ms ${String(evt)} ${JSON.stringify(rest).slice(0, 260)}`);
    }
    for (const p of presses) say(`press ${rel(p.at, t0)}ms ${p.who} ${p.what}`);

    // Each page's record from 500 ms before the release (the status line and the stack count from
    // the start), one line per change.
    for (const [who, rec] of [['alice', mine], ['bob', theirs]] as const) {
      for (const s of rec) {
        if (s.at < t0 - 500 && s.what !== 'says' && s.what !== 'stackcount') continue;
        const pos = s.w === 0 && s.h === 0 && s.x === 0 && s.y === 0 ? '' : ` ${s.x},${s.y}${s.w > 0 ? ` ${s.w}x${s.h}` : ''}`;
        say(`${who} ${rel(s.at, t0)}ms ${s.what}${pos}${s.attrs === '' ? '' : ` [${s.attrs}]`}`);
      }
    }

    // (b) — after the release, any drawn stand-in more than 40 px off the straight path from where the
    // card was let go (on that screen) to where it finally stands is off its route; how near the
    // pointer (alice's own, or bob's drawing of hers) was on that frame says whether it chased it.
    const STANDINS = /^(lift|ghost|stack|back|handoff|plift)\d*$/;
    for (const [who, rec, pointerKind] of [['alice', mine, 'mouse'], ['bob', theirs, 'cursor']] as const) {
      const firstBack = rec.find((s) => s.at >= t0 && s.what === 'back' && s.attrs.includes('data-waiting'));
      const from = who === 'alice' ? release : firstBack === undefined ? null : { x: firstBack.x, y: firstBack.y };
      const end = rec.filter((s) => s.what === 'field' && s.attrs !== 'gone').at(-1);
      if (from === null || end === undefined) {
        say(`chase ${who}: no release point or no final place drawn, cannot judge`);
        continue;
      }
      let pointer: { x: number; y: number } | null = null;
      const off: string[] = [];
      for (const s of rec) {
        if (s.what === pointerKind && s.attrs !== 'gone') pointer = { x: s.x, y: s.y };
        if (s.at < t0 || !STANDINS.test(s.what) || s.attrs === 'gone' || s.attrs.includes('hidden')) continue;
        const d = offSegment(s, from, end);
        if (d <= 40) continue;
        const toPointer = pointer === null ? 'no pointer' : `${Math.round(Math.hypot(s.x - pointer.x, s.y - pointer.y))}px from pointer ${pointer.x},${pointer.y}`;
        off.push(`${rel(s.at, t0)}ms ${s.what} @${s.x},${s.y} ${Math.round(d)}px off-path, ${toPointer}`);
      }
      say(`chase ${who}: path ${from.x},${from.y} → ${end.x},${end.y}; ${off.length} frame(s) off it${off.length === 0 ? '' : ` — ${off.slice(0, 30).join(' | ')}`}`);
    }

    const ms = (s: Sample | undefined) => (s === undefined ? '?' : `${rel(s.at, t0)}ms`);
    const inDom = (rec: Sample[]) => rec.find((s) => s.what === 'field' && s.attrs !== 'gone' && s.at >= t0);
    const lastShown = (rec: Sample[]) => rec.filter((s) => s.what === 'field' && s.attrs.includes('vis=visible') && s.at >= t0).at(-1);
    const backs = theirs.filter((s) => s.what === 'back' && s.at >= t0);
    const lastBack = backs.at(-1);
    const landedAt = lastShown(theirs)?.at ?? Number.POSITIVE_INFINITY;
    const after = backs.filter((s) => s.at > landedAt - 1_000 && s.attrs !== 'gone');
    say(
      `back after landing: ${after.length === 0 ? 'none' : after.map((s) => `${rel(s.at, t0)}ms @${s.x},${s.y} ${s.w}x${s.h} [${s.attrs}]`).join(' | ')}; last back change ${lastBack === undefined ? 'none' : `${rel(lastBack.at, t0)}ms [${lastBack.attrs}]`}; alice's pointer still from ${rel(stillFrom, t0)}ms`,
    );
    say(`summary: in alice's battlefield DOM at ${ms(inDom(mine))}, shown for good at ${ms(lastShown(mine))}; in bob's at ${ms(inDom(theirs))}, shown for good at ${ms(lastShown(theirs))}`);

    // The hand-over, on each screen: where the stand-in last stood, where the stack card was first
    // drawn, how far that is from where the card lands (the hop), and the landing flight's length.
    for (const [who, rec] of [['alice', mine], ['bob', theirs]] as const) {
      const end = rec.filter((s) => s.what === 'field' && s.attrs !== 'gone').at(-1);
      const firstStack = rec.find((s) => s.at >= t0 && /^stack\d*$/.test(s.what) && s.attrs !== 'gone' && !s.attrs.includes('hidden'));
      const standIn = firstStack === undefined ? undefined : rec.filter((s) => s.at >= t0 && s.at <= firstStack.at && /^(back|ghost|lift)$/.test(s.what) && s.attrs !== 'gone').at(-1);
      const flight = rec.find((s) => s.at >= t0 && (s.what === 'handoff' || /data-cast-lift=returning/.test(s.attrs)));
      const px = (a: Sample | undefined) => (a === undefined || end === undefined ? '-' : `${Math.round(Math.hypot(a.x - end.x, a.y - end.y))}px`);
      console.log(
        `[w67-hand] ${run.label} ${who}: lands ${end === undefined ? '?' : `${end.x},${end.y}`}; stand-in last ${standIn === undefined ? '-' : `${standIn.what}@${standIn.x},${standIn.y} ${rel(standIn.at, t0)}ms`}; stack first ${firstStack === undefined ? 'never shown' : `@${firstStack.x},${firstStack.y} ${rel(firstStack.at, t0)}ms`} hop ${px(firstStack)}; landing ${flight === undefined ? 'swap in place' : `flight from ${flight.x},${flight.y} ${rel(flight.at, t0)}ms, ${px(flight)}`}`,
      );
    }

    // And what each screen reported of them itself (`handover-report.ts`, through the server's log).
    for (const r of serverLog(stack).slice(logFrom)) {
      if (r.evt !== 'client' || (r.kind !== 'handover' && r.kind !== 'landing')) continue;
      const f = (k: string) => (r[k] === undefined ? '-' : String(r[k]));
      console.log(
        `[w67-hand] ${run.label} telemetry seat ${f('seat')} ${f('screen')} ${String(r.kind)} ${f('how')}: from ${f('fromX')},${f('fromY')} to ${f('toX')},${f('toY')} dist ${f('dist')}px; glide ${f('glideMs')}ms done=${f('glideDone')}; ${f('msSinceRelease')}ms since release, ${f('msSinceStackFrame')}ms since the stack frame; motion=${f('motion')} doubled=${f('doubled')}`,
      );
    }

    // Each screen hands its stand-in over to the stack card where the stand-in comes to rest, never
    // mid-glide: the stack card is drawn exactly where the stand-in stood (lane U's finding on the
    // caster: 2–4 px, glideDone=false).
    for (const r of serverLog(stack).slice(logFrom)) {
      if (r.evt !== 'client' || r.kind !== 'handover' || r.dist === undefined) continue;
      expect(Number(r.dist), `${String(r.screen)}: the stack card is drawn where its stand-in stood (glide ${String(r.glideMs)}ms, done=${String(r.glideDone)})`).toBeLessThanOrEqual(1);
    }

    // B1 — once bob's waiting back has handed over, no back of hers stands up again: a stale
    // `placing` echo opened a second one, and her pointer traffic kept it alive.
    const firstWait = backs.find((s) => s.attrs.includes('data-waiting'));
    const handedOver = firstWait === undefined ? undefined : backs.find((s) => s.at > firstWait.at && s.attrs === 'gone');
    const phantom = handedOver === undefined ? [] : backs.filter((s) => s.at > handedOver.at && s.attrs !== 'gone');
    expect(
      phantom.map((s) => `${rel(s.at, t0)}ms @${s.x},${s.y} ${s.w}x${s.h} [${s.attrs}]`),
      `no phantom back on bob's screen after the hand-over at ${handedOver === undefined ? '?' : rel(handedOver.at, t0)}ms`,
    ).toEqual([]);

    // B2 — on both screens the stack card is drawn where the stand-in waits (the gap the card
    // lands in), never back at the release point.
    for (const [who, rec] of [['alice', mine], ['bob', theirs]] as const) {
      const end = rec.filter((s) => s.what === 'field' && s.attrs !== 'gone').at(-1);
      if (end === undefined) continue;
      const away = rec.filter((s) => s.at >= t0 && /^stack\d*$/.test(s.what) && s.attrs !== 'gone' && !s.attrs.includes('hidden') && Math.hypot(s.x - end.x, s.y - end.y) > 12);
      expect(away.map((s) => `${rel(s.at, t0)}ms @${s.x},${s.y}`), `${who}: the stack card stands where the card lands (${end.x},${end.y}), not back at the release`).toEqual([]);
    }

    // B3 — bob's real card is never shown in its slot before a flight to it starts.
    const firstFlight = theirs.find((s) => s.at >= t0 && s.what === 'handoff' && s.attrs !== 'gone');
    if (firstFlight !== undefined) {
      const early = theirs.filter((s) => s.at >= t0 && s.at < firstFlight.at && s.what === 'field' && s.attrs.includes('vis=visible'));
      expect(early.map((s) => `${rel(s.at, t0)}ms`), `bob's card shown before its flight at ${rel(firstFlight.at, t0)}ms`).toEqual([]);
    }

    // One object at the landing: no frame draws the stack card and the battlefield card both (the
    // manager's frame sheet of a red run: a copy laid over the field card for a frame or two).
    for (const [who, rec] of [['alice', mine], ['bob', theirs]] as const) {
      let stackShown = false;
      const doubled: string[] = [];
      for (const s of rec) {
        if (s.at < t0) continue;
        if (/^stack\d*$/.test(s.what)) stackShown = s.attrs !== 'gone' && !s.attrs.includes('hidden');
        if (s.what === 'field' && s.attrs.includes('vis=visible') && stackShown) doubled.push(`${rel(s.at, t0)}ms @${s.x},${s.y}`);
      }
      expect(doubled, `${who}: the stack card is gone the frame the card is shown on the battlefield`).toEqual([]);
    }

    // No flight to nowhere: a stand-in already standing where the card is drawn is a swap in place,
    // never a 300 ms "trip" from the gap to the gap with the real card hidden under it.
    for (const [who, rec] of [['alice', mine], ['bob', theirs]] as const) {
      const end = rec.filter((s) => s.what === 'field' && s.attrs !== 'gone').at(-1);
      const flights = rec.filter((s) => s.at >= t0 && (s.what === 'handoff' || /data-cast-lift=returning/.test(s.attrs)));
      const first = flights[0];
      if (end === undefined || first === undefined) continue;
      expect(Math.hypot(first.x - end.x, first.y - end.y), `${who}: a landing flight starts where it ends (${rel(first.at, t0)}ms @${first.x},${first.y})`).toBeGreaterThan(4);
    }
  } finally {
    await stack.stop();
  }
}

for (const run of [
  { label: 'shaman', scenario: 'w67-shaman', card: 'Viridian Shaman', bobHoldsMs: 0, midGlide: false },
  { label: 'bears', scenario: 'w67-bears', card: 'Grizzly Bears', bobHoldsMs: 0, midGlide: false },
  { label: 'shaman-held', scenario: 'w67-shaman', card: 'Viridian Shaman', bobHoldsMs: 2_000, midGlide: false },
  { label: 'shaman-midglide', scenario: 'w67-shaman', card: 'Viridian Shaman', bobHoldsMs: 2_000, midGlide: true },
] satisfies Run[]) {
  test(titled(`${run.label}: where the time goes from release to board, and what each screen draws meanwhile`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    await measure(browser, forge, run);
  });
}
