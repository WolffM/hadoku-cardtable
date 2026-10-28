import { describe, expect, it } from 'vitest';
import type { EventView } from '@hadoku/shared';

import { countdown } from './countdown.ts';
import { fromLocalInput, soonest, toLocalInput } from './events.ts';

const at = (iso: string, title = iso): EventView => ({ id: title, kind: 'casual', title, startsAt: iso, organizer: 'alice', mine: false, roomId: null });

describe('soonest', () => {
  it('keeps the next three, soonest first, whatever order they came in', () => {
    const events = [at('2026-11-04T20:00:00Z'), at('2026-11-01T20:00:00Z'), at('2026-11-03T20:00:00Z'), at('2026-11-02T20:00:00Z')];
    expect(soonest(events).map((e) => e.startsAt)).toEqual(['2026-11-01T20:00:00Z', '2026-11-02T20:00:00Z', '2026-11-03T20:00:00Z']);
    expect(soonest([])).toEqual([]);
  });
});

describe('countdown', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  it('reads days and hours, hours and minutes, or minutes, rounding a part-minute up', () => {
    expect(countdown('2026-10-30T16:00:00Z', now)).toBe('in 2d 4h');
    expect(countdown('2026-10-30T12:00:00Z', now)).toBe('in 2d');
    expect(countdown('2026-10-28T15:10:00Z', now)).toBe('in 3h 10m');
    expect(countdown('2026-10-28T15:00:00Z', now)).toBe('in 3h');
    expect(countdown('2026-10-28T12:24:30Z', now)).toBe('in 25m');
  });
  it('is "now" once it has started', () => {
    expect(countdown('2026-10-28T12:00:00Z', now)).toBe('now');
    expect(countdown('2026-10-28T09:00:00Z', now)).toBe('now');
  });
});

describe('the datetime-local round trip', () => {
  it('reads back the instant it wrote, in the viewer’s own zone', () => {
    const iso = '2026-11-01T20:30:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });
  it('is null for an empty or unreadable value', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('not a date')).toBeNull();
  });
});
