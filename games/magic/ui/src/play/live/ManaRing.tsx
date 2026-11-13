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
import { closeManaPress, echoOfManaPress, heldManaPress, MANA_PRESS_EVENT, manaPressOf, pickHeldPress, pickManaPress, releaseHeldPress, type ManaPress } from './mana-press.ts';
import { clampOffset, pointerAt, type PressPoint } from './movable.tsx';
import { chipLayout, costTokens, discKeys, inOrderOf, markGlyphs, optionForKeys, promptRing, ringFor, ringLayout, tallyDone, type Mana, type Ring, type RingAnswer, type RingOption } from './mana-ring.ts';
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
  /** Where it opens; the pointer's last press or move on the board when none. Read once: it never moves after. */
  readonly anchor?: PressPoint | null;
  /** Which question it answers now: a new one starts the pick over, in the same ring. */
  readonly question: string;
  /** Told once, where its centre was placed. */
  readonly onOpen?: (at: { readonly x: number; readonly y: number }) => void;
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

/** The card the last ring opened on: Forge's own ring that follows a press's opens still, off the card, and holds it on. */
let lastHeld: Element | null = null;

/**
 * Keep the hover lift of the card the ring opened on (`card.css`'s `data-ring-held`) while the ring is open:
 * its hover lift otherwise dropped as the pointer left the card for a disc over it, and rose again as it
 * came back. Returns the release.
 */
function holdCard(still: boolean): () => void {
  const hovered = document.querySelector('[data-board-card][data-selectable] > .board-card__face:hover')?.closest('[data-board-card]') ?? null;
  const card = hovered ?? (still ? lastHeld : null);
  if (card === null || !card.isConnected) return () => undefined;
  lastHeld = card;
  card.setAttribute('data-ring-held', '');
  return () => card.removeAttribute('data-ring-held');
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

export function ManaRing({ ring, kind, ask, titles, onPick, onCancel, press = false, still = false, anchor, question, onOpen }: ManaRingProps) {
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
  const keys = discKeys(ring.options);
  // What the placement depends on: the discs' and chips' layout, not the ring object a render rebuilds.
  const shape = `${keys.join(',')}|${ring.chips.length}`;
  const placedAt = useRef<PressPoint | null | undefined>(undefined);
  const opened = useRef(false);

  // A new question in the same ring: its pick starts over.
  useLayoutEffect(() => {
    picked.current = false;
    typed.current = '';
    setCounts(new Map());
  }, [question]);

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

  // Whether it opened still is the opening's: the echo's window lapsing later lets go of nothing.
  const [openedStill] = useState(still);
  useLayoutEffect(() => holdCard(openedStill), [openedStill]);

  // Open at the press: centred on the pointer, or just above a finger; held whole on the board.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const el = ringRef.current;
    if (host === null || el === null) return undefined;
    // Where it opens is read once: a redraw, a new question in it or the pointer moving on never moves it.
    if (placedAt.current === undefined) placedAt.current = anchor ?? pointerAt(host);
    const press = placedAt.current;
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
      // From the layout, not the discs' drawn boxes: a disc still blooming out of the hub is drawn small and in the middle.
      const half = size / 2;
      const box = [...at, ...chips].reduce(
        (b, p) => ({ left: Math.min(b.left, drawn.left + p.dx - half), top: Math.min(b.top, drawn.top + p.dy - half), right: Math.max(b.right, drawn.left + p.dx + half), bottom: Math.max(b.bottom, drawn.top + p.dy + half) }),
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
      if (!opened.current) {
        opened.current = true;
        const centre = el.getBoundingClientRect();
        onOpen?.({ x: Math.round(centre.left), y: Math.round(centre.top) });
      }
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
    // `shape` is the ring's layout; `anchor` and `onOpen` are read once.
  }, [finger, shape]);

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
            key={keys[i]}
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

/** Ability labels by option key, shown on hover. */
function titlesOf(ring: Ring): Map<string, string> {
  const titles = new Map<string, string>();
  for (const option of ring.options) {
    if (option.answer.to === 'ability' && option.answer.ability?.label !== undefined) titles.set(option.key, option.answer.ability.label);
  }
  return titles;
}

/** What the one ring shows now, and who it answers. */
interface Shown {
  readonly by: 'press' | 'held' | 'ask' | 'prompt';
  /** Which question: a press's and its held ring's are the same. */
  readonly question: string;
  readonly card: number | null;
  readonly ring: Ring;
  readonly kind: ManaRingProps['kind'];
  readonly ask?: LiveAsk;
  readonly titles?: ReadonlyMap<string, string>;
  readonly onPick: (pick: RingPick) => void;
  readonly onCancel: () => void;
}

/** The ring of a press while it is down, or held after a tap until Forge's question takes it over. */
function pressShown(match: LiveMatch, press: ManaPress, by: 'press' | 'held'): Shown {
  return {
    by,
    question: `press:${press.source}`,
    card: press.source,
    ring: press.ring,
    kind: 'abilities',
    titles: titlesOf(press.ring),
    onPick: (pick) => {
      if (pick.to === 'tally-done') return;
      if (by === 'press') pickManaPress(match, press.source, pick);
      else pickHeldPress(match, press.source, pick);
    },
    onCancel: () => (by === 'press' ? closeManaPress(match) : releaseHeldPress(match)),
  };
}

/** The ring for an open ask it answers (`ringFor`): a pick is the ask's reply; a pick of an ability carries its colour on. */
function askShown(match: LiveMatch, ask: LiveAsk): Shown | null {
  const shaped = ringFor(ask);
  if (shaped === null) return null;
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
  const card = ask.method === 'getAbilityToPlay' ? ask.hostCard.id : undoable;
  return { by: 'ask', question: `ask:${ask.callId}`, card, ring, kind: shaped.kind, ask, titles: ask.method === 'getAbilityToPlay' ? titlesOf(shaped.ring) : undefined, onPick, onCancel };
}

/** Forge's two-colour yes/no as a ring: OK is the first colour, Cancel the second. */
function promptShown(match: LiveMatch, colors: readonly [Mana, Mana]): Shown {
  return {
    by: 'prompt',
    question: `prompt:${match.prompt ?? ''}`,
    card: match.promptCard,
    ring: promptRing(colors, match.promptManaMarks ?? {}),
    kind: 'prompt',
    onPick: (pick) => {
      if (pick.to === 'button') pressButton(match, pick.which);
    },
    onCancel: () => undefined,
  };
}

/** One ring's life: from what opened it to the pick, through a press's ring held and taken over by Forge's question. */
interface Session {
  readonly id: number;
  readonly question: string;
  readonly by: Shown['by'];
  readonly still: boolean;
  readonly anchor: PressPoint | null;
  /** Its discs as first drawn: a question that takes it over keeps them in that order. */
  readonly order: readonly string[];
  /** A press's ring that Forge's question took over. */
  readonly takenOver: boolean;
}

let sessions = 0;
const opens = new WeakMap<LiveMatch, number>();

/**
 * The one mana ring (the operator, 2026-11-08: "it seems to display multiple times and move. let's make
 * sure it only displays once"). It owns whether the ring is open: a press's ring, held after a tap,
 * becomes the ring Forge's question about it asks, as the same element, where the press was. A
 * question that follows nothing a press opened opens a ring of its own.
 */
export function ManaRings({ match, ask, promptColors, report }: { match: LiveMatch; ask: LiveAsk | null; promptColors: readonly [Mana, Mana] | null; report: (data: Record<string, string | number | boolean>) => void }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener(MANA_PRESS_EVENT, redraw);
    return () => window.removeEventListener(MANA_PRESS_EVENT, redraw);
  }, []);
  const session = useRef<Session | null>(null);

  const pressed = manaPressOf(match);
  const held = heldManaPress(match);
  const asked = ask === null ? null : askShown(match, ask);
  const shown: Shown | null =
    pressed !== null ? pressShown(match, pressed, 'press')
    : asked !== null ? asked
    : promptColors !== null ? promptShown(match, promptColors)
    : held !== null && ask === null ? pressShown(match, held, 'held')
    : null;

  const was = session.current;
  let now: Session | null = null;
  if (shown !== null) {
    if (was !== null && was.question === shown.question) now = was.by === shown.by ? was : { ...was, by: shown.by };
    else if (was !== null && (was.by === 'press' || was.by === 'held') && (shown.by === 'ask' || shown.by === 'prompt')) now = { ...was, question: shown.question, by: shown.by, takenOver: true };
    else {
      const echo = shown.by === 'press' ? null : echoOfManaPress(match);
      now = {
        id: ++sessions,
        question: shown.question,
        by: shown.by,
        still: echo !== null,
        anchor: shown.by === 'press' || shown.by === 'held' ? (pressed ?? held)!.at : echo,
        order: discKeys(shown.ring.options),
        takenOver: false,
      };
    }
  }
  session.current = now;

  // Taken over by Forge's question, or by another, the held ring is done.
  const holding = held !== null && shown?.by === 'held';
  useEffect(() => {
    if (held !== null && !holding) releaseHeldPress(match);
  }, [match, held, holding]);
  // Reported: every ring that opens, and every question that takes one over (`kind:'info'`, `what:'mana-ring'`).
  const takeover = now?.takenOver === true && shown !== null ? { question: now.question, by: shown.by, method: shown.ask?.method ?? '-', card: shown.card ?? -1 } : null;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (takeover === null || reported.current === takeover.question) return;
    reported.current = takeover.question;
    report({ what: 'mana-ring-adopt', open: opens.get(match) ?? 0, by: takeover.by, method: takeover.method, card: takeover.card });
  });

  if (shown === null || now === null) return null;
  const ring = now.takenOver ? inOrderOf(shown.ring, now.order) : shown.ring;
  const opened = now;
  const onOpen = (at: { x: number; y: number }): void => {
    const n = (opens.get(match) ?? 0) + 1;
    opens.set(match, n);
    report({ what: 'mana-ring', open: n, by: opened.by, card: shown.card ?? -1, x: at.x, y: at.y, method: shown.ask?.method ?? '-' });
  };
  return (
    <ManaRing
      key={now.id}
      ring={ring}
      kind={shown.kind}
      ask={shown.ask === undefined ? undefined : { method: shown.ask.method, callId: shown.ask.callId }}
      titles={shown.titles}
      onPick={shown.onPick}
      onCancel={shown.onCancel}
      press={shown.by === 'press'}
      still={now.still}
      anchor={now.anchor}
      question={shown.question}
      onOpen={onOpen}
    />
  );
}
