/**
 * AE26 — a spell of the opponent's, committed to the stack while this seat
 * holds priority ("Resolve Viridian Zealot?"), is ONE object on this screen:
 * the back at their release point, turned over into the face in place — never
 * a face at one spot beside a back lingering at another until a timer ends it
 * (the operator's Mana Leak screenshot, 2026-10-09: "why are we showing the
 * card back here still when we're already showing the turned around version?
 * … after a few seconds it went away so there's still something flaky here").
 *
 * The scenario (`w49-a-counterspell-opponent`): bob holds Counterspell, so
 * Forge stops at HIS priority with alice's Memnite on the stack. Bob's page is
 * watched from BEFORE alice's release by a MutationObserver that records every
 * change to the presence back and to the placed spell (which of the two is
 * drawn, where, and whether the placed one is the back or the face), and on
 * every animation frame besides, since a gliding back moves without one. The
 * record is printed; the claims read it: once the face exists, no presence
 * back exists past one frame; the face's first box is where the back stood.
 */
import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, handCardNamed, makeTitled, offered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Seen = { t: number; back: { x: number; y: number } | null; placed: { x: number; y: number; face: boolean } | null };

async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const seen: Seen[] = [];
    const w = window as unknown as { __commit: () => Seen[] };
    w.__commit = () => seen;
    let last = '';
    const centre = (el: Element | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return r.width === 0 ? null : { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    const look = () => {
      const back = centre(document.querySelector('[data-board-overlay] .presence__back'));
      const placedEl = document.querySelector<HTMLElement>('[data-placed-spell]:not([data-mine])');
      const placedAt = centre(placedEl);
      const placed = placedEl === null || placedAt === null || placedEl.hasAttribute('data-placed-pending') ? null : { ...placedAt, face: placedEl.querySelector('.placed__back') === null };
      const key = JSON.stringify([back, placed]);
      if (key === last) return;
      last = key;
      seen.push({ t: Math.round(performance.now() - t0), back, placed });
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-waiting', 'data-placed-pending', 'class'] });
    // And every frame: a back on its CSS glide moves with no mutation at all, so the observer alone
    // records where the glide started, not where the back stood when the face replaced it.
    const frame = (): void => {
      look();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

const record = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __commit: () => Seen[] }).__commit());
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

test(titled('the opponent’s committed spell is one object on this screen: the back at their release point turns into the face in place, and no back lingers beside it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w49-a-counterspell-opponent');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    const memnite = await handCardNamed(alice.page, 'Memnite');
    expect(memnite, 'Memnite is in alice’s hand, as the scenario scripts').not.toBeUndefined();
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered Memnite' }).toContain(memnite!);
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const to = { x: herField.x + herField.width * 0.6, y: herField.y + herField.height * 0.4 };

    await watch(bob.page);
    expect(await dragHandCard(alice.page, memnite!, to), 'the press lifted Memnite').toBe(true);
    // Her own priority after the cast is auto-passed (measured: `prompt-withheld s0 priority
    // auto-pass`); bob — who holds Counterspell — is stopped at his with her Memnite on the stack
    // (`prompt-forwarded s1 priority kept`). What this screen draws for it is the claim.
    await expect(bob.page.locator('[data-placed-spell]:not([data-mine])'), 'her Memnite is a placed card on bob’s screen').toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => says(bob.page), { timeout: 10_000, message: 'bob holds priority with her Memnite on the stack' }).toMatch(/Priority/);
    // Five seconds of watching after the face exists: long enough for every grace timer this
    // module has (1.5 s cleared-grace, the 300 ms pending window) to show its hand.
    await bob.page.waitForTimeout(5_000);

    const seen = await record(bob.page);
    console.log(`[commit] bob saw: ${seen.map((s) => `${s.t}ms back=${s.back ? `${s.back.x},${s.back.y}` : '-'} placed=${s.placed ? `${s.placed.x},${s.placed.y}${s.placed.face ? ' face' : ' back'}` : '-'}`).join(' → ')}`);
    const firstFace = seen.find((s) => s.placed !== null && s.placed.face);
    expect(firstFace, 'the face was drawn').toBeDefined();
    const lastBackBefore = [...seen].reverse().find((s) => s.t <= firstFace!.t && s.back !== null)?.back ?? null;
    expect(lastBackBefore, 'a back stood at her release point before the face').not.toBeNull();
    expect(dist(firstFace!.placed!, lastBackBefore!), 'the face is drawn where the back stood (within 4 px)').toBeLessThanOrEqual(4);
    const lingering = seen.filter((s) => s.t > firstFace!.t + 50 && s.back !== null);
    expect(lingering, 'no presence back exists past one frame after the face — one object, never two').toEqual([]);
  } finally {
    await stack.stop();
  }
});
