/*
 * The front page's Twitch-like hero (wave 77 §B,
 * `docs/planning/wave77-2026-10-27.md`; design rulings in
 * `docs/planning/front-page-and-replay-plan.md` R4).
 *
 * Lane A feeds this `pick`, straight off `GET /api/rooms`'s own `featured`
 * (`games/magic/server/src/play/featured.ts`'s `FeaturedPick`). With a pick, this
 * joins that match exactly the way opening `#/match/<id>` does — the same
 * transport, the same `LiveMatch` — and a socket with no seat lands on
 * `WATCHER_SEAT` by construction (`games/magic/server/src/play/socket.ts`), so there
 * is nothing here that claims one. With no pick, and only while `REPLAYS_ON`,
 * it falls back to a random recent replay, looping, with a REPLAY tag in place of
 * LIVE. With neither, it renders nothing and lane A's grid closes the gap.
 *
 * A replay is a file, not a connection (wave 81): it is fetched when the front page mounts, and the
 * card holds its place, drawn invisibly, until its first board and that board's art are ready
 * (`../replay/load.ts`). It never reads "Connecting…".
 *
 * The card plays the replay's dead air short (`skipIdle`, `../replay/player.ts`'s `IDLE_CUT_MS`): a
 * stretch with no frame and no pointer move plays three seconds, then the next thing happens.
 *
 * `LiveBoard` is rendered whole, the table its own table-fit lays out at
 * 1280×800 (`e2e/table-fit.spec.ts`'s own reference), scaled to the card by its
 * units as the UI-scale slider scales it, never by a transform — and never a line
 * changed in `LiveBoard.tsx` itself — and the card is a square
 * window onto it at the board's own proportions: its default capture region, the
 * bottom-left square, or a temporary one following the active player's cursor
 * (`./camera.ts`). The operator, 2026-10-29: *"i don't want to show the whole
 * zoomed out board, that's too hard to see anything. maybe we can focus on the
 * bottom left corner"*. The bottom player is the one whose turn it is — this card
 * alone asks for that (`followTurn`, `match.ts`'s `viewerPlayerIdOf`; a spectator's
 * own board stays put, the operator 2026-11-01) — so the card flips at every
 * turn change; the cursor is that player's, as the board draws it (live, the
 * relayed pointer; in a replay, the recorded one, `../replay/player.ts`).
 *
 * ## Paused
 *
 * A pause button on the title bar (operator, 2026-11-21, for a player bothered by the motion): the board
 * stands still — a replay's clock paused, a live match's transport holding what arrives (`./held.ts`), the
 * camera stopped, every animation in the frame paused where it is. Play goes on from there; a live match
 * catches up to the present in one step. Whether the card is drawn at all is the Display tab's "Front page
 * match" (`./LiveSlot.tsx`).
 *
 * ## Quiet — the match only, for this mount only
 *
 * `holdMatchQuiet` (`../sound/index.ts`) keeps the board's own moments, `g.*` roles and music off
 * while this is mounted; the front page's own `ui.*` cues still play, and the player's saved mute
 * is never touched.
 */

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Icon } from '@wolffm/themes';
import { uiLength } from '@hadoku/ui-shell/settings';
import { everyFrame } from '@hadoku/ui-shell/motion';

import { LiveBoard } from '../play/live/LiveBoard.tsx';
import {
  closeMatch,
  socketIoMatchTransport,
  startMatch,
  subscribe,
  viewerPlayerIdOf,
  type LiveMatch,
  type MatchTransport,
} from '../play/live/match.ts';
import type { Fetch } from '@hadoku/game-ui/http.ts';
import { holdMatchQuiet } from '@hadoku/game-ui/sound/index.ts';
import { featuredReplay, readyPlayer } from '../replay/load.ts';
import type { ReplayClock } from '../replay/player.ts';
import { ReplayBoard } from '../replay/ReplayBoard.tsx';
import { REPLAYS_ON } from '../replay/transport.ts';
import { heldTransport, type HeldTransport } from './held.ts';
import { BOARD_HEIGHT, BOARD_WIDTH, cameraConfigFromHash, defaultRegion, initialCamera, stepCamera, type CameraConfig, type Point } from '@hadoku/game-ui/front/camera.ts';
import './FeaturedMatch.css';

export interface FeaturedMatchProps {
  pick: { matchId: string; roomId: string } | null;
  /** Tests pass a stub transport for the LIVE case. Production leaves it unset and gets a real socket. */
  makeTransport?: () => MatchTransport;
  /** Tests pass a stub `fetch` for the no-pick replay fallback. Production leaves it unset. */
  fetchImpl?: Fetch;
  /** Fall back to a random recent replay when there is no pick. Defaults to `REPLAYS_ON`. */
  replayFallback?: boolean;
  /**
   * Told once per pick what came of it: `true` when a board is drawn (the live match's first view, or
   * the replay ready), `false` when there is nothing to show. The front page waits on it (`./gate.ts`).
   */
  onSettled?: (drawn: boolean) => void;
}

type Source = { kind: 'live'; match: LiveMatch; held: HeldTransport } | { kind: 'replay'; match: LiveMatch; clock: ReplayClock };

/**
 * The frame moved so `at` (board pixels) is the viewport's top-left. A translate only: the board is
 * scaled by its units (`--board-fit`, `FeaturedMatch.css`), never by a transform — every layer over
 * the board writes `left: …px` from `getBoundingClientRect()`, and under a `scale()` that px is scaled
 * twice (`../settings/ui-scale.ts`'s header), which drew the replay's cursor and held card toward the
 * top-left, by the portraits, while the hand they came from stood at the bottom.
 */
const placed = (at: Point, scale: number): string => `translate(${-at.x * scale}px, ${-at.y * scale}px)`;

/** The frame's own size and scale: the board's 1280×800 laid out at `scale` through its units. */
const frameStyle = (scale: number, config: CameraConfig): CSSProperties => ({ width: BOARD_WIDTH * scale, height: BOARD_HEIGHT * scale, transform: placed(defaultRegion(config), scale), ['--board-fit' as string]: scale });

/**
 * The camera's tunables for this viewer: `./camera.ts`'s `CAMERA`, with whatever the page's hash
 * overrides (`#cam=after:400,band:0.25,t95:900`), re-read when the hash changes.
 */
function useCameraConfig(): CameraConfig {
  const read = (): CameraConfig => cameraConfigFromHash(typeof location === 'undefined' ? '' : location.hash);
  const [config, setConfig] = useState(read);
  useEffect(() => {
    const onHash = (): void => setConfig(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return config;
}

/**
 * The camera, every animation frame: the active player's cursor as the board draws it (`.presence`,
 * `../play/live/presence.ts`), in board pixels, steps `./camera.ts`, and the frame is moved to the
 * region it captures. `data-capture-region` on the viewport says which.
 */
function useCamera(viewportRef: RefObject<HTMLDivElement | null>, frameRef: RefObject<HTMLDivElement | null>, match: LiveMatch | null, scale: number, config: CameraConfig, paused: boolean): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    const frame = frameRef.current;
    if (paused || viewport === null || frame === null || match === null || typeof requestAnimationFrame === 'undefined') return undefined;
    let camera = initialCamera(performance.now(), viewerPlayerIdOf(match), config);
    return everyFrame(() => {
      const box = frame.getBoundingClientRect();
      const tip = frame.querySelector('.presence')?.getBoundingClientRect() ?? null;
      const cursor = tip === null ? null : { x: (tip.left - box.left) / scale, y: (tip.top - box.top) / scale };
      camera = stepCamera(camera, performance.now(), cursor, viewerPlayerIdOf(match), config);
      return () => {
        frame.style.transform = placed(camera.at, scale);
        viewport.dataset.captureRegion = camera.region;
      };
    });
  }, [viewportRef, frameRef, match, scale, config, paused]);
}

/** Every animation running in `frame` paused where it stands while `paused`, and played on from there after. */
function useFrozen(frameRef: RefObject<HTMLDivElement | null>, paused: boolean): void {
  useEffect(() => {
    const frame = frameRef.current;
    if (!paused || frame === null || typeof frame.getAnimations !== 'function') return undefined;
    const stopped = frame.getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
    for (const a of stopped) a.pause();
    return () => {
      for (const a of stopped) if (a.playState === 'paused') a.play();
    };
  }, [frameRef, paused]);
}

/**
 * Scale a capture region (a `corner` square) to whatever square box `ref` measures.
 * `drawn`: the box is on the page (a replay's card holds its place without one until it is ready).
 */
function useFitScale(ref: RefObject<HTMLDivElement | null>, drawn: boolean, corner: number): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const measure = (): void => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setScale(Math.min(width, height) / corner);
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [ref, drawn, corner]);
  return scale;
}

/** `match.view`, re-read on every `LiveMatch` change — same subscription `LiveBoard.tsx` itself uses. */
function useMatchView(match: LiveMatch): LiveMatch['view'] {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(match, () => setTick((t) => t + 1)), [match]);
  return match.view;
}

function TitleBar({ source, watchHref, paused, onPause }: { source: Source; watchHref: string; paused: boolean; onPause: (paused: boolean) => void }) {
  const view = useMatchView(source.match);
  const names = view === null ? [] : view.players.map((p) => p.name);
  return (
    <div className="featured-match__title">
      <span className="featured-match__tag" data-testid="featured-match-tag">
        {source.kind === 'live' ? 'LIVE' : 'REPLAY'}
      </span>
      <span className="featured-match__players">{names.length === 0 ? 'Connecting…' : names.join(' vs ')}</span>
      {view !== null && view.turn > 0 && <span className="featured-match__turn">Turn {view.turn}</span>}
      <button
        type="button"
        className="featured-match__pause"
        aria-label={paused ? 'Play' : 'Pause'}
        aria-pressed={paused}
        data-testid="featured-match-pause"
        onClick={() => onPause(!paused)}
      >
        <Icon name={paused ? 'play' : 'pause'} size={uiLength('0.875rem')} />
      </button>
      <a className="featured-match__watch" href={watchHref} data-testid="featured-match-watch">
        Watch
      </a>
    </div>
  );
}

export function FeaturedMatch({ pick, makeTransport, fetchImpl, replayFallback = REPLAYS_ON, onSettled }: FeaturedMatchProps) {
  const [source, setSource] = useState<Source | 'loading' | null>(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const config = useCameraConfig();
  const [paused, setPaused] = useState(false);
  /** Read as a new source starts: a pause pressed before it holds it from its first frame. */
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  /** Bumped to join a live match again: a pause that held more than it would keep (`./held.ts`). */
  const [session, setSession] = useState(0);
  const scale = useFitScale(viewportRef, source !== null && source !== 'loading', config.corner);
  useCamera(viewportRef, frameRef, source === null || source === 'loading' ? null : source.match, scale, config, paused);
  useFrozen(frameRef, paused);

  const pause = (next: boolean): void => {
    setPaused(next);
    if (source === null || source === 'loading') return;
    if (source.kind === 'replay') {
      if (next) source.clock.pause();
      else source.clock.play();
      return;
    }
    if (next) source.held.hold();
    else if (!source.held.release()) setSession((n) => n + 1);
  };

  useEffect(() => holdMatchQuiet(), []);

  useEffect(() => {
    let live = true;
    let built: LiveMatch | null = null;
    let clock: ReplayClock | null = null;
    let stopWatching = (): void => undefined;
    let told = false;
    const settle = (drawn: boolean): void => {
      if (told || !live) return;
      told = true;
      settledRef.current?.(drawn);
    };
    setSource(null);

    if (pick !== null) {
      const held = heldTransport(makeTransport?.() ?? socketIoMatchTransport());
      if (pausedRef.current) held.hold();
      const match = startMatch({ matchId: pick.matchId, followTurn: true, transport: held.transport });
      built = match;
      setSource({ kind: 'live', match, held });
      // Drawn once the first view arrives: until then the card would read "Connecting…".
      stopWatching = subscribe(match, () => {
        if (match.view !== null) settle(true);
      });
    } else if (replayFallback) {
      setSource('loading');
      void featuredReplay(fetchImpl).then(async (data) => {
        if (!live) return;
        if (data === null) {
          setSource(null);
          settle(false);
          return;
        }
        const player = await readyPlayer(data, { loop: true, followTurn: true, skipIdle: true });
        built = player.match;
        clock = player.clock;
        if (!live) {
          closeMatch(player.match);
          player.clock.dispose();
          return;
        }
        if (!pausedRef.current) player.clock.play();
        setSource({ kind: 'replay', match: player.match, clock: player.clock });
        settle(true);
      });
    } else {
      settle(false);
    }

    return () => {
      live = false;
      stopWatching();
      if (built !== null) closeMatch(built);
      clock?.dispose();
    };
    // `makeTransport`/`fetchImpl` are intentionally not deps: they are test-only
    // stubs production never passes, and re-running on their identity would
    // rejoin on every render of a test that inlines one.
  }, [pick === null ? null : pick.matchId, session]);

  if (source === null) return null;
  // Held in place, never drawn: the slot keeps its size while the replay readies, and shows nothing.
  if (source === 'loading') return <div className="featured-match featured-match--loading" data-testid="featured-match-loading" aria-hidden="true" />;
  const watchHref = source.kind === 'live' ? `#/match/${encodeURIComponent(source.match.matchId)}` : `#/replay/${encodeURIComponent(source.match.matchId)}`;

  return (
    <div className="featured-match" data-testid="featured-match" data-paused={paused || undefined}>
      <TitleBar source={source} watchHref={watchHref} paused={paused} onPause={pause} />
      <div className="featured-match__viewport" ref={viewportRef}>
        <div className="featured-match__frame" ref={frameRef} style={frameStyle(scale, config)}>
          {source.kind === 'replay' ? <ReplayBoard match={source.match} clock={source.clock} /> : <LiveBoard match={source.match} roomId={null} />}
        </div>
      </div>
    </div>
  );
}
