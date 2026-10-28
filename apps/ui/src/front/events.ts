/*
 * The front page's events (`/api/events`, `apps/server/src/http/events.ts`): one client, one store
 * the Upcoming card and the Create event dialog share, so an event made in one shows in the other
 * at once, and the pure pieces the card draws with.
 */

import { useEffect, useState } from 'react';
import { EventListSchema, EventViewSchema, type EventKind, type EventView } from '@hadoku/shared';

import { apiUrl, bodyOf, getJson, sendJson, serverMessage, type Fetch } from '../http.ts';

export const EVENT_KIND_LABELS: Readonly<Record<EventKind, string>> = {
  'draft-pod': 'Draft pod',
  'constructed-tournament': 'Constructed tournament',
  room: 'Room',
  casual: 'Casual',
};

/** How many the Upcoming card shows; the calendar shows every one. */
export const CARD_EVENTS = 3;

export type EventOutcome = { ok: true; event: EventView } | { ok: false; message: string };
export type EventDone = { ok: true } | { ok: false; message: string };

export interface CreateEventRequest {
  kind: EventKind;
  title: string;
  /** ISO date-time. */
  startsAt: string;
  /** A `room` event's Create room fields. */
  room?: Record<string, unknown>;
}

const defaultFetch: Fetch = (input, init) => fetch(input, init);

export function eventsClient(fetchImpl: Fetch = defaultFetch) {
  const answer = async (res: Response): Promise<EventOutcome> => {
    const body = await bodyOf(res);
    if (!res.ok) return { ok: false, message: serverMessage(body, res.status) };
    const event = EventViewSchema.safeParse(body);
    return event.success ? { ok: true, event: event.data } : { ok: false, message: 'the server sent an event this page cannot read' };
  };
  return {
    async list(): Promise<EventView[]> {
      const res = await getJson(apiUrl('events'), fetchImpl);
      if (!res.ok) throw new Error(serverMessage(await bodyOf(res), res.status));
      return EventListSchema.parse(await bodyOf(res)).events;
    },
    async create(req: CreateEventRequest): Promise<EventOutcome> {
      return answer(await sendJson(apiUrl('events'), 'POST', req, fetchImpl));
    },
    async update(id: string, change: { title?: string; startsAt?: string }): Promise<EventOutcome> {
      return answer(await sendJson(apiUrl(`events/${encodeURIComponent(id)}`), 'PATCH', change, fetchImpl));
    },
    async cancel(id: string): Promise<EventDone> {
      const res = await fetchImpl(apiUrl(`events/${encodeURIComponent(id)}`), { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } });
      return res.ok ? { ok: true } : { ok: false, message: serverMessage(await bodyOf(res), res.status) };
    },
  };
}
export type EventsClient = ReturnType<typeof eventsClient>;

/* ── the shared store ────────────────────────────────────────────────── */

/** `null` until the first read answers; the last good list after a failed read. */
let current: EventView[] | null = null;
const listeners = new Set<(events: EventView[] | null) => void>();
let client: EventsClient = eventsClient();

/** Tests swap the client (and reset the store) here. */
export function setEventsClient(next: EventsClient): void {
  client = next;
  current = null;
}

export function eventsApi(): EventsClient {
  return client;
}

/** Re-read the list and tell every reader. A failed read keeps what they have. */
export async function refreshEvents(): Promise<void> {
  try {
    current = await client.list();
  } catch {
    // Unreachable for a moment: the card keeps the list it has and the next refresh tries again.
    return;
  }
  for (const listener of listeners) listener(current);
}

/** How often a mounted reader re-reads the list, so another friend's event shows without a reload. */
const REFRESH_MS = 60_000;

/** The events, kept fresh while mounted, and the clock their countdowns read (ticking each half minute). */
export function useEvents(): { events: EventView[] | null; now: number } {
  const [events, setEvents] = useState<EventView[] | null>(current);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    listeners.add(setEvents);
    void refreshEvents();
    const reread = setInterval(() => void refreshEvents(), REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      listeners.delete(setEvents);
      clearInterval(reread);
      clearInterval(tick);
    };
  }, []);
  return { events, now };
}

/* ── what the card draws ─────────────────────────────────────────────── */

/** The next `n` events, soonest first: the server's order, cut. */
export function soonest(events: readonly EventView[], n: number = CARD_EVENTS): EventView[] {
  return [...events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, n);
}

/** A start as the viewer's own weekday, date and time: `Sat 1 Nov, 20:00`. */
export function whenLabel(startsAt: string, locale?: string): string {
  return new Date(startsAt).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** A `datetime-local` input's value for an ISO start, in the viewer's own zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` input's value as ISO, or null when it is empty or not a date. */
export function fromLocalInput(value: string): string | null {
  if (value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
