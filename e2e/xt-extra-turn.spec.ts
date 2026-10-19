/**
 * The operator, 2026-10-19: *"when a player has extra turns, this kind of thing should be visible
 * somewhere around their portrait. let's make a special zone between their name and the deck symbol
 * for this type of information."*
 *
 * Against real Forge: `xt-extra-turn.state` is alice's own turn-1 main phase with Time Walk and two
 * Islands. She casts it: her seat's status zone shows one extra turn to come on BOTH screens
 * (`PlayerView.ExtraTurnCount`, public), and the chip arriving moves neither her face nor her library
 * mark. During turn 2 — her extra turn — the count is gone and her seat wears the extra-turn mark on
 * both screens (`PlayerView.IsExtraTurn`); once bob's turn 3 begins, neither is drawn anywhere,
 * though Forge leaves alice's flag up (`extra-turn.jvm.test.ts`).
 *
 * Every step prints one `[xt]` line (claws keep artifacts only on red).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist`.
 */
import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, grindPriority, handCardNamed, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[xt] ${JSON.stringify({ step, data })}`);

type Owner = 'you' | 'them';

/** One seat's status zone as one screen draws it, with the face and library mark it must not move. */
function statusOf(page: Page, owner: Owner) {
  return page.evaluate((owner) => {
    const seat = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="player"]')).find((s) => s.hasAttribute('data-viewer') === (owner === 'you'))!;
    const zone = seat.querySelector<HTMLElement>('[data-player-bar] > [data-seat-status]');
    const box = (el: Element | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    };
    const coming = zone?.querySelector<HTMLElement>('[data-testid="extra-turns"]') ?? null;
    return {
      zone: zone !== null,
      active: seat.hasAttribute('data-active'),
      extraTurns: coming === null ? null : Number(coming.dataset.extraTurns),
      tip: coming?.dataset.tip ?? null,
      now: (zone?.querySelector('[data-testid="extra-turn-now"]') ?? null) !== null,
      anywhere: seat.querySelectorAll('[data-testid="extra-turns"], [data-testid="extra-turn-now"]').length,
      face: box(seat.querySelector('[data-player-face]')),
      library: box(seat.querySelector('[data-testid="library-count"]')),
    };
  }, owner);
}

test(titled('Time Walk: the caster’s status zone shows the extra turn to come on both screens, then the extra-turn mark during it, and nothing after'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'xt-extra-turn');
    const a = alice.page;
    const b = bob.page;
    // Alice's seat is the viewer's on her screen and the opponent's on bob's.
    const hers = () => Promise.all([statusOf(a, 'you'), statusOf(b, 'them')]);
    const his = () => Promise.all([statusOf(a, 'them'), statusOf(b, 'you')]);

    await expect.poll(() => handCardNamed(a, 'Time Walk'), { timeout: 45_000, message: 'alice holds Time Walk' }).not.toBeUndefined();
    const before = await hers();
    log('before', before);
    for (const s of [...before, ...(await his())]) {
      expect(s.zone, 'every seat has a status zone').toBe(true);
      expect(s.anywhere, 'and nothing in it').toBe(0);
    }

    const walk = (await handCardNamed(a, 'Time Walk'))!;
    await castUntilOnStack(a, stack, walk, []);
    await grindPriority([a, b], async () => (await hers()).every((s) => s.extraTurns === 1), { timeoutMs: 45_000 });
    const resolved = await hers();
    log('resolved', { hers: resolved, his: await his() });
    for (const [i, s] of resolved.entries()) {
      const screen = i === 0 ? 'alice' : 'bob';
      expect([s.extraTurns, s.tip, s.now], `${screen}'s screen: one extra turn to come on alice's seat`).toEqual([1, '1 extra turn', false]);
      expect(s.face, `${screen}'s screen: the chip moved no face`).toEqual(before[i]!.face);
      expect(s.library, `${screen}'s screen: nor the library mark`).toEqual(before[i]!.library);
    }
    for (const s of await his()) expect(s.anywhere, 'bob has none').toBe(0);

    await a.getByTestId('live-button-end-turn').click();
    await grindPriority([a, b], async () => (await hers()).every((s) => s.now && s.active), { timeoutMs: 60_000 });
    const during = await hers();
    log('extra turn', { hers: during, his: await his() });
    for (const s of during) {
      expect([s.now, s.extraTurns], 'alice’s extra turn: the mark, and no turn left to come').toEqual([true, null]);
      expect(s.face).toEqual(before[during.indexOf(s)]!.face);
    }
    for (const s of await his()) expect(s.anywhere, 'bob has neither').toBe(0);

    await a.getByTestId('live-button-end-turn').click();
    await grindPriority([a, b], async () => (await his()).every((s) => s.active), { timeoutMs: 60_000 });
    const after = await hers();
    log('next turn', { hers: after, his: await his() });
    for (const s of [...after, ...(await his())]) expect(s.anywhere, 'bob’s turn 3 is no extra turn, and alice has none to come').toBe(0);
  } finally {
    await stack.stop();
  }
});
