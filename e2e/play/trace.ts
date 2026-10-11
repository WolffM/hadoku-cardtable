/**
 * Recording, every animation frame, where one screen draws a moving thing — the other seat's
 * dragged ability chip, or the tile of a card they rearrange — and summing it up.
 *
 * Each recording's loop carries its own token and dies on the first frame after `stopTrace`, or
 * after the next `recordTrace` replaced it. The first copy of this recorder (in `w69-chip.spec.ts`)
 * shared one `__stop` flag that the next recording re-armed: when the page had not painted between
 * the two calls, the first loop never saw the flag and went on recording ITS selector into the
 * second trace. Two loops into one trace read as one element flipping every frame between two
 * spots — the chip at rest and the card being dragged, 174 px apart — with `rebuilds=1`
 * (2 of ~20 CI traces; a page with nothing else to do reproduced it 14 of 20 times).
 */
import type { Page } from '@playwright/test';

/** One frame: where the element is drawn, and the evidence around it. */
interface Frame {
  t: number;
  x: number | null;
  y: number | null;
  w: number;
  h: number;
  /** What it showed: its face, a card back, or nothing at all. */
  face: 'face' | 'back' | 'none';
  /** How many elements matched the selector. */
  n: number;
  /** How many elements matched the anchor selector, and the first one's identity and centre. */
  anchors: number;
  anchorId: number;
  anchorConnected: boolean;
  homeX: number | null;
  homeY: number | null;
  /** The style.left/top the page itself last set on the element (a new target arrived). */
  target: string;
}

export interface Trace {
  /** Frames seen while recording. */
  frames: number;
  /** Distinct positions drawn. */
  moves: number;
  /** The longest the drawn position stood still, in ms, between its first and last move. */
  maxHoldMs: number;
  /** When the longest hold started, in ms after the first move. */
  holdAtMs: number;
  /** The biggest single jump between two consecutive frames, in px. */
  maxJumpPx: number;
  /** Frames on which the element was missing, empty, or a card back. */
  blankFrames: number;
  /** Times it turned from its face to a back or nothing, or back again, once first drawn. */
  faceFlips: number;
  /** Times its contents were rebuilt (a React root, or a clone, made again). */
  rebuilds: number;
  /** The most elements the selector matched in one frame. */
  maxCount: number;
  /** The most anchor elements matched in one frame, and how many distinct ones were seen. */
  maxAnchors: number;
  anchorIds: number;
  /** Frames drawing the element while the remembered anchor was no longer in the document. */
  anchorGone: number;
  /** The longest gap between two animation frames, in ms: a stall of this screen itself. */
  maxFrameMs: number;
  /** The longest gap between two new targets (`left`/`top` set by the page), in ms, from the first move. */
  maxTargetGapMs: number;
  /** The drawn centres around the biggest jump, with the selector's count and the anchor's centre. */
  around: string;
  /** Last drawn box, w×h. */
  box: { w: number; h: number };
}

/** Start recording on `page`, every animation frame, the first element matching `selector`. */
export async function recordTrace(page: Page, selector: string, anchorSelector: string | null = null): Promise<void> {
  await page.evaluate(
    ({ sel, anchorSel }) => {
      const w = window as unknown as { __trace: Frame[]; __traceToken: number; __traceRebuilds: number };
      const token = (w.__traceToken ?? 0) + 1;
      w.__traceToken = token;
      w.__trace = [];
      w.__traceRebuilds = 0;
      const seen = new WeakSet<Element>();
      const ids = new WeakMap<Element, number>();
      let nextId = 1;
      let anchor: Element | null = null;
      const idOf = (el: Element): number => {
        if (!ids.has(el)) ids.set(el, nextId++);
        return ids.get(el)!;
      };
      const tick = (t: number): void => {
        // Replaced or stopped: this loop is done, whatever any other recording does.
        if (w.__traceToken !== token) return;
        const all = document.querySelectorAll(sel);
        const el = all[0] ?? null;
        const anchors = anchorSel === null ? [] : Array.from(document.querySelectorAll(anchorSel));
        if (anchors[0] !== undefined) anchor = anchors[0];
        const home = anchor?.isConnected === true ? anchor.getBoundingClientRect() : null;
        const base = {
          t,
          n: all.length,
          anchors: anchors.length,
          anchorId: anchor === null ? 0 : idOf(anchor),
          anchorConnected: anchor === null || anchor.isConnected,
          homeX: home === null ? null : home.left + home.width / 2,
          homeY: home === null ? null : home.top + home.height / 2,
        };
        if (el === null) w.__trace.push({ ...base, x: null, y: null, w: 0, h: 0, face: 'none', target: '' });
        else {
          const r = el.getBoundingClientRect();
          const content = el.querySelector('.placed__tile > *, .card, [data-ability-chip]');
          if (content !== null && !seen.has(content)) {
            if (w.__trace.some((f) => f.face === 'face')) w.__traceRebuilds += 1;
            seen.add(content);
          }
          const back = el.querySelector('.placed__back') !== null;
          const face = back ? 'back' : content === null ? 'none' : 'face';
          const s = (el as HTMLElement).style;
          w.__trace.push({ ...base, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, face, target: `${s.left},${s.top}` });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { sel: selector, anchorSel: anchorSelector },
  );
}

/** Stop the recording on `page` and sum it up. */
export async function stopTrace(page: Page): Promise<Trace> {
  return page.evaluate(() => {
    const w = window as unknown as { __trace: Frame[]; __traceToken: number; __traceRebuilds: number };
    w.__traceToken += 1;
    const frames = w.__trace;
    const placed = frames.filter((f) => f.x !== null) as (Frame & { x: number; y: number })[];
    const changes: number[] = [];
    let maxJump = 0;
    let jumpAt = 0;
    for (let i = 1; i < placed.length; i += 1) {
      const d = Math.hypot(placed[i]!.x - placed[i - 1]!.x, placed[i]!.y - placed[i - 1]!.y);
      if (d > 0.5) {
        changes.push(placed[i]!.t);
        if (d > maxJump) {
          maxJump = d;
          jumpAt = i;
        }
      }
    }
    const around = placed
      .slice(Math.max(0, jumpAt - 3), jumpAt + 3)
      .map((f) => `${Math.round(f.x)},${Math.round(f.y)}#${f.n}@${f.homeX === null ? '-' : `${Math.round(f.homeX)},${Math.round(f.homeY!)}`}a${f.anchorId}`)
      .join(' ');
    let maxHold = 0;
    let holdAt = 0;
    for (let i = 1; i < changes.length; i += 1) {
      if (changes[i]! - changes[i - 1]! > maxHold) {
        maxHold = changes[i]! - changes[i - 1]!;
        holdAt = changes[i - 1]! - changes[0]!;
      }
    }
    // New targets the page set, from the first move to the last: the cadence of the messages it drew.
    const first = changes[0] ?? Infinity;
    const last = changes[changes.length - 1] ?? -Infinity;
    const targets: number[] = [];
    for (let i = 1; i < frames.length; i += 1) {
      if (frames[i]!.target !== frames[i - 1]!.target && frames[i]!.t >= first && frames[i]!.t <= last) targets.push(frames[i]!.t);
    }
    let maxTargetGap = 0;
    for (let i = 1; i < targets.length; i += 1) maxTargetGap = Math.max(maxTargetGap, targets[i]! - targets[i - 1]!);
    let maxFrame = 0;
    for (let i = 1; i < frames.length; i += 1) maxFrame = Math.max(maxFrame, frames[i]!.t - frames[i - 1]!.t);
    let faceFlips = 0;
    let shown = false;
    for (let i = 1; i < frames.length; i += 1) {
      if (frames[i - 1]!.face === 'face') shown = true;
      if (shown && frames[i]!.face !== frames[i - 1]!.face) faceFlips += 1;
    }
    const lastPlaced = placed[placed.length - 1];
    return {
      frames: frames.length,
      moves: changes.length,
      maxHoldMs: Math.round(maxHold),
      holdAtMs: Math.round(holdAt),
      maxJumpPx: Math.round(maxJump),
      blankFrames: frames.filter((f) => f.face !== 'face').length,
      faceFlips,
      rebuilds: w.__traceRebuilds,
      maxCount: Math.max(0, ...frames.map((f) => f.n)),
      maxAnchors: Math.max(0, ...frames.map((f) => f.anchors)),
      anchorIds: new Set(frames.map((f) => f.anchorId).filter((id) => id > 0)).size,
      anchorGone: frames.filter((f) => f.n > 0 && !f.anchorConnected).length,
      maxFrameMs: Math.round(maxFrame),
      maxTargetGapMs: Math.round(maxTargetGap),
      around,
      box: { w: Math.round(lastPlaced?.w ?? 0), h: Math.round(lastPlaced?.h ?? 0) },
    };
  });
}

/** One evidence line. */
export const traceLine = (t: Trace): string =>
  `frames=${t.frames} moves=${t.moves} maxHoldMs=${t.maxHoldMs} holdAtMs=${t.holdAtMs} maxJumpPx=${t.maxJumpPx} blankFrames=${t.blankFrames} faceFlips=${t.faceFlips} rebuilds=${t.rebuilds} maxCount=${t.maxCount} maxAnchors=${t.maxAnchors} anchorIds=${t.anchorIds} anchorGone=${t.anchorGone} maxFrameMs=${t.maxFrameMs} maxTargetGapMs=${t.maxTargetGapMs} box=${t.box.w}x${t.box.h} aroundJump=[${t.around}]`;

/** Press at `from`, then the same path every time: 40 steps of 6 px left and 1 px down, one every ~16 ms. */
export async function dragPath(page: Page, from: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i += 1) {
    await page.mouse.move(from.x - 6 * i, from.y + i);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(400);
  await page.mouse.up();
}
