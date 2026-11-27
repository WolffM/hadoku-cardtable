// @vitest-environment jsdom
/*
 * Two reports from CoffeeTraveler, 2026-11-27, against a REAL Forge match with this
 * client's own `LiveBoard` mounted for seat 0.
 *
 * - "Portal to Phyrexia may soft lock when targeting opponents true-name nemesis"
 *   (m-cb6c12da244a). Portal's upkeep trigger returns True-Name Nemesis under the
 *   seat's control, and TNN's "as it enters, choose a player" reaches the wire as a
 *   selection that names no card and offers both players, with both of Forge's
 *   buttons off. The board drew no question for it (`classifySelection` said
 *   `'none'`), so the seat clicked cards for a minute and the game sat on the choice.
 *   Now the selection's sheet asks it, Forge's own line as its title, with the
 *   players to pick from.
 * - "Baleful Mastery doesn't allow you to cast it for 4" (m-85d9166e1c59). Forge
 *   offers its two casts through `getAbilityToPlay`, and a spell's label is its
 *   description alone: both read "If the {1}{B} cost was paid, an opponent draws a
 *   card. Exile target creature or planeswalker.", the {3}{B} cast said its cost
 *   nowhere. Now each says what it costs (`OfferedAbility.cost`), and each pays it.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run games/magic/ui/src/play/prompts/choose-player-and-cast-cost.jvm.test.ts --fileParallelism=false
 */

import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { viewerOf } from '../adapter.ts';
import { forgeAvailability, startLiveScenario, waitUntil, type LiveHarness } from '../live/jvm-harness.ts';
import { LiveBoard } from '../live/LiveBoard.tsx';
import { boardInteraction, currentAsk, pressButton, selectCard } from '../live/match.ts';

const available = forgeAvailability();
const title = available.ok
  ? 'a players-only selection is asked, and a spell’s casts say their costs, against a real Forge match'
  : `a players-only selection is asked, and a spell’s casts say their costs, against a real Forge match — SKIPPED: ${available.reason}`;

afterEach(cleanup);

const message = (h: LiveHarness, seat: number): string => h.seats[seat]!.notes.prompt?.message ?? '';

/** Press each seat's live OK once per thing Forge says — the coin toss, the keep, a pass — never on a question. */
function passBoth(h: LiveHarness, pressed: Map<number, number>, skip: (seat: number) => boolean): void {
  for (const s of h.seats) {
    if (skip(s.seat) || currentAsk(s.live) !== null || pressed.get(s.seat) === s.notes.version) continue;
    if (/target|[Cc]hoose/.test(message(h, s.seat))) continue;
    if (pressButton(s.live, 'ok')) pressed.set(s.seat, s.notes.version);
  }
}

function mount(h: LiveHarness): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(createElement(LiveBoard, { match: h.seats[0]!.live }), { container: root });
  return root;
}

describe.skipIf(!available.ok)(title, () => {
  it(
    'True-Name Nemesis returned by Portal to Phyrexia asks its player choice in the selection sheet, and picking the opponent from it resolves the choice',
    async () => {
      const h = await startLiveScenario('tnn-portal', ['40 Island', '40 Island']);
      try {
        const root = mount(h);
        const pressed = new Map<number, number>();
        await waitUntil(
          () => {
            passBoth(h, pressed, () => false);
            return /Choose a player/.test(message(h, 0)) && h.seats[0]!.notes.selectables !== null;
          },
          "True-Name Nemesis's player choice",
          120_000,
          h,
        );
        const selection = h.seats[0]!.notes.selectables!;
        expect(selection.cards).toEqual([]);
        expect(selection.players?.map((p) => p.id).sort()).toEqual([0, 1]);

        let sheet: HTMLElement | null = null;
        await waitUntil(() => (sheet = root.querySelector<HTMLElement>('[data-testid="live-selection-host"]')) !== null, 'the selection sheet', 10_000, h);
        expect(sheet!.querySelector('.prompt__title')?.textContent).toBe('Choose a player');
        const rows = [...sheet!.querySelectorAll<HTMLInputElement>('input[data-testid="prompt-choice"]')];
        expect(rows.map((r) => r.closest('label')?.textContent)).toEqual(['Aplayer', 'Bplayer']);

        fireEvent.click(rows[1]!);
        const tnnMine = () => viewerOf(h.seats[0]!.live.view!)?.battlefield.some((c) => c.card.name === 'True-Name Nemesis') === true;
        await waitUntil(() => tnnMine() && !/Choose a player/.test(message(h, 0)), 'True-Name Nemesis on seat 0’s battlefield, the choice answered', 30_000, h);
        expect(root.querySelector('[data-testid="live-selection-host"]')).toBeNull();
        expect(h.refused).toEqual([]);
      } finally {
        h.stop();
      }
    },
    180_000,
  );

  for (const [cost, lands] of [['{3}{B}', 4], ['{1}{B}', 2]] as const) {
    it(
      `Baleful Mastery's two casts each say their cost, and the ${cost} one pays ${lands} Swamps`,
      async () => {
        const h = await startLiveScenario('baleful-mastery', ['40 Swamp', '40 Forest']);
        try {
          const root = mount(h);
          const pressed = new Map<number, number>();
          const hand = () => viewerOf(h.seats[0]!.live.view!)?.hand ?? [];
          await waitUntil(
            () => {
              const ready =
                /^Priority: A/.test(message(h, 0)) &&
                h.seats[0]!.notes.buttons?.enable1 === true &&
                h.seats[0]!.live.view?.phase === 'MAIN1' &&
                hand().some((c) => c.card.name === 'Baleful Mastery');
              passBoth(h, pressed, (seat) => seat === 0 && ready);
              return ready;
            },
            "seat 0's main phase with Baleful Mastery in hand",
            120_000,
            h,
          );
          const baleful = hand().find((c) => c.card.name === 'Baleful Mastery')!;
          // The bar goes live a frame before the window's offer names the card.
          await waitUntil(() => boardInteraction(h.seats[0]!.live).selectable.has(baleful.id), 'Baleful Mastery offered', 10_000, h);
          expect(selectCard(h.seats[0]!.live, baleful.id)).toBe(true);
          let choices: HTMLElement[] = [];
          await waitUntil(
            () => (choices = [...root.querySelectorAll<HTMLElement>('[data-testid="live-prompt"][data-method="getAbilityToPlay"] [data-testid="prompt-choice"]')]).length === 2,
            "Baleful Mastery's two casts",
            30_000,
            h,
          );
          const labels = choices.map((c) => c.getAttribute('aria-label') ?? '');
          expect(labels[0]).toMatch(/^3B: If the 1B cost was paid/);
          expect(labels[1]).toMatch(/^1B: If the 1B cost was paid/);

          choices[cost === '{3}{B}' ? 0 : 1]!.click();
          await waitUntil(() => /Select target creature or planeswalker/.test(message(h, 0)) && h.seats[0]!.notes.selectables !== null, 'the target', 30_000, h);
          const target = h.seats[0]!.notes.selectables!.cards[0]!;
          await waitUntil(() => boardInteraction(h.seats[0]!.live).selectable.has(target.id), 'the target offered', 10_000, h);
          expect(selectCard(h.seats[0]!.live, target.id)).toBe(true);
          const tapped = () => viewerOf(h.seats[0]!.live.view!)!.battlefield.filter((c) => c.card.name === 'Swamp' && c.tapped).length;
          await waitUntil(
            () => {
              passBoth(h, pressed, () => false);
              return hand().every((c) => c.card.name !== 'Baleful Mastery') && tapped() > 0;
            },
            'Baleful Mastery cast and paid',
            30_000,
            h,
          );
          expect(tapped()).toBe(lands);
          expect(h.refused).toEqual([]);
        } finally {
          h.stop();
        }
      },
      180_000,
    );
  }
});
