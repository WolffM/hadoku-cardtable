/**
 * The initiative, the Undercity and the monarch, against a real Forge jar. The operator, 2026-10-22:
 * *"i don't see 'initiative' anywhere. i feel like either this should be a card or represented as an
 * emblem. same with other stuff like monarch and things of that nature"*, and *"'undercity' has no
 * art"*.
 *
 * `initiative-monarch.state`: seat 0 casts White Plume Adventurer (takes the initiative, ventures
 * into Undercity) and Thorn of the Black Rose (becomes the monarch). Every Command-zone card is
 * logged as the wire carries it (`[designations]` lines), then read through `toBoardView`, as each
 * seat draws it. (Undercity is not asserted: in this scenario the initiative's venture trigger has
 * not been seen to fire — open, see the ledger.)
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/ui/src/play/live/designations.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_STOP_POLICY } from '../../../../server/src/play/auto.ts';
import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from '../../../../server/src/play/scenario.ts';
import { toBoardView } from '../adapter.ts';
import { currentFace, DELTA_TYPE, deltaKey, idsOf, strOf } from '@hadoku/forge-wire';

const title = available.ok ? 'the initiative, the Undercity and the monarch reach the board, against real Forge' : `designations, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Plains']), deck('Any B', ['40 Island'])];

/** The Command zone of `seat`'s player as seat 0 sees it: each card's wire object, raw, and its name. */
function commandZone(s: Scenario, seat: number): { id: number; name: string | null; raw: unknown }[] {
  const state = s.state(0);
  const player = state.get(deltaKey(DELTA_TYPE.player, s.match.seats[seat]?.playerId ?? -1));
  return idsOf(player, 'Command').map((id) => {
    const card = state.get(deltaKey(DELTA_TYPE.card, id));
    return { id, name: strOf(currentFace(state, id), 'Name') ?? strOf(card, 'Name'), raw: { card, face: currentFace(state, id) } };
  });
}

/** Cast `name` from seat 0's hand and run the stack dry, answering every ask plainly. */
async function castAndResolve(s: Scenario, name: string): Promise<void> {
  const card = s.zone(0, 'Hand').find((c) => c.name === name);
  if (card === undefined) throw new Error(`no ${name} in hand`);
  s.select(0, card.id);
  await waitUntil(
    () => {
      s.answerAsks();
      if (s.zone(0, 'Hand').some((c) => c.name === name)) return false;
      if (inOwnMain(s, 0, 3) && /Stack: Empty/.test(s.prompt(0))) return true;
      if (s.prompt(0).startsWith('Priority:') && !/Stack: Empty/.test(s.prompt(0))) s.ok(0);
      return false;
    },
    `${name} cast and the stack resolved`,
    60_000,
    s,
  );
}

describe.skipIf(!available.ok)(title, () => {
  it(
    'logs the Command zone as the wire carries it, and draws each designation at its player',
    async () => {
      if (!available.ok) return;
      const s: Scenario = await startScenario(available.config, { seed: 2210, decks: DECKS, scenario: scenarioText('initiative-monarch'), policy: DEFAULT_STOP_POLICY });
      try {
        await finishMulligan(s);
        await waitUntil(() => (s.answerAsks(), inOwnMain(s, 0, 3)), 'seat 0’s main 1', 90_000, s);

        await castAndResolve(s, 'White Plume Adventurer');
        for (const c of commandZone(s, 0)) console.log(`[designations] after initiative: ${JSON.stringify(c)}`);
        await castAndResolve(s, 'Thorn of the Black Rose');
        for (const c of commandZone(s, 0)) console.log(`[designations] after monarch: ${JSON.stringify(c)}`);

        const names = commandZone(s, 0).map((c) => c.name);
        expect(names, 'Forge put the designations in seat 0’s Command zone').toEqual(expect.arrayContaining(['The Initiative', 'The Monarch']));

        // Both seats draw them at seat 0, in its Command zone, with their art.
        for (const seat of [0, 1]) {
          const view = toBoardView(s.state(seat) as never, 1, { viewerPlayerId: s.match.seats[seat]?.playerId ?? -1 });
          const owner = view.players.find((p) => p.id === s.match.seats[0]?.playerId);
          const drawn = (owner?.command ?? []).map((c) => ({ name: c.card.name, art: c.card.scryfallId ?? null }));
          console.log(`[designations] seat ${seat} draws: ${JSON.stringify(drawn)}`);
          expect(drawn.map((c) => c.name).sort(), `seat ${seat} draws them in seat 0’s Command zone`).toEqual(expect.arrayContaining(['The Initiative', 'The Monarch']));
          expect(drawn.filter((c) => c.art === null).map((c) => c.name), `seat ${seat}: each has its art`).toEqual([]);
        }
      } finally {
        await s.stop();
      }
    },
    240_000,
  );
});
