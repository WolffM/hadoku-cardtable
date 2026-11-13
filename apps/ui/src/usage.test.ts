// @vitest-environment jsdom
/*
 * The generic counting behaviour (targetName, batching, flush timing) is pinned where it now lives:
 * packages/ui-shell/src/usage/index.test.ts. What is left here is cardtable's own wiring: the
 * screen a route hash names, and that `startUsage()` posts to this app's own URL with this app's
 * own batch limit, in a batch the server schema accepts.
 */
import { UsageBatchSchema, type UsageBatch } from '@hadoku/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { screenOf, startUsage } from '@hadoku/game-ui/usage.ts';

describe('screenOf', () => {
  it('names a screen by its route, and a room table apart from its room', () => {
    expect(screenOf('')).toBe('lobby');
    expect(screenOf('#/room/r-1a2b3c')).toBe('room');
    expect(screenOf('#/room/r-1a2b3c/table/t-9')).toBe('room/table');
    expect(screenOf('#/match/m-1')).toBe('match');
  });
});

describe('startUsage', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  it('posts to this app’s own /api/usage, counting views and named presses by its own route, in a batch the server schema accepts', () => {
    const sent: { url: string; batch: UsageBatch }[] = [];
    stop = startUsage({ send: (url, batch) => sent.push({ url, batch: batch as UsageBatch }) });
    document.body.innerHTML = '<button data-testid="seat-2"><span id="inner">Sit</span></button><p id="plain">text</p>';
    document.getElementById('inner')!.click();
    document.getElementById('plain')!.click();
    window.location.hash = '#/room/r-1a2b3c';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new Event('pagehide'));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.endsWith('/api/usage')).toBe(true);
    expect(sent[0]!.batch.entries).toEqual([
      { kind: 'view', screen: 'lobby' },
      { kind: 'click', screen: 'lobby', target: 'seat' },
      { kind: 'view', screen: 'room' },
    ]);
    expect(UsageBatchSchema.safeParse(sent[0]!.batch).success).toBe(true);
  });
});
