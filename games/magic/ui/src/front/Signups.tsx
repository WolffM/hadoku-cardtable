/*
 * Who has signed up for an event (`EventView.signups`: everyone who submitted its Rally form and
 * everyone in its room, once each): a chip of the first few faces and the count, and the list it
 * opens. The calendar row (`./UpcomingCard.tsx`) and the event's room (`../screens/magic-room-ui.tsx`)
 * draw the same chip and the same list; the row hands its View and Sign up to the list's foot.
 */

import { useEffect, useRef, useState } from 'react';
import type { EventSignup, EventView } from '@hadoku/shared';

import { Avatar } from '@hadoku/game-ui/components/Avatar.tsx';
import { Modal } from '@hadoku/game-ui/components/Modal.tsx';
import { playRole } from '@hadoku/game-ui/sound/index.ts';
import { eventsApi, refreshEvents, useEvents, whenLabel } from './events.ts';
import './Signups.css';

/** How many faces the chip overlaps before the count. */
const CHIP_FACES = 4;

function Face({ person }: { person: EventSignup }) {
  return (
    <span className="signups__face">
      <Avatar id={person.avatarId} look={person.look} fallback="initial" name={person.name} className="signups__face-img" fallbackClassName="signups__face-initial" />
    </span>
  );
}

export interface SignupsActions {
  /** The row's View: absent in the room itself. */
  onView?: () => void;
  /** The row's Sign up: absent where there is nothing to sign up for. */
  onSignUp?: () => void;
  busy?: boolean;
}

export function SignupsChip({ event, ...actions }: { event: EventView } & SignupsActions) {
  const [open, setOpen] = useState(false);
  const count = event.signups.length;
  return (
    <>
      <button
        type="button"
        className="signups__chip"
        data-testid="event-signups"
        aria-label={`Signed up: ${String(count)}. Show who`}
        onClick={() => {
          playRole('ui.select');
          setOpen(true);
        }}
      >
        {count > 0 && (
          <span className="signups__faces">
            {event.signups.slice(0, CHIP_FACES).map((p, i) => (
              <Face key={i} person={p} />
            ))}
          </span>
        )}
        <span>
          <strong>{count}</strong> signed up
        </span>
      </button>
      {open && <SignupsModal event={event} onClose={() => setOpen(false)} {...actions} />}
    </>
  );
}

export function SignupsModal({ event, onClose, onView, onSignUp, busy = false }: { event: EventView; onClose: () => void } & SignupsActions) {
  const actions =
    onView === undefined && onSignUp === undefined ? undefined : (
      <>
        {onView !== undefined && (
          <button type="button" className="button" data-testid="event-signups-view" onClick={onView}>
            View room
          </button>
        )}
        {onSignUp !== undefined && (
          <button type="button" className="button ct-modal__primary" data-testid="event-signups-signup" disabled={busy} onClick={onSignUp}>
            Sign up
          </button>
        )}
      </>
    );
  return (
    <Modal title={`Signed up · ${String(event.signups.length)}`} testId="event-signups-modal" onClose={onClose} actions={actions}>
      <p className="signups__event">
        {event.title} · {whenLabel(event.startsAt)}
      </p>
      <ul className="signups__list">
        {event.signups.map((p, i) => (
          <li key={p.id === '' ? i : p.id} className="signups__person" data-testid="event-signups-person">
            <Face person={p} />
            <span className="signups__name">{p.name}</span>
            {p.inRoom && (
              <span className="signups__tag" data-testid="event-signups-in-room">
                In room
              </span>
            )}
            {event.mine && p.you !== true && p.id !== '' && <RemoveSignup eventId={event.id} signupId={p.id} />}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/**
 * The organizer's Remove on a row: a second press confirms. It takes them out of the room too
 * (`POST /api/events/:id/signups/remove`); the list re-reads once the server has done it.
 */
function RemoveSignup({ eventId, signupId }: { eventId: string; signupId: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    setBusy(true);
    const done = await eventsApi().removeSignup(eventId, signupId);
    setBusy(false);
    if (!done.ok) return setFailed(done.message);
    await refreshEvents();
  };
  return (
    <button
      type="button"
      className={armed ? 'button ghost signups__remove signups__remove--armed' : 'button ghost signups__remove'}
      data-testid={armed ? 'event-signups-remove-confirm' : 'event-signups-remove'}
      disabled={busy}
      title={failed ?? undefined}
      onClick={() => (armed ? void remove() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? 'Confirm' : 'Remove'}
    </button>
  );
}

/**
 * The chip beside an event room's title, from the calendar's own store: nothing until the events
 * read names this room. `members` is the room's head count: a join or a leave re-reads the list.
 */
export function RoomSignups({ roomId, members }: { roomId: string; members: number }) {
  const { events } = useEvents();
  // The store reads on mount; a change of head count after that reads again.
  const seen = useRef(members);
  useEffect(() => {
    if (seen.current === members) return;
    seen.current = members;
    void refreshEvents();
  }, [members]);
  const event = events?.find((e) => e.roomId === roomId);
  return event === undefined ? null : <SignupsChip event={event} />;
}
