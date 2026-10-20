// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { setRolePlayer } from '../sound/index.ts';
import type { SoundEvent } from '../sound/mix.ts';
import pick1 from './fixtures/seat0-pack1-pick1.json';
import pick2 from './fixtures/seat0-pack1-pick2.json';
import spectator from './fixtures/spectator-pack2-pick5.json';
import { nextPackKey, useNewPackSound } from './packSound.ts';
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
  it('names the pack in front of a seat that still owes a pick from it, and nothing for a spectator', () => {
    expect(nextPackKey(view(pick1))).not.toBeNull();
    expect(nextPackKey(view(pick2))).not.toBe(nextPackKey(view(pick1)));
    expect(nextPackKey(view(spectator))).toBeNull();
    const picked = view(pick1);
    expect(nextPackKey({ ...picked, waitingOn: picked.waitingOn.filter((s) => s !== 0) }), 'already picked from it').toBeNull();
  });

  it('plays once for each pack that lands, not again for a re-render or while waiting on the table', () => {
    const roles = recorded();
    const first = view(pick1);
    const { rerender } = renderHook((v: DraftView) => useNewPackSound(v), { initialProps: first });
    expect(roles).toEqual(['ui.draft-pack']);
    rerender({ ...first });
    rerender({ ...first, waitingOn: first.waitingOn.filter((s) => s !== 0) });
    expect(roles).toEqual(['ui.draft-pack']);
    rerender(view(pick2));
    expect(roles).toEqual(['ui.draft-pack', 'ui.draft-pack']);
    rerender({ ...first, packNumber: 2 });
    expect(roles).toHaveLength(3);
  });
});
