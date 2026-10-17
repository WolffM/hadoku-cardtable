/**
 * A cast paid by lands: the release, the reveal and the land taps happen together, on both screens.
 *
 * The operator, 2026-10-11: *"i think the land tapping auto-pay should happen simultaneously with the
 * card being revealed so that can happen a bit faster"*, then: *"it seems like the sequence is: 1.
 * release card 2. reveal it 3. pay for mana 4. resolve card. can we squish together 1-3 so they all
 * happen simultaneously? something about playing cards feels a bit clunky at the moment"*.
 *
 * Scenario `w67-bears`: alice holds Grizzly Bears ({1}{G}) over three Forests; bob holds nothing, so
 * the server passes his priority and the Bears resolves unattended. Alice drags it onto her
 * battlefield and lets go; Forge's payment is auto-paid by the server (two Forests tap).
 *
 * Both pages record every animation frame: the card's stand-ins (alice's parked ghost, bob's back),
 * the stack card (back or face), each Forest's drawn turn, and the creature on the battlefield.
 * Each page's `forge:s2c` frames are stamped as they arrive, with a gist of what each delta changes.
 * Printed as `[tapreveal] <run>` lines — a green CI runner run keeps no artifacts.
 *
 * The reveal, per screen: on bob's, the first frame her card's face is shown — his stand-in back
 * turned over, the stack card, the copy that carries it to the battlefield, or the creature itself.
 * Alice's card is face up in her hand all along, so on hers it is the card taking its own spot: the
 * stack card, or the creature.
 *
 * The claim, Fast Mode off (the operator's own setting) and on, counted in each page's own animation
 * frames (`frame-clock.ts`) so a loaded CI runner's slow frames are slow for the gate too:
 *  - on both screens the lands are drawn tapped within {@link TAP_HOLD_FRAMES} frames of the page
 *    receiving Forge's frame that taps them — nothing queued in front of the payment (a pacer beat
 *    held them 300 ms once: two game-log lines ahead of the tap, 150 ms each). Measured from the
 *    frame, not the release, so a slow CI runner's Forge is not counted against the screen;
 *  - on both, no land taps after the card is revealed (one frame's slack): Forge pays before it puts
 *    the spell on its stack (`PlaySpellAbility.java:683-727`), so the taps lead;
 *  - on bob's, the face is shown as soon as it can be: within {@link REVEAL_FRAMES} frames of his
 *    screen holding the spell's drawn face, whether his stand-in is still gliding into its gap (it
 *    turns over on the way) or has come to rest — never at the glide's end.
 * The milliseconds (release to reveal, the tap's hold, the frame interval) are printed, not gated.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offeredNamed, resizeWindow, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';
import { frameIntervals, installFrameClock, wireStamps } from './frame-clock.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** From the frame the page receives Forge's tap to the frame the lands are drawn tapped: the next frame, and one for React's commit, with one to spare. */
const TAP_HOLD_FRAMES = 3;
/** From the first frame bob's screen holds the spell's drawn face to the frame he is shown it. */
const REVEAL_FRAMES = 2;

const CARD = 'Grizzly Bears';
const LAND = 'Forest';

type Sample = { at: number; frame: number; what: string; attrs: string };

async function record(page: Page): Promise<void> {
  await page.evaluate(
    ({ card, land }) => {
      const w = window as unknown as { __tr: Sample[] };
      type Sample = { at: number; frame: number; what: string; attrs: string };
      w.__tr = [];
      const now = () => performance.timeOrigin + performance.now();
      const last = new Map<string, string>();
      const push = (what: string, attrs: string) => {
        if (last.get(what) === attrs) return;
        last.set(what, attrs);
        w.__tr.push({ at: now(), frame: window.__frameNo, what, attrs });
      };
      window.addEventListener('pointerup', () => w.__tr.push({ at: now(), frame: window.__frameNo, what: 'up', attrs: '' }), true);
      const nameOf = (el: Element) => el.querySelector('.card__name')?.textContent?.trim() ?? '';
      const shown = (el: Element) => getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.05;
      const tick = () => {
        // Each Forest, on whichever battlefield: its tapped mark and the drawn turn of its face.
        for (const el of Array.from(document.querySelectorAll('[data-zone="battlefield"] [data-board-card]'))) {
          if (nameOf(el) !== land) continue;
          const id = el.getAttribute('data-board-card');
          const inner = el.querySelector('.board-card__face > .card');
          const m = inner === null ? 'none' : getComputedStyle(inner).transform;
          let deg = 0;
          const mm = /^matrix\(([-\d.e]+), ([-\d.e]+)/.exec(m);
          if (mm !== null) deg = Math.round((Math.atan2(Number(mm[2]), Number(mm[1])) * 180) / Math.PI);
          const marks = ['data-tapped', 'data-tapped-pending'].filter((n) => el.hasAttribute(n)).join(' ');
          push(`land${id}`, `${marks === '' ? 'untapped' : marks} deg=${deg}`);
        }
        const ghost = document.querySelector('[data-cast-ghost]');
        push('ghost', ghost === null ? 'gone' : shown(ghost) ? 'shown' : 'hidden');
        const back = document.querySelector('[data-board-overlay] .presence__back');
        push('back', back === null ? 'gone' : `${shown(back) ? 'shown' : 'hidden'}${back.hasAttribute('data-face') ? ' face' : ''}`);
        const placed = document.querySelector('[data-placed-spell]');
        push(
          'stack',
          placed === null
            ? 'gone'
            : [
                placed.querySelector('.placed__back') === null ? 'face' : 'back',
                placed.hasAttribute('data-placed-pending') ? 'pending' : '',
                shown(placed) ? 'shown' : 'hidden',
                placed.hasAttribute('data-placed-leaving') ? 'leaving' : '',
              ]
                .filter((s) => s !== '')
                .join(' '),
        );
        const field = Array.from(document.querySelectorAll('[data-zone="battlefield"] [data-board-card]')).find((el) => nameOf(el) === card);
        push('field', field === undefined ? 'gone' : shown(field) ? 'shown' : 'hidden');
        const hand = Array.from(document.querySelectorAll('[data-zone="hand"] [data-board-card]')).find((el) => nameOf(el) === card);
        push('hand', hand === undefined ? 'gone' : shown(hand) ? 'shown' : 'hidden');
        const handoff = document.querySelector('.presence__handoff, [data-cast-lift="returning"]');
        push('flight', handoff === null ? 'gone' : 'shown');
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { card: CARD, land: LAND },
  );
}

const samples = (page: Page): Promise<Sample[]> => page.evaluate(() => (window as unknown as { __tr: Sample[] }).__tr);

/** One `forge:s2c` frame, as a gist: its method, and for a delta each object's type, id and changed properties (the stack's length, a tap's value). */
function gist(text: string): string | null {
  const m = /^42(?:\/[^,]*,)?\d*(\[[\s\S]*\])$/.exec(text);
  if (m === null) return null;
  const [event, body] = JSON.parse(m[1]!) as [string, { frame?: { kind?: string; method?: string; payload?: { packet?: Record<string, unknown> } } }];
  if (event !== 'forge:s2c') return null;
  const frame = body.frame ?? {};
  const parts = [`${frame.kind ?? '?'}:${frame.method ?? '?'}`];
  const packet = frame.payload?.packet ?? {};
  for (const arm of ['newObjects', 'objectDeltas']) {
    for (const [key, obj] of Object.entries((packet[arm] ?? {}) as Record<string, Record<string, unknown>>)) {
      if (key.startsWith('_') || typeof obj !== 'object' || obj === null) continue;
      const props = Object.keys(obj)
        .filter((k) => k !== '_type' && k !== '_id')
        .map((k) => {
          const v = obj[k] as { v?: unknown } | null;
          if (k === 'Stack' && Array.isArray(v?.v)) return `Stack#${v.v.length}`;
          if (k === 'Tapped' || k === 'Zone') return `${k}=${JSON.stringify(v?.v ?? null)}`;
          if (k === 'Hand' && Array.isArray(v?.v)) return `Hand#${v.v.length}`;
          return k;
        });
      parts.push(`${'CPSGX'[Number(obj._type)] ?? '?'}${String(obj._id)}{${props.join(',')}}`);
    }
  }
  return parts.join(' ').slice(0, 400);
}

interface Timeline {
  reveal: number | null;
  revealHow: string;
  /** The frame the face is first shown in. */
  revealFrame: number | null;
  /** The first frame this screen holds the spell's drawn face — the placed stack card's face, shown or still held hidden while a stand-in glides. */
  faceHeldFrame: number | null;
  firstTap: number | null;
  firstTapFrame: number | null;
  lastTapDone: number | null;
  resolve: number | null;
}

/** Per screen: when the face is first shown, when the first land starts to turn, when the last land's turn ends, when the card starts for the battlefield. All relative to `t0`. */
function timeline(rec: Sample[], t0: number): Timeline {
  const after = rec.filter((s) => s.at >= t0);
  // The stand-in turned over on its way into its spot (bob's screen only: alice's is her own face all along).
  const turned = after.find((s) => s.what === 'back' && s.attrs === 'shown face');
  const stackFace = after.find((s) => s.what === 'stack' && s.attrs.startsWith('face') && s.attrs.includes('shown'));
  const field = after.find((s) => s.what === 'field' && s.attrs === 'shown');
  // A spell that resolves while the other screen's back is still gliding is carried to its place by a copy of its face.
  const flight = after.find((s) => s.what === 'flight' && s.attrs === 'shown');
  const reveal = [turned, stackFace, flight, field].filter((s) => s !== undefined).sort((a, b) => a.at - b.at)[0];
  const faceHeld = after.find((s) => s.what === 'stack' && s.attrs.startsWith('face'));
  const taps = after.filter((s) => s.what.startsWith('land') && !s.attrs.startsWith('untapped'));
  const tap = taps.find((s) => !s.attrs.endsWith('deg=0')) ?? taps[0];
  const firstTap = tap?.at ?? null;
  const tappedLands = new Set(taps.map((s) => s.what));
  let lastTapDone: number | null = null;
  for (const land of tappedLands) {
    const done = after.find((s) => s.what === land && /deg=90$/.test(s.attrs));
    if (done !== undefined) lastTapDone = Math.max(lastTapDone ?? 0, done.at);
  }
  const leaving = after.find((s) => (s.what === 'stack' && (s.attrs === 'gone' || s.attrs.includes('leaving')) && stackFace !== undefined && s.at > stackFace.at) || (s.what === 'flight' && s.attrs === 'shown'));
  const resolve = leaving?.at ?? field?.at ?? null;
  const rel = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n - t0));
  return { reveal: rel(reveal?.at), revealFrame: reveal?.frame ?? null, faceHeldFrame: faceHeld?.frame ?? null, firstTapFrame: tap?.frame ?? null, revealHow: reveal === undefined ? 'never' : reveal === turned ? 'stand-in turned' : reveal === stackFace ? 'stack face' : reveal === flight ? 'flight' : 'battlefield', firstTap: rel(firstTap), lastTapDone: rel(lastTapDone), resolve: rel(resolve) };
}

for (const fast of [false, true]) {
  const label = fast ? 'fast' : 'paced';
  test(titled(`${label}: the land taps start with the card's reveal, on both screens`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    const say = (line: string) => console.log(`[tapreveal] ${label} ${line}`);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-bears', { beforeAlice: installFrameClock, beforeBob: installFrameClock });
      for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
      if (!fast) {
        for (const p of [alice.page, bob.page]) {
          const toggle = (await openSettings(p)).locator('[data-testid="live-settings-fast-mode"]');
          await toggle.uncheck();
          await expect(toggle).not.toBeChecked();
          await closeSettings(p);
        }
      }
      let cardId: number | undefined;
      await expect.poll(async () => (cardId = await offeredNamed(alice.page, CARD)), { timeout: 60_000, message: `alice is offered ${CARD}` }).not.toBeUndefined();
      await record(alice.page);
      await record(bob.page);
      const logFrom = serverLog(stack).length;

      const card = (await alice.page.locator(`[data-board-card="${cardId}"]`).boundingBox())!;
      const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
      const release = { x: Math.round(field.x + field.width * 0.4), y: Math.round(field.y + field.height * 0.5) };
      const idle = { alice: await frameIntervals(alice.page), bob: await frameIntervals(bob.page) };
      await alice.page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
      await alice.page.mouse.down();
      await alice.page.mouse.move(release.x, release.y, { steps: 10 });
      await alice.page.mouse.up();
      const releasedAt = Date.now();

      const onBoard = (page: Page, mine: boolean) =>
        page.locator(`.seat${mine ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"] [data-board-card] .card__name`, { hasText: CARD });
      await expect(onBoard(alice.page, true), `${CARD} is on alice’s battlefield`).toHaveCount(1, { timeout: 20_000 });
      await expect(onBoard(bob.page, false), 'and on bob’s view of it').toHaveCount(1, { timeout: 20_000 });
      await alice.page.waitForTimeout(2_000);

      const mine = await samples(alice.page);
      const theirs = await samples(bob.page);
      const t0 = mine.find((s) => s.what === 'up')?.at ?? releasedAt;
      const frames: Record<'alice' | 'bob', { at: number; frame: number; what: string }[]> = { alice: [], bob: [] };
      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        for (const w of await wireStamps(page)) {
          const what = gist(w.text);
          if (what !== null) frames[who].push({ at: w.at, frame: w.frame, what });
        }
      }

      for (const r of serverLog(stack).slice(logFrom)) {
        const at = Date.parse(String(r.t));
        if (Number.isNaN(at) || at < t0 - 200) continue;
        const { t: _t, svc: _svc, matchId: _m, evt, ...rest } = r;
        say(`server ${Math.round(at - t0)}ms ${String(evt)} ${JSON.stringify(rest).slice(0, 200)}`);
      }
      for (const who of ['alice', 'bob'] as const) {
        for (const f of frames[who]) if (f.at >= t0 - 200) say(`${who} wire ${Math.round(f.at - t0)}ms f${f.frame} ${f.what}`);
      }
      for (const [who, rec] of [['alice', mine], ['bob', theirs]] as const) {
        for (const s of rec) if (s.at >= t0 - 100) say(`${who} ${Math.round(s.at - t0)}ms f${s.frame} ${s.what} ${s.attrs}`);
      }

      const lines: [string, Timeline][] = [
        ['alice', timeline(mine, t0)],
        ['bob', timeline(theirs, t0)],
      ];
      for (const [who, tl] of lines) {
        const gap = (a: number | null, b: number | null) => (a === null || b === null ? '?' : `${b - a}`);
        say(
          `summary ${who}: reveal ${tl.reveal ?? '?'}ms (${tl.revealHow}); first tap ${tl.firstTap ?? '?'}ms; last tap done ${tl.lastTapDone ?? '?'}ms; resolve ${tl.resolve ?? '?'}ms | release→reveal ${tl.reveal ?? '?'} reveal→first tap ${gap(tl.reveal, tl.firstTap)} last tap→resolve ${gap(tl.lastTapDone, tl.resolve)}`,
        );
      }
      for (const [who, tl] of lines) {
        expect(tl.reveal, `${who}: the card is revealed`).not.toBeNull();
        expect(tl.firstTap, `${who}: a land is drawn tapping`).not.toBeNull();
        const tapFrame = frames[who as 'alice' | 'bob'].find((f) => f.what.includes('Tapped=true'));
        expect(tapFrame, `${who}: the page received the frame that taps the lands`).toBeDefined();
        const heldFrames = tl.firstTapFrame! - tapFrame!.frame;
        const heldMs = tl.firstTap! - Math.round(tapFrame!.at - t0);
        say(
          `measure ${who}: frame interval idle p50/p95 ${idle[who as 'alice' | 'bob'].p50}/${idle[who as 'alice' | 'bob'].p95}ms; tap frame arrived ${Math.round(tapFrame!.at - t0)}ms (f${tapFrame!.frame}), drawn ${heldMs}ms / ${heldFrames} frame(s) later; release→reveal ${tl.reveal}ms; reveal f${tl.revealFrame}, face held f${tl.faceHeldFrame ?? '-'}, first tap f${tl.firstTapFrame}`,
        );
        expect(heldFrames, `${who}: the lands are drawn tapped within ${TAP_HOLD_FRAMES} frames of their frame (held ${heldFrames} frames, ${heldMs}ms)`).toBeLessThanOrEqual(TAP_HOLD_FRAMES);
        expect(tl.firstTapFrame! - tl.revealFrame!, `${who}: the land taps start no later than the reveal (reveal f${tl.revealFrame} ${tl.reveal}ms, first tap f${tl.firstTapFrame} ${tl.firstTap}ms)`).toBeLessThanOrEqual(1);
      }
      const seen = lines[1]![1];
      expect(seen.faceHeldFrame, "bob's screen draws her spell's face").not.toBeNull();
      expect(
        seen.revealFrame! - seen.faceHeldFrame!,
        `bob: her card is shown as soon as his screen holds its face, not at the end of his stand-in's glide (face held f${seen.faceHeldFrame}, shown f${seen.revealFrame} ${seen.reveal}ms, ${seen.revealHow})`,
      ).toBeLessThanOrEqual(REVEAL_FRAMES);
    } finally {
      await stack.stop();
    }
  });
}
