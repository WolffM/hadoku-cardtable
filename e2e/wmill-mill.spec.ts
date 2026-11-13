/**
 * Cards milled fly from their library into their graveyard, against real Forge.
 *
 * The operator, 2026-11-01: *"we need a 'milling' animation. something for cards put into the graveyard from
 * the library."* `games/magic/ui/src/play/live/mill.ts` finds every card that left a library and appeared in a graveyard
 * in the same frame and flies a copy of it, face up, from the library's count mark into its place on the pile,
 * which hides it until the copy lands. A big mill is a riffle that ends in about a second.
 *
 * `wmill-mill.state`, alice's main phase, Fast Mode off on both screens:
 *  1. Thought Scour on bob: two of his cards milled (a small mill, the other seat's library);
 *  2. Thought Scour on herself: two of hers (a self-mill);
 *  3. Glimpse the Unthinkable on bob: ten of his (the riffle);
 *  4. Notion Rain: both surveilled cards dragged into her graveyard (a surveil).
 *
 * Every step is measured on BOTH screens from the page itself (a recorder on `[data-mill]` copies): how many
 * copies flew, whether each one's art had decoded when it was drawn, and how long the run took from its first
 * copy to its last landing. `[wmill]` lines are the evidence. Each seat wears a watchparty character
 * (`forge:seats`'s `avatarId`, which a match no room started does not carry), so the film shows real faces.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

import { setPlayFastModeDefault } from './prefsLocal.ts';
import { clickHandCard, livePrompt, makeTitled, offeredCard, passOverStack, pressPaymentAuto, promptMethod, says, serverLog } from './play/board.ts';
import type { Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { dragRowOnto } from './play/order.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { ART_ROUTE } from './art.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** `mill.ts`'s `MILL_MAX_MS` and `MILL_MAX_FLYERS`; the slack is a busy claw's timers. */
const MILL_MAX_MS = 1000;
const MAX_FLYERS = 12;
const SLACK_MS = 400;

const SPRITES = ['sage', 'knight'] as const;

interface Flight {
  id: string;
  added: number;
  removed: number | null;
  art: boolean;
}

/** Before the page opens: Fast Mode off, every `[data-mill]` copy recorded, and each seat's watchparty face. */
async function prepare(page: Page): Promise<void> {
  await setPlayFastModeDefault(page.context(), false);
  await page.addInitScript(() => {
    const flights: { id: string; added: number; removed: number | null; art: boolean }[] = [];
    (window as unknown as { __mill: typeof flights }).__mill = flights;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement) || !n.hasAttribute('data-mill')) continue;
          const img = n.querySelector('img');
          flights.push({ id: n.getAttribute('data-mill')!, added: performance.now(), removed: null, art: img !== null && img.complete && img.naturalWidth > 0 });
        }
        for (const n of r.removedNodes) {
          if (!(n instanceof HTMLElement) || !n.hasAttribute('data-mill')) continue;
          const f = flights.findLast((x) => x.id === n.getAttribute('data-mill') && x.removed === null);
          if (f !== undefined) f.removed = performance.now();
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  // The watchparty characters and the cards' art, from the sites that serve them (the harness blocks every
  // request off 127.0.0.1, so a card is otherwise its text tile and the art rule has nothing to wait for).
  const fetched = async (route: Route, url: string): Promise<void> => {
    try {
      await route.fulfill({ response: await page.request.get(url) });
    } catch {
      await route.abort();
    }
  };
  await page.route('**/watchparty/media/sprites/**', (route) =>
    fetched(route, `https://hadoku.me/watchparty/media/sprites/${new URL(route.request().url()).pathname.split('/').pop()!}`),
  );
  await page.route(ART_ROUTE, (route) => fetched(route, route.request().url()));
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === 'string' ? withFaces(m) : m));
  });
}

/** A socket.io text packet with every seat identity given a watchparty character it lacks. */
function withFaces(packet: string): string {
  if (!packet.includes('"claimed"')) return packet;
  const at = packet.search(/[[{]/);
  if (at < 0) return packet;
  try {
    const data = JSON.parse(packet.slice(at)) as unknown;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.seat === 'number' && typeof o.claimed === 'boolean' && o.avatarId === undefined) o.avatarId = SPRITES[o.seat % SPRITES.length];
        Object.values(o).forEach(walk);
      }
    };
    walk(data);
    return packet.slice(0, at) + JSON.stringify(data);
  } catch {
    return packet;
  }
}

const graveyardCount = async (page: Page, whose: 'you' | 'them'): Promise<number> =>
  Number((await page.locator(`[data-zone="graveyard"][data-owner="${whose}"]`).first().getAttribute('data-count')) ?? NaN);

const flights = (page: Page): Promise<Flight[]> => page.evaluate(() => (window as unknown as { __mill: Flight[] }).__mill.splice(0));

const hiddenOnPiles = (page: Page): Promise<number> => page.locator('[data-zone="graveyard"] [data-departure-landing]').count();

test(titled('cards milled fly from their library to their graveyard on both screens: a small mill, a self-mill, a big mill as a riffle, and a surveil'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: { alice: Friend; bob: Friend } | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'wmill-mill', { beforeAlice: prepare, beforeBob: prepare });
    const { alice, bob } = seated;
    const pages = [alice.page, bob.page];
    const face = (whose: 'bob' | 'alice'): ReturnType<Page['locator']> =>
      alice.page.locator(whose === 'bob' ? '[data-player-face]:not([data-viewer])' : '[data-player-face][data-viewer]');

    /** Alice casts `name` on `target`; every target question is answered by a click on that face. */
    async function cast(name: string, target: 'bob' | 'alice' | null, done: () => Promise<boolean>): Promise<void> {
      // A click, not `castCard`: a target is asked before the spell reaches the stack.
      await clickHandCard(alice.page, await offeredCard(alice.page, name, { zone: 'hand', timeout: 45_000 }));
      await expect
        .poll(
          async () => {
            await pressPaymentAuto(alice.page);
            const text = await says(alice.page);
            if (target !== null && text.includes(name) && !/Pay Mana Cost/i.test(text) && !/^Priority/.test(text)) {
              await face(target).click({ timeout: 1_000 }).catch(() => undefined);
            } else if ((await promptMethod(alice.page)) === 'order') {
              // A surveil: every card it looks at into the graveyard.
              const prompt = livePrompt(alice.page);
              const top = alice.page.getByTestId('zone-source');
              const row = top.locator(':scope > li').first();
              if ((await row.count()) > 0) await dragRowOnto(alice.page, row, alice.page.getByTestId('zone-dest'));
              else await prompt.getByTestId('prompt-submit').click({ timeout: 1_000 }).catch(() => undefined);
            } else {
              for (const page of pages) await passOverStack(page);
            }
            return done();
          },
          { timeout: 90_000, intervals: [250], message: `${name} resolved` },
        )
        .toBe(true);
    }

    /** Both screens drew the run: `count` cards, at most a riffle of copies, art decoded, inside its time. */
    let logFrom = 0;
    async function drewMill(label: string, count: number, maxMs: number): Promise<void> {
      await expect.poll(async () => (await Promise.all(pages.map(hiddenOnPiles))).every((n) => n === 0), { timeout: 10_000, message: `${label}: every milled card is shown on its pile` }).toBe(true);
      // Each screen's own account of its runs (`mill.ts`'s report): how many cards, how many flew, what was not found.
      const log = serverLog(stack);
      for (const r of log.slice(logFrom)) if (r.evt === 'client' && r.what === 'mill') console.log(`[wmill] ${label} report seat ${String(r.seat)}: ${JSON.stringify(r)}`);
      logFrom = log.length;
      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        const run = await flights(page);
        const spanMs = run.length === 0 ? 0 : Math.max(...run.map((f) => f.removed ?? Infinity)) - Math.min(...run.map((f) => f.added));
        const first = Math.min(...run.map((f) => f.added));
        const starts = run.map((f) => Math.round(f.added - first)).join(',');
        console.log(`[wmill] ${label} on ${who}: ${run.length} copies for ${count} cards, art ${run.filter((f) => f.art).length}/${run.length}, ${Math.round(spanMs)} ms, starts ${starts}`);
        expect.soft(run.length, `${label} on ${who}: one copy per card, at most a riffle`).toBe(Math.min(count, MAX_FLYERS));
        expect.soft(run.every((f) => f.art), `${label} on ${who}: every copy drawn with its art decoded`).toBe(true);
        expect.soft(spanMs, `${label} on ${who}: the run's time`).toBeLessThanOrEqual(maxMs + SLACK_MS);
      }
    }

    // 1. A small mill, the other seat's library.
    await cast('Thought Scour', 'bob', async () => (await graveyardCount(alice.page, 'them')) === 2 && (await graveyardCount(alice.page, 'you')) === 1);
    await drewMill('Thought Scour on bob', 2, 700);

    // 2. A self-mill.
    await cast('Thought Scour', 'alice', async () => (await graveyardCount(alice.page, 'you')) === 4);
    await drewMill('Thought Scour on alice', 2, 700);

    // 3. A big mill: a riffle, about a second.
    await cast('Glimpse the Unthinkable', 'bob', async () => (await graveyardCount(alice.page, 'them')) === 12);
    await drewMill('Glimpse the Unthinkable on bob', 10, MILL_MAX_MS);

    // 4. A surveil, both cards into the graveyard (Notion Rain follows them).
    await cast('Notion Rain', null, async () => (await graveyardCount(alice.page, 'you')) === 8);
    await drewMill('Notion Rain surveil 2', 2, 700);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
