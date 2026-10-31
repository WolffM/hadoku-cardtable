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

/** How often a mounted reader re-reads the polls, so a form attached since shows without a reload (as `./events.ts` does). */
const REFRESH_MS = 60_000;

/** The open polls, kept fresh while mounted: `null` until the first read answers; a failed read keeps what it had, or none. */
export function usePolls(fetchImpl?: Fetch): Poll[] | null {
  const [polls, setPolls] = useState<Poll[] | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      pollsClient(fetchImpl)
        .list()
        .then((list) => live && setPolls(openPolls(list)))
        .catch(() => {
          // Not reachable for a moment: the page keeps what it showed, or says there are none.
          if (live) setPolls((had) => had ?? []);
        });
    };
    read();
    const reread = setInterval(read, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(reread);
    };
  }, []);
  return polls;
}
