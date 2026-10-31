/*
 * The banner's "Upcoming" card: a manual gallery (`./Gallery.tsx`) of two pages, opening on
 * Calendar (the operator, 2026-10-30: "the calendar is a scrolling list of upcoming events, each
 * with View and Sign up buttons … the front page's middle card becomes a Calendar | Polls gallery").
 *
 *   - **Calendar** — every scheduled event, soonest first, in one scrolling list (`./events.ts`):
 *     a date block, its title, when, and its room as the room is now (`GET /api/events` reads each
 *     event's room live, so an edit in the room shows here at once). View opens the room, Sign up
 *     joins it; the organizer moves or cancels their own instead.
 *   - **Polls** — the open Rally forms attached to events (`./polls.ts`), each with Open to Rally.
 *
 * Events are made from the room list's Create event (`../rooms/CreateEventDialog.tsx`).
 */

import { useState, type FormEvent } from 'react';
import type { EventView } from '@hadoku/shared';

import { roomsClient } from '../rooms/api.ts';
import { navigate } from '../screens/route.ts';
import { playRole } from '../sound/index.ts';
import { countdown } from './countdown.ts';
import { EVENT_KIND_LABELS, eventsApi, fromLocalInput, refreshEvents, toLocalInput, upcoming, useEvents, whenLabel } from './events.ts';
import { formatEraLabel } from './formatLabel.ts';
import { Gallery } from './Gallery.tsx';
import { usePolls, type Poll } from './polls.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function DateBlock({ at }: { at: string }) {
  const d = new Date(at);
  return (
    <span className="front-card__date-block" aria-hidden="true">
      <span className="front-card__date-month">{MONTHS[d.getMonth()]}</span>
      <span className="front-card__date-day">{d.getDate()}</span>
    </span>
  );
}

/** The room's own state, as the room is now: its format and how many have signed up. */
function roomLine(event: EventView): string | null {
  const room = event.room ?? null;
  if (room === null) return null;
  const parts = [room.format === '' ? null : formatEraLabel(room.format), `${String(room.phase === null ? room.members : room.entrants)} signed up`];
  return parts.filter((p): p is string => p !== null).join(' · ');
}

export function UpcomingCard() {
  const { events, now } = useEvents();
  const polls = usePolls();
  const shown = upcoming(events ?? []);

  return (
    <section className="front-card front-card--upcoming" data-testid="front-upcoming">
      <Gallery
        testId="front-upcoming"
        pages={[
          {
            key: 'calendar',
            title: 'Calendar',
            body:
              events !== null && shown.length === 0 ? (
                <p className="front-card__empty">Nothing scheduled yet.</p>
              ) : (
                <ul className="front-card__events" data-testid="front-calendar">
                  {shown.map((e) => (
                    <CalendarRow key={e.id} event={e} now={now} />
                  ))}
                </ul>
              ),
          },
          {
            key: 'polls',
            title: 'Polls',
            body:
              polls !== null && polls.length === 0 ? (
                <p className="front-card__empty">No open polls.</p>
              ) : (
                <ul className="front-card__events" data-testid="front-polls">
                  {(polls ?? []).map((p) => (
                    <PollRow key={p.id} poll={p} now={now} />
                  ))}
                </ul>
              ),
          },
        ]}
      />
    </section>
  );
}

/** One event: when, what, and its room now; View and Sign up, or the organizer's Move and Cancel. */
function CalendarRow({ event, now }: { event: EventView; now: number }) {
  const roomId = event.roomId;
  const [moving, setMoving] = useState(false);
  const [startsAt, setStartsAt] = useState(toLocalInput(event.startsAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const line = roomLine(event);

  const failed = (message: string): void => {
    playRole('ui.deny');
    setError(message);
  };

  const signUp = async (id: string): Promise<void> => {
    playRole('ui.select');
    setBusy(true);
    const joined = await roomsClient().join(id);
    setBusy(false);
    // A locked room asks for its password in the room itself.
    if (joined.ok || joined.reason === 'refused') navigate({ kind: 'room', roomId: id });
    else failed(joined.reason === 'error' ? joined.message : 'Too many tries — wait a moment.');
  };

  const move = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const iso = fromLocalInput(startsAt);
    if (iso === null) return failed('Start time required.');
    setBusy(true);
    const outcome = await eventsApi().update(event.id, { startsAt: iso });
    setBusy(false);
    if (!outcome.ok) return failed(outcome.message);
    playRole('ui.select');
    setMoving(false);
    setError(null);
    await refreshEvents();
  };

  const cancel = async (): Promise<void> => {
    setBusy(true);
    const outcome = await eventsApi().cancel(event.id);
    setBusy(false);
    if (!outcome.ok) return failed(outcome.message);
    playRole('ui.select');
    await refreshEvents();
  };

  return (
    <li className="front-card__event" data-testid="front-calendar-event" data-event={event.id}>
      <DateBlock at={event.startsAt} />
      <span className="front-card__event-text">
        <span className="front-card__event-title">{event.title}</span>
        <span className="front-card__event-detail">
          {whenLabel(event.startsAt)} · {countdown(event.startsAt, now)}
        </span>
        <span className="front-card__event-detail">
          {EVENT_KIND_LABELS[event.kind] ?? 'Event'} · {event.organizer}
          {line !== null && ` · ${line}`}
        </span>
        {moving ? (
          <form className="front-card__event-actions" onSubmit={(e) => void move(e)}>
            <input aria-label="Starts" data-testid="front-calendar-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            <button type="button" className="button" onClick={() => setMoving(false)}>
              Back
            </button>
            <button type="submit" className="button front-card__more" data-testid="front-calendar-save" disabled={busy}>
              Save
            </button>
          </form>
        ) : (
          roomId !== null && (
            <span className="front-card__event-actions">
              <button type="button" className="button" data-testid="front-calendar-view" onClick={() => navigate({ kind: 'room', roomId })}>
                View
              </button>
              {event.mine ? (
                <>
                  <button type="button" className="button" data-testid="front-calendar-move" onClick={() => setMoving(true)}>
                    Move
                  </button>
                  <button type="button" className="button" data-testid="front-calendar-cancel" disabled={busy} onClick={() => void cancel()}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="button front-card__more" data-testid="front-calendar-signup" disabled={busy} onClick={() => void signUp(roomId)}>
                  Sign up
                </button>
              )}
            </span>
          )
        )}
        {error !== null && (
          <span className="ct-error" role="alert">
            {error}
          </span>
        )}
      </span>
    </li>
  );
}

function PollRow({ poll, now }: { poll: Poll; now: number }) {
  return (
    <li className="front-card__event" data-testid="front-poll">
      {poll.closesAt !== null && <DateBlock at={poll.closesAt} />}
      <span className="front-card__event-text">
        <span className="front-card__event-title">{poll.title}</span>
        {poll.closesAt !== null && <span className="front-card__event-detail">closes {countdown(poll.closesAt, now)}</span>}
        <span className="front-card__event-actions">
          <a className="button front-card__more" data-testid="front-poll-open" href={poll.url} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </span>
      </span>
    </li>
  );
}
