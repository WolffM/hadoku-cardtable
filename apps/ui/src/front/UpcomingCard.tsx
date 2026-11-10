/*
 * The banner's "Upcoming" card: a manual gallery (`./Gallery.tsx`) of two pages, opening on
 * Calendar, or on Polls when only Polls has something (2026-11-04, `upcomingOpensOn`). (The operator, 2026-10-30: "the calendar is a scrolling list of upcoming events, each
 * with View and Sign up buttons … the front page's middle card becomes a Calendar | Polls gallery").
 *
 *   - **Calendar** — every scheduled event, soonest first, in one scrolling list (`./events.ts`):
 *     a date block, its title, when, and its room as the room is now (`GET /api/events` reads each
 *     event's room live, so an edit in the room shows here at once). View opens the room, Sign up
 *     joins it; the organizer moves or cancels their own instead.
 *   - **Polls** — the open Rally forms attached to events (`./polls.ts`), each with Open to Rally;
 *     whoever attached one may make its event from it (Create event, filled in from the form).
 *
 * Events are made from the room list's Create event (`../rooms/CreateEventDialog.tsx`).
 *
 * Until the first events and polls reads answer, the card stands as its skeleton — the gallery's head, as many
 * Calendar rows as it drew last visit (`./shape.ts`), the dots — and crossfades in with the rest of
 * the page (`./gate.ts`).
 */

import { useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import type { EventView } from '@hadoku/shared';

import { Reveal } from '@hadoku/ui-shell/components';
import { roomsClient } from '../rooms/api.ts';
import { CreateEventDialog } from '../rooms/CreateEventDialog.tsx';
import { navigate } from '../screens/route.ts';
import { playRole } from '../sound/index.ts';
import { countdown } from './countdown.ts';
import { EVENT_KIND_LABELS, eventsApi, fromLocalInput, refreshEvents, toLocalInput, upcoming, useEvents, whenLabel } from './events.ts';
import { formatEraLabel } from './formatLabel.ts';
import { ArrowGlyph, Gallery } from './Gallery.tsx';
import { upcomingOpensOn } from './gallery.ts';
import { FrontGateContext, usePartShown } from './gate.ts';
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

/**
 * The room's own state, as the room is now: its format and how many have signed up — those who
 * said on its Rally form they can make it, for an event made from one; else those in its room.
 */
function roomLine(event: EventView): string | null {
  const room = event.room ?? null;
  if (room === null) return null;
  const signedUp = event.signedUp ?? (room.phase === null ? room.members : room.entrants);
  const parts = [room.format === '' ? null : formatEraLabel(room.format), `${String(signedUp)} signed up`];
  return parts.filter((p): p is string => p !== null).join(' · ');
}

/** The gallery as it opens, on Calendar, with `count` rows of placeholders (none: the empty line's). */
function UpcomingSkeleton({ count }: { count: number }) {
  return (
    <>
      <header className="front-card__head">
        <h3 className="front-card__title">Calendar</h3>
        <span className="gallery__arrows">
          <span className="gallery__arrow ghost">
            <ArrowGlyph dir="prev" />
          </span>
          <span className="gallery__arrow ghost">
            <ArrowGlyph dir="next" />
          </span>
        </span>
      </header>
      <div className="gallery__page">
        {count === 0 ? (
          <p className="front-card__empty">
            <span className="ghost ghost--text">Nothing scheduled yet.</span>
          </p>
        ) : (
          <ul className="front-card__events">
            {Array.from({ length: count }, (_, i) => (
              <li key={i} className="front-card__event">
                <span className="front-card__date-block">
                  <span className="front-card__date-month ghost">Nov</span>
                  <span className="front-card__date-day ghost">30</span>
                </span>
                <span className="front-card__event-text">
                  <span className="front-card__event-title">
                    <span className="ghost ghost--text">An event&apos;s title</span>
                  </span>
                  <span className="front-card__event-detail">
                    <span className="ghost ghost--text">Sat 1 Nov, 20:00 · in 2 days</span>
                  </span>
                  <span className="front-card__event-detail">
                    <span className="ghost ghost--text">Draft · someone · 3 signed up</span>
                  </span>
                  <span className="front-card__event-actions">
                    <span className="button ghost">View</span>
                    <span className="button ghost">Sign up</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="front-card__foot">
        <span className="gallery__dots">
          <span className="gallery__dot ghost" />
          <span className="gallery__dot ghost" />
        </span>
      </div>
    </>
  );
}

export function UpcomingCard() {
  const { events, now } = useEvents();
  const polls = usePolls();
  const shown = upcoming(events ?? []);
  const { shape, remember } = useContext(FrontGateContext);
  // Both lists, so the page it opens on is known before it shows and never flips under the reader.
  const loaded = events !== null && polls !== null;
  const ready = usePartShown('upcoming', loaded);
  const opening = useRef<'calendar' | 'polls' | null>(null);
  if (loaded && opening.current === null) opening.current = upcomingOpensOn(shown.length, polls.length);
  const drawnEvents = events === null ? null : shown.length;
  useEffect(() => {
    if (drawnEvents !== null) remember({ events: drawnEvents });
  }, [drawnEvents, remember]);

  return (
    <section className="front-card front-card--upcoming" data-testid="front-upcoming">
      <Reveal name="upcoming" shown={ready} skeleton={<UpcomingSkeleton count={shape.events} />} className="front-card__body" layerClassName="front-card__layer">
        <Gallery
          testId="front-upcoming"
          opening={opening.current ?? undefined}
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
      </Reveal>
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
  const [making, setMaking] = useState(false);
  return (
    <li className="front-card__event" data-testid="front-poll">
      {poll.closesAt !== null && <DateBlock at={poll.closesAt} />}
      <span className="front-card__event-text">
        <span className="front-card__event-title">{poll.title}</span>
        {poll.closesAt !== null && <span className="front-card__event-detail">closes {countdown(poll.closesAt, now)}</span>}
        <span className="front-card__event-actions">
          {poll.mine && poll.windows.length > 0 && (
            <button type="button" className="button" data-testid="front-poll-create-event" onClick={() => setMaking(true)}>
              Create event
            </button>
          )}
          <a className="button front-card__more" data-testid="front-poll-open" href={poll.url} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </span>
      </span>
      {making && <CreateEventDialog poll={poll} onClose={() => setMaking(false)} />}
    </li>
  );
}
