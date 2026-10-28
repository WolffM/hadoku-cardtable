/*
 * Create event, beside Create room: what kind of event, its title and start, and for a room event
 * the room's own fields (`RoomFields.tsx`, the same ones Create room asks). A room kind makes its
 * room at once with you as its leader (`apps/server/src/http/events.ts`), so it opens there; a
 * casual event only goes on the calendar.
 */

import { useState, type FormEvent } from 'react';
import { EVENT_KINDS, ROOM_NAME_MAX, type EventKind } from '@hadoku/shared';

import { Modal } from '../components/Modal.tsx';
import { RadioCards } from '../components/RadioCards.tsx';
import { navigate } from '../screens/route.ts';
import { playRole } from '../sound/index.ts';
import { EVENT_KIND_LABELS, eventsApi, fromLocalInput, refreshEvents } from '../front/events.ts';
import { createRoomFields } from './api.ts';
import { NEW_ROOM_FIELDS, RoomFields, roomRequest, type RoomFieldValues } from './RoomFields.tsx';

const KIND_CARDS = EVENT_KINDS.map((value) => ({ value, label: EVENT_KIND_LABELS[value] }));

const FORM_ID = 'event-create-form';

export function CreateEventDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<EventKind>('draft-pod');
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [fields, setFields] = useState<RoomFieldValues>(NEW_ROOM_FIELDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const iso = fromLocalInput(startsAt);
    if (title.trim() === '' || iso === null) {
      playRole('ui.deny');
      setError(title.trim() === '' ? 'Title required.' : 'Start time required.');
      return;
    }
    playRole('ui.select');
    setBusy(true);
    setError(null);
    const outcome = await eventsApi().create({ kind, title: title.trim(), startsAt: iso, ...(kind === 'room' ? { room: createRoomFields(roomRequest(fields)) } : {}) });
    setBusy(false);
    if (!outcome.ok) {
      playRole('ui.deny');
      setError(outcome.message);
      return;
    }
    await refreshEvents();
    if (outcome.event.roomId !== null) navigate({ kind: 'room', roomId: outcome.event.roomId });
    else onClose();
  };

  return (
    <Modal
      title="Create an event"
      testId="event-create"
      onClose={onClose}
      actions={
        <button type="submit" form={FORM_ID} className="lobby__go" data-testid="event-create-submit" disabled={busy}>
          Create event
        </button>
      }
    >
      <form id={FORM_ID} className="event-create" autoComplete="off" onSubmit={(e) => void submit(e)}>
        <span className="rooms__caption">Kind</span>
        <RadioCards name="event-create-kind" label="Kind" options={KIND_CARDS} value={kind} onChange={setKind} testId="event-create-kind" />

        <label htmlFor="event-create-title">Title</label>
        <input
          id="event-create-title"
          data-testid="event-create-title"
          value={title}
          maxLength={ROOM_NAME_MAX}
          placeholder="Saturday cube"
          autoComplete="nickname"
          autoFocus
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
        />

        <label htmlFor="event-create-starts">Starts</label>
        <input id="event-create-starts" data-testid="event-create-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />

        {kind === 'room' && <RoomFields idPrefix="event-create" value={fields} onChange={setFields} />}

        {error !== null && (
          <p className="ct-error rooms__error" role="alert" data-testid="event-create-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
