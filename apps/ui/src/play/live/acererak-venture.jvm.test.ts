/**
 * A dungeon on the board, against a real Forge jar. The operator, 2026-10-27: *"Acererak the archlich
 * isn't showing the tomb of annihilation as a token? also the zombie token it's showing looks weird it
 * has no stats on it."*
 *
 * `acererak-venture.state`: seat 0 casts Acererak the Archlich; it returns to hand and ventures, and
 * seat 0 picks Tomb of Annihilation. Forge puts the dungeon in seat 0's Command zone (`VentureEffect`
 * makes it from its tokenscript), and both seats draw it there with its art; seat 0's Zombie token and
 * The Atropal carry their power and toughness. What the operator saw was the related cards a hovered
 * Acererak shows (`draft/related.test.ts`): no dungeons, and Unglued's Zombie, which prints no stats.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/ui/src/play/live/acererak-venture.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_STOP_POLICY } from '../../../../server/src/play/auto.ts';
import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from '../../../../server/src/play/scenario.ts';
import { toBoardView } from '../adapter.ts';

const title = available.ok ? 'a ventured dungeon is drawn in its player’s Command zone, against real Forge' : `acererak-venture, against real Forge — SKIPPED: ${available.reason}`;

const DUNGEON = 'Tomb of Annihilation';

describe.skipIf(!available.ok)(title, () => {
  it(
    'Acererak ventures into Tomb of Annihilation: both seats draw it in seat 0’s Command zone with its art, and each creature token with its stats',
    async () => {
      if (!available.ok) return;
      const s: Scenario = await startScenario(available.config, {
        seed: 2710,
        decks: [deck('Swamps', ['40 Swamp']), deck('Islands', ['40 Island'])],
        scenario: scenarioText('acererak-venture'),
        policy: DEFAULT_STOP_POLICY,
        reply: (f) => (f.method === 'getChoices' && (f.names as string[] | undefined)?.includes(DUNGEON) === true ? [DUNGEON] : undefined),
      });
      try {
        await finishMulligan(s);
        await waitUntil(() => (s.answerAsks(), inOwnMain(s, 0, 3)), 'seat 0’s main 1', 90_000, s);
        const acererak = s.zone(0, 'Hand').find((c) => c.name === 'Acererak the Archlich');
        if (acererak === undefined) throw new Error('no Acererak in hand');
        s.select(0, acererak.id);
        await waitUntil(
          () => {
            s.answerAsks();
            const prompt = s.prompt(0);
            if (!prompt.startsWith('Priority:')) return false;
            if (!/Stack: Empty/.test(prompt)) {
              s.ok(0);
              return false;
            }
            return s.zone(0, 'Command').length > 0;
          },
          'Acererak to resolve and venture',
          60_000,
          s,
        );

        const ownerAt = (seat: number) => {
          const view = toBoardView(s.state(seat) as never, 1, { viewerPlayerId: s.match.seats[seat]?.playerId ?? -1 });
          return view.players.find((p) => p.id === s.match.seats[0]?.playerId)!;
        };
        // Each seat's frames arrive on their own: seat 1's delta can trail seat 0's.
        await waitUntil(() => (s.answerAsks(), [0, 1].every((seat) => (ownerAt(seat).command ?? []).length > 0)), 'both seats to be sent the dungeon', 10_000, s).catch(() => undefined);
        for (const seat of [0, 1]) {
          const owner = ownerAt(seat);
          const command = (owner.command ?? []).map((c) => ({ name: c.card.name, type: c.card.typeLine, art: c.card.scryfallId ?? null }));
          console.log(`[acererak-venture] seat ${seat} draws seat 0's Command zone: ${JSON.stringify(command)}`);
          expect(command, `seat ${seat}: the dungeon, in seat 0’s Command zone, with its art`).toEqual([
            { name: DUNGEON, type: 'Dungeon', art: '70b284bd-7a8f-4b60-8238-f746bdc5b236' },
          ]);
          const tokens = owner.battlefield.filter((c) => c.token).map((c) => [c.card.name, c.card.power, c.card.toughness]);
          expect(tokens, `seat ${seat}: each creature token with its power and toughness`).toEqual(
            expect.arrayContaining([
              ['Zombie Token', '2', '2'],
              ['The Atropal', '4', '4'],
            ]),
          );
        }
      } finally {
        await s.stop();
      }
    },
    240_000,
  );
});
