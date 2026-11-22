// @vitest-environment jsdom
/*
 * The generic counting behaviour (targetName, batching, flush timing) is pinned where it now lives:
 * packages/ui-shell/src/usage/index.test.ts. What is left here is cardtable's own wiring: the
 * screen an address names (its path, where the app's routes live, or its hash), and that
 * `startUsage()` posts to this app's own URL with this app's own batch limit, in a batch the
 * server schema accepts.
 */
import { UsageBatchSchema, type UsageBatch } from '@hadoku/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { screenOf, startUsage } from '@hadoku/game-ui/usage.ts';

describe('screenOf', () => {
  const at = (pathname: string, hash = '') => screenOf({ pathname, hash }, '/cardtable/');

  it('names a screen by its route, and a room table apart from its room', () => {
    expect(at('/cardtable/')).toBe('lobby');
    expect(at('/cardtable/', '#/room/r-1a2b3c')).toBe('room');
    expect(at('/cardtable/', '#/room/r-1a2b3c/table/t-9')).toBe('room/table');
    expect(at('/cardtable/', '#/match/m-1')).toBe('match');
  });

  it("names a room's page by its path, not as the lobby its empty hash would read as", () => {
    expect(at('/cardtable/room/r-15bc7e47c9b1')).toBe('room');
    expect(at('/cardtable/stats')).toBe('stats');
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
    expect(sent[0]!.batch.entries.map(({ kind, screen, target }) => ({ kind, screen, target }))).toEqual([
      { kind: 'view', screen: 'lobby', target: undefined },
      { kind: 'click', screen: 'lobby', target: 'seat' },
      { kind: 'view', screen: 'room', target: undefined },
    ]);
    expect(sent[0]!.batch.entries.every((e) => typeof e.at === 'number' && e.at <= sent[0]!.batch.sentAt!)).toBe(true);
    expect(UsageBatchSchema.safeParse(sent[0]!.batch).success).toBe(true);
  });
});
