/*
 * The banner's "Upcoming" card (`docs/planning/wave77-2026-10-27.md` §A): the next three scheduled
 * events (`./events.ts`), each a date block, its title — the way into its room when it has one — and
 * when, what and whose. "Calendar" opens every event in a modal, where an organizer moves or cancels
 * their own; events are made from the room list's Create event (`../rooms/CreateEventDialog.tsx`).
 */

import { useState, type FormEvent } from 'react';
import { ROOM_NAME_MAX, type EventView } from '@hadoku/shared';

import { Modal } from '../components/Modal.tsx';
import { navigate, routeHash } from '../screens/route.ts';
import { playRole } from '../sound/index.ts';
import { countdown } from './countdown.ts';
import { EVENT_KIND_LABELS, eventsApi, fromLocalInput, refreshEvents, soonest, toLocalInput, useEvents, whenLabel } from './events.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function DateBlock({ startsAt }: { startsAt: string }) {
  const d = new Date(startsAt);
  return (
    <span className="front-card__date-block" aria-hidden="true">
      <span className="front-card__date-month">{MONTHS[d.getMonth()]}</span>
      <span className="front-card__date-day">{d.getDate()}</span>
    </span>
  );
}

function EventTitle({ event, className }: { event: EventView; className: string }) {
  return event.roomId === null ? (
    <span className={className}>{event.title}</span>
  ) : (
    <a className={className} href={routeHash({ kind: 'room', roomId: event.roomId })}>
      {event.title}
    </a>
  );
}

export function UpcomingCard() {
  const { events, now } = useEvents();
  const [open, setOpen] = useState(false);
  const shown = soonest(events ?? []);

  return (
    <section className="front-card front-card--upcoming" data-testid="front-upcoming">
      <header className="front-card__head">
        <h3 className="front-card__title">Upcoming</h3>
        <button type="button" className="button front-card__more" data-testid="front-upcoming-calendar" onClick={() => setOpen(true)}>
          Calendar
        </button>
      </header>
      {events !== null && shown.length === 0 ? (
        <p className="front-card__empty">Nothing scheduled yet.</p>
      ) : (
        <ul className="front-card__events">
          {shown.map((e) => (
            <li key={e.id} className="front-card__event" data-testid="front-upcoming-event">
              <DateBlock startsAt={e.startsAt} />
              <span className="front-card__event-text">
                <EventTitle event={e} className="front-card__event-title" />
                <span className="front-card__event-detail">
                  {countdown(e.startsAt, now)} · {EVENT_KIND_LABELS[e.kind]} · {e.organizer}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Modal title="Calendar" testId="front-calendar" wide onClose={() => setOpen(false)}>
          {events === null || events.length === 0 ? (
            <p className="front-card__empty">Nothing scheduled yet.</p>
          ) : (
            <ul className="calendar">
              {events.map((e) => (
                <CalendarRow key={e.id} event={e} now={now} />
              ))}
            </ul>
          )}
        </Modal>
      )}
    </section>
  );
}

/** One event in the calendar: everything about it, and its organizer's Edit and Cancel. */
function CalendarRow({ event, now }: { event: EventView; now: number }) {
  const roomId = event.roomId;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(event.title);
  const [startsAt, setStartsAt] = useState(toLocalInput(event.startsAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const iso = fromLocalInput(startsAt);
    if (title.trim() === '' || iso === null) {
      playRole('ui.deny');
      setError(title.trim() === '' ? 'Title required.' : 'Start time required.');
      return;
    }
    setBusy(true);
    const outcome = await eventsApi().update(event.id, { title: title.trim(), startsAt: iso });
    setBusy(false);
    if (!outcome.ok) {
      playRole('ui.deny');
      setError(outcome.message);
      return;
    }
    playRole('ui.select');
    setEditing(false);
    setError(null);
    await refreshEvents();
  };

  const cancel = async (): Promise<void> => {
    setBusy(true);
    const outcome = await eventsApi().cancel(event.id);
    setBusy(false);
    if (!outcome.ok) {
      playRole('ui.deny');
      setError(outcome.message);
      return;
    }
    playRole('ui.select');
    await refreshEvents();
  };

  return (
    <li className="calendar__event" data-testid="front-calendar-event">
      <DateBlock startsAt={event.startsAt} />
      <div className="calendar__body">
        {editing ? (
          <form className="calendar__edit" onSubmit={(e) => void save(e)}>
            <input aria-label="Title" data-testid="front-calendar-title" value={title} maxLength={ROOM_NAME_MAX} onChange={(e) => setTitle(e.target.value)} />
            <input aria-label="Starts" data-testid="front-calendar-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            <span className="calendar__actions">
              <button type="button" className="button" onClick={() => setEditing(false)}>
                Back
              </button>
              <button type="submit" className="button ct-modal__primary" data-testid="front-calendar-save" disabled={busy}>
                Save
              </button>
            </span>
          </form>
        ) : (
          <>
            <EventTitle event={event} className="calendar__title" />
            <span className="calendar__when">
              {whenLabel(event.startsAt)} · {countdown(event.startsAt, now)}
            </span>
            <span className="calendar__detail">
              {EVENT_KIND_LABELS[event.kind]} · {event.organizer}
            </span>
          </>
        )}
        {error !== null && (
          <p className="ct-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {!editing && (
        <span className="calendar__actions">
          {roomId !== null && (
            <button type="button" className="button" data-testid="front-calendar-room" onClick={() => navigate({ kind: 'room', roomId })}>
              Room
            </button>
          )}
          {event.mine && (
            <>
              <button type="button" className="button" data-testid="front-calendar-edit" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="button" data-testid="front-calendar-cancel" disabled={busy} onClick={() => void cancel()}>
                Cancel
              </button>
            </>
          )}
        </span>
      )}
    </li>
  );
}
