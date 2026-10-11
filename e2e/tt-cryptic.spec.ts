/**
 * Against real Forge. The operator, 2026-10-11, on Cryptic Command: *"it has
 * two steps, first pick one then pick another. ideally this is just a single
 * step where you pick two. … it seems to go back to hand after doing the first
 * selection … then the second click needs to happen and the target arrow is
 * first from hand, and then broken when the cryptic command is back in view."*
 *
 * `tt-cryptic.state`: bob casts Memnite; alice holds Cryptic Command and four
 * Islands. She drags Cryptic Command off her hand, takes a person's time over
 * the modes (the operator's two answers took 2.0 s and 2.7 s), picks "Counter
 * target spell" and "Draw a card", aims at Memnite and pays. Full control is on
 * for her so Forge's one-legal-target shortcut leaves the target question to
 * her, as it was in the reported game (two spells on the stack there).
 *
 * Three things are measured, every animation frame from the release until
 * Cryptic Command is on the stack:
 *  - one mode prompt picks both modes, and no second one opens;
 *  - the card is never drawn back in the hand;
 *  - the targeting arrow leaves from the card being cast.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, clickOnce, dragHandCard, handCardNamed, makeTitled, offered, says, serverLog, stackCount } from './play/board.ts';
import { answerLoneAbility } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const WANTED = ['Counter target spell', 'Draw a card'];
/** How long a person reads four modes before picking: longer than either of the operator's two answers. */
const READING_MS = 5_000;

type Frame = { at: number; hand: string | null; ghost: boolean; back: boolean };

/** Every animation frame until `__ttStop()`: how the page draws card `id` (its hand element's lift state, a stand-in), and bob's back of it. */
async function sample(page: Page, id: number): Promise<void> {
  await page.evaluate((cardId) => {
    const w = window as unknown as { __tt: Frame[]; __ttStop: () => void };
    type Frame = { at: number; hand: string | null; ghost: boolean; back: boolean };
    w.__tt = [];
    let live = true;
    w.__ttStop = () => {
      live = false;
    };
    const t0 = performance.now();
    const tick = () => {
      if (!live) return;
      const el = document.querySelector(`[data-zone="hand"][data-owner="you"] [data-board-card="${cardId}"]`);
      w.__tt.push({
        at: Math.round(performance.now() - t0),
        hand: el === null ? null : (el.getAttribute('data-cast-lift') ?? 'in-row'),
        ghost: document.querySelector(`[data-cast-ghost="${cardId}"]`) !== null,
        back: document.querySelector('[data-board-overlay] .presence__back') !== null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
}

async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __tt: Frame[]; __ttStop: () => void };
    w.__ttStop();
    return w.__tt;
  });
}

/** Runs of consecutive frames with the same reading, for a short evidence line. */
function runs(list: Frame[], read: (f: Frame) => string): string {
  const out: string[] = [];
  let last: string | null = null;
  for (const f of list) {
    const r = read(f);
    if (r === last) continue;
    last = r;
    out.push(`${f.at}ms:${r}`);
  }
  return out.join(' ');
}

const modePrompt = (page: Page): Locator =>
  page.locator('section[data-prompt="getChoices"]').filter({ has: page.locator('li', { hasText: /Counter target spell|Draw a card/ }) });

/** Tick every wanted mode this prompt still offers, then submit. Returns the modes ticked. */
async function pickModes(page: Page): Promise<string[]> {
  const prompt = modePrompt(page);
  const ticked: string[] = [];
  for (const mode of WANTED) {
    const row = prompt.locator('li', { hasText: mode }).first();
    if ((await row.count()) === 0) continue;
    await row.locator('label').click();
    ticked.push(mode);
  }
  const checked = await prompt.locator('input[type="checkbox"]:checked').count();
  console.log(`[tt] mode prompt: ticked ${JSON.stringify(ticked)}, ${checked} checked; hint "${(await prompt.locator('.prompt__hint').textContent()) ?? ''}"`);
  await prompt.locator('[data-testid="prompt-submit"]').click();
  return ticked;
}

/** The targeting arrow's tail and source, and the box the cast card is drawn in (its lifted element or its stand-in), in one layout pass. */
function shootArrow(cardId: number): {
  source: string | null;
  tail: { x: number; y: number } | null;
  card: { left: number; top: number; right: number; bottom: number } | null;
} {
  const arrow = document.querySelector('[data-testid="targeter"]');
  const d = arrow?.querySelector('path')?.getAttribute('d') ?? '';
  const nums = d.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  const box = arrow?.getBoundingClientRect();
  const tail = box !== undefined && nums.length >= 6 ? { x: nums[0]! + box.left, y: nums[1]! + box.top } : null;
  const drawn = document.querySelector(`[data-cast-ghost="${cardId}"]`) ?? document.querySelector(`[data-board-card="${cardId}"][data-cast-lift]`);
  const r = drawn?.getBoundingClientRect();
  return {
    source: arrow?.getAttribute('data-source') ?? null,
    tail,
    card: r === undefined || r.width === 0 ? null : { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
  };
}

test(
  titled('Cryptic Command: one prompt picks both modes, the card is never back in the hand while it is cast, and the target arrow leaves from it'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'tt-cryptic');
      const { alice, bob } = seated;
      const page = alice.page;
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.getByTestId('live-full-control').click();
      await expect(page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

      const memnite = await handCardNamed(bob.page, 'Memnite');
      expect(memnite, 'Memnite is in bob’s hand').not.toBeUndefined();
      await castCard(bob.page, memnite!);
      await expect.poll(() => stackCount(page), { timeout: 15_000, message: 'bob’s Memnite reached the stack' }).toBe(1);

      const cryptic = await handCardNamed(page, 'Cryptic Command');
      expect(cryptic, 'Cryptic Command is in alice’s hand').not.toBeUndefined();
      const id = cryptic!;
      await expect.poll(() => offered(page), { timeout: 15_000, message: 'alice is offered Cryptic Command' }).toContain(id);
      const handBefore = await page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').count();

      const bf = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
      expect(bf, 'alice’s battlefield has a box').not.toBeNull();
      const releaseAt = { x: bf!.x + bf!.width / 2, y: bf!.y + bf!.height / 2 };
      const fromCast = serverLog(stack).length;
      await sample(page, id);
      await sample(bob.page, id);
      const lift = () => page.locator(`[data-board-card="${id}"]`).getAttribute('data-cast-lift').catch(() => null);
      for (let i = 0; i < 4 && (await lift()) !== 'parked'; i++) {
        if (i > 0) await page.waitForTimeout(250);
        await dragHandCard(page, id, releaseAt);
      }
      expect(await lift(), 'Cryptic Command is parked where it was let go — the cast went out').toBe('parked');

      // Forge's own questions, in whatever order it asks them, until Cryptic Command is on the stack.
      const modeCalls = new Set<string>();
      const aimed: { arrow: ReturnType<typeof shootArrow> | null } = { arrow: null };
      await expect
        .poll(
          async () => {
            if (await answerLoneAbility(page)) return stackCount(page);
            const mode = modePrompt(page);
            if ((await mode.count()) > 0) {
              const call = (await page.getByTestId('live-prompt').first().getAttribute('data-call-id')) ?? '?';
              if (!modeCalls.has(call)) {
                modeCalls.add(call);
                await page.waitForTimeout(READING_MS);
                await pickModes(page);
              }
              return stackCount(page);
            }
            const target = page.locator('section[data-prompt="getChoices"]').filter({ has: page.locator('li', { hasText: 'Memnite' }) });
            if ((await target.count()) > 0) {
              if (aimed.arrow === null) {
                // Aim the way a person does: the pointer travels to Memnite on the stack.
                const memniteItem = page.locator('[data-stack-id][aria-label*="Memnite"]').first();
                const box = await memniteItem.boundingBox();
                const to = box === null ? { x: releaseAt.x + 200, y: releaseAt.y - 200 } : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                await page.mouse.move(to.x, to.y, { steps: 6 });
                aimed.arrow = await page.evaluate(shootArrow, id);
                console.log(`[tt] target ask: arrow ${JSON.stringify(aimed.arrow)}`);
              }
              const row = target.locator('li', { hasText: 'Memnite' }).first();
              if (!(await row.locator('input[type="checkbox"]').isChecked().catch(() => true))) await row.locator('label').click().catch(() => undefined);
              await target.locator('[data-testid="prompt-submit"]').click().catch(() => undefined);
              return stackCount(page);
            }
            const text = await says(page);
            if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
            return stackCount(page);
          },
          { timeout: 60_000, message: 'Cryptic Command reached the stack' },
        )
        .toBe(2);
      await expect(page.locator('[data-stack-id][aria-label*="Cryptic Command"]'), 'Cryptic Command is its own stack item').toHaveCount(1, { timeout: 10_000 });

      const mine = await frames(page);
      const his = await frames(bob.page);
      const parkedAt = mine.findIndex((f) => f.hand === 'parked');
      const drawnInHand = mine.slice(Math.max(0, parkedAt)).filter((f) => f.hand === 'in-row' || f.hand === 'returning');
      console.log(`[tt] alice frames ${mine.length}: hand ${runs(mine, (f) => f.hand ?? 'none')} | ghost ${runs(mine, (f) => String(f.ghost))}`);
      console.log(`[tt] bob frames ${his.length}: back ${runs(his, (f) => String(f.back))}`);
      const after = serverLog(stack).slice(fromCast);
      const wiredModes = after.filter((r) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'getChoices' && /Choose a mode/.test(String(r.message ?? '')));
      const folded = after.filter((r) => r.evt === 'ask-auto-answered' && r.seat === 0 && r.method === 'getChoices');
      console.log(`[tt] mode prompts shown ${modeCalls.size}; mode asks on alice's wire ${wiredModes.length}; answered by the server ${folded.length} ${folded.map((r) => String(r.why)).join(' | ')}`);

      expect.soft(modeCalls.size, 'Cryptic Command is one step: one mode prompt picks two').toBe(1);
      expect.soft(drawnInHand.length, `Cryptic Command was drawn back in the hand for ${drawnInHand.length} frames while it was being cast (first at ${drawnInHand[0]?.at ?? '-'} ms)`).toBe(0);
      const arrow = aimed.arrow;
      expect.soft(arrow, 'the target question drew an arrow').not.toBeNull();
      expect.soft(arrow?.source, 'the target arrow leaves from Cryptic Command').toBe(String(id));
      const inside =
        arrow?.tail != null && arrow.card !== null && arrow.tail.x >= arrow.card.left - 1 && arrow.tail.x <= arrow.card.right + 1 && arrow.tail.y >= arrow.card.top - 1 && arrow.tail.y <= arrow.card.bottom + 1;
      expect.soft(inside, 'the target arrow’s tail sits on the drawn Cryptic Command').toBe(true);

      // It resolves as chosen: Memnite is countered and alice draws a card.
      await expect
        .poll(
          async () => {
            const text = await says(page);
            if (/^Priority:/.test(text)) await clickOnce(page, text, 'ok');
            return stackCount(page);
          },
          { timeout: 20_000, message: 'the stack resolved' },
        )
        .toBe(0);
      const handAfter = await page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').count();
      console.log(`[tt] alice's hand ${handBefore} before the cast, ${handAfter} after it resolved`);
      expect(handAfter, 'Cryptic Command left the hand and its draw added one').toBe(handBefore);
      await expect(bob.page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]'), 'Memnite was countered').toHaveCount(0);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);
