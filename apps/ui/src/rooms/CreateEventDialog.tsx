/*
 * Create event, beside Create room: a Tournament or a Form (the operator, 2026-10-30).
 *
 * A tournament takes its title, its start and every setting its room has (`RoomFields.tsx`), and
 * makes that room at once with you as its leader (`games/magic/server/src/http/events.ts`), so it opens
 * there. The room is the source of truth from then on: what you change in it is what the calendar
 * shows.
 *
 * A form is a Rally sign-up form (`event-forms.ts`): "Create" goes to Rally's builder and comes back
 * with the new form attached; "Load" attaches one by its link.
 *
 * Opened from a poll (`poll`, the Polls page's Create event), it is a tournament filled in from the
 * form: its title, its best windows to start at (Rally's count of who can make each), and the pool
 * the people free for the chosen window ranked first. Every field stays editable, and the event
 * keeps the form, so the calendar counts who signed up.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { rallyFormIdOf, ROOM_NAME_MAX, type CubeSummary, type DraftPreset, type RallyWindow } from '@hadoku/shared';

import { Modal } from '../components/Modal.tsx';
import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';
import { navigate } from '../screens/route.ts';
import { tablesClient, type TableFormat } from '../screens/tables.ts';
import { playRole } from '../sound/index.ts';
import { fromLocalInput, refreshEvents, toLocalInput, whenLabel } from '../front/events.ts';
import type { Poll } from '../front/polls.ts';
import { poolsClient } from './api.ts';
import { attachRallyForm, eventFormsClient, startRallyCreate } from './event-forms.ts';
import { NEW_ROOM_FIELDS, NEW_TOURNAMENT, RoomFields, TournamentFields, tournamentRoom, type RoomFieldValues, type TournamentValues } from './RoomFields.tsx';

type EventChoice = 'tournament' | 'form';
const CHOICE_CARDS: readonly RadioCard<EventChoice>[] = [
  { value: 'tournament', label: 'Tournament' },
  { value: 'form', label: 'Form' },
];

type FormChoice = 'create' | 'load';
const FORM_CARDS: readonly RadioCard<FormChoice>[] = [
  { value: 'create', label: 'Create a form' },
  { value: 'load', label: 'Load a form' },
];

const FORM_ID = 'event-create-form';

/** The format, cube and preset lists the tournament's pickers offer; each stays null if it cannot load. */
function usePickerLists(): { formats: TableFormat[] | null; cubes: CubeSummary[] | null; presets: DraftPreset[] | null } {
  const [formats, setFormats] = useState<TableFormat[] | null>(null);
  const [cubes, setCubes] = useState<CubeSummary[] | null>(null);
  const [presets, setPresets] = useState<DraftPreset[] | null>(null);
  useEffect(() => {
    let live = true;
    // A list that cannot load leaves its picker on the room's default; the room can change it later.
    tablesClient()
      .formats()
      .then((f) => live && setFormats(f.filter((x) => x.source !== 'free')), () => undefined);
    poolsClient()
      .listCubes()
      .then((c) => live && setCubes(c), () => undefined);
    poolsClient()
      .listPresets()
      .then((p) => live && setPresets(p), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  return { formats, cubes, presets };
}

/** A window's pick as the pool a draft room takes: a preset or a cube by the id Rally keeps, or none this page knows. */
function poolOfPick(pick: string | null, presets: readonly DraftPreset[] | null, cubes: readonly CubeSummary[] | null): Pick<TournamentValues, 'cube' | 'preset'> | null {
  if (pick === null) return null;
  const preset = presets?.find((p) => p.id === pick);
  if (preset !== undefined) return { preset, cube: null };
  return cubes?.some((c) => c.id === pick) === true ? { preset: null, cube: pick } : null;
}

export function CreateEventDialog({ onClose, poll }: { onClose: () => void; poll?: Poll }) {
  const windows = poll?.windows ?? [];
  const [choice, setChoice] = useState<EventChoice>('tournament');
  const [title, setTitle] = useState(poll?.title.slice(0, ROOM_NAME_MAX) ?? '');
  const [chosen, setChosen] = useState<RallyWindow | null>(windows[0] ?? null);
  const [startsAt, setStartsAt] = useState(windows[0] === undefined ? '' : toLocalInput(windows[0].at));
  const [fields, setFields] = useState<RoomFieldValues>(windows.some((w) => w.pick !== null) ? { ...NEW_ROOM_FIELDS, gameType: 'draft' } : NEW_ROOM_FIELDS);
  const [settings, setSettings] = useState<TournamentValues>(NEW_TOURNAMENT);
  const [formChoice, setFormChoice] = useState<FormChoice>('create');
  const [formLink, setFormLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { formats, cubes, presets } = usePickerLists();

  // The chosen window's pick fills the pool once the lists that name it have loaded, and again on
  // each window chosen after; a pool picked by hand in between stays until then.
  const [filledFor, setFilledFor] = useState<RallyWindow | null>(null);
  useEffect(() => {
    if (chosen === null || chosen === filledFor || presets === null || cubes === null) return;
    setFilledFor(chosen);
    const pool = poolOfPick(chosen.pick, presets, cubes);
    if (pool !== null) setSettings((s) => ({ ...s, ...pool }));
  }, [chosen, filledFor, presets, cubes]);

  const chooseWindow = (at: string): void => {
    const next = windows.find((w) => w.at === at) ?? null;
    setChosen(next);
    if (next !== null) setStartsAt(toLocalInput(next.at));
  };

  const fail = (message: string): void => {
    playRole('ui.deny');
    setError(message);
  };

  const submitTournament = async (): Promise<void> => {
    const iso = fromLocalInput(startsAt);
    if (title.trim() === '' || iso === null) return fail(title.trim() === '' ? 'Title required.' : 'Start time required.');
    playRole('ui.select');
    setBusy(true);
    const outcome = await eventFormsClient().createTournament({ title: title.trim(), startsAt: iso, room: tournamentRoom(fields, settings), ...(poll === undefined ? {} : { formId: poll.id }) });
    setBusy(false);
    if (!outcome.ok) return fail(outcome.message);
    await refreshEvents();
    if (outcome.event.roomId !== null) navigate({ kind: 'room', roomId: outcome.event.roomId });
    else onClose();
  };

  const submitForm = async (): Promise<void> => {
    if (formChoice === 'create') {
      playRole('ui.select');
      startRallyCreate();
      return;
    }
    const formId = rallyFormIdOf(formLink);
    if (formId === null) return fail('Paste a Rally form link.');
    playRole('ui.select');
    setBusy(true);
    const outcome = await attachRallyForm(formId);
    setBusy(false);
    if (!outcome.ok) return fail(outcome.message);
    onClose();
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setError(null);
    void (choice === 'tournament' ? submitTournament() : submitForm());
  };

  const action = choice === 'tournament' ? 'Create event' : formChoice === 'create' ? 'Open Rally' : 'Load form';

  return (
    <Modal
      title="Create an event"
      testId="event-create"
      onClose={onClose}
      actions={
        <button type="submit" form={FORM_ID} className="lobby__go" data-testid="event-create-submit" disabled={busy}>
          {action}
        </button>
      }
    >
      <form id={FORM_ID} className="event-create" autoComplete="off" onSubmit={submit}>
        {poll === undefined && <RadioCards name="event-create-kind" label="Kind" options={CHOICE_CARDS} value={choice} onChange={setChoice} testId="event-create-kind" />}

        {choice === 'tournament' ? (
          <>
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

            {windows.length > 0 && (
              <>
                <span className="rooms__caption">Best times</span>
                <RadioCards
                  name="event-create-window"
                  label="Best times"
                  options={windows.map((w) => ({ value: w.at, label: `${whenLabel(w.at)} · ${String(w.free)} free` }))}
                  value={chosen?.at ?? null}
                  onChange={chooseWindow}
                  testId="event-create-window"
                />
              </>
            )}

            <label htmlFor="event-create-starts">Starts</label>
            <input id="event-create-starts" data-testid="event-create-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />

            <RoomFields idPrefix="event-create" value={fields} onChange={setFields} />
            <TournamentFields idPrefix="event-create" gameType={fields.gameType} value={settings} onChange={setSettings} formats={formats} cubes={cubes} presets={presets} />
          </>
        ) : (
          <>
            <RadioCards name="event-create-form-choice" label="Form" options={FORM_CARDS} value={formChoice} onChange={setFormChoice} testId="event-create-form-choice" />
            {formChoice === 'load' && (
              <>
                <label htmlFor="event-create-form-link">Rally link</label>
                <input
                  id="event-create-form-link"
                  data-testid="event-create-form-link"
                  value={formLink}
                  placeholder="https://hadoku.me/rally?e=…"
                  onChange={(e) => {
                    setFormLink(e.target.value);
                    setError(null);
                  }}
                />
              </>
            )}
          </>
        )}

        {error !== null && (
          <p className="ct-error rooms__error" role="alert" data-testid="event-create-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
