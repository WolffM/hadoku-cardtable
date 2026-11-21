/**
 * The frame rate of a screen with no match: the front page and the draft (the operator, 2026-11-20: *"proper
 * perf/frame telemetry for the draft and front pages"*). The match's own watch (`play/live/frame-watch.ts`:
 * bad stretches, what was drawing in them, long frames attributed, a summary, the machine) runs unchanged;
 * only where its events go differs. A match sends them over its socket into the play log; these pages have
 * no match socket, so each event is a `perf` page event to `/api/client-events` (`PageEventSchema`), logged
 * as `svc: 'cardtable-client'` with the page and the user.
 *
 * `turn` and `phase` are the page's own clock and state, as a match's turn and phase are: a summary every few
 * turns, and the frames split by phase. The draft passes its pick count and whether a pack is waiting.
 */
import { useEffect, useRef } from 'react';

import type { ClientEvent } from '@hadoku/shared';
import { PAGE_EVENT_PATH, type PageEvent } from '@hadoku/shared';
import { apiUrl, sendJson } from '@hadoku/game-ui/http.ts';

import { watchFrames, type FrameWatch } from '../play/live/frame-watch.ts';

type Data = ClientEvent['data'];

/** Send one `perf` event of `page`: kept alive past a closing tab, as the watch's last summary is sent then. */
export function sendPagePerf(page: PageEvent['page'], data: Data): void {
  void sendJson(apiUrl(PAGE_EVENT_PATH), 'POST', { page, kind: 'perf', data } satisfies PageEvent, undefined, { keepalive: true }).catch((err: unknown) =>
    console.warn(`[${page}] could not report frames`, err),
  );
}

/** Watch this screen's frames while it is mounted and `on`; `facts` are read as a stretch opens, like a match's board. */
export function usePageFrames(page: PageEvent['page'], on: boolean, facts: () => Data, turn?: number, phase?: string): void {
  const read = useRef(facts);
  read.current = facts;
  const watch = useRef<FrameWatch | null>(null);
  useEffect(() => {
    if (!on) return undefined;
    const w = watchFrames({ report: (data) => sendPagePerf(page, data), board: () => ({ ...read.current(), ui: __HADOKU_UI_VERSION__ }) });
    watch.current = w;
    return () => {
      watch.current = null;
      w.dispose();
    };
  }, [page, on]);
  useEffect(() => {
    if (turn !== undefined && turn >= 0) watch.current?.noteTurn(turn);
  }, [turn]);
  useEffect(() => {
    if (phase !== undefined) watch.current?.notePhase(phase);
  }, [phase]);
}
