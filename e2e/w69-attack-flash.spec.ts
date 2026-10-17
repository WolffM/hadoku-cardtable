/**
 * The operator, 2026-10-10: *"when in declare attackers phase and the 'select creatures to attack' popup
 * comes. after clicking 'Ok' i notice it disppears but then flashes on the screen once more before
 * disappearing again. please find out where that extra pop up is coming from"*.
 *
 * Alice declares Memnite and presses the pop-up's OK with a real mouse. From the press on, every
 * animation frame and every DOM mutation records whether the attack pop-up is drawn: once it is gone it
 * must never come back. The wire alice received after the press is printed beside it, so a red names
 * the frames that drew the pop-up again. Her game then goes on to a later window of her own, which
 * must still be drawn.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickOnce, enabledOk, makeTitled, pressOffered, says } from './play/board.ts';
import { messages } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ATTACK = /Select creatures to attack/i;

/** The decision pop-up's own sentence, or null when none is drawn. */
const decisionText = async (page: Page): Promise<string | null> => {
  const pop = page.getByTestId('live-decision');
  return (await pop.count()) === 0 ? null : ((await pop.first().textContent()) ?? '');
};

/** One look per animation frame and per mutation: is the attack pop-up drawn, and what does it say. */
function installRecorder(): void {
  const w = window as unknown as { __w69: { t: number; via: string; shown: boolean; text: string }[]; __w69Press: number | null };
  w.__w69 = [];
  w.__w69Press = null;
  const look = (via: string): void => {
    const pop = document.querySelector('[data-testid="live-decision"]');
    const text = pop?.textContent ?? '';
    w.__w69.push({ t: performance.now(), via, shown: pop !== null && /Select creatures to attack/i.test(text), text: text.slice(0, 90) });
  };
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target instanceof Element && e.target.closest('[data-testid="live-decision-ok"]') !== null) w.__w69Press = performance.now();
    },
    true,
  );
  new MutationObserver(() => look('mutation')).observe(document.body, { childList: true, subtree: true, characterData: true });
  const frame = (): void => {
    look('frame');
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

test(titled('the attack pop-up never comes back after its OK is pressed'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'attackers-declared');
    const memnite = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first();
    const memniteId = Number(await memnite.getAttribute('data-board-card'));

    // Main 1 → Declare Attackers: Next Phase once, then Forge's live InputAttack opens.
    const deadline = Date.now() + 30_000;
    let pressed = false;
    while (!ATTACK.test((await decisionText(alice.page)) ?? '') && Date.now() < deadline) {
      const line = await says(alice.page);
      if (!pressed && /^Priority:/.test(line) && /Main phase, precombat/i.test(line) && (await enabledOk(alice.page).count()) > 0) {
        pressed = true;
        await enabledOk(alice.page).first().click();
      }
      await alice.page.waitForTimeout(40);
    }
    await expect.poll(() => decisionText(alice.page), { timeout: 5_000, message: 'the attack pop-up opened' }).toMatch(ATTACK);
    console.log(`[w69-attack] the attack pop-up reads "${await decisionText(alice.page)}"`);

    // Memnite attacks: a real click on its face.
    await expect(memnite, 'Memnite is offered to attack').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    expect(await pressOffered(memnite), 'Memnite pressed').toBe(true);
    await expect(alice.page.locator(`[data-board-card="${memniteId}"]`), 'Forge declared Memnite attacking').toHaveAttribute('data-attacking', 'true', {
      timeout: 10_000,
    });
    await expect.poll(() => decisionText(alice.page), { timeout: 5_000 }).toMatch(ATTACK);

    // The OK, pressed with the mouse, everything recorded from just before it.
    await alice.page.evaluate(installRecorder);
    const ok = alice.page.locator('[data-testid="live-decision-ok"]:enabled');
    await expect(ok).toHaveCount(1);
    const box = (await ok.boundingBox())!;
    const wallPress = Date.now();
    await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await decisionText(alice.page)) ?? '', { timeout: 5_000, message: 'the pop-up goes away' }).not.toMatch(ATTACK);
    await alice.page.waitForTimeout(3_000);

    const rec = await alice.page.evaluate(() => {
      const w = window as unknown as { __w69: { t: number; via: string; shown: boolean; text: string }[]; __w69Press: number | null };
      return { samples: w.__w69, press: w.__w69Press };
    });
    expect(rec.press, 'the OK press was recorded').not.toBeNull();
    const after = rec.samples.filter((s) => s.t >= rec.press!);
    const gone = after.findIndex((s) => !s.shown);
    const back = gone < 0 ? [] : after.slice(gone).filter((s) => s.shown);
    const firstBack = back[0];
    console.log(
      `[w69-attack] after the press: ${after.length} looks; first without the pop-up at +${gone < 0 ? 'never' : Math.round(after[gone]!.t - rec.press!)}ms; ` +
        `drawn again in ${back.length} looks${firstBack === undefined ? '' : `, first at +${Math.round(firstBack.t - rec.press!)}ms (${firstBack.via}) reading "${firstBack.text}"`}` +
        `${back.length === 0 ? '' : `, last at +${Math.round(back[back.length - 1]!.t - rec.press!)}ms`}`,
    );

    // The wire alice received from the press on, one line per Forge frame.
    const frames = messages(alice).filter((x) => x.dir === 'in' && x.kind === 's2c' && x.t >= wallPress);
    for (const f of frames.slice(0, 40)) {
      const fr = (f.msg as { frame?: Record<string, unknown> }).frame ?? {};
      const gist =
        fr.method === 'showPromptMessage'
          ? `"${String(fr.message).slice(0, 90)}"`
          : fr.method === 'updateButtons'
            ? `[${String(fr.label1)} ${String(fr.enable1)} | ${String(fr.label2)} ${String(fr.enable2)}]`
            : '';
      console.log(`[w69-attack] wire +${f.t - wallPress}ms ${String(fr.method)} ${gist}`);
    }

    expect(back.length, `the attack pop-up is drawn again after its OK${firstBack === undefined ? '' : `, reading "${firstBack.text}"`}`).toBe(0);

    // A real later window of alice's own still opens and is drawn (bob's own windows pressed on the way).
    const until = Date.now() + 60_000;
    let next = '';
    while (Date.now() < until) {
      if ((await enabledOk(alice.page).count()) > 0 && !ATTACK.test((await decisionText(alice.page)) ?? '')) {
        next = await says(alice.page);
        break;
      }
      await clickOnce(bob.page, await says(bob.page), 'ok');
      await alice.page.waitForTimeout(100);
    }
    console.log(`[w69-attack] alice's next window of her own: "${next}"`);
    expect(next, 'a later window of her own is drawn').not.toBe('');
  } finally {
    await stack.stop();
  }
});
