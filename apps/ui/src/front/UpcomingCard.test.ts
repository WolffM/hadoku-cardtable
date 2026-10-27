import { describe, expect, it } from 'vitest';

import { upcomingEvents, type FrontEvent } from './UpcomingCard.tsx';

const event = (date: string, title = 'x'): FrontEvent => ({ date, title, detail: '' });

describe('upcomingEvents', () => {
  it('drops a past date and keeps today and the future, earliest first', () => {
    const now = new Date('2026-10-27T12:00:00.000Z');
    const events = [event('2026-10-20'), event('2026-11-01'), event('2026-10-27'), event('2026-10-26')];
    expect(upcomingEvents(events, now).map((e) => e.date)).toEqual(['2026-10-27', '2026-11-01']);
  });

  it('is empty for an empty list — the shipped default', () => {
    expect(upcomingEvents([], new Date())).toEqual([]);
  });
});
