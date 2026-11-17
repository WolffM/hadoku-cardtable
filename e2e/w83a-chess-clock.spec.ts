/**
 * The chess clock (the operator, 2026-10-30, D2; per game since 2026-11-07: *"20min per game, not
 * 20min per match"*): each player's time for a game runs whenever the game is waiting on that player,
 * never on the server's own auto-passes, and at zero that player loses the game, which the result
 * calls Out of Time.
 *
 * **The new-game grace:** the operator, of the flash into a series' next game, *"the clock
 * gives a 1-minute grace before it starts running."* `NEW_GAME_CLOCK_GRACE_MS` (`play/match.ts`) is
 * 60 s, for every new game, this scenario match included — not only a series' second game — so this
 * spec reads full, not-running clocks for the first beat and only then waits for alice's to start.
 *
 * A short, test-only clock (`clockMs` on the start body; a room's own is 20 minutes). Alice holds
 * priority in her main phase with a castable Lightning Bolt (`bolt-player`) and does nothing. Her
 * clock runs on both screens and bob's does not — bob's whole time is unchanged while she idles,
 * though Forge hands him priority nowhere in that window and the server answers none of his.
 * Her clock reaches zero: she loses, and both screens say so.
 *
 * `[w83a-clock]` lines are the evidence: each screen's two readings, every few seconds.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const CLOCK_MS = 25_000;
/** `play/match.ts`'s `NEW_GAME_CLOCK_GRACE_MS`: no seat's clock runs before this many ms have passed. */
const GRACE_MS = 60_000;

const say = (line: string): void => console.log(`[w83a-clock] ${line}`);

interface Reading {
  text: string;
  seconds: number;
  running: boolean;
  grace: boolean;
}

/** Both clocks on one screen, the viewer's own first. */
async function clocks(page: Page): Promise<{ you: Reading | null; them: Reading | null }> {
  return page.evaluate(() => {
    const read = (seat: Element | null) => {
      const clock = seat?.querySelector<HTMLElement>('[data-testid="match-clock"]') ?? null;
      if (clock === null) return null;
      const text = clock.textContent?.trim() ?? '';
      const [m, s] = text.split(':').map(Number);
      return { text, seconds: (m ?? 0) * 60 + (s ?? 0), running: clock.hasAttribute('data-running'), grace: clock.hasAttribute('data-grace') };
    };
    const seats = Array.from(document.querySelectorAll('[data-testid="player"]'));
    return { you: read(seats.find((s) => s.hasAttribute('data-viewer')) ?? null), them: read(seats.find((s) => !s.hasAttribute('data-viewer')) ?? null) };
  });
}

test(titled('a seat that idles on priority runs out of time and loses; the other clock never moves'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const started = Date.now();
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'bolt-player', { clockMs: [CLOCK_MS, CLOCK_MS] });

    // Inside the grace neither clock runs, full and static on both screens — and both draw
    // `data-grace`, the one state the operator asked for on the clock itself ("the clock gives a
    // 1-minute grace before it starts running"): a held clock otherwise looks exactly like one
    // merely waiting on the OTHER seat's turn, which this attribute is what tells apart.
    const graceLeft = GRACE_MS - (Date.now() - started);
    if (graceLeft > 5_000) {
      const inGrace = await clocks(alice.page);
      expect(inGrace.you?.running, "inside the grace, alice's own clock does not run").toBe(false);
      expect(inGrace.them?.running, "inside the grace, bob's does not either").toBe(false);
      expect(inGrace.you?.grace, "inside the grace, alice's own clock shows it").toBe(true);
      expect(inGrace.them?.grace, "inside the grace, bob's shows it too").toBe(true);
      say(`inside the grace (${graceLeft}ms left): alice ${inGrace.you?.text} grace=${inGrace.you?.grace}, bob ${inGrace.them?.text} grace=${inGrace.them?.grace}`);
    }

    // Both screens draw both clocks, and agree whose is running once the grace ends: alice's —
    // and `data-grace` is gone from both the instant it is, not left drawn alongside the real run.
    await expect
      .poll(async () => (await clocks(alice.page)).you?.running, { timeout: GRACE_MS + 20_000, message: "alice's own clock runs on her screen, once the grace ends" })
      .toBe(true);
    await expect.poll(async () => (await clocks(bob.page)).them?.running, { timeout: 10_000, message: "alice's clock runs on bob's screen" }).toBe(true);
    expect(Date.now() - started, 'the clock did not start before the grace ended').toBeGreaterThanOrEqual(GRACE_MS - 1_000);
    const afterGrace = await clocks(alice.page);
    expect(afterGrace.you?.grace, "alice's own clock: the grace is over, not merely not running").toBeFalsy();
    expect((await clocks(bob.page)).them?.grace, "bob's screen agrees the grace is over").toBeFalsy();
    say(`grace ended: alice ${afterGrace.you?.text} grace=${afterGrace.you?.grace}`);

    const bobAtStart = (await clocks(bob.page)).you;
    expect(bobAtStart, "bob's own clock is drawn").not.toBeNull();
    expect(bobAtStart!.running, "bob's clock is not running while the game waits on alice").toBe(false);
    const aliceAtStart = (await clocks(alice.page)).you!;
    say(`${matchId} start: alice ${aliceAtStart.text}, bob ${bobAtStart!.text}`);

    // Alice idles. Her reading falls on both screens; bob's never moves, on either.
    const seen: string[] = [];
    let aliceLow = aliceAtStart.seconds;
    for (;;) {
      await alice.page.waitForTimeout(3_000);
      if ((await alice.page.getByTestId('game-result').count()) > 0) break;
      const [a, b] = [await clocks(alice.page), await clocks(bob.page)];
      seen.push(`alice sees ${a.you?.text}/${a.them?.text}, bob sees ${b.you?.text}/${b.them?.text}`);
      say(seen.at(-1)!);
      if (a.you === null || b.you === null || a.them === null || b.them === null) break;
      expect(b.you.text, "bob's own clock does not move while alice is waited on").toBe(bobAtStart!.text);
      expect(a.them.text, "bob's clock on alice's screen does not move either").toBe(bobAtStart!.text);
      expect(b.you.running).toBe(false);
      // At zero it can fall no further; the flag's result can take longer than one reading to draw, and is awaited below.
      if (aliceLow === 0) break;
      expect(a.you.seconds, "alice's clock falls").toBeLessThan(aliceLow);
      expect(Math.abs(a.you.seconds - b.them.seconds), 'both screens agree on alice to the second').toBeLessThanOrEqual(1);
      aliceLow = a.you.seconds;
    }

    // At zero alice loses the game: Defeat on her screen, Victory on bob's.
    await expect(alice.page.getByTestId('game-result')).toHaveAttribute('data-result', 'defeat', { timeout: 30_000 });
    await expect(bob.page.getByTestId('game-result')).toHaveAttribute('data-result', 'victory', { timeout: 30_000 });
    // The server concedes for her, but neither screen calls it a concede: she ran out of time.
    for (const f of [alice, bob]) await expect(f.page.getByTestId('game-result'), 'the result says why').toContainText('Out of Time');
    const flag = serverLog(stack).find((e) => e.evt === 'clock-flag' && e.matchId === matchId);
    expect(flag, 'the server says whose time ran out').toMatchObject({ seat: 0 });
    expect(seen.length, 'the clock was read while alice idled').toBeGreaterThanOrEqual(3);
  } finally {
    await stack.stop();
  }
});
