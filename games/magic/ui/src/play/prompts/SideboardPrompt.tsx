/*
 * `sideboard` — between games, move cards between the maindeck and the
 * sideboard, and answer with the new maindeck.
 *
 * This is a deck editor, so it is built on the deck model rather than beside
 * it: the two pools become one `@hadoku/deck` `Deck` (`rules.ts`
 * `deckFromSideboardAsk`) and every edit is `moveToMain` / `moveToSideboard`,
 * which only ever shuffle copies between the two piles. A card that was in
 * neither pool has no way in, structurally — and `sideboardProblems` checks the
 * same thing again on the answer, with `deckIssues`' own pool accounting.
 *
 * ## The two answers
 *
 * - **Keep deck** answers `null`: Forge reads null as "keep the maindeck you
 *   had" (`PlayerControllerHuman.java:275-276`, `requireNonNullElse`).
 * - **Done** answers the maindeck as it now stands, one entry per card with a
 *   count — `@hadoku/forge-wire`'s `DeckEntry[]`, which the bridge flattens to
 *   Forge's `List<PaperCard>` (`flattenEntries`).
 *
 * Deck size is shown, not enforced: Forge checks conformance itself and asks
 * again until the deck conforms (`PlayerControllerHuman.java:277`).
 */

import { useState } from 'react';
import { mainDeckSize, moveToMain, moveToSideboard, sideboardSize, type Deck } from '@hadoku/deck';

import { PromptShell } from './PromptShell.tsx';
import { deckFromSideboardAsk, sideboardProblems } from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

type Entry = Deck['main'][number];

function entryLabel(e: Entry): string {
  return e.card.set === null ? e.card.name : `${e.card.name} (${e.card.set})`;
}

function Pile({
  label,
  testId,
  entries,
  moveLabel,
  onMove,
}: {
  label: string;
  testId: string;
  entries: readonly Entry[];
  moveLabel: string;
  onMove: (e: Entry) => void;
}) {
  const total = entries.reduce((s, e) => s + e.count, 0);
  return (
    <section aria-label={label}>
      <h4 className="prompt__col-head">
        {label} {total}
      </h4>
      <ul className="prompt__list" data-testid={testId}>
        {entries.map((e) => (
          <li key={`${e.card.name}|${e.card.set ?? ''}|${e.card.artIndex}|${e.card.collectorNumber ?? ''}|${e.card.foil}`}>
            <span className="prompt__count">{e.count}</span>
            <span className="prompt__item">{entryLabel(e)}</span>
            <button type="button" aria-label={`${moveLabel}: ${entryLabel(e)}`} onClick={() => onMove(e)}>
              {moveLabel}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SideboardPrompt({ ask, onAnswer }: PromptProps<'sideboard'>) {
  const [deck, setDeck] = useState<Deck>(() => deckFromSideboardAsk(ask));
  const problems = sideboardProblems(ask, deck.main.slice());

  const submit = () => {
    assertAnswerable('sideboard', problems);
    onAnswer(checkedReply('sideboard', deck.main.slice()));
  };

  return (
    <PromptShell
      method="sideboard"
      title="Sideboarding"
      message={ask.message}
      problems={problems}
      onSubmit={submit}
      submitLabel="Done"
      actions={
        <button type="button" data-testid="prompt-cancel" onClick={() => onAnswer(checkedReply('sideboard', null))}>
          Keep deck
        </button>
      }
    >
      <p className="prompt__hint" data-testid="sideboard-sizes">
        Maindeck {mainDeckSize(deck)} · sideboard {sideboardSize(deck)}
      </p>
      <div className="prompt__dual">
        <Pile
          label="Maindeck"
          testId="sideboard-main"
          entries={deck.main}
          moveLabel="Side out"
          onMove={(e) => setDeck((d) => moveToSideboard(d, e.card))}
        />
        <Pile
          label="Sideboard"
          testId="sideboard-side"
          entries={deck.sideboard}
          moveLabel="Side in"
          onMove={(e) => setDeck((d) => moveToMain(d, e.card))}
        />
      </div>
    </PromptShell>
  );
}
