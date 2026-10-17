/**
 * The operator, 2026-10-11: *"tarmogoyf is a 4/5 and it was dealt 3 damage.
 * now the chip is showing: 2(red) 4/(down arrow red 3). i think it would be
 * simpler to just show 4/2(red)"*.
 *
 * A damaged creature's badge is the ONE place its damage is drawn: power over
 * what is left of its toughness, that number in the danger ink, no marker and
 * no separate damage pill beside it. Proven from a real match on both screens:
 * Tarmogoyf (printed `*` / `1+*`, a 4/5 here) and Griselbrand (printed 7/7,
 * which our card data knows) are each bolted, then the turn's cleanup wipes the
 * damage and both badges read plain again.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one each test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, grindPriority, makeTitled, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Badge {
  text: string;
  label: string | null;
  toughnessState: string | null;
  damage: string | null;
  toughnessInkIsDanger: boolean;
  pills: number;
}

/** One creature's P/T badge as this screen draws it, plus whether ANY damage pill is drawn anywhere on the board. */
async function badgeOf(page: Page, cardId: number): Promise<Badge | null> {
  return page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`[data-card-id="${id}"] > .board-card__pt`);
    if (el === null) return null;
    const toughness = el.querySelector<HTMLElement>('[data-pt-of="toughness"]');
    // The theme's own danger ink, resolved the same way the badge's own rule resolves it.
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger-ink)';
    el.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    return {
      text: el.textContent ?? '',
      label: el.getAttribute('aria-label'),
      toughnessState: toughness?.getAttribute('data-pt-state') ?? null,
      damage: el.getAttribute('data-damage'),
      toughnessInkIsDanger: toughness !== null && getComputedStyle(toughness).color === danger,
      pills: document.querySelectorAll('.board-number__pill').length,
    };
  }, cardId);
}

/** The battlefield card of this name on this screen, by id. */
async function battlefieldNamed(page: Page, owner: 'you' | 'them', name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card]`)
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is on ${owner === 'you' ? 'the viewer’s' : 'the opponent’s'} battlefield` },
    )
    .not.toBeUndefined();
  return id!;
}

/** The hand card of this name that Forge offers, by id. */
async function offeredNamed(page: Page, name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]')
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is offered` },
    )
    .not.toBeUndefined();
  return id!;
}

test(titled('a damaged creature reads power / toughness-left in the danger ink, with no pill, on both screens; cleanup restores it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'w70-damage-pt');
    const { alice, bob } = seated;
    const goyf = await battlefieldNamed(alice.page, 'you', 'Tarmogoyf');
    const gris = await battlefieldNamed(alice.page, 'them', 'Griselbrand');
    const screens = [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const;

    const plain = (text: string, label: string): Badge => ({
      text,
      label,
      toughnessState: null,
      damage: null,
      toughnessInkIsDanger: false,
      pills: 0,
    });
    const damaged = (text: string, label: string): Badge => ({
      text,
      label,
      toughnessState: 'damaged',
      damage: '3',
      toughnessInkIsDanger: true,
      pills: 0,
    });

    /** Both screens draw this badge for this card — polled, and what each screen last drew is logged either way. */
    const bothScreens = async (step: string, cardId: number, want: Badge): Promise<void> => {
      const seen: Record<string, Badge | null> = {};
      try {
        for (const [who, page] of screens) {
          await expect
            .poll(async () => (seen[who] = await badgeOf(page, cardId)), { timeout: 15_000, message: `${who}: ${step}` })
            .toEqual(want);
        }
      } finally {
        console.log(`[w70-damage-pt] ${JSON.stringify({ step, cardId, ...seen })}`);
      }
    };

    await bothScreens('before: Tarmogoyf is a plain 4/5 — its printed */1+* is no baseline', goyf, plain('4/5', 'power 4, toughness 5'));
    await bothScreens('before: Griselbrand is a plain 7/7', gris, plain('7/7', 'power 7, toughness 7'));

    // Full control holds alice's priority so every step is driven from here, never by the
    // auto-pass policy (the route `w56-numbers` proved for a Bolt).
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    const boltAt = async (target: number): Promise<void> => {
      const bolt = await offeredNamed(alice.page, 'Lightning Bolt');
      const card = alice.page.locator(`[data-board-card="${target}"]`);
      await castUntilOnStack(alice.page, stack, bolt, async () => {
        if ((await card.getAttribute('data-selectable')) === null) return false;
        const box = await card.boundingBox();
        if (box === null) return false;
        await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      });
      expect(await stackCount(alice.page), 'the Bolt is on the stack').toBe(1);
      const resolvedBy = Date.now() + 20_000;
      while ((await stackCount(alice.page)) > 0 && Date.now() < resolvedBy) {
        for (const page of [alice.page, bob.page]) {
          const ok = page.getByTestId('live-decision-ok');
          if ((await ok.count()) > 0) await ok.click().catch(() => undefined);
        }
        await alice.page.waitForTimeout(40);
      }
      expect(await stackCount(alice.page), 'the Bolt resolved').toBe(0);
    };

    await boltAt(goyf);
    await bothScreens('Tarmogoyf took 3: 4/2, the 2 in the danger ink, no marker and no damage pill', goyf, damaged('4/2', 'power 4, toughness 5, 3 damage marked'));

    await boltAt(gris);
    await bothScreens(
      'Griselbrand took 3: 7/4, the 4 in the danger ink — damage, not a second mark against its printed 7',
      gris,
      damaged('7/4', 'power 7, toughness 7, 3 damage marked'),
    );

    // Pass alice's held priority forward until the turn's cleanup wipes the damage.
    await grindPriority([alice.page, bob.page], async () => (await badgeOf(alice.page, goyf))?.damage === null, { intervalMs: 60, timeoutMs: 60_000 });
    await bothScreens('after cleanup: Tarmogoyf is a plain 4/5 again', goyf, plain('4/5', 'power 4, toughness 5'));
    await bothScreens('after cleanup: Griselbrand is a plain 7/7 again', gris, plain('7/7', 'power 7, toughness 7'));
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
