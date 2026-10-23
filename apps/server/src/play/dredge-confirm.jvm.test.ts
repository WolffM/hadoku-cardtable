/**
 * An optional replacement's yes/no, against a real Forge jar: Stinkweed Imp's dredge at its owner's
 * draw. The operator, 2026-10-23, on a Yes/No whose only words were the turn's status lines ("Priority:
 * Hadoku / Turn: 15 (Sage) / Phase: End step / Stack: Empty"): *"is this a dredge trigger? that looks
 * like a bug"*, *"why isn't it showing the dredge card and telling me the effect?"*.
 *
 * Forge asks it through `ReplacementHandler`'s Optional branch → `confirmReplacementEffect` →
 * `InputConfirm.confirm(controller, effectSA, question)`: a confirm with no card of its own, whose
 * question names the card and its dredge. The seat must be sent that question with its Yes/No, and
 * the card it is about.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/dredge-confirm.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_STOP_POLICY } from './auto.js';
import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok ? 'an optional replacement’s yes/no names its card and its effect, against real Forge' : `dredge confirm, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Swamp']), deck('Any B', ['40 Island'])];

/** The seat-0 frames from `from` on, as the browser was sent them. */
const sentFrom = (s: Scenario, from: number) =>
  s.sent
    .slice(from)
    .filter((x) => x.seat === 0)
    .map((x) => x.envelope as unknown as { frame?: { method?: string; message?: string; label1?: string; label2?: string; card?: unknown; confirmAbility?: unknown } })
    .map((e) => e.frame)
    .filter((f) => f?.method === 'showPromptMessage' || f?.method === 'updateButtons');

describe.skipIf(!available.ok)(title, () => {
  it(
    'Stinkweed Imp’s dredge asks with its own question and its card, never the turn’s status lines',
    async () => {
      if (!available.ok) return;
      const s: Scenario = await startScenario(available.config, { seed: 2311, decks: DECKS, scenario: scenarioText('dredge-confirm'), policy: DEFAULT_STOP_POLICY });
      try {
        await finishMulligan(s);
        let mark = 0;
        await waitUntil(
          () => {
            s.answerAsks();
            const bar = s.buttons(0);
            if (bar?.label1 === 'Yes' && bar.label2 === 'No') return true;
            if (s.prompt(0).startsWith('Priority:') && bar?.enable1 === true) {
              mark = s.sent.length;
              s.ok(0);
            }
            return false;
          },
          'the dredge is asked',
          90_000,
          s,
        );
        // The window's halves have had their moment to pair.
        await new Promise((r) => setTimeout(r, 1_500));
        const frames = sentFrom(s, mark);
        console.log(`[dredge] frames since the last pass: ${JSON.stringify(frames)}`);
        console.log(`[dredge] prompt now: ${JSON.stringify(s.prompt(0))}`);
        const raw = s.lines
          .filter((l) => l.t === 'frame' && l.seat === 0)
          .map((l) => (l as { frame: { method?: string; message?: string; label1?: string } }).frame)
          .filter((f) => f.method === 'showPromptMessage' || f.method === 'updateButtons')
          .slice(-6);
        console.log(`[dredge] bridge's own last window frames: ${JSON.stringify(raw)}`);
        console.log(`[dredge] server log tail: ${JSON.stringify(s.logs.slice(-12))}`);
        const stderr = (() => {
          try {
            return readFileSync(join(s.workDir, s.match.id, 'bridge.stderr.txt'), 'utf8');
          } catch (err) {
            return `unreadable: ${String(err)}`;
          }
        })();
        console.log(`[dredge] bridge stderr tail:\n${stderr.split('\n').slice(-40).join('\n')}`);
        const imp = s.zone(0, 'Graveyard').find((c) => c.name === 'Stinkweed Imp');
        expect(imp, 'the Imp is in her graveyard').toBeDefined();
        expect(s.prompt(0), 'the question is the dredge’s own').toMatch(/Stinkweed Imp/);
        expect(s.prompt(0), 'the question names the effect').toMatch(/Dredge 5/);
        expect(s.prompt(0), 'never the turn’s status lines').not.toMatch(/^Priority:/);
        const asked = frames.filter((f) => f?.method === 'showPromptMessage').at(-1);
        expect(asked?.card, 'the question carries the card it is about').toEqual({ kind: 'card', id: imp!.id });
      } finally {
        await s.stop();
      }
    },
    240_000,
  );
});
