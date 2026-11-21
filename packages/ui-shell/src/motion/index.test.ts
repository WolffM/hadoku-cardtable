// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyMotion, clearMotion, motionState, prefersReducedMotion, rememberedMotion, rememberMotion, screenShakeAllowed, setMotionChoices } from './index.ts';

const system = (reduce: boolean): void => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce') }));
};

describe('the motion switches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setMotionChoices({});
    localStorage.clear();
  });

  it('a switch nobody set follows the system', () => {
    system(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(screenShakeAllowed()).toBe(false);
    expect(motionState()).toEqual({ cardMotion: false, screenShake: false, ambientMotion: false });
    system(false);
    expect(motionState()).toEqual({ cardMotion: true, screenShake: true, ambientMotion: true });
  });

  it('is full motion where there is no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('each switch is its own, and the player wins over the system either way', () => {
    system(false);
    setMotionChoices({ screenShake: false });
    expect(motionState()).toEqual({ cardMotion: true, screenShake: false, ambientMotion: true });
    system(true);
    setMotionChoices({ cardMotion: true });
    expect(prefersReducedMotion()).toBe(false);
    expect(screenShakeAllowed()).toBe(false);
  });

  it('writes every switch on the root, always, and takes them off again', () => {
    system(false);
    setMotionChoices({ ambientMotion: false });
    const root = document.createElement('div');
    applyMotion(root);
    expect([root.dataset.motion, root.dataset.shake, root.dataset.ambient]).toEqual(['full', 'on', 'off']);
    clearMotion(root);
    expect(root.attributes.length).toBe(0);
  });

  it('remembers the choices for the next first frame, and reads back only booleans', () => {
    rememberMotion('t:motion', { cardMotion: false, screenShake: undefined });
    expect(rememberedMotion('t:motion')).toEqual({ cardMotion: false });
    localStorage.setItem('t:motion', '{"cardMotion":"no","ambientMotion":true}');
    expect(rememberedMotion('t:motion')).toEqual({ ambientMotion: true });
    localStorage.setItem('t:motion', 'not json');
    expect(rememberedMotion('t:motion')).toBeNull();
    expect(rememberedMotion('none')).toBeNull();
  });
});
