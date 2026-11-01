// @vitest-environment jsdom
/*
 * Several projectiles in flight at once (a wipe's hits): each frame, every trail reads where its ball is
 * before any trail drops its embers — one layout a frame, not one per ball (cut 3's Blasphemous Act).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fly } from './projectile.ts';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

describe('trail', () => {
  it('reads every ball, then drops every ball’s embers, each frame', () => {
    let queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
    HTMLElement.prototype.animate = vi.fn(() => ({ finished: new Promise(() => undefined), cancel: () => undefined }) as unknown as Animation) as unknown as typeof HTMLElement.prototype.animate;
    const log: string[] = [];
    const root = document.createElement('div');
    document.body.append(root);
    root.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    const append = root.append.bind(root);
    vi.spyOn(root, 'append').mockImplementation((...nodes) => {
      for (const n of nodes) if (n instanceof HTMLElement && n.classList.contains('effect-trail')) log.push('ember');
      append(...nodes);
    });
    let frame = 0;
    for (const n of [1, 2, 3]) {
      const ball = fly(root, { x: 100 * n, y: 600 }, { x: 500, y: 100 }, `hit:${n}`, 'bolt', 1000, null, 1);
      ball.getBoundingClientRect = () => {
        log.push('read');
        return rect(100 * n + frame * 40, 600 - frame * 40, 20, 20);
      };
    }
    for (frame = 1; frame <= 2; frame++) {
      log.length = 0;
      const run = queue;
      queue = [];
      for (const cb of run) cb(performance.now());
      expect(log.filter((e) => e === 'read'), `frame ${frame}: every ball read`).toHaveLength(3);
      expect(log.indexOf('ember'), `frame ${frame}: embers dropped`).toBeGreaterThan(-1);
      expect(log.lastIndexOf('read'), `frame ${frame}: no ember before the last read`).toBeLessThan(log.indexOf('ember'));
    }
  });
});
