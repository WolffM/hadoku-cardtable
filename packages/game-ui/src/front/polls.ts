/*
 * The Upcoming card's Polls page: the open Rally forms attached to events (`GET /api/events/forms`,
 * `games/magic/server/src/http/events.ts`), each Rally's own summary of it plus who attached it
 * (`AttachedForm`). Its Open button goes to the form on Rally.
 */

import { useEffect, useState } from 'react';
import { AttachedFormSchema, type AttachedForm } from '@hadoku/platform-wire/events';

import { apiUrl, bodyOf, getJson, isRecord, serverMessage, type Fetch } from '../http.ts';
import { rereadWhileVisible } from '../visible.ts';

export type Poll = AttachedForm;

const defaultFetch: Fetch = (input, init) => fetch(input, init);

export function pollsClient(fetchImpl: Fetch = defaultFetch) {
  return {
    /** The open forms; one the page cannot read is skipped, never the whole list. A refused read throws. */
    async list(): Promise<Poll[]> {
      const res = await getJson(apiUrl('events/forms'), fetchImpl);
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(serverMessage(body, res.status));
      const forms = isRecord(body) && Array.isArray(body.forms) ? body.forms : [];
      return forms.flatMap((f) => {
        const poll = AttachedFormSchema.safeParse(f);
        return poll.success && poll.data.status === 'open' ? [poll.data] : [];
      });
    },
  };
}

/** Soonest to close first; a form with no closing time last. */
export function openPolls(polls: readonly Poll[]): Poll[] {
  const closes = (p: Poll): number => (p.closesAt === null ? Infinity : Date.parse(p.closesAt));
  return [...polls].sort((a, b) => closes(a) - closes(b));
}

/* ── the shared store ────────────────────────────────────────────────── */

type PollsClient = Pick<ReturnType<typeof pollsClient>, 'list'>;

/** `null` until the first read answers; the last good list after a failed read. */
let current: Poll[] | null = null;
const listeners = new Set<(polls: Poll[] | null) => void>();
let client: PollsClient = pollsClient();
/** Bumped by every read and every attach: only the newest read may set the list, so a read begun before an attach never drops its form. */
let generation = 0;

/** Tests swap the client (and reset the store) here. */
export function setPollsClient(next: PollsClient): void {
  client = next;
  current = null;
  generation += 1;
}

function publish(polls: Poll[]): void {
  current = polls;
  for (const listener of listeners) listener(current);
}

/** Tell `listener` the polls now and on every change; answers the unsubscribe. */
export function subscribePolls(listener: (polls: Poll[] | null) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/** Re-read the polls and tell every reader. A failed read keeps what they have; a read overtaken by a newer one changes nothing. */
export async function refreshPolls(): Promise<void> {
  const mine = ++generation;
  let next: Poll[];
  try {
    next = openPolls(await client.list());
  } catch {
    // Not reachable for a moment: the page keeps what it showed, or says there are none.
    if (current !== null || mine !== generation) return;
    next = [];
  }
  if (mine === generation) publish(next);
}

/**
 * A form just attached (Create event's Load form, or Rally's return trip): it shows at once, and
 * the list is re-read behind it, never left to the next tick.
 */
export async function pollAttached(form: Poll): Promise<void> {
  generation += 1;
  if (form.status === 'open') publish(openPolls([...(current ?? []).filter((p) => p.id !== form.id), form]));
  await refreshPolls();
}

/** How often a mounted reader re-reads the polls, so another organizer's form shows without a reload (as `./events.ts` does). */
const REFRESH_MS = 60_000;

/** The open polls, kept fresh while mounted and shown (`../visible.ts`): `null` until the first read answers. */
export function usePolls(): Poll[] | null {
  const [polls, setPolls] = useState<Poll[] | null>(current);
  useEffect(() => {
    const stop = subscribePolls(setPolls);
    const stopReread = rereadWhileVisible(() => void refreshPolls(), REFRESH_MS);
    return () => {
      stop();
      stopReread();
    };
  }, []);
  return polls;
}
