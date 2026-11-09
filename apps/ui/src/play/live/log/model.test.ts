/**
 * The game log's tree, built from lines as the bridge really sends them: the
 * fixtures below are `game-log.jvm.test.ts`'s own capture of `lg-gamelog` and of
 * the response scenario against real Forge (2026-11-09), alice's words.
 */
import { describe, expect, it } from 'vitest';

import type { GameLogLine } from '@hadoku/forge-wire';

import type { Say } from '../match.ts';
import { buildLog, cleanText, manaTokens, type LogItem, type LogNode, type LogTurn } from './model.ts';

const ALICE = 0;
const BOB = 1;
const PLAYERS = [
  { id: ALICE, name: 'alice', life: 20 },
  { id: BOB, name: 'bob', life: 17 },
];

function say(text: string, type: GameLogLine['type'], meta: Omit<GameLogLine, 'type' | 'cards'> = {}, cards: GameLogLine['cards'] = []): Say {
  return { text, log: { type, cards, ...meta } };
}

const plain = (text: string): Say => ({ text, log: null });

/** The response scenario: bob's Unsummon answers alice's Bolt, the Bolt fizzles, alice's Bears enter. */
const RESPONSE: Say[] = [
  say('alice cast Lightning Bolt targeting [Llanowar Elves]', 'STACK_ADD', { actor: ALICE, stack: 1, phase: 'MAIN1' }),
  say('bob cast Unsummon targeting [Llanowar Elves]', 'STACK_ADD', { actor: BOB, stack: 3, parent: 1, mana: '{U}', phase: 'MAIN1' }),
  say("Unsummon - Return Llanowar Elves to its owner's hand.", 'STACK_RESOLVE', { actor: BOB, resolves: 3, phase: 'MAIN1' }),
  say('Lightning Bolt fizzles: no legal target.', 'STACK_RESOLVE', { actor: ALICE, resolves: 1, phase: 'MAIN1' }),
  say('alice cast Grizzly Bears', 'STACK_ADD', { actor: ALICE, stack: 6, mana: '{G}{G}', phase: 'MAIN1' }),
  say('Grizzly Bears enters as a 2/2.', 'STACK_RESOLVE', { actor: ALICE, resolves: 6, phase: 'MAIN1' }),
];

/** A slice of lg-gamelog: a trigger whose resolution only restates it, combat, Opt, then bob's turn. */
const TURN: Say[] = [
  say('alice cast Doom Blade targeting [Doomed Traveler]', 'STACK_ADD', { actor: ALICE, stack: 5, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say('alice cast Lightning Bolt targeting [bob]', 'STACK_ADD', { actor: ALICE, stack: 4, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say('Doomed Traveler was put into graveyard from battlefield.', 'ZONE_CHANGE', { actor: BOB, of: 5, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say('Doom Blade - Destroy Doomed Traveler.', 'STACK_RESOLVE', { actor: ALICE, resolves: 5, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say('bob triggered Doomed Traveler', 'STACK_ADD', { actor: BOB, stack: 12, parent: 4, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say('bob creates a 1/1 Spirit Token.', 'ZONE_CHANGE', { actor: BOB, of: 12, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say(
    'When Doomed Traveler dies, create a 1/1 white Spirit creature token with flying. [Zone Changer: Doomed Traveler]',
    'STACK_RESOLVE',
    { actor: BOB, resolves: 12, phase: 'COMBAT_DECLARE_ATTACKERS' },
  ),
  say('Lightning Bolt deals 3 non-combat damage to bob.', 'DAMAGE', { actor: ALICE, of: 4, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say('Life: bob 22 > 19', 'LIFE', { actor: BOB, of: 4, life: { player: BOB, from: 22, to: 19 }, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say('Lightning Bolt - Lightning Bolt deals 3 damage to bob.', 'STACK_RESOLVE', { actor: ALICE, resolves: 4, phase: 'COMBAT_DECLARE_ATTACKERS' }),
  say("bob didn't block Grizzly Bears.", 'COMBAT', { actor: BOB, phase: 'COMBAT_DECLARE_BLOCKERS' }),
  say('Grizzly Bears deals 2 combat damage to bob.', 'DAMAGE', { actor: ALICE, phase: 'COMBAT_DAMAGE' }),
  say('Life: bob 19 > 17', 'LIFE', { actor: BOB, life: { player: BOB, from: 19, to: 17 }, phase: 'COMBAT_DAMAGE' }),
  say('alice played Mountain', 'LAND', { actor: ALICE, phase: 'MAIN2' }),
  say('alice cast Opt', 'STACK_ADD', { actor: ALICE, stack: 14, mana: '{U}', phase: 'MAIN2' }),
  say('alice scried 1 card(s) to the top of the library', 'STACK_RESOLVE', { actor: ALICE, of: 14, phase: 'MAIN2' }),
  say('alice draws Brainstorm.', 'ZONE_CHANGE', { actor: ALICE, of: 14, phase: 'MAIN2' }),
  say('Opt - alice scries 1. alice draws a card.', 'STACK_RESOLVE', { actor: ALICE, resolves: 14, phase: 'MAIN2' }),
  say('Turn 2 (bob)', 'TURN', { actor: BOB, turn: 2, phase: 'UNTAP' }),
  say('bob draws a card.', 'ZONE_CHANGE', { actor: BOB, phase: 'DRAW' }),
];

function texts(nodes: readonly LogNode[]): unknown[] {
  return nodes.map((n) =>
    n.kind === 'row'
      ? n.row.text
      : n.kind === 'combat'
        ? { combat: texts(n.nodes) }
        : { item: n.row.text, mana: n.mana, responses: n.responses.map((r) => texts([r])[0]), results: texts(n.results) },
  );
}

const item = (turn: LogTurn, i: number): LogItem => turn.nodes[i] as LogItem;

describe('the game log, as turns', () => {
  it("a response sits under what it answered; each spell's resolution under it; its payment on it", () => {
    const [turn] = buildLog(RESPONSE, PLAYERS, ALICE);
    expect(texts(turn!.nodes)).toEqual([
      {
        item: 'alice cast Lightning Bolt → Llanowar Elves',
        mana: [],
        responses: [{ item: 'bob cast Unsummon → Llanowar Elves', mana: ['U'], responses: [], results: ["Return Llanowar Elves to its owner's hand."] }],
        results: ['Lightning Bolt fizzles: no legal target.'],
      },
      { item: 'alice cast Grizzly Bears', mana: ['G', 'G'], responses: [], results: ['Grizzly Bears enters as a 2/2.'] },
    ]);
    expect(item(turn!, 0).row.seat).toBe('you');
    expect(item(turn!, 0).responses[0]!.row.seat).toBe('them');
  });

  it('a turn line opens a turn; combat is one block; results go under their spell wherever they arrive', () => {
    const turns = buildLog(TURN, PLAYERS, ALICE);
    expect(turns.map((t) => [t.n, t.who, t.seat])).toEqual([
      [1, null, 'none'],
      [2, 'bob', 'them'],
    ]);
    expect(texts(turns[0]!.nodes)).toEqual([
      {
        combat: [
          {
            item: 'alice cast Doom Blade → Doomed Traveler',
            mana: [],
            responses: [],
            // The death came before the line that says Doom Blade resolved; it is still Doom Blade's.
            results: ['Doomed Traveler was put into graveyard from battlefield.', 'Destroy Doomed Traveler.'],
          },
          {
            item: 'alice cast Lightning Bolt → bob',
            mana: [],
            // Bob's trigger went on the stack on top of the Bolt. Its resolution only says the trigger again, so its token is what shows.
            responses: [{ item: 'bob triggered Doomed Traveler', mana: [], responses: [], results: ['bob creates a 1/1 Spirit Token.'] }],
            results: ['Lightning Bolt deals 3 non-combat damage to bob.', 'Life: bob 22 > 19', 'Lightning Bolt deals 3 damage to bob.'],
          },
          "bob didn't block Grizzly Bears.",
          'Grizzly Bears deals 2 combat damage to bob.',
          'Life: bob 19 > 17',
        ],
      },
      'alice played Mountain',
      { item: 'alice cast Opt', mana: ['U'], responses: [], results: ['alice scried 1 card to the top of the library', 'alice draws Brainstorm.', 'alice scries 1. alice draws a card.'] },
    ]);
    expect(turns[0]!.summary).toEqual(['Doom Blade', 'Lightning Bolt', 'Mountain', 'Opt']);
  });

  it("each turn carries both life totals at its end and the change over it, from the log's own life lines", () => {
    const turns = buildLog(TURN, PLAYERS, ALICE);
    expect(turns.map((t) => t.life.map((l) => [l.seat, l.at, l.delta]))).toEqual([
      [
        ['you', 20, 0],
        ['them', 17, -5],
      ],
      [
        ['you', 20, 0],
        ['them', 17, 0],
      ],
    ]);
    const lifeRow = (turns[0]!.nodes[0] as { kind: 'combat'; nodes: LogNode[] }).nodes[4] as { kind: 'row'; row: { life: unknown } };
    expect(lifeRow.row.life).toEqual({ seat: 'them', from: 19, to: 17 });
  });

  it("a turn's life change is read in the order it happened, not the stack's", () => {
    // Bob gains 2 from Swords (cast second, resolved first), then takes 3 from the Bolt under it: net −1.
    const [turn] = buildLog(
      [
        say('alice cast Lightning Bolt targeting [bob]', 'STACK_ADD', { actor: ALICE, stack: 1 }),
        say('alice cast Swords to Plowshares targeting [Savannah Lions]', 'STACK_ADD', { actor: ALICE, stack: 2, parent: 1 }),
        say('Life: bob 20 > 22', 'LIFE', { actor: BOB, of: 2, life: { player: BOB, from: 20, to: 22 } }),
        say('Life: bob 22 > 19', 'LIFE', { actor: BOB, of: 1, life: { player: BOB, from: 22, to: 19 } }),
      ],
      PLAYERS,
      ALICE,
    );
    expect(turn!.life.find((l) => l.player === BOB)).toMatchObject({ at: 19, delta: -1 });
  });

  it('a line from before the public half existed is still a row of its turn, its seat found by the name it opens with, in any case', () => {
    const turns = buildLog(
      [say('Turn 3 (Bob)', 'TURN'), say('Bob played Forest', 'LAND'), say('alice cast Shock', 'STACK_ADD'), plain('full control on')],
      PLAYERS,
      ALICE,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]!.n).toBe(3);
    expect(turns[0]!.seat).toBe('them');
    expect(turns[0]!.nodes.map((n) => (n.kind === 'row' ? [n.row.text, n.row.seat, n.row.kind] : null))).toEqual([
      ['Bob played Forest', 'them', 'land'],
      ['alice cast Shock', 'you', 'cast'],
      ['full control on', 'none', 'said'],
    ]);
  });

  it("a player's spells stacked over their own sit side by side; the lines before the first turn line are the turn before it", () => {
    const turns = buildLog(
      [
        say('alice cast Shock targeting [bob]', 'STACK_ADD', { actor: ALICE, stack: 1 }),
        say('alice cast Opt', 'STACK_ADD', { actor: ALICE, stack: 2, parent: 1 }),
        say('bob cast Counterspell targeting [Opt]', 'STACK_ADD', { actor: BOB, stack: 3, parent: 2 }),
        say('alice cast Brainstorm', 'STACK_ADD', { actor: ALICE, stack: 4, parent: 3 }),
        say('Turn 5 (bob)', 'TURN', { actor: BOB, turn: 5 }),
      ],
      PLAYERS,
      ALICE,
    );
    expect(turns.map((t) => t.n)).toEqual([4, 5]);
    // Opt is beside Shock, not under it; bob's Counterspell answers Opt; alice's Brainstorm answers the Counterspell.
    expect(texts(turns[0]!.nodes)).toEqual([
      { item: 'alice cast Shock → bob', mana: [], responses: [], results: [] },
      {
        item: 'alice cast Opt',
        mana: [],
        responses: [{ item: 'bob cast Counterspell → Opt', mana: [], responses: [{ item: 'alice cast Brainstorm', mana: [], responses: [], results: [] }], results: [] }],
        results: [],
      },
    ]);
  });

  it('a watcher with no seat of its own sees no "you"', () => {
    const [turn] = buildLog(RESPONSE, PLAYERS, null);
    expect(item(turn!, 0).row.seat).toBe('none');
  });
});

describe('the words', () => {
  it("takes out Forge's bookkeeping and reminder text, and says a target as an arrow", () => {
    expect(cleanText('When Temple of Deceit enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.) [Zone Changer: Temple of Deceit]')).toBe(
      'When Temple of Deceit enters, scry 1.',
    );
    expect(cleanText('Exile Prime Speaker Zegana at the beginning of the next end step. ([Prime Speaker Zegana]) [Phase: Hadoku]')).toBe(
      'Exile Prime Speaker Zegana at the beginning of the next end step.',
    );
    expect(cleanText("Azorius Charm -  Put target attacking or blocking creature on top of its owner's library. (Targeting: Varolz, the Scar-Striped)")).toBe(
      "Azorius Charm - Put target attacking or blocking creature on top of its owner's library. → Varolz, the Scar-Striped",
    );
    expect(cleanText('Orcish Bowmasters deals 1 damage to any target. (Targeting: [[TeaW1thRum]]) [Zone Changer: Orcish Bowmasters]')).toBe(
      'Orcish Bowmasters deals 1 damage to any target. → TeaW1thRum',
    );
    expect(cleanText('Hadoku cast Boon Satyr targeting [Prognostic Sphinx]')).toBe('Hadoku cast Boon Satyr → Prognostic Sphinx');
    // X and a card's own id-free parentheses stay.
    expect(cleanText('Sphinx\'s Revelation - ohmusama gains 6 life. ohmusama draws six cards. (X=6)')).toBe("Sphinx's Revelation - ohmusama gains 6 life. ohmusama draws six cards. (X=6)");
    expect(cleanText('Hadoku scried 3 card(s) to the bottom of the library')).toBe('Hadoku scried 3 cards to the bottom of the library');
  });

  it('reads the mana that paid as tokens', () => {
    expect(manaTokens('{G}{G}{U}')).toEqual(['G', 'G', 'U']);
    expect(manaTokens('{W/U}{C}')).toEqual(['W/U', 'C']);
    expect(manaTokens(undefined)).toEqual([]);
  });
});
