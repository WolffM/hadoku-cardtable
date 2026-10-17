/**
 * The operator, 2026-10-17:
 *
 *  - "creature gave +1/0 to enhance a creatures power, it should have shown the number in green if the
 *    stats have been changed";
 *  - "when enemy has circle make it color danger, same with the phase counter".
 *
 * Scenario `lb-anthem`: Alice's Glorious Anthem makes her Hill Giant (printed 3/3, a card in no table
 * the browser holds) a 4/4, and Bob's Grizzly Bears is untouched; Alice holds priority in her main.
 * What this pins, on BOTH screens: the Giant's power and toughness read buffed, in the theme's
 * success ink, from Forge's own printed base (the bridge's `printedPT`), and the Bears read plain.
 * On Bob's screen Alice — the other seat — holds priority, so her ring is in the theme's danger and
 * the phase rail's current step is too; on Alice's own they are the accent.
 *
 * Every step prints one `[lb-marks]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[lb-marks] ${JSON.stringify({ step, data })}`);

interface Marks {
  /** Each named battlefield creature's two numbers: state and drawn colour. */
  pt: Record<string, { power: string | null; toughness: string | null; powerColor: string; toughnessColor: string }>;
  /** The colour of the lit ring (its outer shadow) on each seat, `none` when unlit. */
  ring: { you: string; them: string };
  /** The current phase step's leading bar. */
  step: string;
  /** The theme's tokens, resolved on this page. */
  tokens: { success: string; accent: string; danger: string };
}

function marks(page: Page): Promise<Marks> {
  return page.evaluate(() => {
    const probe = (value: string): string => {
      const el = document.createElement('span');
      el.style.color = value;
      document.querySelector('.board')!.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    const pt: Marks['pt'] = {};
    for (const li of Array.from(document.querySelectorAll<HTMLElement>('[data-zone="battlefield"] li.board-card'))) {
      const name = li.querySelector(':scope > .board-card__face .card__name')?.textContent?.trim();
      const p = li.querySelector<HTMLElement>(':scope > .board-card__pt .board-card__pt-n[data-pt-of="power"]');
      const t = li.querySelector<HTMLElement>(':scope > .board-card__pt .board-card__pt-n[data-pt-of="toughness"]');
      if (name === undefined || p === null || t === null) continue;
      pt[name] = { power: p.dataset.ptState ?? null, toughness: t.dataset.ptState ?? null, powerColor: getComputedStyle(p).color, toughnessColor: getComputedStyle(t).color };
    }
    const ringOf = (sel: string): string => {
      const shadow = getComputedStyle(document.querySelector(`${sel} .seat__ring`)!).boxShadow;
      if (shadow === 'none') return 'none';
      const colours = shadow.match(/rgba?\([^)]*\)/g) ?? [];
      return colours.at(-1) ?? shadow;
    };
    const step = getComputedStyle(document.querySelector('.live__step[data-current]')!).boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? 'none';
    return {
      pt,
      ring: { you: ringOf('.seat[data-viewer]'), them: ringOf('.seat:not([data-viewer])') },
      step,
      tokens: { success: probe('var(--success-ink)'), accent: probe('var(--accent)'), danger: probe('var(--danger)') },
    };
  });
}

test(titled('a raised number is green from Forge’s own printed base, and the other seat’s priority ring and phase are danger — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'lb-anthem');
    for (const [who, page, holder] of [
      ['alice', alice.page, 'you'],
      ['bob', bob.page, 'them'],
    ] as const) {
      let m: Marks | null = null;
      try {
        await expect
          .poll(async () => {
            m = await marks(page);
            return m.pt['Hill Giant']?.power === 'buffed' && m.ring[holder] !== 'none';
          }, { timeout: 20_000, message: `${who}: the Giant reads buffed and Alice’s ring is lit` })
          .toBe(true);
      } finally {
        log(`marks (${who})`, m);
      }
      const got = m as unknown as Marks;
      const giant = got.pt['Hill Giant']!;
      expect([giant.power, giant.toughness], `${who}: the Giant, printed 3/3, is 4/4`).toEqual(['buffed', 'buffed']);
      expect([giant.powerColor, giant.toughnessColor], `${who}: both numbers in the success ink`).toEqual([got.tokens.success, got.tokens.success]);
      expect([got.pt['Grizzly Bears']?.power, got.pt['Grizzly Bears']?.toughness], `${who}: the Bears is untouched`).toEqual([null, null]);
      const want = holder === 'them' ? got.tokens.danger : got.tokens.accent;
      expect(got.ring[holder], `${who}: Alice’s ring`).toBe(want);
      expect(got.step, `${who}: the current step`).toBe(want);
    }
  } finally {
    await stack.stop();
  }
});
