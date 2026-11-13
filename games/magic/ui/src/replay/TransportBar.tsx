/*
 * Play/pause, 1×/2×/4×, and a turn… really a time scrubber — `#/replay/<id>`'s
 * own controls over `./player.ts`'s clock (wave 77 §B). `R5` of the
 * plan calls it "scrub by turn"; the clock has no notion of a turn boundary
 * (it paces by the recording's own `at`, in ms), so this scrubs by time, which
 * is the data actually on hand — a turn-aware scrubber is further work, not
 * this one withheld.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import type { ReplayClock, ReplaySpeed } from './player.ts';

/**
 * `clock.positionMs()` recomputes from the wall clock on every call, so two
 * calls a microsecond apart within the SAME render already disagree —
 * `useSyncExternalStore` reads its snapshot more than once per commit to
 * check for tearing, and a snapshot that moves on its own between those
 * reads is exactly what it exists to catch: the subscription fires, re-reads
 * disagree again, and React loops ("Maximum update depth exceeded"), caught
 * by `TransportBar.test.ts`'s own run before this shipped. So position is
 * NOT read that way: it is the clock's own `notify` ticks (`player.ts`'s
 * `TICK_MS`) turned into ordinary React state, which only changes on an
 * explicit subscriber callback — a stable snapshot between those.
 */
function usePosition(clock: ReplayClock): number {
  const [position, setPosition] = useState(clock.positionMs);
  useEffect(() => {
    setPosition(clock.positionMs());
    return clock.subscribe(() => setPosition(clock.positionMs()));
  }, [clock]);
  return position;
}

const SPEEDS: readonly ReplaySpeed[] = [1, 2, 4];

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export interface TransportBarProps {
  clock: ReplayClock;
  className?: string;
}

export function TransportBar({ clock, className }: TransportBarProps) {
  // The clock ticks on a timer, not on a React-visible prop — `useSyncExternalStore` is the
  // sanctioned way to read a mutable external value without tearing, same reason `match.ts`'s
  // own `subscribe`/`notify` pair exists for `LiveMatch`.
  const position = usePosition(clock);
  const playing = useSyncExternalStore(clock.subscribe, clock.playing);
  const speed = useSyncExternalStore(clock.subscribe, clock.speed);
  const ended = useSyncExternalStore(clock.subscribe, clock.ended);

  return (
    <div className={className} data-testid="replay-bar">
      <button
        type="button"
        data-testid="replay-bar-play"
        title={playing ? 'Pause' : 'Play'}
        onClick={() => (playing ? clock.pause() : clock.play())}
      >
        {playing ? '⏸' : ended ? '↺' : '▶'}
      </button>
      <div className="replay-bar__speeds" role="group">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`replay-bar-speed-${s}`}
            aria-pressed={speed === s}
            title={`${s}× speed`}
            onClick={() => clock.setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      <span className="replay-bar__time">{formatTime(position)}</span>
      <input
        type="range"
        data-testid="replay-bar-scrub"
        min={clock.startMs}
        max={Math.max(clock.durationMs, 1)}
        value={Math.min(position, clock.durationMs)}
        onChange={(e) => clock.seek(Number(e.currentTarget.value))}
      />
      <span className="replay-bar__time">{formatTime(clock.durationMs)}</span>
    </div>
  );
}
