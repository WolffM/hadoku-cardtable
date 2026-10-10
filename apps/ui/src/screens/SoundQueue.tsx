/*
 * The sound picker's queue mode: one cell at a time, a few takes to choose
 * from (the operator, 2026-10-10: *"gives me a thing that needs a sound and
 * then a couple to choose from. i can either pick one, multiple, or none and
 * move on … just a different way for me to engage in it"*).
 *
 * What it serves and offers is `../sound/queue.ts`. This draws it and writes
 * through the picker's own `place` and `retire`, so the Roles and Colours tabs
 * see every choice made here at once.
 *
 * Listening and picking are two acts (the operator, 2026-10-10: *"it's a bit
 * annoying that clicking is the same thing for selecting and listening"*): a
 * card plays its take, its check picks it. Keys: 1–6 hear a take; Space picks or
 * unpicks the take last heard; Enter places the picks (or, with none, moves on);
 * S or → skips to the back of the queue; Delete throws out the take last heard
 * as bad, Shift+Delete as broken. Not while typing in a field.
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@wolffm/themes';

import type { RetireReason, SoundMark, SoundTake } from '@hadoku/shared';

import { candidatesFor, queueOrder } from '../sound/queue.ts';

/** A prompt without the generator's stock tail ("High-quality, stereo, 44.1kHz, sound effect."); the full one is the tooltip. */
export function promptGist(prompt: string): string {
  return prompt.replace(/[.,]?\s*High-quality\b.*$/i, '').trim() || prompt;
}

export interface SoundQueueProps {
  takes: readonly SoundTake[];
  cells: Readonly<Record<string, readonly string[]>>;
  placed: ReadonlySet<string>;
  play: (file: string) => void;
  /** The picker's keep / delete marks: a take marked delete is never offered. */
  marks: Readonly<Record<string, SoundMark>>;
  /** Middle-click keep, right-click delete, as in the bin. */
  markHandlers: (file: string) => Record<string, unknown>;
  place: (cell: string, files: string[]) => void;
  retire: (file: string, reason: RetireReason) => void;
}

export function SoundQueue({ takes, cells, placed, play, marks, markHandlers, place, retire }: SoundQueueProps) {
  const [skipped, setSkipped] = useState<string[]>([]);
  // Drawn once per visit to the tab: random, but still for the session (see `queue.ts`).
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 32));
  const queue = useMemo(() => queueOrder(cells, skipped, seed), [cells, skipped, seed]);
  const item = queue[0];
  return item === undefined ? (
    <p className="sound-queue__done" data-testid="sound-queue-done">
      Every cell has a sound.
    </p>
  ) : (
    <QueueItemView
      key={item.cell}
      cell={item.cell}
      title={item.title}
      sub={item.sub}
      left={queue.length}
      choices={candidatesFor(
        item.cell,
        takes.filter((t) => marks[t.file] !== 'trash'),
        placed,
      )}
      markHandlers={markHandlers}
      play={play}
      onPlace={(files) => place(item.cell, files)}
      onSkip={() => setSkipped((s) => [...s.filter((c) => c !== item.cell), item.cell])}
      retire={retire}
    />
  );
}

interface QueueItemViewProps {
  cell: string;
  title: string;
  sub: string;
  left: number;
  choices: SoundTake[];
  play: (file: string) => void;
  onPlace: (files: string[]) => void;
  onSkip: () => void;
  retire: (file: string, reason: RetireReason) => void;
  markHandlers: (file: string) => Record<string, unknown>;
}

/** One cell's turn. Keyed by the cell, so picks and the last-heard take start fresh for each. */
function QueueItemView({ cell, title, sub, left, choices, play, onPlace, onSkip, retire, markHandlers }: QueueItemViewProps) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [heard, setHeard] = useState<string | null>(null);

  const hear = (file: string): void => {
    play(file);
    setHeard(file);
  };
  const togglePick = (file: string): void => {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };
  // In the order offered, not the order clicked.
  const chosen = (): string[] => choices.filter((t) => picked.has(t.file)).map((t) => t.file);
  const commit = (): void => {
    const files = chosen();
    if (files.length > 0) onPlace(files);
    else onSkip();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        hear(choices[n - 1]!.file);
      } else if (e.key === ' ') {
        // Not the focused button's own Space, which would play it again.
        e.preventDefault();
        if (heard !== null) togglePick(heard);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 's' || e.key === 'S' || e.key === 'ArrowRight') {
        onSkip();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && heard !== null) {
        e.preventDefault();
        setPicked((p) => {
          const next = new Set(p);
          next.delete(heard);
          return next;
        });
        retire(heard, e.shiftKey ? 'broken' : 'bad');
        setHeard(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <section className="sound-queue" data-testid="sound-queue" data-cell={cell} aria-labelledby="sound-queue-title">
      <p className="sound-queue__left">{left} to go</p>
      <h2 id="sound-queue-title" className="sound-queue__title">
        {title}
      </h2>
      <p className="sound-queue__sub">{sub}</p>
      <ol className="sound-queue__choices">
        {choices.map((t, i) => (
          <li key={t.file} className="sound-queue__card" data-picked={picked.has(t.file) ? '' : undefined}>
            <button
              type="button"
              className="sound-queue__choice"
              data-testid="sound-queue-choice"
              data-file={t.file}
              data-heard={heard === t.file ? '' : undefined}
              {...markHandlers(t.file)}
              aria-label={`Play ${t.label}`}
              title={t.prompt}
              onClick={() => hear(t.file)}
            >
              <span className="sound-queue__key" aria-hidden="true">
                {i + 1}
              </span>
              <span className="sound-queue__label">{t.label}</span>
              <span className="sound-queue__prompt">{promptGist(t.prompt)}</span>
            </button>
            <button
              type="button"
              className="sound-queue__pick"
              data-testid="sound-queue-pick"
              aria-label={`Pick ${t.label}`}
              aria-pressed={picked.has(t.file)}
              onClick={() => togglePick(t.file)}
            >
              <Icon name="check" size="1rem" />
            </button>
          </li>
        ))}
      </ol>
      <div className="sound-queue__actions">
        <button type="button" className="sound-queue__place" data-testid="sound-queue-place" disabled={picked.size === 0} onClick={commit}>
          Place {picked.size > 0 ? picked.size : ''}
        </button>
        <button type="button" className="sound-queue__skip" data-testid="sound-queue-skip" onClick={onSkip}>
          Skip
        </button>
      </div>
    </section>
  );
}
