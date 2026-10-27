/*
 * The banner's "Upcoming" card (`docs/planning/wave77-2026-10-27.md` §A): a date block, a title and
 * one detail line per event, read from `./events.json`. Ship it with an empty list and an
 * empty-state line — the brief's own instruction not to invent events before the operator has any
 * to put in it.
 *
 * "Calendar" links the Discord invite: the one place the group already schedules tournaments
 * (`../chrome/HeaderLinks.tsx`'s own comment — "the Discord server (patch notes, scheduled
 * tournaments, looking-for-game)") — there is no calendar page of our own to link instead.
 */

import { DISCORD_INVITE_URL } from '../chrome/HeaderLinks.tsx';
import EVENTS from './events.json';

export interface FrontEvent {
  /** `YYYY-MM-DD`. A past date never shows. */
  date: string;
  title: string;
  detail: string;
  href?: string;
}

const events = EVENTS as FrontEvent[];

/** `events`, future ones only, earliest first — never invented, only ever what `events.json` holds. */
export function upcomingEvents(all: readonly FrontEvent[], now: Date): FrontEvent[] {
  const today = now.toISOString().slice(0, 10);
  return all.filter((e) => e.date >= today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function DateBlock({ date }: { date: string }) {
  const [, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) ?? [];
  const monthLabel = month === undefined ? '' : MONTHS[Number(month) - 1] ?? '';
  return (
    <span className="front-card__date-block" aria-hidden="true">
      <span className="front-card__date-month">{monthLabel}</span>
      <span className="front-card__date-day">{day ?? ''}</span>
    </span>
  );
}

export function UpcomingCard({ now = new Date() }: { now?: Date }) {
  const upcoming = upcomingEvents(events, now);
  return (
    <section className="front-card front-card--upcoming" data-testid="front-upcoming">
      <header className="front-card__head">
        <h3 className="front-card__title">Upcoming</h3>
        <a className="front-card__link" href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
          Calendar
        </a>
      </header>
      {upcoming.length === 0 ? (
        <p className="front-card__empty">Nothing scheduled yet.</p>
      ) : (
        <ul className="front-card__events">
          {upcoming.map((e) => (
            <li key={`${e.date}-${e.title}`} className="front-card__event">
              <DateBlock date={e.date} />
              <span className="front-card__event-text">
                {e.href === undefined ? (
                  <span className="front-card__event-title">{e.title}</span>
                ) : (
                  <a className="front-card__event-title" href={e.href}>
                    {e.title}
                  </a>
                )}
                <span className="front-card__event-detail">{e.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
