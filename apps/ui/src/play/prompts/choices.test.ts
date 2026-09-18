// @vitest-environment jsdom
/**
 * The list prompts — `getChoices`, `chooseSingleEntityForEffect`,
 * `chooseEntitiesForEffect`, `getAbilityToPlay` — from their committed
 * fixtures. Names come from the real match's state (`fixtureLookup`), so a
 * card drawn as "card #67" would be a lookup bug and fails here.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';

import { askFor, asksFor } from './fixtures.ts';
import { EMPTY_LOOKUP } from './lookup.ts';
import { expectWireReply, mountPrompt } from './testing.ts';

afterEach(cleanup);

const labels = (els: HTMLElement[]) => els.map((e) => e.closest('li')!.textContent);

describe('getChoices', () => {
  it('chooses one colour and answers its key', () => {
    const { getAllByTestId, answers, submit } = mountPrompt('getChoices', askFor('getChoices'));
    const boxes = getAllByTestId('prompt-choice') as HTMLInputElement[];
    expect(labels(boxes)).toEqual(['white', 'blue', 'black', 'red', 'green']);
    fireEvent.click(boxes[3]!);
    fireEvent.click(submit());
    expect(answers).toEqual([['red']]);
    expectWireReply('getChoices', answers[0]);
  });

  it('treats a 1..1 list as single-select: a second click replaces the first', () => {
    const { getAllByTestId, answers, submit } = mountPrompt('getChoices', askFor('getChoices'));
    const boxes = getAllByTestId('prompt-choice') as HTMLInputElement[];
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[4]!);
    expect(boxes.filter((b) => b.checked)).toHaveLength(1);
    fireEvent.click(submit());
    expect(answers).toEqual([['green']]);
  });

  it('cannot send zero choices when one is required', () => {
    const { answers, submit, getByTestId } = mountPrompt('getChoices', askFor('getChoices'));
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toBe('choose at least 1');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('cannot send more than max when several are allowed', () => {
    const ask = { ...askFor('getChoices'), min: 0, max: 2 };
    const { getAllByTestId, submit, answers } = mountPrompt('getChoices', ask);
    const boxes = getAllByTestId('prompt-choice');
    [0, 1, 2].forEach((i) => fireEvent.click(boxes[i]!));
    expect(submit().disabled).toBe(true);
    fireEvent.click(boxes[1]!);
    fireEvent.click(submit());
    expect(answers).toEqual([['white', 'black']]);
    expectWireReply('getChoices', answers[0]);
  });

  it('shows a display-only list with nothing to tick, and answers empty', () => {
    const reveal = asksFor('getChoices').find((a) => a.max < 0)!;
    const { getAllByTestId, answers, submit, container } = mountPrompt('getChoices', reveal);
    expect(getAllByTestId('prompt-choice').map((e) => e.textContent)).toEqual(['Oxidda Golem', 'Gemini Engine']);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    fireEvent.click(submit());
    expect(answers).toEqual([[]]);
    expectWireReply('getChoices', answers[0]);
  });
});

describe('chooseSingleEntityForEffect', () => {
  it('names players and cards from the real board and answers the ref chosen', () => {
    const { getAllByTestId, answers, submit } = mountPrompt(
      'chooseSingleEntityForEffect',
      askFor('chooseSingleEntityForEffect'),
    );
    const radios = getAllByTestId('prompt-choice');
    expect(labels(radios)).toEqual(['Alice (Host AI)player', 'Goblin Replica', 'Vulshok War Boar', 'Fire Urchin']);
    fireEvent.click(radios[1]!);
    fireEvent.click(submit());
    expect(answers).toEqual([{ kind: 'card', id: 67 }]);
    expectWireReply('chooseSingleEntityForEffect', answers[0]);
  });

  it('cannot send null when the choice is not optional', () => {
    const { submit, answers } = mountPrompt('chooseSingleEntityForEffect', askFor('chooseSingleEntityForEffect'));
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('answers null for an optional choice left empty', () => {
    const ask = { ...askFor('chooseSingleEntityForEffect'), isOptional: true };
    const { submit, answers } = mountPrompt('chooseSingleEntityForEffect', ask);
    expect(submit().textContent).toBe('Choose none');
    fireEvent.click(submit());
    expect(answers).toEqual([null]);
    expectWireReply('chooseSingleEntityForEffect', answers[0]);
  });
});

describe('chooseEntitiesForEffect', () => {
  it('shows the delayed reveal and answers the refs chosen, in offer order', () => {
    const { getAllByTestId, getByTestId, answers, submit } = mountPrompt(
      'chooseEntitiesForEffect',
      askFor('chooseEntitiesForEffect'),
    );
    expect(getByTestId('prompt-reveal').textContent).toContain("Looking at: Fire Urchin, Rubblebelt Boar, Ral's Staticaster");
    const boxes = getAllByTestId('prompt-choice');
    fireEvent.click(boxes[2]!);
    fireEvent.click(boxes[0]!);
    fireEvent.click(submit());
    expect(answers).toEqual([
      [
        { kind: 'card', id: 20 },
        { kind: 'card', id: 2 },
      ],
    ]);
    expectWireReply('chooseEntitiesForEffect', answers[0]);
  });

  it('cannot send three when the max is two', () => {
    const { getAllByTestId, submit, answers, getByTestId } = mountPrompt(
      'chooseEntitiesForEffect',
      askFor('chooseEntitiesForEffect'),
    );
    getAllByTestId('prompt-choice').forEach((b) => fireEvent.click(b));
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toBe('choose at most 2');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });
});

describe('getAbilityToPlay', () => {
  it('draws each ability in words — no tap symbol, no braces — and answers the one clicked', () => {
    const { getAllByTestId, answers, getByRole } = mountPrompt('getAbilityToPlay', askFor('getAbilityToPlay'));
    expect(getByRole('dialog').textContent).toContain('Pyrite Spellbomb');
    const buttons = getAllByTestId('prompt-choice');
    expect(buttons.map((b) => b.textContent)).toEqual([
      '1, Sacrifice Pyrite Spellbomb: Draw a card.',
      'R, Sacrifice Pyrite Spellbomb: It deals 2 damage to any target.',
    ]);
    fireEvent.click(buttons[1]!);
    expect(answers).toEqual([{ kind: 'spellAbility', id: 9002 }]);
    expectWireReply('getAbilityToPlay', answers[0]);
  });

  it('answers null for none', () => {
    const { getByTestId, answers } = mountPrompt('getAbilityToPlay', askFor('getAbilityToPlay'));
    fireEvent.click(getByTestId('prompt-cancel'));
    expect(answers).toEqual([null]);
    expectWireReply('getAbilityToPlay', answers[0]);
  });

  it('cannot answer an ability it was not offered: one button per offered ability, labelled even without a lookup', () => {
    const ask = askFor('getAbilityToPlay');
    const { getAllByTestId } = mountPrompt('getAbilityToPlay', ask, EMPTY_LOOKUP);
    expect(getAllByTestId('prompt-choice').map((b) => b.textContent)).toEqual(['ability #9001', 'ability #9002']);
  });
});
