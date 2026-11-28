/**
 * Sunday's fire drill: `docs/TOURNAMENT_RUNBOOK.md` run the way an operator would run it, against the
 * real built server and real Forge, in an 8-seat Bloomburrow pod of four people and four bots, Bots
 * play off (the Draft Major's own setting). The operator is an admin who is in the room but neither
 * leads it nor plays. Each symptom of the runbook's "Find the tool from what you see" table is caused
 * in turn, and the operator answers it with the runbook's own words:
 *
 *  - the operator joins: "press Stand" before anyone readies;
 *  - a no-show at the lock: the seat chip's Bot;
 *  - a drafter who closes their tab mid-pack: the console's member lookup, then pick-for;
 *  - a seat that never picks, with the pick timer off: the console's timer command;
 *  - a softlock (Forge waits on a bar the seat's screen never got): ⋯ → Re-send asks;
 *  - a Restart turn, on a lossy turn when the game reaches one (the ⚠ path), else on the turn as it stands;
 *  - a wrong result in a finished match while the round still plays: ⋯ → Match to ‹right player›;
 *  - a DQ mid-round: ⋯ → DQ ‹player›.
 *
 * "Verbatim" is literal: the console steps are the runbook's own ```js blocks, read from the file at
 * run time and evaluated in the operator's page, with only the `r-…`/`fk:…` placeholders filled in;
 * the controls are pressed by the names the runbook gives them. Where the text does not get there,
 * the drill says how (`[drill] MISS …`) and does what a person would do next; a product step that
 * does not do what the runbook says it does fails the test. The server log after each injection is
 * printed (`openAsks`, refusals, the operator's acts). The table at the end is the drill's record.
 *
 * Needs a Forge build. Run it on the claw path: `CARDTABLE_E2E_CLAWS=1` (`play/harness.ts`), on a claw.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Browser, type Page, type WebSocket } from '@playwright/test';

import type { DraftCard } from '../packages/shared/src/index.ts';
import { isPodAi } from '../packages/shared/src/pod.ts';

import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromAddress, serverLog } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { connectHands, type Hands } from './play/hands.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { readyPod } from './podSeats.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
// A match start, the server's own bound (`play/socket.ts` `startTimeoutMs`): a restored game boots a fresh JVM.
const START_TIMEOUT = 60_000;
const TICK_MS = 400;
const MATCH_HASH = /^#\/match\/(m-[0-9a-f]{12})$/;
const RUNBOOK = readFileSync(resolve(import.meta.dirname, '..', 'docs', 'TOURNAMENT_RUNBOOK.md'), 'utf8');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (line: string): void => console.log(`[drill] ${line}`);

type WireCard = Pick<DraftCard, 'cardId' | 'name' | 'colors' | 'typeLine' | 'manaValue'> & { rarity?: string };

interface RoomBody {
  members: { id: string; name: string }[];
  tables: {
    id: string;
    matchId: string | null;
    players: { memberId: string }[];
    series: { wins: [number, number]; phase: string; played: number };
  }[];
  game: {
    pod: {
      phase: string;
      round: number;
      rounds: number;
      seats: ({ memberId: string; name?: string } | null)[];
      pairings: { tableId: string; players: [string, string | null] }[];
      results: {
        round: number;
        playerA: string;
        playerB: string | null;
        gamesA: number;
        gamesB: number;
      }[];
      standings: { id: string; rank: number; matchPoints: number }[];
      dropped?: string[];
    } | null;
  };
}

interface LiveTable {
  tableId: string;
  matchId: string | null;
  epochs: string[];
  match: {
    status: string;
    turn: number | null;
    restoreTurn: number | null;
    restoreLossy?: string[];
    seats: { ai: boolean; asks: { method: string }[] }[];
  } | null;
}

/** What a person at a table does with the game in front of them. */
type Policy = 'play' | 'concede' | 'wait';

interface Player {
  f: Friend;
  name: string;
  id: string;
  pack: () => readonly WireCard[] | null;
  picks: WireCard[];
  policy: Policy;
  /** Server bars and asks never reach this screen (the softlock): Forge waits on a question the page was not shown. */
  dropBars: boolean;
  dropped: number;
  hands: Hands | null;
  handsFor: string;
  results: string[];
  errors: string[];
}

interface Row {
  symptom: string;
  step: string;
  asWritten: boolean;
  misses: string[];
  ms: number;
  error: string | null;
}

/* ── the runbook's own console blocks ───────────────────────────────── */

const JS_BLOCKS = [...RUNBOOK.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!);

/** The one ```js block of the runbook that contains `has`. */
function runbookBlock(has: string): string {
  const found = JS_BLOCKS.filter((b) => b.includes(has));
  if (found.length !== 1) throw new Error(`the runbook has ${found.length} js blocks containing ${JSON.stringify(has)}`);
  return found[0]!;
}

/**
 * The operator's console: each block is pasted as written, its placeholders filled in, after the
 * `const`s pasted before it (a DevTools session keeps them). Returns what the block's last line
 * evaluates to, as the console would print it.
 */
class OperatorConsole {
  private consts = new Map<string, string>();
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  async paste(block: string, fill: Record<string, string>): Promise<unknown> {
    let text = block;
    for (const [from, to] of Object.entries(fill)) text = text.split(from).join(to);
    const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('//'));
    const own = new Map<string, string>();
    const statements: string[] = [];
    for (const l of lines) {
      const decl = /^const (\w+) = /.exec(l.trim());
      if (decl !== null) own.set(decl[1]!, l.trim());
      else statements.push(l.trim());
    }
    const last = statements.pop();
    if (last === undefined) throw new Error(`a runbook block with nothing to evaluate:\n${block}`);
    const consts = new Map([...this.consts, ...own]);
    const body = [...consts.values(), ...statements, `return (${last.replace(/;\s*$/, '')});`].join('\n');
    for (const [k, v] of own) this.consts.set(k, v);
    say(`console> ${last.slice(0, 160)}`);
    const out = await this.page.evaluate((code) => {
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (body: string) => () => Promise<unknown>;
      return new AsyncFunction(code)();
    }, body);
    say(`console< ${JSON.stringify(out).slice(0, 400)}`);
    return out;
  }
}

/* ── players ─────────────────────────────────────────────────────────── */

function capturePack(page: Page): () => readonly WireCard[] | null {
  let latest: readonly WireCard[] | null = null;
  page.on('websocket', (ws: WebSocket) => {
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string' || !frame.payload.startsWith('42') || !frame.payload.includes('"draft:s2c"')) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(frame.payload.slice(frame.payload.indexOf('[')));
      } catch {
        return; // a torn frame: the next one carries the same state again
      }
      const viewer = (decoded as [string, { view?: { viewer?: { kind?: string; pack?: WireCard[] } } }])[1].view?.viewer;
      if (viewer?.kind === 'seat' && Array.isArray(viewer.pack)) latest = viewer.pack;
    });
  });
  return () => latest;
}

/** A page for `p`: their draft pack read off the wire, and the softlock's filter in front of their socket. */
async function attachPage(p: Player, page: Page): Promise<void> {
  page.setDefaultNavigationTimeout(90_000);
  p.pack = capturePack(page);
  page.on('pageerror', (err) => p.errors.push(`pageerror ${String(err).slice(0, 300)}`));
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (p.dropBars && typeof message === 'string' && message.startsWith('42') && (message.includes('"updateButtons"') || message.includes('"kind":"ask"'))) {
        p.dropped += 1;
        return;
      }
      ws.send(message);
    });
  });
}

async function openPlayer(browser: Browser, name: string): Promise<Player> {
  const f = await openFriend(browser, name);
  const p: Player = {
    f,
    name,
    id: '',
    pack: () => null,
    picks: [],
    policy: 'wait',
    dropBars: false,
    dropped: 0,
    hands: null,
    handsFor: '',
    results: [],
    errors: [],
  };
  await attachPage(p, f.page);
  return p;
}

const RARITY_SCORE: Record<string, number> = {
  mythic: 4,
  rare: 3,
  uncommon: 2,
  common: 1,
};

function topColours(cards: readonly WireCard[]): string[] {
  const counts = new Map<string, number>(['W', 'U', 'B', 'R', 'G'].map((c) => [c, 0]));
  for (const card of cards) if (!/\bLand\b/.test(card.typeLine)) for (const c of card.colors) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([c]) => c);
}

function choosePick(p: Player, pack: readonly WireCard[]): WireCard {
  const pair = topColours(p.picks);
  const score = (card: WireCard): number => {
    let s = RARITY_SCORE[card.rarity ?? 'common'] ?? 1;
    if (/\bCreature\b/.test(card.typeLine)) s += 1;
    if (/\bLand\b/.test(card.typeLine)) s -= 2;
    if (p.picks.length >= 5) s += card.colors.length === 0 ? 0.5 : card.colors.every((c) => pair.includes(c)) ? 4 : -3;
    return s;
  };
  return [...pack].sort((a, b) => score(b) - score(a))[0]!;
}

/**
 * Picks until the draft is done, or until `stop()` says so before a pick: the person who walks away
 * from their pack. Returns whether the draft is done.
 */
async function draft(p: Player, stop: () => boolean = () => false): Promise<boolean> {
  const { page } = p.f;
  const grid = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
  await expect(grid, `${p.name}: the draft is up`).toBeVisible({
    timeout: UI_TIMEOUT,
  });
  if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
  const enabled = '[data-testid="pack"] button[data-testid="card"]:not([disabled])';
  for (;;) {
    const next = await page.waitForFunction(
      (sel) =>
        window.location.hash.startsWith('#/deck/') || document.querySelector('[role="group"][aria-label="Pack layout"]') === null ? 'done' : document.querySelector(sel) !== null ? 'pick' : null,
      enabled,
      { timeout: 5 * 60_000, polling: 100 },
    );
    if ((await next.jsonValue()) === 'done') return true;
    if (stop()) return false;
    const onPage = await page.locator(enabled).evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id') ?? ''));
    const pack = (p.pack() ?? []).filter((c) => onPage.includes(c.cardId));
    const chosen = pack.length > 0 ? choosePick(p, pack) : null;
    const target = chosen === null ? page.locator(enabled).first() : page.locator(`[data-testid="pack"] button[data-testid="card"][data-card-id="${chosen.cardId}"]`);
    const clicked = await target.click({ timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (clicked && chosen !== null) p.picks.push(chosen);
    // Under the server's pick rate limit (15 burst, then one per 250 ms).
    await page.waitForTimeout(450);
  }
}

/** 23 spells in two colours, Auto for the lands, then Play. */
async function build(p: Player, stack: PlayStack): Promise<void> {
  const { page } = p.f;
  await expect(page.getByTestId('deck-editor'), `${p.name}: the finished draft opens the builder`).toBeVisible({ timeout: UI_TIMEOUT });
  const podId = /^#\/deck\/([^/?]+)/.exec(new URL(page.url()).hash)?.[1];
  if (podId === undefined) throw new Error(`${p.name}: the builder's address names no pod: ${page.url()}`);
  const mine = await p.f.context.request.get(`${stack.origin}${PREFIX}/api/drafts/${podId}/mine`);
  expect(mine.status(), `${p.name}: my pool`).toBe(200);
  const pool = ((await mine.json()) as { pool: WireCard[] }).pool;
  const pair = topColours(pool);
  const spells = pool.filter((c) => !/\bLand\b/.test(c.typeLine));
  const rank = (c: WireCard): number =>
    (c.colors.length > 0 && c.colors.every((x) => pair.includes(x)) ? 0 : c.colors.length === 0 ? 1 : 2) * 100 + (/\bCreature\b/.test(c.typeLine) ? 0 : 10) + c.manaValue;
  const keep = new Set(
    [...spells]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 23)
      .map((c) => c.cardId),
  );
  const mainCount = page.getByTestId('main-count');
  for (const card of pool) {
    if (keep.has(card.cardId)) continue;
    const before = Number(await mainCount.textContent());
    const tile = page.locator(`[data-testid="main-grid"] .deck-editor__card[data-name="${card.name.replace(/"/g, '\\"')}"] button[data-testid="card"]`).first();
    if ((await tile.count()) === 0) continue;
    const moved = await tile.click({ position: { x: 20, y: 8 }, timeout: 3_000 }).then(
      () => true,
      () => false,
    );
    if (!moved && Number(await mainCount.textContent()) === before && (await tile.count()) > 0) await tile.dispatchEvent('click', undefined, { timeout: 3_000 });
    await expect(mainCount, `${p.name}: ${card.name} goes to the sideboard`).toHaveText(String(before - 1), { timeout: 5_000 });
  }
  await page.getByTestId('basics-auto').click();
  await expect(mainCount, `${p.name}: 40 cards`).toHaveText('40', {
    timeout: UI_TIMEOUT,
  });
  const play = page.getByTestId('play-deck');
  const t0 = Date.now();
  await expect(play, `${p.name}: Play is offered once the deck checks out`).toBeEnabled({ timeout: 90_000 });
  if (Date.now() - t0 > 20_000) say(`${p.name}: Play was disabled ${Math.round((Date.now() - t0) / 1000)} s after the deck was 40 (verdict ${await play.getAttribute('data-verdict')})`);
  await play.click();
  await page.waitForURL(/\/room\/[^/#]+$/, { timeout: UI_TIMEOUT });
  say(`${p.name}: built in ${pair.join('')}`);
}

/* ── at the table: a person on their own page ────────────────────────── */

interface Look {
  hash: string;
  board: boolean;
  result: string | null;
  enter: boolean;
  next: boolean;
  room: boolean;
  sideboardReady: boolean;
  concede: boolean;
  tablePage: boolean;
  door: string | null;
  lit: boolean;
  says: string;
}

async function look(page: Page): Promise<Look | null> {
  try {
    return await page.evaluate((): Look => {
      const q = (sel: string): Element | null => document.querySelector(sel);
      const usable = (sel: string): boolean => {
        const el = q(sel) as HTMLButtonElement | null;
        return el !== null && !el.disabled && el.getClientRects().length > 0;
      };
      return {
        hash: window.location.hash,
        board: q('[aria-label="Game board"]') !== null,
        result: q('[data-testid="game-result"]')?.getAttribute('data-result') ?? (q('[data-testid="game-result"]') !== null ? '?' : null),
        enter: usable('[data-testid="game-result-enter"]'),
        next: usable('[data-testid="game-result-next"]'),
        room: usable('[data-testid="game-result-room"]'),
        sideboardReady: usable('[data-testid="sideboard-ready"]'),
        concede: usable('[data-testid="live-concede"]'),
        tablePage: q('[data-testid="table-page"]') !== null,
        door: q('a[data-door]')?.getAttribute('data-door') ?? null,
        lit: q('[data-testid="pod-tables-row"][data-call] [data-testid="pod-tables-play"]') !== null,
        says: q('[data-testid="live-says"]')?.textContent ?? '',
      };
    });
  } catch {
    return null; // mid-navigation
  }
}

async function stopHands(p: Player): Promise<void> {
  if (p.hands === null) return;
  await p.hands.close();
  p.hands = null;
}

async function concede(p: Player): Promise<boolean> {
  const { page } = p.f;
  await p.hands?.pause();
  try {
    await page.getByTestId('live-concede').click({ timeout: 3_000 });
    await page.getByTestId('live-concede-yes').click({ timeout: 3_000 });
    return await page
      .getByTestId('live-concede-ask')
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
  } catch {
    return false;
  } finally {
    p.hands?.resume();
  }
}

/** One person, the whole tournament: into each game their page offers, then what their policy says. */
async function atTheTable(p: Player, done: () => boolean): Promise<void> {
  const { page } = p.f;
  let game: {
    hash: string;
    since: number;
    conceded: number | null;
    recorded: boolean;
  } | null = null;
  while (!done()) {
    const s = page.isClosed() ? null : await look(page);
    if (s === null) {
      await sleep(TICK_MS);
      continue;
    }
    if (MATCH_HASH.test(s.hash) && (game === null || game.hash !== s.hash))
      game = {
        hash: s.hash,
        since: Date.now(),
        conceded: null,
        recorded: false,
      };
    if (s.result !== null) {
      await stopHands(p);
      if (game !== null && !game.recorded) {
        game.recorded = true;
        p.results.push(s.result);
        say(`${p.name}: ${s.result} in ${game.hash}`);
      }
      if (p.policy !== 'wait' || !s.enter) {
        if (s.enter)
          await page
            .getByTestId('game-result-enter')
            .click({ timeout: 3_000 })
            .catch(() => undefined);
        else if (s.sideboardReady)
          await page
            .getByTestId('sideboard-ready')
            .click({ timeout: 3_000 })
            .catch(() => undefined);
        else if (s.next)
          await page
            .getByTestId('game-result-next')
            .click({ timeout: 3_000 })
            .catch(() => undefined);
        else if (s.room)
          await page
            .getByTestId('game-result-room')
            .click({ timeout: 3_000 })
            .catch(() => undefined);
      }
    } else if (s.board && game !== null) {
      if (p.policy === 'play' && (p.hands === null || p.handsFor !== game.hash)) {
        await stopHands(p);
        p.hands = await connectHands(p.f, 0, { attack: true });
        p.handsFor = game.hash;
      }
      if (p.policy !== 'play') await stopHands(p);
      if (p.policy !== 'wait') await answerPrompt(page).catch(() => null);
      if (p.policy === 'concede' && s.concede && s.says !== '' && Date.now() - game.since > 4_000 && (game.conceded === null || Date.now() - game.conceded > 20_000)) {
        if (await concede(p)) game.conceded = Date.now();
      }
    } else if (p.policy === 'wait') {
      // Not at the table yet: stays where it is.
    } else if (/\/sideboard$/.test(s.hash)) {
      if (s.sideboardReady)
        await page
          .getByTestId('sideboard-ready')
          .click({ timeout: 3_000 })
          .catch(() => undefined);
      else if (s.door === 'enter')
        await page
          .locator('a[data-door="enter"]')
          .click({ timeout: 3_000 })
          .catch(() => undefined);
    } else if (s.tablePage) {
      if (s.door === 'enter' || s.door === 'sideboard')
        await page
          .locator(`a[data-door="${s.door}"]`)
          .click({ timeout: 3_000 })
          .catch(() => undefined);
    } else if (s.lit) {
      await page
        .locator('[data-testid="pod-tables-row"][data-call] [data-testid="pod-tables-play"]')
        .click({ timeout: 3_000 })
        .catch(() => undefined);
    }
    await sleep(TICK_MS);
  }
  await stopHands(p);
}

/* ── the drill ───────────────────────────────────────────────────────── */

test(titled('fire drill: the tournament runbook, symptom by symptom, in an 8-seat BLB pod of 4 people and 4 bots'), { tag: '@no-retry' }, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(75 * 60_000);
  const stack = await startPlayStack(forge as { jar: string; res: string }, {
    env: { CARDTABLE_PLAY_OVER_GRACE_MS: '30000' },
  });
  const rows: Row[] = [];
  const findings: string[] = [];
  let logSeen = 0;
  let over = false;
  const everyone: Player[] = [];
  try {
    const [alice, bob, carol, drafter3, erin, admin] = await Promise.all(['alice', 'bob', 'carol', 'drafter3', 'erin', 'admin'].map((n) => openPlayer(browser, n)));
    const people = [alice!, bob!, carol!, drafter3!];
    everyone.push(...people, erin!, admin!);
    const op = admin!;
    let roomId = '';
    const roomUrl = (): string => `${stack.origin}${PREFIX}/#/room/${roomId}`;
    const room = async (): Promise<RoomBody> => (await (await op.f.context.request.get(`${stack.origin}${PREFIX}/api/rooms/${roomId}`)).json()) as RoomBody;
    const live = async (): Promise<LiveTable[]> => ((await (await op.f.context.request.get(`${stack.origin}${PREFIX}/api/rooms/${roomId}/admin/live`)).json()) as { tables: LiveTable[] }).tables;
    const nameOf = (id: string): string => everyone.find((p) => p.id === id)?.name ?? (isPodAi(id) ? 'AI' : id);
    const opConsole = new OperatorConsole(op.f.page);

    /** The server's log since the last injection: what an operator reads after each one. */
    const readLog = (label: string): Record<string, unknown>[] => {
      const all = serverLog(stack);
      const since = all.slice(logSeen);
      logSeen = all.length;
      const loud = since.filter((r) =>
        /refused|unanswered|openAsks|admin-act|pick-for|pick-timeout|rope-set|ask-reopened|ask-unclassified|ai-acted-for-seat|snapshot-lossy|game-restored|seat-bot/.test(JSON.stringify(r)),
      );
      say(`log after ${label}: ${since.length} rows; of note ${loud.length}`);
      for (const r of loud.slice(0, 40)) say(`  log ${JSON.stringify(r).slice(0, 300)}`);
      return since;
    };

    const drill = async (symptom: string, step: string, fn: (miss: (line: string) => void) => Promise<void>): Promise<void> => {
      const row: Row = {
        symptom,
        step,
        asWritten: true,
        misses: [],
        ms: 0,
        error: null,
      };
      const t0 = Date.now();
      say(`── ${symptom}: ${step}`);
      try {
        await fn((line) => {
          row.asWritten = false;
          row.misses.push(line);
          say(`MISS ${line}`);
        });
      } catch (err) {
        row.asWritten = false;
        row.error = String(err).split('\n').slice(0, 3).join(' ');
        findings.push(`${symptom}: ${row.error}`);
        say(`FAILED ${symptom}: ${row.error}`);
      }
      row.ms = Date.now() - t0;
      readLog(symptom);
      rows.push(row);
    };

    /** ⋯ on a table card in the bracket, the tool the runbook names, and its confirm if it asks one. Returns the card's error line, if any. */
    const pressTool = async (tableId: string, offer: string): Promise<string | null> => {
      const page = op.f.page;
      const card = page.locator(`[data-testid="pod-tables-row"][data-table-id="${tableId}"]`);
      await expect(card, `the bracket's card for ${tableId}`).toBeVisible({
        timeout: UI_TIMEOUT,
      });
      const more = card.getByTestId('pod-tables-row-more');
      if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
      const tools = page.getByTestId('pod-tables-row-tools');
      await tools.getByRole('menuitem', { name: offer, exact: true }).click({ timeout: UI_TIMEOUT });
      const confirm = tools.locator('.table-card__confirm');
      if (await confirm.isVisible().catch(() => false)) await confirm.locator('[data-testid$="-yes"]').click();
      await expect(confirm).toHaveCount(0, { timeout: START_TIMEOUT });
      const error = await tools
        .getByRole('alert')
        .textContent({ timeout: 2_000 })
        .catch(() => null);
      return error;
    };
    const closeTools = async (): Promise<void> => {
      if (
        await op.f.page
          .getByTestId('pod-tables-row-tools')
          .isVisible()
          .catch(() => false)
      )
        await op.f.page.keyboard.press('Escape');
    };
    /** ⋯'s state rows on a table, as the operator reads them. */
    const readState = async (tableId: string): Promise<string> => {
      const page = op.f.page;
      const more = page.locator(`[data-testid="pod-tables-row"][data-table-id="${tableId}"]`).getByTestId('pod-tables-row-more');
      if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
      const state = page.getByTestId('pod-tables-row-state');
      await expect(state, '⋯ opens on how the match stands').toBeVisible({
        timeout: UI_TIMEOUT,
      });
      const text = (await state.innerText()).replace(/\s+/g, ' ');
      const unshown = await page.getByTestId('pod-tables-row-unshown').allInnerTexts();
      await closeTools();
      return `${text}${unshown.length > 0 ? ` (unshown in danger colour: ${unshown.join(', ')})` : ''}`;
    };

    /* ── the room: BLB · Set-cube, Bots play off, the pick timer left off ── */
    await alice!.f.page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(alice!.f.page, {
      name: `BLB fire drill ${Date.now()}`,
      gameType: 'draft',
    });
    roomId = await roomIdFromAddress(alice!.f.page);
    say(`room ${roomId}`);
    await drill('Before the pod', 'choose the pool a few minutes before Start draft', async () => {
      const page = alice!.f.page;
      await page.getByTestId('pool-picker-tab-set').click();
      await page.getByTestId('pool-picker-sets-BLB').click();
      await page.getByTestId('pool-picker-style-set-cube').click();
      await expect(page.getByTestId('pool-picker-verdict'), 'BLB · Set-cube checks out').toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
      await page.getByTestId('match-rules').click();
      const botsPlay = page.getByTestId('bots-play');
      if ((await botsPlay.getAttribute('aria-pressed')) !== 'false') await botsPlay.click();
      await expect(botsPlay).toHaveAttribute('aria-pressed', 'false', {
        timeout: UI_TIMEOUT,
      });
      await page.getByTestId('match-rules-popover-close').click();
    });

    for (const p of [bob!, carol!, drafter3!, erin!, op]) {
      await p.f.page.goto(roomUrl());
      await expect(p.f.page.getByTestId('draft-lobby'), `${p.name}: in the room`).toBeVisible({ timeout: UI_TIMEOUT });
    }
    const entered = await room();
    for (const p of everyone) {
      const me = entered.members.find((m) => m.name === `e2e-${p.name}`);
      if (me === undefined) throw new Error(`${p.name} is not among the room's members`);
      p.id = me.id;
      const tier = p === op ? 'admin' : p === erin ? 'member' : 'guest';
      await p.f.context.route('**/session/whoami', (route) =>
        route.fulfill({
          json: { valid: true, userId: me.id, userType: tier, name: me.name },
        }),
      );
      await p.f.page.reload();
      await resizeWindow(p.f.page, { width: 1280, height: 800 });
    }

    await drill('An operator not in the room joins it', '"In the lobby, entering seats you: press Stand before anyone readies"', async (miss) => {
      const page = op.f.page;
      await expect(page.locator('[data-testid^="pod-seat-"][data-mine]'), 'entering seated the operator').toHaveCount(1, { timeout: UI_TIMEOUT });
      const stand = page.getByRole('button', {
        name: 'Stand',
        exact: true,
      });
      if ((await stand.count()) === 0) {
        miss('there is no Stand button: the way out of a seat is the spectator row\'s open slot, labelled "Spectate" (seat-stand)');
        await page.getByRole('button', { name: 'Spectate', exact: true }).click();
      } else await stand.click();
      await expect(page.locator('[data-testid^="pod-seat-"][data-mine]'), 'the operator holds no seat').toHaveCount(0, { timeout: UI_TIMEOUT });
    });

    /* the leader's three bots; erin will be the no-show */
    for (let i = 0; i < 3; i++) {
      const seats = (await room()).game.pod?.seats ?? [];
      const open = seats.indexOf(null) === -1 ? seats.length : seats.indexOf(null);
      const ai = alice!.f.page.locator(`[data-testid="pod-seat-ai"][data-seat="${open}"]`);
      await expect(ai, `seat ${open + 1} offers the leader a bot`).toBeVisible({ timeout: UI_TIMEOUT });
      await ai.click();
      await expect.poll(async () => ((await room()).game.pod?.seats ?? []).filter((x) => x !== null && isPodAi(x.memberId)).length, { timeout: UI_TIMEOUT }).toBe(i + 1);
    }
    say(`seats: ${((await room()).game.pod?.seats ?? []).map((x) => (x === null ? '-' : nameOf(x.memberId))).join(' ')}`);
    await Promise.all(people.map((p) => readyPod(p.f.page, 90_000)));

    await drill('No-show before the lock', 'their seat chip → Bot', async () => {
      await sleep(3_000);
      expect((await room()).game.pod?.phase, 'the field waits on the no-show').toBe('lobby');
      const seat = ((await room()).game.pod?.seats ?? []).findIndex((x) => x?.memberId === erin!.id);
      expect(seat, 'erin holds a seat').toBeGreaterThanOrEqual(0);
      await op.f.page.getByTestId(`pod-seat-${seat}`).getByRole('button', { name: /bot/i }).click();
      await expect.poll(async () => isPodAi((await room()).game.pod?.seats[seat]?.memberId ?? ''), { timeout: UI_TIMEOUT, message: "the AI takes erin's seat" }).toBe(true);
      await Promise.all(people.map((p) => expect(p.f.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: 90_000 })));
    });
    await erin!.f.context.close();

    /* ── the draft ── */
    const picksOf = (p: Player): number => p.picks.length;
    let carolHeld = false;
    let carolRelease = false;
    let bobBack = false;
    // Carol's stall waits for bob to be picking again: a seat held still holds every pack behind it, his too.
    let bobPicking = false;
    const drafting = [
      draft(alice!),
      draft(drafter3!),
      // Bob closes his tab after two picks; he comes back once the pod is into pack 2.
      (async () => {
        await draft(bob!, () => picksOf(bob!) >= 2);
        await bob!.f.page.close();
        say('bob closed his tab after 2 picks');
        await expect.poll(() => bobBack, { timeout: 15 * 60_000, intervals: [1_000] }).toBe(true);
        const page = await bob!.f.context.newPage();
        await attachPage(bob!, page);
        bob!.f.page = page;
        await page.goto(roomUrl());
        await draft(bob!);
      })(),
      // Carol stops picking in pack 2, once bob is back, and stays on her page; she picks again when the drill says.
      (async () => {
        const done = await draft(carol!, () => bobPicking && picksOf(carol!) >= 16 && !carolRelease);
        if (done) return;
        carolHeld = true;
        say(`carol stops picking at ${picksOf(carol!)} picks`);
        await expect
          .poll(() => carolRelease, {
            timeout: 15 * 60_000,
            intervals: [1_000],
          })
          .toBe(true);
        await draft(carol!);
      })(),
    ];

    await drill('A drafter stops picking mid-draft (closed the tab)', 'console: the member lookup, then pick-for', async (miss) => {
      await expect.poll(() => bob!.f.page.isClosed(), { timeout: 5 * 60_000 }).toBe(true);
      // The pod waits: the packs pile up at bob's seat, and nobody downstream of him picks again.
      const humanPicks = (): number => serverLog(stack).filter((r) => r.evt === 'pick').length;
      let last = humanPicks();
      let quietSince = Date.now();
      for (const until = Date.now() + 2 * 60_000; Date.now() < until && Date.now() - quietSince < 15_000; await sleep(1_000)) {
        const n = humanPicks();
        if (n !== last) [last, quietSince] = [n, Date.now()];
      }
      if (Date.now() - quietSince < 15_000) miss('the pod did not stop on the closed tab: people kept picking for 2 min');
      else say(`the pod waits on bob's closed tab (${last} human picks, none for 15 s)`);
      if (serverLog(stack).some((r) => r.evt === 'pick-timeout' && r.seat === 1)) miss('the pod did not wait: something already picked for the closed tab');
      // The operator's page is the room; they open the console.
      const lookup = (await opConsole.paste(runbookBlock('.members.map('), {
        'r-xxxxxxxxxxxx': roomId,
      })) as string;
      const line = lookup.split('\n').find((l) => l.startsWith('e2e-bob '));
      if (line === undefined) throw new Error(`the member lookup does not list bob:\n${lookup}`);
      const id = line.trim().split(/\s+/).pop()!;
      expect(id, "the lookup's id is bob's").toBe(bob!.id);
      const answer = (await opConsole.paste(runbookBlock('/draft/pick-for`'), { 'fk:xxxxxxxxxxxxxxxx': id })) as [number, unknown];
      expect(answer, "the runbook's answer: [200, { ok: true }]").toEqual([200, { ok: true }]);
      const before = picksOf(alice!);
      await expect
        .poll(() => picksOf(alice!), {
          timeout: 3 * 60_000,
          message: 'the pod moves on with the bot picking for bob',
        })
        .toBeGreaterThan(before + 3);
      expect(
        serverLog(stack).some((r) => r.evt === 'pick-for' && r.memberId === bob!.id && r.on === true),
        'pick-for is logged',
      ).toBe(true);
    });

    await drill('A drafter comes back', '"it stops by itself when they reconnect"', async () => {
      await expect
        .poll(() => picksOf(alice!), {
          timeout: 10 * 60_000,
          message: 'the pod reaches pack 2',
        })
        .toBeGreaterThanOrEqual(15);
      bobBack = true;
      await expect
        .poll(() => serverLog(stack).some((r) => r.evt === 'pick-for-ended' && r.memberId === bob!.id), {
          timeout: 2 * 60_000,
          message: 'pick-for ends when bob reconnects',
        })
        .toBe(true);
      const at = picksOf(bob!);
      await expect
        .poll(() => picksOf(bob!), {
          timeout: 2 * 60_000,
          message: 'bob picks again himself',
        })
        .toBeGreaterThan(at);
      bobPicking = true;
    });

    await drill('The draft is dealt with the pick timer off and a seat never picks', 'console: pick timer on', async () => {
      await expect.poll(() => carolHeld, { timeout: 10 * 60_000 }).toBe(true);
      await sleep(12_000);
      expect(await alice!.f.page.getByTestId('pick-rope').count(), 'no timer before the command').toBe(0);
      const answer = (await opConsole.paste(runbookBlock('/draft/timer`'), {
        'r-xxxxxxxxxxxx': roomId,
      })) as [number, unknown];
      expect(answer, "the runbook's answer: [200, { ok: true }]").toEqual([200, { ok: true }]);
      const carolSeat = ((await room()).game.pod?.seats ?? []).findIndex((x) => x?.memberId === carol!.id);
      const since = serverLog(stack).length;
      await expect(carol!.f.page.getByTestId('pick-rope'), "the timer is on the stalled seat's screen").toBeVisible({ timeout: 5_000 });
      const seen = await Promise.all(people.map(async (p) => `${p.name} ${(await p.f.page.getByTestId('pick-rope').count()) > 0 ? 'rope' : 'no rope'}`));
      say(`timer on screens 5 s after: ${seen.join(', ')}`);
      const t0 = Date.now();
      await expect
        .poll(() => serverLog(stack).slice(since).filter((r) => r.evt === 'pick-timeout' && r.seat === carolSeat).length, {
          timeout: 6 * 60_000,
          message: "carol's pick falls to the bot when its time runs out",
        })
        .toBeGreaterThanOrEqual(2);
      say(`two timed-out picks in ${Math.round((Date.now() - t0) / 1000)} s at speed 1`);
      carolRelease = true;
    });
    await Promise.all(drafting);
    await Promise.all(people.map((p) => build(p, stack)));

    /* ── round 1 ── */
    let r = await room();
    expect(r.game.pod?.phase, 'the rounds start').toBe('rounds');
    const tableOf = (body: RoomBody, round: number, n: number): { tableId: string; players: Player[] } => {
      const pairing = (body.game.pod?.pairings ?? []).filter((x) => x.players[1] !== null)[n];
      if (pairing === undefined || body.game.pod?.round !== round) throw new Error(`no table ${n} in round ${round}: ${JSON.stringify(body.game.pod?.pairings)}`);
      return {
        tableId: pairing.tableId,
        players: pairing.players.map((id) => everyone.find((p) => p.id === id)!),
      };
    };
    const t1 = tableOf(r, 1, 0);
    const t2 = tableOf(r, 1, 1);
    say(`round 1: ${t1.tableId} ${t1.players.map((p) => p.name).join(' v ')}, ${t2.tableId} ${t2.players.map((p) => p.name).join(' v ')}`);
    const stuck = t1.players[0]!;
    stuck.dropBars = true;
    for (const p of t1.players) p.policy = 'play';
    const agents = people.map((p) => atTheTable(p, () => over));
    await op.f.page.goto(roomUrl());

    await drill('A screen shows nothing to do, but the game does not move', '⋯ → Re-send asks', async (miss) => {
      await expect.poll(async () => (await live()).find((t) => t.tableId === t1.tableId)?.match?.status, { timeout: START_TIMEOUT * 2, message: 'the table starts' }).toBe('running');
      await expect(stuck.f.page.locator('[aria-label="Game board"]'), `${stuck.name}: at the board`).toBeVisible({ timeout: START_TIMEOUT });
      await sleep(20_000);
      expect(stuck.dropped, 'the seat was never shown its bar').toBeGreaterThan(0);
      const before = (await live()).find((t) => t.tableId === t1.tableId)?.match;
      say(`live before: turn ${before?.turn} asks ${JSON.stringify(before?.seats.map((s) => s.asks.map((a) => a.method)))}`);
      say(`⋯ reads: ${await readState(t1.tableId)}`);
      stuck.dropBars = false;
      const error = await pressTool(t1.tableId, 'Re-send asks');
      if (error !== null) throw new Error(`Re-send asks answered: ${error}`);
      await closeTools();
      await expect(stuck.f.page.getByTestId('live-says'), `${stuck.name}: the screen has something to do again`).not.toHaveText('', { timeout: UI_TIMEOUT });
      await expect.poll(async () => (await live()).find((t) => t.tableId === t1.tableId)?.match?.turn ?? 0, { timeout: 4 * 60_000, message: 'the game moves again' }).toBeGreaterThanOrEqual(2);
      const after = await readState(t1.tableId);
      say(`⋯ reads after: ${after}`);
      if (!after.includes('unshown'))
        miss(
          '"a question Forge waited on that the seat had never been shown is named in the danger colour": nothing was, because the server had sent it; the frame was lost after the server (the page). The runbook does not say the mark only covers what the server never sent',
        );
    });

    await drill('A finished match has the wrong result while the round still plays', '⋯ → Match to ‹right player›', async () => {
      const [loser, winner] = t2.players as [Player, Player];
      loser.policy = 'concede';
      winner.policy = 'play';
      await expect
        .poll(async () => (await room()).game.pod?.results.some((x) => x.round === 1 && [x.playerA, x.playerB].includes(loser.id)), {
          timeout: 10 * 60_000,
          message: `${loser.name} concedes the match`,
        })
        .toBe(true);
      winner.policy = 'wait';
      loser.policy = 'wait';
      const wrong = (await room()).game.pod!.results.find((x) => x.round === 1 && [x.playerA, x.playerB].includes(loser.id))!;
      say(`recorded: ${JSON.stringify(wrong)}`);
      expect((await room()).game.pod?.round, 'the round still plays').toBe(1);
      const error = await pressTool(t2.tableId, `Match to e2e-${loser.name}`);
      if (error !== null) throw new Error(`Match to answered: ${error}`);
      await closeTools();
      await expect
        .poll(
          async () => {
            const x = (await room()).game.pod!.results.find((y) => y.round === 1 && [y.playerA, y.playerB].includes(loser.id))!;
            return x.playerA === loser.id ? [x.gamesA, x.gamesB] : [x.gamesB, x.gamesA];
          },
          {
            timeout: UI_TIMEOUT,
            message: 'the result is corrected in place',
          },
        )
        .toEqual([2, 0]);
      const standing = (await room()).game.pod!.standings.find((s) => s.id === loser.id)!;
      expect(standing.matchPoints, 'the standings follow').toBe(3);
    });

    await drill('A game will not move (or a lossy turn)', '⋯ → Restart turn (refused on a lossy turn → Reset game)', async (miss) => {
      const t0 = Date.now();
      let lossy: string[] = [];
      while (Date.now() - t0 < 5 * 60_000) {
        const m = (await live()).find((t) => t.tableId === t1.tableId)?.match;
        lossy = m?.restoreLossy ?? [];
        if (lossy.length > 0 || (m?.turn ?? 0) >= 6) break;
        await sleep(3_000);
      }
      const m = (await live()).find((t) => t.tableId === t1.tableId);
      say(`restarting at turn ${m?.match?.turn}, restore turn ${m?.match?.restoreTurn}, lossy ${JSON.stringify(lossy)}`);
      const epochs = m?.epochs.length ?? 0;
      const error = await pressTool(t1.tableId, 'Restart turn');
      if (lossy.length > 0) {
        if (error === null || !/cannot be restored exactly/.test(error)) throw new Error(`a lossy turn's Restart turn answered ${JSON.stringify(error)}`);
        say(`refused as the runbook says: ${error}`);
        const reset = await pressTool(t1.tableId, 'Reset game');
        if (reset !== null) throw new Error(`Reset game answered: ${reset}`);
      } else {
        miss('no lossy turn reached in this game: the refusal and its Reset game were not exercised here (the plain Restart turn was)');
        if (error !== null) throw new Error(`Restart turn answered: ${error}`);
        await expect
          .poll(async () => (await live()).find((t) => t.tableId === t1.tableId)?.epochs.length ?? 0, {
            timeout: START_TIMEOUT,
            message: 'the game before is kept as a replay',
          })
          .toBe(epochs + 1);
      }
      await closeTools();
      await expect.poll(async () => (await live()).find((t) => t.tableId === t1.tableId)?.match?.status, { timeout: START_TIMEOUT, message: 'the board is back' }).toBe('running');
      const seconds = Math.round((Date.now() - t0) / 1000);
      say(`back in ${seconds} s from the press`);
    });

    // Round 1's last table ends: its first player concedes out.
    t1.players[0]!.policy = 'concede';
    t1.players[1]!.policy = 'play';
    for (const p of t2.players) p.policy = 'concede';
    await expect
      .poll(async () => (await room()).game.pod?.round ?? 0, {
        timeout: 15 * 60_000,
        message: 'round 2 is paired',
      })
      .toBe(2);

    /* ── round 2: a DQ mid-match ── */
    for (const p of people) p.policy = 'wait';
    r = await room();
    const d1 = tableOf(r, 2, 0);
    const d2 = tableOf(r, 2, 1);
    say(`round 2: ${d1.tableId} ${d1.players.map((p) => p.name).join(' v ')}, ${d2.tableId} ${d2.players.map((p) => p.name).join(' v ')}`);
    for (const p of d1.players) p.policy = 'play';
    const dqd = d1.players[0]!;
    await drill('A player must leave the tournament mid-round', '⋯ → DQ ‹player›', async () => {
      await expect.poll(async () => (await live()).find((t) => t.tableId === d1.tableId)?.match?.status, { timeout: START_TIMEOUT * 3, message: 'the match is under way' }).toBe('running');
      await sleep(10_000);
      const error = await pressTool(d1.tableId, `DQ e2e-${dqd.name}`);
      if (error !== null) throw new Error(`DQ answered: ${error}`);
      await closeTools();
      await expect(dqd.f.page.getByTestId('game-result'), `${dqd.name}: the board ends`).toBeVisible({ timeout: UI_TIMEOUT });
      await expect
        .poll(async () => (await room()).game.pod!.results.some((x) => x.round === 2 && [x.playerA, x.playerB].includes(dqd.id)), { timeout: UI_TIMEOUT, message: 'their match is conceded' })
        .toBe(true);
      const body = await room();
      say(`after the DQ: dropped ${JSON.stringify(body.game.pod?.dropped)}`);
      expect(body.game.pod?.dropped ?? [], 'they stay in the standings, marked').toContain(dqd.id);
    });
    for (const p of d2.players) p.policy = 'concede';
    for (const p of d1.players) p.policy = 'concede';

    /* ── to the end ── */
    await expect
      .poll(async () => (await room()).game.pod?.phase, {
        timeout: 25 * 60_000,
        intervals: [5_000],
        message: 'the tournament ends',
      })
      .toBe('done');
    over = true;
    await Promise.all(agents);
    const end = (await room()).game.pod!;
    say(`standings: ${end.standings.map((s) => `${s.rank}. ${nameOf(s.id)} ${s.matchPoints}`).join(', ')}`);
    for (const x of end.results.filter((y) => y.round > 2)) {
      if (x.playerA === dqd.id || x.playerB === dqd.id) {
        const theirs = x.playerA === dqd.id ? [x.gamesA, x.gamesB] : [x.gamesB, x.gamesA];
        if (theirs[0]! > 0 || x.playerB !== null) findings.push(`the DQ'd player played on in round ${x.round}: ${JSON.stringify(x)}`);
      }
    }
    expect(
      end.standings.some((s) => s.id === dqd.id),
      "the DQ'd player stays in the standings",
    ).toBe(true);
  } finally {
    over = true;
    say('┌ the drill');
    say('│ symptom | runbook step | worked as written | time | what was wrong');
    for (const row of rows)
      say(`│ ${row.symptom} | ${row.step} | ${row.asWritten ? 'y' : 'n'} | ${Math.round(row.ms / 1000)} s | ${[...row.misses, ...(row.error === null ? [] : [`FAILED ${row.error}`])].join('; ')}`);
    say('└');
    for (const p of everyone) for (const e of new Set(p.errors)) findings.push(`${p.name} ${e}`);
    for (const p of everyone) if (p.hands !== null) await p.hands.close().catch(() => undefined);
    await stack.stop();
  }
  expect(findings, "the drill's product findings").toEqual([]);
});
