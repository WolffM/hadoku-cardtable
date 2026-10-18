/**
 * Whose turn it is, on the table's edge. The operator, 2026-10-14, chose an edge light along the
 * active player's side with the other side in shade; on 2026-10-17: *"make sure the curved board
 * outline for the active player matches who's turn it is (danger for enemy)"*.
 *
 * Scenario `own-spell`, two people, passed through three turn boundaries (turns 1 → 4). At each
 * boundary, on BOTH screens, against what Forge itself last sent (`Turn` / `PlayerTurn` in the
 * bridge's `stream.jsonl`, never a deduction from the client):
 *
 *  - exactly one seat carries `data-active`, and it is Forge's active player;
 *  - that seat, and only it, is lit, and the other sits in shade;
 *  - the light is the accent on the viewer's own turn and the danger on the other seat's
 *    (`turnMarks`' `hue`), in a dark theme on Alice's screen and the default light one on Bob's.
 *
 * Throughout the passing, every sample also checks that the phase rail's `data-whose` agrees with
 * the seat's `data-active` in the same frame: both are read off one view, so a frame where they
 * part is a torn render. Every sample where a screen disagrees with Forge is printed with its time
 * (`[turn-edge] lag`), so a pacer delivering the turn late shows up as a number, not a guess.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and
 * the title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { clickOnce, grindPriority, makeTitled, turnMarks } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { says, startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[turn-edge] ${JSON.stringify({ step, data })}`);

/** Alice's screen is measured in a dark theme, Bob's in the default light one. */
const DARK = 'coffee-dark';
const BOUNDARIES = 3;

/** Press OK (or, failing that, Cancel/"End Turn") to keep a match moving with no particular goal but to advance it. */
async function passWhatever(page: Page): Promise<void> {
  await answerPrompt(page);
  if ((await page.getByTestId('live-prompt').count()) > 0) return;
  const text = await says(page);
  if (await clickOnce(page, text, 'ok')) return;
  await clickOnce(page, text, 'cancel');
}

interface ForgeTurn {
  turn: number;
  player: number;
}

/** Forge's turn as the bridge last sent it to any seat: the last `Turn` and `PlayerTurn` in the stack's `stream.jsonl` frames. */
function forgeTurn(workDir: string): ForgeTurn | null {
  const runs = readdirSync(workDir)
    .map((run) => join(workDir, run, 'stream.jsonl'))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  let turn: number | null = null;
  let player: number | null = null;
  for (const file of runs) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.startsWith('{"t":"frame"')) continue;
      for (const m of line.matchAll(/"(Turn|PlayerTurn)":\{"t":"int","v":(\d+)\}/g)) {
        if (m[1] === 'Turn') turn = Number(m[2]);
        else player = Number(m[2]);
      }
    }
  }
  return turn === null || player === null ? null : { turn, player };
}

interface Screen {
  /** The seats carrying `data-active`, by Forge player id. */
  active: string[];
  viewer: string | null;
  /** The phase rail's `data-whose`. */
  whose: string | null;
}

/** One frame of one screen: whose seat is active, and what the phase rail says, read together. */
function screenOf(page: Page): Promise<Screen> {
  return page.evaluate(() => ({
    active: Array.from(document.querySelectorAll('[data-testid="player"][data-active]')).map((s) => s.getAttribute('data-player-id') ?? '?'),
    viewer: document.querySelector('[data-testid="player"][data-viewer]')?.getAttribute('data-player-id') ?? null,
    whose: document.querySelector('.live__phases')?.getAttribute('data-whose') ?? null,
  }));
}

test(titled('the active seat’s edge light follows Forge’s turn on both screens, across three turns, in the accent on your turn and the danger on theirs'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    await alice.page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), DARK);
    const screens = [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const;

    const started = Date.now();
    const torn: unknown[] = [];
    /** Per screen and Forge turn, the first and last sample where the screen's active seat was not Forge's. */
    const lags = new Map<string, { from: number; to: number }>();
    /** Forge's turn and both screens, now; records a torn frame or a screen behind Forge. */
    const sample = async (): Promise<{ forge: ForgeTurn | null; seen: Record<string, Screen> }> => {
      const f = forgeTurn(stack.workDir);
      const seen: Record<string, Screen> = {};
      for (const [who, page] of screens) {
        const s = await screenOf(page);
        seen[who] = s;
        const want = s.active.length !== 1 ? null : s.active[0] === s.viewer ? 'yours' : 'theirs';
        if (want !== null && s.whose !== want) torn.push({ ms: Date.now() - started, who, ...s });
        if (f !== null && (s.active.length !== 1 || s.active[0] !== String(f.player))) {
          const key = `${who} turn ${f.turn}`;
          const ms = Date.now() - started;
          lags.set(key, { from: lags.get(key)?.from ?? ms, to: ms });
        }
      }
      return { forge: f, seen };
    };

    const turns: ForgeTurn[] = [];
    for (let boundary = 0; ; boundary++) {
      let at: Awaited<ReturnType<typeof sample>> | null = null;
      try {
        await expect
          .poll(async () => {
            at = await sample();
            const f = at.forge;
            return f !== null && Object.values(at.seen).every((s) => s.active.length === 1 && s.active[0] === String(f.player));
          }, { timeout: 15_000, message: `turn boundary ${boundary}: both screens mark Forge’s active player, and only it` })
          .toBe(true);
      } finally {
        log(`boundary ${boundary}`, at);
      }
      const now = (at as unknown as Awaited<ReturnType<typeof sample>>).forge!;
      turns.push(now);
      const active = String(now.player);

      for (const [who, page] of screens) {
        const viewer = (await screenOf(page)).viewer;
        const seats = await page.locator('[data-testid="player"]').evaluateAll((all) => all.map((s) => s.getAttribute('data-player-id') ?? '?'));
        const hue = active === viewer ? 'accent' : 'danger';
        let marks: Awaited<ReturnType<typeof turnMarks>> = [];
        try {
          await expect
            .poll(async () => {
              marks = await turnMarks(page);
              return {
                lit: marks.filter((m) => m.lit).map((m) => m.id),
                hue: marks.filter((m) => m.lit).map((m) => m.hue),
                shaded: marks.filter((m) => m.shaded).map((m) => m.id),
              };
            }, { timeout: 10_000, message: `turn ${now.turn}, ${who}’s screen: player ${active}’s seat alone is lit, in the ${hue}` })
            .toEqual({ lit: [active], hue: [hue], shaded: seats.filter((id) => id !== active) });
        } finally {
          log(`turn ${now.turn} marks (${who})`, marks);
        }
      }

      if (boundary === BOUNDARIES) break;
      await grindPriority(
        [alice.page, bob.page],
        async () => {
          const f = (await sample()).forge;
          return f !== null && f.turn > now.turn;
        },
        { timeoutMs: 2 * 60_000, press: (p) => passWhatever(p) },
      );
    }

    log('turns', turns);
    log('lag', Object.fromEntries([...lags].map(([key, { from, to }]) => [key, { atMs: from, forMs: to - from }])));
    expect(turns.map((t) => t.turn - turns[0]!.turn), 'three boundaries, one turn apart').toEqual([0, 1, 2, 3]);
    expect(new Set(turns.map((t) => t.player)).size, 'the turn went to both players').toBe(2);
    expect(torn, 'no frame where the phase rail and the active seat disagree').toEqual([]);
  } finally {
    await stack.stop();
  }
});
