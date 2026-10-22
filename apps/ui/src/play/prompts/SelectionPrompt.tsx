/*
 * The off-board picker and the on-board pop-up — W18's soft-lock (Relentless
 * Dead's graveyard target) and W16 (Worldbreaker's — really World Breaker's
 * — cast trigger, never explained).
 *
 * Forge names a SELECTION through `setSelectables(cards, min, max)`
 * (`../live/match.ts`'s module header has the full citation chain), never
 * through one of the fourteen blocking `ask` methods this directory
 * dispatches via `index.ts`. A selection has no `callId` and nothing to
 * `onAnswer`: answering it is a CLICK — `selectCard`, the exact sender every
 * ordinary board click already uses. So this file does not touch
 * `PromptProps`/`onAnswer` at all; `onPick` below is a plain callback, and
 * `LiveBoard.tsx` (lane L) is the one place that turns a pick into a
 * `selectCard` act, exactly as it already turns a board click into one.
 *
 * ## Why a popup at all
 *
 * The board already lets a player click a card that is ON a battlefield —
 * that is what `selectable`/`boardInteraction` already draw (`../live/match.ts`).
 * This component exists for what the board cannot show a click target for,
 * and for the text no selection has ever shown at all. Both halves are
 * measured against a real jar (`offboard.jvm.test.ts`, `worldbreaker.jvm.test.ts`),
 * not assumed:
 *
 *  - **off-board** (W18, the soft-lock). Relentless Dead's second dies
 *    trigger targets "another target Zombie creature card … from your
 *    graveyard" (`forge-gui/res/cardsfolder/r/relentless_dead.txt`). With
 *    exactly ONE legal Zombie in the graveyard Forge's own `TargetSelection`
 *    picks it with no wire frame at all — nothing to reproduce. With TWO,
 *    the real jar sends `setSelectables({cards:[two graveyard ids]}, min:1,
 *    max:1)` — the soft-lock's exact shape, neither id on any battlefield.
 *    `classifySelection` returns `'off-board'` whenever ANY named id is not
 *    currently on a battlefield this client can draw, and the whole offer
 *    is shown here — cards already on the board included — so the player
 *    picks from one place instead of some cards being clickable on the
 *    table and others only in a popup.
 *  - **on-board** (W16, World Breaker). *"i played worldbreaker and it went
 *    on the stack. but the effect that i'm choosing was never explained to
 *    me."* Measured: casting World Breaker sends `setSelectables` naming
 *    every land on EITHER battlefield (`ValidTgts$ Artifact,Enchantment,Land`
 *    has no `+Other`) — every one of those ids is already a battlefield
 *    permanent, so `classifySelection` reads this as `'on-board'`, not
 *    `'off-board'`: the table's own highlight already offers a click on
 *    each. What was actually missing is that NEITHER an on-board selection
 *    NOR (before the fourteen asks existed) any ask showed Forge's own
 *    prompt line as a titled pop-up; `match.prompt` only ever reached the
 *    collapsed log (`LiveBoard.tsx`'s `live__says`). Mounting
 *    `SelectionPrompt` for `'on-board'` too is the fix: it gives the
 *    board's own highlight a titled sheet with Forge's own words — the
 *    question ("Select target artifact, enchantment or land") as its title
 *    and the ability's text ("When you cast this spell, exile target
 *    artifact, enchantment, or land. […]") on its own line under it, as the
 *    bridge splits Forge's one string (`promptLines`) — the same shape every
 *    other decision already has.
 *
 * ## No yes/no kind
 *
 * A "you may sacrifice …" cost (Sanctum of Ugin) does not reach the wire as a
 * selection: Forge asks it through the ordinary bar confirm, which
 * `isConfirmPrompt`/`ConfirmPrompt.tsx` handles
 * (`sanctum-worldbreaker.jvm.test.ts`).
 */

import { useEffect, useRef, useState } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { PickChoice, PromptShell, promptThumb, promptTileFor } from './PromptShell.tsx';
import { promptText, type PromptLookup } from './lookup.ts';

/** `LiveSelectables`'s shape, read structurally so this file does not import lane L's `../live/match.ts`. */
export interface SelectionLike {
  cards: ReadonlySet<number> | readonly number[];
  min: number;
  max: number;
}

export type SelectionKind = 'none' | 'off-board' | 'on-board';

/**
 * Which decision-area treatment an open selection needs. `boardCardIds` is
 * every id the board itself can currently draw a clickable tile for — lane
 * L's own `match.view`'s permanents, battlefield only (a hand or a graveyard
 * pile is not drawn as a clickable target today).
 */
export function classifySelection(selection: SelectionLike | null, boardCardIds: ReadonlySet<number>): SelectionKind {
  if (selection === null) return 'none';
  const ids = [...selection.cards];
  if (ids.length === 0) return 'none';
  return ids.some((id) => !boardCardIds.has(id)) ? 'off-board' : 'on-board';
}

interface SelectionButton {
  label: string;
  enabled: boolean;
  onClick: () => void;
}

export interface SelectionPromptProps {
  /**
   * Forge's own prompt line (`match.prompt`) — no invented title (W3: "i hate
   * this stupid ai prose"). This component runs it through `plainRulesText`
   * itself (Y18 — a raw `ValidTgts$` expression, `InputSelectTargets.
   * showMessage()`'s own `tgt.getVTSelection()`, can reach this same line),
   * so a caller may pass the line verbatim or already-translated — both read
   * the same, because a string with no raw token in it passes through
   * `plainRulesText` unchanged.
   */
  message: string;
  /** The ability text the question needs under it (`promptLines`), or null when it stands alone. */
  context?: string | null;
  /** The card the selection is for (`showPromptMessage.card`), drawn beside the question. */
  source?: number | null;
  /** `selection.cards`, in Forge's own order. */
  cards: readonly number[];
  lookup: PromptLookup;
  /**
   * Already registered this round — `setHighlighted`'s marks (`../live/match.ts`
   * module header: a mark is not an offer, but it is what Forge has accepted
   * so far). A redraw never loses it because it comes from `match.highlighted`,
   * not local state.
   */
  picked: ReadonlySet<number>;
  /** A card still named by the selection and not yet spent. */
  onPick: (id: number) => void;
  /** Forge's own bar, unchanged — "Done" only while `min` allows stopping now ("you may…"). */
  done?: SelectionButton;
  /** Forge's own Cancel, unchanged — present only while Forge enabled it. */
  cancel?: SelectionButton;
}

/**
 * The grid for `'off-board'` and `'on-board'`. Every named card is a tile —
 * art and name, the board's own `CardTile` (operator, wave 20: *"prompts are
 * cards"*) — clicking one calls `onPick` directly: a selection click answers
 * Forge immediately, it does not stage an answer for a later submit the way
 * the fourteen asks' multi-choice prompts do (`ChoicePrompts.tsx`'s own
 * header marks that difference). `done`/`cancel` are Forge's own two bar
 * buttons, drawn here instead of on the bar (T4's precedent: the decision
 * area owns a question once one is open) — never drawn when Forge has not
 * enabled them.
 */
export function SelectionPrompt({ message: rawMessage, context = null, source = null, cards, lookup, picked, onPick, done, cancel }: SelectionPromptProps) {
  const message = promptText(rawMessage);
  /*
   * A double click (`PickChoice`): pick the card and press Done. The picks are
   * Forge's, so both wait on Forge — Done is pressed once the card is among
   * the picks AND Forge has enabled Done, which it does only for a legal set;
   * a set that is not legal yet stays picked for the player to finish. Any
   * later pick withdraws it. A one-pick selection is answered by the pick
   * itself and never gets this far.
   */
  const [confirming, setConfirming] = useState<number | null>(null);
  /** The card the last single click toggled, and whether that click took it OUT of the picks. */
  const lastPick = useRef<{ id: number; unpicked: boolean } | null>(null);
  const pick = (id: number) => {
    lastPick.current = { id, unpicked: picked.has(id) };
    setConfirming(null);
    onPick(id);
  };
  const confirm = (id: number) => {
    // The double click's first click un-picked a card that was already picked: pick it back.
    if (lastPick.current?.id === id && lastPick.current.unpicked) onPick(id);
    lastPick.current = null;
    setConfirming(id);
  };
  const pressDone = confirming !== null && picked.has(confirming) && done !== undefined && done.enabled ? done.onClick : null;
  useEffect(() => {
    if (pressDone === null) return;
    setConfirming(null);
    pressDone();
  }, [pressDone]);
  // The question is the title; the ability's text, where the question needs it, is the line
  // under it (`promptLines`). Drawn in `PromptShell`, so a selection's sheet is every other
  // decision area question's sheet.
  return (
    <PromptShell
      method="selection"
      title={message}
      label={rawMessage}
      context={context === null ? null : promptText(context)}
      face={source === null ? undefined : promptThumb(lookup, { kind: 'card', id: source }, 'prompt-source')}
      actions={[
        done !== undefined && (
          <button key="done" type="button" className="prompt__submit" data-testid="selection-done" disabled={!done.enabled} onClick={done.onClick}>
            {done.label}
          </button>
        ),
        cancel !== undefined && (
          <button key="cancel" type="button" data-testid="selection-cancel" disabled={!cancel.enabled} onClick={cancel.onClick}>
            {cancel.label}
          </button>
        ),
      ]}
    >
      <ul className="prompt__cards" data-testid="prompt-cards">
        {cards.map((id) => {
          // `promptTileFor` already falls back to `card #<id>` as the
          // tile's own name when the lookup knows nothing — a second,
          // separate "unknown card" tag would say the same fact twice.
          const tile = promptTileFor(lookup, id);
          return (
            <li key={id} data-card-id={id}>
              <PickChoice type="checkbox" data={{ 'data-card-id': id }} checked={picked.has(id)} onPick={() => pick(id)} onConfirm={() => confirm(id)}>
                <CardTile card={tile} />
              </PickChoice>
            </li>
          );
        })}
      </ul>
    </PromptShell>
  );
}
