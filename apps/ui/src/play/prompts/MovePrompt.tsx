/*
 * Every question that moves cards between places or orders them, as one sheet: named
 * zones, and cards dragged between them. The operator, 2026-10-19, over a fateseal's
 * "select a card to put on bottom": *"it would be nice if it were just two zones 'top'
 * and 'bottom' and i can drag between them … in general i feel like there way too many
 * similar UIs for this type of card selection and movement question. would be nice to
 * unify as many of them as we can"*.
 *
 * It answers `order` — Forge's dual list (`DualListBox.java`) and what the server folds
 * into one (a scry, a surveil, a dig: `apps/server/src/play/arrange.ts`) — and
 * `manipulateCardList`, read as the same two ends of a library.
 *
 * ## The zones
 *
 * An order has two groups: what is left (`sourceChoices`) and the answer (`destChoices`).
 *
 *  - One that must place everything and has no second group (a library order, Ponder, a
 *    mulligan's tuck, an order of triggers) is ONE zone, every item already in it in the
 *    order Forge offered: the answer is ready, and a drag only changes the order.
 *  - Any other is two zones, both always drawn, an empty one at its own size as a drop
 *    target (the operator, 2026-10-19, on Ponder: *"the unplaced zone disappears when all
 *    three cards have been dragged which is weird"*).
 *
 * A zone is named by where its cards go — Top, Bottom, Graveyard, Hand — from the ask's
 * `destination` (the answer) and `rest` (what is left), and then the sheet's title is the
 * library's ("Your library", or the other player's for a fateseal). A group with nowhere
 * named keeps Forge's own caption (`top`, e.g. "Damaged first"). No sentence explains it.
 *
 * Forge's bounds on how many go where gate OK (`rules.ts` `orderProblems`), drawn rather
 * than written: a zone that must hold an exact count shows it, and a zone short of or
 * over its bounds is marked (`data-short`). A pick of one card per type (`oneEach`, Atraxa's
 * "for each card type") draws each type over the answer's zone, filled once the cards in it
 * fill that type whichever way they are read, open while a card of several types could; a card
 * goes in only while the cards still each fill a type of their own.
 *
 * ## The gesture
 *
 * Drag is the gesture (operator, 2026-10-06): a card is dragged into a zone and lands
 * where it is let go, between the two cards it is let go between. A click moves it to the
 * other zone. The arrow keys move a focused card along its pile. The drag is the board's
 * (`./row-drag.ts`): the phantom, the landing bar, the slide.
 *
 * ## Every card whole, in a row, the library's way across
 *
 * A zone of cards is one row of whole tiles at a board card's size, the highest card on the
 * left: every card is readable at once, because a card you cannot read is one you cannot
 * order (the operator, 2026-10-19, on Ponder: *"the UI for ponder is quite ugly"* — three
 * cards stacked in a pile, one readable). The sheet is as wide as its rows need, up to the
 * board (`live.css`). A zone going into a library draws the ghost of it
 * (`.prompt__library`) on the side the zone meets it (operator, 2026-10-16): after the Top
 * zone's last card, before the Bottom zone's first. So the cards read left to right as the
 * library does top to bottom — Top, the library, Bottom — and the card touching the ghost is
 * the one that ends next to the rest of the library. An answer whose first card is the lowest
 * (`first: 'bottom'`) is drawn the other way round, so the left is always the higher card.
 *
 * A row of words (a trigger's ability) keeps its ↑/↓ on its own tile.
 */

import { oneEachFit } from '@hadoku/forge-wire';
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { cardOrWordsFace, PromptShell } from './PromptShell.tsx';
import { refName, translateTargetWords, type PromptLookup } from './lookup.ts';
import { moveBetween, moveItem, orderProblems, type OrderLists } from './rules.ts';
import { ACROSS_ATTR, useRowDrag } from './row-drag.ts';
import { assertAnswerable, checkedReply, type AskOf, type PromptProps, type ReplyOf } from './types.ts';

const LIST_TESTID = { source: 'zone-source', dest: 'zone-dest' } as const;
type Side = keyof OrderLists;
type OrderAsk = AskOf<'order'>;
type Destination = NonNullable<OrderAsk['destination']>;

const ZONE_NAME: Readonly<Record<Destination['zone'], string>> = {
  library: 'Library',
  graveyard: 'Graveyard',
  hand: 'Hand',
  exile: 'Exile',
  battlefield: 'Battlefield',
};

/** A zone's name: a library's end ("Top"), any other zone's own name. */
const zoneName = (d: Destination): string => (d.zone === 'library' ? (d.end === 'bottom' ? 'Bottom' : 'Top') : ZONE_NAME[d.zone]);

/** `data-zone`: the zone's name as a stable word, for a stylesheet or a test. */
const zoneWord = (d: Destination | undefined, side: Side): string =>
  d === undefined ? (side === 'dest' ? 'chosen' : 'left') : d.zone === 'library' ? (d.end ?? 'top') : d.zone;

/** The ghost of the zone a group goes into: a few card backs, see-through. */
function ZoneGhost({ destination }: { destination: Destination }) {
  return (
    <div className="prompt__library" data-testid="zone-library" data-zone={destination.zone} data-end={destination.end} aria-hidden="true">
      <span className="card-back" />
      <span className="card-back" />
      <span className="card-back" />
    </div>
  );
}

/**
 * The sheet's title: the action the seat takes when the ask says it in words (a dig's); else the
 * library's, when a zone is one of its ends; Forge's own otherwise.
 */
function titleOf(ask: OrderAsk, lookup: PromptLookup): string {
  if (ask.question !== undefined) return ask.question;
  const library = [ask.destination, ask.rest].find((d) => d?.zone === 'library');
  if (library === undefined) return ask.title;
  return library.owner === undefined ? 'Your library' : `${refName(lookup, library.owner)}'s library`;
}

/** One order ask, one reply: the sheet both methods draw. */
function ZonesSheet({
  ask,
  method,
  lookup,
  onReply,
}: {
  ask: OrderAsk;
  method: 'order' | 'manipulateCardList';
  lookup: PromptLookup;
  onReply: (reply: ReplyOf<'order'>) => void;
}) {
  const all = [...ask.sourceChoices, ...ask.destChoices];
  // NOT `plainRulesText`: a card item's label is an IDENTITY fallback (`cardOrWordsFace`
  // → `promptTileFor` → `nameFromForgeLabel`), see `ChoicePrompts.tsx`'s identical note.
  const labelOf = new Map(all.map((c) => [c.key, translateTargetWords(c.label)]));
  /** The forge card id an item that stands for a card carries, by choice key. */
  const cardIdOf = new Map(all.flatMap((c) => (c.ref !== null && c.ref.kind === 'card' ? [[c.key, c.ref.id] as const] : [])));
  const anyCards = cardIdOf.size > 0;
  const nameOf = (key: string): string => {
    const id = cardIdOf.get(key);
    return labelOf.get(key) || (id === undefined ? key : refName(lookup, { kind: 'card', id }));
  };
  /** Every row's drag id: a card's own id, or a small per-mount negative number (never a Forge id). */
  const liftIdOf = new Map(all.map((c, i) => [c.key, cardIdOf.get(c.key) ?? -(i + 1)]));
  const keyOfLiftId = new Map([...liftIdOf].map(([key, id]) => [id, key]));
  /** One zone: everything is placed already, so the order Forge offered is in it. */
  const single = ask.rest === undefined && ask.remainingObjectsMax === 0;
  /** The source's fixed order, when its order is not part of the answer. */
  const fixedSource = ask.rest === undefined ? all.map((c) => c.key) : undefined;
  const locked = new Set(ask.locked ?? []);
  const oneEach = ask.oneEach;

  const [lists, setLists] = useState<OrderLists>(() =>
    single
      ? { source: [], dest: [...ask.destChoices, ...ask.sourceChoices].map((c) => c.key) }
      : { source: ask.sourceChoices.map((c) => c.key), dest: ask.destChoices.map((c) => c.key) },
  );
  const [remember, setRemember] = useState(false);

  const reply = {
    ordered: [...lists.dest],
    rememberDecision: ask.showRememberCheckbox && remember,
    ...(ask.rest !== undefined && { rest: [...lists.source] }),
  };
  const problems = orderProblems(ask, reply);

  const submit = () => {
    assertAnswerable(method, problems);
    onReply(reply);
  };

  const other = (side: Side): Side => (side === 'dest' ? 'source' : 'dest');
  const destinationOf: Readonly<Record<Side, Destination | undefined>> = { source: ask.rest, dest: ask.destination };
  /** A zone of cards drawn the other way round from its answer: the answer's first card is its lowest. */
  const turned = (side: Side): boolean => anyCards && destinationOf[side]?.first === 'bottom';
  /** A zone's keys as drawn, left to right (top to bottom for words). */
  const shown = (side: Side, keys: readonly string[] = lists[side]): string[] => (turned(side) ? [...keys].reverse() : [...keys]);

  /**
   * Move `key` to `to`, drawn just before `before` (`null`: at the end as drawn); false when nothing
   * would change or the move is not allowed. In a zone drawn turned round, before a card as drawn is
   * after it in the answer.
   */
  const move = (key: string, to: Side, before: string | null): boolean => {
    if (to === 'dest' && locked.has(key)) return false;
    if (to === 'dest' && oneEach !== undefined && !lists.dest.includes(key) && oneEachFit(oneEach, [...lists.dest, key]) === null) return false;
    let at = before;
    if (turned(to)) {
      const rest = lists[to].filter((k) => k !== key);
      at = before === null ? (rest[0] ?? null) : (rest[rest.indexOf(before) + 1] ?? null);
    }
    const next = moveBetween(lists, key, to, at, fixedSource);
    if (next.source.join() === lists.source.join() && next.dest.join() === lists.dest.join()) return false;
    setLists(next);
    return true;
  };
  /** One card one place along its zone as drawn. */
  const nudge = (side: Side, from: number, to: number) =>
    setLists((l) => ({ ...l, [side]: shown(side, moveItem(shown(side, l[side]), from, to)) }));

  const drag = useRowDrag({
    targets: [
      ...(single ? [] : [{ testid: LIST_TESTID.source, rows: fixedSource === undefined }]),
      { testid: LIST_TESTID.dest, rows: true },
    ],
    canLift: () => true,
    onDrop: (liftId, slot) => {
      const key = keyOfLiftId.get(liftId);
      if (key === undefined) return false;
      const before = slot.before === null ? null : (keyOfLiftId.get(slot.before) ?? null);
      return move(key, slot.testid === LIST_TESTID.dest ? 'dest' : 'source', before);
    },
  });

  /** How many the answer must hold, when Forge bounds it: [least, most]. */
  const n = all.length;
  const bounds: readonly [number, number] | null =
    ask.remainingObjectsMax < 0 || single ? null : [n - ask.remainingObjectsMax, n - Math.max(ask.remainingObjectsMin, 0)];
  const exact = bounds !== null && bounds[0] === bounds[1] ? bounds[0] : null;
  const destShort = bounds !== null && (lists.dest.length < bounds[0] || lists.dest.length > bounds[1]);
  /** What the answer fills, for a pick of one per type: a type is filled once every reading of it fills the type. */
  const fit = oneEach === undefined ? null : oneEachFit(oneEach, lists.dest);
  /** The types some pick could still be, not yet decided. */
  const open = new Set([...(fit?.could.values() ?? [])].flat().filter((type) => !fit!.filled.has(type)));

  /** Enter or Space does what a click does; in an ordered zone the arrows move the card the way they point. */
  const onKey = (act: () => void, side: Side, i: number, ordered: boolean) => (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      act();
      return;
    }
    const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
    if (!ordered || step === undefined) return;
    const to = i + step;
    if (to < 0 || to >= lists[side].length) return;
    e.preventDefault();
    nudge(side, i, to);
  };

  /** One item's face: the tile when the item is a card, the words otherwise. A card the server folded in has no label: the lookup names it. */
  const face = (key: string) => cardOrWordsFace(lookup, cardIdOf.get(key), labelOf.get(key) || undefined);

  /** One zone: its name and its row of cards (or list of words), with the ghost of the zone it goes into. */
  const zone = (side: Side) => {
    const keys = shown(side);
    const ordered = side === 'dest' || fixedSource === undefined;
    const Tag = ordered ? 'ol' : 'ul';
    const destination = destinationOf[side];
    const ghost = anyCards && destination?.zone === 'library' ? destination : undefined;
    const name = destination !== undefined ? zoneName(destination) : side === 'dest' ? ask.top : 'Not chosen';
    const click = (key: string) => (single ? undefined : () => move(key, other(side), null));
    const list = (
      <Tag
        className={anyCards ? 'prompt__tiles' : 'prompt__list'}
        data-testid={LIST_TESTID[side]}
        data-zone={zoneWord(destination, side)}
        data-over={drag.over === LIST_TESTID[side] || undefined}
        {...(anyCards && { [ACROSS_ATTR]: '' })}
      >
        {keys.map((key, i) => (
          <li
            key={key}
            data-key={key}
            data-card-id={liftIdOf.get(key)}
            data-locked={locked.has(key) || undefined}
            data-types={(side === 'dest' && fit?.could.get(key)?.join(' ')) || undefined}
            role="button"
            tabIndex={0}
            aria-label={nameOf(key)}
            data-dragging={drag.liftedId === liftIdOf.get(key) || undefined}
            onPointerDown={drag.onRowPointerDown(liftIdOf.get(key)!)}
            onClick={click(key)}
            onKeyDown={onKey(click(key) ?? (() => undefined), side, i, ordered)}
          >
            {face(key)}
            {ordered && !anyCards && (
              <span className="prompt__card-order">
                <button
                  type="button"
                  aria-label={`move ${nameOf(key)} up`}
                  disabled={i === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    nudge(side, i, i - 1);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`move ${nameOf(key)} down`}
                  disabled={i === keys.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    nudge(side, i, i + 1);
                  }}
                >
                  ↓
                </button>
              </span>
            )}
          </li>
        ))}
      </Tag>
    );
    return (
      <section aria-label={name} data-short={(side === 'dest' && destShort) || undefined}>
        <h4 className="prompt__col-head">
          {name}
          {side === 'dest' && exact !== null && (
            <>
              {' '}
              <span className="zone__count" data-testid="zone-count">
                {lists[side].length}/{exact}
              </span>
            </>
          )}
        </h4>
        {side === 'dest' && oneEach !== undefined && (
          <ul className="zone__types">
            {oneEach.map(({ type }) => (
              <li
                key={type}
                className="zone__type"
                data-testid="zone-type"
                data-type={type}
                data-filled={fit?.filled.has(type) || undefined}
                data-could={open.has(type) || undefined}
              >
                {type} <span className="zone__count">{fit?.filled.has(type) ? 1 : 0}/1</span>
              </li>
            ))}
          </ul>
        )}
        {anyCards ? (
          <div className="prompt__zone-row" data-ghost={ghost?.end}>
            {ghost?.end === 'bottom' && <ZoneGhost destination={ghost} />}
            {list}
            {ghost?.end === 'top' && <ZoneGhost destination={ghost} />}
          </div>
        ) : (
          list
        )}
      </section>
    );
  };

  return (
    <PromptShell method={method} title={titleOf(ask, lookup)} drawnBlock={problems.length > 0} onSubmit={submit} effectText={!anyCards}>
      {ask.referenceCard !== null && <p className="prompt__hint">For {refName(lookup, ask.referenceCard)}</p>}
      <div className={anyCards ? 'prompt__zones' : 'prompt__dual'} data-one={single || undefined}>
        {!single && zone('source')}
        {zone('dest')}
      </div>
      {ask.showRememberCheckbox && (
        <label className="prompt__hint">
          <input type="checkbox" data-testid="zone-remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this order
        </label>
      )}
    </PromptShell>
  );
}

export function OrderPrompt({ ask, onAnswer, lookup }: PromptProps<'order'>) {
  return <ZonesSheet ask={ask} method="order" lookup={lookup} onReply={(reply) => onAnswer(checkedReply('order', reply))} />;
}

/**
 * `manipulateCardList` (`PlayerControllerHuman.arrangeForMove`): the cards it may move, in a
 * Top zone and a Bottom zone of the library — every one on top to start with, as the ask has
 * them. The answer is the whole pile: the Top zone, the cards that may not move as they were,
 * then the Bottom zone. An end the ask does not offer takes no card.
 */
export function ManipulateCardListPrompt({ ask, onAnswer, lookup }: PromptProps<'manipulateCardList'>) {
  const movable = new Set(ask.manipulable.map((c) => c.id));
  const cards = ask.cards.filter((c) => movable.has(c.id));
  const n = cards.length;
  const toBottom = ask.toBottom || ask.toAnywhere;
  const asOrder: OrderAsk = {
    kind: 'ask',
    callId: ask.callId,
    method: 'order',
    title: ask.title,
    top: ask.title,
    remainingObjectsMin: toBottom ? 0 : n,
    remainingObjectsMax: n,
    sourceChoices: cards.map((c) => ({ key: String(c.id), label: '', ref: c })),
    destChoices: [],
    referenceCard: null,
    sideboardingMode: false,
    showRememberCheckbox: false,
    destination: { zone: 'library', end: 'bottom', first: 'top' },
    rest: { zone: 'library', end: 'top', first: 'top' },
  };
  const byId = new Map(ask.cards.map((c) => [String(c.id), c]));
  return (
    <ZonesSheet
      ask={asOrder}
      method="manipulateCardList"
      lookup={lookup}
      onReply={(reply) => {
        const fixed = ask.cards.filter((c) => !movable.has(c.id));
        const pile = [...(reply.rest ?? []).map((k) => byId.get(k)!), ...fixed, ...reply.ordered.map((k) => byId.get(k)!)];
        onAnswer(checkedReply('manipulateCardList', pile));
      }}
    />
  );
}
