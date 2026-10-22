/**
 * The pod: every seat around one table, who holds it, who has a pack to pick
 * from, which way the packs go, and the packs waiting in front of each seat.
 *
 * ## A circle, because the pass is a circle
 *
 * The operator, 2026-10-21: *"rather than showing a vertical table can we show a
 * visual circle instead? … display all the avatars and then show arrows between
 * them for who is passing to who."* So the seats sit around a ring in `SeatId`
 * order — the order the pack passes along, which is the content, not the
 * styling — and an arrow between each pair of neighbours points the way this
 * pack goes (`packages/draft/src/engine.ts`: left is seat s to s + 1). A seated
 * player's table is turned so their own seat is at the bottom; everyone else's
 * keeps seat 0 there, whichever seat they watch, so pressing a seat moves only
 * its outline and never the table (the operator, 2026-10-21). The arrow into the
 * seat in view — yours, or the one you watch — is drawn lit: where its next pack
 * comes from. The pack and pick counters are the circle's centre.
 *
 * ## The packs waiting in front of a seat
 *
 * Every seat picks at its own pace, so packs queue in front of a slow one
 * (`DraftSeatView.queueDepth`). They are drawn as a pile beside the seat, each
 * pack three card backs: the first four each in its own place, the rest on the
 * seat itself (`pack-queue.ts`). A pack that arrives hops along the arrow into
 * the seat; one the seat takes slides into it.
 *
 * ## What a seat may show
 *
 * A face, a name and its pile. Never *which* cards — the payload does not carry
 * them, and this component could not leak them if it tried. See
 * `draft/types.ts`. The face is the seat's watchparty character (`avatarId`: a
 * member's own, an AI seat's persona), or our own mark for a seat with none.
 *
 * ## A spectator's seats are whose draft to watch
 *
 * A person holding no seat watches one drafter's pack and picks (the
 * operator, 2026-10-20). Their circle marks the seat they watch, and pressing
 * another seat watches that one instead.
 *
 * ## HELD, which is the fourth thing a seat can be
 *
 * A seat whose player dropped is released with `{ hold: true }` and reserved
 * against everyone else for a TTL, so they come back to the same chair
 * (`apps/server/src/room/draftRooms.ts`). `draft/seatStatus.ts` derives the
 * difference from an empty chair and says plainly what it is derived FROM,
 * because the envelope carries no reservation field.
 */

import { forwardRef, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';

import { seatStatus, SEAT_HELD_NOTE } from '../draft/seatStatus.ts';
import type { DraftView } from '../draft/types.ts';
import { isWaiting } from '../draft/types.ts';
import { Avatar } from './Avatar.tsx';
import { DraftCounters } from './DraftCounters.tsx';
import {
  CLEAR,
  FLIGHT_MAX_MS,
  FLIGHT_MIN_MS,
  IN_VIEW,
  LEAVE_MS,
  MS_PER_PX,
  PACK,
  REACT_MS,
  STAGGER_MS,
  UNMEASURED,
  fixed,
  packSlot,
  pileRoom,
  rad,
  ring,
  type PackSlot,
} from './pack-queue.ts';
import './card-back.css';
import './spectate.css';

/** Where a pack is drawn: its centre in box units and its turn. */
interface Pose {
  x: number;
  y: number;
  angle: number;
  pose: PackSlot['pose'];
  depth: number;
  /** Where along the ring an arrival's hop ends before it settles into this pose. */
  s: number;
}

interface Leaving {
  key: string;
  from: Pose;
  to: { x: number; y: number };
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const round = (_: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

/**
 * The seats' name lines, a face's half width with its ring, the counters and
 * the panel's padding box, in the ring's box units — what the piles must clear,
 * and where they may reach.
 */
function useMeasures(ref: RefObject<HTMLDivElement | null>, key: string) {
  const [measures, setMeasures] = useState<{ names: Box[]; centre: Box; faceHalf: number; bounds: Box } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const panel = el?.closest<HTMLElement>('.seats');
    if (el === null || el === undefined || panel === null || panel === undefined) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      const face = el.querySelector('.seatbar__face')?.getBoundingClientRect();
      const centre = el.querySelector('.podcircle__centre')?.getBoundingClientRect();
      if (b.width === 0 || face === undefined || centre === undefined) return;
      const u = b.width / 100;
      const toBox = (r: { left: number; top: number; right: number; bottom: number }): Box => ({
        left: (r.left - b.left) / u,
        top: (r.top - b.top) / u,
        right: (r.right - b.left) / u,
        bottom: (r.bottom - b.top) / u,
      });
      // The panel inside its border: its padding is room a pile may use.
      const p = panel.getBoundingClientRect();
      const inner = { left: p.left + panel.clientLeft, top: p.top + panel.clientTop, right: p.left + panel.clientLeft + panel.clientWidth, bottom: p.top + panel.clientTop + panel.clientHeight };
      const next = {
        names: [...el.querySelectorAll('.seatbar__label')].map((l) => toBox(l.getBoundingClientRect())),
        centre: toBox(centre),
        // The face's ring is 2px outside it (`spectate.css`), at the face's own 40px scale.
        faceHalf: ((face.width / 2) * (44 / 40)) / u,
        bounds: toBox(inner),
      };
      setMeasures((was) => (was !== null && JSON.stringify(was, round) === JSON.stringify(next, round) ? was : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const part of el.querySelectorAll('.seatbar__label, .podcircle__centre')) observer.observe(part);
    return () => observer.disconnect();
  }, [ref, key]);
  return measures;
}

export function SeatBar({ view, onWatch }: { view: DraftView; onWatch?: (seatId: number) => void }) {
  const viewerSeatId = view.viewer.kind === 'seat' ? view.viewer.seatId : null;
  const watchedId = view.viewer.kind === 'watcher' ? view.viewer.seatId : null;
  const watchable = watchedId !== null && onWatch !== undefined;
  const seats = view.seats;
  const n = seats.length;
  const bottom = Math.max(0, seats.findIndex((s) => s.id === (viewerSeatId ?? 0)));
  const inView = seats.findIndex((s) => s.id === (viewerSeatId ?? watchedId));
  const left = view.passDirection === 'left';
  /** Which way along the ring the giver is from a seat: left passes come from lower s. */
  const giverSide = left ? -1 : 1;
  /** The most that can wait: everyone else's pack. */
  const cap = Math.max(0, n - 1);
  const queueKey = seats.map((s) => Math.min(cap, s.queueDepth)).join(',');
  const queue = useMemo(() => queueKey.split(',').map(Number), [queueKey]);
  const depthOf = (at: number): number => queue[at] ?? 0;

  const boxRef = useRef<HTMLDivElement>(null);
  const measures = useMeasures(boxRef, String(n));
  const track = ring();
  const pct = (p: { x: number; y: number }) => ({ left: `${fixed(p.x)}%`, top: `${fixed(p.y)}%` });
  /** Clockwise from the bottom, in seat order, evenly by distance. */
  const seatS = (at: number): number => (((at - bottom + n) % n) * track.length) / n;
  const giverOf = (at: number): number => (at + giverSide + n) % n;
  const head = (at: number): number => seatS(at) + giverSide * CLEAR;
  /** Along the arrow into seat `at`: `a` pack widths back from its head. */
  const onArrow = (at: number, a: number): number => head(at) + giverSide * a * PACK;

  const arcs = seats.map((_, at) => {
    const next = (at + 1) % n;
    const s0 = seatS(at) + CLEAR;
    let s1 = seatS(next) - CLEAR;
    if (s1 < s0) s1 += track.length;
    const points = left ? track.points(s0, s1) : track.points(s1, s0);
    const intoView = left ? next === inView : at === inView;
    return { d: track.path(points), points, intoView };
  });

  /** Which side of seat `at`'s face its arrow arrives on; straight above or below it, its inward side. */
  const sideOf = (at: number): 1 | -1 => {
    const face = track.at(seatS(at));
    const dx = track.at(onArrow(at, 0)).x - face.x;
    return Math.abs(dx) > 1 ? (Math.sign(dx) as 1 | -1) : face.x < 50 ? 1 : -1;
  };

  // The piles need the names' and the counters' own boxes: measured, then the room is searched once per table.
  const piles = useMemo(() => {
    if (measures === null || n < 2) return null;
    return pileRoom({
      faces: seats.map((_, at) => track.at(seatS(at))),
      sides: seats.map((_, at) => sideOf(at)),
      heads: seats.map((_, at) => track.at(onArrow(at, 0))),
      faceHalf: measures.faceHalf,
      names: measures.names,
      centre: measures.centre,
      arrows: arcs.map((arc) => ({ points: arc.points, width: arc.intoView ? 1.2 : 0.9 })),
      bounds: measures.bounds,
    });
    // The room is the table's: seats, direction, the lit arrow and the measured boxes.
  }, [measures, n, bottom, left, inView]);

  /**
   * Where pack `i` of `depth` at seat `at` is drawn, as one centre and one turn in
   * the box, so moving from any pose to any other is one transition of left,
   * top and rotate.
   */
  const poseOf = (at: number, i: number, depth: number): Pose => {
    const face = track.at(seatS(at));
    const sx = sideOf(at);
    const slot = packSlot(i, depth, piles?.[at] ?? UNMEASURED);
    return { x: face.x + slot.x * sx * PACK, y: face.y + slot.y * PACK, angle: slot.r * sx, pose: slot.pose, depth, s: onArrow(at, 0) };
  };
  const tailOf = (at: number): number => seatS(giverOf(at)) - giverSide * CLEAR;

  // One motion rule for every change of pose. A pack that arrives hops from the
  // giver's end along its arrow and ends exactly in its pose. A pack whose pose
  // changes because the depth changed moves there (a transition), after the new
  // packs have landed when the pile grew, at once when it shrank, one after
  // another so the shove reads as a reaction. A pack that leaves slides into its
  // seat and fades. Nothing is ever removed or re-placed in one frame.
  const previous = useRef<readonly number[] | null>(null);
  const angles = useRef<Map<string, number>>(new Map());
  const lastPoses = useRef<Map<string, Pose>>(new Map());
  const elements = useRef<Map<string, HTMLElement>>(new Map());
  const unitPx = useRef(2.64);
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  const before = previous.current;
  const moving = before !== null && !reducedMotion();

  /** A turn as close as possible to `near`, so no pack ever spins the long way round. */
  const closest = (angle: number, near: number | undefined): number =>
    near === undefined ? angle : angle + 360 * Math.round((near - angle) / 360);

  /** The hop: points along the arrow from the giver's end, then the pose itself. */
  const hop = (at: number, pose: Pose) => {
    const from = tailOf(at);
    let to = pose.s;
    // Unwrapped so the hop runs the short way, along the arrow.
    if (Math.abs(to - from) > track.length / 2) to += Math.sign(from - to) * track.length;
    const steps = 8;
    const points = Array.from({ length: steps + 1 }, (_, k) => {
      const p = track.at(from + ((to - from) * k) / steps);
      // A little hop off the arrow, inward, highest half way.
      const lift = Math.sin((Math.PI * k) / steps) * 1.4 * PACK;
      return { x: p.x - lift * Math.sin(rad(p.heading)), y: p.y + lift * Math.cos(rad(p.heading)), angle: p.heading + 180 };
    });
    points.push({ x: pose.x, y: pose.y, angle: pose.angle });
    for (let k = points.length - 2; k >= 0; k--) points[k]!.angle = closest(points[k]!.angle, points[k + 1]!.angle);
    const lengths = points.map((p, k) => (k === 0 ? 0 : Math.hypot(p.x - points[k - 1]!.x, p.y - points[k - 1]!.y)));
    const total = lengths.reduce((a, b) => a + b, 0) || 1;
    let run = 0;
    const frames = points.map((p, k) => {
      run += lengths[k]!;
      return { offset: run / total, opacity: k === 0 ? 0 : 1, ...pct(p), rotate: `${fixed(p.angle)}deg` };
    });
    const duration = Math.min(FLIGHT_MAX_MS, Math.max(FLIGHT_MIN_MS, total * unitPx.current * MS_PER_PX));
    return { frames, duration };
  };

  const poses = new Map<string, Pose>();
  const delays = new Map<string, number>();
  const arrivals: { key: string; at: number; delay: number }[] = [];
  seats.forEach((seat, at) => {
    const depth = depthOf(at);
    const was = before === null ? depth : (before[at] ?? 0);
    let landed = 0;
    for (let i = was; i < depth && moving; i++) {
      const key = `${seat.id}:${i}`;
      const delay = (i - was) * STAGGER_MS;
      arrivals.push({ key, at, delay });
      landed = Math.max(landed, delay + hop(at, poseOf(at, i, depth)).duration);
    }
    for (let i = 0; i < depth; i++) {
      const key = `${seat.id}:${i}`;
      const pose = poseOf(at, i, depth);
      pose.angle = closest(pose.angle, angles.current.get(key));
      poses.set(key, pose);
      if (i < Math.min(was, depth)) delays.set(key, (depth > was ? landed : 0) + i * REACT_MS);
    }
  });

  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = queue;
    const width = boxRef.current?.getBoundingClientRect().width;
    if (width) unitPx.current = width / 100;
    const gone: Leaving[] = [];
    if (was !== null && !reducedMotion()) {
      for (const { key, at, delay } of arrivals) {
        const el = elements.current.get(key);
        const pose = poses.get(key);
        if (el === undefined || pose === undefined || typeof el.animate !== 'function') continue;
        const { frames, duration } = hop(at, pose);
        el.animate(frames, { duration, delay, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'backwards' });
      }
      seats.forEach((seat, at) => {
        const seatAt = track.at(seatS(at));
        for (let i = depthOf(at); i < (was[at] ?? 0); i++) {
          const from = lastPoses.current.get(`${seat.id}:${i}`);
          if (from) gone.push({ key: `${seat.id}:${i}:${performance.now()}`, from, to: seatAt });
        }
      });
    }
    for (const [key, pose] of poses) angles.current.set(key, pose.angle);
    lastPoses.current = poses;
    if (gone.length > 0) setLeaving((all) => [...all, ...gone]);
    // Keyed on the queue: `arrivals` and `poses` are this render's.
  }, [queue]);

  return (
    <section className="seats" data-testid="seat-bar" aria-label="Seats">
      <div className="podcircle" ref={boxRef}>
        <svg
          className="podcircle__ring"
          viewBox="0 0 100 100"
          role="img"
          aria-label={`passing ${view.passDirection}`}
          data-testid="pass-direction"
          data-direction={view.passDirection}
        >
          <defs>
            <marker id="podcircle-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path className="podcircle__head" d="M1 1 L8 5 L1 9" />
            </marker>
            <marker id="podcircle-head-in" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path className="podcircle__head podcircle__head--in" d="M1 1 L8 5 L1 9" />
            </marker>
          </defs>
          {n > 1 && arcs.map((arc, at) => <path key={at} className={arc.intoView ? 'podcircle__arc podcircle__arc--in' : 'podcircle__arc'} d={arc.d} />)}
        </svg>

        {n > 1 && measures !== null && (
          <div className="packq" aria-hidden="true">
            {[...poses].map(([key, pose]) => {
              const [seatId, i] = key.split(':');
              return (
                <Pack
                  key={key}
                  testId={`seat-${seatId}-pack-${i}`}
                  pose={pose}
                  place={pct(pose)}
                  delay={delays.get(key) ?? 0}
                  ref={(el) => {
                    if (el) elements.current.set(key, el);
                    else elements.current.delete(key);
                  }}
                />
              );
            })}
            {leaving.map((l) => (
              <Leaver key={l.key} from={l.from} place={pct} to={l.to} onDone={() => setLeaving((all) => all.filter((x) => x.key !== l.key))} />
            ))}
          </div>
        )}

        {/* After the piles, so a pack that reaches the middle passes under the counters. */}
        <div className="podcircle__centre">
          <DraftCounters view={view} />
        </div>

        <ol className="podcircle__seats">
          {seats.map((seat, at) => {
            const waiting = isWaiting(view, seat.id);
            const isYou = seat.id === viewerSeatId;
            const watched = seat.id === watchedId;
            const status = seatStatus(seat);
            const held = status === 'held';
            const depth = depthOf(at);
            return (
              <li
                key={seat.id}
                className={[
                  'seatbar__seat',
                  waiting ? 'seatbar__seat--waiting' : 'seatbar__seat--done',
                  isYou ? 'seatbar__seat--you' : '',
                  watched ? 'seatbar__seat--watched' : '',
                  held ? 'seatbar__seat--held' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={pct(track.at(seatS(at)))}
                data-testid={`seat-${seat.id}`}
                data-waiting={waiting ? 'true' : 'false'}
                data-occupant={status}
                data-queue={depth}
                data-watched={watched ? '' : undefined}
                data-swamped={depth > IN_VIEW ? '' : undefined}
              >
                {watchable && !watched && (
                  <button
                    type="button"
                    className="seatbar__watch"
                    data-testid={`seat-${seat.id}-watch`}
                    aria-label={`Watch ${seat.displayName}`}
                    onClick={() => onWatch(seat.id)}
                  />
                )}
                <span className="seatbar__face">
                  <Avatar id={seat.avatarId} fallback="mark" />
                </span>
                <span className="seatbar__label">
                  {/* Your own seat is named like every other; the lit ring at the bottom marks it as yours. */}
                  <span className="seatbar__name" title={seat.displayName}>
                    {status === 'empty' ? <em>empty</em> : seat.displayName}
                  </span>
                  {held && (
                    <span className="seatbar__held" data-testid={`seat-${seat.id}-held`} title={SEAT_HELD_NOTE}>
                      held
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/** The three backs a pack is drawn as, nudged apart like a squared-up mini-deck. */
const STACK = [-1, 0, 1];

function Backs() {
  return STACK.map((k) => <span key={k} className="card-back packq__card" style={{ '--k': k } as CSSProperties} />);
}

/** One waiting pack: placed by its centre and turn; its pose's shake lives on the stack inside. */
const Pack = forwardRef<HTMLSpanElement, { pose: Pose; place: { left: string; top: string }; delay: number; testId: string }>(function Pack(
  { pose, place, delay, testId },
  ref,
) {
  return (
    <span
      ref={ref}
      className="packq__pack"
      data-testid={testId}
      style={{ left: place.left, top: place.top, rotate: `${fixed(pose.angle)}deg`, '--delay': `${delay}ms` } as CSSProperties}
    >
      <span className="packq__stack" data-pose={pose.pose} style={{ '--shake': Math.max(0, pose.depth - 1) } as CSSProperties}>
        <Backs />
      </span>
    </span>
  );
});

/** A pack that left its pile: from its last pose into its seat, fading. */
function Leaver({
  from,
  to,
  place,
  onDone,
}: {
  from: Pose;
  to: { x: number; y: number };
  place: (p: { x: number; y: number }) => { left: string; top: string };
  onDone: () => void;
}) {
  const el = useRef<HTMLSpanElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const start = place(from);
  useLayoutEffect(() => {
    const node = el.current;
    if (node === null || typeof node.animate !== 'function') {
      done.current();
      return;
    }
    const end = place(to);
    const anim = node.animate(
      [
        { ...start, rotate: `${fixed(from.angle)}deg`, opacity: 1, scale: '1' },
        { ...end, rotate: `${fixed(from.angle)}deg`, opacity: 0, scale: '0.6' },
      ],
      { duration: LEAVE_MS, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' },
    );
    anim.onfinish = () => done.current();
    return () => anim.cancel();
    // Runs once: a leaving pack's path is fixed when it leaves.
  }, []);
  return (
    <span ref={el} className="packq__pack packq__leaving" style={{ left: start.left, top: start.top, rotate: `${fixed(from.angle)}deg` } as CSSProperties}>
      <span className="packq__stack">
        <Backs />
      </span>
    </span>
  );
}
