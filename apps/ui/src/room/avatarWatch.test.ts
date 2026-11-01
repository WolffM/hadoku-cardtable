import { describe, expect, it } from 'vitest';
import { watchAvatar } from './avatarWatch.ts';

function rig(account: string | null = null) {
  let cache: string | null = null;
  const asserted: string[] = [];
  let tick: (() => void) | null = null;
  let cleared = false;
  let again: (() => void) | null = null;
  let unheard = false;
  const stop = watchAvatar({
    readAccount: () => Promise.resolve(account),
    readCache: () => cache,
    assert: (id) => asserted.push(id),
    rejoined: (listener) => {
      again = listener;
      return () => {
        unheard = true;
      };
    },
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  return {
    asserted,
    stop,
    setCache: (v: string | null) => {
      cache = v;
    },
    tick: () => tick?.(),
    rejoin: () => again?.(),
    wasCleared: () => cleared,
    stoppedHearing: () => unheard,
  };
}

describe('watching the viewer avatar (Q6)', () => {
  it('asserts a NEW pick made after the first read, once, and not again until it changes', () => {
    const r = rig();
    r.setCache('mage');
    r.tick();
    r.tick();
    expect(r.asserted).toEqual(['mage']);
    r.setCache('rogue');
    r.tick();
    r.tick();
    expect(r.asserted).toEqual(['mage', 'rogue']);
  });

  // A deploy restarts the server mid-match. A saved room keeps no faces (R12), so the room comes
  // back wearing a handed-out character on this viewer's seat, and the pick, which has not changed,
  // is said again the moment the server has them back (e2e/w32.spec.ts, "after a deploy mid-match").
  it('says the pick again when the server has them back, and says nothing when there is no pick', () => {
    const r = rig();
    r.rejoin();
    expect(r.asserted, 'no pick: the room keeps the character it handed out').toEqual([]);
    r.setCache('mage');
    r.tick();
    r.rejoin();
    r.tick();
    expect(r.asserted).toEqual(['mage', 'mage']);
    r.stop();
    expect(r.stoppedHearing()).toBe(true);
    r.rejoin();
    expect(r.asserted, 'stopped: nothing more').toEqual(['mage', 'mage']);
  });

  it('uses the account copy when the cache is empty, and lets the cache win afterwards', async () => {
    const r = rig('sage');
    await Promise.resolve();
    expect(r.asserted).toEqual(['sage']);
    r.setCache('knight');
    r.tick();
    expect(r.asserted).toEqual(['sage', 'knight']);
  });

  it('does not let a late account read overwrite a pick the cache already made', async () => {
    const r = rig('sage');
    r.setCache('mage');
    r.tick();
    await Promise.resolve();
    expect(r.asserted).toEqual(['mage']);
  });

  it('asserts nothing for a viewer with no avatar, and stops when asked', () => {
    const r = rig();
    r.tick();
    expect(r.asserted).toEqual([]);
    r.stop();
    expect(r.wasCleared()).toBe(true);
    r.setCache('mage');
    r.tick();
    expect(r.asserted).toEqual([]);
  });
});
