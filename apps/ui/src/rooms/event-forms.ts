/*
 * Create event's two network halves (`apps/server/src/http/events.ts`): making a tournament, and
 * attaching a Rally form, either loaded by its link or made on Rally with a return trip back here
 * (WolffM/hadoku-cardtable#22). The trip's `ref` is kept in this tab's session storage, so only a
 * return this tab started attaches a form.
 */

import { AttachedFormSchema, EventViewSchema, rallyCreateUrl, rallyReturnOf, type AttachedForm, type EventView } from '@hadoku/shared';

import { apiUrl, bodyOf, sendJson, serverMessage, type Fetch } from '../http.ts';

export type CreateTournamentOutcome = { ok: true; event: EventView } | { ok: false; message: string };
export type AttachOutcome = { ok: true; form: AttachedForm } | { ok: false; message: string };

export interface CreateTournamentRequest {
  title: string;
  /** ISO date-time. */
  startsAt: string;
  room: Record<string, unknown>;
}

const defaultFetch: Fetch = (input, init) => fetch(input, init);

export function eventFormsClient(fetchImpl: Fetch = defaultFetch) {
  return {
    async createTournament(req: CreateTournamentRequest): Promise<CreateTournamentOutcome> {
      const res = await sendJson(apiUrl('events'), 'POST', req, fetchImpl);
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, message: res.status === 409 ? 'That pool cannot be drafted: pick another.' : serverMessage(body, res.status) };
      const event = EventViewSchema.safeParse(body);
      return event.success ? { ok: true, event: event.data } : { ok: false, message: 'the server sent an event this page cannot read' };
    },
    async attachForm(formId: string): Promise<AttachOutcome> {
      const res = await sendJson(apiUrl('events/forms'), 'POST', { formId }, fetchImpl);
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, message: serverMessage(body, res.status) };
      const form = AttachedFormSchema.safeParse(body);
      return form.success ? { ok: true, form: form.data } : { ok: false, message: 'the server sent a form this page cannot read' };
    },
  };
}
export type EventFormsClient = ReturnType<typeof eventFormsClient>;

const REF_KEY = 'cardtable.rally-ref';

/** Where this page is, without its query: what Rally returns to, with the new form added. */
function returnUrl(loc: Location): string {
  return `${loc.origin}${loc.pathname}${loc.hash}`;
}

/** "Create a form": remember the trip and send the organizer to Rally's builder. */
export function startRallyCreate(loc: Location = location, storage: Pick<Storage, 'setItem'> = sessionStorage): void {
  const ref = `ct-${crypto.randomUUID()}`;
  storage.setItem(REF_KEY, ref);
  loc.assign(rallyCreateUrl(ref, returnUrl(loc)));
}

/**
 * Rally's return trip, read once at boot: the page loses `?form=&ref=` either way, and the form
 * is attached when the ref is the one this tab sent. Answers what happened, for the caller's log.
 */
export async function finishRallyReturn(
  loc: Location = location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
  storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage,
  client: Pick<EventFormsClient, 'attachForm'> = eventFormsClient(),
): Promise<'none' | 'foreign' | AttachOutcome> {
  const trip = rallyReturnOf(loc.search);
  if (trip === null) return 'none';
  history.replaceState(history.state, '', returnUrl(loc));
  if (storage.getItem(REF_KEY) !== trip.ref) return 'foreign';
  storage.removeItem(REF_KEY);
  return client.attachForm(trip.formId);
}
