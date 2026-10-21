/*
 * Starting a match shows no error on either screen — the operator, 2026-10-10:
 * "there is a weird sequence when starting a game where orange text pops up
 * saying 'game cannot be started' or 'room for this game has already begun'.
 * can we fix how this works?"
 *
 * Both players readied means BOTH browsers ask the server to start: whoever
 * readied last asks on its own answer, the other on its next table poll. Forge
 * takes seconds to come up, so the second ask lands while the first is still in
 * flight. Each case below is a sequence a real pair of players makes, and in
 * each the match starts normally — so no orange text may appear on either
 * screen at any moment (every role="alert" and `.lobby__error` that ever enters
 * the DOM is recorded, not sampled), and both screens reach the SAME match.
 *
 * `[start-race]` lines are the evidence: every error text either screen drew,
 * with when, and the match each screen reached.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, twoLegalDecks } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;

/** Every error text this friend's screen ever draws, across reloads. */
async function recordErrors(f: Friend, seen: string[]): Promise<void> {
  const t0 = Date.now();
  await f.context.exposeBinding('__startRaceError', (_src, text: string) => {
    const line = `${f.name} +${Date.now() - t0}ms: ${text}`;
    seen.push(line);
    console.log(`[start-race] ERROR DRAWN ${line}`);
  });
  await f.context.addInitScript(() => {
    const said = new WeakMap<Element, string>();
    const look = (): void => {
      for (const el of Array.from(document.querySelectorAll('[role="alert"], .lobby__error'))) {
        const text = (el.textContent ?? '').trim();
        if (text === '' || said.get(el) === text) continue;
        said.set(el, text);
        (window as unknown as { __startRaceError: (t: string) => void }).__startRaceError(text);
      }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

/** Alice makes a room, bob opens it, each holds a legal deck of their own. Neither is ready. */
async function seat(alice: Friend, bob: Friend, stack: PlayStack): Promise<void> {
  const choice = await twoLegalDecks(alice.context.request, stack.origin);
  await alice.page.goto(`${stack.origin}${PREFIX}/`);
  await submitCreateRoom(alice.page, { name: `start race ${Date.now()}` });
  await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
  await bob.page.goto(alice.page.url());
  await expect(bob.page.getByTestId('constructed')).toBeVisible({ timeout: 30_000 });
  await alice.page.getByTestId('format').selectOption(choice.format);
  await expect(bob.page.getByTestId('format-fixed')).toHaveAttribute('data-format', choice.format);
  for (const [f, deck] of [
    [alice, choice.decks[0]],
    [bob, choice.decks[1]],
  ] as const) {
    await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
    await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
    await expect(f.page.getByTestId('ready-toggle')).toBeEnabled();
  }
}

/** Both screens on a match board; the match each reached. */
async function bothInMatch(alice: Friend, bob: Friend): Promise<[string, string]> {
  await alice.page.waitForURL(MATCH_URL, { timeout: 120_000 });
  await bob.page.waitForURL(MATCH_URL, { timeout: 120_000 });
  for (const f of [alice, bob]) await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
  const a = MATCH_URL.exec(alice.page.url())?.[1] ?? '';
  const b = MATCH_URL.exec(bob.page.url())?.[1] ?? '';
  console.log(`[start-race] alice reached ${a}, bob reached ${b}`);
  return [a, b];
}

async function race(browser: import('@playwright/test').Browser, how: string, press: (alice: Friend, bob: Friend) => Promise<void>): Promise<void> {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const errors: string[] = [];
    await recordErrors(alice, errors);
    await recordErrors(bob, errors);
    await seat(alice, bob, stack);
    console.log(`[start-race] ${how}: both seated, pressing`);
    await press(alice, bob);
    const [a, b] = await bothInMatch(alice, bob);
    // The board has drawn on both; a late refusal would have drawn by now too.
    expect(errors, `${how}: no error text on either screen while the match starts`).toEqual([]);
    expect(b, `${how}: both screens are in the same match`).toBe(a);
  } finally {
    await stack.stop();
  }
}

test(titled('alice readies, then bob: the match starts with no error on either screen'), async ({ browser }) => {
  await race(browser, 'one then the other', async (alice, bob) => {
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
    await bob.page.getByTestId('ready-toggle').click();
  });
});

test(titled('both press Ready at the same moment: the match starts with no error on either screen'), async ({ browser }) => {
  await race(browser, 'together', async (alice, bob) => {
    await Promise.all([alice.page.getByTestId('ready-toggle').click(), bob.page.getByTestId('ready-toggle').click()]);
  });
});

test(titled('a reload while the match is starting: no error, and both screens reach the one match'), async ({ browser }) => {
  await race(browser, 'reload during start', async (alice, bob) => {
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
    // Bob's ready answers both-ready and his screen asks for the match; he reloads while it is starting.
    const asked = bob.page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/play/matches'));
    await bob.page.getByTestId('ready-toggle').click();
    await asked;
    console.log('[start-race] bob asked for the match; reloading mid-start');
    await bob.page.reload();
  });
});
