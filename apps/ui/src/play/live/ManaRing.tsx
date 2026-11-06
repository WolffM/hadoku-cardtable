/**
 * The mana ring: a mana source's results drawn as discs in a ring round the press that tapped it
 * (the operator, 2026-11-05: "ideally it's a custom visual and it appears directly on the
 * mouse-cursor when they click a land"; take A, approved on the workbench artifact). The model is
 * `./mana-ring.ts`; this draws it and takes the pick.
 *
 * A pick is a click (a tap) on a disc, or a key (a colour letter, a pair's two letters, a digit).
 * Escape or a press away answers "none" where Forge allows it. On a finger the ring opens above the
 * press, never under it, its discs at least 44 px. A press on a source whose offer gives a choice
 * opens its ring before anything is sent (`./mana-press.ts`): a drag to a disc and a release on it
 * picks it there.
 */

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import { ManaCost, ManaPip } from '../../components/ManaPip.tsx';
import { answerAsk, pressButton, undoableManaSource, undoManaChoice, type LiveAsk, type LiveMatch } from './match.ts';
import { closeManaPress, echoesManaPress, MANA_PRESS_EVENT, manaPressOf, pickManaPress } from './mana-press.ts';
import { clampOffset, pointerAt } from './movable.tsx';
import { chipLayout, costTokens, markGlyphs, optionForKeys, promptRing, ringFor, ringLayout, tallyDone, type Mana, type Ring, type RingAnswer, type RingOption } from './mana-ring.ts';
import './mana-ring.css';

/** A disc's size in px: the pointer's, and a finger's (at least 44 px, the brief's touch floor). */
const DISC_PX = 42;
const FINGER_DISC_PX = 52;
/** How far over a finger's press the ring's lowest disc stands: clear of the fingertip's pad. */
const OVER_FINGER_PX = 28;
/** How far beside a finger's press the ring stands when the board leaves no room above it. */
const FINGER_CLEAR_PX = 32;

/** Whether this device's primary pointer is a finger. */
function coarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export type RingPick = RingAnswer | { readonly to: 'tally-done'; readonly counts: ReadonlyMap<Mana, number> };

export interface ManaRingProps {
  readonly ring: Ring;
  /** The ring's key in the DOM (`data-ring`), for tests and telemetry: which question it answers. */
  readonly kind: 'abilities' | 'colors' | 'prompt' | 'tally';
  /** The open ask it answers (`data-method`, `data-call-id`), as the generic prompt marks its own; none for Forge's yes/no. */
  readonly ask?: { readonly method: string; readonly callId: string };
  /** Forge's label for each option's ability, shown on hover only. */
  readonly titles?: ReadonlyMap<string, string>;
  readonly onPick: (pick: RingPick) => void;
  readonly onCancel: () => void;
  /** Drawn on a press, before Forge asked (`data-press`): the gestures layer resolves its release. */
  readonly press?: boolean;
  /** Opens where the press's ring just stood, without blooming again. */
  readonly still?: boolean;
}

function Marks({ option }: { option: RingOption }) {
  const { cost, rule } = markGlyphs(option.marks);
  const mana = option.marks.cost === undefined || option.syms.length > 1 ? [] : costTokens(option.marks.cost);
  const hurt = (option.marks.life ?? 0) + (option.marks.damage ?? 0);
  return (
    <>
      {hurt > 0 && <span className="mana-ring__mark mana-ring__mark--life" data-testid="mana-ring-life">{hurt}</span>}
      {option.times > 1 && <span className="mana-ring__mark mana-ring__mark--times">×{option.times}</span>}
      {option.split !== undefined && <span className="mana-ring__mark mana-ring__mark--times">×{option.split}</span>}
      {(cost.length > 0 || mana.length > 0) && (
        <span className="mana-ring__mark mana-ring__mark--cost">
          {mana.length > 0 && <ManaCost cost={mana} />}
          {cost.map((g, i) => (
            <i key={i} className={`ms ${g}`} aria-hidden />
          ))}
        </span>
      )}
      {rule !== null && (
        <span className="mana-ring__mark mana-ring__mark--rule">
          <i className={`ms ${rule}`} aria-hidden />
        </span>
      )}
    </>
  );
}

function Glyphs({ option }: { option: RingOption }) {
  if (option.split !== undefined || option.reflects === true) return <i className="ms ms-multicolor mana-ring__wild" aria-hidden />;
  return (
    <span className="mana-ring__glyphs">
      {option.syms.map((c, i) => (
        <ManaPip key={i} token={c} titled={false} />
      ))}
    </span>
  );
}

/** The box every disc and chip stands in, round the ring's centre, with room for their marks. */
function extentOf(discs: readonly { dx: number; dy: number }[], chips: readonly { dx: number; dy: number }[], size: number): { left: string; top: string; width: string; height: string } {
  const half = size * 0.9;
  const xs = [...discs, ...chips].map((p) => p.dx);
  const ys = [...discs, ...chips].map((p) => p.dy);
  const left = Math.min(0, ...xs) - half;
  const top = Math.min(0, ...ys) - half;
  const right = Math.max(0, ...xs) + half;
  const bottom = Math.max(0, ...ys) + half;
  return { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` };
}

export function ManaRing({ ring, kind, ask, titles, onPick, onCancel, press = false, still = false }: ManaRingProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [finger, setFinger] = useState(coarsePointer);
  const [counts, setCounts] = useState<ReadonlyMap<Mana, number>>(new Map());
  const picked = useRef(false);
  const typed = useRef('');
  const size = finger ? FINGER_DISC_PX : DISC_PX;
  const at = ringLayout(ring.options, size);
  const radius = at[0]?.radius ?? size;
  const chips = chipLayout(ring.chips.length, radius, size);

  const pick = (p: RingPick): void => {
    if (picked.current) return;
    picked.current = true;
    onPick(p);
  };
  const choose = (i: number): void => {
    const option = ring.options[i];
    if (option === undefined || option.dim === true) return;
    if (option.answer.to !== 'tally') {
      pick(option.answer);
      return;
    }
    const c = option.syms[0]!;
    const next = new Map(counts);
    next.set(c, (next.get(c) ?? 0) + 1);
    if ((next.get(c) ?? 0) > (ring.tally?.max.get(c) ?? 0)) return;
    setCounts(next);
    if (ring.tally !== undefined && tallyDone(ring.tally, next)) pick({ to: 'tally-done', counts: next });
  };

  // Open at the press: centred on the pointer, or just above a finger; held whole on the board.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const el = ringRef.current;
    const press = host === null ? null : pointerAt(host);
    if (host === null || el === null) return undefined;
    // A finger: the press said so, or the device has no finer pointer (the press's own type can be lost
    // to a gesture that takes the touch first).
    const fingered = (press?.finger ?? false) || coarsePointer();
    if (fingered !== finger) {
      setFinger(fingered);
      return undefined;
    }
    const place = (): void => {
      const board = host.getBoundingClientRect();
      const point = press ?? { x: (board.left + board.right) / 2, y: (board.top + board.bottom) / 2, finger: false };
      el.style.translate = '0px 0px';
      const drawn = el.getBoundingClientRect();
      const parts = [...el.querySelectorAll('.mana-ring__disc, .mana-ring__chip')].map((d) => d.getBoundingClientRect());
      const box = parts.reduce(
        (b, r) => ({ left: Math.min(b.left, r.left), top: Math.min(b.top, r.top), right: Math.max(b.right, r.right), bottom: Math.max(b.bottom, r.bottom) }),
        { left: drawn.left, top: drawn.top, right: drawn.left, bottom: drawn.top },
      );
      // The ring's centre on the press. A finger's press under its lowest disc; where the board leaves
      // no room above it, beside the finger (right, else left), never back down onto it.
      const want = { x: point.x - drawn.left, y: fingered ? point.y - OVER_FINGER_PX - box.bottom : point.y - drawn.top };
      let by = clampOffset(want, box, board);
      if (fingered && box.bottom + by.y > point.y - OVER_FINGER_PX / 2) {
        const midY = point.y - (box.top + box.bottom) / 2;
        const right = clampOffset({ x: point.x + FINGER_CLEAR_PX - box.left, y: midY }, box, board);
        const left = clampOffset({ x: point.x - FINGER_CLEAR_PX - box.right, y: midY }, box, board);
        by = box.left + right.x >= point.x + FINGER_CLEAR_PX / 2 ? right : left;
      }
      el.style.translate = `${Math.round(by.x)}px ${Math.round(by.y)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [finger, ring]);

  // Keys, and a press away.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (ring.cancellable) {
          event.preventDefault();
          onCancel();
        }
        return;
      }
      if (event.key === 'Backspace' && ring.tally !== undefined) {
        event.preventDefault();
        setCounts(new Map());
        return;
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      typed.current += event.key;
      const hit = optionForKeys(ring.options, typed.current);
      if (hit === 'pending') return;
      typed.current = '';
      if (hit === null) return;
      event.preventDefault();
      choose(hit.index);
    };
    const onDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || ringRef.current?.contains(event.target)) return;
      if (ring.cancellable) onCancel();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  });

  const tallied = [...counts].flatMap(([c, n]) => Array.from({ length: n }, () => c));
  return (
    <div ref={hostRef} className="mana-ring" data-testid="mana-ring-host">
      <div
        ref={ringRef}
        className={['mana-ring__ring', finger ? 'mana-ring__ring--finger' : '', still ? 'mana-ring__ring--still' : ''].filter(Boolean).join(' ')}
        data-testid="mana-ring"
        data-ring={kind}
        data-press={press ? '' : undefined}
        data-method={ask?.method}
        data-call-id={ask?.callId}
        role="dialog"
        aria-label="Choose mana"
        style={{ ['--disc' as string]: `${size}px` }}
      >
        {/* The ring's whole footprint, discs and chips: the card inspector stands beside it (`inspect/index.ts`'s OPEN_WINDOW). */}
        <div className="mana-ring__extent" data-ring-extent="" style={extentOf(at, chips, size)} />
        <div className={ring.tally === undefined ? 'mana-ring__hub' : 'mana-ring__hub mana-ring__hub--tally'} data-testid="mana-ring-hub">
          {ring.tally !== undefined && (
            <>
              {tallied.map((c, i) => (
                <ManaPip key={i} token={c} titled={false} />
              ))}
              <span className="mana-ring__mark mana-ring__mark--times">{ring.tally.total - tallied.length}</span>
            </>
          )}
        </div>
        {ring.options.map((option, i) => (
          <button
            key={option.key}
            type="button"
            className={[
              'mana-ring__disc',
              option.syms.length > 1 && option.split === undefined ? 'mana-ring__disc--pair' : '',
              option.dim === true ? 'mana-ring__disc--dim' : '',
            ].filter(Boolean).join(' ')}
            disabled={option.dim === true}
            data-dim={option.dim === true ? '' : undefined}
            data-testid="mana-ring-option"
            data-mana={option.syms.join('')}
            title={titles?.get(option.key)}
            style={{ left: `${at[i]!.dx}px`, top: `${at[i]!.dy}px`, ['--i' as string]: i, ['--dx' as string]: `${at[i]!.dx}px`, ['--dy' as string]: `${at[i]!.dy}px` }}
            onClick={() => choose(i)}
          >
            <Glyphs option={option} />
            <Marks option={option} />
          </button>
        ))}
        {ring.chips.map((chip, j) => (
          <button
            key={chip.key}
            type="button"
            className="mana-ring__chip"
            data-testid="mana-ring-chip"
            title={chip.label}
            style={{ left: `${chips[j]!.dx}px`, top: `${chips[j]!.dy}px`, ['--i' as string]: ring.options.length + j, ['--dx' as string]: `${chips[j]!.dx}px`, ['--dy' as string]: `${chips[j]!.dy}px` }}
            onClick={() => pick(chip.answer)}
          >
            <i className="ms ms-ability-activated" aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}

/** The ring for an open ask it answers (`ringFor`): a pick is the ask's reply; a pick of an ability carries its colour on. */
export function ManaAsk({ match, ask }: { match: LiveMatch; ask: LiveAsk }) {
  const shaped = ringFor(ask);
  if (shaped === null) return null;
  const titles = ask.method === 'getAbilityToPlay' ? titlesOf(shaped.ring) : new Map<string, string>();
  const onPick = (pick: RingPick): void => {
    if (pick.to === 'ability' && ask.method === 'getAbilityToPlay') {
      match.manaIntent = pick.then === null ? null : { colors: pick.then, source: ask.hostCard.id };
      answerAsk(match, ask.callId, 'getAbilityToPlay', pick.ability);
    } else if (pick.to === 'choice' && ask.method === 'getChoices') {
      answerAsk(match, ask.callId, 'getChoices', [pick.key]);
    } else if (pick.to === 'tally-done' && shaped.ring.tally !== undefined) {
      answerAsk(match, ask.callId, 'assignGenericAmount', shaped.ring.tally.reply(pick.counts));
    }
  };
  // A colour Forge asks after tapping the source has no way out of its own; at priority, giving it up untaps the source.
  const undoable = undoableManaSource(match, ask);
  const ring = undoable === null ? shaped.ring : { ...shaped.ring, cancellable: true };
  const onCancel = (): void => {
    if (ask.method === 'getAbilityToPlay') answerAsk(match, ask.callId, 'getAbilityToPlay', null);
    else if (undoable !== null && ask.method === 'getChoices') undoManaChoice(match, ask, undoable);
  };
  return <ManaRing key={ask.callId} ring={ring} kind={shaped.kind} ask={ask} titles={titles} onPick={onPick} onCancel={onCancel} still={echoesManaPress(match)} />;
}

/** Ability labels by option key, shown on hover. */
function titlesOf(ring: Ring): Map<string, string> {
  const titles = new Map<string, string>();
  for (const option of ring.options) {
    if (option.answer.to === 'ability' && option.answer.ability?.label !== undefined) titles.set(option.key, option.answer.ability.label);
  }
  return titles;
}

/** The ring a press on a mana source opened (`./mana-press.ts`), while it is open. */
export function ManaPressRing({ match }: { match: LiveMatch }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener(MANA_PRESS_EVENT, redraw);
    return () => window.removeEventListener(MANA_PRESS_EVENT, redraw);
  }, []);
  const press = manaPressOf(match);
  if (press === null) return null;
  const onPick = (pick: RingPick): void => {
    if (pick.to === 'tally-done') return;
    pickManaPress(match, press.source, pick);
  };
  return <ManaRing key={press.source} ring={press.ring} kind="abilities" titles={titlesOf(press.ring)} onPick={onPick} onCancel={() => closeManaPress(match)} press />;
}

/** Forge's two-colour yes/no as a ring: OK is the first colour, Cancel the second. */
export function ManaPrompt({ match, colors }: { match: LiveMatch; colors: readonly [Mana, Mana] }) {
  const marks = match.promptManaMarks;
  const onPick = (pick: RingPick): void => {
    if (pick.to === 'button') pressButton(match, pick.which);
  };
  return <ManaRing ring={promptRing(colors, marks ?? {})} kind="prompt" onPick={onPick} onCancel={() => undefined} still={echoesManaPress(match)} />;
}
