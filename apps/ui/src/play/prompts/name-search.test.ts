// @vitest-environment jsdom
/**
 * Naming a card: Cabal Therapy's ask carried 33,659 names, and drawing them all
 * froze the tab until its socket timed out (the operator, 2026-10-11). The picker
 * is a search that draws a few matches, at any list size.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';

import { foldName, nameIndex, NAME_MATCHES_SHOWN, searchNames } from './name-search.ts';
import { expectWireReply, mountPrompt } from './testing.ts';
import type { AskOf } from './types.ts';

afterEach(cleanup);

const NAMES = ['"Ach! Hans, Run!"', 'Bear Cub', 'Grizzly Bears', 'Jötun Grunt', 'Lim-Dûl’s Vault', 'Llanowar Elves', 'Werebear'];

/** Forge's own size for "Choose a nonland card name.", the real names among filler. */
const HUGE = [...NAMES, ...Array.from({ length: 33_659 - NAMES.length }, (_, i) => `Filler Card ${i}`)];

function nameAsk(names: readonly string[], min = 1): AskOf<'getChoices'> {
  return { kind: 'ask', callId: 'c-name', method: 'getChoices', message: 'Choose a nonland card name.', min, max: 1, choices: [], selected: [], names: [...names] };
}

describe('searchNames', () => {
  const index = nameIndex(NAMES);

  it('folds case, accents and punctuation', () => {
    expect(foldName('Lim-Dûl’s Vault')).toBe('lim dul s vault');
    expect(searchNames(index, 'JOTUN')).toEqual(['Jötun Grunt']);
    expect(searchNames(index, 'lim dul')).toEqual(['Lim-Dûl’s Vault']);
  });

  it('a name that starts with the query comes first, then a word that does, then the rest', () => {
    expect(searchNames(index, 'bear')).toEqual(['Bear Cub', 'Grizzly Bears', 'Werebear']);
  });

  it('an empty query lists a short ask whole and a long one not at all', () => {
    expect(searchNames(index, '')).toEqual(NAMES);
    expect(searchNames(nameIndex(HUGE), '')).toEqual([]);
  });

  it('draws at most a screenful', () => {
    expect(searchNames(nameIndex(HUGE), 'filler')).toHaveLength(NAME_MATCHES_SHOWN);
  });
});

describe('the name picker', () => {
  it('types, moves with the arrows, and Enter names the highlighted card by its own key', () => {
    const { getByTestId, getAllByTestId, answers } = mountPrompt('getChoices', nameAsk(NAMES));
    const search = getByTestId('prompt-name-search');
    fireEvent.change(search, { target: { value: 'bear' } });
    expect(getAllByTestId('prompt-name-option').map((li) => li.textContent)).toEqual(['Bear Cub', 'Grizzly Bears', 'Werebear']);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(answers).toEqual([['Grizzly Bears']]);
    expectWireReply('getChoices', answers[0]);
  });

  it('a name Forge lists twice is drawn once, and the matches follow the query', () => {
    const { getByTestId, getAllByTestId, queryAllByTestId } = mountPrompt('getChoices', nameAsk([...NAMES, 'Grizzly Bears', 'Goblin Bombardment', 'Goblin Bombardment']));
    const search = getByTestId('prompt-name-search');
    for (const query of ['g', 'go', 'gob', 'goblin', 'goblin g', 'goblin gu']) fireEvent.change(search, { target: { value: query } });
    expect(queryAllByTestId('prompt-name-option')).toHaveLength(0);
    for (const query of ['', 'g', 'gr', 'grizzly b']) fireEvent.change(search, { target: { value: query } });
    expect(getAllByTestId('prompt-name-option').map((li) => li.textContent)).toEqual(['Grizzly Bears']);
  });

  it('a click names the card', () => {
    const { getByTestId, getAllByTestId, answers } = mountPrompt('getChoices', nameAsk(NAMES));
    fireEvent.change(getByTestId('prompt-name-search'), { target: { value: 'elves' } });
    fireEvent.click(getAllByTestId('prompt-name-option')[0]!);
    expect(answers).toEqual([['Llanowar Elves']]);
  });

  /*
   * The budget is CPU time on this thread, not the wall clock: what it guards is
   * work done per name, and a wall clock also counts the time a loaded host gave
   * the core to someone else (251 ms against 200 on a full check at load 22).
   */
  it('opens at once on 33,659 names and draws none of them until asked', () => {
    const cpuMs = (since: NodeJS.CpuUsage): number => {
      const { user, system } = process.threadCpuUsage(since);
      return (user + system) / 1000;
    };
    const started = process.threadCpuUsage();
    const { getByTestId, queryAllByTestId } = mountPrompt('getChoices', nameAsk(HUGE));
    const opened = cpuMs(started);
    expect(queryAllByTestId('prompt-name-option')).toHaveLength(0);
    const typed = process.threadCpuUsage();
    fireEvent.change(getByTestId('prompt-name-search'), { target: { value: 'griz' } });
    const searched = cpuMs(typed);
    console.log(`[gg-name] jsdom: ${HUGE.length} names open in ${opened.toFixed(0)} ms of CPU, a search in ${searched.toFixed(0)} ms`);
    expect(queryAllByTestId('prompt-name-option').map((li) => li.textContent)).toEqual(['Grizzly Bears']);
    expect(opened).toBeLessThan(200);
  });

  it('an optional name can be declined', () => {
    const { answers, submit } = mountPrompt('getChoices', nameAsk(NAMES, 0));
    fireEvent.click(submit());
    expect(answers).toEqual([[]]);
  });
});
