/*
 * Choosing from a list: `getChoices`, `chooseSingleEntityForEffect`,
 * `chooseEntitiesForEffect`, `getAbilityToPlay`.
 *
 * Forge sends the list and the bounds; these draw it and count. A CARD in the
 * list is a tile — the board's own `CardTile`, art ids and all (operator, wave
 * 20 item 12: a Stoneforge-style tutor choice is a grid of cards, never a
 * concatenated text list). What renders is what the seat was sent: the ids the
 * ask carries, named by `lookup`, and nothing else.
 *
 * Non-cards stay words: `getChoices` over colours keeps its pre-rendered
 * labels, a player keeps their name and the `player` tag, and an ability is a
 * button in plain rules text. The tick that chooses a tile is the tile's
 * border; the input itself stays in the DOM (visually hidden) so the keyboard
 * path and the live driver see exactly what they saw before.
 */

import { useState } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { PromptShell, promptTileFor } from './PromptShell.tsx';
import { isZoneDividerLabel, plainRulesText, refName, type PromptLookup } from './lookup.ts';
import {
  abilityProblems,
  choiceBounds,
  chooseEntitiesProblems,
  chooseSingleProblems,
  getChoicesProblems,
  numericChoiceRange,
  searchRows,
  type NumericChoiceRange,
  type SearchRow,
} from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';
import type { CardRef, EntityRef } from '@hadoku/forge-wire';

function toggle<T>(list: readonly T[], item: T, single: boolean): T[] {
  if (list.includes(item)) return list.filter((x) => x !== item);
  return single ? [item] : [...list, item];
}

/** The card an option stands for, when it stands for one. */
function cardOfOption(ref: EntityRef | null): CardRef | null {
  return ref !== null && ref.kind === 'card' ? ref : null;
}

/**
 * The bound, as a LABEL. Not a sentence: the board states things, it does not
 * explain them (operator, 2026-09-24). `max === 0` is Forge revealing a list
 * rather than asking about it, and says so in one word.
 */
function boundsText(min: number, max: number): string {
  if (max === 0) return 'Revealed';
  if (min === max) return `Choose ${min}`;
  if (min === 0) return `Up to ${max}`;
  return `${min}–${max}`;
}

/**
 * One card in a choosing grid: the tile, stamped with the forge id the ask
 * carried (the wrapper `<li>` carries `data-card-id`; the inspector finds tiles
 * by that value — see the DOM contract at `Board.tsx`). The input that chooses
 * it is rendered by the caller inside the same `<label>`.
 */
function ChoiceTile({ cardRef, lookup, label }: { cardRef: CardRef; lookup: PromptLookup; label?: string }) {
  return <CardTile card={promptTileFor(lookup, cardRef.id, label)} />;
}

/**
 * The face of one row in a choosing list: a card is a tile, a player is their
 * name plus the `player` tag, anything else is the words `lookup` has for it.
 */
function RowFace({ entity, lookup }: { entity: EntityRef; lookup: PromptLookup }) {
  if (entity.kind === 'card') return <ChoiceTile cardRef={entity} lookup={lookup} />;
  return (
    <>
      {refName(lookup, entity)}
      {entity.kind === 'player' && <span className="prompt__tag">player</span>}
    </>
  );
}

/**
 * A row Forge did NOT offer: drawn, in its place, and not selectable.
 *
 * Two signals, never colour alone: no tick (so no border can light up) and the
 * word Forge's own frame implies — it was revealed, not offered. `data-choosable`
 * is what `prompts.css` dims and what `search.jvm.test.ts` reads.
 */
function UnofferedRow({ row, lookup }: { row: SearchRow; lookup: PromptLookup }) {
  return (
    <span className="prompt__tile" data-testid="prompt-unoffered">
      <RowFace entity={row.ref} lookup={lookup} />
      <span className="prompt__tag">not offered</span>
    </span>
  );
}

/**
 * "Choose X" — and `NumTimes`, and a keyword-cost count — as a DRAG, not a
 * radio list (first list item 13). Forge's own choices are the integers
 * `range.min..range.max`; this reads the one chosen (default its minimum, so
 * the slider always shows a value, never the "nothing ticked yet" of a radio
 * list) and answers with that choice's own key, byte-identical to what the
 * radio rendering would have sent.
 *
 * The drag reports a raw integer string (the DOM range input's own `value`);
 * `range.keys[n - range.min]` is what turns that into the wire key Forge
 * actually offered for `n` — measured against a real match (wave 34 §G item
 * 1) to never be the integer itself (`NumericChoiceRange.keys`'s own doc).
 *
 * `range.otherKey`, when Forge's own cutoff sat below its true max, is a
 * plain button beside the slider: picking it sends Forge's "Other…" choice
 * exactly as a click would have (it is already a real key, no translation
 * needed), and the free-text follow-up it provokes is `showInputDialog`,
 * already answered by `DialogPrompts.tsx` — nothing here chains the two asks
 * itself.
 */
function NumberChoiceSlider({
  range,
  value,
  onChange,
}: {
  range: NumericChoiceRange;
  /** The chosen key, or null while the "Other…" entry is the current choice. */
  value: number | null;
  onChange: (key: string) => void;
}) {
  return (
    <div className="prompt__slider">
      <input
        type="range"
        data-testid="prompt-slider"
        min={range.min}
        max={range.max}
        step={1}
        value={value ?? range.min}
        aria-label={`between ${range.min} and ${range.max}`}
        onChange={(e) => onChange(range.keys[Number.parseInt(e.target.value, 10) - range.min]!)}
      />
      <output className="prompt__slider-value" data-testid="prompt-slider-value">
        {value ?? range.min}
      </output>
      {range.otherKey !== undefined && (
        <button
          type="button"
          className="prompt__link"
          data-testid="prompt-slider-other"
          aria-pressed={value === null}
          onClick={() => onChange(range.otherKey!)}
        >
          Other…
        </button>
      )}
    </div>
  );
}

export function GetChoicesPrompt({ ask, onAnswer, lookup }: PromptProps<'getChoices'>) {
  const bounds = choiceBounds(ask.min, ask.max);
  const known = new Set(ask.choices.map((c) => c.key));
  const range = bounds.max > 0 ? numericChoiceRange(ask) : null;
  const [chosen, setChosen] = useState<string[]>(() => {
    const selected = ask.selected.filter((k) => known.has(k));
    // A slider always shows a value; Forge's own default reading for `getInteger`
    // (`AbstractGuiGame.java:791-813`) is the range's minimum — `range.keys[0]`
    // is the WIRE KEY that answers it, never `String(range.min)` (wave 34 §G
    // item 1: Forge's own key is never the integer — see `NumericChoiceRange`).
    if (selected.length === 0 && range !== null) return [range.keys[0]!];
    return selected;
  });
  // Reply in the order Forge listed the options, not the order they were clicked.
  const reply = ask.choices.map((c) => c.key).filter((k) => chosen.includes(k));
  const problems = getChoicesProblems(ask, reply);
  const submit = () => {
    assertAnswerable('getChoices', problems);
    onAnswer(checkedReply('getChoices', reply));
  };

  if (range !== null) {
    const key = chosen[0] ?? null;
    // The key is never the integer (wave 34 §G item 1) — its VALUE is its
    // position in `range.keys`, offset by `range.min`.
    const index = key === null ? -1 : range.keys.indexOf(key);
    const value = index >= 0 ? range.min + index : null;
    return (
      <PromptShell method="getChoices" title={plainRulesText(ask.message)} problems={problems} onSubmit={submit}>
        <NumberChoiceSlider range={range} value={value} onChange={(k) => setChosen([k])} />
      </PromptShell>
    );
  }

  const anyCards = ask.choices.some((c) => cardOfOption(c.ref) !== null);

  return (
    <PromptShell method="getChoices" title={plainRulesText(ask.message)} problems={problems} onSubmit={submit}>
      <p className="prompt__hint">{boundsText(bounds.min, bounds.max)}</p>
      <ul className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid={anyCards ? 'prompt-cards' : undefined}>
        {ask.choices.map((c) => {
          // Y18, second half: `TargetSelection.chooseCardFromList` splices a
          // zone-group marker ("--CARDS ON BATTLEFIELD:--", …) into Forge's
          // own choice list (`lookup.ts`'s own header has the citation chain).
          // Drawn as a rule line between the real groups — never a tick, never
          // counted, never reachable by Tab (`lookup.ts`'s `isZoneDividerLabel`).
          if (c.ref === null && isZoneDividerLabel(c.label)) {
            return <li key={c.key} className="prompt__divider" role="separator" aria-hidden="true" />;
          }
          const cardRef = cardOfOption(c.ref);
          const name = plainRulesText(c.label);
          return (
            <li key={c.key} data-card-id={cardRef !== null ? cardRef.id : undefined}>
              {bounds.max === 0 ? (
                <span className="prompt__tile" data-testid="prompt-choice">
                  {cardRef !== null ? <ChoiceTile cardRef={cardRef} lookup={lookup} label={name} /> : name}
                </span>
              ) : (
                <label>
                  <input
                    type="checkbox"
                    data-testid="prompt-choice"
                    data-key={c.key}
                    checked={chosen.includes(c.key)}
                    onChange={() => setChosen((prev) => toggle(prev, c.key, bounds.max === 1))}
                  />
                  {cardRef !== null ? <ChoiceTile cardRef={cardRef} lookup={lookup} label={name} /> : name}
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </PromptShell>
  );
}

export function ChooseSingleEntityPrompt({ ask, onAnswer, lookup }: PromptProps<'chooseSingleEntityForEffect'>) {
  const [chosen, setChosen] = useState<number | null>(null);
  const reply = chosen === null ? null : (ask.optionList[chosen] ?? null);
  const problems = chooseSingleProblems(ask, reply);
  const submit = () => {
    assertAnswerable('chooseSingleEntityForEffect', problems);
    onAnswer(checkedReply('chooseSingleEntityForEffect', reply));
  };
  // Choosable first, in Forge's order; then what Forge only revealed. One grid,
  // not two — §D.2. `rules.ts` owns the order and the flag.
  const rows = searchRows(ask);
  const anyCards = rows.some((r) => r.ref.kind === 'card');

  return (
    <PromptShell
      method="chooseSingleEntityForEffect"
      title={plainRulesText(ask.title)}
      problems={problems}
      onSubmit={submit}
      submitLabel={reply === null && ask.isOptional ? 'Choose none' : 'OK'}
    >
      <DelayedRevealNote reveal={ask.delayedReveal} lookup={lookup} />
      <ul className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid={anyCards ? 'prompt-cards' : undefined}>
        {rows.map((row) => (
          <li
            key={`${row.ref.kind}:${row.ref.id}`}
            data-card-id={row.ref.kind === 'card' ? row.ref.id : undefined}
            data-choosable={row.choosable ? undefined : 'false'}
          >
            {row.option === null ? (
              <UnofferedRow row={row} lookup={lookup} />
            ) : (
              <label>
                <input
                  type="radio"
                  name="prompt-single"
                  data-testid="prompt-choice"
                  data-ref={`${row.ref.kind}:${row.ref.id}`}
                  checked={chosen === row.option}
                  onChange={() => setChosen(row.option)}
                />
                <RowFace entity={row.ref} lookup={lookup} />
              </label>
            )}
          </li>
        ))}
      </ul>
      {ask.isOptional && chosen !== null && (
        <button type="button" className="prompt__link" onClick={() => setChosen(null)}>
          Clear choice
        </button>
      )}
    </PromptShell>
  );
}

export function ChooseEntitiesPrompt({ ask, onAnswer, lookup }: PromptProps<'chooseEntitiesForEffect'>) {
  const bounds = choiceBounds(ask.min, ask.max);
  const [chosen, setChosen] = useState<number[]>([]);
  const reply = ask.optionList.filter((_, i) => chosen.includes(i));
  const problems = chooseEntitiesProblems(ask, reply);
  const submit = () => {
    assertAnswerable('chooseEntitiesForEffect', problems);
    onAnswer(checkedReply('chooseEntitiesForEffect', reply));
  };
  // Choosable first, then what Forge only revealed — the same one grid §D.2
  // gives the single-choice prompt.
  const rows = searchRows(ask);
  const anyCards = rows.some((r) => r.ref.kind === 'card');

  return (
    <PromptShell method="chooseEntitiesForEffect" title={plainRulesText(ask.title)} problems={problems} onSubmit={submit}>
      <DelayedRevealNote reveal={ask.delayedReveal} lookup={lookup} />
      <p className="prompt__hint">{boundsText(bounds.min, bounds.max)}</p>
      <ul className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid={anyCards ? 'prompt-cards' : undefined}>
        {rows.map((row) => (
          <li
            key={`${row.ref.kind}:${row.ref.id}`}
            data-card-id={row.ref.kind === 'card' ? row.ref.id : undefined}
            data-choosable={row.choosable ? undefined : 'false'}
          >
            {row.option === null ? (
              <UnofferedRow row={row} lookup={lookup} />
            ) : (
              <label>
                <input
                  type="checkbox"
                  data-testid="prompt-choice"
                  data-ref={`${row.ref.kind}:${row.ref.id}`}
                  checked={chosen.includes(row.option)}
                  onChange={() => setChosen((prev) => toggle(prev, row.option!, bounds.max === 1))}
                />
                <RowFace entity={row.ref} lookup={lookup} />
              </label>
            )}
          </li>
        ))}
      </ul>
    </PromptShell>
  );
}

/**
 * "Which ability?" Each ability is a button that answers; "none" is always
 * allowed, as it is in Forge (`CMatchUI.java:1016-1024`, `oneOrNone`, and the
 * popup menu can be dismissed). An ability is not a card — it draws in words,
 * braces said out loud, never a symbol.
 */
export function GetAbilityToPlayPrompt({ ask, onAnswer, lookup }: PromptProps<'getAbilityToPlay'>) {
  const answer = (reply: (typeof ask.abilities)[number] | null) => {
    assertAnswerable('getAbilityToPlay', abilityProblems(ask, reply));
    onAnswer(checkedReply('getAbilityToPlay', reply));
  };
  return (
    <PromptShell
      method="getAbilityToPlay"
      title="Choose ability to play"
      message={refName(lookup, ask.hostCard)}
      actions={
        <button type="button" data-testid="prompt-cancel" onClick={() => answer(null)}>
          None
        </button>
      }
    >
      <ul className="prompt__list">
        {ask.abilities.map((ab) => (
          <li key={ab.id}>
            <button type="button" className="prompt__choice" data-testid="prompt-choice" onClick={() => answer(ab)}>
              {plainRulesText(refName(lookup, ab))}
            </button>
          </li>
        ))}
      </ul>
    </PromptShell>
  );
}

/**
 * `DelayedReveal`: the CAPTION of a search — Forge's own words for what the
 * seat is looking at, and whose zone it came from.
 *
 * It used to draw the revealed cards as a second grid of its own, above the
 * options, so a fetchland showed the whole library once un-pickable and then
 * its Islands and Mountains again below — the operator's *"library search"*
 * complaint (#3) was exactly that shape. The cards now live in the ONE grid the
 * prompt draws, choosable first (`rules.ts` `searchRows`), so this is the line
 * that names the pile and nothing more.
 */
function DelayedRevealNote({
  reveal,
  lookup,
}: {
  reveal: PromptProps<'chooseEntitiesForEffect'>['ask']['delayedReveal'];
  lookup: PromptProps<'chooseEntitiesForEffect'>['lookup'];
}) {
  if (reveal === null) return null;
  return (
    <p className="prompt__reveal" data-testid="prompt-reveal">
      {reveal.messagePrefix}{' '}
      <span className="prompt__tag">
        from {refName(lookup, reveal.owner)}&rsquo;s {reveal.zones.join(', ')}
      </span>
    </p>
  );
}
