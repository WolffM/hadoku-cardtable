/**
 * The operator, 2026-10-14: *"i need a visual for emblems. let's make it so they go around the
 * player's avatar and hovering the players avatar shows all their emblems."*
 *
 * A Forge emblem is an effect card (`IsEmblem`) in its owner's Command zone, public to both seats.
 * Alice activates Sorin, Lord of Innistrad's emblem ability, then Gideon's, Elspeth's and Narset's:
 * after each, both screens draw one medallion per emblem around HER avatar — the viewer's seat on
 * her screen, the opponent's (mirrored) seat on Bob's — clear of the priority ring, inside the
 * seat's bar, with the avatar not moved by an inch; and hovering her avatar, or a medallion, opens
 * the board's one expanded view on every emblem she has, each as its trigger's chip — the operator,
 * 2026-10-21: *"we already have the emblem card chip for the trigger, we can just use that. and when
 * hovering over the player, then we display the card chips."* — inside the 1280×800 window. A chip
 * draws the emblem's own printing, with its credit, where Forge's edition names one (its `[other]`
 * rows, 2026-10-22).
 *
 * Scenario: `em-emblems`. Every step prints one `[em]` line (claws keep artifacts only on red).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { clickPermanent, makeTitled, passOverStack, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[em] ${JSON.stringify({ step, data })}`);

/** Each planeswalker, its loyalty before and after its emblem ability, and the emblem's own words. */
const WALKERS = [
  { name: 'Sorin, Lord of Innistrad', from: 3, to: 1, says: 'Creatures you control get +1/+0.' },
  { name: 'Gideon, Ally of Zendikar', from: 5, to: 1, says: 'Creatures you control get +1/+1.' },
  { name: 'Elspeth, Sun’s Champion', from: 8, to: 1, says: 'Creatures you control get +2/+2 and have flying.' },
  { name: 'Narset Transcendent', from: 10, to: 1, says: "Your opponents can't cast noncreature spells." },
] as const;

type Owner = 'you' | 'them';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What one screen draws of a seat's emblems: the medallions, their boxes, the avatar's and the bar's. */
interface Emblems {
  medallions: { box: Box; hit: boolean }[];
  more: string | null;
  art: Box | null;
  bar: Box | null;
}

function emblemsOf(page: Page, owner: Owner): Promise<Emblems> {
  return page.evaluate((owner) => {
    const box = (el: Element | null): Box | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    };
    const seat = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="player"]')).find((s) => s.hasAttribute('data-viewer') === (owner === 'you'));
    if (seat === undefined) return { medallions: [], more: null, art: null, bar: null };
    const marks = Array.from(seat.querySelectorAll<HTMLElement>('[data-emblem]'));
    return {
      medallions: marks.map((m) => {
        const b = box(m)!;
        // Painted where it is: the topmost element at its centre is the medallion (or inside it).
        const top = document.elementFromPoint(b.x + b.w / 2, b.y + b.h / 2);
        return { box: b, hit: top !== null && m.contains(top) };
      }),
      more: seat.querySelector<HTMLElement>('[data-emblem-more]')?.textContent?.trim() ?? null,
      art: box(seat.querySelector('[data-player-face] .face__art')),
      bar: box(seat.querySelector('.seat__who')),
    };
  }, owner);
}

/** What the inspector shows after the pointer rests on (`x`, `y`): each chip's name and words, all its text, and its box. */
interface Shown {
  chips: { name: string; text: string }[];
  text: string;
  box: Box;
}

async function inspectAt(page: Page, x: number, y: number): Promise<Shown> {
  await page.mouse.move(x, y);
  const panel = page.locator('[data-inspect]');
  await expect(panel, 'the inspector opens').toBeVisible({ timeout: 5_000 });
  return panel.evaluate((el): Shown => {
    const r = el.getBoundingClientRect();
    return {
      chips: Array.from(el.querySelectorAll('[data-ability-chip]')).map((c) => ({
        name: c.querySelector('.placed__chip-name')?.textContent?.trim() ?? '',
        text: c.querySelector('.placed__chip-text')?.textContent?.trim() ?? '',
      })),
      text: el.textContent ?? '',
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  });
}

/** The permanent named `name` on `owner`'s battlefield, by id. */
async function battlefieldNamed(page: Page, owner: Owner, name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card]`)
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name.replace(/[’']/g, "'") === name.replace(/[’']/g, "'"))?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is on the ${owner} battlefield` },
    )
    .not.toBeUndefined();
  return id!;
}

/** What the bridge sent of an emblem: each `stream.jsonl` line under the stack's work dir that names one, cut short. */
function emblemFrames(workDir: string): string[] {
  const out: string[] = [];
  for (const run of readdirSync(workDir)) {
    const file = join(workDir, run, 'stream.jsonl');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const at = line.indexOf('Emblem');
      if (at >= 0) out.push(line.slice(Math.max(0, at - 1500), at + 1500));
    }
  }
  return out.slice(0, 3);
}

const inside = (a: Box, b: Box): boolean => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;
/** Whether a medallion's circle is clear of the priority ring's: the avatar's circle and 6px around it (`card.css`'s `.seat__ring`). */
const clearOfRing = (m: Box, art: Box): boolean =>
  Math.hypot(m.x + m.w / 2 - (art.x + art.w / 2), m.y + m.h / 2 - (art.y + art.h / 2)) >= art.w / 2 + 6 + m.w / 2;

test(titled('emblems ring their owner’s avatar on both screens, clear of the priority ring, and hovering it shows every emblem as its trigger’s chip'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'em-emblems');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    // Alice's seat, from each screen: hers is the viewer's seat, on Bob's it is the opponent's.
    const screens = [
      ['alice', alice.page, 'you'],
      ['bob', bob.page, 'them'],
    ] as const;

    const before = new Map<string, Box | null>();
    for (const [who, page, owner] of screens) {
      const seen = await emblemsOf(page, owner);
      log(`before (${who})`, seen);
      expect(seen.medallions, `${who}: no emblem yet`).toEqual([]);
      before.set(who, seen.art);
    }

    for (const [n, walker] of WALKERS.entries()) {
      const id = await battlefieldNamed(alice.page, 'you', walker.name);
      expect(await clickPermanent(alice.page, id), `${walker.name} is offered`).toBe(true);
      const emblem = alice.page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]').filter({ hasText: 'You get an emblem' });
      await expect(emblem, `${walker.name}: the emblem ability is among its abilities`).toHaveCount(1, { timeout: 15_000 });
      await emblem.click();
      // Paid and resolved — loyalty less the cost, and an empty stack. Both pass if asked.
      await expect
        .poll(
          async () => {
            for (const p of [alice.page, bob.page]) await passOverStack(p);
            const loyalty = await alice.page.locator(`[data-board-card="${id}"] > .board-card__face .card__stat`).textContent();
            return `${loyalty?.trim()} | stack ${await stackCount(alice.page)}`;
          },
          { timeout: 30_000, message: `${walker.name}: the emblem ability resolved` },
        )
        .toBe(`${walker.to} | stack 0`);

      const want = WALKERS.slice(0, n + 1);
      if (n === 0) log('the wire', emblemFrames(stack.workDir));
      for (const [who, page, owner] of screens) {
        let seen: Emblems = await emblemsOf(page, owner);
        try {
          await expect.poll(async () => (seen = await emblemsOf(page, owner)).medallions.length, { timeout: 15_000, message: `${who}: one medallion per emblem around alice’s avatar` }).toBe(want.length);
        } finally {
          log(`after ${walker.name} (${who})`, seen);
        }
        const art = seen.art!;
        expect(art, `${who}: alice’s avatar did not move`).toEqual(before.get(who));
        for (const [i, m] of seen.medallions.entries()) {
          expect(clearOfRing(m.box, art), `${who}: medallion ${i} is clear of the priority ring`).toBe(true);
          expect(inside(m.box, seen.bar!), `${who}: medallion ${i} is inside the seat’s bar`).toBe(true);
          expect(m.hit, `${who}: medallion ${i} is painted on top`).toBe(true);
        }

        // Hover the avatar, then a medallion: the one expanded view shows every emblem as its trigger's chip.
        const onFace = await inspectAt(page, art.x + art.w / 2, art.y + art.h / 2);
        const m = seen.medallions.at(-1)!.box;
        const onMedallion = await inspectAt(page, m.x + m.w / 2, m.y + m.h / 2);
        log(`hover after ${walker.name} (${who})`, { onFace, onMedallion });
        const chips = want.map((w) => ({ name: `Emblem — ${w.name}`, text: w.says }));
        for (const shown of [onFace, onMedallion]) {
          expect(shown.chips.map((c) => ({ name: c.name.replace(/^Emblem\s*[—–-]\s*/, 'Emblem — ').replace(/[’']/g, '’'), text: c.text })), `${who}: one chip per emblem`).toEqual(chips);
          expect(inside(shown.box, { x: 0, y: 0, w: 1280, h: 800 }), `${who}: the chips fit the window`).toBe(true);
        }
        await page.mouse.move(0, 0);
        await expect(page.locator('[data-inspect]'), `${who}: leaving the avatar puts the chips away`).toHaveCount(0);
      }
    }
  } finally {
    await stack.stop();
  }
});
