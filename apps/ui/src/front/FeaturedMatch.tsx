/*
 * The front page's Twitch-like hero (wave 77 §B,
 * `docs/planning/wave77-2026-10-27.md`; design rulings in
 * `docs/planning/front-page-and-replay-plan.md` R4).
 *
 * Lane A feeds this `pick`, straight off `GET /api/rooms`'s own `featured`
 * (`apps/server/src/play/featured.ts`'s `FeaturedPick`). With a pick, this
 * joins that match exactly the way opening `#/match/<id>` does — the same
 * transport, the same `LiveMatch` — and a socket with no seat lands on
 * `WATCHER_SEAT` by construction (`apps/server/src/play/socket.ts`), so there
 * is nothing here that claims one. With no pick, and only while `REPLAYS_ON`,
 * it falls back to the newest replay, looping, with a REPLAY tag in place of
 * LIVE. With neither, it renders nothing and lane A's grid closes the gap.
 *
 * `LiveBoard` is rendered whole, at the size its own table-fit expects
 * (`e2e/table-fit.spec.ts`'s own reference, 1280×800), inside a box scaled
 * down by a CSS `transform` to whatever this banner slot is — never
 * re-laid-out, and never a line changed in `LiveBoard.tsx` itself.
 *
 * ## Quiet — the match only, for this mount only
 *
 * `holdMatchQuiet` (`../sound/index.ts`) keeps the board's own moments, `g.*` roles and music off
 * while this is mounted; the front page's own `ui.*` cues still play, and the player's saved mute
 * is never touched.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

import { LiveBoard } from '../play/live/LiveBoard.tsx';
import {
  closeMatch,
  socketIoMatchTransport,
  startMatch,
  subscribe,
  type LiveMatch,
  type MatchTransport,
} from '../play/live/match.ts';
import type { Fetch } from '../http.ts';
import { holdMatchQuiet } from '../sound/index.ts';
import { createReplayTransport, type ReplayClock } from '../replay/replayTransport.ts';
import { fetchLatestReplay, fetchReplay, REPLAYS_ON } from '../replay/transport.ts';
import './FeaturedMatch.css';

export interface FeaturedMatchProps {
  pick: { matchId: string; roomId: string } | null;
  /** Tests pass a stub transport for the LIVE case. Production leaves it unset and gets a real socket. */
  makeTransport?: () => MatchTransport;
  /** Tests pass a stub `fetch` for the no-pick replay fallback. Production leaves it unset. */
  fetchImpl?: Fetch;
  /** Fall back to the newest replay when there is no pick. Defaults to `REPLAYS_ON`. */
  replayFallback?: boolean;
}

/** `e2e/table-fit.spec.ts`'s own reference room size — what `LiveBoard`'s table-fit is designed against. */
const BOARD_WIDTH = 1280;
const BOARD_HEIGHT = 800;

type Source = { kind: 'live'; match: LiveMatch } | { kind: 'replay'; match: LiveMatch };

/** Scale `BOARD_WIDTH × BOARD_HEIGHT` down to whatever box `ref` measures, preserving aspect ratio. */
function useFitScale(ref: RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const measure = (): void => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setScale(Math.min(width / BOARD_WIDTH, height / BOARD_HEIGHT));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return scale;
}

/** `match.view`, re-read on every `LiveMatch` change — same subscription `LiveBoard.tsx` itself uses. */
function useMatchView(match: LiveMatch): LiveMatch['view'] {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(match, () => setTick((t) => t + 1)), [match]);
  return match.view;
}

function TitleBar({ source, watchHref }: { source: Source; watchHref: string }) {
  const view = useMatchView(source.match);
  const names = view === null ? [] : view.players.map((p) => p.name);
  return (
    <div className="featured-match__title">
      <span className="featured-match__tag" data-testid="featured-match-tag">
        {source.kind === 'live' ? 'LIVE' : 'REPLAY'}
      </span>
      <span className="featured-match__players">{names.length === 0 ? 'Connecting…' : names.join(' vs ')}</span>
      {view !== null && <span className="featured-match__turn">Turn {view.turn}</span>}
      <a className="featured-match__watch" href={watchHref} data-testid="featured-match-watch">
        Watch
      </a>
    </div>
  );
}

export function FeaturedMatch({ pick, makeTransport, fetchImpl, replayFallback = REPLAYS_ON }: FeaturedMatchProps) {
  const [source, setSource] = useState<Source | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scale = useFitScale(viewportRef);

  useEffect(() => holdMatchQuiet(), []);

  useEffect(() => {
    let live = true;
    let built: LiveMatch | null = null;
    let clock: ReplayClock | null = null;
    setSource(null);

    if (pick !== null) {
      const match = startMatch({ matchId: pick.matchId, transport: makeTransport?.() ?? socketIoMatchTransport() });
      built = match;
      setSource({ kind: 'live', match });
    } else if (replayFallback) {
      void fetchLatestReplay(fetchImpl).then(
        (listing) => {
          if (!live || listing === null) return;
          void fetchReplay(listing.matchId, fetchImpl).then(
            (data) => {
              if (!live || data === null) return;
              const replay = createReplayTransport(data, { loop: true });
              const match = startMatch({ matchId: data.header.matchId, transport: replay.transport });
              built = match;
              clock = replay.clock;
              setSource({ kind: 'replay', match });
            },
            () => undefined,
          );
        },
        () => undefined,
      );
    }

    return () => {
      live = false;
      if (built !== null) closeMatch(built);
      clock?.dispose();
    };
    // `makeTransport`/`fetchImpl` are intentionally not deps: they are test-only
    // stubs production never passes, and re-running on their identity would
    // rejoin on every render of a test that inlines one.
  }, [pick === null ? null : pick.matchId]);

  if (source === null) return null;
  const watchHref = source.kind === 'live' ? `#/match/${encodeURIComponent(source.match.matchId)}` : `#/replay/${encodeURIComponent(source.match.matchId)}`;

  return (
    <div className="featured-match" data-testid="featured-match">
      <TitleBar source={source} watchHref={watchHref} />
      <div className="featured-match__viewport" ref={viewportRef}>
        <div className="featured-match__frame" style={{ width: BOARD_WIDTH, height: BOARD_HEIGHT, transform: `scale(${scale})` }}>
          <LiveBoard match={source.match} roomId={null} />
        </div>
      </div>
    </div>
  );
}
