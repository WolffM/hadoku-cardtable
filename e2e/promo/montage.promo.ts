/**
 * Clips for the trailer's closing montage: one short moment each, from its own scenario
 * (`apps/server/src/play/scenarios/promo-m-<name>.state`), filmed as `m-<name>`. The operator asked for
 * "fresh moments in different situations", so each is a different kind of play: a removal spell, a wipe,
 * a burn finish, a big landing, tokens, a drain, a discard, an Emrakul swing.
 *
 * Each moment is data: the steps the hero takes. `go` is marked as the hero commits the step that makes
 * the moment (the target click, or the Done after attackers); `cut.py` finds the moment's peak itself, as
 * the biggest change on screen in the seconds after `go`, so no mark has to guess an animation's timing.
 * Run all: `shoot.sh montage`; one: `shoot.sh montage -g wrath`. Tests run one at a time (workers: 1).
 */
import { test, type Page } from '@playwright/test';

import { pressPaymentAuto, stackCount } from '../play/board.ts';
import { answerPrompt } from '../play/prompts.ts';
import { autoYield, cast, deliberateClick, faceTargetable, humanRest, opponentFace, okEnabled, pickTiles, pressIfThere, restCursor, selectionTiles, shootScenario, swing, theirCard, until, wrap, type Shoot } from './drive.ts';

type Target = 'face' | { theirs: string };
type Step = { cast: string; target?: Target } | { attack: 'all' };

interface Moment {
  name: string;
  steps: Step[];
  /** A card the hero takes from a revealed selection (Thoughtseize). */
  take?: RegExp;
}

const MOMENTS: Moment[] = [
  { name: 'bolt-bob', steps: [{ cast: 'Lightning Bolt', target: { theirs: 'Dark Confidant' } }] },
  { name: 'swords', steps: [{ cast: 'Swords to Plowshares', target: { theirs: 'Griselbrand' } }] },
  { name: 'wrath', steps: [{ cast: 'Wrath of God' }] },
  { name: 'lava-axe', steps: [{ cast: 'Lava Axe', target: 'face' }] },
  { name: 'griselbrand', steps: [{ cast: 'Griselbrand' }] },
  { name: 'tokens', steps: [{ cast: 'Hordeling Outburst' }] },
  { name: 'gary', steps: [{ cast: 'Gray Merchant of Asphodel' }] },
  { name: 'pyroclasm', steps: [{ cast: 'Pyroclasm' }] },
  { name: 'helix', steps: [{ cast: 'Lightning Helix', target: 'face' }] },
  { name: 'emrakul-swing', steps: [{ attack: 'all' }] },
  { name: 'thoughtseize', steps: [{ cast: 'Thoughtseize', target: 'face' }], take: /Show and Tell/ },
];

/** Answer whatever the step leaves open until the stack is empty and nobody is asked anything. */
async function settle(page: Page, rival: Page, moment: Moment, target: Target | undefined, onTarget: () => void, cast: string | null): Promise<void> {
  let aimed = false;
  // A cast is done once its spell has been on the stack and the stack is empty again: an untargeted spell
  // otherwise reads as settled before it is even paid for (cut 3's Wrath was filmed unresolved).
  let stacked = cast === null;
  // …or once the card has left the stack for its next zone, in case it came and went between two polls.
  const landed = page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card], .seat [data-zone="graveyard"][data-owner="you"] [data-board-card]', { hasText: cast ?? '\u0000' });
  await until(`${moment.name} settles`, async () => {
    if ((await page.getByTestId('game-result').count()) > 0) return true;
    if (!aimed && target === 'face' && (await faceTargetable(page))) {
      await deliberateClick(page, opponentFace(page), { hover: 450 });
      aimed = true;
      onTarget();
      return false;
    }
    if (!aimed && target !== undefined && target !== 'face') {
      const card = theirCard(page, target.theirs);
      if ((await card.getAttribute('data-selectable').catch(() => null)) !== null) {
        await deliberateClick(page, card.locator('button').first(), { hover: 450 });
        aimed = true;
        onTarget();
        return false;
      }
    }
    for (const [who, take] of [[page, moment.take], [rival, undefined]] as const) {
      const tiles = await selectionTiles(who);
      if (tiles.length > 0) {
        const want = take === undefined ? tiles : tiles.filter((t) => take.test(t.text));
        await pickTiles(who, (want.length > 0 ? want : tiles).map((t) => t.id), 220);
        return false;
      }
      await answerPrompt(who).catch(() => null);
    }
    await pressPaymentAuto(page);
    if ((await stackCount(page)) > 0 || (await landed.count()) > 0) stacked = true;
    const open = (await page.getByTestId('live-prompt').count()) + (await rival.getByTestId('live-prompt').count());
    if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
    return stacked && (await stackCount(page)) === 0 && open === 0 && (target === undefined || aimed);
  }, 60_000, 250, page);
}

for (const moment of MOMENTS) {
  test(`montage: ${moment.name}`, async ({ browser }) => {
    let shoot: Shoot | undefined;
    try {
      shoot = await shootScenario(browser, `m-${moment.name}`, `promo-m-${moment.name}`);
      const { film, hero, rival } = shoot;
      const page = hero.page;
      await autoYield(rival.page);
      await restCursor(page);
      film.mark('board');
      await film.beat(1_200);
      for (const step of moment.steps) {
        if ('attack' in step) {
          await swing(page, step.attack);
          film.mark('go');
          await settle(page, rival.page, moment, undefined, () => undefined, null);
          continue;
        }
        await cast(page, step.cast, { hover: 600 });
        if (step.target === undefined) film.mark('go');
        await settle(page, rival.page, moment, step.target, () => film.mark('go'), step.cast);
        await humanRest(page, 300);
      }
      await restCursor(page);
      film.mark('settled');
      await film.beat(3_500);
      film.mark('end');
    } finally {
      await wrap(shoot ?? {});
    }
  });
}
