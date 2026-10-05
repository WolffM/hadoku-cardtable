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
 *    board's own highlight a titled sheet with Forge's own words
 *    ("World Breaker (81) - When you cast this spell, exile target
 *    artifact, enchantment, or land. […]\n\nSelect target artifact,
 *    enchantment or land" — Forge's own text, verbatim, already on the
 *    wire), the same shape every other decision already has.
 *
 * ## No yes/no kind
 *
 * A "you may sacrifice …" cost (Sanctum of Ugin) does not reach the wire as a
 * selection: Forge asks it through the ordinary bar confirm, which
 * `isConfirmPrompt`/`ConfirmPrompt.tsx` handles
 * (`sanctum-worldbreaker.jvm.test.ts`).
 */

import { CardTile } from '../../components/CardTile.tsx';

import { promptTileFor, PromptTitle } from './PromptShell.tsx';
import type { PromptLookup } from './lookup.ts';

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

export interface SelectionButton {
  label: string;
  enabled: boolean;
  onClick: () => void;
}

export interface SelectionPromptProps {
  /** Forge's own prompt line (`match.prompt`), verbatim — no invented title (W3: "i hate this stupid ai prose"). */
  message: string;
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
export function SelectionPrompt({ message, cards, lookup, picked, onPick, done, cancel }: SelectionPromptProps) {
  // Forge's own selection prompts (`showPromptMessage`) separate the
  // trigger/source line from the instruction with a blank line — the same
  // two-part shape every other prompt's own `title`/`message` fields
  // already are, just not pre-split for us. `PromptTitle` is the existing
  // "<what happened> - <what to do>" line-break rule (`PromptShell.tsx`);
  // reused here rather than re-implemented so a selection's sheet looks
  // like every other decision area question.
  const [title, ...rest] = message.split('\n\n');
  const instruction = rest.join('\n\n');
  return (
    <section className="prompt" data-prompt="selection" role="dialog" aria-label={message}>
      <PromptTitle title={title ?? message} />
      {instruction !== '' && <p className="prompt__message">{instruction}</p>}
      <div className="prompt__body">
        <ul className="prompt__cards" data-testid="prompt-cards">
          {cards.map((id) => {
            // `promptTileFor` already falls back to `card #<id>` as the
            // tile's own name when the lookup knows nothing — a second,
            // separate "unknown card" tag would say the same fact twice.
            const tile = promptTileFor(lookup, id);
            return (
              <li key={id} data-card-id={id}>
                <label>
                  <input
                    type="checkbox"
                    data-testid="prompt-choice"
                    data-card-id={id}
                    checked={picked.has(id)}
                    onChange={() => onPick(id)}
                  />
                  <CardTile card={tile} />
                </label>
              </li>
            );
          })}
        </ul>
      </div>
      {(done !== undefined || cancel !== undefined) && (
        <div className="prompt__actions">
          {cancel !== undefined && (
            <button type="button" className="prompt__link" data-testid="selection-cancel" disabled={!cancel.enabled} onClick={cancel.onClick}>
              {cancel.label}
            </button>
          )}
          {done !== undefined && (
            <button type="button" className="prompt__submit" data-testid="selection-done" disabled={!done.enabled} onClick={done.onClick}>
              {done.label}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
