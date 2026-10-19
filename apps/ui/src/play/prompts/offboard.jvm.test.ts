/*
 * Wave 42 §P item 1 — the W18 soft-lock, against a REAL Forge match.
 *
 * Operator, playtest 7, match `m-09487f336215`: *"you may pay {X}. If you
 * do, return another target Zombie creature card … from your graveyard"* —
 * Relentless Dead's second dies trigger (`forge-gui/res/cardsfolder/r/
 * relentless_dead.txt`) targets a card in the GRAVEYARD, and no board
 * element could pick it or decline it, so the game locked.
 *
 * **Measured here, not assumed, and corrected once after a manager
 * send-back.** A first draft of `w42-relentless-dead.state` gave the
 * graveyard only ONE legal Zombie target, and Forge's own `TargetSelection`
 * — reached while the triggered ability is put on the stack, before it is
 * even offered as a `getAbilityToPlay` "play this trigger?" choice — picked
 * that sole target with NO wire frame at all: no `ask`, no `setSelectables`.
 * A one-target graveyard never exercises the targeting UI and proves
 * nothing. With TWO legal targets (the scenario now on disk), Forge sends
 * exactly the shape the brief hypothesized:
 *
 *   notify setSelectables { cards: [two graveyard ids], min: 1, max: 1 }
 *
 * naming two cards that are in the graveyard, not on any battlefield — the
 * soft-lock's exact shape. `classifySelection` (`./SelectionPrompt.tsx`)
 * reads this as `'off-board'`.
 *
 * **The real "you may pay {X}" decision is NOT this selection at all.** It
 * is the payment of `{X}` that follows it: the trigger's own `Cost$ X` is
 * paid on resolution, and a trigger with a cost is always "confirmed" by
 * Forge (`PlayerControllerHuman.confirmTrigger`: *"triggers with costs can
 * always be declined by not paying the cost"*). `X` is the chosen target's
 * mana value (`SVar:X:Targeted$CardManaCost`), so the target is picked first
 * and the payment window, with Forge's own Cancel, is where the seat says no.
 * Each trigger also reaches the wire once as a one-ability `getAbilityToPlay`
 * (`PlaySpellAbility.chooseOptionalAdditionalCosts`); that offer has one
 * answer and the server plays it in every mode, as Forge's own clients do
 * (`CMatchUI.getAbilityToPlay`, `MatchController.getAbilityToPlay`), so it is
 * no decline.
 *
 * This suite drives the SERVER/bridge directly (`apps/server/src/play/
 * scenario.ts`'s `s.select`/`s.ok`, the same calls a UI click would
 * trigger) rather than through a browser, because this lane's files are
 * `apps/ui/src/play/prompts/**` and lane L (`LiveBoard.tsx`) is the one that
 * mounts `SelectionPrompt` on a real socket — see `P-contract.md`.
 * `SelectionPrompt`'s own unit tests (`selection.test.ts`) prove it renders
 * the off-board shape as a clickable grid.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w42-P/work \
 *   pnpm exec vitest run apps/ui/src/play/prompts/offboard.jvm.test.ts --fileParallelism=false
 */

import { describe, expect, it } from 'vitest';

import { paymentCost } from '../../../../server/src/play/auto.ts';
import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from '../../../../server/src/play/scenario.ts';

const title = available.ok
  ? "the W18 soft-lock: Relentless Dead's graveyard target, against a real Forge match"
  : `the W18 soft-lock: Relentless Dead's graveyard target, against a real Forge match — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('RD A', ['40 Mountain']), deck('RD B', ['40 Mountain'])];

interface OpenSelection {
  cards: number[];
  min: number;
  max: number;
}

/** Cast Kozilek's Return, whose damage kills Relentless Dead and puts both its dies triggers on the stack. */
async function castKozileksReturn(seed: number): Promise<Scenario> {
  if (!available.ok) throw new Error(available.reason);
  const s = await startScenario(available.config, {
    seed,
    decks: DECKS,
    scenario: scenarioText('w42-relentless-dead'),
  });
  await finishMulligan(s);
  // A cast sent before Forge's priority input is live is dropped, and the
  // hand can show the card a frame before that input opens.
  await waitUntil(
    () => {
      s.answerAsks();
      return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === "Kozilek's Return");
    },
    "seat 0's hand to reflect the scripted Kozilek's Return",
    20_000,
    s,
  );
  const card = s.zone(0, 'Hand').find((c) => c.name === "Kozilek's Return");
  if (card === undefined) throw new Error("no Kozilek's Return in hand");
  s.select(0, card.id);
  return s;
}

/**
 * Answer the default asks and press Auto on any live mana window, as the
 * seat would: Kozilek's Return's `{2}{R}`, `TrigReturn`'s `{B}` (the
 * scenario's Swamp is there for exactly this) and `TrigChange`'s `{X}`. The
 * two trigger payments are "you may pay" costs the server shows the seat
 * rather than paying for it, so the driver pays them.
 */
function answerAndPay(s: Scenario): void {
  s.answerAsks();
  const bar = s.buttons(0);
  if (bar?.label1 === 'Auto' && bar.enable1) s.ok(0);
}

/** Drive `s` (already casting) until the second trigger's own target selection opens — two graveyard cards. */
async function reachTheGraveyardSelection(s: Scenario): Promise<OpenSelection> {
  let selection: OpenSelection | null = null;
  await waitUntil(
    () => {
      answerAndPay(s);
      const last = [...s.sent].reverse().find((x) => x.seat === 0 && x.envelope.frame.method === 'setSelectables');
      if (last !== undefined) {
        const f = last.envelope.frame as unknown as { cards: { id: number }[]; min: number; max: number };
        if (f.cards.length > 1) selection = { cards: f.cards.map((c) => c.id), min: f.min, max: f.max };
      }
      return selection !== null;
    },
    'the second trigger’s own target selection — two graveyard cards, not one',
    30_000,
    s,
  );
  if (selection === null) throw new Error('unreachable');
  return selection;
}

describe.skipIf(!available.ok)(title, () => {
  it(
    'the real "you may pay {X}" decision is the {X} payment after the target — declining it (Cancel) leaves both graveyard cards untouched and the game continues normally',
    async () => {
      if (!available.ok) return;
      const s = await castKozileksReturn(4210);
      try {
        const selection = await reachTheGraveyardSelection(s);
        s.select(0, selection.cards[0]!);
        let declined: string | null = null;
        await waitUntil(
          () => {
            s.answerAsks();
            const bar = s.buttons(0);
            const cost = paymentCost(s.prompt(0));
            if (declined === null && cost !== null && cost !== '{B}' && bar?.label1 === 'Auto' && bar.enable2) {
              declined = cost;
              s.cancel(0);
            } else if (bar?.label1 === 'Auto' && bar.enable1) s.ok(0);
            return declined !== null && /Stack: Empty/.test(s.prompt(0));
          },
          'the stack to resolve empty after declining the {X} payment',
          20_000,
          s,
        );
        console.log(`[offboard] declined the payment of ${String(declined)}`);
        expect(s.zone(0, 'Graveyard').some((c) => c.name === 'Diregraf Ghoul')).toBe(true);
        expect(s.zone(0, 'Graveyard').some((c) => c.name === 'Dread Wanderer')).toBe(true);
        expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Diregraf Ghoul' || c.name === 'Dread Wanderer')).toBe(false);
        // Priority genuinely returns — never a lock.
        expect(s.buttons(0)?.label1).toBe('OK');
      } finally {
        await s.stop();
      }
    },
    60_000,
  );

  it(
    'the trigger opens the real target selection: a setSelectables naming two cards, both in the graveyard — nothing on the battlefield can answer it by clicking the board',
    async () => {
      if (!available.ok) return;
      const s = await castKozileksReturn(4211);
      try {
        const selection = await reachTheGraveyardSelection(s);
        expect(selection.min).toBe(1);
        expect(selection.max).toBe(1);
        expect(selection.cards).toHaveLength(2);
        // Forge's own bar has NO Cancel here either: the target itself is
        // MANDATORY once the ability is being played (a legal Zombie
        // exists) — `SelectionPrompt` correctly draws no Cancel/Done for
        // this selection; declining is the {X} payment after it (the test
        // above), not this step.
        const bar = s.buttons(0);
        expect(bar?.enable2).toBe(false);
        const graveyardIds = new Set(s.zone(0, 'Graveyard').map((c) => c.id));
        const battlefieldIds = new Set(s.zone(0, 'Battlefield').map((c) => c.id));
        for (const id of selection.cards) {
          expect(graveyardIds.has(id), `selected id ${id} is in the graveyard`).toBe(true);
          expect(battlefieldIds.has(id), `selected id ${id} must not be on the battlefield — that is the soft-lock's whole shape`).toBe(false);
        }
      } finally {
        await s.stop();
      }
    },
    60_000,
  );

  it(
    'picking one of the two graveyard cards returns exactly that card to the battlefield',
    async () => {
      if (!available.ok) return;
      const s = await castKozileksReturn(4212);
      try {
        const selection = await reachTheGraveyardSelection(s);
        const chosen = selection.cards[0]!;
        const other = selection.cards[1]!;
        s.select(0, chosen);
        await waitUntil(
          () => {
            answerAndPay(s);
            return s.zone(0, 'Battlefield').some((c) => c.id === chosen);
          },
          'the chosen graveyard card to enter the battlefield',
          20_000,
          s,
        );
        expect(s.zone(0, 'Battlefield').some((c) => c.id === chosen)).toBe(true);
        // The OTHER legal target was never touched — exactly one card moved.
        expect(s.zone(0, 'Graveyard').some((c) => c.id === other)).toBe(true);
        expect(s.zone(0, 'Battlefield').some((c) => c.id === other)).toBe(false);
      } finally {
        await s.stop();
      }
    },
    60_000,
  );
});
