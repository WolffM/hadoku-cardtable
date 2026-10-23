/**
 * Nomads en-Kor's {0}, twice, against a real Forge jar. The operator, 2026-10-23, on a stack of "en-Kor
 * Redirection" cards in the Command zone: *"i wouldn't want them to show in the command zone anyway"*,
 * and, asked whether they cleared at end of turn, *"i don't think so"*.
 *
 * Each activation is an `EFFECT` card Forge keeps in its controller's Command zone for the effect's
 * duration (`SpellAbilityEffect.createEffect`), the bookkeeping of a resolved ability, not a thing the
 * player has. So the board draws none of them there, and the turn's end takes them out of the state.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/ui/src/play/live/enkor-effects.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_STOP_POLICY } from '../../../../server/src/play/auto.ts';
import { available, deck, finishMulligan, inOwnMain, passUntil, scenarioText, startScenario, waitUntil, type Scenario } from '../../../../server/src/play/scenario.ts';
import { toBoardView } from '../adapter.ts';

const title = available.ok ? 'Nomads en-Kor’s effects stay off the board and leave at end of turn, against real Forge' : `en-Kor effects, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Plains']), deck('Any B', ['40 Island'])];

const redirections = (s: Scenario, seat: number) => s.zone(seat, 'Command').filter((c) => c.name === 'en-Kor Redirection');

/** Activate Nomads en-Kor's {0} at Grizzly Bears and run the stack dry. */
async function activate(s: Scenario): Promise<void> {
  const before = redirections(s, 0).length;
  const nomads = s.zone(0, 'Battlefield').find((c) => c.name === 'Nomads en-Kor');
  const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears');
  if (nomads === undefined || bears === undefined) throw new Error('no Nomads en-Kor or Grizzly Bears');
  s.select(0, nomads.id);
  let targeted = false;
  await waitUntil(
    () => {
      s.answerAsks();
      const said = s.prompt(0);
      if (!targeted && /Select target/.test(said)) {
        targeted = true;
        s.select(0, bears.id);
        return false;
      }
      if (redirections(s, 0).length > before && inOwnMain(s, 0, 3)) return true;
      if (said.startsWith('Priority:') && !/^Stack: Empty$/m.test(said) && s.buttons(0)?.enable1 === true) s.ok(0);
      return false;
    },
    'the redirection resolved',
    60_000,
    s,
  );
}

describe.skipIf(!available.ok)(title, () => {
  it(
    'two activations are two effects in Forge’s Command zone, drawn by neither seat, and gone once the turn ends',
    async () => {
      if (!available.ok) return;
      const s: Scenario = await startScenario(available.config, { seed: 2310, decks: DECKS, scenario: scenarioText('enkor-redirection'), policy: DEFAULT_STOP_POLICY });
      try {
        await finishMulligan(s);
        await waitUntil(() => (s.answerAsks(), inOwnMain(s, 0, 3)), 'seat 0’s main 1', 90_000, s);

        await activate(s);
        await activate(s);
        console.log(`[enkor] Command after two activations: ${JSON.stringify(s.zone(0, 'Command'))}`);
        expect(redirections(s, 0).length, 'Forge keeps one effect per activation').toBe(2);

        for (const seat of [0, 1]) {
          const view = toBoardView(s.state(seat) as never, 1, { viewerPlayerId: s.match.seats[seat]?.playerId ?? -1 });
          const owner = view.players.find((p) => p.id === s.match.seats[0]?.playerId);
          expect(owner?.command?.map((c) => c.card.name) ?? [], `seat ${seat} draws no effect in seat 0’s Command zone`).toEqual([]);
        }

        await passUntil(s, () => s.turn(0)?.n === 4, 'seat 1’s turn');
        console.log(`[enkor] Command at turn 4: ${JSON.stringify(s.zone(0, 'Command'))}`);
        expect(redirections(s, 0), 'the end of the turn took the effects away').toEqual([]);
      } finally {
        await s.stop();
      }
    },
    240_000,
  );
});
