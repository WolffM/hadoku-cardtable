// @vitest-environment jsdom
/*
 * Wave 34 §G item 1 — the Choose X slider, against a REAL Forge match.
 *
 * w33 shipped `NumberChoiceSlider` (`ChoicePrompts.tsx`) unit-tested only,
 * against a synthetic `getChoices` fixture built by hand. This casts the
 * scripted Fireball in `scenarios/choose-x.state` against a real child JVM,
 * captures the REAL `getChoices` ask Forge sends for the X announce, and
 * mounts THIS LANE'S OWN component (`mountPrompt`, the same helper every
 * other prompt test here uses) on it.
 *
 * **Measured here, and the reason this is a jar test and not only a fixture
 * one: `choose-x.state`'s own header claim — "five Mountains minus Fireball's
 * {R} leaves 4, so the slider's max is 4" — is FALSE against the real jar.**
 * `Cost.getMaxForNonManaX` (what `announceRequirements` caps `max` by) only
 * walks cost parts whose amount is the literal string `"X"` — the shape a
 * NON-mana X cost uses (`Sacrifice X creatures`); Fireball's `X` lives in the
 * MANA cost itself (`{X}{R}`), which that method never sees, so it returns
 * `null` and no cap applies at all. The real ask is Forge's plain, unconstrained
 * `getInteger` shape: `0..9` plus `"Other…"` — not `0..4`. See
 * `docs/planning/wave34-evidence/g1-choose-x-slider.md` for the full finding;
 * this test asserts the shape Forge actually sends, not the scenario header's
 * arithmetic (which is wrong about Forge, not about the mana on the board).
 *
 * Clicking the Fireball card does not go straight to the X announce: Forge
 * first asks `getAbilityToPlay` (the card's one spell ability). `getChoices`'
 * own keys are never the integers either — `PlayBridge.choices()` keys every
 * entry positionally, `"c" + index` — which is the OTHER real bug this item
 * found: `numericChoiceRange` used to require `key === label`, so it NEVER
 * matched a real ask and the slider never rendered at all against production
 * data (fixed in `rules.ts`, this lane).
 *
 * `Scenario.answerAsks()`'s own default for `getChoices` picks the first key
 * (X=0), which would make "OK enabled at every legal value" untestable
 * against the real wire — so this test's own `reply` hook intercepts ONLY the
 * numeric-range `getChoices` ask, mounts and asserts it the moment Forge sends
 * it, drives the slider through every legal value, and answers with whatever
 * the mounted component itself produced; every other ask (the ability choice)
 * keeps `answerAsks()`'s ordinary default.
 *
 * Skips visibly without CARDTABLE_FORGE_JAR / CARDTABLE_FORGE_RES.
 */

import type { ServerFrame } from '@hadoku/forge-wire';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil, type Scenario } from '../../../../server/src/play/scenario.ts';
import { numericChoiceRange } from './rules.ts';
import { mountPrompt } from './testing.ts';
import type { AskOf } from './types.ts';

const title = available.ok
  ? 'the Choose X slider, against a real Forge match'
  : `the Choose X slider, against a real Forge match — SKIPPED: ${available.reason}`;

const XCARD = 'Fireball';
// The scenario scripts the whole hand/battlefield itself; these decks only
// need to be legal and non-empty, the same shape every other scenario-driven
// jvm test here uses (`scenario-priority.jvm.test.ts`'s `DECKS`).
const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

interface Seen {
  range: { min: number; max: number };
  slider: { min: string; max: string; value: string };
  everyValueEnabled: boolean;
  reply: readonly string[];
}

describe.skipIf(!available.ok)(title, () => {
  let s: Scenario | undefined;

  afterAll(async () => {
    cleanup();
    if (s !== undefined) await s.stop();
  }, 60_000);

  it(
    'renders the real ask as a slider (not the checkbox fallback), defaults to the minimum, reads enabled at every legal value, and answers Forge’s own key',
    async () => {
      if (!available.ok) return;
      let seen: Seen | null = null;

      s = await startScenario(available.config, {
        seed: 1,
        decks: DECKS,
        scenario: scenarioText('choose-x'),
        reply: (f: ServerFrame & Record<string, unknown>) => {
          if (f.method !== 'getChoices' || seen !== null) return undefined;
          const ask = f as unknown as AskOf<'getChoices'>;
          const range = numericChoiceRange(ask);
          if (range === null) return undefined; // not the X slider shape — fall through to the default

          const { getByTestId, submit, answers } = mountPrompt('getChoices', ask);
          const slider = getByTestId('prompt-slider') as HTMLInputElement;
          const initial = { min: slider.min, max: slider.max, value: slider.value };
          let everyValueEnabled = true;
          for (let n = range.min; n <= range.max; n++) {
            fireEvent.change(slider, { target: { value: String(n) } });
            if (submit().disabled) everyValueEnabled = false;
          }
          // Leave it at the max, then answer through the component itself —
          // the real reply this ask gets is whatever the mounted slider sends,
          // never a value this test fabricates.
          fireEvent.click(submit());
          seen = { range, slider: initial, everyValueEnabled, reply: answers[0] ?? [] };
          return answers[0];
        },
      });
      await finishMulligan(s);

      await waitUntil(
        () => {
          s!.answerAsks();
          return s!.zone(0, 'Hand').some((c) => c.name === XCARD);
        },
        `seat 0 to hold ${XCARD}`,
        20_000,
      );
      const card = s.zone(0, 'Hand').find((c) => c.name === XCARD);
      if (card === undefined) throw new Error(`no ${XCARD} in hand`);
      s.select(0, card.id);

      await waitUntil(
        () => {
          s!.answerAsks();
          return seen !== null;
        },
        'the X announce to reach seat 0 as getChoices, and be answered through the mounted component',
        20_000,
      );

      // Forge's real, unconstrained shape — see the file header. Both min and
      // max as the ACTUAL ask's own `choices` length: min=0 and the
      // ten-wide-plus-Other cutoff puts max at 9, with an Other… entry (c10)
      // beyond it — not capped to the board's 4 available mana at all.
      expect(seen!.range).toEqual({
        min: 0,
        max: 9,
        keys: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'],
        otherKey: 'c10',
      });
      expect(seen!.slider).toEqual({ min: '0', max: '9', value: '0' });
      expect(seen!.everyValueEnabled, 'OK was never disabled, X=0 through X=9').toBe(true);
      // The reply round-tripped through match.fromClient without being refused
      // (answerAsks() would have thrown via s.select/the harness otherwise —
      // asserted structurally here: it is Forge's own key for X=9, never "9").
      expect(seen!.reply).toEqual(['c9']);
    },
    60_000,
  );
});
