/**
 * A Bloomburrow set-cube draft tournament, end to end, the way Sunday's Draft Major will run it:
 * a draft room's leader picks BLB · Set-cube, sets Bots play, seats the field, and every person in
 * it is a real browser that drafts, builds and plays its tournament the way a person does. Nobody
 * in the field is driven by the server: each player is an agent on its own page, pressing what the
 * page offers (its lit table card, Enter game, the board, Ready on the sideboard step, back to the
 * room), and the room's own AI seats are the only bots.
 *
 * Fields (the operator, 2026-11-26: "try with 7 players 1 bot, 14 players 2 bots, 8 players no
 * bots, 1 player 7 bots … have them play actual games in some and in other have them just give a
 * bye"):
 *
 *  - `7p+1bot bye` — seven people and one bot, Bots play off: the Draft Major's own setting, so the
 *    bot only drafts and an odd person takes the bye each round. Games are played out.
 *  - `14p+2bots` — fourteen people and two bots, split into two pods of eight; a field past one pod
 *    pairs its people alone either way. Games end by concede, so seven tables a round stay cheap.
 *  - `8p` — eight people, no bot. Games are played out.
 *  - `1p+7bots` — one person and seven bots, Bots play on: the person plays a bot every round, and
 *    the bots' own games are played in Forge. Games are played out.
 *  - `1p+7bots bye` — the same field with Bots play off: one person and no one to pair them with.
 *
 * "Played out" is a real game of drafted Bloomburrow cards: each seat plays a land, casts what
 * Forge offers, attacks with everything, and answers every question the board asks
 * (`play/hands.ts` with `attack`, `play/prompts.ts`). The first `realGames` of each series are
 * played out, at no more than `realTables` tables a round (a claw job's memory holds about four
 * live boards); a game still going at `GAME_CAP_MS` is conceded by the seat behind on life. The rest
 * of a series ends by concede, in a fixed pattern per table (2–0 or 2–1), so every series length
 * and the sideboard step between its games are walked.
 *
 * What it looks for: the room's own record after every round (everyone still in plays once or has
 * the bye, the bye only when the field is odd and never twice to one person, no repeat pairing, no
 * bot result when bots don't play), the standings at the end on every page, each page's own
 * errors, the server's own complaints about a match (`ask-unclassified`, `ai-acted-for-seat`,
 * `concede-forced`, a game Forge ended), and a player stranded where the page offers no way on.
 * Every finding is printed as `[tourney] FINDING …` and fails the test at the end, so its
 * evidence (screenshots, the server log) is uploaded.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and
 * the title says why. One scenario per dispatch: `-g "<key>"`.
 */
import { expect, test, type Browser, type Page, type TestInfo, type WebSocket } from '@playwright/test';

import type { DraftCard, PodView } from '../packages/shared/src/index.ts';
import { splitPods } from '../packages/shared/src/index.ts';

import { PREFIX } from './identities.ts';
import { lifeOf, makeTitled, resizeWindow, roomIdFromAddress, serverLog } from './play/board.ts';
import { describePage, openFriend, type Friend } from './play/browser.ts';
import { connectHands, type Hands } from './play/hands.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { readyPod } from './podSeats.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
/** A played-out game still going after this is conceded by the seat behind on life. */
const GAME_CAP_MS = 6 * 60_000;
/** No result, pairing or bot game changing for this long is a stalled tournament. */
const STALL_MS = 10 * 60_000;
const TICK_MS = 400;
const MATCH_HASH = /^#\/match\/(m-[0-9a-f]{12})$/;

interface Scenario {
  key: string;
  humans: number;
  bots: number;
  botsPlay: boolean;
  /** How many games of each series are played out; the rest end by concede. */
  realGames: number;
  /**
   * How many tables a round play their games out; the rest concede. A played-out game keeps two
   * live boards open for minutes, and a claw job's memory ceiling (6.2 GB) holds the server, a
   * Forge JVM and about four of them: seven people at three played-out tables were OOM-killed.
   */
  realTables: number;
  minutes: number;
  /**
   * The play stack's own env. Fourteen browsers and seven tables a round fill a claw's memory
   * cap if every finished game stays on its JVM for play's ten minutes; the monkey keeps one 10 s.
   */
  env?: Record<string, string>;
}

const SCENARIOS: readonly Scenario[] = [
  { key: '7p+1bot bye', humans: 7, bots: 1, botsPlay: false, realGames: 1, realTables: 1, minutes: 42 },
  { key: '14p+2bots', humans: 14, bots: 2, botsPlay: true, realGames: 0, realTables: 0, minutes: 42, env: { CARDTABLE_PLAY_OVER_GRACE_MS: '30000' } },
  { key: '8p', humans: 8, bots: 0, botsPlay: true, realGames: 1, realTables: 1, minutes: 42 },
  { key: '1p+7bots', humans: 1, bots: 7, botsPlay: true, realGames: 3, realTables: 1, minutes: 42 },
  { key: '1p+7bots bye', humans: 1, bots: 7, botsPlay: false, realGames: 0, realTables: 0, minutes: 20 },
];

const NAMES = ['alice', 'bob', 'carol', ...Array.from({ length: 14 }, (_, i) => `drafter${i + 3}`)];

type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'basic';
type WireCard = Pick<DraftCard, 'cardId' | 'name' | 'colors' | 'typeLine' | 'manaValue'> & { rarity?: Rarity };

interface RoomBody {
  you: { id: string };
  members: { id: string; name: string }[];
  game: { pod: PodView | null };
}

interface Player {
  f: Friend;
  name: string;
  id: string;
  /** The last pack the draft socket sent this seat. */
  pack: () => readonly WireCard[] | null;
  picks: WireCard[];
  /** My own result of every game, by table. */
  results: Map<string, ('victory' | 'defeat' | 'draw')[]>;
  /** What this agent did last, for a stall's evidence. */
  last: string;
  lastAt: number;
  errors: string[];
  /** Every place the page went, with the time and what this agent did just before. */
  trail: string[];
  hands: Hands | null;
  handsFor: string;
  /** This page's draft socket, frame by frame (`draftLine`), for a refused pick's evidence. */
  wire: string[];
}

interface Run {
  scenario: Scenario;
  stack: PlayStack;
  roomId: string;
  roomUrl: string;
  players: Player[];
  findings: string[];
  /** The tables that play their games out, by round: at most `realTables` a round, first come. */
  realTables: Map<number, Set<string>>;
  done: boolean;
  info: TestInfo;
}

const say = (line: string): void => console.log(`[tourney] ${line}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function finding(run: Run, line: string): void {
  if (run.findings.includes(line)) return;
  run.findings.push(line);
  say(`FINDING ${line}`);
}

function note(p: Player, what: string): void {
  if (p.last !== what) say(`${p.name}: ${what}`);
  p.last = what;
  p.lastAt = Date.now();
}

const isAi = (id: string): boolean => id === 'ai' || /^ai:\d+$/.test(id);

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

async function roomOf(p: Player, run: Pick<Run, 'stack' | 'roomId'>): Promise<RoomBody> {
  const res = await p.f.context.request.get(`${run.stack.origin}${PREFIX}/api/rooms/${run.roomId}`);
  if (!res.ok()) throw new Error(`${p.name}: GET room ${res.status()}`);
  return (await res.json()) as RoomBody;
}

/** The draft socket's own pack for this seat, newest frame wins. Attached before the page opens a socket. */
/** One draft socket frame, short: when, which way, its kind, and the seat's pack as it stood. */
function draftLine(dir: string, payload: string): string | null {
  if (!payload.startsWith('42') || !payload.includes('"draft:')) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.slice(payload.indexOf('[')));
  } catch {
    return null;
  }
  const body = (decoded as [string, Record<string, unknown>])[1] ?? {};
  const view = body.view as { seq?: number; viewer?: { kind?: string; pack?: { cardId: string }[]; packNumber?: number; pickNumber?: number } } | undefined;
  const pack = view?.viewer?.pack;
  const packText = Array.isArray(pack) ? `pack ${pack.length} [${pack.slice(0, 3).map((c) => c.cardId).join(' ')}${pack.length > 3 ? ' …' : ''}]` : '';
  const rest = Object.entries(body)
    .filter(([k]) => k !== 'view')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v)}`)
    .join(' ');
  return `${new Date().toISOString().slice(11, 23)} ${dir} ${rest} ${view?.seq === undefined ? '' : `seq ${view.seq}`} ${packText}`.trim();
}

function capturePack(page: Page, wire: string[]): () => readonly WireCard[] | null {
  let latest: readonly WireCard[] | null = null;
  page.on('websocket', (ws: WebSocket) => {
    ws.on('framesent', (frame) => {
      const line = typeof frame.payload === 'string' ? draftLine('→', frame.payload) : null;
      if (line !== null) wire.push(line);
    });
    ws.on('framereceived', (frame) => {
      const line = typeof frame.payload === 'string' ? draftLine('←', frame.payload) : null;
      if (line !== null) wire.push(line);
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

async function openPlayer(browser: Browser, name: string): Promise<Player> {
  const f = await openFriend(browser, name);
  const wire: string[] = [];
  const p: Player = { f, name, id: '', wire, pack: capturePack(f.page, wire), picks: [], results: new Map(), last: '', lastAt: Date.now(), errors: [], trail: [], hands: null, handsFor: '' };
  f.page.on('framenavigated', (frame) => {
    if (frame !== f.page.mainFrame()) return;
    const hash = new URL(frame.url()).hash;
    p.trail.push(`${new Date().toISOString().slice(11, 19)} ${hash === '' ? '(no hash)' : hash} after "${p.last.slice(0, 60)}"`);
    if (p.trail.length > 30) p.trail.shift();
  });
  f.page.on('pageerror', (err) => p.errors.push(`pageerror ${String(err).slice(0, 300)}`));
  f.page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Art leaves 127.0.0.1 and is refused by this harness on purpose (`play/browser.ts`).
    if (/ERR_BLOCKED_BY_CLIENT|Failed to load resource/.test(text)) return;
    p.errors.push(`console.error ${text.slice(0, 300)}`);
  });
  return p;
}

/* ── the draft: a person's picks, by colour ─────────────────────────── */

const RARITY_SCORE: Record<string, number> = { mythic: 4, rare: 3, uncommon: 2, common: 1 };
const COLOURS = ['W', 'U', 'B', 'R', 'G'] as const;

function topColours(cards: readonly WireCard[]): string[] {
  const counts = new Map<string, number>(COLOURS.map((c) => [c, 0]));
  for (const card of cards) if (!/\bLand\b/.test(card.typeLine)) for (const c of card.colors) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
}

/** A drafter's pick: the best card early, then the best card in their two colours. Each player leans a little differently. */
function choosePick(p: Player, pack: readonly WireCard[]): WireCard {
  const lean = (hash32(p.name) % 100) / 100;
  const pair = topColours(p.picks);
  const committed = p.picks.length >= 5;
  const score = (card: WireCard): number => {
    let s = RARITY_SCORE[card.rarity ?? 'common'] ?? 1;
    if (/\bCreature\b/.test(card.typeLine)) s += 1 + lean;
    if (/\bLand\b/.test(card.typeLine)) s -= 2;
    if (committed) s += card.colors.length === 0 ? 0.5 : card.colors.every((c) => pair.includes(c)) ? 4 : -3;
    // A stable tiebreak per player and card, so two players at one table differ.
    return s + (hash32(`${p.name}:${card.cardId}`) % 1000) / 1000;
  };
  return [...pack].sort((a, b) => score(b) - score(a))[0]!;
}

async function draft(p: Player): Promise<void> {
  const { page } = p.f;
  const grid = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
  await expect(grid, `${p.name}: the draft is up`).toBeVisible({ timeout: UI_TIMEOUT });
  if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
  const enabled = '[data-testid="pack"] button[data-testid="card"]:not([disabled])';
  for (;;) {
    const next = await page.waitForFunction(
      // Done: the builder, or the draft screen gone (a field that ends at the draft stays in the room).
      (sel) => (window.location.hash.startsWith('#/deck/') || document.querySelector('[role="group"][aria-label="Pack layout"]') === null ? 'done' : document.querySelector(sel) !== null ? 'pick' : null),
      enabled,
      { timeout: 3 * 60_000, polling: 100 },
    );
    if ((await next.jsonValue()) === 'done') break;
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
  note(p, `drafted ${p.picks.length} picks seen, colours ${topColours(p.picks).join('')}`);
}

/* ── building: 23 spells in two colours, Auto for the lands ──────────── */

/** One pass of a person's build; returns what the builder showed after it settled. */
async function buildOnce(p: Player, run: Run, podId: string, pool: readonly WireCard[]): Promise<{ main: number; basics: number; remounted: boolean; trail: string[] }> {
  const { page } = p.f;
  const pair = topColours(pool);
  const spells = pool.filter((c) => !/\bLand\b/.test(c.typeLine));
  const rank = (c: WireCard): number =>
    (c.colors.length > 0 && c.colors.every((x) => pair.includes(x)) ? 0 : c.colors.length === 0 ? 1 : 2) * 100 + (/\bCreature\b/.test(c.typeLine) ? 0 : 10) + c.manaValue;
  const keep = new Set([...spells].sort((a, b) => rank(a) - rank(b)).slice(0, 23).map((c) => c.cardId));
  const mainCount = page.getByTestId('main-count');
  const editor = page.getByTestId('deck-editor');
  // A mark on the editor's own node: a remount drops it.
  await editor.evaluate((el) => el.setAttribute('data-tourney-mark', '1'));
  const t0 = Date.now();
  const trail: string[] = [];
  const stamp = async (what: string): Promise<void> => {
    trail.push(`+${Date.now() - t0}ms ${what}: main ${await mainCount.textContent().catch(() => '?')} mark ${(await page.locator('[data-tourney-mark]').count()) > 0} save ${await editor.getAttribute('data-save').catch(() => '?')} at ${new URL(page.url()).hash}`);
  };
  await stamp('open');
  for (const card of pool) {
    if (keep.has(card.cardId)) continue;
    const before = Number(await mainCount.textContent());
    // The editor numbers its own tiles (`w0`, `w1`, …): a card is found by its name, any copy of it.
    const tile = page.locator(`[data-testid="main-grid"] .deck-editor__card[data-name="${card.name.replace(/"/g, '\\"')}"] button[data-testid="card"]`).first();
    if ((await tile.count()) === 0) {
      trail.push(`no tile for ${card.name} in the deck`);
      continue;
    }
    // A pile overlaps its cards: the top strip of each one is what shows.
    const moved = await tile.click({ position: { x: 20, y: 8 }, timeout: 3_000 }).then(
      () => true,
      () => false,
    );
    // A click can move the card and still time out waiting on the tile it moved: count before pressing again.
    if (!moved && Number(await mainCount.textContent()) === before && (await tile.count()) > 0) await tile.dispatchEvent('click', undefined, { timeout: 3_000 });
    await expect(mainCount, `${p.name}: ${card.name} goes to the sideboard`).toHaveText(String(before - 1), { timeout: 5_000 });
  }
  await stamp('sideboarded');
  await page.getByTestId('basics-auto').click();
  await stamp('auto');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    await stamp(`settle ${i}`);
  }
  const basics = await page.locator('[data-testid^="basic-"][data-testid$="-count"]').evaluateAll((els) => els.reduce((n, e) => n + Number(e.textContent ?? 0), 0));
  return { main: Number(await mainCount.textContent()), basics, remounted: (await page.locator('[data-tourney-mark]').count()) === 0, trail };
}

/** 23 spells in two colours and Auto for the lands, as a person builds; then Play. */
async function build(p: Player, run: Run): Promise<void> {
  const { page } = p.f;
  await expect(page.getByTestId('deck-editor'), `${p.name}: the finished draft opens the builder`).toBeVisible({ timeout: UI_TIMEOUT });
  const podId = /^#\/deck\/([^/?]+)/.exec(new URL(page.url()).hash)?.[1];
  if (podId === undefined) throw new Error(`${p.name}: the builder's address names no pod: ${page.url()}`);
  const mine = await p.f.context.request.get(`${run.stack.origin}${PREFIX}/api/drafts/${podId}/mine`);
  expect(mine.status(), `${p.name}: my pool`).toBe(200);
  const pool = ((await mine.json()) as { pool: WireCard[] }).pool;
  let built = await buildOnce(p, run, podId, pool);
  if (built.main !== 40 || built.basics < 15 || built.remounted) {
    finding(run, `${p.name}: the builder lost a finished build (main ${built.main}, basics ${built.basics}, remounted ${built.remounted}):\n    ${built.trail.join('\n    ')}`);
    // A person whose build vanished builds it again.
    built = await buildOnce(p, run, podId, pool);
    if (built.main !== 40 || built.basics === 0) finding(run, `${p.name}: the second build was lost too (main ${built.main}, basics ${built.basics}):\n    ${built.trail.join('\n    ')}`);
  }
  note(p, `built ${built.main} (${built.basics} basics) in ${topColours(pool).join('')}`);
  await page.getByTestId('play-deck').click();
  await page.waitForURL(/\/room\/[^/#]+$/, { timeout: UI_TIMEOUT });
  const dck = ((await (await p.f.context.request.get(`${run.stack.origin}${PREFIX}/api/drafts/${podId}/mine`)).json()) as { deck: string | null }).deck ?? '';
  const lands = [...dck.matchAll(/^(\d+)\s+(Plains|Island|Swamp|Mountain|Forest)\b/gm)].reduce((n, m) => n + Number(m[1]), 0);
  if (lands === 0) finding(run, `${p.name}: Play seated a build with no basics; the server holds:\n${dck.slice(0, 600)}`);
}

/* ── the tournament: a person on their own page ──────────────────────── */

interface Look {
  hash: string;
  /** On the room page itself: its path, with no table in the hash. */
  onRoom: boolean;
  board: boolean;
  result: string | null;
  /** The result screen's own words on how the game ended. */
  ending: string;
  enter: boolean;
  next: boolean;
  room: boolean;
  sideboardReady: boolean;
  /** The sideboard step is up: Ready pressed, it waits for the other seat. */
  sideboardStep: boolean;
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
        // A room is its PATH, `room/<id>` (`packages/game-ui/src/screens/route.ts`); its tables are the hash.
        onRoom: /\/room\/[^/]+\/?$/.test(window.location.pathname) && window.location.hash.length <= 2,
        board: q('[aria-label="Game board"]') !== null,
        result: q('[data-testid="game-result"]')?.getAttribute('data-result') ?? (q('[data-testid="game-result"]') !== null ? '?' : null),
        ending: (q('[data-testid="game-result"] .live__result-ending')?.textContent ?? q('[data-testid="game-result"] h2')?.textContent ?? '').trim(),
        enter: usable('[data-testid="game-result-enter"]'),
        next: usable('[data-testid="game-result-next"]'),
        room: usable('[data-testid="game-result-room"]'),
        sideboardReady: usable('[data-testid="sideboard-ready"]'),
        sideboardStep: q('[data-testid="sideboard-step"]') !== null,
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

interface Seat {
  tableId: string;
  opponent: string;
  round: number;
}

/** Whether this table plays its games out: it already does, or its round has a place left. */
function playsOut(run: Run, seat: Seat): boolean {
  const tables = run.realTables.get(seat.round) ?? new Set<string>();
  run.realTables.set(seat.round, tables);
  if (tables.has(seat.tableId)) return true;
  if (tables.size >= run.scenario.realTables) return false;
  tables.add(seat.tableId);
  return true;
}

async function mySeat(p: Player, run: Run): Promise<Seat | null> {
  const body = await roomOf(p, run);
  const pairing = body.game.pod?.pairings.find((x) => x.players.includes(p.id));
  if (pairing === undefined) return null;
  return { tableId: pairing.tableId, opponent: pairing.players.find((x) => x !== p.id) ?? '', round: body.game.pod?.round ?? 0 };
}

/**
 * Who gives this game up when it is not played out. A table's pattern is 2–0 or 2–1, by its id:
 * level, the higher id concedes; otherwise 2–0's trailing player concedes again, 2–1's leader
 * gives one back. Both seats reach the same answer from their own results. A bot never concedes.
 */
function concedes(p: Player, seat: Seat, mine: readonly string[]): boolean {
  if (isAi(seat.opponent)) return true;
  const won = mine.filter((r) => r === 'victory').length;
  const lost = mine.filter((r) => r === 'defeat').length;
  const higher = p.id > seat.opponent;
  if (won === lost) return higher;
  const twoOne = hash32(seat.tableId) % 2 === 1;
  return twoOne ? won > lost : won < lost;
}

async function concede(p: Player, run: Run, why: string): Promise<boolean> {
  const { page } = p.f;
  note(p, `concedes: ${why}`);
  try {
    await page.getByTestId('live-concede').click({ timeout: 3_000 });
    await page.getByTestId('live-concede-yes').click({ timeout: 3_000 });
    // Concede closes its own sheet as it sends (`LiveBoard`'s `ConcedeAsk`): one still open was not sent.
    const open = await page.getByTestId('live-concede-ask').waitFor({ state: 'hidden', timeout: 2_000 }).then(
      () => false,
      () => true,
    );
    if (open) {
      finding(run, `${p.name}: the Concede sheet stayed open after Concede was pressed (${page.url()})`);
      await page.getByTestId('live-concede-no').click({ timeout: 2_000 }).catch(() => undefined);
      return false;
    }
    return true;
  } catch (err) {
    note(p, `concede did not land: ${String(err).split('\n')[0]}`);
    return false;
  }
}

async function stopHands(p: Player): Promise<void> {
  if (p.hands === null) return;
  await p.hands.close();
  p.hands = null;
}

async function playTournament(p: Player, run: Run): Promise<void> {
  const { page } = p.f;
  let game: { hash: string; seat: Seat | null; since: number; concededAt: number | null; real: boolean; conceded: boolean; recorded: boolean } | null = null;
  let idleSince = Date.now();
  while (!run.done) {
    const s = await look(page);
    if (s === null) {
      await sleep(TICK_MS);
      continue;
    }
    let acted = true;
    const match = MATCH_HASH.exec(s.hash);
    if (match !== null && (game === null || game.hash !== s.hash)) {
      const seat = await mySeat(p, run).catch(() => null);
      const played = seat === null ? 0 : (p.results.get(seat.tableId) ?? []).length;
      game = { hash: s.hash, seat, since: Date.now(), concededAt: null, real: played < run.scenario.realGames && seat !== null && playsOut(run, seat), conceded: false, recorded: false };
      note(p, `game ${played + 1} at ${seat?.tableId ?? '?'} vs ${seat?.opponent ?? '?'} (${game.real ? 'played out' : 'conceded'}) ${s.hash}`);
    }
    if (s.result !== null) {
      if (p.hands !== null && game !== null && !game.recorded) say(`${p.name}: the hands' last acts in ${game.hash}:\n  ${p.hands.log.slice(-8).join('\n  ')}`);
      await stopHands(p);
      if (game !== null && !game.recorded && game.seat !== null) {
        game.recorded = true;
        const mine = p.results.get(game.seat.tableId) ?? [];
        mine.push(s.result === 'victory' ? 'victory' : s.result === 'defeat' ? 'defeat' : 'draw');
        p.results.set(game.seat.tableId, mine);
        note(p, `result ${s.result} at ${game.seat.tableId} after ${Math.round((Date.now() - game.since) / 1000)} s, "${s.ending}" (${mine.join(',')})`);
      }
      if (s.enter) await page.getByTestId('game-result-enter').click({ timeout: 3_000 }).catch(() => undefined);
      else if (s.sideboardReady) await page.getByTestId('sideboard-ready').click({ timeout: 3_000 }).catch(() => undefined);
      else if (s.next) await page.getByTestId('game-result-next').click({ timeout: 3_000 }).catch(() => undefined);
      else if (s.sideboardStep) acted = false;
      else if (s.room) await page.getByTestId('game-result-room').click({ timeout: 3_000 }).catch(() => undefined);
      else acted = false;
    } else if (s.board && game !== null) {
      if (p.hands === null || p.handsFor !== game.hash) {
        await stopHands(p);
        p.hands = await connectHands(p.f, 0, { attack: true });
        p.handsFor = game.hash;
      }
      await answerPrompt(page).catch(() => null);
      const age = Date.now() - game.since;
      // A concede the page took that never ended the game: say so, with when, and give up again.
      if (game.conceded && game.concededAt !== null && s.result === null && Date.now() - game.concededAt > 20_000) {
        finding(run, `${p.name}: conceded at ${new Date(game.concededAt).toISOString().slice(11, 23)} in ${game.hash} and the game went on 20 s`);
        game.conceded = false;
        game.concededAt = null;
      }
      if (!game.conceded && s.concede && game.seat !== null && s.says !== '') {
        const mine = p.results.get(game.seat.tableId) ?? [];
        if (!game.real) {
          if (age > 4_000 && concedes(p, game.seat, mine)) {
            game.conceded = await concede(p, run, 'a conceded game');
            if (game.conceded) game.concededAt = Date.now();
          }
        } else if (age > GAME_CAP_MS) {
          const me = Number(await lifeOf(page, 'me').textContent({ timeout: 1_000 }).catch(() => 'NaN'));
          const opp = Number(await lifeOf(page, 'opp').textContent({ timeout: 1_000 }).catch(() => 'NaN'));
          const behind = me < opp || (me === opp && concedes(p, game.seat, mine)) || (isAi(game.seat.opponent) && age > 2 * GAME_CAP_MS);
          if (behind) {
            game.conceded = await concede(p, run, `the cap: life ${me} to ${opp} on "${s.says.slice(0, 60)}"`);
            if (game.conceded) game.concededAt = Date.now();
          }
        }
      }
    } else if (/\/sideboard$/.test(s.hash)) {
      if (s.sideboardReady) await page.getByTestId('sideboard-ready').click({ timeout: 3_000 }).catch(() => undefined);
      else if (s.enter) await page.getByTestId('game-result-enter').click({ timeout: 3_000 }).catch(() => undefined);
      else if (s.door === 'enter') await page.locator('a[data-door="enter"]').click({ timeout: 3_000 }).catch(() => undefined);
      else acted = false;
    } else if (s.tablePage) {
      if (s.door === 'enter' || s.door === 'sideboard') await page.locator(`a[data-door="${s.door}"]`).click({ timeout: 3_000 }).catch(() => undefined);
      else acted = false;
    } else if (s.lit) {
      note(p, 'presses my lit table');
      await page.locator('[data-testid="pod-tables-row"][data-call] [data-testid="pod-tables-play"]').click({ timeout: 3_000 }).catch(() => undefined);
    } else {
      acted = false;
    }
    if (acted) idleSince = Date.now();
    else if (Date.now() - idleSince > 3 * 60_000 && !s.onRoom) {
      // A person left on a screen with nothing to press goes back to the room.
      finding(run, `${p.name} stranded 3 min at ${s.hash === "" ? "(no hash)" : s.hash} (board ${s.board}, result ${s.result}, door ${s.door}, says "${s.says.slice(0, 80)}"); how it got there:\n    ${p.trail.slice(-8).join('\n    ')}`);
      await page.goto(run.roomUrl).catch(() => undefined);
      idleSince = Date.now();
    }
    await sleep(TICK_MS);
  }
  await stopHands(p);
}

/* ── the room's own record, checked every round ─────────────────────── */

function checkRounds(run: Run, pod: PodView, humans: ReadonlySet<string>): void {
  const seen = new Set<string>();
  const byes = new Map<string, number>();
  const rounds = new Map<number, typeof pod.results>();
  for (const r of pod.results) rounds.set(r.round, [...(rounds.get(r.round) ?? []), r]);
  for (const [round, results] of rounds) {
    // Only a finished round: one still playing has results for its finished tables alone.
    if (pod.phase !== 'done' && round >= pod.round) continue;
    const playing = new Map<string, number>();
    for (const r of results) {
      for (const id of [r.playerA, r.playerB]) if (id !== null) playing.set(id, (playing.get(id) ?? 0) + 1);
      if (r.playerB === null) byes.set(r.playerA, (byes.get(r.playerA) ?? 0) + 1);
      else {
        const key = [r.playerA, r.playerB].sort().join(' v ');
        if (seen.has(key)) finding(run, `round ${round}: ${key} met before`);
        seen.add(key);
      }
      if (!run.scenario.botsPlay || run.scenario.humans + run.scenario.bots > 8) {
        if ([r.playerA, r.playerB].some((id) => id !== null && isAi(id))) finding(run, `round ${round}: a bot result with bots off: ${JSON.stringify(r)}`);
      }
    }
    for (const [id, n] of playing) if (n > 1) finding(run, `round ${round}: ${id} has ${n} results`);
    const dropped = new Set(pod.dropped ?? []);
    for (const id of humans) if (!playing.has(id) && !dropped.has(id)) finding(run, `round ${round}: ${id} neither played nor had the bye`);
  }
  for (const [id, n] of byes) if (n > 1) finding(run, `${id} had the bye ${n} times`);
}

async function screenshotAll(run: Run, label: string): Promise<void> {
  for (const p of run.players) {
    const body = await p.f.page.screenshot({ fullPage: false }).catch(() => null);
    if (body !== null) await run.info.attach(`${label}-${p.name}.png`, { body, contentType: 'image/png' });
  }
}

/** Watches the room until its tournament is done, checking each round as it lands. */
async function watchRoom(run: Run, humans: ReadonlySet<string>, deadline: number): Promise<PodView> {
  const leader = run.players[0]!;
  let signature = '';
  let changedAt = Date.now();
  let round = 0;
  for (;;) {
    const pod = (await roomOf(leader, run)).game.pod;
    if (pod === null) throw new Error('the room lost its pod');
    const sig = JSON.stringify([pod.phase, pod.round, pod.results.length, pod.pairings, pod.botGames ?? [], pod.bye]);
    if (sig !== signature) {
      signature = sig;
      changedAt = Date.now();
      say(`room: ${pod.phase} round ${pod.round}/${pod.rounds}, ${pod.results.length} results, pairings ${pod.pairings.map((x) => x.players.join('–')).join(' ')}${pod.bye === null ? '' : `, bye ${pod.bye}`}${(pod.botGames ?? []).length > 0 ? `, ${(pod.botGames ?? []).length} bot game(s)` : ''}`);
      checkRounds(run, pod, humans);
      if (pod.round !== round) {
        round = pod.round;
        await screenshotAll(run, `round-${round}`);
      }
    }
    if (pod.phase === 'done') return pod;
    if (Date.now() - changedAt > STALL_MS) {
      for (const p of run.players) say(`stall: ${p.name} last "${p.last}" ${Math.round((Date.now() - p.lastAt) / 1000)} s ago\n${describePage(p.f)}${p.hands === null ? '' : `\n  hands: ${p.hands.log.slice(-25).join('\n  ')}`}`);
      await screenshotAll(run, 'stall');
      throw new Error(`the tournament stalled ${STALL_MS / 60_000} min at round ${pod.round}: ${sig}`);
    }
    if (Date.now() > deadline) {
      await screenshotAll(run, 'deadline');
      throw new Error(`the tournament ran past its deadline at round ${pod.round}/${pod.rounds}: ${sig}`);
    }
    await sleep(3_000);
  }
}

/** The server's own complaints about any match of this run. */
function serverFindings(run: Run): void {
  const rows = serverLog(run.stack);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(String(row.evt ?? row.event ?? '?'), (counts.get(String(row.evt ?? row.event ?? '?')) ?? 0) + 1);
  say(`server events: ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}×${n}`).join(' ')}`);
  const bad = new Set(['ask-unclassified', 'ai-acted-for-seat', 'concede-forced', 'match-failed', 'match-crashed', 'jvm-exit', 'uncaught', 'unhandled-rejection']);
  for (const row of rows) {
    const evt = String(row.evt ?? row.event ?? '');
    // The harness's own state dir has no presets file: the stack's, not the product's.
    if (evt === 'presets-load-failed' && /ENOENT/.test(String(row.detail))) continue;
    if (bad.has(evt) || row.level === 'error' || /error|crash|fail/i.test(evt)) finding(run, `server ${evt}: ${JSON.stringify(row).slice(0, 400)}`);
  }
  // A pick the page offered and the server refused: the passed pack still drawn, pickable, while the next one comes.
  const refused = new Map<string, string[]>();
  for (const row of rows) if (row.evt === 'pick-rejected') refused.set(String(row.participantId), [...(refused.get(String(row.participantId)) ?? []), String(row.reason)]);
  for (const [id, reasons] of refused) {
    const p = run.players.find((x) => x.id === id);
    finding(run, `${p?.name ?? id}: ${reasons.length} pick(s) the page offered were refused (${[...new Set(reasons)].join(', ')})`);
    // The socket around the first refusals: what the page had been sent when it offered the card.
    const at = (p?.wire ?? []).flatMap((line, i) => (/reject|error|reason=/i.test(line) ? [i] : [])).slice(0, 3);
    for (const i of at) say(`${p?.name}: the draft socket before refusal:\n  ${p!.wire.slice(Math.max(0, i - 6), i + 2).join('\n  ')}`);
    if (at.length === 0) say(`${p?.name}: no refusal on the draft socket's ${p?.wire.length ?? 0} frame(s); its last:\n  ${(p?.wire ?? []).slice(-6).join('\n  ')}`);
  }
}

/* ── one scenario ────────────────────────────────────────────────────── */

async function runScenario(browser: Browser, scenario: Scenario, info: TestInfo): Promise<void> {
  const started = Date.now();
  const stack = await startPlayStack(forge as { jar: string; res: string }, { env: scenario.env ?? {} });
  const run: Run = { scenario, stack, roomId: '', roomUrl: '', players: [], findings: [], realTables: new Map(), done: false, info };
  try {
    const players = await Promise.all(NAMES.slice(0, scenario.humans).map((n) => openPlayer(browser, n)));
    run.players = players;
    const leader = players[0]!;

    /* the leader makes the room: BLB · Set-cube, Bots play as the scenario has it */
    await leader.f.page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(leader.f.page, { name: `BLB ${scenario.key} ${Date.now()}`, gameType: 'draft' });
    run.roomId = await roomIdFromAddress(leader.f.page);
    run.roomUrl = `${stack.origin}${PREFIX}/#/room/${run.roomId}`;
    say(`${scenario.key}: room ${run.roomId}`);
    await leader.f.page.getByTestId('pool-picker-tab-set').click();
    await leader.f.page.getByTestId('pool-picker-sets-BLB').click();
    await leader.f.page.getByTestId('pool-picker-style-set-cube').click();
    await expect(leader.f.page.getByTestId('pool-picker-verdict'), 'BLB · Set-cube checks out').toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
    await leader.f.page.getByTestId('match-rules').click();
    const botsPlay = leader.f.page.getByTestId('bots-play');
    if ((await botsPlay.getAttribute('aria-pressed')) !== String(scenario.botsPlay)) await botsPlay.click();
    await expect(botsPlay, `Bots play ${scenario.botsPlay ? 'on' : 'off'}`).toHaveAttribute('aria-pressed', String(scenario.botsPlay), { timeout: UI_TIMEOUT });
    await leader.f.page.getByTestId('match-rules-popover-close').click();

    /* the field arrives: each person opens the room's link and is seated by entering */
    for (const p of players.slice(1)) {
      await p.f.page.goto(run.roomUrl);
      await expect(p.f.page.getByTestId('draft-lobby'), `${p.name}: in the room`).toBeVisible({ timeout: UI_TIMEOUT });
    }
    const entered = await roomOf(leader, run);
    for (const p of players) {
      const me = entered.members.find((m) => m.name === `e2e-${p.name}`);
      if (me === undefined) throw new Error(`${p.name} is not among the room's members`);
      p.id = me.id;
      // "Which seat is mine" reads whoami, which this edge does not serve.
      await p.f.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: `e2e-${p.name}` } }));
      await p.f.page.reload();
      await resizeWindow(p.f.page, { width: 1280, height: 800 });
    }
    // Entering seats a person up to eight; past that they arrive among the spectators and press Sit on the seat their page adds.
    for (const p of players) {
      const mine = p.f.page.locator('[data-testid^="pod-seat-"][data-mine]');
      await expect(mine.or(p.f.page.locator('[data-testid="room-spectator"][data-mine]')), `${p.name}: in the room, seated or watching`).toHaveCount(1, { timeout: UI_TIMEOUT });
      if ((await mine.count()) > 0) continue;
      const sit = p.f.page.locator('[data-testid="pod-seat-sit"]:not([disabled])').first();
      await expect(sit, `${p.name}: a seat to sit in`).toBeVisible({ timeout: UI_TIMEOUT });
      await sit.click();
      await expect(mine, `${p.name}: seated by Sit`).toHaveCount(1, { timeout: UI_TIMEOUT });
      note(p, 'sat down from the spectators');
    }

    /* the leader's bots, one press each */
    const botCount = async (): Promise<number> => ((await roomOf(leader, run)).game.pod?.seats ?? []).filter((x) => x !== null && isAi(x.memberId)).length;
    for (let i = 0; i < scenario.bots; i++) {
      // The open seat the room names, not the first AI button drawn: the page can still be drawing the last one.
      const seats = (await roomOf(leader, run)).game.pod?.seats ?? [];
      const open = seats.indexOf(null) === -1 ? seats.length : seats.indexOf(null);
      const ai = leader.f.page.locator(`[data-testid="pod-seat-ai"][data-seat="${open}"]`);
      await expect(ai, `seat ${open + 1} offers the leader a bot`).toBeVisible({ timeout: UI_TIMEOUT });
      await ai.click();
      await expect.poll(botCount, { timeout: UI_TIMEOUT, message: `bot ${i + 1} is seated` }).toBe(i + 1);
      await expect(ai, `seat ${open + 1} is the bot's`).toHaveCount(0, { timeout: UI_TIMEOUT });
    }
    const seated = (await roomOf(leader, run)).game.pod?.seats ?? [];
    say(`seats: ${seated.map((x) => (x === null ? '-' : isAi(x.memberId) ? 'AI' : (players.find((p) => p.id === x.memberId)?.name ?? x.memberId))).join(' ')}`);
    // A room of eight or fewer with an open seat never deals: close what nobody holds.
    if (scenario.humans + scenario.bots < 8) {
      for (let seat = 0; seat < 8; seat++) if (seated[seat] === null) await leader.f.page.locator(`[data-testid="pod-seat-close"][data-seat="${seat}"]`).click();
    }

    /* everyone ready; past eight, the leader splits and starts */
    await Promise.all(players.map((p) => readyPod(p.f.page, 90_000)));
    if (scenario.humans + scenario.bots > 8) {
      await expect(leader.f.page.getByTestId('pod-split'), 'the leader can split a ready room').toBeVisible({ timeout: UI_TIMEOUT });
      await leader.f.page.getByTestId('pod-split').click();
      await expect(leader.f.page.getByTestId('pod-split-pods')).toBeVisible({ timeout: UI_TIMEOUT });
      const pods = (await roomOf(leader, run)).game.pod?.pods ?? [];
      say(`pods: ${pods.map((pod) => `[${pod.map((id) => (isAi(id) ? 'AI' : (players.find((p) => p.id === id)?.name ?? id))).join(' ')}]`).join(' ')}`);
      // The people split as evenly as they go and the bots are spread across the pods (`splitPods`, the operator 2026-11-23).
      expect(pods.map((pod) => pod.length), 'the people split evenly').toEqual(splitPods(scenario.humans));
      await leader.f.page.getByTestId('pod-split-start').click();
    }

    /* draft and build, every person at once */
    await Promise.all(players.map((p) => expect(p.f.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: 90_000 })));
    const drafted = Date.now();
    await Promise.all(players.map((p) => draft(p)));
    say(`drafted in ${Math.round((Date.now() - drafted) / 1000)} s`);
    const afterDraft = (await roomOf(leader, run)).game.pod;
    if (afterDraft?.phase === 'done') {
      // Nobody to pair: the draft's end is the tournament's.
      finding(run, `the tournament ended with the draft: ${afterDraft.rounds} round(s), results ${JSON.stringify(afterDraft.results)}; no builder opened (${players.map((p) => `${p.name} at ${new URL(p.f.page.url()).hash}`).join(', ')})`);
    } else await Promise.all(players.map((p) => build(p, run)));

    /* the tournament */
    const humans = new Set(players.map((p) => p.id));
    const deadline = started + (scenario.minutes - 4) * 60_000;
    const agents = players.map((p) => playTournament(p, run));
    let pod: PodView;
    try {
      pod = await watchRoom(run, humans, deadline);
    } finally {
      run.done = true;
      await Promise.all(agents);
    }
    say(`done: ${pod.rounds} rounds, standings ${pod.standings.map((r) => `${r.rank}. ${isAi(r.id) ? r.id : (players.find((p) => p.id === r.id)?.name ?? r.id)} ${r.matchPoints}`).join(', ')}`);

    /* the end, on every page */
    const entrants = scenario.botsPlay && scenario.humans + scenario.bots <= 8 ? scenario.humans + scenario.bots : scenario.humans;
    expect.soft(pod.standings, 'one standings row per entrant').toHaveLength(entrants);
    expect.soft(pod.standings.map((r) => r.rank).sort((a, b) => a - b), 'ranks 1…n').toEqual(pod.standings.map((_, i) => i + 1));
    for (const p of players) {
      await p.f.page.goto(run.roomUrl);
      const rows = p.f.page.getByTestId(/^pod-standings-row-\d+$/);
      await expect.soft(rows, `${p.name}: the final standings`).toHaveCount(entrants, { timeout: UI_TIMEOUT });
    }
    await screenshotAll(run, 'final');
  } finally {
    run.done = true;
    serverFindings(run);
    for (const p of run.players) for (const e of new Set(p.errors)) finding(run, `${p.name} ${e}`);
    say(`${scenario.key}: ${run.findings.length} finding(s)`);
    await stack.stop();
  }
  expect(run.findings, `${scenario.key}: findings`).toEqual([]);
}

/*
 * `@no-retry`: forge.yml's one re-run of a red (`scripts/ci/e2e-rerun.ts`) names a test by its file and
 * line, and every scenario is this one line, so it re-ran all five; and a 40-minute tournament has no
 * second pass inside the job's 45 anyway.
 */
for (const scenario of SCENARIOS) {
  test(titled(`BLB set-cube tournament, ${scenario.key}: ${scenario.humans} people, ${scenario.bots} bots, bots ${scenario.botsPlay ? 'play' : 'only draft'}`), { tag: '@no-retry' }, async ({ browser }, info) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(scenario.minutes * 60_000);
    await runScenario(browser, scenario, info);
  });
}
