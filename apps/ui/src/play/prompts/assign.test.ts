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
  it('lists the blockers in damage order, each a card with a meter to its lethal damage, then the defender', () => {
    const { container, getByRole } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    expect(getByRole('dialog').getAttribute('aria-label')).toBe('Assign damage dealt by Fire Urchin');
    const rows = slots(container);
    expect(rows.map((s) => s.querySelector('.prompt__amount-name')!.textContent)).toEqual(['Goblin Replica', 'Vulshok War Boar', 'Alice (Host AI)']);
    expect(rows.map((s) => s.querySelector('[data-thumb]')!.getAttribute('data-thumb'))).toEqual(['card', 'card', 'player']);
    expect(rows.slice(0, 2).map((s) => s.querySelector('[data-thumb]')!.getAttribute('data-card-id'))).toEqual(['67', '99']);
    expect(rows.map((s) => s.querySelector('[data-testid="damage-meter"]')!.getAttribute('data-lethal'))).toEqual(['2', '5', null]);
    expect(container.querySelector('[data-testid="damage-attacker"]')!.getAttribute('data-card-id')).toBe('21');
    expect(container.querySelector('[data-testid="damage-left"]')!.textContent).toBe('5');
  });

  it('gives every row one stepper — −, the value, + — and no native spinner', () => {
    const { container } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    for (const row of slots(container)) {
      expect(row.querySelectorAll('.prompt__stepper')).toHaveLength(1);
      expect(row.querySelectorAll('.prompt__stepper button')).toHaveLength(2);
      expect(row.querySelectorAll('[role="spinbutton"]')).toHaveLength(1);
      expect(row.querySelectorAll('input[type="number"]')).toHaveLength(0);
    }
  });

  it('steps by the arrow keys, fills the meter to lethal and drains the pool', () => {
    const { container } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    const [replica] = slots(container);
    const value = within(replica!).getByRole('spinbutton');
    fireEvent.keyDown(value, { key: 'ArrowUp' });
    expect(replica!.querySelector('[data-testid="damage-meter"]')!.hasAttribute('data-reached')).toBe(false);
    fireEvent.keyDown(value, { key: 'ArrowUp' });
    expect((value as HTMLInputElement).value).toBe('2');
    expect(replica!.querySelector('[data-testid="damage-meter"]')!.hasAttribute('data-reached')).toBe(true);
    expect(container.querySelector('[data-testid="damage-left"]')!.textContent).toBe('3');
    fireEvent.keyDown(value, { key: 'ArrowDown' });
    expect((value as HTMLInputElement).value).toBe('1');
  });

  it('hands the board each blocker’s damage as it stands', () => {
    const previews: ReadonlyMap<number, number>[] = [];
    const { container } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'), undefined, (m) => previews.push(m));
    setAmount(slots(container)[0]!, 2);
    expect([...previews.at(-1)!]).toEqual([
      [67, 2],
      [99, 0],
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

  it('cannot send damage that sums wrong — the pool says it, not a sentence', () => {
    const { container, submit, answers, getByTestId } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    expect(submit().disabled).toBe(true);
    const [replica, boar] = slots(container);
    setAmount(replica!, 2);
    setAmount(boar!, 4);
    expect(submit().disabled).toBe(true);
    expect(getByTestId('damage-left').textContent).toBe('-1');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('clears what may not take damage yet, as Forge’s own dialog does, so no order rule is ever a sentence', () => {
    const { container, submit, answers, queryByTestId } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    const [replica, boar, alice] = slots(container);
    setAmount(replica!, 2);
    setAmount(boar!, 2);
    setAmount(alice!, 1);
    expect(within(alice!).getByRole('spinbutton')).toHaveProperty('value', '0');
    setAmount(boar!, 3);
    setAmount(replica!, 1);
    expect(within(boar!).getByRole('spinbutton')).toHaveProperty('value', '0');
    expect(queryByTestId('prompt-problems')).toBeNull();
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('offers no defender slot to a non-trampler', () => {
    const ask = { ...askFor('assignCombatDamage'), attacker: { kind: 'card', id: 60 } as const };
    const { container, queryByTestId } = mountPrompt('assignCombatDamage', ask);
    expect(queryByTestId('prompt-defender')).toBeNull();
    expect(slots(container)).toHaveLength(2);
  });

  it('writes no note of its own when Forge would allow a skip', () => {
    const { queryByTestId, getByRole } = mountPrompt('assignCombatDamage', { ...askFor('assignCombatDamage'), maySkip: true });
    expect(queryByTestId('prompt-mayskip')).toBeNull();
    expect(getByRole('dialog').textContent).not.toMatch(/not supported/i);
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

  it('draws a mana combination as its whole answers, and one press sends one', () => {
    const mana = asksFor('assignGenericAmount').find((a) => a.amountLabel === 'mana')!;
    const { container, queryByTestId, answers, getByRole } = mountPrompt('assignGenericAmount', mana);
    expect(getByRole('dialog').getAttribute('aria-label')).toBe('Izzet Guildgate - Choose mana');
    const combos = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="prompt-combo"]')];
    expect(combos.map((b) => b.getAttribute('aria-label'))).toEqual(['blue blue', 'blue red', 'red red']);
    expect(combos[1]!.querySelectorAll('.ms-u, .ms-r')).toHaveLength(2);
    expect(slots(container)).toHaveLength(0);
    expect(queryByTestId('prompt-submit')).toBeNull();
    fireEvent.click(combos[1]!);
    expect(answers).toEqual([
      [
        { key: { target: 'manaColor', color: 2 }, amount: 1 },
        { key: { target: 'manaColor', color: 8 }, amount: 1 },
      ],
    ]);
    expectWireReply('assignGenericAmount', answers[0]);
  });
});
