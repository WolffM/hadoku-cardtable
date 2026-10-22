/*
 * A Constructed room's mode: Classic, Gauntlet or All Random (the operator,
 * 2026-10-21). The create form offers it as an optional pick and the room's
 * first row offers it to the leader; everybody else sees the same row,
 * disabled. Picking another card is how the mode changes, until somebody
 * readies (the server then answers `mode-locked`).
 *
 * While no mode is chosen the row is the room, so it is drawn large, each mode
 * its name over its art (`./modeArt.ts`); once one is chosen it is the compact row beside that
 * mode's options, and each card grows or shrinks into its new size in one
 * continuous animation of the card itself (`morph` below) (the
 * operator, 2026-10-21: "can we use a prettier visual for the 'Classic',
 * 'Gauntlet', 'All Random' buttons? something bigger, then animate to the
 * smaller buttons we have now").
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConstructedMode, RoomMode } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../../components/RadioCards.tsx';
import { modeArtUrl } from './modeArt.ts';

export const MODE_CARDS: readonly RadioCard<ConstructedMode>[] = [
  { value: 'classic', label: 'Classic', art: modeArtUrl('classic') },
  { value: 'gauntlet', label: 'Gauntlet', art: modeArtUrl('gauntlet') },
  { value: 'random', label: 'All Random', art: modeArtUrl('random') },
];

/**
 * A mode as it is first chosen, before its options row has been touched:
 * Classic and Gauntlet need none (a Gauntlet with neither family nor era is a
 * random era), and All Random starts on the whole library.
 */
export function freshRoomMode(mode: ConstructedMode): RoomMode {
  return mode === 'random' ? { mode, modeOptions: { pool: 'full' } } : { mode, modeOptions: {} };
}

/** How long a size change takes, and its curve. */
export const MORPH_MS = 420;
const MORPH_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** Whether this page may animate the change: the browser animates elements, and the person has not asked for less motion. */
function canMorph(): boolean {
  return typeof Element.prototype.animate === 'function' && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Everything a card's look is made of that differs between the sizes, read off the page. */
interface CardLook {
  box: Keyframe;
  label: Keyframe;
  art: Keyframe | null;
}

interface RowLook {
  width: number;
  height: number;
  cards: CardLook[];
}

const cardsOf = (group: HTMLElement): HTMLElement[] => [...group.querySelectorAll<HTMLElement>(':scope > .radio-cards__card')];

function look(group: HTMLElement): RowLook {
  const origin = group.getBoundingClientRect();
  return {
    width: origin.width,
    height: origin.height,
    cards: cardsOf(group).map((card) => {
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const label = card.querySelector('.radio-cards__label');
      const labelStyle = label === null ? null : getComputedStyle(label);
      const art = card.querySelector('.radio-cards__art');
      return {
        box: {
          left: `${rect.left - origin.left}px`,
          top: `${rect.top - origin.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          padding: style.padding,
          borderRadius: style.borderRadius,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          color: style.color,
        },
        label: labelStyle === null ? {} : { fontSize: labelStyle.fontSize, fontWeight: labelStyle.fontWeight, textShadow: labelStyle.textShadow },
        art: art === null ? null : { opacity: getComputedStyle(art).opacity },
      };
    }),
  };
}

/**
 * One animation from the row as it was to the row as it is now: every card moves and
 * resizes from its old box to its new one, its colours, corners and padding blend, its
 * name changes size, its art fades, and the row's own height follows, so the room's box
 * around it moves with the cards. The cards are placed by the animation while it runs
 * (`data-morphing` on `host`, an element React never rewrites), and handed back to the
 * row's layout, which is where they end, when it finishes. No snapshot of either size is
 * ever drawn, so nothing is stretched and nothing is waited for.
 */
function morph(host: HTMLElement, group: HTMLElement, from: RowLook, to: RowLook): void {
  const timing: KeyframeAnimationOptions = { duration: MORPH_MS, easing: MORPH_EASING, fill: 'forwards' };
  const cards = cardsOf(group);
  if (cards.length !== from.cards.length || cards.length !== to.cards.length) return;
  host.dataset.morphing = '';
  const running = [
    group.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }], timing),
    ...cards.flatMap((card, i) => {
      const a = from.cards[i]!;
      const b = to.cards[i]!;
      const label = card.querySelector('.radio-cards__label');
      const art = card.querySelector('.radio-cards__art');
      return [
        card.animate([a.box, b.box], timing),
        ...(label === null ? [] : [label.animate([a.label, b.label], timing)]),
        ...(art === null || a.art === null || b.art === null ? [] : [art.animate([a.art, b.art], timing)]),
      ];
    }),
  ];
  const handBack = (): void => {
    delete host.dataset.morphing;
    for (const animation of running) animation.cancel();
  };
  void Promise.all(running.map((animation) => animation.finished)).then(handBack, handBack);
}

export function ModeRow({
  mode,
  disabled,
  gauntletDisabled = false,
  onChoose,
}: {
  mode: ConstructedMode | null;
  disabled: boolean;
  /**
   * Gauntlet alone, off limits — the server's `tournament-mode-unsupported`
   * (a per-table Gauntlet-state follow-up lane's own gap): a Constructed
   * room with its Tournament setting on refuses a move to Gauntlet, so the
   * leader never gets the chance to send one. Classic and All Random are
   * unaffected.
   */
  gauntletDisabled?: boolean;
  onChoose: (mode: ConstructedMode) => void;
}) {
  // The size drawn, which follows `mode` a step behind so the old layout can be read before it changes.
  const [large, setLarge] = useState(mode === null);
  const wantLarge = mode === null;
  const host = useRef<HTMLDivElement>(null);
  const groupOf = (): HTMLElement | null => host.current?.querySelector<HTMLElement>('.radio-cards') ?? null;
  /** The row as it looked before a size change React has not drawn yet. */
  const before = useRef<RowLook | null>(null);
  // Read the old layout, then ask for the new one.
  useEffect(() => {
    if (large === wantLarge) return;
    const group = groupOf();
    before.current = group !== null && canMorph() ? look(group) : null;
    setLarge(wantLarge);
  }, [large, wantLarge]);
  // The new layout is on the page and not yet painted: animate from the old one to it.
  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    const group = groupOf();
    if (from === null || group === null || host.current === null) return;
    morph(host.current, group, from, look(group));
  }, [large]);
  return (
    // `display: contents`: the row's own layout is the room's, this element is only a handle to find the cards by.
    <div ref={host} style={{ display: 'contents' }}>
      <RadioCards
        name="constructed-mode"
        label="Mode"
        options={gauntletDisabled ? MODE_CARDS.map((c) => (c.value === 'gauntlet' ? { ...c, disabled: true } : c)) : MODE_CARDS}
        value={mode}
        disabled={disabled}
        onChange={onChoose}
        testId="constructed-mode"
        size={large ? 'large' : 'small'}
      />
    </div>
  );
}
