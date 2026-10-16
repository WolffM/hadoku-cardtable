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
 * A player keeps their name and the `player` tag; an ability is a button in
 * rules text WITH its symbols — "{T}: Add {B}." draws the tap and the mana
 * glyph (`RulesText`), the plain words kept as the button's accessible name
 * (the operator, 2026-10-08, after Z10 and Y23: "in this place we should be
 * showing mana icons not letters"). The tick that chooses a tile is the tile's
 * border; the input itself stays in the DOM (visually hidden) so the keyboard
 * path and the live driver see exactly what they saw before.
 */

import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { OptionButton, PickChoice, PromptShell, promptTileFor, usePicks } from './PromptShell.tsx';
import { isZoneDividerLabel, plainRulesText, promptText, refName, translateTargetWords, type PromptLookup } from './lookup.ts';
import { nameIndex, searchNames } from './name-search.ts';
import { RulesText } from './RulesText.tsx';
import {
  abilityProblems,
  choiceBounds,
  chooseEntitiesProblems,
  chooseSingleProblems,
  getChoicesProblems,
  numericChoiceRange,
  revealCaption,
  searchRows,
  type NumericChoiceRange,
  type SearchRow,
} from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';
import type { CardRef, EntityRef } from '@hadoku/forge-wire';

/** The card an option stands for, when it stands for one. */
function cardOfOption(ref: EntityRef | null): CardRef | null {
  return ref !== null && ref.kind === 'card' ? ref : null;
}

/**
 * The bound, as a LABEL. Not a sentence: the board states things, it does not
 * explain them (operator, 2026-09-24). An ask with nothing to choose never gets
 * here: the server answers it and sends it as a reveal (`RevealNotice.tsx`).
 */
function boundsText(min: number, max: number): string {
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
 * `range.affordable`, on a mana X, is the most X the seat can pay: a notch
 * on the track at that value, the thumb's centre when it sits there.
 */
function NumberChoiceSlider({
  range,
  value,
  onChange,
}: {
  range: NumericChoiceRange;
  value: number | null;
  onChange: (key: string) => void;
}) {
  const span = range.max - range.min;
  const afford = range.affordable === undefined ? undefined : Math.min(Math.max(range.affordable, range.min), range.max);
  return (
    <div className="prompt__slider">
      <span className="prompt__slider-track">
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
        {afford !== undefined && (
          <span
            className="prompt__slider-afford"
            data-testid="prompt-slider-afford"
            data-value={afford}
            aria-hidden="true"
            style={{ '--at': (afford - range.min) / span } as CSSProperties}
          />
        )}
      </span>
      <output className="prompt__slider-value" data-testid="prompt-slider-value">
        {value ?? range.min}
      </output>
    </div>
  );
}

export function GetChoicesPrompt(props: PromptProps<'getChoices'>) {
  return props.ask.names !== undefined ? <NamePickPrompt {...props} /> : <ListChoicesPrompt {...props} />;
}

/**
 * A card-name ask (Cabal Therapy, Pithing Needle): a search over the names, never
 * the whole list drawn — 33,659 rows froze the tab long enough to drop its socket
 * (the operator, 2026-10-11). Typing narrows the matches; arrows move through
 * them, Enter or a click names the card.
 */
function NamePickPrompt({ ask, onAnswer }: PromptProps<'getChoices'>) {
  const names = ask.names ?? [];
  const index = useMemo(() => nameIndex(names), [names]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => searchNames(index, query), [index, query]);
  const at = Math.min(active, Math.max(0, matches.length - 1));
  const pick = (name: string) => {
    const problems = getChoicesProblems(ask, [name]);
    assertAnswerable('getChoices', problems);
    onAnswer(checkedReply('getChoices', [name]));
  };
  const decline = choiceBounds(ask.min, ask.max).min === 0 ? () => onAnswer(checkedReply('getChoices', [])) : undefined;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(Math.min(Math.max(at + step, 0), Math.max(0, matches.length - 1)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const name = matches[at];
      if (name !== undefined) pick(name);
    }
  };
  return (
    <PromptShell method="getChoices" title={promptText(ask.message)} onSubmit={decline}>
      <input
        className="prompt__input prompt__name-search"
        data-testid="prompt-name-search"
        type="search"
        role="combobox"
        aria-label={promptText(ask.message)}
        aria-expanded={matches.length > 0}
        aria-controls={`names-${ask.callId}`}
        aria-activedescendant={matches.length > 0 ? `names-${ask.callId}-${at}` : undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <ul className="prompt__list prompt__names" id={`names-${ask.callId}`} role="listbox">
        {matches.map((name, i) => (
          <li
            key={name}
            id={`names-${ask.callId}-${i}`}
            role="option"
            aria-selected={i === at}
            data-testid="prompt-name-option"
            data-active={i === at || undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(name)}
          >
            {name}
          </li>
        ))}
      </ul>
    </PromptShell>
  );
}

function ListChoicesPrompt({ ask, onAnswer, lookup }: PromptProps<'getChoices'>) {
  const bounds = choiceBounds(ask.min, ask.max);
  const known = new Set(ask.choices.map((c) => c.key));
  const range = bounds.max > 0 ? numericChoiceRange(ask) : null;
  // Reply in the order Forge listed the options, not the order they were clicked.
  const replyOf = (picks: readonly string[]) => ask.choices.map((c) => c.key).filter((k) => picks.includes(k));
  const { chosen, setChosen, problems, pick, submit, confirm } = usePicks<string>(
    () => {
      const selected = ask.selected.filter((k) => known.has(k));
      // A slider always shows a value; Forge's own default reading for `getInteger`
      // (`AbstractGuiGame.java:791-813`) is the range's minimum — `range.keys[0]`
      // is the WIRE KEY that answers it, never `String(range.min)` (wave 34 §G
      // item 1: Forge's own key is never the integer — see `NumericChoiceRange`).
      if (selected.length === 0 && range !== null) return [range.keys[0]!];
      return selected;
    },
    bounds.max === 1,
    (picks) => getChoicesProblems(ask, replyOf(picks)),
    (picks) => {
      const reply = replyOf(picks);
      assertAnswerable('getChoices', getChoicesProblems(ask, reply));
      onAnswer(checkedReply('getChoices', reply));
    },
  );

  if (range !== null) {
    const key = chosen[0] ?? null;
    // The key is never the integer (wave 34 §G item 1) — its VALUE is its
    // position in `range.keys`, offset by `range.min`.
    const index = key === null ? -1 : range.keys.indexOf(key);
    const value = index >= 0 ? range.min + index : null;
    return (
      <PromptShell method="getChoices" title={promptText(ask.message)} problems={problems} onSubmit={submit}>
        <NumberChoiceSlider range={range} value={value} onChange={(k) => setChosen([k])} />
      </PromptShell>
    );
  }

  const anyCards = ask.choices.some((c) => cardOfOption(c.ref) !== null);

  return (
    <PromptShell method="getChoices" title={promptText(ask.message)} problems={problems} onSubmit={submit}>
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
          // NOT `plainRulesText` (T4 stripped its card-id suffix): this label
          // is an IDENTITY `ChoiceTile` can fall back to (`nameFromForgeLabel`,
          // `PromptShell.tsx`), which only strips the suffix when it matches
          // THIS card's own id — blindly stripping it first would let a
          // mismatched id's art be guessed (`choices.test.ts`'s own safety
          // case: "a label whose parenthesis is not this card's id").
          const name = translateTargetWords(c.label);
          return (
            <li key={c.key} data-card-id={cardRef !== null ? cardRef.id : undefined}>
              <PickChoice type="checkbox" data={{ 'data-key': c.key }} checked={chosen.includes(c.key)} onPick={() => pick(c.key)} onConfirm={() => confirm(c.key)}>
                {cardRef !== null ? <ChoiceTile cardRef={cardRef} lookup={lookup} label={name} /> : <RulesText text={c.label} />}
              </PickChoice>
            </li>
          );
        })}
      </ul>
    </PromptShell>
  );
}

export function ChooseSingleEntityPrompt({ ask, onAnswer, lookup }: PromptProps<'chooseSingleEntityForEffect'>) {
  const replyOf = (picks: readonly number[]) => (picks[0] === undefined ? null : (ask.optionList[picks[0]] ?? null));
  const { chosen: picks, setChosen, problems, pick, submit, confirm } = usePicks<number>(
    () => [],
    true,
    (p) => chooseSingleProblems(ask, replyOf(p)),
    (p) => {
      const reply = replyOf(p);
      assertAnswerable('chooseSingleEntityForEffect', chooseSingleProblems(ask, reply));
      onAnswer(checkedReply('chooseSingleEntityForEffect', reply));
    },
  );
  const chosen = picks[0] ?? null;
  const reply = replyOf(picks);
  // Choosable first, in Forge's order; then what Forge only revealed. One grid,
  // not two — §D.2. `rules.ts` owns the order and the flag.
  const rows = searchRows(ask);
  const anyCards = rows.some((r) => r.ref.kind === 'card');

  return (
    <PromptShell
      method="chooseSingleEntityForEffect"
      title={promptText(ask.title)}
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
              <PickChoice
                type="radio"
                data={{ 'data-ref': `${row.ref.kind}:${row.ref.id}` }}
                checked={chosen === row.option}
                onPick={() => pick(row.option!)}
                onConfirm={() => confirm(row.option!)}
              >
                <RowFace entity={row.ref} lookup={lookup} />
              </PickChoice>
            )}
          </li>
        ))}
      </ul>
      {ask.isOptional && chosen !== null && (
        <button type="button" className="prompt__link" onClick={() => setChosen([])}>
          Clear choice
        </button>
      )}
    </PromptShell>
  );
}

export function ChooseEntitiesPrompt({ ask, onAnswer, lookup }: PromptProps<'chooseEntitiesForEffect'>) {
  const bounds = choiceBounds(ask.min, ask.max);
  const replyOf = (picks: readonly number[]) => ask.optionList.filter((_, i) => picks.includes(i));
  const { chosen, problems, pick, submit, confirm } = usePicks<number>(
    () => [],
    bounds.max === 1,
    (picks) => chooseEntitiesProblems(ask, replyOf(picks)),
    (picks) => {
      const reply = replyOf(picks);
      assertAnswerable('chooseEntitiesForEffect', chooseEntitiesProblems(ask, reply));
      onAnswer(checkedReply('chooseEntitiesForEffect', reply));
    },
  );
  // Choosable first, then what Forge only revealed — the same one grid §D.2
  // gives the single-choice prompt.
  const rows = searchRows(ask);
  const anyCards = rows.some((r) => r.ref.kind === 'card');

  return (
    <PromptShell method="chooseEntitiesForEffect" title={promptText(ask.title)} problems={problems} onSubmit={submit}>
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
              <PickChoice
                type="checkbox"
                data={{ 'data-ref': `${row.ref.kind}:${row.ref.id}` }}
                checked={chosen.includes(row.option)}
                onPick={() => pick(row.option!)}
                onConfirm={() => confirm(row.option!)}
              >
                <RowFace entity={row.ref} lookup={lookup} />
              </PickChoice>
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
            <OptionButton
              testId="prompt-choice"
              className="prompt__choice"
              ariaLabel={plainRulesText(refName(lookup, ab))}
              onClick={() => answer(ab)}
            >
              <RulesText text={refName(lookup, ab)} />
            </OptionButton>
          </li>
        ))}
      </ul>
    </PromptShell>
  );
}

/**
 * `DelayedReveal`: the CAPTION of a search — one sentence, one style, naming
 * the source and whose zone the seat is looking at (`rules.ts` `revealCaption`).
 * The cards live in the ONE grid the prompt draws (`rules.ts` `searchRows`), so
 * this is the line that names the pile and nothing more.
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
      {revealCaption(reveal, refName(lookup, reveal.owner))}
    </p>
  );
}
