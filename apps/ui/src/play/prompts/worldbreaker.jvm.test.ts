/*
 * Wave 42 §P item 3 — W16, against a REAL Forge match.
 *
 * Operator: *"i played worldbreaker and it went on the stack. but the
 * effect that i'm choosing was never explained to me. the decision box
 * should pop up for things like this."*
 *
 * The real card is World Breaker (`forge-gui/res/cardsfolder/w/
 * world_breaker.txt`): "When you cast this spell, exile target artifact,
 * enchantment, or land." Measured against the real jar, casting it opens:
 *
 *   ask openZones (Battlefield — a no-op notice, auto-answered)
 *   notify setSelectables { cards: [8 land ids, both battlefields], min: 1, max: 1 }
 *   notify showPromptMessage "World Breaker (81) - When you cast this
 *     spell, exile target artifact, enchantment, or land. […]\n\nSelect
 *     target artifact, enchantment or land"
 *
 * Every named id is a BATTLEFIELD permanent — `classifySelection`
 * (`./SelectionPrompt.tsx`) reads this as `'on-board'`, not `'off-board'`:
 * the board's own highlight already offers a click on each of the 8 lands.
 * What is missing — and what this test proves is sitting unused on the
 * wire — is Forge's own prompt line, the one quoted above, which names the
 * trigger ("exile target artifact, enchantment, or land") and is never
 * drawn as a titled pop-up for an `'on-board'` selection today; `LiveBoard.tsx`
 * (lane L) only ever put a selection's `match.prompt` into the collapsed
 * log (`live__says`), the same architecture fact `../live/match.ts`'s own
 * module header documents. Mounting `SelectionPrompt` for `'on-board'` too
 * (lane L, per `P-contract.md` §3) is what turns this ALREADY-PRESENT text
 * into the pop-up the operator asked for; this lane's own files already
 * classify the selection correctly and already draw that exact text when
 * handed it (`selection.test.ts`'s own "draws Forge's own message verbatim"
 * case).
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w42-P/work \
 *   pnpm exec vitest run apps/ui/src/play/prompts/worldbreaker.jvm.test.ts --fileParallelism=false
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from '../../../../server/src/play/scenario.ts';
import { classifySelection } from './SelectionPrompt.tsx';

const title = available.ok
  ? "W16: World Breaker's cast-trigger target, against a real Forge match"
  : `W16: World Breaker's cast-trigger target, against a real Forge match — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('WB A', ['40 Mountain']), deck('WB B', ['40 Mountain'])];

interface OpenSelection {
  cards: number[];
  min: number;
  max: number;
}

async function castWorldBreakerAndWaitForTarget(seed: number): Promise<{ s: Scenario; selection: OpenSelection }> {
  if (!available.ok) throw new Error(available.reason);
  const s = await startScenario(available.config, { seed, decks: DECKS, scenario: scenarioText('w42-worldbreaker') });
  await finishMulligan(s);
  // A cast sent before Forge's priority input is live is dropped, and the
  // hand can show the card a frame before that input opens.
  await waitUntil(
    () => {
      s.answerAsks();
      return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'World Breaker');
    },
    "seat 0's hand to reflect the scripted World Breaker",
    20_000,
    s,
  );
  const card = s.zone(0, 'Hand').find((c) => c.name === 'World Breaker');
  if (card === undefined) throw new Error('no World Breaker in hand');
  s.select(0, card.id);

  let selection: OpenSelection | null = null;
  await waitUntil(
    () => {
      s.answerAsks(); // the "play this trigger?" ask and the no-op openZones notice
      const bar = s.buttons(0);
      if (bar?.label1 === 'Auto' && bar.enable1) s.ok(0); // pay {6}{G}
      const last = [...s.sent].reverse().find((x) => x.seat === 0 && x.envelope.frame.method === 'setSelectables');
      if (last !== undefined) {
        const f = last.envelope.frame as unknown as { cards: { id: number }[]; min: number; max: number };
        selection = { cards: f.cards.map((c) => c.id), min: f.min, max: f.max };
      }
      return selection !== null && /Select target/.test(s.prompt(0));
    },
    "the cast trigger's own target selection",
    20_000,
    s,
  );
  if (selection === null) throw new Error('unreachable');
  return { s, selection };
}

describe.skipIf(!available.ok)(title, () => {
  it(
    'is a real setSelectables naming every land on the table (on-board), carrying Forge’s own trigger text — the data a pop-up needs is on the wire',
    async () => {
      if (!available.ok) return;
      const { s, selection } = await castWorldBreakerAndWaitForTarget(5301);
      try {
        expect(selection.min).toBe(1);
        expect(selection.max).toBe(1);
        // Every land on EITHER battlefield is a legal target (`ValidTgts$
        // Artifact,Enchantment,Land` has no `+Other`) — 7 of seat 0's, 1 of
        // seat 1's.
        expect(selection.cards.length).toBeGreaterThanOrEqual(8);

        const onBoardIds = new Set([...s.zone(0, 'Battlefield').map((c) => c.id), ...s.zone(1, 'Battlefield').map((c) => c.id)]);
        for (const id of selection.cards) expect(onBoardIds.has(id), `selected id ${id} is on a battlefield`).toBe(true);
        expect(classifySelection(selection, onBoardIds)).toBe('on-board');

        // Forge's own words for the question — exactly what a pop-up would
        // show, already on the wire, never invented by this lane.
        expect(s.prompt(0)).toContain('exile target artifact, enchantment, or land');
        expect(s.prompt(0)).toContain('Select target artifact, enchantment or land');

        // No Cancel: the trigger is mandatory once it is on the stack (the
        // cost of casting World Breaker is already paid), so both bar
        // buttons are disabled until a target is clicked — min=1, no decline.
        const bar = s.buttons(0);
        expect(bar?.enable1).toBe(false);
        expect(bar?.enable2).toBe(false);
      } finally {
        await s.stop();
      }
    },
    60_000,
  );

  it(
    'clicking one of the on-board targets exiles exactly that permanent',
    async () => {
      if (!available.ok) return;
      const { s, selection } = await castWorldBreakerAndWaitForTarget(5302);
      try {
        const targetId = selection.cards.find((id) => s.zone(1, 'Battlefield').some((c) => c.id === id)) ?? selection.cards[0]!;
        s.select(0, targetId);
        await waitUntil(
          () => {
            s.answerAsks();
            return !s.zone(0, 'Battlefield').some((c) => c.id === targetId) && !s.zone(1, 'Battlefield').some((c) => c.id === targetId);
          },
          'the chosen land to leave the battlefield (exiled)',
          20_000,
          s,
        );
      } finally {
        await s.stop();
      }
    },
    60_000,
  );
});
