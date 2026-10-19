// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { setRolePlayer } from '../sound/index.ts';
import type { SoundEvent } from '../sound/mix.ts';
import pick1 from './fixtures/seat0-pack1-pick1.json';
import pick2 from './fixtures/seat0-pack1-pick2.json';
import spectator from './fixtures/spectator-pack2-pick5.json';
import { freshPackKey, useNewPackSound } from './packSound.ts';
import type { DraftView } from './types.ts';
import { expectDraftView } from './validate.ts';

afterEach(() => setRolePlayer(null));

const view = (raw: unknown): DraftView => expectDraftView(raw, 'fixture');

function recorded(): string[] {
  const roles: string[] = [];
  setRolePlayer({ play: (e: SoundEvent) => void roles.push(e.role) });
  return roles;
}

describe('the New pack sound', () => {
  it('names a whole pack at its first pick, for a seat only', () => {
    expect(freshPackKey(view(pick1))).not.toBeNull();
    expect(freshPackKey(view(pick2))).toBeNull();
    expect(freshPackKey(view(spectator))).toBeNull();
  });

  it('plays once for a fresh pack, not again for its later picks or a re-render, and again for the next round', () => {
    const roles = recorded();
    const first = view(pick1);
    const { rerender } = renderHook((v: DraftView) => useNewPackSound(v), { initialProps: first });
    expect(roles).toEqual(['ui.draft-pack']);
    rerender({ ...first });
    rerender(view(pick2));
    expect(roles).toEqual(['ui.draft-pack']);
    rerender({ ...first, packNumber: 2 });
    expect(roles).toEqual(['ui.draft-pack', 'ui.draft-pack']);
  });
});
