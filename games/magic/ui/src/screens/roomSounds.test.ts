// @vitest-environment jsdom
/*
 * The room's comings and goings (the operator, 2026-11-08): another member arriving plays the join, one going
 * the leave, anyone readying the ready. The first read is the baseline, and a change of where readiness is read
 * from rebaselines it rather than sounding.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FALLBACK_ROLES, SOUND_ROLES } from '@hadoku/shared';

const played = vi.hoisted(() => [] as string[]);
vi.mock('@hadoku/game-ui/sound/index.ts', () => ({ playRole: (role: string) => played.push(role) }));

import { presenceRoles, useRoomSounds, type RoomPresence } from './roomSounds.ts';

const room = (others: string[], ready: string[] = [], readySource = 'classic'): RoomPresence => ({ others, ready, readySource });

beforeEach(() => {
  played.length = 0;
});

describe('room sounds', () => {
  it('each is a role in the builder, falling back to the operator’s pick until one is assigned', () => {
    for (const role of ['ui.room-join', 'ui.room-ready', 'ui.room-leave']) expect(SOUND_ROLES.has(role)).toBe(true);
    expect(FALLBACK_ROLES['ui.room-join']).toBe('g.turn-mine');
    expect(FALLBACK_ROLES['ui.room-ready']).toBe('g.attack');
    expect(FALLBACK_ROLES['ui.room-leave']).toBe('g.counter');
  });

  it('a member arriving joins, one going leaves, anyone readying readies', () => {
    expect(presenceRoles(room(['a']), room(['a', 'b']))).toEqual(['ui.room-join']);
    expect(presenceRoles(room(['a', 'b']), room(['a']))).toEqual(['ui.room-leave']);
    expect(presenceRoles(room(['a']), room(['a'], ['seat:0:me']))).toEqual(['ui.room-ready']);
  });

  it('one read plays each role at most once, and unreadying plays nothing', () => {
    expect(presenceRoles(room([], ['x']), room(['a', 'b', 'c'], ['y', 'z']))).toEqual(['ui.room-join', 'ui.room-ready']);
    expect(presenceRoles(room(['a'], ['x']), room(['a']))).toEqual([]);
    expect(presenceRoles(room(['a', 'b']), room(['b', 'c']))).toEqual(['ui.room-join', 'ui.room-leave']);
  });

  it('readiness read from a new source is a baseline, not a ready', () => {
    expect(presenceRoles(room(['a'], [], 'classic|false'), room(['a'], ['seat:0:me'], 'classic|true'))).toEqual([]);
  });

  it('the hook hears changes only after its first read, and again only after a read once the room is lost', () => {
    const { rerender } = renderHook(({ p }: { p: RoomPresence | null }) => useRoomSounds(p), { initialProps: { p: null as RoomPresence | null } });
    rerender({ p: room(['a', 'b'], ['seat:0:a']) });
    expect(played).toEqual([]);
    rerender({ p: room(['a', 'b', 'c'], ['seat:0:a']) });
    expect(played).toEqual(['ui.room-join']);
    rerender({ p: room(['a', 'b', 'c'], ['seat:0:a']) });
    expect(played).toEqual(['ui.room-join']);
    rerender({ p: null });
    rerender({ p: room(['a'], ['seat:1:b']) });
    expect(played).toEqual(['ui.room-join']);
  });
});
