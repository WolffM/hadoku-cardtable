/*
 * The expectation check, on the two reports it exists for: a gift that stopped being asked, and an
 * optional cost the server answered for the seat.
 */
import { describe, expect, it } from 'vitest';

import { differences, differenceText, expectedOf, signatureOf } from './expected.ts';
import type { CardResult } from './run-cards.ts';

function result(over: Partial<CardResult>): CardResult {
  return { card: 'Parting Gust', rarity: 'U', variant: 'accept', matchId: 'm-1', with: [], seed: 1, cast: 'resolved', endedIn: 'graveyard', board: null, asks: [], uses: 0, attacked: false, server: [], turns: 5, decisions: 9, ended: 'done', ms: 1, flags: [], ...over };
}

const play = { during: 'play' as const, method: 'getAbilityToPlay', shape: {}, declined: false };
const gift = { during: 'play' as const, method: 'getChoices', shape: { message: 'Choose optional costs', min: 0, max: 1 }, declined: false };
const offspring = { during: 'play' as const, method: 'bar', shape: { message: 'Pawpatch Recruit (102) - Pay for Offspring? {2}', label1: 'Yes', label2: 'No' }, declined: true };
const combat = { during: 'follow' as const, method: 'assignCombatDamage', shape: {}, declined: false };

describe('signatureOf', () => {
  it('keeps the questions of the play, without card ids, and leaves out the ability offer and the turns played on', () => {
    expect(signatureOf(result({ asks: [play, gift, offspring, combat] }))).toEqual({
      cast: 'resolved',
      asks: ['getChoices: Choose optional costs', 'bar: Pawpatch Recruit - Pay for Offspring? {2} (declined)'],
      server: [],
    });
  });

  it('lists a question asked again straight away once', () => {
    expect(signatureOf(result({ asks: [play, gift, gift, offspring, gift] })).asks).toEqual(['getChoices: Choose optional costs', 'bar: Pawpatch Recruit - Pay for Offspring? {2} (declined)', 'getChoices: Choose optional costs']);
  });

  it('keeps what the server answered for the seat, but not its standing answers to the ability offer', () => {
    const server = [
      { evt: 'ask-auto-answered', method: 'getAbilityToPlay', why: 'one ability' },
      { evt: 'auto-picked', method: null, why: 'the only legal sacrifice' },
    ];
    expect(signatureOf(result({ server })).server).toEqual(['auto-picked -: the only legal sacrifice']);
  });
});

describe('differences', () => {
  const recorded = expectedOf([result({ asks: [play, gift] }), result({ variant: 'decline', asks: [play, { ...gift, declined: true }] })]);

  it('is empty for the same plays again', () => {
    expect(differences([result({ asks: [play, gift] }), result({ variant: 'decline', asks: [play, { ...gift, declined: true }] })], recorded)).toEqual([]);
  });

  it('names a gift that was no longer asked', () => {
    const [d] = differences([result({ asks: [play] })], recorded);
    expect(d).toMatchObject({ card: 'Parting Gust', variant: 'accept', expected: { asks: ['getChoices: Choose optional costs'] }, got: { asks: [] } });
    expect(differenceText(d!)).toContain('ask: getChoices: Choose optional costs');
  });

  it('names a question the server answered in the seat\'s place', () => {
    const [d] = differences([result({ asks: [play], server: [{ evt: 'ask-auto-answered', method: 'confirm', why: 'the seat chose this ability just before' }] })], recorded);
    expect(d!.got.server).toEqual(['ask-auto-answered confirm: the seat chose this ability just before']);
  });

  it('names a refusal that is no longer a refusal, and a cast that no longer resolves', () => {
    expect(differences([result({ variant: 'decline', asks: [play, gift] })], recorded)).toHaveLength(1);
    expect(differences([result({ cast: 'rolled-back', asks: [play, gift] })], recorded)).toHaveLength(1);
  });

  it('names a card the set has no expectation for', () => {
    expect(differences([result({ card: 'New Card' })], recorded)).toMatchObject([{ card: 'New Card', expected: null }]);
  });
});
