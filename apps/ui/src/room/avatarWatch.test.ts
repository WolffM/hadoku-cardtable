// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AVATAR_EVENT } from '@wolffm/task-ui-components';

import { watchAvatar, type AvatarEventSource } from './avatarWatch.ts';

/** Lets a resolved `readAvatar()` promise settle. */
const flush = (): Promise<void> => Promise.resolve().then(() => Promise.resolve());

function rig(start: string | null = null) {
  const asserted: string[] = [];
  let again: (() => void) | null = null;
  let unheard = false;
  let live = true;
  let heard: ((event: Event) => void) | undefined;
  const events: AvatarEventSource = {
    addEventListener: (_type, listener) => {
      live = true;
      heard = listener;
    },
    removeEventListener: () => {
      live = false;
    },
  };
  const stop = watchAvatar({
    readAvatar: () => Promise.resolve(start),
    assert: (id) => asserted.push(id),
    rejoined: (listener) => {
      again = listener;
      return () => {
        unheard = true;
      };
    },
    events,
  });
  return {
    asserted,
    stop,
    /** Fires `AVATAR_EVENT` with `sprite` in its detail, as the fleet's settings popout does. */
    fire: (detail: unknown) => heard?.(new CustomEvent(AVATAR_EVENT, { detail })),
    rejoin: () => again?.(),
    wasRemoved: () => !live,
    stoppedHearing: () => unheard,
  };
}

describe('watching the viewer avatar (Q6)', () => {
  it('reads the account once at the start, and asserts what it finds', async () => {
    const r = rig('mage');
    await flush();
    expect(r.asserted).toEqual(['mage']);
  });

  it('asserts the new id a dispatched AVATAR_EVENT carries', async () => {
    const r = rig();
    await flush();
    r.fire({ sprite: 'rogue' });
    expect(r.asserted).toEqual(['rogue']);
  });

  it('asserts the same id only once, even heard twice', async () => {
    const r = rig();
    await flush();
    r.fire({ sprite: 'rogue' });
    r.fire({ sprite: 'rogue' });
    expect(r.asserted).toEqual(['rogue']);
  });

  it('the slower start read does not overwrite an id an event already asserted', async () => {
    let resolveStart: (id: string | null) => void = () => undefined;
    const asserted: string[] = [];
    let heard: ((event: Event) => void) | undefined;
    const events: AvatarEventSource = {
      addEventListener: (_type, listener) => {
        heard = listener;
      },
      removeEventListener: () => undefined,
    };
    watchAvatar({
      readAvatar: () => new Promise((resolve) => (resolveStart = resolve)),
      assert: (id) => asserted.push(id),
      rejoined: () => () => undefined,
      events,
    });
    // The event arrives while the start read is still in flight.
    heard?.(new CustomEvent(AVATAR_EVENT, { detail: { sprite: 'rogue' } }));
    expect(asserted).toEqual(['rogue']);
    // The start read, slower, resolves with a different (by now stale) id.
    resolveStart('knight');
    await flush();
    expect(asserted, 'the stale start read must not overwrite what the event already asserted').toEqual(['rogue']);
  });

  it('asserts nothing for a detail with no sprite, or no sprite picked', async () => {
    const r = rig();
    await flush();
    r.fire({ avatar: { source: 'discord', url: 'https://cdn.example/a.png' } });
    r.fire({ sprite: null });
    r.fire('not an object');
    r.fire(null);
    expect(r.asserted).toEqual([]);
  });

  it('stops hearing AVATAR_EVENT once stopped', async () => {
    const r = rig();
    await flush();
    r.stop();
    expect(r.wasRemoved()).toBe(true);
    r.fire({ sprite: 'mage' });
    expect(r.asserted).toEqual([]);
  });

  it('creates no timer: watchAvatar never calls setInterval', async () => {
    let called = false;
    const g = globalThis as { setInterval?: unknown };
    const real = g.setInterval;
    g.setInterval = (() => {
      called = true;
      return 0;
    }) as unknown;
    try {
      const stop = watchAvatar({
        readAvatar: () => Promise.resolve(null),
        assert: () => undefined,
        rejoined: () => () => undefined,
        events: { addEventListener: () => undefined, removeEventListener: () => undefined },
      });
      await flush();
      stop();
    } finally {
      g.setInterval = real;
    }
    expect(called).toBe(false);
  });

  // A deploy restarts the server mid-match. A saved room keeps no faces (R12), so the room comes
  // back wearing a handed-out character on this viewer's seat, and the pick, which has not changed,
  // is said again the moment the server has them back (e2e/w32.spec.ts, "after a deploy mid-match").
  it('says the pick again when the server has them back, and says nothing when there is no pick', async () => {
    const r = rig();
    await flush();
    r.rejoin();
    expect(r.asserted, 'no pick: the room keeps the character it handed out').toEqual([]);
    r.fire({ sprite: 'mage' });
    r.rejoin();
    expect(r.asserted).toEqual(['mage', 'mage']);
    r.stop();
    expect(r.stoppedHearing()).toBe(true);
    r.rejoin();
    expect(r.asserted, 'stopped: nothing more').toEqual(['mage', 'mage']);
  });
});
