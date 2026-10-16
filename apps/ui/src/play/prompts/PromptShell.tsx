/*
 * The frame every prompt draws in: a title, Forge's message, the body, the
 * reasons the current answer cannot be sent yet, and the buttons. The ask
 * prompts and the selection sheet (`SelectionPrompt.tsx`) both draw in it, so
 * `prompts.css`'s three-part column — the body the only part that scrolls, the
 * buttons pinned under it — holds for every sheet.
 *
 * The submit button is disabled while `problems` is non-empty, and `problems`
 * always comes from `rules.ts`. That is the whole enforcement story: the rules
 * are pure and tested on their own, and the shell makes them the only way out.
 *
 * This is also where the lane's one shared piece lives: `promptCardTile`, the
 * card-as-tile every prompt below renders (operator, wave 20: *"prompts are
 * cards"* — a tutor choice is the board's card look, never a text list).
 */

import { createContext, useContext, useState, type MouseEvent, type ReactNode } from 'react';

import { CardTile } from '../../components/CardTile.tsx';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import { PlayerMark } from '../marks.tsx';
import type { DraftCard } from '@hadoku/shared';
import type { AskSource } from '@hadoku/forge-wire';

import './prompts.css';
import { plainRulesText, type PromptLookup } from './lookup.ts';
import { RulesText } from './RulesText.tsx';
import type { PromptMethod } from './types.ts';

export interface PromptShellProps {
  /** `data-prompt`: the ask's method, or `selection` for Forge's `setSelectables` sheet. */
  method: PromptMethod | 'selection';
  title: string;
  /** The dialog's accessible name when it is more than the title (a selection's whole prompt line). */
  label?: string;
  message?: ReactNode;
  problems?: readonly string[];
  /**
   * For a sheet whose body DRAWS why it cannot be answered yet instead of
   * writing it (the damage window's pool): OK is disabled while this is true,
   * and no reason line is written or reserved.
   */
  drawnBlock?: boolean;
  submitLabel?: string;
  /** Omit for a prompt that answers without a button (the zone prompts). */
  onSubmit?: () => void;
  /** Buttons beside submit, e.g. "Decline" on an optional choice. */
  actions?: ReactNode;
  /** The card the whole question is about, drawn beside the title and the message (`promptThumb`). */
  face?: ReactNode;
  children?: ReactNode;
}

/**
 * The card the open ask was raised on behalf of, and Forge's own text for that effect (the
 * bridge's `askSource`: a replacement running, or the stack item resolving), with the lookup that
 * names it. `PromptFor` provides it for every ask, so every sheet draws it the same way without
 * each prompt passing it on: the card as the head's `face` (`promptThumb`) when the prompt has no
 * face of its own, and the effect's text under the title. The operator, 2026-10-15, on Cavern of
 * Souls' creature-type list: *"it should show the effect text of cavern of souls"*.
 */
export const AskSourceContext = createContext<{ source: AskSource; lookup: PromptLookup } | null>(null);

/**
 * The title, broken where Forge already broke it.
 *
 * The operator, 2026-09-28: *"theres no newline here: 'Seat 1 activated Slagstorm
 * - Choose a mode' i think choose a mode should be on its own line."*
 *
 * The STRING is Forge's — it composes `<what happened> - <what you must do>` and
 * hands it over as one line — and the line break is ours to render. So this
 * splits on Forge's own separator, the first spaced hyphen, and draws the two
 * halves as two lines: what happened, quieter, and then the instruction, which is
 * the part the player has to act on.
 *
 * Nothing is added, removed or reworded: `aria-label` on the dialog is still the
 * whole original string, and a title with no separator draws exactly as it did.
 * The separator itself goes, because that is what a line break is for.
 */
const TITLE_SPLIT = /^(.+?) - (.+)$/s;

function PromptTitle({ title }: { title: string }) {
  const split = TITLE_SPLIT.exec(title);
  if (split === null)
    return (
      <h3 className="prompt__title">
        <RulesText text={title} />
      </h3>
    );
  return (
    <h3 className="prompt__title" data-split="">
      <span className="prompt__title-source">
        <RulesText text={split[1]!} />
      </span>
      <span className="prompt__title-task">
        <RulesText text={split[2]!} />
      </span>
    </h3>
  );
}

/** Words compared as a reader compares them: case, spacing and a closing full stop do not count. */
function wordsOf(text: string): string {
  return plainRulesText(text).toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

/**
 * The ask's effect line as the sheet draws it, or null when it would say nothing new.
 *
 * The stack's own description leads with the card's name (`Ponder - Look at the top 3 cards …`);
 * when the head draws that card (`drawsCard`) the name is said once, by the card, and the line
 * keeps only the effect. And Forge often writes the effect into the question itself — an optional
 * trigger asks *"Use triggered ability of X? (When X enters, …)"* — so a title, dialog label or
 * plain-text message that already holds the effect leaves no line at all.
 */
function effectLine(asked: { source: AskSource; lookup: PromptLookup }, drawsCard: boolean, words: readonly ReactNode[]): string | null {
  const { text: said } = asked.source;
  const name = asked.lookup.card(asked.source.card.id)?.name;
  const lead = name === undefined ? '' : `${name} - `;
  const named = lead !== '' && said.toLowerCase().startsWith(lead.toLowerCase());
  const text = (named ? said.slice(lead.length) : said).trim();
  const effect = wordsOf(text);
  if (effect === '' || words.some((w) => typeof w === 'string' && wordsOf(w).includes(effect))) return null;
  return drawsCard ? text : said;
}

export function PromptShell({
  method,
  title,
  label,
  message,
  problems = [],
  drawnBlock,
  submitLabel = 'OK',
  onSubmit,
  actions,
  face,
  children,
}: PromptShellProps) {
  const asked = useContext(AskSourceContext);
  const head = face ?? (asked === null ? undefined : promptThumb(asked.lookup, asked.source.card, 'prompt-source'));
  const said = asked === null ? null : effectLine(asked, face === undefined, [title, label, message]);
  const effect = said === null ? null : (
    <p className="prompt__source" data-testid="prompt-source-text">
      <RulesText text={said} />
    </p>
  );
  return (
    <section className="prompt" data-prompt={method} role="dialog" aria-label={plainRulesText(label ?? title)}>
      {head === undefined ? (
        <>
          <PromptTitle title={title} />
          {message !== undefined && message !== '' && <p className="prompt__message">{message}</p>}
        </>
      ) : (
        <div className="prompt__head">
          {head}
          <div className="prompt__head-text">
            <PromptTitle title={title} />
            {effect}
            {message !== undefined && message !== '' && <p className="prompt__message">{message}</p>}
          </div>
        </div>
      )}
      <div className="prompt__body">{children}</div>
      {/*
       * Kept in the layout, empty, on any sheet with an OK: the sheet is centred
       * in its host, so a reason line coming and going moved every row under the
       * pointer — the second click of a double click landed beside the row it
       * meant (measured on a real Cryptic Command's mode sheet).
       */}
      {((onSubmit !== undefined && drawnBlock === undefined) || problems.length > 0) && (
        <ul className="prompt__problems" data-testid="prompt-problems" data-empty={problems.length === 0 || undefined} aria-live="polite">
          {problems.length === 0 ? (
            <li aria-hidden="true">{'\u00a0'}</li>
          ) : (
            problems.map((p) => <li key={p}>{p}</li>)
          )}
        </ul>
      )}
      {(onSubmit !== undefined || actions !== undefined) && (
        <div className="prompt__actions">
          {actions}
          {onSubmit !== undefined && (
            <button
              type="button"
              className="prompt__submit"
              data-testid="prompt-submit"
              disabled={problems.length > 0 || drawnBlock === true}
              onClick={onSubmit}
            >
              {submitLabel}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A card a prompt was asked about, as the board's own `CardTile` draws it.
 *
 * An ask never carries a card — it carries a `{ kind: 'card', id }` ref and the
 * name and printing come from `lookup.ts` — so the tile is built here from
 * those two facts, and the art is resolved exactly as the board resolves it:
 * through the w19 art-id table (`adapter.ts`'s `KNOWN_ART_IDS`,
 * `@hadoku/carddata/art`) by `scryfallIdFor(index, name, setCode)`, then by
 * `CardTile` → `cardImageUrl`. No prompt names an image host, and none ever
 * builds a URL.
 *
 * **The `setCode` argument is wave 24 §D.3.** It used to be `''` here, so a
 * prompt tile could only ever hit the table's bare-name row while the board hit
 * `Name|SET` first — the same card, two printings, and nothing at all for a
 * card whose only row is the exact printing. `PromptCardFacts.setCode` now
 * carries Forge's own `SetCode` for the face on show, so a prompt and the board
 * ask the table the same question and get the same answer.
 *
 * What the board has and this has not — cost, type line, oracle text, stats —
 * the lookup does not carry (it is a prompt's seam, not a board's). The tile
 * shows the name and, when the table knows the card, its art; a card the table
 * does not know draws the text tile, which is the same fallback the board
 * makes. Nothing here invents a fact the wire did not send.
 *
 * `cardId` is `w<forge id>` on purpose: that is the draft's namespace
 * `CardTile` stamps its own `data-card-id` in, which the DOM contract
 * (`Board.tsx`) already accounts for — the prompt's tile wrapper carries the
 * bare forge id beside it.
 *
 * **`name` is the card's IDENTITY; `label` is what the tile SAYS (wave 25 §F).**
 * They were one argument until now, and that is the whole of the reported bug:
 * for a reveal Forge pre-renders each option with `CardView.toString()` —
 * `zoneText + name + " (" + id + ")"` (`CardView.java:1214-1232`) — so the
 * caller's label is `Mox Opal (130)`, and an art key built from THAT matches no
 * row in the table. The art is looked up on `name`/`setCode`, which come from
 * the card's own facts and nothing else; `label`, when a caller has one, only
 * replaces the words on the tile.
 */
export function promptCardTile(forgeId: number, name: string, setCode = '', label?: string): DraftCard {
  const card: DraftCard = {
    cardId: `w${forgeId}`,
    // What the tile says. Forge's own wording wins where a caller has it — it
    // may carry a zone or a qualifier the lookup cannot know — but it is never
    // the key the art is resolved by.
    name: label ?? name,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: '',
    oracleText: '',
    setCode,
    collectorNumber: '',
    // The rarity letter the board's tiles draw for a card whose rarity the
    // wire did not carry (`adapter.ts` maps unknown the same way).
    rarity: 'special',
  };
  const scryfallId = scryfallIdFor(KNOWN_ART_IDS, name, setCode);
  if (scryfallId !== undefined) card.scryfallId = scryfallId;
  return card;
}

/**
 * The tile for a card an ask named, built from the lookup alone — the one place
 * a prompt turns a `{ kind: 'card', id }` into a face.
 *
 * Every card-drawing prompt goes through this rather than reaching for the
 * name and the set code separately, so "a prompt resolves art the way the board
 * does" is one function instead of a convention.
 *
 * ## A tile's name is not its label (wave 25 §F)
 *
 * `label` is Forge's pre-rendered wording for the asks that have one —
 * `getChoices` (so: every `reveal`, `AbstractGuiGame.java:786`) and `order`,
 * both of which reach `PlayBridge`'s `choices()` with a null display function
 * and therefore label each option `String.valueOf(item)`, i.e.
 * `CardView.toString()`. This function used to hand that string on as the card's
 * NAME, so the art key became `Mox Opal (130)` and every revealed card drew the
 * text tile with no art at all — the operator's report, and the `(130)` in the
 * name was its fingerprint.
 *
 * So: **identity comes from the lookup, the label is display only.** The art key
 * is the card's own `Name`/`SetCode`, exactly as `adapter.ts` builds it for the
 * board, and it is the same whether a caller passed a label or not.
 *
 * The lookup does hold those facts for a revealed card: Forge calls
 * `tempShowCards` → `addMayLookTemp` before revealing
 * (`PlayerControllerHuman.java:182-195`), so the card projects as `full` to the
 * seat being shown it — measured against the real jar in
 * `../live/prompts.jvm.test.ts` (§F.2), which prints what the lookup held for
 * every id a reveal labelled.
 *
 * When the lookup knows nothing, the label is the only name there is. The tile
 * still says it verbatim, but the identity is the label with Forge's decoration
 * removed (`nameFromForgeLabel`), so the art resolves on the bare name instead of
 * on `Island (129)`.
 */
export function promptTileFor(lookup: PromptLookup, forgeId: number, label?: string): DraftCard {
  const facts = lookup.card(forgeId);
  const identity = facts?.name ?? (label === undefined ? `card #${forgeId}` : nameFromForgeLabel(label, forgeId));
  return promptCardTile(forgeId, identity, facts?.setCode ?? '', label);
}

/**
 * The card name inside a `CardView.toString()` label: Forge renders
 * `(zoneText + ' ' + name + " (" + id + ")").trim()` (`CardView.java:1215-1233`),
 * where `zoneText` is a bracketed `[Main game: Library]` only for a card in a
 * subgame's sideboard (`CardView.java:1189-1211`). The suffix is stripped only
 * when its id is this card's own, so a label that merely ends in a parenthesis is
 * left alone.
 */
export function nameFromForgeLabel(label: string, forgeId: number): string {
  const suffix = ` (${forgeId})`;
  if (!label.endsWith(suffix)) return label;
  return label.slice(0, -suffix.length).replace(/^\[[^\]]*\] /, '');
}

/**
 * A row's face: the board's `CardTile` when it stands for a card, the words
 * otherwise. `OrderPrompt`'s dual list (a mix of cards and abilities) and
 * `ManipulateCardListPrompt`'s pile (always cards) shared this by hand (T5) —
 * the pile just never takes the words branch.
 */
export function cardOrWordsFace(lookup: PromptLookup, cardId: number | undefined, label?: string): ReactNode {
  if (cardId !== undefined) return <CardTile card={promptTileFor(lookup, cardId, label)} />;
  return <span className="prompt__item">{label}</span>;
}

/**
 * A card or a player a prompt names, as a small face: the board's own
 * `CardTile` (art through the same lookup as every prompt tile,
 * `promptTileFor`) or the seat's own `PlayerMark`. The wrapper carries the bare
 * forge id, so hovering it opens the one expanded card view as a grid tile does.
 */
export function promptThumb(lookup: PromptLookup, ref: { kind: string; id: number }, testId?: string): ReactNode {
  if (ref.kind === 'player') {
    return (
      <span className="prompt__thumb" data-thumb="player" data-player-id={ref.id} data-testid={testId}>
        <PlayerMark />
      </span>
    );
  }
  return (
    <span className="prompt__thumb" data-thumb="card" data-card-id={ref.id} data-testid={testId}>
      <CardTile card={promptTileFor(lookup, ref.id)} />
    </span>
  );
}

/**
 * One answer button in a row of them — `showOptionDialog`'s options,
 * `confirm`'s yes/no (`DialogPrompts.tsx`) and `GetAbilityToPlayPrompt`'s
 * abilities (`ChoicePrompts.tsx`) rendered this same shape under three
 * separate hands before T1 folded them into one. The content (plain text, a
 * `ManaPip`, `RulesText`) and the markers that make sense for it are the
 * caller's; this owns only the button itself.
 */
export function OptionButton({
  testId,
  className,
  dataDefault,
  dataAnswer,
  autoFocus,
  ariaLabel,
  onClick,
  children,
}: {
  testId: string;
  className?: string;
  /** `data-default` — Forge's own default for this ask, where one exists. */
  dataDefault?: boolean;
  /** `data-answer` — `confirm`'s own true/false shape, read by `LiveBoard.test.ts`. */
  dataAnswer?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      data-default={dataDefault || undefined}
      data-answer={dataAnswer}
      aria-label={ariaLabel}
      autoFocus={autoFocus === true}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** `item` ticked or unticked; a one-pick list holds at most the one. */
export function togglePick<T>(list: readonly T[], item: T, single: boolean): T[] {
  if (list.includes(item)) return list.filter((x) => x !== item);
  return single ? [item] : [...list, item];
}

/**
 * The picks of a pick-then-OK prompt, and the two ways to answer with them.
 *
 * `submit` is the OK button: the picks as they stand. `confirm` is a double
 * click on one row (the operator, 2026-10-13: *"double click to confirm without
 * needing to click ok"*): the picks WITH that row — the row alone in a one-pick
 * list — answer at once when `problemsOf` has nothing against them, and
 * otherwise stay picked for the player to finish, so a double click never sends
 * what OK would refuse. `answer` is the prompt's own reply for a set of picks.
 */
export function usePicks<T>(
  initial: () => T[],
  single: boolean,
  problemsOf: (picks: readonly T[]) => readonly string[],
  answer: (picks: readonly T[]) => void,
) {
  const [chosen, setChosen] = useState<T[]>(initial);
  return {
    chosen,
    setChosen,
    problems: problemsOf(chosen),
    pick: (item: T) => setChosen((prev) => togglePick(prev, item, single)),
    submit: () => answer(chosen),
    confirm: (item: T) => {
      const next = single ? [item] : chosen.includes(item) ? chosen : [...chosen, item];
      if (problemsOf(next).length === 0) answer(next);
      else setChosen(next);
    },
  };
}

/**
 * One pickable row of a prompt: the tick (`prompt-choice`, a checkbox or a
 * radio) and the row's face in one `<label>`, so a click anywhere on the face
 * ticks it.
 *
 * A double click is `onConfirm`. Its first click ticks the row as any click
 * does; the second click of the pair is not a second toggle (it would untick
 * what the first just ticked), so the row stays picked for `onConfirm` to answer
 * with. Nothing here drags, so the ordering prompts' row drag is untouched.
 */
export function PickChoice({
  type,
  checked,
  onPick,
  onConfirm,
  data,
  children,
}: {
  type: 'checkbox' | 'radio';
  checked: boolean;
  onPick: () => void;
  onConfirm: () => void;
  /** The input's own `data-*` markers (`data-key`, `data-ref`, `data-card-id`). */
  data: Record<`data-${string}`, string | number>;
  children: ReactNode;
}) {
  return (
    <label
      onClick={(e: MouseEvent) => {
        if (e.detail > 1) e.preventDefault();
      }}
      onDoubleClick={onConfirm}
    >
      <input type={type} name={type === 'radio' ? 'prompt-single' : undefined} data-testid="prompt-choice" {...data} checked={checked} onChange={onPick} />
      {children}
    </label>
  );
}
