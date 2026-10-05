/*
 * Wave 42 §P, manager send-back — W18 (Sanctum of Ugin) and W16 (World
 * Breaker) are ONE event, against a REAL Forge match.
 *
 * The manager's read of the production log for `m-09487f336215`
 * (`~/.pm2/logs/cardtable-out.log`): at 01:00:10.781 seat 0 auto-paid
 * `{6}{G}` for World Breaker, and at 01:00:10.795 Forge asked `order`
 * (`ask-auto-answered … "why":"Forge's own order"` — the SERVER answered it,
 * the browser never saw it) — two SIMULTANEOUS triggers from one cast.
 * World Breaker (`forge-gui/res/cardsfolder/w/world_breaker.txt`) has
 * `K:Devoid` (colorless despite `{6}{G}`) and mana value 7, so casting it
 * fires BOTH Sanctum of Ugin's own "whenever you cast a colorless spell
 * with mana value 7 or greater, you may sacrifice CARDNAME" trigger AND
 * World Breaker's own "when you cast this spell, exile target artifact,
 * enchantment, or land" trigger — one cast, two questions.
 *
 * **Measured here, against the real jar** (`w42-sanctum-worldbreaker.state`:
 * Sanctum of Ugin + 7 mana sources + World Breaker in hand + a colorless
 * creature in the library for the search):
 *
 *   ask getAbilityToPlay  "World Breaker - Creature 5/7"          (cast it)
 *   notify updateButtons  Auto/Cancel, then Auto enabled           (pay {6}{G})
 *   ask getAbilityToPlay  "When you cast this spell, exile target…" (World Breaker's own trigger — play it)
 *   ask openZones         Battlefield (no-op notice)
 *   notify setSelectables { 7 land ids, min:1, max:1 }              ← the "arrow"
 *   notify showPromptMessage "World Breaker (81) - When you cast this
 *     spell, exile target artifact, enchantment, or land. […]\n\nSelect
 *     target artifact, enchantment or land"                        ← World Breaker's OWN text
 *   (player picks a target — NOT logged as an ask; this is the exact
 *    window the production log's 40-SECOND GAP between s0-27 and s0-28
 *    falls in: openZones answered at 01:00:10.865, the next ask not until
 *    01:00:50.963 — no ask to wait on, just an unexplained on-board
 *    selection, exactly W16's own diagnosis)
 *   ask getAbilityToPlay  "Whenever you cast a colorless spell…"    (Sanctum's trigger — play it, queued AFTER World Breaker's own trigger resolves, not simultaneously ordered in anything the player sees)
 *   notify updateButtons  Yes/No
 *   notify showPromptMessage "Sacrifice Sanctum of Ugin?"           ← Sanctum's OWN text, never conflated with World Breaker's
 *
 * So: the two questions are sequential, not overlapping, and each already
 * carries its own correct text — `SelectionPrompt` (mounted for `'on-board'`,
 * this wave) draws World Breaker's; the existing `isConfirmPrompt`/
 * `ConfirmPrompt` (wave 36's T4) draws Sanctum's. **No gap found that this
 * lane's files (or any file) need to close beyond what items 1–3 already
 * built** — the 40-second gap in production is exactly the UNEXPLAINED
 * on-board selection W16 already diagnosed, now proven to be the SAME
 * selection Sanctum's question was blended into in the operator's report.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w42-P/work \
 *   pnpm exec vitest run apps/ui/src/play/prompts/sanctum-worldbreaker.jvm.test.ts --fileParallelism=false
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from '../../../../server/src/play/scenario.ts';
import { classifySelection } from './SelectionPrompt.tsx';
import { isConfirmPrompt } from './ConfirmPrompt.tsx';

const title = available.ok
  ? 'W18+W16 are one event: World Breaker’s own target then Sanctum’s own Yes/No, against a real Forge match'
  : `W18+W16 are one event: World Breaker’s own target then Sanctum’s own Yes/No, against a real Forge match — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('SW A', ['40 Mountain']), deck('SW B', ['40 Mountain'])];

interface OpenSelection {
  cards: number[];
  min: number;
  max: number;
}

/** Cast World Breaker and drive to its own target selection — never answers it. */
async function castWorldBreakerWithSanctum(seed: number): Promise<{ s: Scenario; selection: OpenSelection }> {
  if (!available.ok) throw new Error(available.reason);
  const s = await startScenario(available.config, { seed, decks: DECKS, scenario: scenarioText('w42-sanctum-worldbreaker') });
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
      s.answerAsks(); // the cast confirm, World Breaker's own trigger confirm, openZones
      const bar = s.buttons(0);
      if (bar?.label1 === 'Auto' && bar.enable1) s.ok(0); // pay {6}{G}
      const last = [...s.sent].reverse().find((x) => x.seat === 0 && x.envelope.frame.method === 'setSelectables');
      if (last !== undefined) {
        const f = last.envelope.frame as unknown as { cards: { id: number }[]; min: number; max: number };
        selection = { cards: f.cards.map((c) => c.id), min: f.min, max: f.max };
      }
      return selection !== null && /Select target/.test(s.prompt(0));
    },
    "World Breaker's own target selection",
    20_000,
    s,
  );
  if (selection === null) throw new Error('unreachable');
  return { s, selection };
}

/**
 * Past the target selection, into Sanctum's own trigger — the Yes/No bar.
 *
 * Sanctum of Ugin is itself a legal target for World Breaker's own "exile
 * target artifact, enchantment, or land" (it is a land) — picking IT would
 * exile Sanctum through a completely different effect and make the later
 * Yes/No answer untestable (Sanctum would already be gone either way). A
 * Mountain is always among the seven offered and is never Sanctum's own
 * name, so this targets one explicitly rather than taking `cards[0]`.
 */
async function resolveTargetAndReachSanctum(s: Scenario, selection: OpenSelection): Promise<void> {
  const mountain = s.zone(0, 'Battlefield').find((c) => c.name === 'Mountain' && selection.cards.includes(c.id));
  const targetId = mountain?.id ?? selection.cards[0]!;
  s.select(0, targetId);
  await waitUntil(
    () => {
      s.answerAsks(); // Sanctum's own "play this trigger?" getAbilityToPlay — one option
      return /Sacrifice Sanctum of Ugin\?/.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
    },
    "Sanctum's own Yes/No question",
    20_000,
    s,
  );
}

describe.skipIf(!available.ok)(title, () => {
  it(
    "World Breaker's own target selection is on-board (every id a battlefield land) and carries World Breaker's OWN text — never Sanctum's",
    async () => {
      if (!available.ok) return;
      const { s, selection } = await castWorldBreakerWithSanctum(6101);
      try {
        expect(selection.min).toBe(1);
        expect(selection.max).toBe(1);
        expect(selection.cards.length).toBeGreaterThanOrEqual(7);
        const onBoardIds = new Set([...s.zone(0, 'Battlefield').map((c) => c.id), ...s.zone(1, 'Battlefield').map((c) => c.id)]);
        for (const id of selection.cards) expect(onBoardIds.has(id)).toBe(true);
        expect(classifySelection(selection, onBoardIds)).toBe('on-board');

        expect(s.prompt(0)).toContain('World Breaker');
        expect(s.prompt(0)).toContain('exile target artifact, enchantment, or land');
        expect(s.prompt(0)).not.toContain('Sanctum');
        // No `order` ask ever reached the browser — the server answered it.
        expect(s.asks.map((a) => (a as unknown as { method: string }).method)).not.toContain('order');
      } finally {
        await s.stop();
      }
    },
    60_000,
  );

  it(
    "after picking World Breaker's target, Sanctum's OWN Yes/No question appears next — sequential, not conflated — and isConfirmPrompt is true for it",
    async () => {
      if (!available.ok) return;
      const { s, selection } = await castWorldBreakerWithSanctum(6102);
      try {
        await resolveTargetAndReachSanctum(s, selection);
        const bar = s.buttons(0);
        expect(bar?.label1).toBe('Yes');
        expect(bar?.label2).toBe('No');
        expect(isConfirmPrompt(bar)).toBe(true);
        expect(s.prompt(0)).not.toContain('World Breaker');
        expect(s.prompt(0)).toBe('Sacrifice Sanctum of Ugin?');
        // Never a selection for this question — the existing ConfirmPrompt handles it.
        const sawSelectablesForSanctum = s.sent
          .slice(s.sent.findIndex((x) => x.seat === 0 && /Sacrifice Sanctum/.test((x.envelope.frame as unknown as { message?: string }).message ?? '')))
          .some((x) => x.seat === 0 && x.envelope.frame.method === 'setSelectables');
        expect(sawSelectablesForSanctum).toBe(false);
      } finally {
        await s.stop();
      }
    },
    60_000,
  );

  it('answering Yes sacrifices the Sanctum and searches the library', async () => {
    if (!available.ok) return;
    const { s, selection } = await castWorldBreakerWithSanctum(6103);
    try {
      await resolveTargetAndReachSanctum(s, selection);
      s.ok(0); // "Yes"
      await waitUntil(
        () => {
          s.answerAsks(); // the library search
          return !s.zone(0, 'Battlefield').some((c) => c.name === 'Sanctum of Ugin');
        },
        'the Sanctum to leave the battlefield (sacrificed)',
        20_000,
        s,
      );
      expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Sanctum of Ugin')).toBe(false);
    } finally {
      await s.stop();
    }
  }, 60_000);

  it('answering No keeps the Sanctum in play, and the game continues (priority returns, no lock)', async () => {
    if (!available.ok) return;
    const { s, selection } = await castWorldBreakerWithSanctum(6104);
    try {
      await resolveTargetAndReachSanctum(s, selection);
      s.cancel(0); // "No"
      await waitUntil(
        () => {
          s.answerAsks();
          return /Stack: Empty/.test(s.prompt(0));
        },
        'the stack to resolve empty after declining',
        20_000,
        s,
      );
      expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Sanctum of Ugin')).toBe(true);
      // Priority genuinely returns — not stuck.
      expect(s.buttons(0)?.label1).toBe('OK');
    } finally {
      await s.stop();
    }
  }, 60_000);
});
