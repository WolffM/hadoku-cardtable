// @vitest-environment jsdom
/**
 * The damage-distribution widget (`assignCombatDamage`) and its generic
 * sibling (`assignGenericAmount`), driven by their steppers.
 *
 * The combat fixture is Bob's Fire Urchin (Trample, pumped to 5) blocked by
 * Goblin Replica (lethal 2) then Vulshok War Boar (lethal 5), attacking Alice.
 * The lethal numbers are Forge's own `LethalDamage` from the captured state.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';

import { askFor, asksFor } from './fixtures.ts';
import { expectWireReply, mountPrompt } from './testing.ts';

afterEach(cleanup);

function slots(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="prompt-slot"], [data-testid="prompt-defender"]')];
}

function setAmount(slot: HTMLElement, n: number) {
  fireEvent.change(within(slot).getByRole('spinbutton'), { target: { value: String(n) } });
}

describe('assignCombatDamage', () => {
  it('lists the blockers in damage order with their lethal damage, then the defender', () => {
    const { container, getByRole } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    expect(getByRole('dialog').getAttribute('aria-label')).toBe('Assign damage dealt by Fire Urchin');
    expect(slots(container).map((s) => s.querySelector('.prompt__amount-label')!.textContent)).toEqual([
      'Goblin Replicalethal 2',
      'Vulshok War Boarlethal 5',
      'Alice (Host AI)past the blockers',
    ]);
  });

  it('answers lethal-then-rest, every slot included, the defender as Forge’s -1 key', () => {
    const { container, submit, answers } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    const [replica, boar] = slots(container);
    setAmount(replica!, 2);
    setAmount(boar!, 3);
    fireEvent.click(submit());
    expect(answers).toEqual([
      [
        { target: { kind: 'card', id: 67 }, amount: 2 },
        { target: { kind: 'card', id: 99 }, amount: 3 },
        { target: { kind: 'card', id: -1 }, amount: 0 },
      ],
    ]);
    expectWireReply('assignCombatDamage', answers[0]);
  });

  it('Auto assigns lethal in order, as Forge’s own button does', () => {
    const { getByTestId, submit, answers } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    fireEvent.click(getByTestId('prompt-auto'));
    fireEvent.click(submit());
    expect(answers[0]!.map((e) => e.amount)).toEqual([2, 3, 0]);
  });

  it('tramples over once the only blocker has lethal', () => {
    const ask = { ...askFor('assignCombatDamage'), blockers: [{ kind: 'card', id: 67 }] as [{ kind: 'card'; id: number }] };
    const { getByTestId, submit, answers } = mountPrompt('assignCombatDamage', ask);
    fireEvent.click(getByTestId('prompt-auto'));
    fireEvent.click(submit());
    expect(answers).toEqual([
      [
        { target: { kind: 'card', id: 67 }, amount: 2 },
        { target: { kind: 'card', id: -1 }, amount: 3 },
      ],
    ]);
    expectWireReply('assignCombatDamage', answers[0]);
  });

  it('cannot send damage that sums wrong', () => {
    const { container, submit, answers, getByTestId } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    expect(submit().disabled).toBe(true);
    const [replica, boar] = slots(container);
    setAmount(replica!, 2);
    setAmount(boar!, 4);
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toBe('assign exactly 5 (assigned 6)');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('cannot send damage past a blocker that lacks lethal', () => {
    const { container, submit, answers, getByTestId } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    const [replica, boar, alice] = slots(container);
    setAmount(replica!, 1);
    setAmount(boar!, 2);
    setAmount(alice!, 2);
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toContain('blocker 2 cannot take damage');
    expect(getByTestId('prompt-problems').textContent).toContain('before any tramples over');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('offers no defender slot to a non-trampler', () => {
    const ask = { ...askFor('assignCombatDamage'), attacker: { kind: 'card', id: 60 } as const };
    const { container, queryByTestId } = mountPrompt('assignCombatDamage', ask);
    expect(queryByTestId('prompt-defender')).toBeNull();
    expect(slots(container)).toHaveLength(2);
  });

  it('says so when Forge would allow a skip it cannot yet express', () => {
    const { getByTestId } = mountPrompt('assignCombatDamage', { ...askFor('assignCombatDamage'), maySkip: true });
    expect(getByTestId('prompt-mayskip').textContent).toContain('not supported yet');
  });
});

describe('assignGenericAmount', () => {
  it('starts every target at one under atLeastOne and answers every key', () => {
    const { container, submit, answers, getByRole } = mountPrompt('assignGenericAmount', askFor('assignGenericAmount'));
    expect(getByRole('dialog').getAttribute('aria-label')).toBe("Distribute damage from Ral's Dispersal");
    expect(slots(container).map((s) => within(s).getByRole('spinbutton') as HTMLInputElement).map((i) => i.value)).toEqual([
      '1',
      '1',
      '1',
    ]);
    fireEvent.click(submit());
    expect(answers).toEqual([
      [
        { key: { target: 'entity', ref: { kind: 'player', id: 1 } }, amount: 1 },
        { key: { target: 'entity', ref: { kind: 'card', id: 67 } }, amount: 1 },
        { key: { target: 'entity', ref: { kind: 'card', id: 99 } }, amount: 1 },
      ],
    ]);
    expectWireReply('assignGenericAmount', answers[0]);
  });

  it('cannot take a target below one under atLeastOne', () => {
    const { container, submit, answers, getByTestId } = mountPrompt('assignGenericAmount', askFor('assignGenericAmount'));
    const [alice, replica] = slots(container);
    setAmount(alice!, 2);
    setAmount(replica!, 0);
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toBe('target 2: at least 1');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('names mana colours in words and clamps each to its maximum', () => {
    const mana = asksFor('assignGenericAmount').find((a) => a.amountLabel === 'mana')!;
    const { container, submit, answers } = mountPrompt('assignGenericAmount', mana);
    const [blue, red] = slots(container);
    expect(blue!.textContent).toContain('blue');
    expect(red!.textContent).toContain('red');
    setAmount(blue!, 9);
    expect((within(blue!).getByRole('spinbutton') as HTMLInputElement).value).toBe('2');
    fireEvent.click(submit());
    expect(answers).toEqual([
      [
        { key: { target: 'manaColor', color: 2 }, amount: 2 },
        { key: { target: 'manaColor', color: 8 }, amount: 0 },
      ],
    ]);
    expectWireReply('assignGenericAmount', answers[0]);
  });
});
