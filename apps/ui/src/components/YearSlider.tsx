/*
 * A year chosen on a line, oldest on the left: drag the year along it, press anywhere on it, or
 * nudge it one year with ‹ and › or the arrow keys (the operator, 2026-11-02, of Classic's era
 * dropdown: "lets get rid of the dropdown and just make it a left-to-right slider you can drag or
 * click arrows on the left and right of it to nudge it one year in either direction").
 *
 * The line is a ruler of years: a tick for every year from the first stop to the last, taller every
 * five years and tallest every ten, the fives, tens and ends labelled ("it would be nice to have 5yr and
 * 10yr intervals have slightly different tick marks so it's easier to read the whole line"). A year
 * with no stop is drawn muted and is never chosen: the slider snaps past it. The pill reads the
 * year it is on.
 *
 * A held pill follows the pointer, between years too, and reads the year nearest it; let go, it
 * settles on that year in one short glide. It never steps from tick to tick under a moving pointer
 * (the operator saw "a bit of 'jitter' for where the year placement went": a pill that hopped a
 * year at a time behind the pointer, measured frame by frame in a real browser). The line takes the
 * pointer itself; the native range under it is the slider for keys and assistive tech (its role,
 * its value, its arrows, Home and End).
 *
 * Moving it is not choosing. A drag chooses once, on release, and a run of nudges once it has rested
 * for `SETTLE_MS`, so scrubbing across twenty years asks for one year's list, not twenty.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

import './YearSlider.css';

export interface YearStop {
  /** What choosing it sends. */
  id: string;
  /** What the thumb reads on it. */
  label: string;
  /** The year it stands for; null for the one stop that is not a year ("All"), which sits left of the oldest. */
  year: number | null;
}

/** How long a run of nudges (keys, ‹ ›) rests before it chooses where it stopped. */
export const SETTLE_MS = 250;

export type TickRank = 'year' | 'half' | 'decade' | 'other';

export interface Tick {
  /** Its place on the line: a year, or one before the first for the stop that is not one. */
  at: number;
  /** Which stop it marks, or -1 for a year with none. */
  stop: number;
  rank: TickRank;
  /** Drawn by it: the tens, the fives, an unlabelled end, and the stop that is not a year. */
  label: string | null;
}

export interface YearLine {
  min: number;
  max: number;
  /** Each stop's place, in `stops` order. */
  places: number[];
  ticks: Tick[];
}

/** The ruler `stops` lie on: a tick for every year between the first and the last. */
export function yearLine(stops: readonly YearStop[]): YearLine {
  const years = stops.flatMap((s) => (s.year === null ? [] : [s.year]));
  const first = years.length > 0 ? Math.min(...years) : 0;
  const places = stops.map((s) => s.year ?? first - 1);
  const min = places.length > 0 ? Math.min(...places) : 0;
  const max = places.length > 0 ? Math.max(...places) : 0;
  const ticks: Tick[] = [];
  for (let at = min; at <= max; at += 1) {
    const stop = places.indexOf(at);
    if (stop >= 0 && stops[stop]!.year === null) {
      ticks.push({ at, stop, rank: 'other', label: stops[stop]!.label });
      continue;
    }
    const rank: TickRank = at % 10 === 0 ? 'decade' : at % 5 === 0 ? 'half' : 'year';
    ticks.push({ at, stop, rank, label: rank === 'year' ? null : String(at) });
  }
  // The stop that is not a year names itself in a word ("All", "Random"), wider than a year: a year's label within two years of it gives way.
  const word = ticks.find((t) => t.rank === 'other');
  if (word !== undefined) for (const t of ticks) if (t !== word && Math.abs(t.at - word.at) <= 2) t.label = null;
  // Each end says where the line starts and stops, unless a label already stands within two years of it.
  for (const end of [ticks.at(0), ticks.at(-1)]) {
    if (end !== undefined && end.label === null && !ticks.some((t) => t.label !== null && Math.abs(t.at - end.at) <= 2)) end.label = String(end.at);
  }
  return { min, max, places, ticks };
}

/** Where a place sits along the line, 0 (left) to 1 (right); a line of one place puts it in the middle. */
export function lineFraction(at: number, line: Pick<YearLine, 'min' | 'max'>): number {
  return line.max > line.min ? (at - line.min) / (line.max - line.min) : 0.5;
}

/** The stop nearest a place on the line, among those `keep` allows (the first of two as near); -1 for none. */
export function closest(places: readonly number[], value: number, keep: (place: number) => boolean = () => true): number {
  let best = -1;
  places.forEach((p, i) => {
    if (keep(p) && (best < 0 || Math.abs(p - value) < Math.abs(places[best]! - value))) best = i;
  });
  return best;
}

/**
 * The stop a value on the line lands on: the nearest one, and on a year with none, the next one
 * the way it was moving from `from` (a key press past a gap carries on to the next year that has one).
 */
export function snapped(places: readonly number[], value: number, from: number): number {
  const exact = places.indexOf(value);
  if (exact >= 0) return exact;
  const ahead = value > from ? closest(places, value, (p) => p > value) : value < from ? closest(places, value, (p) => p < value) : -1;
  return ahead >= 0 ? ahead : closest(places, value);
}

/**
 * The stop a nudge lands on: one stop from `at` towards `by`'s sign, kept on the line. From no stop
 * at all (`at` below 0, nothing chosen), either way starts at the newest.
 */
export function nudged(at: number, by: -1 | 1, count: number): number {
  if (count === 0) return -1;
  if (at < 0) return count - 1;
  return Math.min(count - 1, Math.max(0, at + by));
}

/**
 * A press held on the line: where the pill travels, measured as it pressed, where on the pill it took
 * hold, and the stop the pill is over.
 */
interface Hold {
  pointer: number;
  /** The pill's centre on the line's first place, in px, and how far it travels to the last. */
  start: number;
  span: number;
  /** How far right of the pill's centre the press took it: 0 when it pressed the line, not the pill. */
  grip: number;
  stop: number;
  release: () => void;
}

export function YearSlider({
  stops,
  value,
  label,
  disabled = false,
  busy = false,
  testId,
  onChange,
}: {
  /** Oldest first: left to right. */
  stops: readonly YearStop[];
  /** The chosen stop's id; null, or one not among `stops`, when none of them is chosen. */
  value: string | null;
  /** The slider's name for assistive tech; nothing draws it. */
  label: string;
  disabled?: boolean;
  /** The chosen stop has been asked for and not yet answered: it is drawn as chosen meanwhile. */
  busy?: boolean;
  testId: string;
  onChange: (id: string) => void;
}) {
  const line = useMemo(() => yearLine(stops), [stops]);
  const chosen = value === null ? -1 : stops.findIndex((s) => s.id === value);
  /** The stop a held press or a run of nudges has the pill over, until it chooses. */
  const [moving, setMoving] = useState<number | null>(null);
  /** Where a held pill is, between years too, once its pointer has moved. */
  const [glide, setGlide] = useState<number | null>(null);
  const shown = moving ?? chosen;
  const last = stops.length - 1;
  /** The stop the input stands on: the newest while nothing is chosen, and the pill is not drawn. */
  const at = shown < 0 ? last : shown;
  const input = useRef<HTMLInputElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const hold = useRef<Hold | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A settle that fires after a re-render reads the room as it is then, not as it was when it began.
  const latest = useRef({ stops, chosen, onChange });
  latest.current = { stops, chosen, onChange };
  const unhold = (): void => {
    hold.current?.release();
    hold.current = null;
  };
  useEffect(
    () => () => {
      clearTimeout(settle.current);
      unhold();
    },
    [],
  );

  const choose = (to: number): void => {
    clearTimeout(settle.current);
    setMoving(null);
    const now = latest.current;
    const stop = now.stops[to];
    if (stop !== undefined && to !== now.chosen) now.onChange(stop.id);
  };
  const nudge = (to: number): void => {
    if (to < 0) return;
    setMoving(to);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => choose(to), SETTLE_MS);
  };
  /** The stop a key (or anything else that sets the range) lands on, moving from where the pill stands. */
  const landing = (range: HTMLInputElement): number => snapped(line.places, range.valueAsNumber, line.places[at] ?? range.valueAsNumber);
  /** The place on the line a held pointer at `x` puts the pill's centre. */
  const placeAt = (x: number, h: Hold): number => {
    const fraction = h.span > 0 ? Math.min(1, Math.max(0, (x - h.grip - h.start) / h.span)) : 0.5;
    return line.min + fraction * (line.max - line.min);
  };
  const press = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || hold.current !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // The line is no field: a press keeps the slider focused for its keys, and selects no text.
    e.preventDefault();
    input.current?.focus({ preventScroll: true });
    clearTimeout(settle.current);
    const track = e.currentTarget.getBoundingClientRect();
    const width = pill.current?.getBoundingClientRect().width ?? 0;
    const start = track.left + width / 2;
    const span = track.width - width;
    const centre = start + span * lineFraction(line.places[at]!, line);
    const onPill = shown >= 0 && Math.abs(e.clientX - centre) <= width / 2;
    const h: Hold = { pointer: e.pointerId, start, span, grip: onPill ? e.clientX - centre : 0, stop: at, release: () => undefined };
    // A press on the line, not the pill, takes the pill straight to the year under it.
    if (!onPill) {
      h.stop = closest(line.places, placeAt(e.clientX, h));
      setMoving(h.stop);
    }
    const mine = (ev: PointerEvent): boolean => ev.pointerId === h.pointer;
    const move = (ev: PointerEvent): void => {
      if (!mine(ev)) return;
      const place = placeAt(ev.clientX, h);
      h.stop = closest(line.places, place);
      setGlide(place);
      setMoving(h.stop);
    };
    const up = (ev: PointerEvent): void => {
      if (!mine(ev)) return;
      unhold();
      setGlide(null);
      choose(h.stop);
    };
    // The page took the press for a scroll: nothing is chosen, and the pill goes back.
    const cancel = (ev: PointerEvent): void => {
      if (!mine(ev)) return;
      unhold();
      setGlide(null);
      setMoving(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    h.release = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    hold.current = h;
  };

  if (stops.length === 0) return null;
  const position = { '--at': lineFraction(glide ?? line.places[at]!, line) } as CSSProperties;
  return (
    <div
      className="year-slider"
      data-testid={testId}
      data-value={chosen < 0 ? '' : stops[chosen]!.id}
      data-empty={shown < 0 || undefined}
      data-gliding={glide !== null || undefined}
      aria-busy={busy || undefined}
    >
      <button
        type="button"
        className="year-slider__nudge"
        data-testid={`${testId}-earlier`}
        aria-label={`${label}: earlier`}
        disabled={disabled || at <= 0}
        onClick={() => nudge(nudged(shown, -1, stops.length))}
      >
        ‹
      </button>
      <div className="year-slider__track" style={position} onPointerDown={press}>
        <span className="year-slider__rail" aria-hidden="true">
          {line.ticks.map((tick) => (
            <span
              key={tick.at}
              className="year-slider__tick"
              data-rank={tick.rank}
              data-at={tick.at}
              data-era={tick.stop < 0 ? undefined : stops[tick.stop]!.id}
              data-muted={tick.stop < 0 || undefined}
              data-on={(shown >= 0 && tick.stop === at) || undefined}
              style={{ '--i': lineFraction(tick.at, line) } as CSSProperties}
            >
              {tick.label !== null && <span className="year-slider__label">{tick.label}</span>}
            </span>
          ))}
        </span>
        <input
          ref={input}
          type="range"
          className="year-slider__input"
          data-testid={`${testId}-year`}
          min={line.min}
          max={line.max}
          step={1}
          value={line.places[at]}
          aria-label={label}
          aria-valuetext={shown < 0 ? undefined : stops[at]!.label}
          disabled={disabled}
          onChange={(e) => nudge(landing(e.currentTarget))}
        />
        <span ref={pill} className="year-slider__thumb" aria-hidden="true">
          {stops[at]!.label}
        </span>
      </div>
      <button
        type="button"
        className="year-slider__nudge"
        data-testid={`${testId}-later`}
        aria-label={`${label}: later`}
        disabled={disabled || (shown >= 0 && at >= last)}
        onClick={() => nudge(nudged(shown, 1, stops.length))}
      >
        ›
      </button>
    </div>
  );
}
