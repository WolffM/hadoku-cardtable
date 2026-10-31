/*
 * The Upcoming card's Polls page: the open Rally forms attached to events (`GET /api/events/forms`,
 * `apps/server/src/http/events.ts`), each Rally's own summary of it plus who attached it
 * (`AttachedForm`). Its Open button goes to the form on Rally.
 */

import { useEffect, useState } from 'react';
import { AttachedFormSchema, type AttachedForm } from '@hadoku/shared';

import { apiUrl, bodyOf, getJson, isRecord, serverMessage, type Fetch } from '../http.ts';

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

/** The open polls, read once on mount: `null` until the read answers, the empty list when it cannot. */
export function usePolls(fetchImpl?: Fetch): Poll[] | null {
  const [polls, setPolls] = useState<Poll[] | null>(null);
  useEffect(() => {
    let live = true;
    pollsClient(fetchImpl)
      .list()
      .then((list) => live && setPolls(openPolls(list)))
      .catch(() => {
        // Not reachable (or not yet served): the page says there are none rather than an error.
        if (live) setPolls([]);
      });
    return () => {
      live = false;
    };
  }, []);
  return polls;
}
