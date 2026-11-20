/*
 * The board swept cards are played on: a Forge puzzle `[state]` (`../../scenarios/README.md`) with
 * the cards in seat 0's hand on its own first main phase, and enough of everything around them that
 * whatever a card asks for exists — mana of every colour (four of each basic per card), creatures,
 * an artifact and an enchantment on both sides, cards in both graveyards and hands, mixed libraries.
 *
 * One board for every card, on purpose. What a card of the swept sets needed that an ordinary board
 * lacks is here by name: a Food and a creature token (forage, a token to copy), a tapped creature
 * and one with power 4 on the other side (removal that asks for either), and a creature in the AI's
 * hand with the lands to cast it, which is the spell a counterspell waits for. A card that still
 * finds nothing to do is reported as never offered, and gets a scenario of its own.
 */
import type { SetCard } from './set-cards.ts';

const each = (name: string, n: number): string[] => Array.from({ length: n }, () => name);

const BASICS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
/** How many of each basic one card is given: enough for any cost in the set and its optional extra. */
const LANDS_PER_CARD = 4;
const PERMANENTS = ['Grizzly Bears', 'Savannah Lions', 'Ornithopter', 'Mind Stone', 'Intangible Virtue', 'T:c_a_food_sac', 'T:g_1_1_squirrel'];
const GRAVEYARD = ['Grizzly Bears', 'Hill Giant', 'Llanowar Elves', 'Shock', 'Cancel', 'Divination', 'Forest', 'Mountain'];
const LIBRARY = ['Forest', 'Grizzly Bears', 'Shock', 'Island', 'Hill Giant', 'Divination', 'Swamp', 'Llanowar Elves', 'Mountain', 'Plains', 'Savannah Lions', 'Forest'];

/** The scenario text for one match that plays `cards`. */
export function boardFor(cards: readonly SetCard[]): string {
  const lands = BASICS.flatMap((l) => each(l, LANDS_PER_CARD * cards.length));
  return [
    'turn=3',
    'activeplayer=human',
    'activephase=MAIN1',
    // Enough life to be attacked for the turns the seat plays on.
    'humanlife=60',
    'ailife=20',
    // A second card and a land, for a cost or an effect that discards.
    `humanhand=${[...cards.map((c) => c.name), 'Runeclaw Bear', 'Swamp'].join(';')}`,
    `humanbattlefield=${[...lands, ...PERMANENTS].join(';')}`,
    `humanlibrary=${LIBRARY.join(';')}`,
    `humangraveyard=${GRAVEYARD.join(';')}`,
    'aihand=Forest;Grizzly Bears',
    `aibattlefield=${[...each('Forest', 2), ...each('Island', 2), 'Hill Giant', 'Craw Wurm', 'Runeclaw Bear|Tapped', 'Ornithopter', 'Mind Stone', 'Intangible Virtue'].join(';')}`,
    `ailibrary=${LIBRARY.join(';')}`,
    `aigraveyard=${GRAVEYARD.join(';')}`,
  ].join('\n');
}
