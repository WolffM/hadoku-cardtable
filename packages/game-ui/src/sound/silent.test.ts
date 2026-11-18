import { describe, expect, it } from 'vitest';

import { playRole, setScreenMusic, takeUiTally } from './index.ts';

// Nothing registers a sound in this file: a game with no sound of its own (bomberman, the template) never does.
describe('sound with nothing registered', () => {
  it('plays nothing and throws nothing', () => {
    expect(() => playRole('ui.hover-card')).not.toThrow();
    expect(() => setScreenMusic(null)).not.toThrow();
    expect(takeUiTally()).toEqual({});
  });
});
