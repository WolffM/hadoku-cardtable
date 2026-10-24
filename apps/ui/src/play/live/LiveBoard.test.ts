// @vitest-environment jsdom
/*
 * The live board in a DOM: a real server replaying a real game, a real
 * socket, and a person's click on the confirm dialog travelling back to the
 * server as the reply Forge is waiting on.
 *
 * Every wait is RTL's `waitFor`, because the updates come from socket events
 * outside React's `act` — `waitFor` is what makes that legitimate.
 */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

/*
 * Every case here boots a real replay server and socket and replays a recorded
 * game into it: 0.7–2.5 s alone (measured 2026-10-11). Locally `vitest.config.ts`
 * gives a test 5 s (30 s on CI), and on a shared host at load 30+ a full run
 * pushed a different one of these past 5 s on five checks in a row while each
 * passed alone, 18 of 18. This file gets CI's room locally too; no assertion
 * changes, only the time each is allowed.
 */
vi.setConfig({ testTimeout: 30_000 });
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ComponentType } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { parseServerFrame, type GameLogLine, DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';
import { ClientEventSchema } from '@hadoku/shared';
import { parseDck } from '@hadoku/carddata/dck';
import { deckFromDeckFile } from '@hadoku/deck';
import { setRolePlayer } from '../../sound/index.ts';
import type { SoundEvent } from '../../sound/mix.ts';

import type { BoardInteraction, BoardLayout } from '../Board.tsx';
import { PHASE_LABEL, type BoardPlayer, type BoardView, type StackEntry } from '../adapter.ts';
import { PROMPT_FIXTURES, askFor } from '../prompts/fixtures.ts';
import { PROMPT_COMPONENTS, PROMPT_METHODS } from '../prompts/index.ts';

import {
  decisionMessage,
  nextStepName,
  END_TURN_NUDGE_MS,
  END_UNSHOWN_MS,
  endingSentence,
  gameOutcome,
  isMatchGone,
  isWaitingForOpponent,
  isWaitingForPregameDecision,
  LiveBoard,
  liveStatus,
  questionTopOf,
  MATCH_GONE_SENTENCE,
  reasonLost,
  refusalOf,
  rematchOf,
  statusText,
  useCrawlGuard,
  useIdleNudge,
  withGatedPriority,
  type LiveStatus,
  tossSounds,
} from './LiveBoard.tsx';
import {
  choosingMulligan,
  answerAsk,
  boardInteraction,
  closeMatch,
  currentAsk,
  nothingToDecide,
  pressButton,
  selectCard,
  socketIoMatchTransport,
  startMatch,
  subscribe,
  type LiveMatch,
  type MatchTransport,
} from './match.ts';
import { FLIP_MS } from './CoinToss.tsx';
import { whenBoardStill } from '../motion.ts';
import type { PlayPrefs } from './prefs.ts';
import { confirmAsk, fixtureFrames, startReplayServer, untilMatch, type ReplayServer } from './replay-server.ts';
import { parseMatchAck } from './transport.ts';
import { PHASE_SETTLE_MS } from './phase-sound.ts';
import type { DeckRules, SeatChoice } from '../../screens/tables.ts';

/** A constructed seat's rules, as the server sends them with every choice. */
const CONSTRUCTED_RULES: DeckRules = { kind: 'standard', format: 'free' };

/*
 * `../../rooms/api.ts` (lane R) is mocked here so R16's "Main menu" path can
 * be asserted without a real HTTP call: `GameResultScreen` (`LiveBoard.tsx`)
 * calls `roomsClient().leave(roomId)` and this is the one place that method is
 * exercised in this file. `leave.mockClear()` between tests keeps one test's
 * call out of the next's assertions.
 */
const roomsClientState = vi.hoisted(() => ({
  leave: vi.fn(async (_roomId: string) => ({ ok: true as const, room: {} as never })),
  /**
   * `get`'s answer — null by default (every R16 case here is a plain bo1,
   * non-pod room, and that is exactly what a null room reads as,
   * `GameResultScreen`'s own defaults; the same direction a room that cannot
   * be reached falls back). Wave 72 §Q's own tests set this to a real
   * `RoomView`-shaped record to drive
   * `tables[0].series.phase` and `pod`.
   */
  room: null as Record<string, unknown> | null,
  /** Called after each `get` answers — a test that needs the room to move between reads sets it. */
  afterGet: null as (() => void) | null,
  gets: 0,
  /** While set, each `get` holds its answer (the room as it was when asked) until a test calls one of `held`. */
  hold: false,
  held: [] as (() => void)[],
}));
vi.mock('../../rooms/api.ts', () => ({
  roomsClient: () => ({
    leave: roomsClientState.leave,
    get: async () => {
      const room = roomsClientState.room;
      roomsClientState.gets += 1;
      roomsClientState.afterGet?.();
      if (roomsClientState.hold) await new Promise<void>((release) => roomsClientState.held.push(release));
      return room;
    },
  }),
  // `DraftLobby.tsx` calls this at module scope (`poolsClient()`), and this
  // file's module graph reaches it on the way to `GameResultScreen` — nothing
  // in this file's own cases exercises the pool picker, so a minimal stub
  // that is never called is enough.
  poolsClient: () => ({
    listCubes: async () => [],
    importCube: async () => ({ ok: false as const, message: 'not used' }),
    refreshCube: async () => ({ ok: false as const, message: 'not used' }),
    deleteCube: async () => ({ ok: false as const, message: 'not used' }),
    cubeCards: async () => null,
  }),
}));

/*
 * The room feed (`../../rooms/feed.ts`), as the server drives it: the result
 * screen reads the table once when it starts following, then only when a test
 * says the room changed (`roomPing()`) — standing in for the other player's
 * screen writing the room and the server pushing that.
 */
const feedState = vi.hoisted(() => ({ followers: new Set<() => void>() }));
vi.mock('../../rooms/feed.ts', () => ({
  roomFeed: () => ({
    follow: (_target: unknown, refresh: () => void) => {
      refresh();
      feedState.followers.add(refresh);
      return () => feedState.followers.delete(refresh);
    },
  }),
}));
const roomPing = (): void => {
  for (const refresh of [...feedState.followers]) refresh();
};

/*
 * The room's table, as the result screen's Rematch reads and writes it: a fake
 * `tablesClient` over one table each test sets up. `ready` writes the caller's
 * own row, as the server's `POST …/ready` does; `other` is the other player's
 * row, which a test moves by hand to stand in for their screen.
 */
const tableState = vi.hoisted(() => ({
  me: { ready: false, present: true, choice: null as SeatChoice | null },
  other: { ready: false, present: true },
  matchId: null as string | null,
  /** The table's series phase, as the table read reports it beside `matchId`. */
  phase: 'done' as string,
  startRoom: vi.fn(async (_roomId: string) => ({ ok: true as const, matchId: 'm-next00000000' })),
  startVsBot: vi.fn(async (_roomId: string) => ({ ok: true as const, matchId: 'm-bot000000000' })),
  ready: vi.fn((_roomId: string, _ready: boolean, _tableId?: string, _opts?: { rematch?: boolean }) => undefined),
  loadDeck: vi.fn((_roomId: string, _deck: unknown, _tableId?: string) => undefined),
  decks: vi.fn(() => [] as { id: string; main: { name: string; count: number }[]; sideboard: { name: string; count: number }[] }[]),
  /** The server's 409 from `PUT …/deck`'s sideboard check — null answers `{ok: true}` as usual. */
  loadDeckRefusal: null as string | null,
  /** While set, each table read holds its answer (the table as it was when asked) until a test calls one of `held`. */
  hold: false,
  held: [] as (() => void)[],
}));
vi.mock('../../screens/tables.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../screens/tables.ts')>();
  const row = (you: boolean, ready: boolean) => ({
    seat: you ? 0 : 1,
    name: you ? 'me' : 'them',
    you,
    ready,
    ...(you ? { deck: tableState.me.choice === null ? null : { name: 'Deck', rulesName: '', legal: true, issueCount: 0, choice: tableState.me.choice } } : {}),
  });
  const table = () => ({
    room: { id: 'r-1', name: 'Room', gameType: 'constructed-1v1', matchId: tableState.matchId, seats: 2, phase: tableState.phase },
    you: { player: true, leader: true },
    players: [
      ...(tableState.me.present ? [row(true, tableState.me.ready)] : []),
      ...(tableState.other.present ? [row(false, tableState.other.ready)] : []),
    ],
  });
  return {
    ...actual,
    tablesClient: () => ({
      table: async () => {
        const answer = { ok: true as const, table: table() };
        if (tableState.hold) await new Promise<void>((release) => tableState.held.push(release));
        return answer;
      },
      decks: async () => tableState.decks(),
      loadDeck: async (roomId: string, deck: unknown, tableId?: string) => {
        // Forwarded the same discipline `tables.ts`'s own `withTable` keeps on
        // the wire: an absent id is a 2-arg call, never a 3rd arg of `undefined`.
        if (tableId === undefined) tableState.loadDeck(roomId, deck);
        else tableState.loadDeck(roomId, deck, tableId);
        if (tableState.loadDeckRefusal !== null) return { ok: false as const, error: tableState.loadDeckRefusal, status: 409 };
        return { ok: true as const, table: table() };
      },
      ready: async (roomId: string, ready: boolean, tableId?: string, opts?: { rematch?: boolean }) => {
        // The row first, then the spy: a test's own implementation runs after
        // the write, the way the server's own side effects follow it.
        tableState.me.ready = ready;
        if (opts !== undefined) tableState.ready(roomId, ready, tableId, opts);
        else if (tableId === undefined) tableState.ready(roomId, ready);
        else tableState.ready(roomId, ready, tableId);
        return { ok: true as const, table: table() };
      },
      startRoom: tableState.startRoom,
      startVsBot: tableState.startVsBot,
    }),
  };
});

/*
 * `Board` is mocked to CAPTURE the props it is handed and then render the real
 * component. Two things need that and nothing else in this file is affected:
 * the interaction contract lane A reads (`selectionOpen`, `declaringAttackers`)
 * is a set of BOOLEANS, and asserting them off the DOM would be asserting what
 * lane A drew rather than what this component handed over — and item 11's
 * `boardLayout` prop, a string, for the same reason. Every other case here
 * still renders the real board, because the wrapper delegates to it.
 */
const captured = vi.hoisted(() => ({
  interaction: null as BoardInteraction | null,
  boardLayout: null as BoardLayout | null,
}));
vi.mock('../Board.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Board.tsx')>();
  return {
    ...actual,
    Board: (props: { view: BoardView; interaction: BoardInteraction; boardLayout?: BoardLayout }) => {
      captured.interaction = props.interaction;
      captured.boardLayout = props.boardLayout ?? 'single';
      return createElement(actual.Board, props);
    },
  };
});

/*
 * `@wolffm/prefs-client/react`'s `usePrefs` is mocked rather than let loose:
 * the real one reads localStorage and fetches `hadoku.me/prefs` over the
 * network, neither of which this suite may depend on. `prefsState.value` is
 * this file's own knob — a test sets `prefs` before rendering to simulate a
 * returning viewer, and every `save` call is captured in `saved` rather than
 * actually persisted anywhere.
 */
const prefsState = vi.hoisted(() => ({
  prefs: null as PlayPrefs | null,
  saved: [] as Partial<PlayPrefs>[],
}));
vi.mock('@wolffm/prefs-client/react', () => ({
  usePrefs: () => ({
    prefs: prefsState.prefs,
    loading: prefsState.prefs === null,
    error: null,
    save: (patch: Partial<PlayPrefs>) => {
      prefsState.saved.push(patch);
      return Promise.resolve();
    },
  }),
}));

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;

/** Every sound event the table raised, recorded instead of played (jsdom has no WebAudio). */
const soundCalls: SoundEvent[] = [];
beforeEach(() => {
  soundCalls.length = 0;
  setRolePlayer({ play: (e) => void soundCalls.push(e) });
});

afterEach(async () => {
  setRolePlayer(null);
  cleanup();
  if (match !== null) closeMatch(match);
  match = null;
  if (server !== null) await server.close();
  server = null;
  prefsState.prefs = null;
  prefsState.saved = [];
  roomsClientState.leave.mockClear();
  roomsClientState.room = null;
  roomsClientState.afterGet = null;
  roomsClientState.gets = 0;
  roomsClientState.hold = false;
  roomsClientState.held = [];
  tableState.me = { ready: false, present: true, choice: null };
  tableState.other = { ready: false, present: true };
  tableState.matchId = null;
  tableState.phase = 'done';
  tableState.startRoom.mockClear();
  tableState.startVsBot.mockClear();
  tableState.ready.mockClear();
  tableState.loadDeck.mockClear();
  tableState.decks.mockClear();
  tableState.loadDeckRefusal = null;
  tableState.hold = false;
  tableState.held = [];
});

/**
 * `menu`: open cardtable's settings once the board is up, the way a player
 * does — a click on their own face.
 */
async function liveBoard(playerId = 0, menu = false) {
  const s = (server = await startReplayServer({ playerId }));
  const m = (match = startMatch({
    matchId: s.matchId,
    transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
  }));
  const utils = render(createElement(LiveBoard, { match: m }));
  await untilMatch(m, () => expect(m.stats.snapshots).toBe(1));
  const frames = fixtureFrames();
  for (const f of frames) s.send(f);
  // Wait for DELIVERY first, on the counter that says so, and only then for
  // what the delivery renders.
  //
  // This raced: the loop above hands every frame to the socket at once and the
  // wait below asked only about the LAST frame's rendered effect, so on a
  // contended runner `waitFor` could exhaust its window with the board still
  // at an earlier turn — observed in CI as `expected 'Turn 13' to be
  // 'Turn 14'`, at a sha whose only change was a dependency bump, and never
  // reproducible locally (45/45, three runs). Waiting on `stats.applied` is
  // waiting for the right thing: the assertion below is then about rendering,
  // not about how fast a websocket drained.
  await untilMatch(m, () => expect(m.stats.applied).toBe(frames.length));
  // The turn number is the RAIL's: §A deleted `.board__bar`, which carried
  // `turn`, and `live-turn-n` is Forge's own counter on its own (wave 26 §B.2).
  await waitFor(() => expect(utils.getByTestId('live-turn-n').textContent).toBe('14'));
  if (menu) fireEvent.click(utils.getByTestId('seat-settings'));
  return { s, m, ...utils };
}

/**
 * `forge:seats`' `waitingOn` for the OTHER seat — under
 * this fixture always seat 1, since the replay server's own snapshot always
 * answers `seat: 0` (`replay-server.ts`). `null` clears it, the same two-state
 * rule `avatarId` already follows. Every T2/W1 test that wants "the opponent
 * is waiting" now has to say so explicitly — see `isWaitingForOpponent`'s own
 * note on why this is no longer inferred from the viewer's OWN bar/ask state.
 */
async function sendTheirWaitingOn(
  s: ReplayServer,
  m: LiveMatch,
  fact: { method: string; hostCard: string | null } | null,
): Promise<void> {
  s.sendSeats([
    { seat: 0, claimed: true, playerId: null },
    { seat: 1, claimed: true, playerId: null, ...(fact === null ? {} : { waitingOn: fact }) },
  ]);
  await untilMatch(m, () => expect(m.waitingOn?.has(1) ?? false).toBe(fact !== null));
}

/**
 * Every row of text the board draws ABOUT ITSELF, in DOM order — the status
 * line and, while the board is live, the error line. `LiveBoard` marks them
 * with `data-live-line`, and three of these at once is the bug §F.2 names.
 */
const lines = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-live-line]')].map((el) => el.textContent ?? '');

/**
 * The step the rail says the game is on. It is the only thing on the page that
 * names the phase now: §A deleted `.board__bar`, which carried `turn`, `phase`
 * and `active-player`, and §B.2 widened the rail so the thirteen steps could be
 * read (`live-turn-n` is the turn number on its own).
 */
const currentStep = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('.live__step[data-current] .live__step-name');


/**
 * `.live`'s children by class, less the "Your turn" cue (`TurnCue.tsx`): the fixture replays a turn
 * beginning, so the cue is up for its 1.2 s or not depending on how fast a test runs, and it is a
 * passing moment, not part of the layout these cases pin.
 */
/** Which children stand in `.live`, by their own classes; `ct-panel` is the trim hook (`settings/trim.ts`), not a child's identity. */
const standingChildren = (live: Element): string[] =>
  [...live.children].map((el) => [...el.classList].filter((c) => c !== 'ct-panel').join(' ')).filter((c) => c !== 'live__turn-cue');

describe('the board follows the stream', () => {
  it('waits, then draws the game as the frames arrive', async () => {
    const s = (server = await startReplayServer());
    const m = (match = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    }));
    const { container, getByTestId, queryByTestId } = render(createElement(LiveBoard, { match: m }));
    // Seated, with no state yet: ONE line says exactly that, and it is the
    // line — there is no second "waiting" row under it any more (§F.2).
    await untilMatch(m, () => expect(m.stats.snapshots).toBe(1));
    await waitFor(() => expect(getByTestId('live-status').textContent).toBe('Seat 1, waiting for the state.'));
    expect(lines(container)).toEqual(['Seat 1, waiting for the state.']);
    // No state, so no rail: the turn indicator arrives with the board.
    expect(queryByTestId('live-turn-n')).toBeNull();

    const frames = fixtureFrames();
    s.send(frames[0]!);
    await waitFor(() => expect(getByTestId('live-turn-n')).toBeTruthy());
    for (const f of frames.slice(1)) s.send(f);
    // 27 frames over a real socket, each re-rendering the whole board: 0.5-0.8 s alone, past waitFor's
    // 1 s default under a full-suite load (it failed there at turn 11 after w46-w48 were integrated).
    await waitFor(() => expect(getByTestId('live-turn-n').textContent).toBe('14'), { timeout: 5000 });
    // And the phase, from the rail's own current step — the bar that used to say
    // it is gone (§A).
    expect(currentStep(container)?.textContent).toBe('Main 1');
    // The line the board drew about itself while it waited is gone now that it is
    // live (§B.5): there is nothing on the page but the table and its overlays.
    expect(lines(container)).toEqual([]);
  });
});

describe('showConfirmDialog', () => {
  it('renders the ask, focuses the default, and a click on the OTHER button reaches the server', async () => {
    const { s, m, getByTestId, getByRole, queryByTestId } = await liveBoard();
    s.send(confirmAsk('c-1', true));
    const dialog = await waitFor(() => getByTestId('confirm-dialog'));

    expect(getByRole('alertdialog', { name: 'Mulligan' })).toBe(dialog);
    expect(dialog.textContent).toContain('Keep this hand of seven?');
    const keep = dialog.querySelector<HTMLButtonElement>('[data-answer="yes"]')!;
    const mulligan = dialog.querySelector<HTMLButtonElement>('[data-answer="no"]')!;
    expect([keep.textContent, mulligan.textContent]).toEqual(['Keep', 'Mulligan']);
    expect(document.activeElement).toBe(keep);

    fireEvent.click(mulligan);
    await s.untilClientFrames(1);
    expect(s.clientFrames()[0]).toEqual({
      ok: true,
      value: { kind: 'reply', callId: 'c-1', method: 'showConfirmDialog', result: false },
    });
    await waitFor(() => expect(queryByTestId('confirm-dialog')).toBeNull());
    expect(m.stats.replies).toBe(1);
  });

  it('a double click answers once', async () => {
    const { s, getByTestId } = await liveBoard();
    s.send(confirmAsk('c-2', false));
    const dialog = await waitFor(() => getByTestId('confirm-dialog'));
    const keep = dialog.querySelector<HTMLButtonElement>('[data-answer="yes"]')!;
    expect(document.activeElement).toBe(dialog.querySelector('[data-answer="no"]'));
    fireEvent.click(keep);
    fireEvent.click(keep);
    await s.untilClientFrames(1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { callId: 'c-2', result: true } });
  });
});

describe('hidden information, on the live path', () => {
  it('the viewer is the snapshot’s player, and the other hand is a count', async () => {
    const { container, queryByTestId } = await liveBoard(0);
    const viewer = container.querySelector<HTMLElement>('[data-viewer]')!;
    expect(viewer.dataset.playerId).toBe('0');
    // `Seat 1, live.` is deleted (§B.5); a live board says nothing about itself.
    expect(queryByTestId('live-status')).toBeNull();
    // Alice's hand, whose names ARE on the wire (Board.test.ts proves that).
    expect(container.textContent).not.toContain('Talon of Pain');
    expect(container.textContent).not.toContain('Electrostatic Bolt');
  });

  it('seated as the other player, the SAME stream hides the other hand', async () => {
    const { container } = await liveBoard(1);
    expect(container.querySelector<HTMLElement>('[data-viewer]')!.dataset.playerId).toBe('1');
    expect(container.textContent).toContain('Talon of Pain');
    for (const name of ['Leapfrog', 'Fearless Halberdier', "Ral's Dispersal", 'Hellkite Whelp']) {
      expect(container.textContent).not.toContain(name);
    }
  });
});

describe('the other fourteen prompts, on the live board', () => {
  // The two zone asks answer on mount and are gone before a wait could see
  // them — they have their own case below.
  const drawn = PROMPT_METHODS.filter((m) => m !== 'tempShowZones' && m !== 'openZones');

  it('draws twelve and answers two by itself: the fourteen, all accounted for', () => {
    expect(drawn).toHaveLength(12);
    expect(PROMPT_METHODS).toHaveLength(14);
  });

  it.each(drawn)('%s: an ask from the stream draws its own component', async (method) => {
    const { s, container, getByTestId } = await liveBoard();
    const fixture = PROMPT_FIXTURES.find((f) => f.method === method)!;
    s.send(parseServerFrame(fixture.raw));
    const sheet = await waitFor(() => getByTestId('live-prompt'));
    expect(sheet.dataset.method).toBe(method);
    expect(container.querySelector(`[data-prompt="${method}"]`)).not.toBeNull();
    expect(container.querySelector('[data-testid="live-error"]')).toBeNull();
  });

  it.each(['tempShowZones', 'openZones'] as const)(
    '%s answers itself on mount, once, through the seam',
    async (method) => {
      const { s, m, queryByTestId } = await liveBoard();
      s.send(askFor(method));
      await s.untilClientFrames(1);
      expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'reply', callId: `fx-${method}`, method } });
      await waitFor(() => expect(queryByTestId('live-prompt')).toBeNull());
      expect(m.stats.replies).toBe(1);
    },
  );

  it('a choice half-made survives the board moving under it, and the answer is the one Forge asked for', async () => {
    const s = (server = await startReplayServer());
    const m = (match = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    }));
    const { getByTestId, container } = render(createElement(LiveBoard, { match: m }));
    await untilMatch(m, () => expect(m.stats.snapshots).toBe(1));
    const frames = fixtureFrames();
    for (const f of frames.slice(0, 8)) s.send(f);
    await waitFor(() => expect(getByTestId('live-turn-n')).toBeTruthy());
    const turnBefore = getByTestId('live-turn-n').textContent;

    s.send(askFor('getChoices'));
    await waitFor(() => getByTestId('live-prompt'));
    const red = () => container.querySelector<HTMLInputElement>('[data-testid="prompt-choice"][data-key="red"]')!;
    fireEvent.click(red());
    expect(red().checked).toBe(true);

    // The rest of the game arrives with the question open.
    for (const f of frames.slice(8)) s.send(f);
    await waitFor(() => expect(getByTestId('live-turn-n').textContent).toBe('14'));
    expect(turnBefore).not.toBe('14');
    expect(red().checked).toBe(true);
    expect(getByTestId('live-prompt').dataset.callId).toBe('fx-getChoices');

    fireEvent.click(getByTestId('prompt-submit'));
    await s.untilClientFrames(1);
    expect(s.clientFrames()[0]).toEqual({
      ok: true,
      value: { kind: 'reply', callId: 'fx-getChoices', method: 'getChoices', result: ['red'] },
    });
    expect(currentAsk(m)).toBeNull();
    expect(m.stats).toMatchObject({ gaps: 0, resyncsRequested: 0, invalid: 0 });
  });

  it('two asks open: the oldest is drawn, and the next is drawn once it is answered', async () => {
    const { s, getByTestId } = await liveBoard();
    s.send(askFor('getChoices'));
    s.send(confirmAsk('c-next'));
    await waitFor(() => expect(getByTestId('live-prompt').dataset.callId).toBe('fx-getChoices'));
    fireEvent.click(document.querySelector('[data-testid="prompt-choice"][data-key="blue"]')!);
    fireEvent.click(getByTestId('prompt-submit'));
    const dialog = await waitFor(() => getByTestId('confirm-dialog'));
    expect(dialog.dataset.callId).toBe('c-next');
    fireEvent.click(dialog.querySelector('[data-answer="yes"]')!);
    await s.untilClientFrames(2);
    expect(s.clientFrames().map((f) => (f.ok && f.value.kind === 'reply' ? [f.value.callId, f.value.result] : null))).toEqual([
      ['fx-getChoices', ['blue']],
      ['c-next', true],
    ]);
  });

  it('a prompt that throws is aborted, so Forge is not left waiting on it', async () => {
    const table = PROMPT_COMPONENTS as unknown as Record<string, ComponentType<unknown>>;
    const original = table.showOptionDialog!;
    table.showOptionDialog = () => {
      throw new Error('boom');
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      const { s, m, getByTestId, queryByTestId } = await liveBoard();
      s.send(askFor('showOptionDialog'));
      await s.untilClientFrames(1);
      expect(s.clientFrames()[0]).toMatchObject({
        ok: true,
        value: { kind: 'abort', callId: 'fx-showOptionDialog', reason: 'unsupported' },
      });
      await waitFor(() => expect(queryByTestId('live-prompt')).toBeNull());
      expect(getByTestId('live-error').textContent).toMatch(/could not show showOptionDialog/);
      expect(m.stats.aborts).toBe(1);
    } finally {
      table.showOptionDialog = original;
      console.error = quiet;
    }
  });
});

/*
 * The coin toss, and the gap that let every production match hang at Turn 0.
 *
 * Forge opens a match by asking "play or draw?" through `showPromptMessage` +
 * `updateButtons`. Neither is a blocking `ask`: no callId, no reply schema,
 * nothing for `currentAsk` to return. The board drew only `asks`, so the page
 * showed an empty table with no control on it and the game never started —
 * observed live on 2026-09-19, match `m-090bf01ba811`, with Forge's own log
 * carrying `updateButtons` and `showPromptMessage` for a seat whose browser
 * rendered neither.
 *
 * `e2e/play/hands.ts` existed to press these buttons over a second socket, so
 * the browser suite went green while the product could not be played. These
 * tests are the ones that bite instead.
 */
describe('Forge asks with buttons, not only with asks', () => {
  function buttonFrames(message: string, label1: string, label2: string) {
    return parseFrames([
      { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: null },
      {
        kind: 'notify',
        method: 'updateButtons',
        owner: { kind: 'player', id: 0 },
        label1,
        label2,
        enable1: true,
        enable2: true,
        focus1: true,
      },
    ]);
  }

  /** Each literal through forge-wire, so a shape the server could not send cannot be tested. */
  function parseFrames(raw: unknown[]) {
    return raw.map((r) => parseServerFrame(r));
  }

  /*
   * R2, wave 35: the coin toss / play-draw question moved OFF the control bar
   * and into the decision area (`PlayOrDrawPrompt`, lane G) — this used to
   * assert the bar drew `Play`/`Draw`; now the control box's End Turn is
   * greyed and no decision pop-up opens while `PlayOrDrawPrompt` owns the question. See
   * `g.md` for the full shape.
   */
  it('the coin toss / play-draw question renders in the decision area, not the control bar, and sends the click Forge is waiting for', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();

    for (const f of buttonFrames('Seat 1, you have won the coin toss.\n\nPlay or draw?', 'Play', 'Draw')) {
      s.send(f);
    }

    await waitFor(() => expect(getByTestId('live-play-or-draw-host')).toBeTruthy());
    expect(getByTestId('live-play-or-draw').textContent).toContain('coin toss');
    expect(getByTestId('live-play-or-draw-play').textContent).toBe('Play');
    expect(getByTestId('live-play-or-draw-draw').textContent).toBe('Draw');
    // The control box does not ALSO answer it, and no second pop-up does either.
    expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(true);
    expect(queryByTestId('live-decision'), 'no pass can double-fire the answer').toBeNull();

    const before = m.stats.replies;
    fireEvent.click(getByTestId('live-play-or-draw-play'));

    await untilMatch(m, () => expect(m.stats.replies).toBe(before + 1));
    await s.caughtUp(m);
    expect(s.clientFrames().some((f) => f.ok && f.value.kind === 'act' && f.value.method === 'selectButtonOk')).toBe(true);
  });

  it('a bar Forge has disabled is not pressable, so a stale click cannot answer the NEXT question', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();

    s.send(stackDelta(m));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(0));
    for (const f of buttonFrames('Priority', 'OK', 'End Turn')) s.send(f);
    const pass = await waitFor(() => getByTestId('live-decision-ok'));

    fireEvent.click(pass);
    // The pop-up goes with the bar, and the box stays where it is, greyed, until Forge sends a fresh bar.
    await waitFor(() => expect(queryByTestId('live-decision')).toBeNull());
    expect(getByTestId('live-buttons')).toBeTruthy();
    // `pressButton` disabled both of Forge's buttons, so End Turn greys with it.
    expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(pass);
    expect(pressButton(m, 'ok')).toBe(false);
    await s.untilClientFrames(1);
    expect(m.stats.replies).toBe(1);
  });

  it('the box is there before Forge has sent a bar: our End Turn, greyed, nothing said', async () => {
    const { getByTestId, queryByTestId } = await liveBoard();
    expect(getByTestId('live-says').textContent).toBe('');
    const end = getByTestId('live-button-end-turn') as HTMLButtonElement;
    expect([end.textContent, end.disabled]).toEqual(['End Turn', true]);
    expect(queryByTestId('live-decision')).toBeNull();
  });

  it('the bar stays while a question is open, disabled, and a press sends nothing', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    s.send(stackDelta(m));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(0));
    for (const f of buttonFrames('Priority', 'OK', 'End Turn')) s.send(f);
    const pass = await waitFor(() => getByTestId('live-decision-ok'));
    expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled, 'Forge’s End Turn, enabled').toBe(false);

    s.send(confirmAsk('c-open'));
    await waitFor(() => getByTestId('confirm-dialog'));
    expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled, 'a question is open: End Turn greys').toBe(true);
    expect(queryByTestId('live-decision'), 'the ask owns the column: no pass beside it').toBeNull();
    expect(getByTestId('live-says').textContent).toBe('Priority');
    fireEvent.click(pass);
    expect(pressButton(m, 'ok')).toBe(false);
    expect(m.stats.replies).toBe(0);

    fireEvent.click(getByTestId('confirm-dialog').querySelector('[data-answer="yes"]')!);
    await waitFor(() => getByTestId('live-decision-ok'));
    expect((await s.framesFrom(m)).map((f) => (f.ok ? f.value.kind : null))).toEqual(['reply']);
  });
});

/*
 * The board's cards, clicked. `Board` draws a card as a button only when
 * `boardInteraction` offers it; the click goes to `selectCard`, which checks
 * Forge's CURRENT state before sending.
 *
 * `[data-selectable]` (wave 35 R10, lane B, twice over): a battlefield card's
 * face is now always a `<button>`, so "a button exists" stopped meaning
 * "selectable" the first time (B's flicker fix). It briefly read
 * `button:not([disabled])` here; B's own follow-up (a real browser never
 * dispatches pointer events to, or bubbles them past, a `disabled` form
 * control — jsdom does not reproduce that, so a disabled card's arrange-drag
 * could never start on a real mouse) switched the face to
 * `tabIndex={-1}` instead, so `disabled` stopped existing on it at all. The
 * board's own selectable marker — `data-selectable` on the card's OUTER
 * wrapper, `[data-board-card]`'s own element — is the one fact that has not
 * moved under this file twice; these queries read that now, and press the
 * inner `<button>` (found inside it) to fire the click.
 */
describe('clicking a card on the live board', () => {
  function notify(raw: unknown[]) {
    return raw.map((r) => parseServerFrame(r));
  }

  it('a card Forge lists is clickable and sends selectCard; once Forge clears the list it is inert and sends nothing', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const [target, other] = [mine[0]!, mine[1]!];
    const selectableCard = (id: number) => container.querySelector<HTMLElement>(`[data-board-card="${id}"][data-selectable]`);
    expect(selectableCard(target)).toBeNull();

    for (const f of notify([
      { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Select a target', card: null },
      { kind: 'notify', method: 'setSelectables', cards: [{ kind: 'card', id: target }], min: 1, max: 1 },
    ])) {
      s.send(f);
    }
    await waitFor(() => expect(selectableCard(target)).not.toBeNull());
    expect(selectableCard(other)).toBeNull();

    fireEvent.click(selectableCard(target)!.querySelector('button')!);
    await s.untilClientFrames(1);
    expect(s.clientFrames()[0]).toEqual({
      ok: true,
      value: { kind: 'act', method: 'selectCard', card: { kind: 'card', id: target }, otherCardViewsToSelect: [], triggerEvent: null },
    });
    // Spent: not selectable again until Forge speaks — asserted by the wire
    // above (exactly one frame sent) and by the marker going away here.
    await waitFor(() => expect(selectableCard(target)).toBeNull());

    s.send(parseServerFrame({ kind: 'notify', method: 'clearSelectables' }));
    await untilMatch(m, () => expect(m.selectables).toBeNull());
    expect(selectableCard(target)).toBeNull();
    expect(selectableCard(other)).toBeNull();
    expect(selectCard(m, target)).toBe(false);
    expect(m.stats.replies).toBe(1);
  });
});

/*
 * Dragging, box-drawing and the targeter arrow are NOT here any more.
 *
 * Wave 24 re-homed the whole pointer layer into `./gestures/` (lane B's, and
 * framework-free), and the tests that asserted what a drag put on the WIRE went
 * with it. What is left of that layer in this component is one effect that
 * installs it on `.live` and disposes it, which is what "the frame installs the
 * gesture layer" below asserts — everything else about a drag is now provable
 * without React.
 */

/*
 * The says, the full-control toggle, and the ability label — Wave 19's §C
 * items as they reach the player's eyes. All three assert on the WIRE (what
 * `s.received` / `s.clientFrames()` hold) or on the text drawn, never on
 * internals.
 */
describe('the says, the toggle, and the ability label', () => {
  const says = (text: string) => parseServerFrame({ kind: 'notify', method: 'message', message: text, title: '' });

  it('draws every say the match holds, in a panel that is there before any arrive', async () => {
    const { s, container } = await liveBoard();
    const log = container.querySelector('[data-testid="live-log"]')!;
    expect(log.querySelectorAll('li')).toHaveLength(0); // the panel, empty, not gone

    for (const f of [says('auto-passed Upkeep step'), says('paid U — Volcanic Island'), says('auto-passed Draw step')]) {
      s.send(f);
    }
    // All three, not the two the cluster's fixed row had room for (§C.3).
    await waitFor(() => expect(log.querySelectorAll('li')).toHaveLength(3));
    expect([...log.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'auto-passed Upkeep step',
      'paid U — Volcanic Island',
      'auto-passed Draw step',
    ]);
  });

  it('says a say\'s brace notation in words, like every other rules text', async () => {
    const { s, container } = await liveBoard();
    s.send(says('paid {U} — {T} Volcanic Island'));
    await waitFor(() => expect(container.querySelector('[data-testid="live-log"] li')?.textContent).toBe('paid U — Tap Volcanic Island'));
  });

  it('the toggle: off by default, a click sends forge:full-control and the button says on, and back', async () => {
    const { s, m, getByTestId } = await liveBoard();
    // Each state is its own element (`ActionButton`): read the toggle afresh after every press.
    const toggle = (): HTMLElement => getByTestId('live-full-control');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(s.received.filter((r) => r.event === 'forge:full-control')).toEqual([]);

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(s.received.filter((r) => r.event === 'forge:full-control')).toHaveLength(1));
    expect(s.received.filter((r) => r.event === 'forge:full-control')[0]!.payload).toEqual({
      matchId: s.matchId,
      on: true,
    });

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('false'));
    await waitFor(() => expect(s.received.filter((r) => r.event === 'forge:full-control')).toHaveLength(2));
    expect(s.received.filter((r) => r.event === 'forge:full-control')[1]!.payload).toEqual({
      matchId: s.matchId,
      on: false,
    });
    // A preference, not a frame: none of it crossed forge:c2s.
    expect(await s.framesFrom(m)).toEqual([]);
  });

  it('the ability picker shows the LABEL the bridge sent, braces in words, and the reply still names the ability', async () => {
    const { s, m, container, getByTestId } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 'fx-labelled',
        method: 'getAbilityToPlay',
        hostCard: { kind: 'card', id: mine[0]! },
        abilities: [
          { kind: 'spellAbility', id: 9001, label: '{T}: Add {R}.' },
          { kind: 'spellAbility', id: 9002, label: '{2}, Sacrifice Pyrite Spellbomb: Draw a card.' },
        ],
        triggerEvent: null,
      }),
    );
    await waitFor(() => expect(getByTestId('live-prompt').dataset.method).toBe('getAbilityToPlay'));
    const sheet = container.querySelector('[data-prompt="getAbilityToPlay"]')!;
    const offered = [...sheet.querySelectorAll<HTMLButtonElement>('[data-testid="prompt-choice"]')];
    // The label is the affordance — no number is drawn anywhere in it.
    // The plain words are the accessible name; the button draws the tap and mana symbols (2026-10-08).
    expect(offered.map((b) => b.getAttribute('aria-label'))).toEqual(['Tap: Add R.', '2, Sacrifice Pyrite Spellbomb: Draw a card.']);
    expect(offered[0]!.querySelector('.pip'), 'the {R} is a symbol').not.toBeNull();
    expect(sheet.textContent).not.toMatch(/ability #/);

    fireEvent.click(offered[1]!);
    await s.untilClientFrames(1);
    expect(s.clientFrames()[0]).toMatchObject({
      ok: true,
      value: { kind: 'reply', callId: 'fx-labelled', method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 9002 } },
    });
  });

  it('an offer with no labels keeps its fallback — the shape a bridge that predates them sends', async () => {
    const { s, m, container, getByTestId } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 'fx-unlabelled',
        method: 'getAbilityToPlay',
        hostCard: { kind: 'card', id: mine[0]! },
        // Two, because one answers itself and is never drawn — see below.
        abilities: [{ kind: 'spellAbility', id: 9001 }, { kind: 'spellAbility', id: 9002 }],
        triggerEvent: null,
      }),
    );
    await waitFor(() => expect(getByTestId('live-prompt').dataset.method).toBe('getAbilityToPlay'));
    const sheet = container.querySelector('[data-prompt="getAbilityToPlay"]')!;
    expect(sheet.querySelector('[data-testid="prompt-choice"]')!.textContent).toBe('ability #9001');
  });

  /*
   * Wave 20 §B.1, the operator's #4: *"one choice shouldn't require this dialog
   * at all"*. The policy is `@hadoku/shared`'s `selfAnswer`; this is the wiring.
   */
  it('an offer with ONE ability is answered without drawing anything', async () => {
    const { s, m, queryByTestId } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 'fx-only-one',
        method: 'getAbilityToPlay',
        hostCard: { kind: 'card', id: mine[0]! },
        abilities: [{ kind: 'spellAbility', id: 9001, label: '{T}: Add {R}.' }],
        triggerEvent: null,
      }),
    );
    await s.untilClientFrames(1);
    expect(s.clientFrames()[0]).toMatchObject({
      ok: true,
      value: { kind: 'reply', callId: 'fx-only-one', method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 9001 } },
    });
    // Nothing was ever drawn for it, and nothing is left open.
    expect(queryByTestId('live-prompt')).toBeNull();
    expect(m.asks).toEqual([]);
    // The browser writes nothing to the log itself: what was played is Forge's own log line.
    expect(m.says).toEqual([]);
  });

  /*
   * The operator, 2026-10-19, in full control: *"for cards like timewarp, why is it asking me to
   * 'select' an ability? there is only one valid choice here."* Full control brings back every
   * stop and every real choice, never a question with one answer.
   */
  it('full control answers that same one-ability offer too, and still draws two', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-full-control'));
    await untilMatch(m, () => expect(m.fullControl).toBe(true));
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 'fx-full-control',
        method: 'getAbilityToPlay',
        hostCard: { kind: 'card', id: mine[0]! },
        abilities: [{ kind: 'spellAbility', id: 9001, label: '{T}: Add {R}.' }],
        triggerEvent: null,
      }),
    );
    await s.untilClientFrames(1);
    expect(s.clientFrames()[0]).toMatchObject({
      ok: true,
      value: { kind: 'reply', callId: 'fx-full-control', method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 9001 } },
    });
    expect(queryByTestId('live-prompt')).toBeNull();
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 'fx-full-control-two',
        method: 'getAbilityToPlay',
        hostCard: { kind: 'card', id: mine[0]! },
        abilities: [{ kind: 'spellAbility', id: 9001 }, { kind: 'spellAbility', id: 9002 }],
        triggerEvent: null,
      }),
    );
    await waitFor(() => expect(getByTestId('live-prompt').dataset.callId).toBe('fx-full-control-two'));
  });
});

/*
 * §N — the two lanes meet: lane E's honest `match-gone` ack has to survive
 * lane F's client.
 *
 * Lane E made a gone match say so on the wire, lane F made the board render
 * `match-gone`, and between them `MatchErrorSchema` was `.strict()` with one
 * field, so E's three-field ack parsed as MALFORMED and F's state was never
 * reached. Neither lane's own suite could see it: E asserts what the server
 * sends and F drove the bare `{ error }` shape.
 *
 * A copy of lane E's sentence. `@hadoku/ui` does not depend on the server
 * package, so `MATCH_GONE_WORDS` (`apps/server/src/play/socket.ts`) cannot be
 * imported here; nothing below asserts its TEXT — only that a refusal shaped
 * like E's parses, and reaches `match-gone`.
 */
const MATCH_GONE_MESSAGE =
  'This match is no longer running on the server — it ended when the server restarted or when Forge stopped. Nothing you did caused it. Start a new match to play again.';

describe('the refusal wire: a gone match, and every other refusal', () => {
  it('a bare { error } still parses — every refusal but one sends exactly that, and so does an older server', () => {
    for (const error of ['unknown-match', 'match-full', 'not-joined', 'match-starting', 'malformed: $.matchId']) {
      const ack = parseMatchAck({ error });
      expect(ack).toEqual({ ok: true, value: { error } });
    }
  });

  it('lane E’s three-field match-gone ack parses — the fields are optional, so both shapes are one schema', () => {
    const refusal = { error: 'unknown-match', outcome: 'match-gone', message: MATCH_GONE_MESSAGE };
    const ack = parseMatchAck(refusal);
    expect(ack).toEqual({ ok: true, value: refusal });
  });

  it('the refusal is still strict: a field the contract does not have is an error, not a shrug', () => {
    // A typo in one of the new names is the case this guards — `outcom` must
    // not slip through as "some key we now tolerate".
    const typo = parseMatchAck({ error: 'unknown-match', outcom: 'match-gone' });
    expect(typo.ok).toBe(false);
    if (!typo.ok) {
      expect(typo.errors.map((e) => e.path)).toEqual(['$']);
      expect(typo.errors[0]!.message).toContain('outcom');
    }
    // And an empty `message` is not a message: the primitives still hold.
    expect(parseMatchAck({ error: 'unknown-match', outcome: 'match-gone', message: '' }).ok).toBe(false);
  });
});

/*
 * §F — the match's own chrome: six states, ONE line, and Leave where a person
 * looks for it.
 *
 * The operator saw `forge:join was refused: unknown-match`, `Connected, not
 * seated.` and `Waiting for the game state.` stacked together and asked
 * whether anybody had decided that. Nobody had. Every case below drives a real
 * state and asserts what the WHOLE board says about itself — `lines()`, not one
 * element — because "exactly one line" is a claim about everything drawn, and a
 * test that reads a single test-id cannot fail when a second line appears
 * beside it.
 *
 * The five states before `live` are driven through a stub transport rather than
 * the replay server: a refused join, an unanswered one and a socket that has
 * not come up yet are exactly what a real server does NOT do.
 */
describe('one state, one line', () => {
  interface Stub {
    transport: MatchTransport;
    /** Fire a socket event at the driver: `connect`, `disconnect`, a frame. */
    fire: (event: string, payload?: unknown) => void;
    /** Answer the join or resync the driver has in flight, as the server would. */
    answer: (response: unknown) => void;
  }

  function stubTransport(): Stub {
    const handlers = new Map<string, ((payload: unknown) => void)[]>();
    const acks: ((err: Error | null, response: unknown) => void)[] = [];
    return {
      transport: {
        on: (event, handler) => {
          const held = handlers.get(event) ?? [];
          held.push(handler);
          handlers.set(event, held);
        },
        emit: () => {},
        request: (_event, _payload, onAck) => {
          acks.push(onAck);
        },
        disconnect: () => {},
      },
      fire: (event, payload) => {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
      answer: (response) => {
        const onAck = acks.shift();
        if (onAck === undefined) throw new Error('nothing was in flight to answer');
        onAck(null, response);
      },
    };
  }

  const MATCH_ID = 'm-chrome';
  /** A snapshot that seats this client and carries no state yet. */
  const seatOnly = { matchId: MATCH_ID, seat: 0, playerId: 0, cursor: null, frames: [] };

  function stubBoard() {
    const stub = stubTransport();
    const m = (match = startMatch({ matchId: MATCH_ID, transport: stub.transport }));
    const utils = render(createElement(LiveBoard, { match: m }));
    return { stub, m, ...utils };
  }

  /** The state, the one line, and that it IS the only line. */
  function only(container: HTMLElement, m: LiveMatch, state: LiveStatus, text: string): void {
    expect(liveStatus(m)).toBe(state);
    expect(lines(container)).toEqual([text]);
    const line = container.querySelector<HTMLElement>('[data-testid="live-status"]')!;
    expect(line.dataset.status).toBe(state);
    expect(container.querySelectorAll('[data-testid="live-status"]')).toHaveLength(1);
  }

  it('connecting: the socket is not up, and then the join is in flight', () => {
    const { stub, m, container } = stubBoard();
    only(container, m, 'connecting', 'Connecting…');

    // The socket comes up; the join it sent is still unanswered, so there is
    // still no seat and still nothing a player could do.
    act(() => stub.fire('connect'));
    expect(m.awaitingSnapshot).toBe(true);
    only(container, m, 'connecting', 'Connecting…');
  });

  it('connected-not-seated: the join was answered with something that is not a seat', () => {
    const { stub, m, container, queryByTestId } = stubBoard();
    act(() => stub.fire('connect'));
    act(() => stub.answer({}));

    expect(m.seat).toBeNull();
    expect(m.awaitingSnapshot).toBe(false);
    only(container, m, 'connected-not-seated', 'Connected, not seated.');
    // Not a refusal, so the seam says nothing about it — and the server's own
    // sentence is on the line's title, not on a second row.
    expect(refusalOf(m)).toBeNull();
    expect(queryByTestId('live-error')).toBeNull();
    expect(queryByTestId('live-status')!.title).toMatch(/is not a snapshot/);
  });

  it('seated-waiting-for-state: a seat, and no board yet', () => {
    const { stub, m, container, queryByTestId } = stubBoard();
    act(() => stub.fire('connect'));
    act(() => stub.answer(seatOnly));

    only(container, m, 'seated-waiting-for-state', 'Seat 1, waiting for the state.');
    expect(container.querySelector('.board')).toBeNull();
    expect(container.textContent).not.toContain('Waiting for the game state.');
    expect(queryByTestId('live-error')).toBeNull();
    // With no table under it the line takes the table's space; see `live.css`.
    expect(queryByTestId('live-status')!.dataset.perch).toBe('table');
  });

  /*
   * §B.5 — `Seat 1, live.` is DELETED. Operator, 2026-09-27: *"i dont understand
   * what 'turn bar' and 'seat 1 live' are relevant for so i think these should
   * just be deleted."*
   *
   * So the live state is the one state with no line, and this asserts the whole
   * page rather than one element: `lines()` is every row of text the board draws
   * about itself, and it is empty. What a player reads instead is their own table
   * — and the turn, on the rail.
   */
  it('live: NO line at all, and the turn is the rail’s', async () => {
    const { m, container, queryByTestId, getByTestId } = await liveBoard();
    expect(liveStatus(m)).toBe('live');
    expect(statusText(m)).toBeNull();
    expect(lines(container)).toEqual([]);
    expect(queryByTestId('live-status')).toBeNull();
    expect(container.textContent).not.toContain('Seat 1, live.');
    // The one indicator that replaced it, and it is Forge's own counter.
    expect(getByTestId('live-turn-n').textContent).toBe(String(m.view!.turn));
  });

  it('reconnecting, not connecting: a socket the page had and lost (a deploy mid-game) — and gone again once it is back', async () => {
    const { m, container, queryByTestId } = await liveBoard();
    expect(liveStatus(m)).toBe('live');
    act(() => m.transport.disconnect());
    await untilMatch(m, () => expect(m.connected).toBe(false));
    only(container, m, 'reconnecting', 'Reconnecting…');
    expect(container.querySelector('.board'), 'the table stays drawn under it').not.toBeNull();
    expect(queryByTestId('live-status')!.dataset.perch).toBe('corner');
  });

  it('the seat number is the snapshot’s seat, not a guess — seat 1 is “Seat 2”', () => {
    // The replay server always seats a client at 0, so the second seat is
    // driven here. `Seat 2, live.` — which `e2e/play.spec.ts` waits on — is the
    // same `match.seat + 1` this renders.
    const { stub, m, container } = stubBoard();
    act(() => stub.fire('connect'));
    act(() => stub.answer({ ...seatOnly, seat: 1, playerId: 1 }));
    only(container, m, 'seated-waiting-for-state', 'Seat 2, waiting for the state.');
  });

  it('refused: the server’s own word, once, and it outranks every hopeful branch', () => {
    const { stub, m, container, queryByTestId } = stubBoard();
    act(() => stub.fire('connect'));
    act(() => stub.answer({ error: 'seat-taken' }));

    expect(refusalOf(m)).toBe('seat-taken');
    expect(isMatchGone(m)).toBe(false);
    only(container, m, 'refused', 'Refused: seat-taken');
    // The state a refused join leaves behind — connected, no seat — is NOT
    // what is drawn: an outcome outranks a status.
    expect(m.connected).toBe(true);
    expect(m.seat).toBeNull();
    expect(queryByTestId('live-error')).toBeNull();
  });

  it('match-gone: unknown-match is not a status, and the three lines are one', () => {
    const { stub, m, container, queryByTestId, getByTestId } = stubBoard();
    act(() => stub.fire('connect'));
    act(() => stub.answer({ error: 'unknown-match' }));

    expect(isMatchGone(m)).toBe(true);
    only(container, m, 'match-gone', MATCH_GONE_SENTENCE);
    // The operator's three, as they were: the refusal, the seat line and the
    // waiting line. Exactly one of them is drawn now, and it is none of them.
    expect(container.textContent).not.toContain('Connected, not seated.');
    expect(container.textContent).not.toContain('Waiting for the game state.');
    expect(container.textContent).not.toContain('was refused');
    expect(queryByTestId('live-error')).toBeNull();
    // Item 5 deleted `Leave` and the `data-urgent` treatment that rode on it;
    // the status line's own `data-status="match-gone"` (asserted in `only`
    // above) is what is left to act on the state.
    expect(getByTestId('live-status').title).toContain('unknown-match');
  });

  /*
   * Wave 31 §L.5 — *"why can I still join this if the match is gone?"*. What the
   * page showed before: the one line AND the whole of the table's chrome — the
   * Log toggle and its empty logbook, the OK / Cancel / Full control / Settings /
   * Concede cluster — over nothing. Now: the server's sentence and ONE way back.
   */
  it('match-gone: the server’s sentence, one way back, and no board chrome or Join-shaped control', () => {
    const { stub, container, queryByTestId, getByTestId } = stubBoard();
    act(() => stub.fire('connect'));
    act(() => stub.answer({ error: 'unknown-match', outcome: 'match-gone', message: MATCH_GONE_MESSAGE }));

    expect(getByTestId('live-status').textContent).toBe(MATCH_GONE_SENTENCE);
    for (const id of ['live-buttons', 'live-log-toggle', 'live-logbook', 'live-concede', 'live-settings', 'live-full-control']) {
      expect(queryByTestId(id), `${id} is table chrome and there is no table`).toBeNull();
    }
    expect(container.querySelectorAll('button'), 'nothing to press, least of all something that says Join').toHaveLength(0);
    // The way back: no room on a `#/match/<id>` route, so the lobby.
    const back = getByTestId('live-gone-back') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('#/');
    expect(back.textContent).toBe('Back to the lobby');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('match-gone inside a room goes back to that room', () => {
    const stub = stubTransport();
    const m = (match = startMatch({ matchId: MATCH_ID, transport: stub.transport }));
    const { getByTestId } = render(createElement(LiveBoard, { match: m, roomId: 'room 7' }));
    act(() => stub.fire('connect'));
    act(() => stub.answer({ error: 'unknown-match' }));
    const back = getByTestId('live-gone-back') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('#/room/room%207');
    expect(back.textContent).toBe('Back to the room');
  });

  it('match-gone, from lane E’s ACTUAL ack: the outcome and the sentence do not make it malformed', () => {
    const { stub, m, container, queryByTestId } = stubBoard();
    act(() => stub.fire('connect'));
    // The shape the server really sends now (§E). With `MatchErrorSchema`
    // strict and one field, this parsed as malformed, `lastError` became
    // "answered with something that is not a snapshot", the seam found no
    // refusal word, and the board sat in `connected-not-seated` telling a
    // player whose match had ended that they were merely not seated.
    act(() => stub.answer({ error: 'unknown-match', outcome: 'match-gone', message: MATCH_GONE_MESSAGE }));

    // Nothing was recorded as malformed: this ack is a REFUSAL, not a broken one.
    expect(m.lastInvalid).toBeNull();
    expect(m.stats.invalid).toBe(0);
    expect(refusalOf(m)).toBe('unknown-match');
    expect(isMatchGone(m)).toBe(true);
    only(container, m, 'match-gone', MATCH_GONE_SENTENCE);
    expect(container.textContent).not.toContain('is not a snapshot');
    expect(queryByTestId('live-error')).toBeNull();
  });

  it('a gone match that the socket then drops is still gone, not connecting', () => {
    const { stub, m, container } = stubBoard();
    act(() => stub.fire('connect'));
    act(() => stub.answer({ error: 'unknown-match' }));
    act(() => stub.fire('disconnect'));
    expect(m.connected).toBe(false);
    only(container, m, 'match-gone', MATCH_GONE_SENTENCE);
  });

  it('the seam reads the refusal and nothing else: an unanswered ack is not a refusal', () => {
    const { m } = stubBoard();
    m.lastError = 'forge:join was not answered: operation has timed out';
    expect(refusalOf(m)).toBeNull();
    expect(isMatchGone(m)).toBe(false);
    m.lastError = 'forge:resync was refused: unknown-match';
    expect(refusalOf(m)).toBe('unknown-match');
    expect(isMatchGone(m)).toBe(true);
  });

  it('a failure INSIDE a live match still gets its own line — that is a different kind of thing', async () => {
    const { s, m, container, getByTestId } = await liveBoard();
    // A real failure through a real seam: an answer that fails its own wire
    // schema is refused by `answerAsk`, which is where this `lastError` comes
    // from in production too.
    s.send(confirmAsk('c-bad', true));
    await waitFor(() => getByTestId('confirm-dialog'));
    act(() => {
      expect(answerAsk(m, 'c-bad', 'showConfirmDialog', 'not a boolean')).toBe(false);
    });
    expect(liveStatus(m)).toBe('live');
    // The ONE line a live board can draw: the state line above it is gone (§B.5),
    // so a failure inside a live match is now the only thing that speaks.
    expect(lines(container)).toEqual([
      'refused to send an answer to showConfirmDialog that fails its wire schema',
    ]);
    expect(getByTestId('live-error')).toBeTruthy();
    expect(await s.framesFrom(m)).toEqual([]);
  });
});

/*
 * Item 5 (wave 30) — `Leave` is deleted; `Concede` is enough.
 *
 * *"delete the Leave button. Concede is enough."* Wave 22 §F.1 used to put
 * `Leave` in the bar and assert it sat off Forge's two answers, was keyboard
 * reachable and was not inside the canvas. What remains to assert is that it
 * is truly gone — not disabled, not hidden, ABSENT — and that the cluster's
 * shape and the canvas guard around it still hold with one fewer child.
 * `Concede`'s own coverage (§C.4, below) already proves it is keyboard
 * reachable and pressable with a question open, so nothing here duplicates
 * that.
 */
describe('Leave is deleted (item 5); Concede is the cluster’s only own control', () => {
  it('Leave is nowhere — no test id, no label', async () => {
    const { container, queryByTestId } = await liveBoard();
    expect(queryByTestId('live-leave')).toBeNull();
    expect(container.textContent).not.toContain('Leave');
  });

  it('Concede is in the cluster, kept off Forge’s two answers, and not inside the board', async () => {
    const { s, m, container, getByTestId } = await liveBoard();
    // The calm indicator is now a server FACT, not an inference
    // from the viewer's own bar — see `sendTheirWaitingOn`'s own note.
    await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
    const concede = getByTestId('live-concede');
    const bar = getByTestId('live-buttons');
    expect(concede.tagName).toBe('BUTTON');
    expect(bar.contains(concede)).toBe(true);
    // Not adjacent to End Turn: Full control stands between, so a reach for
    // Concede is never a misclick on Forge's button.
    const order = [...bar.children].map((el) => (el as HTMLElement).dataset.testid);
    expect(order.indexOf('live-full-control'), 'Full control stands between Forge’s answers and Concede').toBe(
      order.indexOf('live-concede') - 1,
    );
    expect(container.querySelector('.board')!.contains(concede)).toBe(false);
    // The cluster still holds five children — item 7 put `Settings` in the
    // slot item 5's deletion of `Leave` vacated — and is still a sibling of
    // the board, drawn after it: the chrome is around the canvas, not in it.
    // The waiting pop-out trails (moved off the top line
    // into the decision-area `.live__prompt` slot every other pop-up uses):
    // the opponent's own `waitingOn` fact, sent above, is what makes it draw
    // — see `isWaitingForOpponent`'s own test.
    const live = container.querySelector('.live')!;
    expect(standingChildren(live)).toEqual([
      'board',
      'live__phases',
      'live__logbook',
      'live__log-button',
      'live__buttons',
      'live__prompt',
    ]);
    expect(bar.querySelectorAll('button')).toHaveLength(3);
  });

  /*
   * The canvas is lane C's. This lane's stylesheet may dress the chrome around
   * it and must not reach inside it, so the guard is on the stylesheet itself:
   * every selector in `live.css` that names a board part is one that was
   * already there, with the reason written above it. A new one goes red here.
   */
  it('live.css reaches into the canvas in exactly the places it already did', () => {
    // `import.meta.dirname` and not `import.meta.url`: under jsdom the URL is
    // not a file one. Same read as `Board.test.ts`'s own CSS guard.
    const css = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/live', 'live.css'), 'utf8');
    const selectors = css
      .split('}')
      .map((rule) => rule.slice(0, rule.indexOf('{')))
      .map((sel) => sel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim())
      .filter((sel) => sel !== '' && !sel.startsWith('@'));
    // A board part: `.board`, a card class, a seat, a zone. `.cardtable-chrome`
    // is the page's own wrapper and not one of them.
    const canvas = /\.board\b|\.card\b|\.card__|\.seat\b|\[data-zone/;
    expect(selectors.filter((sel) => canvas.test(sel))).toEqual([
      '.live > .board',
      '.live .board',
    ]);
  });
});

/*
 * ── Wave 24 §C: the frame gets out of the way ─────────────────────────────
 *
 * Four items, and three of them are about LAYOUT, which jsdom has none of. So
 * each is split the only honest way:
 *
 *  - what is in the DOM and what it is a sibling of, asserted here;
 *  - what BOX it gets, asserted on `live.css`'s own declarations here (the
 *    source is the truth about the rule; jsdom applies no stylesheet at all,
 *    so `getComputedStyle` would agree with any rule whatsoever) and measured
 *    for real, on every animation frame of a live match, by
 *    `e2e/table-fit.spec.ts`.
 *
 * Concede is the exception and is asserted end to end, because it is a safety
 * control: what reaches the WIRE is the whole claim.
 */

/**
 * `live.css` as text. Shared by the rule assertions below and by the canvas
 * guard above it.
 */
const liveCss = (): string => readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/live', 'live.css'), 'utf8');

/**
 * `live.css` on the document for this test, and a reader of what the cascade
 * gives a rendered element. jsdom resolves the cascade and lays nothing out, so
 * a test reads a keyword or compares two elements; where a box lands is
 * `e2e/table-fit.spec.ts`'s.
 */
function styled(): (el: Element, property: string) => string {
  const sheet = document.createElement('style');
  sheet.textContent = liveCss();
  document.head.append(sheet);
  onTestFinished(() => sheet.remove());
  return (el, property) => getComputedStyle(el).getPropertyValue(property).trim();
}

/** One rule's declarations, by its selector, comments stripped and whitespace collapsed. */
function declarations(css: string, selector: string): string {
  for (const rule of css.split('}')) {
    const at = rule.indexOf('{');
    if (at < 0) continue;
    const clean = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (clean(rule.slice(0, at)) === selector) return clean(rule.slice(at + 1));
  }
  throw new Error(`live.css has no rule for ${selector}`);
}

/*
 * §C.1 — the control bar stops being a bar.
 *
 * The operator accepted its CONTENTS and rejected its SHAPE. So the contents
 * are asserted to be all still there, in ONE container, and the shape is
 * asserted to be a corner cluster out of the flex flow.
 *
 * `e2e/table-fit.spec.ts` is the other half and it is strict: *"once the board
 * is drawn, `live-buttons` has a nonzero box that lies inside the viewport,
 * with its buttons in it, and that box is at the
 * SAME place and size in every frame at a given window size — a fixed home, not
 * a bar on demand."* Every fixed track below is that sentence.
 *
 * Wave 25 §C: the cluster keeps every CONTROL and has no text in it at all.
 */
describe('the controls are a cluster over the board, not a bar under it', () => {
  it('is ONE container, and every control the operator kept is inside it', async () => {
    const { container, getByTestId } = await liveBoard();
    const cluster = getByTestId('live-buttons');
    // The spec queries `live-buttons` and then looks INSIDE it, so a second
    // container, or one of these drawn as a sibling, is a red e2e.
    expect(container.querySelectorAll('[data-testid="live-buttons"]')).toHaveLength(1);
    for (const id of ['live-button-end-turn', 'live-full-control', 'live-concede']) {
      expect(cluster.querySelector(`[data-testid="${id}"]`), `the cluster still holds ${id}`).not.toBeNull();
    }
    // Passing priority is the decision pop-up's: the cluster has no Next Phase.
    expect(cluster.querySelector('[data-testid="live-button-next-phase"]')).toBeNull();
    // Wave 32 Q15 took Settings out: it opens from your own face now.
    expect(cluster.querySelector('[data-testid="live-settings"]')).toBeNull();
    // Item 5 deleted `Leave`: the cluster no longer holds it at all.
    expect(cluster.querySelector('[data-testid="live-leave"]')).toBeNull();
    /*
     * And in the order they are DRAWN (wave 27 §B.1). The cluster is one
     * column, so the tab order and the reading order are the same order —
     * `Settings` (item 7) is written in the slot `Leave` vacated.
     */
    expect([...cluster.querySelectorAll('button')].map((b) => b.dataset.testid)).toEqual([
      'live-button-end-turn',
      'live-full-control',
      'live-concede',
    ]);
    /*
     * The log's toggle is NOT in it any more (§B.4): the operator drew the cluster
     * 112 wide with five buttons and drew the log as its own 36 × 32 button
     * further up the gutter. It is still the same disclosure, still naming the
     * same panel — the box it lives in changed, not what it does.
     */
    const log = getByTestId('live-log-toggle');
    expect(cluster.contains(log)).toBe(false);
    expect(log.tagName).toBe('BUTTON');
    expect(log.getAttribute('aria-controls')).toBe(getByTestId('live-logbook').id);
  });

  /*
   * §C.1 — *"i mostly hate all the text in the bottom right it's totally
   * useless"*, and *"i hate the log, the log must go somewhere else."*
   *
   * So the claim is two-sided and both sides are asserted: no text is in the
   * corner, and the text is somewhere — the log is MOVED, not deleted, because
   * it is what carries `paid U — Volcanic Island` and a cast must never look
   * free.
   */
  it('has no PROSE in it — Forge’s line and the log are out of the corner, and still on the page', async () => {
    const { container, getByTestId } = await liveBoard();
    const cluster = getByTestId('live-buttons');
    for (const id of ['live-says', 'live-log']) {
      expect(cluster.querySelector(`[data-testid="${id}"]`), `${id} is out of the corner`).toBeNull();
    }
    // Every child of the cluster is a button now: nothing in it can be text that
    // grows, which is the other half of "one box at one window size". Still
    // five: item 7 put `Settings` where item 5's deletion of `Leave` left a gap.
    expect([...cluster.children].map((el) => el.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    // And both moved into the logbook, which is not inside the cluster.
    const logbook = getByTestId('live-logbook');
    expect(cluster.contains(logbook)).toBe(false);
    for (const id of ['live-says', 'live-log']) {
      expect(logbook.querySelector(`[data-testid="${id}"]`), `${id} has a home`).not.toBeNull();
    }
    expect(container.querySelectorAll('[data-testid="live-says"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="live-log"]')).toHaveLength(1);
  });

  /*
   * The logbook is a disclosure: collapsed by default, and the toggle in the
   * cluster is what opens it. `hidden` rather than unmounted, so `aria-controls`
   * names a node that exists and the panel's own content is readable before it
   * is ever opened.
   */
  it('the logbook is collapsed until the cluster’s toggle opens it, and never leaves the DOM', async () => {
    const { getByTestId } = await liveBoard();
    const toggle = getByTestId('live-log-toggle') as HTMLButtonElement;
    const logbook = getByTestId('live-logbook');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(logbook.id);
    expect(logbook.hasAttribute('hidden')).toBe(true);

    fireEvent.click(toggle);
    await waitFor(() => expect(logbook.hasAttribute('hidden')).toBe(false));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    await waitFor(() => expect(logbook.hasAttribute('hidden')).toBe(true));
    // The collapsed rule is the one that has to be written down: `display: flex`
    // on the panel outranks the UA's own `[hidden]`, so without it a collapsed
    // panel would draw.
    expect(declarations(liveCss(), '.live__logbook[hidden]')).toContain('display: none');
  });

  // The operator, 2026-10-07: "clicking outside of the log should close the log, also clicking ESC could close the log".
  it('the open logbook closes on a press outside it and on Escape, and stays open for a press inside it', async () => {
    const { getByTestId, container } = await liveBoard();
    const toggle = getByTestId('live-log-toggle') as HTMLButtonElement;
    const logbook = getByTestId('live-logbook');
    fireEvent.click(toggle);
    await waitFor(() => expect(logbook.hasAttribute('hidden')).toBe(false));
    fireEvent.pointerDown(logbook, { button: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(logbook.hasAttribute('hidden'), 'a press inside leaves it open').toBe(false);
    fireEvent.pointerDown(container.querySelector('.board')!, { button: 0 });
    await waitFor(() => expect(logbook.hasAttribute('hidden')).toBe(true));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    await waitFor(() => expect(logbook.hasAttribute('hidden')).toBe(false));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    await waitFor(() => expect(logbook.hasAttribute('hidden')).toBe(true));
    expect(escape.defaultPrevented, 'Escape is not consumed: a prompt that wants it still gets it').toBe(false);
  });

  // The operator, 2026-10-07, on the log: "why is there this tiny little scrollbar here?" — the status block's own cap, inside the panel.
  it('inside the logbook the status block does not scroll on its own: the list is the one scroll owner', () => {
    expect(declarations(liveCss(), '.live__logbook > .live__says')).toContain('overflow: visible');
    expect(declarations(liveCss(), '.live__logbook > .live__says')).toContain('max-height: none');
  });

  /*
   * The logbook is a wide overlay over the main view, not a narrow strip
   * pinned to one edge, and it is out of flow so it moves and blocks nothing
   * underneath it either way.
   */
  it('the logbook is a wide overlay over the main view, starting at the left edge', async () => {
    const { container, getByTestId } = await liveBoard();
    expect(container.querySelector('.board')!.contains(getByTestId('live-logbook'))).toBe(false);
    const decls = declarations(liveCss(), '.live__logbook');
    expect(decls).toContain('position: absolute');
    // On the LEFT, which is the edge the phase rail vacated (§C.4) — still
    // where it STARTS, just no longer the whole of its box.
    expect(decls).toContain('left: 6px');
    // No fixed `width` any more: `right` reaches across instead, which is what
    // makes this an overlay over the main view rather than a side-bar.
    expect(decls, 'no left-side-bar width').not.toContain('width:');
    expect(decls).toContain('right: calc(var(--live-rail-w) + var(--live-gutter) + 6px)');
    /*
     * §B.4 — it opens to the FULL HEIGHT of the match (the operator's own). Both
     * insets, so the height is definite and an overfull panel clips inside itself
     * instead of growing the match's scroll box — which the fit spec reads as a
     * breach — and the six pixels are what keep it inside the window.
     */
    expect(decls).toContain('top: 6px');
    expect(decls).toContain('bottom: 6px');
    expect(decls, 'a content cap would make the height indefinite again').not.toContain('max-height');
    expect(decls).toContain('overflow: hidden');
    // Under lane A's overlay root at z 2, like the rail.
    expect(decls).toContain('z-index: 1');
  });

  /*
   * Pointer events: collapsed, it must not steal the drag gesture from
   * whatever board it covers — the same reason the phase rail is
   * pointer-transparent. Open, it is a scrollable panel the player asked to
   * see, and a pointer-transparent box cannot be scrolled by hand.
   */
  it('the logbook takes no pointer events while closed, and is interactive while open', async () => {
    const { getByTestId } = await liveBoard();
    const toggle = getByTestId('live-log-toggle') as HTMLButtonElement;
    const logbook = getByTestId('live-logbook');
    expect(logbook.hasAttribute('hidden')).toBe(true);
    expect(declarations(liveCss(), '.live__logbook')).toContain('pointer-events: none');
    expect(declarations(liveCss(), '.live__logbook:not([hidden])')).toContain('pointer-events: auto');

    fireEvent.click(toggle);
    await waitFor(() => expect(logbook.hasAttribute('hidden')).toBe(false));
    // A closed panel is `display: none` (asserted above) and so is never a
    // pointer target regardless of this rule; `:not([hidden])` is the one
    // state in which `auto` ever applies, and it is the open one.
  });

  /*
   * Scrollable, and the newest line stays in view. jsdom lays nothing out, so
   * the scroll POSITION cannot be asserted end to end — only that the effect
   * runs without throwing against a real ref, and that the stylesheet gives
   * `.live__log` the bounded, scrolling box the effect depends on.
   */
  it('the log list is the scroll owner, and opening it scrolls to the newest line', async () => {
    const { s, getByTestId } = await liveBoard();
    for (let i = 1; i <= 5; i += 1) {
      s.send(parseServerFrame({ kind: 'notify', method: 'message', message: `line ${i}`, title: '' }));
    }
    const list = getByTestId('live-log') as HTMLUListElement;
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(5));
    // jsdom never gives an element real scroll dimensions (both read 0), so
    // this cannot observe the scroll POSITION end to end — only that nothing
    // throws when the effect runs against a real ref, both on open and on a
    // line arriving while already open.
    const toggle = getByTestId('live-log-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(getByTestId('live-logbook').hasAttribute('hidden')).toBe(false));
    s.send(parseServerFrame({ kind: 'notify', method: 'message', message: 'line 6', title: '' }));
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(6));

    const decls = declarations(liveCss(), '.live__log');
    expect(decls).toContain('overflow-y: auto');
    expect(decls, 'scrolling needs a bounded box, not a content-sized one').toContain('flex: 1 1 0');
  });

  it('is out of the flow, so the table has the height back', async () => {
    const css = styled();
    const { getByTestId } = await liveBoard();
    expect(css(getByTestId('live-buttons'), 'position')).toBe('absolute');
  });

  it('every slot in it is a fixed track, so one window size can never see two boxes', async () => {
    const css = styled();
    const { getByTestId } = await liveBoard();
    const cluster = getByTestId('live-buttons');
    /*
     * A track sized by its content is exactly how the box changes between
     * frames — a longer button label from Forge. `1fr` IS such a track
     * (`minmax(auto, 1fr)`), so no track may be `auto`, content-sized or a bare fraction.
     */
    for (const prop of ['grid-template-rows', 'grid-template-columns']) {
      expect(css(cluster, prop), prop).not.toBe('');
      expect(css(cluster, prop), prop).not.toMatch(/(^|[\s(])(auto|min-content|max-content|fit-content|\d+fr)(?![^(]*\))/);
    }
    // The ellipsis stays, as the last resort for a label Forge chose; `e2e/table-fit.spec.ts` proves none of ours clips.
    for (const button of cluster.querySelectorAll('button')) expect(css(button, 'text-overflow')).toBe('ellipsis');
  });

  /*
   * The invariant two other things rest on, and it was wrong once.
   *
   * `--live-controls-h` is the cluster's `height`, and the cluster's tracks are
   * pixels, so the token has to be their sum. (The prompt host used to subtract it
   * as well; §B.1 gave the question a column of its own, so the cluster's height
   * is now this box's business alone — the invariant below is unchanged.) It was `9.75rem`, which is that sum at a
   * 16px root font size and nothing else — measured in Chrome, the tracks that
   * needed 153px got 136px at a 14px root and 195px at 20px. So the token is
   * pixels, and this adds them up rather than trusting a literal.
   *
   * Wave 25 §C took two 34px text rows and a gap out, and wave 26 §B.3 shrank the
   * box to the 112 × 84 the operator drew and moved the log's button out of it.
   * Wave 27 §B.1 gave each of the five buttons a row of its own — two columns of
   * 49px clipped `Full control` and `Concede` — so the sum was 136. Item 5
   * (wave 30) deleted `Leave` and item 7 put `Settings` in its slot, so the
   * cluster is still five rows and the sum is still 136.
   */
  it('the height token is the exact sum of the cluster’s own tracks, in pixels', () => {
    const css = liveCss();
    const cluster = declarations(css, '.live__buttons');
    const rows = /grid-template-rows: ([^;]+);/.exec(cluster)?.[1];
    expect(rows, 'the cluster declares explicit rows').toBeDefined();
    // `minmax(22px, 1fr)` contributes its 22px floor; nothing here is content-sized.
    const tracks = Array.from({ length: Number(/repeat\((\d+), (\d+)px\)/.exec(rows!)?.[1]) }, () =>
      Number(/repeat\((\d+), (\d+)px\)/.exec(rows!)?.[2]),
    );
    expect(tracks).toEqual([22, 22, 22]);
    const padY = Number(/padding: (\d+)px/.exec(cluster)?.[1]);
    const gap = Number(/gap: (\d+)px/.exec(cluster)?.[1]);
    const token = Number(/--live-controls-h: (\d+)px/.exec(declarations(css, '.live'))?.[1]);
    const border = 1;
    expect(
      tracks.reduce((a, b) => a + b, 0) + gap * (tracks.length - 1) + padY * 2 + border * 2,
      'padding + border + rows + gaps === --live-controls-h',
    ).toBe(token);
  });
});

/*
 * §C.2 — a vertical phase indicator.
 *
 * Presentation only: every value here is read back off the same `match.view`
 * the turn bar draws, and the test asserts they agree rather than asserting a
 * literal — a fixture whose turn changes must not need this file edited.
 */
describe('the phase reads down the side', () => {
  const steps = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.live__step')];

  it('draws the turn’s steps — combat as one — and marks the one the game is on', async () => {
    const { m, container } = await liveBoard();
    const all = steps(container);
    expect(all).toHaveLength(8);
    const current = all.filter((el) => el.hasAttribute('data-current'));
    expect(current).toHaveLength(1);
    // The phase the VIEW is on, and our own word for it. It used to be compared
    // against the turn bar's `phase`; §A deleted the bar, so the view is the
    // source both sides used anyway.
    expect(current[0]!.dataset.phase).toBe('MAIN1');
    expect(m.view!.phase).toBe('MAIN1');
    expect(current[0]!.getAttribute('aria-current')).toBe('step');
    expect(current[0]!.textContent).toBe(PHASE_LABEL['MAIN1']);
    expect(currentStep(container)?.textContent).toBe('Main 1');
    // A turn in progress: the steps before it are past, the ones after are not.
    const at = all.indexOf(current[0]!);
    expect(all.slice(0, at).every((el) => el.hasAttribute('data-past'))).toBe(true);
    expect(all.slice(at).some((el) => el.hasAttribute('data-past'))).toBe(false);
  });

  /*
   * §B.2 — every step SAYS its name now. At 32px the rail could draw the current
   * one only and every other name was clipped; the operator widened it to 8.4% so
   * the thirteen could be read. The names are `PHASE_LABEL`'s and this lane renames
   * none of them.
   */
  it('every step says its name — outside combat, combat is ONE of them (wave 31 P1)', async () => {
    const { container } = await liveBoard();
    expect(steps(container).map((el) => el.textContent)).toEqual([
      'Untap',
      'Upkeep',
      'Draw',
      'Main 1',
      'Combat',
      'Main 2',
      'End step',
      'Cleanup',
    ]);
  });

  it('says which turn and whose, off the view and nothing else', async () => {
    const { m, getByTestId } = await liveBoard();
    const view = m.view!;
    const active = view.players.find((p) => p.id === view.activePlayerId);
    const whose = active === undefined ? 'nobody' : active.isViewer ? 'yours' : 'theirs';
    expect(getByTestId('live-phases').dataset.whose).toBe(whose);
    // Q1: the number alone — the name under it is gone.
    expect(getByTestId('live-turn').textContent).toBe(String(view.turn));
    /*
     * The turn number on its own, and the same number on the rail's own dataset:
     * this is the ONLY turn indicator on the page now that §A has deleted
     * `.board__bar`, and `e2e/play.spec.ts` and `e2e/table-fit.spec.ts` read both
     * of these — a number they parsed out of "Turn 14" before.
     */
    expect(getByTestId('live-turn-n').textContent).toBe(String(view.turn));
    expect(getByTestId('live-phases').dataset.turn).toBe(String(view.turn));
  });

  it('is out of flow beside the canvas and takes no pointer events, so it moves and blocks nothing', async () => {
    const { container, getByTestId } = await liveBoard();
    const rail = getByTestId('live-phases');
    expect(container.querySelector('.board')!.contains(rail)).toBe(false);
    const css = styled();
    expect(css(rail, 'position')).toBe('absolute');
    expect(css(rail, 'pointer-events')).toBe('none');
    // A short window clips trailing rows rather than shrinking every row.
    expect(css(rail, 'overflow')).toBe('hidden');
  });

});

/*
 * §C.3 — a prompt belongs where the player is looking.
 *
 * Teetering Peaks' ask *"appeared as text at the bottom of the screen"*. Where
 * it sits is this lane's; what it looks like inside is lane D's.
 */
describe('a prompt belongs where the player is looking', () => {
  it('the host is a column over the board with the sheet centred in it, and takes no click the sheet does not', async () => {
    const css = styled();
    const { s, getByTestId } = await liveBoard();
    s.send(confirmAsk('c-host', true));
    const host = await waitFor(() => getByTestId('live-prompt'));
    expect(css(host, 'position')).toBe('absolute');
    expect(css(host, 'align-items')).toBe('center');
    expect(css(host, 'justify-content')).toBe('center');
    // The host covers the board, so it must not swallow the table's clicks; the sheet takes them back.
    expect(css(host, 'pointer-events')).toBe('none');
    expect(css(host.firstElementChild!, 'pointer-events')).not.toBe('none');
  });

  it('an open prompt is a sibling of the board, drawn last — nothing in the canvas moves for it', async () => {
    const { s, container, getByTestId } = await liveBoard();
    s.send(confirmAsk('c-centre', true));
    await waitFor(() => getByTestId('live-prompt'));
    // No `live__status`: a live board draws no line about itself (§B.5). The log's
    // button is its own child of `.live` now, not the cluster's (§B.4).
    expect(standingChildren(container.querySelector('.live')!)).toEqual([
      'board',
      'live__phases',
      'live__logbook',
      'live__log-button',
      'live__buttons',
      'live__prompt',
    ]);
    expect(container.querySelector('.board')!.contains(getByTestId('live-prompt'))).toBe(false);
  });
});

/*
 * ── Wave 25 §C.2: a payment is a question, so it is drawn as one ───────────
 *
 * The operator hit a Mana Leak and got `Pay Mana Cost: {3}` buried in the
 * corner's multi-line blob, with the cluster's OK and Cancel underneath it as
 * its answers: *"if an effect happens that is necessary, it should popout into
 * its own popover modal on top of the game not in some text box."*
 *
 * A payment is not one of Forge's `ask` methods — it is `showPromptMessage`
 * plus `updateButtons`, which is why it had no window. `match.ts`'s
 * `payingMana` already names that state off four facts, and these cases drive it
 * with the frames a real Forge sends (`InputPayMana`'s own `Auto` bar, a prompt
 * that names the ability being paid for, and the actionable set that makes the
 * input live) and assert where the text comes out.
 */
describe('a mana payment pops out of the corner', () => {
  const payBar = (enable1: boolean) =>
    parseServerFrame({
      kind: 'notify',
      method: 'updateButtons',
      owner: { kind: 'player', id: 0 },
      label1: 'Auto',
      label2: 'Cancel',
      enable1,
      enable2: true,
      focus1: enable1,
    });
  const payPrompt = (message: string, cardId: number) =>
    parseServerFrame({
      kind: 'notify',
      method: 'showPromptMessage',
      player: { kind: 'player', id: 0 },
      message,
      card: { kind: 'card', id: cardId },
    });
  const actionable = (ids: number[]) =>
    parseServerFrame({ kind: 'notify', method: 'setWeaklySelectable', cards: ids.map((id) => ({ kind: 'card', id })) });

  /** Into the payment input, exactly as Forge enters it. */
  async function payment(enable1 = true) {
    const live = await liveBoard();
    const mine = live.m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    for (const f of [payBar(enable1), payPrompt('Mana Leak - Counter target spell.\n\nPay Mana Cost: {3}', mine[0]!), actionable(mine)]) {
      live.s.send(f);
    }
    await untilMatch(live.m, () => expect(live.m.promptCard).toBe(mine[0]!));
    return live;
  }

  it('a split payment says the mana first, and what it pays for as its own line under it', async () => {
    const live = await liveBoard();
    const mine = live.m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const parts = { question: 'Pay Mana Cost: {3}', context: 'Mana Leak - Counter target spell.', input: 'pay' };
    for (const f of [payBar(true), parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Mana Leak - Counter target spell.\n\nPay Mana Cost: {3}', card: { kind: 'card', id: mine[0]! }, parts }), actionable(mine)])
      live.s.send(f);
    const sheet = await waitFor(() => live.getByTestId('live-payment'));
    expect(sheet.querySelector('.confirm__message')?.textContent).toBe('Pay Mana Cost: ');
    expect(sheet.querySelector('.confirm__message i.ms.ms-3')).not.toBeNull();
    const context = live.getByTestId('prompt-source-text');
    expect(context.textContent).toBe('Mana Leak - Counter target spell.');
    expect(sheet.querySelector('.confirm__message')!.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the sheet, with Forge’s own text and Forge’s own two labels', async () => {
    const { getByTestId, queryByTestId } = await payment();
    const sheet = await waitFor(() => getByTestId('live-payment'));
    // The whole claim: the payment is IN the same host the other questions use,
    // not in a line in the corner — and that host is the fixed column §B.1 gave
    // every question, so a payment appears where a player has learned to look.
    const host = getByTestId('live-payment-host');
    expect(host.contains(sheet)).toBe(true);
    expect(host.className).toBe('live__prompt');
    expect(declarations(liveCss(), '.live__prompt')).toContain('left: var(--live-col-x)');
    expect(sheet.textContent).toContain('Pay Mana Cost:');
    // The cost is the Mana font's symbol, never the bare digit (operator, 2026-10-06: "show the actual mana cost icons").
    expect(sheet.querySelector('.confirm__message i.ms.ms-3')).not.toBeNull();
    expect(sheet.textContent).toContain('Mana Leak');
    // Forge's labels, not ours.
    expect(getByTestId('live-payment-ok').textContent).toBe('Auto');
    expect(getByTestId('live-payment-cancel').textContent).toBe('Cancel');
    // Auto/Cancel is not a yes/no, so the two sit together at the right, Forge's button one first
    // (the operator, 2026-10-24: "let's keep the left/right decisions only for yes/no").
    const row = sheet.querySelector<HTMLElement>('.answers')!;
    expect(row.dataset.pair).toBeUndefined();
    expect(row.firstElementChild).toBe(getByTestId('live-payment-ok'));
    expect(row.lastElementChild).toBe(getByTestId('live-payment-cancel'));
    /*
     * And it is NOT `live-prompt`. That id means "one of Forge's fifteen asks is
     * open" to three e2e readers — `e2e/play/prompts.ts` switches on the host's
     * `data-method` and THROWS when there is none, and `table-fit`'s stuck
     * detector leaves an open prompt alone. A payment wearing that id would break
     * two other lanes' specs and wedge a real game.
     */
    expect(queryByTestId('live-prompt')).toBeNull();
    expect(host.hasAttribute('data-method')).toBe(false);
  });

  it('a cost Forge lets the payer pay with life gets a life button, and only that cost', async () => {
    const live = await payment(false);
    const { getByTestId, queryByTestId } = live;
    expect(queryByTestId('live-payment-life')).toBeNull();
    const mine = live.m.view!.players.find((p) => p.isViewer)!;
    live.s.send(payBar(false));
    live.s.send(payPrompt('Gitaxian Probe\n\nPay Mana Cost: {U/P}\n(Click on your life total to pay life for phyrexian mana.)', mine.battlefield[0]!.id));
    const life = await waitFor(() => getByTestId('live-payment-life'));
    // What one press costs, in the Phyrexian symbol; Forge's "click on your life total" is not repeated.
    expect(life.textContent).toBe(' 2 life');
    expect(life.querySelector('i.ms.ms-p')).not.toBeNull();
    expect(getByTestId('live-payment').textContent).not.toMatch(/life total/i);
    expect(getByTestId('live-payment').textContent).toContain('Pay Mana Cost:');
    expect(life.hasAttribute('disabled')).toBe(false);
    const before = live.s.clientFrames().length;
    fireEvent.click(life);
    await live.s.untilClientFrames(before + 1);
    expect(live.s.clientFrames().at(-1)).toMatchObject({ ok: true, value: { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: mine.id } } });
    // Refused until Forge answers the press.
    await waitFor(() => expect(getByTestId('live-payment-life').hasAttribute('disabled')).toBe(true));
  });

  /*
   * THE REGRESSION, as the operator met it: the payment's text in the corner,
   * with the cluster's buttons as its only answers. The corner has no text row
   * at all now, so this is asserted as an absence in the cluster and a presence
   * in the sheet — reverting either half turns it red.
   */
  it('and NOT a corner line: the cluster holds no text about the payment', async () => {
    const { getByTestId } = await payment();
    await waitFor(() => getByTestId('live-payment'));
    const cluster = getByTestId('live-buttons');
    expect(cluster.textContent, 'the corner says nothing about the cost').not.toContain('Pay Mana Cost');
    expect(cluster.querySelector('[data-testid="live-says"]')).toBeNull();
    // The message is readable exactly once on the page — in the sheet. The
    // logbook's copy of Forge's line is collapsed and is the same one line.
    expect(getByTestId('live-payment').textContent).toContain('Pay Mana Cost:');
    expect(getByTestId('live-payment').querySelector('i.ms.ms-3')).not.toBeNull();
    expect(getByTestId('live-logbook').hasAttribute('hidden')).toBe(true);
  });

  it('its buttons are the same sender as the cluster’s: one press, one act, and the window is gone', async () => {
    const { s, m, getByTestId, queryByTestId } = await payment();
    await waitFor(() => getByTestId('live-payment'));
    fireEvent.click(getByTestId('live-payment-ok'));
    await untilMatch(m, () => expect(m.stats.replies).toBe(1));
    await s.caughtUp(m);
    expect(s.clientFrames().map((f) => (f.ok && f.value.kind === 'act' ? f.value.method : null))).toEqual(['selectButtonOk']);
    // `pressButton` ends the input as well as answering it, so the payment state
    // is over and the window goes with it — there is nothing left to press twice.
    await waitFor(() => expect(queryByTestId('live-payment')).toBeNull());
    expect(m.inputLive).toBe(false);
    expect(m.stats.replies).toBe(1);
  });

  /* And Cancel is the other of Forge's two answers, through the same sender. */
  it('Cancel sends Forge’s own cancel and nothing else', async () => {
    const { s, m, getByTestId, queryByTestId } = await payment();
    await waitFor(() => getByTestId('live-payment'));
    fireEvent.click(getByTestId('live-payment-cancel'));
    await untilMatch(m, () => expect(m.stats.replies).toBe(1));
    await s.caughtUp(m);
    expect(s.clientFrames().map((f) => (f.ok && f.value.kind === 'act' ? f.value.method : null))).toEqual(['selectButtonCancel']);
    await waitFor(() => expect(queryByTestId('live-payment')).toBeNull());
  });

  /*
   * A cost that cannot be auto-paid is exactly when the player taps sources on
   * the board, so the window is still up and still says the cost — it just has
   * no default answer. `payingMana` does not require `enable1` for the same
   * reason (`match.ts`).
   */
  it('a cost Forge cannot auto-pay still gets the window, with no default answer', async () => {
    const { getByTestId } = await payment(false);
    const sheet = await waitFor(() => getByTestId('live-payment'));
    expect(sheet.textContent).toContain('Pay Mana Cost:');
    // The cost is the Mana font's symbol, never the bare digit (operator, 2026-10-06: "show the actual mana cost icons").
    expect(sheet.querySelector('.confirm__message i.ms.ms-3')).not.toBeNull();
    const ok = getByTestId('live-payment-ok') as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    expect(ok.hasAttribute('data-default')).toBe(false);
    expect((getByTestId('live-payment-cancel') as HTMLButtonElement).disabled).toBe(false);
  });

  /* Priority is not a payment: the window closes the moment the input ends. */
  it('closes when Forge moves on, even while the stale Auto bar is still standing', async () => {
    const { s, queryByTestId, getByTestId } = await payment();
    await waitFor(() => getByTestId('live-payment'));
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'showPromptMessage',
        player: { kind: 'player', id: 0 },
        message: 'Priority: you\nTurn: 14\nPhase: Main 1\nStack: Empty',
        card: null,
      }),
    );
    await waitFor(() => expect(queryByTestId('live-payment')).toBeNull());
    expect(queryByTestId('live-payment-host')).toBeNull();
  });
});

/*
 * §C.4 — Concede.
 *
 * `concede` has been on the wire since the beginning and has never had a
 * button. It is destructive and irreversible, so every assertion here is about
 * what did or did not reach the WIRE: the button sends nothing, cancel sends
 * nothing, and the confirmation's own yes is the one and only path.
 */
describe('Concede asks first', () => {
  it('the button sends NOTHING — it opens a confirmation', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    const button = getByTestId('live-concede') as HTMLButtonElement;
    expect(getByTestId('live-buttons').contains(button)).toBe(true);
    expect(queryByTestId('live-concede-ask')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button);
    const ask = await waitFor(() => getByTestId('live-concede-ask'));
    // The claim: pressing Concede put nothing on the wire.
    expect(await s.framesFrom(m)).toEqual([]);
    expect(m.stats.replies).toBe(0);
    expect(ask.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(ask.textContent).toContain('You lose this game.');
    // The safe button has the focus: Enter on a dialog nobody read must not end
    // the game.
    expect(document.activeElement).toBe(getByTestId('live-concede-no'));
  });

  it('its two answers sit together at the right, Cancel at the edge: Concede/Cancel is not a yes/no', async () => {
    const { getByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-concede'));
    const ask = await waitFor(() => getByTestId('live-concede-ask'));
    const row = ask.querySelector<HTMLElement>('.answers')!;
    expect(row.dataset.pair).toBeUndefined();
    expect(row.firstElementChild).toBe(getByTestId('live-concede-yes'));
    expect(row.lastElementChild).toBe(getByTestId('live-concede-no'));
  });

  it('cancel closes it and sends nothing', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-concede'));
    await waitFor(() => getByTestId('live-concede-ask'));
    fireEvent.click(getByTestId('live-concede-no'));
    await waitFor(() => expect(queryByTestId('live-concede-ask')).toBeNull());
    expect(await s.framesFrom(m)).toEqual([]);
    expect(m.stats.replies).toBe(0);
  });

  it('escape is cancel, and sends nothing', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-concede'));
    const ask = await waitFor(() => getByTestId('live-concede-ask'));
    fireEvent.keyDown(ask, { key: 'Escape' });
    await waitFor(() => expect(queryByTestId('live-concede-ask')).toBeNull());
    expect(await s.framesFrom(m)).toEqual([]);
  });

  it('the confirmation’s own yes is the one thing that reaches the wire, exactly once', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-concede'));
    await waitFor(() => getByTestId('live-concede-ask'));
    fireEvent.click(getByTestId('live-concede-yes'));
    await s.untilClientFrames(1);
    expect(s.clientFrames()[0]).toEqual({ ok: true, value: { kind: 'act', method: 'concede' } });
    // And it closes, so it cannot be conceded twice.
    await waitFor(() => expect(queryByTestId('live-concede-ask')).toBeNull());
    expect(await s.framesFrom(m)).toHaveLength(1);
  });

  it('is pressable with a question open — giving up is not an answer to it', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    s.send(confirmAsk('c-conc', true));
    await waitFor(() => getByTestId('confirm-dialog'));
    expect((getByTestId('live-concede') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(getByTestId('live-concede'));
    await waitFor(() => getByTestId('live-concede-ask'));
    // Its own dialog, not Forge's: `ConfirmDialog` is for a `showConfirmDialog`
    // frame with a callId, and there is no such frame behind this one. Forge's
    // is still the only `confirm-dialog` on the page.
    expect(queryByTestId('confirm-dialog')!.dataset.callId).toBe('c-conc');
    expect(document.querySelectorAll('[data-testid="confirm-dialog"]')).toHaveLength(1);
  });
});

/*
 * The two fields lane A reads off `BoardInteraction`, and why this component is
 * where they are filled.
 *
 * `e2e/table-fit.spec.ts` went red on a real match because the arrangement stood
 * down whenever a card was `selectable`, and outside an open selection
 * `selectable` is Forge's ACTIONABLE set — most of a player's own permanents on
 * their own turn. The fix splits the two states, and the split rests on a fact
 * from Forge's own source: `setSelectables` has exactly two call sites in all of
 * Forge (`InputSelectEntitiesFromList.java:57`, `InputSelectTargets.java:68`),
 * and `InputAttack` / `InputBlock` are neither. So Forge publishes NO open
 * selection while attackers or blockers are declared, and *"a selection is
 * open"* and *"a card is actionable"* are genuinely different states.
 *
 * Neither fact is computed here. `selectionOpen` arrives on `LiveClickables`
 * from `boardInteraction`, so it rides in with the spread and is NOT named
 * twice; `declaringAttackers` is lane B's function over `view.phase` and
 * `view.activePlayerId`. This component is only the one place both can be read
 * off the same handle, so these cases assert the HANDOVER — what reached
 * `Board`, off the props it was called with.
 */
describe('what the board is told about Forge’s input', () => {
  const notify = (raw: unknown) => parseServerFrame(raw);
  const selectables = (ids: number[], min: number, max: number) =>
    notify({ kind: 'notify', method: 'setSelectables', cards: ids.map((id) => ({ kind: 'card', id })), min, max });
  const actionable = (ids: number[]) =>
    notify({ kind: 'notify', method: 'setWeaklySelectable', cards: ids.map((id) => ({ kind: 'card', id })) });
  const prompt = (message: string) =>
    notify({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: null });
  const phase = phaseDelta;

  it('no selection open and not declaring attackers, at rest', async () => {
    const { m } = await liveBoard();
    await waitFor(() => expect(captured.interaction).not.toBeNull());
    expect(captured.interaction!.selectionOpen).toBe(false);
    expect(captured.interaction!.declaringAttackers).toBe(false);
    expect(m.selectables).toBeNull();
  });

  it('an open selection is passed through as one — and it is the SPREAD that carries it, not a second copy', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    expect(captured.interaction!.selectionOpen).toBe(false);

    for (const f of [prompt('Choose one'), selectables([mine[0]!], 1, 1)]) s.send(f);
    // Wait on the STATE and on a settled RENDER, never on the field under test —
    // a `waitFor` on the assertion itself passes on any transient that happens to
    // satisfy it, which is how an inverted field got past an earlier version of
    // the case below.
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    await waitFor(() => expect(container.querySelector(`[data-board-card="${mine[0]}"][data-selectable]`)).not.toBeNull());
    expect(captured.interaction!.selectionOpen).toBe(true);
    // Exactly `match.selectables !== null`, which is also what `boardInteraction`
    // put on `LiveClickables` — one source, so the two can never disagree.
    expect(captured.interaction!.selectionOpen).toBe(m.selectables !== null);
    expect(boardInteraction(m).selectionOpen).toBe(true);
    expect(captured.interaction!.declaringAttackers).toBe(false);

    s.send(notify({ kind: 'notify', method: 'clearSelectables' }));
    await untilMatch(m, () => expect(m.selectables).toBeNull());
    await waitFor(() => expect(container.querySelector(`[data-board-card="${mine[0]}"][data-selectable]`)).toBeNull());
    expect(captured.interaction!.selectionOpen).toBe(false);
  });

  /*
   * THE REGRESSION, stated as the state it is about: Forge names most of this
   * seat's own permanents at ordinary priority, so `selectable` is large while
   * NOTHING is being asked. A board told "a selection is open" here is a board
   * whose arrangement stands down for most of a game.
   */
  it('actionable is not asking: a full selectable set with no selection open', async () => {
    const { s, m } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    for (const f of [prompt('Priority: you'), actionable(mine)]) s.send(f);
    await waitFor(() => expect(captured.interaction!.selectable.size).toBe(mine.length));
    expect(mine.length).toBeGreaterThan(1);
    expect(captured.interaction!.selectionOpen).toBe(false);
    expect(m.selectables).toBeNull();
  });

  /*
   * Every wait here is on the VIEW and on the rail's own rendered attributes —
   * never on `declaringAttackers` itself. An earlier version waited on the field,
   * and an inverted field passed: inverted, it is already `true` at rest, so the
   * first wait was satisfied before any delta arrived and the case never saw the
   * state it was about. Waiting on the thing under test is how a mutant survives.
   */
  it('declaring attackers is told separately, because Forge opens no selection for it', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const me = m.view!.players.find((p) => p.isViewer)!;
    const them = m.view!.players.find((p) => !p.isViewer)!;
    const mine = me.battlefield.map((c) => c.id);
    // At rest — Main 1, and nobody is declaring anything.
    expect(getByTestId('live-phases').dataset.phase).toBe('MAIN1');
    expect(captured.interaction!.declaringAttackers).toBe(false);

    for (const f of [phase(m, 'COMBAT_DECLARE_ATTACKERS', me.id), prompt('Declare attackers'), actionable(mine)]) {
      s.send(f);
    }
    await untilMatch(m, () => expect(m.view!.phase).toBe('COMBAT_DECLARE_ATTACKERS'));
    await waitFor(() => expect(getByTestId('live-phases').dataset.phase).toBe('COMBAT_DECLARE_ATTACKERS'));
    expect(getByTestId('live-phases').dataset.whose).toBe('yours');
    expect(captured.interaction!.declaringAttackers).toBe(true);
    // And it is NOT a selection: `InputAttack` publishes none.
    expect(captured.interaction!.selectionOpen).toBe(false);
    expect(m.selectables).toBeNull();

    // The same step, but the OTHER seat is the one declaring.
    s.send(phase(m, 'COMBAT_DECLARE_ATTACKERS', them.id));
    await untilMatch(m, () => expect(m.view!.activePlayerId).toBe(them.id));
    await waitFor(() => expect(getByTestId('live-phases').dataset.whose).toBe('theirs'));
    expect(getByTestId('live-phases').dataset.phase).toBe('COMBAT_DECLARE_ATTACKERS');
    expect(captured.interaction!.declaringAttackers).toBe(false);
    expect(captured.interaction!.selectionOpen).toBe(false);
  });
});


/* ── §A.6 / item 16 — Forge's second button during declare-attackers ─── */

/**
 * The operator, 2026-09-28: *"i hate the 'alpha strike' button just delete it."*
 * Wave 30 item 16 widens the refusal from just `Alpha Strike` to `Call Back`
 * too: *"delete the Call Back button… the operator has asked for it anyway"*,
 * knowing the cost — `Call Back` is Forge's own `lblCallBack`
 * (`InputAttack.canCallBackAttackers()`), and it was the only way this UI let a
 * player un-declare attackers already committed. `InputAttack.java:89` sets the
 * bar's second label to `lblAlphaStrike` with nothing declared and `lblCallBack`
 * once something is, and this component used to paint `bar.label2` verbatim
 * for the second case. Now `offersSecondButton` refuses BOTH, off
 * `declaringAttackers` alone — never off the label's text, which is localized,
 * and a client that reads Forge's prose to decide what a button means is a
 * client that breaks in French.
 */
describe('§A.6 / item 16 — Forge’s second button is refused for the whole of declare-attackers', () => {
  const GAME_KEY = String(deltaKey(DELTA_TYPE.game, 1));
  const notify = (raw: unknown) => parseServerFrame(raw);
  const bar = (label2: string, enable2 = true) =>
    notify({
      kind: 'notify',
      method: 'updateButtons',
      owner: { kind: 'player', id: 0 },
      label1: 'OK',
      label2,
      enable1: true,
      enable2,
      focus1: true,
    });
  const phase = (m: LiveMatch, name: string, playerTurn: number) =>
    notify({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: {
          seq: m.view!.seq + 1,
          checksum: 0,
          checksumProperties: [],
          newObjects: {},
          objectDeltas: {
            [GAME_KEY]: {
              _type: DELTA_TYPE.game,
              _id: 1,
              Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: name },
              PlayerTurn: { t: 'int', v: playerTurn },
            },
          },
          events: [],
        },
      },
    });
  const attacking = (m: LiveMatch, ids: number[]) =>
    notify({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: {
          seq: m.view!.seq + 1,
          checksum: 0,
          checksumProperties: [],
          newObjects: {},
          objectDeltas: Object.fromEntries(
            ids.map((id) => [String(id), { _type: DELTA_TYPE.card, _id: id, Attacking: { t: 'bool', v: true } }]),
          ),
          events: [],
        },
      },
    });

  it('paints Forge’s label2 while Forge enables it, and refuses it whether or not an attacker is declared', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    const me = m.view!.players.find((p) => p.isViewer)!;
    const cancel = () => queryByTestId('live-decision-cancel') as HTMLButtonElement | null;

    // 1. Outside combat, Forge's word is Forge's word, on the decision pop-up.
    s.send(bar('Cancel'));
    await waitFor(() => expect(cancel()).not.toBeNull());
    expect(cancel()!.textContent).toBe('Cancel');

    // 2. Declaring attackers with none declared (the old Alpha Strike state):
    //    the button is not offered at all, and never says Forge's word.
    s.send(phase(m, 'COMBAT_DECLARE_ATTACKERS', me.id));
    s.send(bar('Alpha Strike'));
    await waitFor(() => expect(cancel()).toBeNull());
    expect(m.buttons!.label2, 'Forge still sent it — we simply do not offer it').toBe('Alpha Strike');
    expect(getByTestId('live-buttons').textContent).not.toContain('Alpha Strike');
    expect(getByTestId('live-decision').textContent).not.toContain('Alpha Strike');
    expect(getByTestId('live-decision-ok').textContent, 'done declaring says what it does').toBe('Done Attacking');
    expect(
      getByTestId('live-decision').querySelector<HTMLElement>('.answers')!.hasAttribute('data-start'),
      'Done Attacking ends the choosing: bottom left, where a No goes (the operator, 2026-10-24)',
    ).toBe(true);

    // 3. One attacker declared. Forge's own `canCallBackAttackers()` is true now
    //    and it sends `Call Back` — item 16 refuses this one too, on the operator's
    //    own instruction, so the button stays absent instead of becoming Forge's undo.
    s.send(attacking(m, [me.battlefield.find((c) => !c.tapped)!.id]));
    s.send(bar('Call Back'));
    await untilMatch(m, () => expect(m.buttons!.label2).toBe('Call Back'));
    expect(cancel(), 'Call Back is refused too (item 16)').toBeNull();
    expect(getByTestId('live-buttons').textContent).not.toContain('Call Back');
    expect(getByTestId('live-decision').textContent).not.toContain('Call Back');
  });

  /*
   * Wave 32 Q15b — *"what is the point of the cancel button in the control
   * pane?"* — and wave 51: Forge's second button is the decision pop-up's,
   * drawn only while Forge enables it and in Forge's own word; the cluster
   * keeps its three buttons whatever Forge sends.
   */
  it('Q15b: the second button is drawn only while Forge enables it, in Forge’s word, and the cluster keeps its three buttons', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    expect(queryByTestId('live-decision-cancel'), 'no bar yet').toBeNull();

    s.send(bar('Auto'));
    await waitFor(() => expect(queryByTestId('live-decision-cancel')).not.toBeNull());
    expect(getByTestId('live-decision-cancel').textContent).toBe('Auto');

    s.send(bar('Auto', false));
    await waitFor(() => expect(queryByTestId('live-decision-cancel')).toBeNull());
    expect(getByTestId('live-decision-ok').textContent).toBe('OK');
    expect([...getByTestId('live-buttons').querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'End Turn',
      'Full control',
      'Concede',
    ]);
  });

  /*
   * The operator: *"when a menace creature is attacking, if i only assign one creature to block then
   * it should not allow me to click 'Done Blocking'"*. Forge enables `InputBlock`'s OK whatever the
   * blocks are; the bridge sends what `CombatUtil.validateBlocks` says (`refusal1`), and Done
   * Blocking is off while it is set, saying why on hover.
   */
  it('Done Blocking is off while Forge would refuse the blocks, and says why on hover; on again once it would take them', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const opponent = m.view!.players.find((p) => !p.isViewer)!;
    const blockBar = (refusal1?: string) =>
      notify({
        kind: 'notify',
        method: 'updateButtons',
        owner: { kind: 'player', id: 0 },
        label1: 'OK',
        label2: 'Cancel',
        enable1: true,
        enable2: false,
        focus1: true,
        ...(refusal1 === undefined ? {} : { refusal1 }),
      });
    const done = () => getByTestId('live-decision-ok') as HTMLButtonElement;

    s.send(phase(m, 'COMBAT_DECLARE_BLOCKERS', opponent.id));
    s.send(blockBar("Boggart Brute (57) cannot be blocked with 1 creatures you've assigned"));
    await waitFor(() => expect(done().disabled, 'one blocker on a menace attacker').toBe(true));
    expect(done().textContent).toBe('Done Blocking');
    expect(done().closest('[data-tip]')?.getAttribute('data-tip'), 'Forge’s reason, without its card id').toBe(
      "Boggart Brute cannot be blocked with 1 creatures you've assigned",
    );
    expect(pressButton(m, 'ok'), 'no press is sent while Forge would refuse it').toBe(false);

    s.send(blockBar());
    await waitFor(() => expect(done().disabled, 'a second blocker, or none').toBe(false));
    expect(done().closest('[data-tip]'), 'nothing to explain').toBeNull();
    expect(pressButton(m, 'ok')).toBe(true);
  });
});

/* ── §A.11 — the log, as something you can read ──────────────────────── */

/**
 * The render half of the log. The lines are Forge's own game log, worded per
 * player by the bridge (`PlayBridge.GameLogForward`); this is what they LOOK like.
 */
describe('§A.11 — the log is coloured by what happened, and its card names reveal the card', () => {
  const says = (text: string) => parseServerFrame({ kind: 'notify', method: 'message', message: text, title: '' });
  /** A line of Forge's own game log, as the server sends it. */
  const logged = (text: string, type: GameLogLine['type'], cards: GameLogLine['cards'] = []) =>
    parseServerFrame({ kind: 'notify', method: 'message', message: text, title: '', log: { type, cards } });
  const lines = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-testid="live-log"] li')];

  it('marks each line with its kind, from Forge’s own entry type, and each kind has an ink of its own', async () => {
    const { s, container } = await liveBoard();
    for (const f of [
      logged('Volcanic Island - Add U.', 'MANA'),
      logged('Fire Urchin deals 2 damage to Goblin Replica.', 'DAMAGE'),
      says('full control on'),
      logged('Alice played Island', 'LAND'),
      logged('Alice cast Opt', 'STACK_ADD'),
      says('nothing in particular'),
      logged('Bob triggered Fire Urchin', 'STACK_ADD'),
      logged('Life: Bob 20 > 17', 'LIFE'),
      logged('Bob discards Island.', 'DISCARD'),
    ]) {
      s.send(f);
    }
    await waitFor(() => expect(lines(container)).toHaveLength(9));
    expect(lines(container).map((li) => li.dataset.logKind)).toEqual(['payment', 'damage', 'control', 'play', 'play', 'said', 'trigger', 'life', 'said']);
    expect(lines(container).map((li) => li.dataset.logType ?? null)).toEqual(['MANA', 'DAMAGE', null, 'LAND', 'STACK_ADD', null, 'STACK_ADD', 'LIFE', 'DISCARD']);
    /*
     * Colour is never the only signal — the words are, and always were. These are
     * tints on the text rather than badges, so a log read with no colour at all
     * still says everything it said before.
     */
    for (const kind of ['payment', 'trigger', 'damage', 'life', 'play', 'control']) {
      const rule = new RegExp(`\\.live__log li\\[data-log-kind='${kind}'\\] \\{([^}]*)\\}`).exec(liveCss());
      expect(rule, `${kind} has a rule`).not.toBeNull();
      expect(rule![1], `${kind} sets an ink`).toMatch(/color:/);
    }
  });

  it('tells the table’s lines from your own, by the player Forge’s line opens with', async () => {
    const { s, m, container } = await liveBoard();
    const me = m.view!.players.find((p) => p.isViewer)!;
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.send(logged(`${me.name} played Island`, 'LAND'));
    s.send(logged(`${them.name} played Mountain`, 'LAND'));
    await waitFor(() => expect(lines(container)).toHaveLength(2));
    expect(lines(container).map((li) => li.dataset.logWho)).toEqual(['you', 'them']);
  });

  it('a card a Forge log line names is a hover target for THAT card, by its own id', async () => {
    const { s, m, container } = await liveBoard();
    const islands = m.view!.players.flatMap((p) => [...(p.hand ?? []), ...p.battlefield]).filter((c) => c.card.name === 'Island').map((c) => c.id);
    expect(islands.length).toBeGreaterThan(0);
    const named = islands.at(-1)!;
    s.send(logged('Island - Add U.', 'MANA', [{ id: named, name: 'Island' }]));
    await waitFor(() => expect(lines(container)).toHaveLength(1));
    const name = lines(container)[0]!.querySelector<HTMLElement>('.live__log-card')!;
    expect(name.dataset.logCard).toBe('Island');
    expect(Number(name.dataset.inspectIds!.split(',')[0]), 'the named card first, for the inspector').toBe(named);
    // A name Forge's line did not list is plain text, even when the board holds a card of that name.
    s.send(logged('Bob discards Island.', 'DISCARD', []));
    await waitFor(() => expect(lines(container)).toHaveLength(2));
    expect(lines(container)[1]!.querySelectorAll('.live__log-card')).toHaveLength(0);
  });

  it('a card name the viewer’s own board holds is a tab stop, and hovering it draws the card through the inspector', async () => {
    const { s, m, container } = await liveBoard();
    s.send(says('paid U — Island, Izzet Guildgate'));
    await waitFor(() => expect(lines(container)).toHaveLength(1));
    const names = [...lines(container)[0]!.querySelectorAll<HTMLElement>('.live__log-card')];
    expect(names.map((n) => n.dataset.logCard)).toEqual(['Island', 'Izzet Guildgate']);
    expect(names.map((n) => n.tabIndex), 'the keyboard gets what the pointer gets').toEqual([0, 0]);
    // The line still READS as the line: wrapping a name changes no text.
    expect(lines(container)[0]!.textContent).toBe('paid U — Island, Izzet Guildgate');
    // The name points at the cards of that name the view holds; the inspector resolves one.
    const islandIds = m.view!.players.flatMap((p) => [...(p.hand ?? []), ...p.battlefield]).filter((c) => c.card.name === 'Island').map((c) => c.id);
    expect(islandIds.length).toBeGreaterThan(0);
    expect(names[0]!.dataset.inspectIds!.split(',').map(Number).sort()).toEqual(expect.arrayContaining(islandIds));
    // Nothing is drawn until it is wanted, and then it is the inspector's own panel.
    expect(container.querySelector('[data-inspect]')).toBeNull();
    fireEvent.pointerOver(names[0]!, { pointerType: 'mouse' });
    await waitFor(() => expect(container.querySelector('[data-inspect]')).not.toBeNull());
    expect(container.querySelector('[data-inspect] .card__name')!.textContent).toBe('Island');
    // P12: there is no second hover display — the log's own peek is gone.
    expect(container.querySelector('[data-testid="live-log-peek"]')).toBeNull();
    expect(container.querySelector('.live__log-peek')).toBeNull();
    fireEvent.pointerOut(names[0]!, { pointerType: 'mouse', relatedTarget: container });
    await waitFor(() => expect(container.querySelector('[data-inspect]')).toBeNull());
  });

  it('a log name whose card has no tile on the page draws NOTHING — it does not get a surface of its own', async () => {
    const { s, container } = await liveBoard();
    s.send(says('paid U — Island'));
    await waitFor(() => expect(lines(container)).toHaveLength(1));
    const name = lines(container)[0]!.querySelector<HTMLElement>('.live__log-card')!;
    name.dataset.inspectIds = '999999';
    fireEvent.pointerOver(name, { pointerType: 'mouse' });
    expect(container.querySelector('[data-inspect]')).toBeNull();
    expect(container.querySelector('[data-testid="live-log-peek"]')).toBeNull();
  });

  it('a name the viewer’s board does not hold is left as text: we have no card to show', async () => {
    const { s, container } = await liveBoard();
    s.send(says('paid B — Swamp'));
    await waitFor(() => expect(lines(container)).toHaveLength(1));
    expect(lines(container)[0]!.querySelectorAll('.live__log-card')).toHaveLength(0);
    expect(lines(container)[0]!.textContent).toBe('paid B — Swamp');
  });
});

/*
 * ── items 4-7, then wave 32 Q15 — the match's settings, in the HEADER ──────
 *
 * The operator, 2026-09-30: *"i think by default this should be off, but can
 * be turned on in settings (always stop at endstep). same place that we
 * should allow the board config to show differently."* — and, wave 32:
 * *"the settings live in the top settings menu, and the extra button goes."*
 *
 * 2026-10-10, the operator: *"i dont want watchparty's settings menu to get
 * clogged up by our game settings … we can expose it by making the avatar
 * clickable in-game"*. `liveBoard(0, true)` opens them from the viewer's face.
 */
describe('the match settings open from your own face (items 4-7, 2026-10-10)', () => {
  it('there is no Settings button in the cluster; your face opens the popover, with sound and the match', async () => {
    const { container, queryByTestId, getByTestId } = await liveBoard();
    expect(queryByTestId('live-settings')).toBeNull();
    expect(queryByTestId('live-settings-panel')).toBeNull();
    const face = getByTestId('seat-settings');
    expect(face.closest('[data-viewer]'), 'the viewer’s own face, not the opponent’s').not.toBeNull();
    expect(container.querySelectorAll('[data-testid="seat-settings"]')).toHaveLength(1);

    fireEvent.click(face);
    const dialog = getByTestId('settings');
    expect(dialog.contains(getByTestId('settings-sound'))).toBe(true);
    expect(dialog.contains(getByTestId('live-settings-panel'))).toBe(true);
    expect(container.querySelector('.live__ask')).toBeNull();
  });

  it('Escape, the close button and a press outside each close it', async () => {
    const { queryByTestId, getByTestId } = await liveBoard(0, true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByTestId('settings')).toBeNull();

    fireEvent.click(getByTestId('seat-settings'));
    fireEvent.click(getByTestId('settings-close'));
    expect(queryByTestId('settings')).toBeNull();

    fireEvent.click(getByTestId('seat-settings'));
    fireEvent.pointerDown(getByTestId('live-turn-n'));
    expect(queryByTestId('settings')).toBeNull();
  });

  it('board layout: single is the default `Board` prop, and the radio flips it to type-separated and back', async () => {
    const { getByTestId } = await liveBoard(0, true);
    expect(captured.boardLayout).toBe('single');
    const panel = getByTestId('live-settings-panel');
    const radios = [...panel.querySelectorAll<HTMLInputElement>('input[name="board-layout"]')];
    expect(radios.map((r) => r.value)).toEqual(['single', 'type-separated']);
    expect(radios[0]!.checked).toBe(true);

    fireEvent.click(radios[1]!);
    expect(captured.boardLayout).toBe('type-separated');
    expect(prefsState.saved).toContainEqual({ boardLayout: 'type-separated' });

    fireEvent.click(radios[0]!);
    expect(captured.boardLayout).toBe('single');
  });

  it('the End step stop: on by default, the checkbox sends forge:stop-preference and persists the change', async () => {
    const { s, m, getByTestId } = await liveBoard(0, true);
    expect(m.stopAtEndStep).toBe(true);
    const checkbox = getByTestId('live-settings-stop-end-step') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    await untilMatch(m, () => expect(m.stopAtEndStep).toBe(false));
    await s.caughtUp(m);
    const sent = s.received.filter((r) => r.event === 'forge:stop-preference');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({ matchId: s.matchId, type: 'stopPreference', stopAtEndStep: false });
    expect(prefsState.saved).toContainEqual({ endStepStop: false });
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    await untilMatch(m, () => expect(m.stopAtEndStep).toBe(true));
    await s.caughtUp(m);
    expect(s.received.filter((r) => r.event === 'forge:stop-preference')).toHaveLength(2);
    // A preference, not a Forge frame: none of it crossed forge:c2s.
    expect(s.clientFrames()).toEqual([]);
  });

  it('a persisted preference is sent to the server on join, without the panel ever opening — the manager’s own instruction', async () => {
    prefsState.prefs = { boardLayout: 'type-separated', endStepStop: false };
    const { s, m } = await liveBoard();
    await untilMatch(m, () => expect(m.stopAtEndStep).toBe(false));
    await s.caughtUp(m);
    expect(captured.boardLayout).toBe('type-separated');
    const sent = s.received.filter((r) => r.event === 'forge:stop-preference');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({ matchId: s.matchId, type: 'stopPreference', stopAtEndStep: false });
    // The settings were never opened in this test.
  });

  it('the seat’s settings go to the match log as client telemetry once read, and again on every change', async () => {
    // The operator, 2026-10-08: "you should always confirm everything with telemetry" — a report about
    // what a seat saw is read from the log's `client` events, never deduced from the code's defaults.
    prefsState.prefs = { boardLayout: 'type-separated', endStepStop: true, fastMode: false };
    const { s, getByTestId } = await liveBoard(0, true);
    const infos = () => s.received.filter((r) => r.event === 'forge:client' && (r.payload as { kind: string }).kind === 'info');
    await waitFor(() => expect(infos()).toHaveLength(1));
    // `ui` is the bundle's version: a report of an animation the deploy had replaced is read as a stale tab
    // or a regression from this field (the operator, 2026-10-17: "i played a game a few hrs ago and the
    // animation was still bad" — the log of those matches could not say which build the tab ran).
    expect(__HADOKU_UI_VERSION__).toMatch(/^\d+\.\d+\.\d+$/);
    expect(infos()[0]!.payload).toEqual({
      matchId: s.matchId,
      kind: 'info',
      data: { ui: __HADOKU_UI_VERSION__, fastMode: false, boardLayout: 'type-separated', reducedMotion: false, window: `${window.innerWidth}x${window.innerHeight}` },
    });
    // Toggling Fast Mode sends the new settings, nothing else of the panel's.
    fireEvent.click(getByTestId('live-settings-fast-mode'));
    await waitFor(() => expect(infos()).toHaveLength(2));
    expect(infos()[1]!.payload).toMatchObject({ kind: 'info', data: { fastMode: true } });
  });

  it('every sound a board change raises goes to the match log with why, its roles, the view’s turn and seq, and the mute', async () => {
    // The operator, 2026-10-10: "as we investigate these things, please make sure we have ample telemetry".
    const { s } = await liveBoard();
    const sounds = () => s.received.filter((r) => r.event === 'forge:client' && (r.payload as { kind: string }).kind === 'sound').map((r) => (r.payload as { data: Record<string, unknown> }).data);
    await waitFor(() => expect(sounds().some((d) => d.why === 'view')).toBe(true));
    const view = sounds().find((d) => d.why === 'view')!;
    expect(typeof view.roles).toBe('string');
    expect(view.count).toBeGreaterThan(0);
    expect(typeof view.seq).toBe('number');
    expect(typeof view.turn).toBe('number');
    expect(typeof view.prevSeq).toBe('number');
    expect(view.muted).toBe(false);
    // Every one of them fits the wire's own shape.
    for (const r of s.received.filter((x) => x.event === 'forge:client')) expect(ClientEventSchema.safeParse(r.payload).success).toBe(true);
  });

  it('a persisted ON preference is still sent on join — force, because on already matches the client default', async () => {
    prefsState.prefs = { endStepStop: true };
    const { s, m } = await liveBoard();
    await waitFor(() => expect(s.received.filter((r) => r.event === 'forge:stop-preference')).toHaveLength(1));
    expect(m.stopAtEndStep).toBe(true);
  });
});

/*
 * ── Wave 31 lane L — the watching window, the rail, the finished game ──────
 *
 * `LiveMatch.spectator` and `LiveMatch.over` are lane S's (shapes 3 and 4) and
 * are set here directly on the handle, then the board is re-rendered: this file
 * reads the fields, it does not own how they get set.
 */
describe('wave 31 §L — a watching window, the combat rail, and Concede after the end', () => {
  const notify = (raw: unknown) => parseServerFrame(raw);
  const GAME_KEY = String(deltaKey(DELTA_TYPE.game, 1));
  const inCombat = (m: LiveMatch, name: string) =>
    notify({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: {
          seq: m.view!.seq + 1,
          checksum: 0,
          checksumProperties: [],
          newObjects: {},
          objectDeltas: {
            [GAME_KEY]: {
              _type: DELTA_TYPE.game,
              _id: 1,
              Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: name },
            },
          },
          events: [],
        },
      },
    });
  const selectables = (ids: number[]) =>
    notify({ kind: 'notify', method: 'setSelectables', cards: ids.map((id) => ({ kind: 'card', id })), min: 1, max: 1 });
  const buttons = () =>
    notify({
      kind: 'notify',
      method: 'updateButtons',
      owner: { kind: 'player', id: 0 },
      label1: 'OK',
      label2: 'Cancel',
      enable1: true,
      enable2: true,
      focus1: true,
    });
  const flag = (m: LiveMatch, patch: { spectator?: boolean; watcher?: boolean; over?: boolean }, rerender: (ui: ReturnType<typeof createElement>) => void) => {
    Object.assign(m, patch);
    rerender(createElement(LiveBoard, { match: m }));
  };

  it('spectator: a banner, no prompt, every button inert, nothing reaches the server — and it lifts on promotion', async () => {
    const { s, m, getByTestId, queryByTestId, rerender } = await liveBoard();
    s.send(confirmAsk('c-spec', true));
    await waitFor(() => getByTestId('confirm-dialog'));
    // Forge is enabling the buttons and offering a card: every one of them is a
    // thing a player could press or click, so refusing them is the watcher's.
    const offeredId = m.view!.players.find((p) => p.isViewer)!.battlefield[0]!.id;
    s.send(selectables([offeredId]));
    s.send(buttons());
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    await untilMatch(m, () => expect(m.buttons?.enable1).toBe(true));
    expect(queryByTestId('live-spectator')).toBeNull();
    const frames = (await s.framesFrom(m)).length;

    flag(m, { spectator: true }, rerender);
    expect(getByTestId('live-spectator').textContent).toBe('Watching: this seat is being played in another window');
    expect(queryByTestId('confirm-dialog'), 'a watcher is asked nothing').toBeNull();
    expect(queryByTestId('live-prompt')).toBeNull();
    for (const id of ['live-button-end-turn', 'live-full-control', 'live-concede']) {
      expect((getByTestId(id) as HTMLButtonElement).disabled, `${id} is inert`).toBe(true);
    }
    expect(queryByTestId('live-decision'), 'a watcher is offered no decision').toBeNull();
    fireEvent.click(getByTestId('live-full-control'));
    fireEvent.click(getByTestId('live-concede'));
    expect(queryByTestId('live-concede-ask')).toBeNull();
    expect(m.fullControl).toBe(false);
    // Clicks and drags on the table reach nobody.
    expect(captured.interaction!.selectable.size).toBe(0);
    const replies = m.stats.replies;
    captured.interaction!.onSelectCard(offeredId);
    captured.interaction!.onSelectPlayer(0);
    expect(m.stats.replies, 'a click on the offered card sent nothing').toBe(replies);
    const card = document.querySelector<HTMLElement>('.board [data-card-id]')!;
    expect(fireEvent.dragStart(card), 'the arranging drag is refused at the root').toBe(false);
    // Reading still works: the log opens.
    fireEvent.click(getByTestId('live-log-toggle'));
    expect(getByTestId('live-logbook').hidden).toBe(false);
    expect(await s.framesFrom(m)).toHaveLength(frames);

    // Promotion: no reload, the prompt comes back and the controls live.
    flag(m, { spectator: false }, rerender);
    expect(queryByTestId('live-spectator')).toBeNull();
    await waitFor(() => getByTestId('confirm-dialog'));
    expect((getByTestId('live-concede') as HTMLButtonElement).disabled).toBe(false);
    expect((getByTestId('live-full-control') as HTMLButtonElement).disabled).toBe(false);
    expect(fireEvent.dragStart(card)).toBe(true);
  });

  it('watcher (2026-10-12): no control box at all, a Watching line with a flip, and the flip turns the table around', async () => {
    const { s, m, getByTestId, queryByTestId, rerender } = await liveBoard();
    s.send(buttons());
    await untilMatch(m, () => expect(m.buttons?.enable1).toBe(true));
    const bottom = m.view!.players.find((p) => p.isViewer)!.id;
    const frames = (await s.framesFrom(m)).length;

    flag(m, { spectator: true, watcher: true }, rerender);
    expect(queryByTestId('live-buttons'), 'nothing to grey: the box is not drawn').toBeNull();
    expect(queryByTestId('live-spectator'), 'the wave-31 banner is a seat’s').toBeNull();
    expect(getByTestId('watcher-status').getAttribute('data-role')).toBe('watcher');
    expect(getByTestId('watcher-status').textContent).toContain('Watching');
    expect(document.querySelector('.live')?.getAttribute('data-role')).toBe('watcher');
    expect(queryByTestId('live-prompt'), 'a watcher is asked nothing').toBeNull();
    expect(queryByTestId('live-decision')).toBeNull();
    expect(getByTestId('live-log-toggle'), 'reading stays').toBeTruthy();

    fireEvent.click(getByTestId('perspective-flip'));
    expect(m.view!.players.find((p) => p.isViewer)!.id, 'the other player is at the bottom now').not.toBe(bottom);
    expect(m.view!.players.every((p) => p.hand === null), 'both hands are backs').toBe(true);
    rerender(createElement(LiveBoard, { match: m }));
    expect(document.querySelectorAll('.board .card-backs').length, 'two backs strips, no hand rail').toBeGreaterThanOrEqual(2);
    expect(await s.framesFrom(m), 'the flip is the client’s alone').toHaveLength(frames);

    // Promotion to a seat: the box is back and the table is the seat’s way round.
    flag(m, { spectator: false, watcher: false }, rerender);
    expect(getByTestId('live-buttons')).toBeTruthy();
    expect(queryByTestId('watcher-status')).toBeNull();
  });

  it('spectator: a click on a card Forge offered sends nothing — and does, for the seat’s own window', async () => {
    const { s, m, rerender } = await liveBoard();
    const offeredId = m.view!.players.find((p) => p.isViewer)!.battlefield[0]!.id;
    s.send(selectables([offeredId]));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    const replies = m.stats.replies;

    flag(m, { spectator: true }, rerender);
    captured.interaction!.onSelectCard(offeredId);
    expect(m.stats.replies, 'the watcher’s click went nowhere').toBe(replies);

    flag(m, { spectator: false }, rerender);
    captured.interaction!.onSelectCard(offeredId);
    expect(m.stats.replies, 'the same click from the seat’s own window is an answer').toBe(replies + 1);
  });

  it('spectator: hover and the inspector still work', async () => {
    const { m, container, rerender } = await liveBoard();
    flag(m, { spectator: true }, rerender);
    const tile = container.querySelector<HTMLElement>('.board [data-card-id]')!;
    fireEvent.pointerOver(tile, { pointerType: 'mouse' });
    await waitFor(() => expect(container.querySelector('[data-inspect]')).not.toBeNull());
  });

  it('P1: combat is one row outside combat and six inside it, and the rail itself does not change', async () => {
    const { s, m, container, getByTestId } = await liveBoard();
    const names = () => [...container.querySelectorAll('.live__step')].map((el) => el.textContent);
    expect(names()).toHaveLength(8);
    expect(names()).toContain('Combat');
    const railBefore = getByTestId('live-phases').className;
    // The rail's row count is the CSS's, its rows one shared height (wave 33 §L1): read off what the cascade gives the drawn rail.
    const css = styled();
    const rows = () => {
      const rail = getByTestId('live-phases');
      const step = rail.querySelector('.live__step')!;
      return { count: Number(css(rail, '--rail-rows')), height: [css(rail, '--rail-row-h'), css(step, 'height'), css(step, 'flex')] };
    };
    const outside = rows();
    expect(outside.count, 'out of combat').toBe(names().length);
    expect(outside.height[1], 'a row has a height of its own, not a share of what is left').not.toBe('');

    s.send(inCombat(m, 'COMBAT_DECLARE_BLOCKERS'));
    await waitFor(() => expect(getByTestId('live-phases').dataset.phase).toBe('COMBAT_DECLARE_BLOCKERS'));
    expect(names()).toEqual([
      'Untap',
      'Upkeep',
      'Draw',
      'Main 1',
      'Beginning of combat',
      'Declare attackers',
      'Declare blockers',
      'First-strike damage',
      'Combat damage',
      'End of combat',
      'Main 2',
      'End step',
      'Cleanup',
    ]);
    const current = container.querySelector('.live__step[data-current]')!;
    expect(current.textContent).toBe('Declare blockers');
    const inside = rows();
    expect(inside.count, 'the rail is sized for the rows it draws').toBe(names().length);
    expect(inside.height, 'every row the same height in combat as out of it').toEqual(outside.height);
    // The earlier combat steps are past; the rail is the same element with the same box rules.
    expect(container.querySelector('.live__step[data-phase="COMBAT_BEGIN"]')!.hasAttribute('data-past')).toBe(true);
    expect(getByTestId('live-phases').className).toBe(railBefore);

    // Out of combat again, past combat: it is one row again and it is PAST.
    s.send(inCombat(m, 'MAIN2'));
    await waitFor(() => expect(getByTestId('live-phases').dataset.phase).toBe('MAIN2'));
    expect(names()).toHaveLength(8);
    expect(container.querySelector('.live__step[data-phase="COMBAT"]')!.hasAttribute('data-past')).toBe(true);
    expect(container.querySelector('.live__step[data-current]')!.textContent).toBe('Main 2');
  });

  it('P18: Concede is disabled once the game is over, and an open confirmation closes', async () => {
    const { m, getByTestId, queryByTestId, rerender } = await liveBoard();
    const concede = getByTestId('live-concede') as HTMLButtonElement;
    expect(concede.disabled).toBe(false);
    fireEvent.click(concede);
    await waitFor(() => getByTestId('live-concede-ask'));

    flag(m, { over: true }, rerender);
    expect((getByTestId('live-concede') as HTMLButtonElement).disabled).toBe(true);
    expect(queryByTestId('live-concede-ask'), 'nothing to concede').toBeNull();
    const sent = m.stats.replies;
    fireEvent.click(getByTestId('live-concede'));
    expect(queryByTestId('live-concede-ask')).toBeNull();
    expect(m.stats.replies).toBe(sent);
  });

  it('the sentence the page shows for a gone match is the one the server sends', () => {
    expect(MATCH_GONE_SENTENCE).toBe(MATCH_GONE_MESSAGE);
  });
});

/*
 * ── Wave 32 lane L — the turn display, the rail's size, the popover layer ──
 */
describe('wave 32 lane L: chrome', () => {
  it('Q1: before turn 1 the rail says Start, with no name under it; from turn 1 it is the number alone', async () => {
    const { m, container, getByTestId, rerender } = await liveBoard();
    m.view = { ...m.view!, turn: 0, activePlayerId: -1 };
    rerender(createElement(LiveBoard, { match: m }));
    expect(getByTestId('live-turn-n').textContent).toBe('Start');
    expect(getByTestId('live-turn').textContent).toBe('Start');
    expect(container.querySelector('.live__turn-who')).toBeNull();
    // The specs' hook is kept.
    expect(getByTestId('live-phases').dataset.whose).toBe('nobody');
    expect(getByTestId('live-phases').dataset.turn).toBe('0');

    m.view = { ...m.view!, turn: 1 };
    rerender(createElement(LiveBoard, { match: m }));
    expect(getByTestId('live-turn-n').textContent).toBe('1');
  });

  it('Q3: no bullets in the rail, names centred, and the rail is sized by its rows and animated in CSS only', async () => {
    const { container } = await liveBoard();
    expect(container.querySelector('.live__mark'), 'the bullet is gone from the markup').toBeNull();
    const css = styled();
    const step = container.querySelector('.live__step')!;
    expect(css(step.querySelector('.live__step-name')!, 'text-align')).toBe('center');
    expect(css(step, 'justify-content')).toBe('center');
    // The replayed phases can land in two renders under 80 ms apart on a loaded worker, which arms
    // `useCrawlGuard`'s snap for its cooldown; the rule this pins is the rail's at rest.
    const rail = container.querySelector<HTMLElement>('.live__phases')!;
    await waitFor(() => expect(rail.hasAttribute('data-crawl')).toBe(false));
    expect(css(rail, 'transition'), 'the rail animates its height in CSS').toContain('height');
  });

  it('Q3: the rail carries data-combat only while the game is in combat', async () => {
    const { s, m, getByTestId } = await liveBoard();
    expect(getByTestId('live-phases').hasAttribute('data-combat')).toBe(false);
    const delta = (name: string) =>
      parseServerFrame({
        kind: 'notify',
        method: 'applyDelta',
        payload: {
          packet: {
            seq: m.view!.seq + 1,
            checksum: 0,
            checksumProperties: [],
            newObjects: {},
            objectDeltas: {
              [String(deltaKey(DELTA_TYPE.game, 1))]: {
                _type: DELTA_TYPE.game,
                _id: 1,
                Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: name },
              },
            },
            events: [],
          },
        },
      });
    s.send(delta('COMBAT_DECLARE_BLOCKERS'));
    await waitFor(() => expect(getByTestId('live-phases').hasAttribute('data-combat')).toBe(true));
    s.send(delta('MAIN2'));
    await waitFor(() => expect(getByTestId('live-phases').hasAttribute('data-combat')).toBe(false));
  });

  it('Q16: the question sits on the popover layer, the cluster, log button and rail on the overlay layer', async () => {
    const css = styled();
    const { s, container, getByTestId } = await liveBoard();
    s.send(confirmAsk('c-layer', true));
    const question = await waitFor(() => getByTestId('live-prompt'));
    expect(css(question, 'z-index')).toContain('--z-popover');
    for (const sel of ['.live__buttons', '.live__log-button', '.live__phases']) {
      expect(css(container.querySelector(sel)!, 'z-index'), sel).toContain('--z-overlay');
    }
  });
});

describe('wave 33 §L2: accent as text', () => {
  /*
   * §L2 — `--accent` as TEXT is `--accent-ink` (w32 R): `--accent` itself
   * stays reserved for borders and the colour-pie, which do not need the
   * contrast `--accent-ink` was built for (`styles.css`'s own token comment).
   * Every one of this file's five `color: var(--accent)` lines becomes
   * `--accent-ink`; the six `border-color: var(--accent)` lines are untouched.
   */
  it('§L2: every text colour in live.css reads --accent-ink, never bare --accent', () => {
    const css = liveCss();
    expect(css, 'no text colour reads the raw token any more').not.toMatch(/(?<!border-)color: var\(--accent\);/);
  });
});

/*
 * ── Wave 35 lane L ──────────────────────────────────────────────────────
 */

describe('R11 — the turn counter leaves the phase bar for the logbook', () => {
  it('live-turn / live-turn-n live in the logbook now, not the rail; data-turn/data-whose stay on the rail', async () => {
    const { getByTestId } = await liveBoard();
    const rail = getByTestId('live-phases');
    const logbook = getByTestId('live-logbook');
    const turn = getByTestId('live-turn');
    expect(rail.contains(turn), 'the turn line left the rail').toBe(false);
    expect(logbook.contains(turn), 'and lives in the logbook').toBe(true);
    expect(getByTestId('live-turn-n').textContent).toBe('14');
    // The specs’ hook is kept, on the rail, regardless of where the turn text moved.
    expect(rail.dataset.turn).toBe('14');
    expect(rail.dataset.whose).toMatch(/^(yours|theirs|nobody)$/);
  });
});

describe('R8 — the log button is an icon with an accessible name', () => {
  it('draws no visible "Log" text, carries aria-label, and its glyph is decorative', async () => {
    const { getByTestId } = await liveBoard();
    const toggle = getByTestId('live-log-toggle');
    expect(toggle.textContent?.trim()).toBe('');
    expect(toggle.getAttribute('aria-label')).toBe('Log');
    expect(toggle.querySelector('svg[aria-hidden="true"]'), 'the glyph itself says nothing twice').not.toBeNull();
  });
});

/** A Game delta: the phase, and whose turn it is. Forge's own structured facts. */
/**
 * Forge's stack, set to exactly these stack items. The fixture's own board has
 * two items on it (Direct Current and Fire Urchin's trigger), so a test about
 * the EMPTY-stack priority pass empties it first (the pass the pop-up's `Next
 * Phase` presses).
 */
function stackDelta(m: LiveMatch, ids: number[] = []) {
  return parseServerFrame({
    kind: 'notify',
    method: 'applyDelta',
    payload: {
      packet: {
        seq: m.view!.seq + 1,
        checksum: 0,
        checksumProperties: [],
        newObjects: {},
        objectDeltas: {
          [String(deltaKey(DELTA_TYPE.game, 1))]: { _type: DELTA_TYPE.game, _id: 1, Stack: { t: 'list', v: ids.map((id) => ({ t: 'int', v: id })) } },
        },
        events: [],
      },
    },
  });
}

function phaseDelta(m: LiveMatch, name: string, playerTurn: number) {
  return parseServerFrame({
    kind: 'notify',
    method: 'applyDelta',
    payload: {
      packet: {
        seq: m.view!.seq + 1,
        checksum: 0,
        checksumProperties: [],
        newObjects: {},
        objectDeltas: {
          [String(deltaKey(DELTA_TYPE.game, 1))]: {
            _type: DELTA_TYPE.game,
            _id: 1,
            Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: name },
            PlayerTurn: { t: 'int', v: playerTurn },
          },
        },
        events: [],
      },
    },
  });
}

/** `PlayerTurn` (whose turn — `view.activePlayerId`) and `Turn` (`view.turn`) together, for the Auto Yield cases below. */
function turnDelta(m: LiveMatch, playerTurn: number, turn: number) {
  return parseServerFrame({
    kind: 'notify',
    method: 'applyDelta',
    payload: {
      packet: {
        seq: m.view!.seq + 1,
        checksum: 0,
        checksumProperties: [],
        newObjects: {},
        objectDeltas: {
          [String(deltaKey(DELTA_TYPE.game, 1))]: {
            _type: DELTA_TYPE.game,
            _id: 1,
            PlayerTurn: { t: 'int', v: playerTurn },
            Turn: { t: 'int', v: turn },
          },
        },
        events: [],
      },
    },
  });
}

/*
 * The operator: *"when it's the opponents turn the 'End turn' button should
 * turn to 'Auto Yield'… Auto Yield should only last for that turn."* Same
 * testid, same slot — only the label, enablement and press change.
 */
/*
 * The operator, 2026-10-11: "'end turn' skips the remaining phases and goes straight to the opponents turn".
 * The phases Forge passes through after End Turn make no phase sound; the opponent's turn sounds as ever.
 */
describe('End Turn goes straight to the other turn', () => {
  it('the rest of the turn sounds no phase change, and the next turn sounds as usual', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const me = m.view!.players.find((p) => p.isViewer)!;
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.send(parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Priority', card: null }));
    s.send(
      parseServerFrame({ kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'OK', label2: 'End Turn', enable1: true, enable2: true, focus1: true }),
    );
    await waitFor(() => expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(getByTestId('live-button-end-turn'));
    soundCalls.length = 0;
    s.send(phaseDelta(m, 'MAIN2', me.id));
    await untilMatch(m, () => expect(m.view!.phase).toBe('MAIN2'));
    s.send(phaseDelta(m, 'END_OF_TURN', me.id));
    await untilMatch(m, () => expect(m.view!.phase).toBe('END_OF_TURN'));
    expect(soundCalls.map((e) => e.role)).not.toContain('g.phase');

    const theirTurn = m.view!.turn + 1;
    s.send(turnDelta(m, them.id, theirTurn));
    await untilMatch(m, () => expect(m.view!.turn).toBe(theirTurn));
    const endTurnLine = () =>
      s.received.find((r) => r.event === 'forge:client' && (r.payload as { data: Record<string, unknown> }).data.what === 'end-turn')?.payload as
        | { data: Record<string, unknown> }
        | undefined;
    await waitFor(() => expect(endTurnLine()?.data.phases, 'the log says how many phases End Turn passed').toBe(2));
    s.send(phaseDelta(m, 'UPKEEP', them.id));
    await waitFor(() => expect(soundCalls.map((e) => e.role)).toContain('g.phase'), { timeout: PHASE_SETTLE_MS + 1000 });
  });
});

/*
 * The operator, 2026-10-15: "can we make it so skipped phases dont trigger the 'next phase' sound? i notice i
 * hear it through every combat phase which is annoying."
 */
describe('a phase passed straight through makes no sound', () => {
  it('combat steps nobody stops in are silent; the phase a window opens in sounds at once', async () => {
    const { s, m } = await liveBoard();
    const me = m.view!.players.find((p) => p.isViewer)!;
    soundCalls.length = 0;
    for (const step of ['COMBAT_BEGIN', 'COMBAT_DECLARE_ATTACKERS', 'COMBAT_END']) {
      s.send(phaseDelta(m, step, me.id));
      await untilMatch(m, () => expect(m.view!.phase).toBe(step));
    }
    s.send(phaseDelta(m, 'MAIN2', me.id));
    await untilMatch(m, () => expect(m.view!.phase).toBe('MAIN2'));
    expect(soundCalls.map((e) => e.role), 'no step so far has held').not.toContain('g.phase');

    s.send(parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Priority', card: null }));
    s.send(
      parseServerFrame({ kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'OK', label2: 'End Turn', enable1: true, enable2: true, focus1: true }),
    );
    await waitFor(() => expect(soundCalls.filter((e) => e.role === 'g.phase')).toHaveLength(1), { timeout: 400 });
    const phaseLine = () =>
      s.received.find((r) => r.event === 'forge:client' && (r.payload as { data: Record<string, unknown> }).data.why === 'phase')?.payload as
        | { data: Record<string, unknown> }
        | undefined;
    await waitFor(() => expect(phaseLine()?.data, 'the sound log names the phase and why it sounded').toMatchObject({ phase: 'MAIN2', how: 'held' }));
  });
});

describe('Auto Yield / Cancel Yield (the End Turn slot, on the other seat’s turn)', () => {
  it('reads End Turn on the viewer’s own turn, even with no bar yet', async () => {
    const { getByTestId } = await liveBoard();
    const button = getByTestId('live-button-end-turn') as HTMLButtonElement;
    expect(button.textContent).toBe('End Turn');
    expect(button.hasAttribute('data-yield')).toBe(false);
  });

  it('reads Auto Yield the instant the OTHER seat’s turn starts, pressable with no bar at all', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.send(turnDelta(m, them.id, m.view!.turn + 1));
    await untilMatch(m, () => expect(m.view!.activePlayerId).toBe(them.id));

    const button = getByTestId('live-button-end-turn') as HTMLButtonElement;
    expect(button.textContent).toBe('Auto Yield');
    expect(button.dataset.yield).toBe('off');
    expect(button.disabled).toBe(false);
  });

  it('a press flips the label to Cancel Yield and sends forge:auto-yield, never forge:c2s', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.send(turnDelta(m, them.id, m.view!.turn + 1));
    await untilMatch(m, () => expect(m.view!.activePlayerId).toBe(them.id));

    fireEvent.click(getByTestId('live-button-end-turn'));
    // Each state is its own element (`ActionButton`): read the button afresh after every press.
    const button = (): HTMLElement => getByTestId('live-button-end-turn');
    await waitFor(() => expect(button().textContent).toBe('Cancel Yield'));
    expect(button().dataset.yield).toBe('on');
    await waitFor(() => expect(s.received.some((r) => r.event === 'forge:auto-yield')).toBe(true));
    expect(s.received.filter((r) => r.event === 'forge:auto-yield').map((r) => r.payload)).toEqual([
      { matchId: s.matchId, on: true },
    ]);
    expect(await s.framesFrom(m)).toEqual([]);

    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toBe('Auto Yield'));
    expect(button().dataset.yield).toBe('off');
  });

  it('the turn moving back to the viewer restores End Turn, and never carries a highlight meant for it', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const me = m.view!.players.find((p) => p.isViewer)!;
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.send(turnDelta(m, them.id, m.view!.turn + 1));
    await waitFor(() => expect(getByTestId('live-button-end-turn').textContent).toBe('Auto Yield'));
    fireEvent.click(getByTestId('live-button-end-turn'));
    await waitFor(() => expect(getByTestId('live-button-end-turn').textContent).toBe('Cancel Yield'));

    s.send(turnDelta(m, me.id, m.view!.turn + 1));
    await untilMatch(m, () => expect(m.view!.activePlayerId).toBe(me.id));
    const button = getByTestId('live-button-end-turn') as HTMLButtonElement;
    expect(button.textContent).toBe('End Turn');
    expect(button.hasAttribute('data-yield')).toBe(false);
    // Forge has shown nothing this turn yet, so End Turn itself is disabled —
    // the slot reverted, it did not inherit the yield press as a highlight.
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute('data-highlight')).toBe(false);
  });
});

describe('R5 — End Turn is highlighted when there is nothing left to decide', () => {
  // The fixture is the viewer's own MAIN1 with an untapped Fire Urchin: attacking
  // is still to come there, so End Turn is not highlighted (attackersLeft). These
  // cases start in MAIN2, after combat, and test their own reason.
  const pastAttackers = (m: LiveMatch) => phaseDelta(m, 'MAIN2', m.view!.players.find((p) => p.isViewer)!.id);

  const clearSelectables = () => parseServerFrame({ kind: 'notify', method: 'clearSelectables' });
  const weaklySelectable = (ids: number[]) =>
    parseServerFrame({ kind: 'notify', method: 'setWeaklySelectable', cards: ids.map((id) => ({ kind: 'card', id })) });
  const bar2 = (label2: string) =>
    parseServerFrame({
      kind: 'notify',
      method: 'updateButtons',
      owner: { kind: 'player', id: 0 },
      label1: 'OK',
      label2,
      enable1: true,
      enable2: true,
      focus1: true,
    });

  it('highlights End Turn (Forge’s label2) exactly when nothingToDecide is true', async () => {
    const { s, m, getByTestId } = await liveBoard();
    s.send(pastAttackers(m));
    await untilMatch(m, () => expect(m.view!.phase).toBe('MAIN2'));
    s.send(clearSelectables());
    s.send(bar2('End Turn'));
    await waitFor(() => expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(false));
    expect(getByTestId('live-button-end-turn').hasAttribute('data-highlight'), 'Forge has not said "nothing" yet').toBe(false);

    s.send(weaklySelectable([]));
    await untilMatch(m, () => expect(nothingToDecide(m)).toBe(true));
    await waitFor(() => expect(getByTestId('live-button-end-turn').hasAttribute('data-highlight')).toBe(true));

    // Forge names a real decision (a non-land permanent): the highlight comes off at once.
    // By type line, not a hard-coded id — lane F's land-tapping fix means an
    // untapped land in the actionable set is the common case, not a decision
    // `nothingToDecide` counts (see the next case).
    const viewerBattlefield = m.view!.players.find((p) => p.isViewer)!.battlefield;
    const nonLand = viewerBattlefield.find((c) => !c.card.typeLine.includes('Land'))!.id;
    s.send(weaklySelectable([nonLand]));
    await untilMatch(m, () => expect(nothingToDecide(m)).toBe(false));
    await waitFor(() => expect(getByTestId('live-button-end-turn').hasAttribute('data-highlight')).toBe(false));
  });

  it('an actionable set naming only the viewer’s own battlefield LAND keeps End Turn highlighted (lane F’s land-tapping fix)', async () => {
    const { s, m, getByTestId } = await liveBoard();
    s.send(pastAttackers(m));
    await untilMatch(m, () => expect(m.view!.phase).toBe('MAIN2'));
    s.send(clearSelectables());
    s.send(bar2('End Turn'));
    await waitFor(() => expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(false));

    const viewerBattlefield = m.view!.players.find((p) => p.isViewer)!.battlefield;
    const land = viewerBattlefield.find((c) => c.card.typeLine.includes('Land'))!.id;
    s.send(weaklySelectable([land]));
    await untilMatch(m, () => expect(nothingToDecide(m)).toBe(true));
    await waitFor(() => expect(getByTestId('live-button-end-turn').hasAttribute('data-highlight')).toBe(true));
  });

  it('the highlight held END_TURN_NUDGE_MS escalates to data-nudge; a new input from Forge restarts the wait', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { s, m, getByTestId } = await liveBoard();
    const endTurn = () => getByTestId('live-button-end-turn');
    s.send(pastAttackers(m));
    await untilMatch(m, () => expect(m.view!.phase).toBe('MAIN2'));
    s.send(clearSelectables());
    s.send(bar2('End Turn'));
    s.send(weaklySelectable([]));
    await waitFor(() => expect(endTurn().hasAttribute('data-highlight')).toBe(true));
    // The fixture's stack still holds two items, so the pass-to-resolve pop-up is open
    // under the highlight: the nudge never fires over a decision.
    await waitFor(() => expect(getByTestId('live-decision')).toBeTruthy());
    act(() => {
      vi.advanceTimersByTime(2 * END_TURN_NUDGE_MS);
    });
    expect(endTurn().hasAttribute('data-nudge'), 'not while a decision is open').toBe(false);

    s.send(stackDelta(m));
    await untilMatch(m, () => expect(m.view!.stack).toEqual([]));
    await waitFor(() => expect(endTurn().hasAttribute('data-highlight')).toBe(true));
    expect(endTurn().hasAttribute('data-nudge'), 'not straight away').toBe(false);

    act(() => {
      vi.advanceTimersByTime(END_TURN_NUDGE_MS);
    });
    await waitFor(() => expect(endTurn().hasAttribute('data-nudge')).toBe(true));

    // Forge shows a new input with the same answer: the highlight stays, the nudge restarts.
    s.send(weaklySelectable([]));
    await waitFor(() => expect(endTurn().hasAttribute('data-nudge')).toBe(false));
    expect(endTurn().hasAttribute('data-highlight')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(END_TURN_NUDGE_MS);
    });
    await waitFor(() => expect(endTurn().hasAttribute('data-nudge')).toBe(true));

    // A real decision appears: highlight and nudge both come off at once.
    const nonLand = m.view!.players.find((p) => p.isViewer)!.battlefield.find((c) => !c.card.typeLine.includes('Land'))!.id;
    s.send(weaklySelectable([nonLand]));
    await waitFor(() => expect(endTurn().hasAttribute('data-highlight')).toBe(false));
    expect(endTurn().hasAttribute('data-nudge')).toBe(false);
  });
});

describe('End Turn nudge — the highlight held unchanged escalates (useIdleNudge)', () => {
  function NudgeProbe({ on, state }: { on: boolean; state: unknown }) {
    const nudged = useIdleNudge(on, [state]);
    return createElement('div', { 'data-testid': 'nudge-probe', 'data-nudge': nudged ? '' : undefined });
  }
  const probe = (on: boolean, state: unknown) => createElement(NudgeProbe, { on, state });
  const nudged = (el: HTMLElement) => el.hasAttribute('data-nudge');
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off until the state has held END_TURN_NUDGE_MS, then on', () => {
    const { getByTestId } = render(probe(true, 'a'));
    advance(END_TURN_NUDGE_MS - 1);
    expect(nudged(getByTestId('nudge-probe')), 'not a moment early').toBe(false);
    advance(1);
    expect(nudged(getByTestId('nudge-probe'))).toBe(true);
    advance(5 * END_TURN_NUDGE_MS);
    expect(nudged(getByTestId('nudge-probe')), 'and it stays on while nothing changes').toBe(true);
  });

  it('never fires while the highlight is off', () => {
    const { getByTestId } = render(probe(false, 'a'));
    advance(3 * END_TURN_NUDGE_MS);
    expect(nudged(getByTestId('nudge-probe'))).toBe(false);
  });

  it('a change of the underlying state clears it in that same render and restarts the full wait', () => {
    const { getByTestId, rerender } = render(probe(true, 'a'));
    advance(END_TURN_NUDGE_MS);
    expect(nudged(getByTestId('nudge-probe'))).toBe(true);
    rerender(probe(true, 'b'));
    expect(nudged(getByTestId('nudge-probe')), 'cleared by the render that saw the change').toBe(false);
    advance(END_TURN_NUDGE_MS - 1);
    expect(nudged(getByTestId('nudge-probe')), 'the wait started again from zero').toBe(false);
    advance(1);
    expect(nudged(getByTestId('nudge-probe'))).toBe(true);
  });

  it('a change part-way through the wait restarts it', () => {
    const { getByTestId, rerender } = render(probe(true, 'a'));
    advance(END_TURN_NUDGE_MS - 100);
    rerender(probe(true, 'b'));
    advance(200);
    expect(nudged(getByTestId('nudge-probe')), 'the first span’s timer did not carry over').toBe(false);
    advance(END_TURN_NUDGE_MS - 200);
    expect(nudged(getByTestId('nudge-probe'))).toBe(true);
  });

  it('the highlight ending clears it at once, and coming back waits the full time again', () => {
    const { getByTestId, rerender } = render(probe(true, 'a'));
    advance(END_TURN_NUDGE_MS);
    rerender(probe(false, 'a'));
    expect(nudged(getByTestId('nudge-probe'))).toBe(false);
    rerender(probe(true, 'a'));
    expect(nudged(getByTestId('nudge-probe')), 'same state, but a new span').toBe(false);
    advance(END_TURN_NUDGE_MS - 1);
    expect(nudged(getByTestId('nudge-probe'))).toBe(false);
    advance(1);
    expect(nudged(getByTestId('nudge-probe'))).toBe(true);
  });
});

describe('R6 — the End Turn flicker: the rail’s resize transition is suppressed during a crawl', () => {
  function CrawlProbe({ phase }: { phase: string }) {
    const crawling = useCrawlGuard(phase);
    return createElement('div', { 'data-testid': 'crawl-probe', 'data-crawl': crawling ? '' : undefined });
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a single phase change never arms the guard', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { getByTestId } = render(createElement(CrawlProbe, { phase: 'MAIN1' }));
    expect(getByTestId('crawl-probe').hasAttribute('data-crawl')).toBe(false);
  });

  it('two phase changes under 80ms apart arm it, and it lifts after the cooldown', () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const { getByTestId, rerender } = render(createElement(CrawlProbe, { phase: 'MAIN1' }));
    now.mockReturnValue(1040);
    rerender(createElement(CrawlProbe, { phase: 'COMBAT_BEGIN' }));
    expect(getByTestId('crawl-probe').hasAttribute('data-crawl')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(getByTestId('crawl-probe').hasAttribute('data-crawl')).toBe(false);
  });

  it('an ordinary change after a crawl still lets it lift — the cooldown is not cancelled by the next phase', () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const { getByTestId, rerender } = render(createElement(CrawlProbe, { phase: 'MAIN1' }));
    now.mockReturnValue(1040);
    rerender(createElement(CrawlProbe, { phase: 'COMBAT_BEGIN' }));
    now.mockReturnValue(1200);
    rerender(createElement(CrawlProbe, { phase: 'COMBAT_DECLARE_ATTACKERS' }));
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(getByTestId('crawl-probe').hasAttribute('data-crawl')).toBe(false);
  });

  it('two phase changes 80ms or more apart do not arm it — one ordinary change is not a crawl', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const { getByTestId, rerender } = render(createElement(CrawlProbe, { phase: 'MAIN1' }));
    now.mockReturnValue(1200);
    rerender(createElement(CrawlProbe, { phase: 'COMBAT_BEGIN' }));
    expect(getByTestId('crawl-probe').hasAttribute('data-crawl')).toBe(false);
  });

  it('the transition is off while data-crawl is set', () => {
    const css = styled();
    const rail = document.body.appendChild(document.createElement('div'));
    rail.className = 'live__phases';
    onTestFinished(() => rail.remove());
    expect(css(rail, 'transition'), 'at rest it animates').not.toMatch(/^(none)?$/);
    rail.setAttribute('data-crawl', '');
    expect(css(rail, 'transition'), 'crawling it does not').toBe('none');
  });
});

describe('R16 — Victory, Defeat or Draw, and how it ended (pure logic)', () => {
  function fakePlayer(overrides: Partial<BoardPlayer> & Pick<BoardPlayer, 'id' | 'name'>): BoardPlayer {
    return {
      isViewer: false,
      isActive: false,
      hasPriority: false,
      hasLost: false,
      life: 20,
      hand: null,
      handCount: 0,
      libraryCount: 40,
      battlefield: [],
      graveyard: [],
      exile: [],
      ...overrides,
    };
  }
  function fakeView(players: BoardPlayer[], gameOverFlag = true): BoardView {
    return {
      seq: 1,
      title: 't',
      turn: 5,
      phase: null,
      phaseLabel: '',
      activePlayerId: null,
      players,
      stack: [],
      gameOver: gameOverFlag,
      missingCardIds: [],
    };
  }
  const matchWithView = (view: BoardView | null, lost: LiveMatch['lost'] = null): LiveMatch => ({ view, losers: null, lost }) as unknown as LiveMatch;

  it('the viewer lost, the opponent did not: Defeat', () => {
    const view = fakeView([
      fakePlayer({ id: 0, name: 'You', isViewer: true, hasLost: true, life: 0 }),
      fakePlayer({ id: 1, name: 'Them' }),
    ]);
    expect(gameOutcome(matchWithView(view))).toBe('defeat');
  });

  it('the opponent lost, the viewer did not: Victory', () => {
    const view = fakeView([
      fakePlayer({ id: 0, name: 'You', isViewer: true }),
      fakePlayer({ id: 1, name: 'Them', hasLost: true, life: 0 }),
    ]);
    expect(gameOutcome(matchWithView(view))).toBe('victory');
  });

  it('both lost, or neither: Draw', () => {
    const bothLost = fakeView([
      fakePlayer({ id: 0, name: 'You', isViewer: true, hasLost: true, life: 0 }),
      fakePlayer({ id: 1, name: 'Them', hasLost: true, life: 0 }),
    ]);
    expect(gameOutcome(matchWithView(bothLost))).toBe('draw');
    const neitherLost = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true }), fakePlayer({ id: 1, name: 'Them' })]);
    expect(gameOutcome(matchWithView(neitherLost))).toBe('draw');
  });

  it('null while the game is not over, and before any view exists', () => {
    const notOver = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true })], false);
    expect(gameOutcome(matchWithView(notOver))).toBeNull();
    expect(gameOutcome(matchWithView(null))).toBeNull();
  });

  it('reasonLost reads life, poison, decking and concede off facts already on BoardPlayer, in that priority', () => {
    expect(reasonLost(fakePlayer({ id: 0, name: 'A', life: 0 }))).toBe('life');
    expect(reasonLost(fakePlayer({ id: 0, name: 'A', life: 3, counters: [{ name: 'Poison', count: 10 }] }))).toBe('poison');
    expect(reasonLost(fakePlayer({ id: 0, name: 'A', life: 3, libraryCount: 0 }))).toBe('decking');
    expect(reasonLost(fakePlayer({ id: 0, name: 'A', life: 3, libraryCount: 12 }))).toBe('concede');
    // Life wins over poison when both happen to read true at once — checked first.
    expect(
      reasonLost(fakePlayer({ id: 0, name: 'A', life: 0, counters: [{ name: 'Poison', count: 10 }] })),
    ).toBe('life');
  });

  it('endingSentence names every loser by name and reason; null when nobody lost', () => {
    const view = fakeView([
      fakePlayer({ id: 0, name: 'You', isViewer: true, hasLost: true, life: 0 }),
      fakePlayer({ id: 1, name: 'Them' }),
    ]);
    expect(endingSentence(matchWithView(view), view)).toBe('You — life total reached 0');
    const nobody = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true })]);
    expect(endingSentence(matchWithView(nobody), nobody)).toBeNull();
  });

  it("endingSentence words Forge's own reason when the end notice carries one, over the board's guess", () => {
    const decked = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true, hasLost: true, libraryCount: 0 }), fakePlayer({ id: 1, name: 'Them' })]);
    expect(endingSentence(matchWithView(decked, new Map([[0, { player: 0, reason: 'Milled' }]])), decked)).toBe('You — had to draw from an empty library');
    // An empty library is not always why: an effect that ends the game names its card.
    expect(endingSentence(matchWithView(decked, new Map([[0, { player: 0, reason: 'SpellEffect', source: 'Door to Nothingness' }]])), decked)).toBe(
      'You — lost to Door to Nothingness',
    );
    expect(endingSentence(matchWithView(decked), decked), "without Forge's reason, the board's").toBe('You — had to draw from an empty library');
  });
});

describe('R16 — the result screen, drawn over the board', () => {
  const GAME_KEY = String(deltaKey(DELTA_TYPE.game, 1));
  const gameOverDelta = (seq: number, loserId: number) =>
    parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: {
          seq,
          checksum: 0,
          checksumProperties: [],
          newObjects: {},
          objectDeltas: {
            [GAME_KEY]: { _type: DELTA_TYPE.game, _id: 1, GameOver: { t: 'bool', v: true } },
            [String(deltaKey(DELTA_TYPE.player, loserId))]: {
              _type: DELTA_TYPE.player,
              _id: loserId,
              HasLost: { t: 'bool', v: true },
              Life: { t: 'int', v: 0 },
            },
          },
          events: [],
        },
      },
    });

  it("Victory from Forge's finishGame alone, when the view's GameOver delta never comes (w35 R16, 2026-10-08)", async () => {
    // No GameOver delta ever arrives, so the result screen only shows once `useGameEnded`'s
    // END_UNSHOWN_MS fallback fires. Real timers would need END_UNSHOWN_MS (2s) of wall clock,
    // longer than waitFor's default budget on a fast host; advance the fake clock instead.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    const loserId = m.view!.players.find((p) => !p.isViewer)!.id;
    // Forge's last flush carried only the loser's outcome: no `GameOver` on the game.
    const outcomeOnly = parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: {
          seq: m.view!.seq + 1,
          checksum: 0,
          checksumProperties: [],
          newObjects: {},
          objectDeltas: {
            [String(deltaKey(DELTA_TYPE.player, loserId))]: { _type: DELTA_TYPE.player, _id: loserId, HasLost: { t: 'bool', v: true } },
          },
          events: [],
        },
      },
    });
    s.send(outcomeOnly);
    await untilMatch(m, () => expect(m.view!.players.find((p) => p.id === loserId)!.hasLost).toBe(true));
    expect(queryByTestId('game-result'), 'the loser is drawn as lost, but nothing yet says the game is over').toBeNull();

    s.send(parseServerFrame({ kind: 'notify', method: 'finishGame' }));
    await untilMatch(m, () => expect(m.finished).toBe(true));
    act(() => {
      vi.advanceTimersByTime(END_UNSHOWN_MS);
    });
    await waitFor(() => expect(getByTestId('game-result').dataset.result).toBe('victory'));
    expect(getByTestId('game-result').textContent).toContain('Victory');
  });

  it('Victory from the end notice alone, when this view never caught up with the end (a concede during the deal)', async () => {
    // Same fallback as above: this view's `GameOver` delta never comes, only the notice.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { s, m, getByTestId } = await liveBoard();
    const loserId = m.view!.players.find((p) => !p.isViewer)!.id;
    expect(m.view!.players.some((p) => p.hasLost), 'nobody is drawn as lost').toBe(false);
    expect((getByTestId('live-concede') as HTMLButtonElement).disabled).toBe(false);

    s.send(parseServerFrame({ kind: 'notify', method: 'finishGame', losers: [loserId] }));
    await untilMatch(m, () => expect(m.finished).toBe(true));
    act(() => {
      vi.advanceTimersByTime(END_UNSHOWN_MS);
    });
    await waitFor(() => expect(getByTestId('game-result').dataset.result).toBe('victory'));
    expect(getByTestId('game-result').textContent).toContain('conceded');
    expect((getByTestId('live-concede') as HTMLButtonElement).disabled, 'a finished game cannot be conceded').toBe(true);
  });

  it("the end notice's own reason is the one the result screen words: a decked player had to draw", async () => {
    // Same fallback again: the notice carries the reason, but no `GameOver` delta ever shows it.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { s, m, getByTestId } = await liveBoard();
    const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
    s.send(parseServerFrame({ kind: 'notify', method: 'finishGame', losers: [viewerId], lost: [{ player: viewerId, reason: 'Milled' }] }));
    await untilMatch(m, () => expect(m.finished).toBe(true));
    act(() => {
      vi.advanceTimersByTime(END_UNSHOWN_MS);
    });
    await waitFor(() => expect(getByTestId('game-result').dataset.result).toBe('defeat'));
    expect(getByTestId('game-result').textContent).toContain('had to draw from an empty library');
  });

  it('Defeat, over the still-visible board, with no known room: Rematch has no table to ready at, Main menu goes to the lobby', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
    s.send(gameOverDelta(m.view!.seq + 1, viewerId));

    await waitFor(() => expect(getByTestId('game-result').dataset.result).toBe('defeat'));
    expect(getByTestId('game-result').textContent).toContain('Defeat');
    expect(getByTestId('game-result').textContent).toContain('life total reached 0');
    // Over the board, which stays visible behind it (shape 4).
    expect(document.querySelector('.board'), 'the board is still drawn underneath').not.toBeNull();

    expect((getByTestId('game-result-rematch') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('game-result-room') as HTMLButtonElement).disabled, 'no room to go back to').toBe(true);

    fireEvent.click(getByTestId('game-result-menu'));
    expect(roomsClientState.leave, 'no room to leave').not.toHaveBeenCalled();
    await waitFor(() => expect(globalThis.location.hash).toBe('#/'));
  });

  /** A finished game in room `r-1`: the opponent lost, so the viewer sees Victory. */
  /**
   * The end's last beats (`noteBoardDrawing`) run on real timers, and the result screen waits for them
   * (`useAfterTheBoard`); this waits on the board itself, with no deadline, so a `waitFor` after it covers
   * only the screen's own draw — on a loaded host the beats alone outlasted its second.
   */
  async function untilBoardStill(): Promise<void> {
    await act(() => new Promise<void>((resolve) => whenBoardStill(resolve)));
  }

  /** The outcome first, then Next opens the sideboard step (the operator, 2026-10-19). */
  async function toSideboard(getByTestId: (id: string) => HTMLElement): Promise<void> {
    fireEvent.click(await waitFor(() => getByTestId('game-result-next')));
  }

  async function victoryInRoom() {
    const s = (server = await startReplayServer());
    const m = (match = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    }));
    const utils = render(createElement(LiveBoard, { match: m, roomId: 'r-1' }));
    await untilMatch(m, () => expect(m.stats.snapshots).toBe(1));
    const frames = fixtureFrames();
    for (const f of frames) s.send(f);
    await untilMatch(m, () => expect(m.stats.applied).toBe(frames.length));
    await waitFor(() => expect(utils.getByTestId('live-turn-n').textContent).toBe('14'));

    const opponentId = m.view!.players.find((p) => !p.isViewer)!.id;
    s.send(gameOverDelta(m.view!.seq + 1, opponentId));
    await untilMatch(m, () => expect(m.over).toBe(true));
    await untilBoardStill();
    await waitFor(() => expect(utils.getByTestId('game-result').dataset.result).toBe('victory'));
    const rematch = () => utils.getByTestId('game-result-rematch') as HTMLButtonElement;
    const check = (you: boolean) =>
      utils.container.querySelector(`[data-testid="game-result-face"][data-you="${you}"] [data-testid="game-result-check"]`);
    return { ...utils, rematch, check };
  }

  it('Victory: Rematch readies me — a check over my face, nothing started — and pressing again stands me down', async () => {
    const { getByTestId, rematch, check } = await victoryInRoom();
    expect(getByTestId('game-result').textContent).toContain('Victory');
    await waitFor(() => expect(rematch().disabled, 'the table has answered').toBe(false));
    expect(check(true)).toBeNull();

    fireEvent.click(rematch());
    await waitFor(() => expect(check(true), 'my check').not.toBeNull());
    expect(tableState.ready, 'the press says it is a Rematch').toHaveBeenCalledWith('r-1', true, undefined, { rematch: true });
    expect(rematch().getAttribute('aria-pressed')).toBe('true');
    expect(rematch().hasAttribute('data-highlight'), 'my own press is not a highlight').toBe(false);
    expect(check(false), 'they have not pressed').toBeNull();
    expect(tableState.startRoom, 'one press starts nothing').not.toHaveBeenCalled();
    expect(globalThis.location.hash).not.toBe('#/match/m-next00000000');

    fireEvent.click(rematch());
    await waitFor(() => expect(check(true), 'pressed again: taken back').toBeNull());
    expect(tableState.ready).toHaveBeenLastCalledWith('r-1', false);
    expect(rematch().getAttribute('aria-pressed')).toBe('false');
  });

  it('the other player pressed first: their check, my button highlighted; my press starts the match once and goes to it', async () => {
    tableState.other.ready = true;
    const { rematch, check } = await victoryInRoom();
    await waitFor(() => expect(check(false), 'their check').not.toBeNull());
    expect(rematch().getAttribute('data-highlight')).toBe('true');

    fireEvent.click(rematch());
    await waitFor(() => expect(globalThis.location.hash).toBe('#/match/m-next00000000'));
    expect(tableState.startRoom).toHaveBeenCalledTimes(1);
    expect(tableState.startRoom).toHaveBeenCalledWith('r-1');
  });

  it('a series a room change interrupted is not rematched: the table no longer lists this game', async () => {
    // The room's mode changed after this game: both stay seated (AF344), but the table's series is a fresh one.
    const series = { length: 1, wins: [0, 0], games: [], phase: 'seating' };
    roomsClientState.room = { settings: { handSmoothing: true }, mode: 'random', tables: [{ id: 't-1', players: [], matchId: null, series }], pod: null };
    tableState.phase = 'seating';
    const { rematch } = await victoryInRoom();
    expect(rematch().disabled, 'nothing of the interrupted series to rematch').toBe(true);
  });

  /* Two reads of the same thing in flight: the older answering last must not put the older state back (`../../rooms/latest.ts`). */
  describe('a read a newer one overtook', () => {
    const release = async (held: (() => void)[], i: number): Promise<void> => {
      await act(async () => {
        held[i]!();
      });
    };

    it('the table: an older read answering last does not take back what the newer one showed', async () => {
      const { check } = await victoryInRoom();
      tableState.hold = true;
      tableState.other.ready = true;
      roomPing();
      await waitFor(() => expect(tableState.held).toHaveLength(1));
      tableState.other.ready = false;
      roomPing();
      await waitFor(() => expect(tableState.held).toHaveLength(2));

      await release(tableState.held, 1);
      expect(check(false), 'the newer read: they have not pressed').toBeNull();
      await release(tableState.held, 0);
      expect(check(false), 'the older read lands nothing').toBeNull();
    });

    it('the table: a read sent before my own Rematch answered is asked again, not landed', async () => {
      const { rematch, check } = await victoryInRoom();
      await waitFor(() => expect(rematch().disabled).toBe(false));
      tableState.hold = true;
      roomPing();
      await waitFor(() => expect(tableState.held).toHaveLength(1));
      fireEvent.click(rematch());
      await waitFor(() => expect(check(true), 'my check').not.toBeNull());

      tableState.hold = false;
      await release(tableState.held, 0);
      await waitFor(() => expect(check(true), 'the read from before my press does not take it back').not.toBeNull());
      expect(rematch().getAttribute('aria-pressed')).toBe('true');
    });

    it('the room: an older read answering last does not put the older room back', async () => {
      const series = { length: 3, wins: [2, 1], games: [], phase: 'done' };
      roomsClientState.room = { settings: { handSmoothing: true }, mode: null, tables: [{ id: 't-1', players: [], matchId: null, series }], pod: null };
      const { queryByTestId } = await victoryInRoom();
      await waitFor(() => expect(queryByTestId('game-result-rematch')).not.toBeNull());

      // Each table move makes the tick read the room again.
      roomsClientState.hold = true;
      tableState.other.ready = true;
      roomPing();
      await waitFor(() => expect(roomsClientState.held).toHaveLength(1));
      roomsClientState.room = { ...roomsClientState.room, mode: 'gauntlet' };
      tableState.other.ready = false;
      roomPing();
      await waitFor(() => expect(roomsClientState.held).toHaveLength(2));

      await release(roomsClientState.held, 1);
      await waitFor(() => expect(queryByTestId('game-result-rematch'), 'the newer room: a Gauntlet').toBeNull());
      await release(roomsClientState.held, 0);
      expect(queryByTestId('game-result-rematch'), 'the older room lands nothing').toBeNull();
    });
  });

  it("the other screen started the match: this one follows the room's new match", async () => {
    const { rematch, check } = await victoryInRoom();
    await waitFor(() => expect(rematch().disabled).toBe(false));
    fireEvent.click(rematch());
    await waitFor(() => expect(check(true)).not.toBeNull());
    tableState.matchId = 'm-theirs000000';
    roomPing();
    await waitFor(() => expect(globalThis.location.hash).toBe('#/match/m-theirs000000'));
  });

  it('the other player leaves: their check and my highlight go, and Rematch has nobody to agree with', async () => {
    tableState.other.ready = true;
    const { rematch, check } = await victoryInRoom();
    await waitFor(() => expect(check(false)).not.toBeNull());
    tableState.other = { ready: false, present: false };
    roomPing();
    await waitFor(() => expect(check(false), 'their check is gone').toBeNull());
    expect(rematch().hasAttribute('data-highlight')).toBe(false);
    expect(rematch().disabled).toBe(true);
  });

  it('a game played alone against the bot: Rematch readies the one seat, and a series that did not convert starts the next bot game at once', async () => {
    tableState.other = { ready: false, present: false };
    const { rematch } = await victoryInRoom();
    await waitFor(() => expect(rematch().disabled).toBe(false));
    fireEvent.click(rematch());
    await waitFor(() => expect(globalThis.location.hash).toBe('#/match/m-bot000000000'));
    expect(tableState.ready, 'the press says it is a Rematch').toHaveBeenCalledWith('r-1', true, undefined, { rematch: true });
    expect(tableState.startVsBot, 'the start says it is a Rematch, so the bot keeps its deck').toHaveBeenCalledWith('r-1', undefined, { rematch: true });
  });

  it('Main menu leaves the room first, then goes to the lobby', async () => {
    const { getByTestId } = await victoryInRoom();
    fireEvent.click(getByTestId('game-result-menu'));
    await waitFor(() => expect(roomsClientState.leave).toHaveBeenCalledWith('r-1'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/'));
  });

  it('Back to room opens the room and changes nothing at its table: no leave, no ready, no start', async () => {
    const { getByTestId } = await victoryInRoom();
    const labels = Array.from(getByTestId('game-result').querySelectorAll('.confirm__actions button')).map((b) => b.textContent);
    expect(labels).toEqual(['Rematch', 'Back to room', 'Main menu']);
    fireEvent.click(getByTestId('game-result-room'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/room/r-1'));
    expect(roomsClientState.leave).not.toHaveBeenCalled();
    expect(tableState.ready).not.toHaveBeenCalled();
    expect(tableState.startRoom).not.toHaveBeenCalled();
  });

  it('Draw: both players hasLost — neither Victory nor Defeat', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
    const opponentId = m.view!.players.find((p) => !p.isViewer)!.id;
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'applyDelta',
        payload: {
          packet: {
            seq: m.view!.seq + 1,
            checksum: 0,
            checksumProperties: [],
            newObjects: {},
            objectDeltas: {
              [GAME_KEY]: { _type: DELTA_TYPE.game, _id: 1, GameOver: { t: 'bool', v: true } },
              [String(deltaKey(DELTA_TYPE.player, viewerId))]: { _type: DELTA_TYPE.player, _id: viewerId, HasLost: { t: 'bool', v: true } },
              [String(deltaKey(DELTA_TYPE.player, opponentId))]: { _type: DELTA_TYPE.player, _id: opponentId, HasLost: { t: 'bool', v: true } },
            },
            events: [],
          },
        },
      }),
    );
    await waitFor(() => expect(getByTestId('game-result').dataset.result).toBe('draw'));
    expect(getByTestId('game-result').textContent).toContain('Draw');
  });

  /* ── wave 72 §Q.3/§Q.4: series on screen, and the sideboard step ────────── */

  describe('series on screen (wave 72 §Q)', () => {
    it('between the games of a series that does not sideboard, the button reads "Next game"', async () => {
      // The table read says `between` too: a room and table that disagree are drawn only after
      // RESULT_SETTLE_MS gives up waiting for them, and that is not the screen this case is about.
      tableState.phase = 'between';
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [1, 0], games: [], phase: 'between' } }],
        pod: null,
      };
      const { rematch } = await victoryInRoom();
      await waitFor(() => expect(rematch().textContent).toBe('Next game'));
    });

    it.each([
      ['a person', false],
      ['the AI', true],
    ])('Next game between the games of a series whose next game is set up in the room goes back to the room, and starts nothing (against %s)', async (_who, alone) => {
      if (alone) tableState.other = { ready: false, present: false };
      tableState.phase = 'between';
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [1, 0], games: [], phase: 'between' } }],
        pod: null,
      };
      const { rematch } = await victoryInRoom();
      await waitFor(() => expect(rematch().textContent).toBe('Next game'));
      await waitFor(() => expect(rematch().disabled).toBe(false));
      globalThis.location.hash = '#/match/m-1';
      fireEvent.click(rematch());
      await waitFor(() => expect(globalThis.location.hash).toBe('#/room/r-1'));
      expect(tableState.ready).not.toHaveBeenCalled();
      expect(tableState.startRoom).not.toHaveBeenCalled();
      expect(tableState.startVsBot).not.toHaveBeenCalled();
    });

    it('a finished Bo3 reads "Rematch"', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [2, 0], games: [], phase: 'done' } }],
        pod: null,
      };
      const { rematch } = await victoryInRoom();
      await waitFor(() => expect(rematch().textContent).toBe('Rematch'));
    });

    it('a pod room has no Rematch at all — Back to room already opens the pod', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [0, 0], games: [], phase: 'done' } }],
        pod: { phase: 'rounds', seats: [], round: 1, rounds: 2, results: [], standings: [], pairings: [], bye: null, drafters: [], built: [] },
      };
      const { queryByTestId, getByTestId } = await victoryInRoom();
      await waitFor(() => expect(getByTestId('game-result-room')).toBeTruthy());
      expect(queryByTestId('game-result-rematch')).toBeNull();
    });

    /**
     * The agreeing press, with sideboarding on: the server begins the step and
     * spends both Readys in the same `POST …/ready` (`routes.ts`), so its
     * answer reads both seats unready. The screen must take that as "the step
     * has begun": no second press, no start, and a sideboard Ready that reads
     * unpressed, never "Waiting for the other player…".
     */
    it('Rematch that begins sideboarding: the answer reads both unready — no re-press, no start, the step opens unpressed', async () => {
      const sideboardingRoom = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      roomsClientState.room = {
        ...sideboardingRoom,
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [1, 0], games: [], phase: 'done' } }],
      };
      tableState.other.ready = true;
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n60 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      tableState.ready.mockImplementationOnce(() => {
        tableState.me.ready = false;
        tableState.other.ready = false;
        roomsClientState.room = sideboardingRoom;
      });
      const { getByTestId, rematch } = await victoryInRoom();
      await waitFor(() => expect(rematch().disabled).toBe(false));
      fireEvent.click(rematch());
      await waitFor(() => expect(tableState.ready).toHaveBeenCalledWith('r-1', true, 't-1', { rematch: true }));
      roomPing();
      await toSideboard(getByTestId);
      const ready = await waitFor(() => getByTestId('sideboard-ready'));
      expect(ready.getAttribute('aria-pressed')).toBe('false');
      expect(ready.textContent).toContain('Ready');
      expect(ready.textContent).not.toContain('✓');
      roomPing();
      await waitFor(() => expect(getByTestId('sideboard-ready')).toBeTruthy());
      expect(tableState.ready).toHaveBeenCalledTimes(1);
      expect(tableState.startRoom).not.toHaveBeenCalled();
    });

    /**
     * Claw run 39093583786: bob's screen never read alice's press (it landed
     * between two of his table reads), so his own agreeing press took the
     * table from "nobody ready" to "nobody ready" — the agreement spends both
     * Readys. Only the table's `phase` moved, and the screen must still notice
     * and read the room, or the sideboard step never opens for him.
     */
    it('Rematch that begins sideboarding when the other press was never seen: the phase alone opens the step', async () => {
      const sideboardingRoom = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      roomsClientState.room = {
        ...sideboardingRoom,
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [1, 0], games: [], phase: 'done' } }],
      };
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n60 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      tableState.ready.mockImplementationOnce(() => {
        tableState.me.ready = false;
        tableState.phase = 'sideboarding';
        roomsClientState.room = sideboardingRoom;
      });
      const { getByTestId, rematch } = await victoryInRoom();
      await waitFor(() => expect(rematch().disabled).toBe(false));
      fireEvent.click(rematch());
      await waitFor(() => expect(tableState.ready).toHaveBeenCalledWith('r-1', true, 't-1', { rematch: true }));
      roomPing();
      await toSideboard(getByTestId);
      await waitFor(() => expect(getByTestId('sideboard-step')).toBeTruthy());
      expect(tableState.startRoom).not.toHaveBeenCalled();
    });

    it('a pod of one has no Next game once its series is over — Back to room, to the standings', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [2, 0], games: [], phase: 'done' } }],
        pod: { phase: 'done', seats: [], round: 1, rounds: 1, results: [], standings: [], pairings: [], bye: null, built: [] },
      };
      tableState.other = { ready: false, present: false };
      const { getByTestId, queryByTestId } = await victoryInRoom();
      await waitFor(() => expect(getByTestId('game-result-room')).toBeTruthy());
      expect(queryByTestId('game-result-rematch')).toBeNull();
      expect(queryByTestId('game-result-next')).toBeNull();
      expect(tableState.startVsBot).not.toHaveBeenCalled();
    });

    it.each([
      ['a person', false],
      ['the AI', true],
    ])('a decided Gauntlet has no Rematch — Back to room, where a new one is set up (against %s)', async (_who, alone) => {
      if (alone) tableState.other = { ready: false, present: false };
      tableState.phase = 'done';
      roomsClientState.room = {
        settings: { handSmoothing: true },
        mode: 'gauntlet',
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [2, 1], games: [], phase: 'done' } }],
        pod: null,
      };
      const { getByTestId, queryByTestId } = await victoryInRoom();
      await waitFor(() => expect(getByTestId('game-result-room')).toBeTruthy());
      expect(queryByTestId('game-result-rematch')).toBeNull();
      expect(tableState.startVsBot).not.toHaveBeenCalled();
      expect(tableState.ready).not.toHaveBeenCalled();
    });

    it('against the AI, my sideboard Ready alone starts the next game — the bot’s, not a two-player start', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [0, 1], games: [], phase: 'sideboarding' } }],
        pod: { phase: 'rounds', seats: [], round: 1, rounds: 1, results: [], standings: [], pairings: [], bye: null, built: [] },
      };
      tableState.phase = 'sideboarding';
      tableState.other = { ready: false, present: false };
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n40 Island\n[Sideboard]\n' }, rules: { kind: 'draft', draftId: 'r-1' } } };
      const { getByTestId } = await victoryInRoom();
      await toSideboard(getByTestId);
      await waitFor(() => expect(getByTestId('sideboard-step')).toBeTruthy());
      expect(tableState.startVsBot).not.toHaveBeenCalled();
      fireEvent.click(getByTestId('sideboard-ready'));
      await waitFor(() => expect(tableState.ready).toHaveBeenCalledWith('r-1', true, 't-1'));
      roomPing(); // the server's push of my own write
      await waitFor(() => expect(tableState.startVsBot).toHaveBeenCalledWith('r-1', 't-1'));
      expect(tableState.startRoom).not.toHaveBeenCalled();
    });

    /**
     * The operator's pod (2026-10-19) and claw run 39207516746: the first room
     * read was taken before the game was recorded — it still said `playing`
     * while the table already said `sideboarding` — so the sideboard step never
     * opened and Back to room was all there was. Now nothing is drawn until the
     * two agree, and a room read that is behind the table is taken again.
     */
    it('a room read from before the game was recorded is read again, and nothing shows until it agrees with the table', async () => {
      const s = (server = await startReplayServer());
      const pod = { phase: 'rounds', seats: [], round: 1, rounds: 1, results: [], standings: [], pairings: [], bye: null, drafters: [], built: [] };
      const settings = { handSmoothing: true };
      // Before the game is recorded: the match is still the table's live game.
      roomsClientState.room = { settings, pod, tables: [{ id: 't-1', players: [], matchId: s.matchId, series: { length: 3, wins: [0, 0], games: [], phase: 'playing' } }] };
      // Two reads still from before; the one after that finds it recorded.
      roomsClientState.afterGet = () => {
        if (roomsClientState.gets < 2) return;
        roomsClientState.room = { settings, pod, tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [0, 1], games: [{ matchId: s.matchId, winner: 1 }], phase: 'sideboarding' } }] };
        roomsClientState.afterGet = null;
      };
      tableState.phase = 'sideboarding';
      tableState.other = { ready: false, present: false };
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n40 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      const m = (match = startMatch({
        matchId: s.matchId,
        transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
      }));
      const shown: string[] = [];
      const utils = render(createElement(LiveBoard, { match: m, roomId: 'r-1' }));
      const observer = new MutationObserver(() => {
        if (utils.queryByTestId('sideboard-loading') !== null) shown.push('sideboard-loading');
        else if (utils.queryByTestId('game-result-room') !== null && utils.queryByTestId('sideboard-step') === null && utils.queryByTestId('game-result-next') === null) shown.push('back-to-room-alone');
        if (utils.queryByTestId('game-result-rematch') !== null) shown.push('rematch');
      });
      observer.observe(utils.container, { childList: true, subtree: true });
      await untilMatch(m, () => expect(m.stats.snapshots).toBe(1));
      const frames = fixtureFrames();
      for (const f of frames) s.send(f);
      await untilMatch(m, () => expect(m.stats.applied).toBe(frames.length));
      await waitFor(() => expect(utils.getByTestId('live-turn-n').textContent).toBe('14'));
      s.send(gameOverDelta(m.view!.seq + 1, m.view!.players.find((p) => !p.isViewer)!.id));
      await untilMatch(m, () => expect(m.over).toBe(true));
      await waitFor(() => expect(roomsClientState.gets).toBe(2));
      // Both reads so far are behind the table: nothing is drawn yet.
      expect(utils.queryByTestId('game-result')).toBeNull();
      // The next tick of the room (another seat's write, the fallback timer)
      // reads the table, sees the room behind it, and reads the room again.
      roomPing();
      await toSideboard(utils.getByTestId);
      await waitFor(() => expect(utils.getByTestId('sideboard-step')).toBeTruthy(), { timeout: 3_000 });
      observer.disconnect();
      expect(roomsClientState.gets).toBeGreaterThanOrEqual(2);
      // It opened on the outcome with Next, then the step: no Back-to-room-only screen, no Rematch, first.
      expect(shown).toEqual([]);
    });

    // The operator, 2026-10-19: "victory screen should show when winning a match in pod … let the player click 'next'".
    it('between games, shows the outcome first, and Next opens the sideboard step', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 3, wins: [1, 0], games: [], phase: 'sideboarding' } }],
        pod: { phase: 'rounds', seats: [], round: 1, rounds: 2, results: [], standings: [], pairings: [], bye: null, built: [] },
      };
      tableState.phase = 'sideboarding';
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n40 Island\n[Sideboard]\n' }, rules: { kind: 'draft', draftId: 'r-1' } } };
      const { getByTestId, queryByTestId } = await victoryInRoom();
      const next = await waitFor(() => getByTestId('game-result-next'));
      expect(getByTestId('game-result').dataset['result']).toBe('victory');
      expect(queryByTestId('sideboard-step')).toBeNull();
      expect(queryByTestId('game-result-rematch')).toBeNull();
      fireEvent.click(next);
      await waitFor(() => expect(getByTestId('sideboard-step')).toBeTruthy());
    });

    it('mounting the sideboard step sends no ready request — the server already began it with nobody ready', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      tableState.phase = 'sideboarding';
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n60 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      const { getByTestId } = await victoryInRoom();
      await toSideboard(getByTestId);
      await waitFor(() => expect(getByTestId('sideboard-ready')).toBeTruthy());
      roomPing();
      await waitFor(() => expect(getByTestId('sideboard-ready')).toBeTruthy());
      expect(tableState.ready).not.toHaveBeenCalled();
    });

    it('a drafted 75 sideboards with the basics counters and a floor of 40; a constructed one with neither', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      tableState.phase = 'sideboarding';
      tableState.me = {
        ready: false,
        present: true,
        choice: { deck: { dck: '[Main]\n23 Lightning Bolt\n17 Mountain\n[Sideboard]\n2 Abrade\n' }, rules: { kind: 'draft', draftId: 'pod-1' } },
      };
      const { getByTestId } = await victoryInRoom();
      await toSideboard(getByTestId);
      await waitFor(() => expect(getByTestId('sideboard-ready')).toBeTruthy());
      expect(getByTestId('sideboard-step').querySelector('[data-testid="basics"]'), 'basics are free on a drafted pool').not.toBeNull();
      expect(getByTestId('basic-Mountain-count').textContent).toBe('17');
      fireEvent.click(getByTestId('basic-Mountain-less'));
      expect(getByTestId('deck-meter').textContent).toBe('39/40');
    });

    it('a constructed 75 has no basics counters on its sideboard step', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      tableState.phase = 'sideboarding';
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n60 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      const { getByTestId } = await victoryInRoom();
      await toSideboard(getByTestId);
      await waitFor(() => expect(getByTestId('sideboard-ready')).toBeTruthy());
      expect(getByTestId('sideboard-step').querySelector('[data-testid="basics"]')).toBeNull();
    });

    it('both Ready on the sideboard step: the other seat readied first, mine completes the agreement and starts the next game on this table', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      tableState.phase = 'sideboarding';
      tableState.other.ready = true;
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n60 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      const { getByTestId } = await victoryInRoom();
      await toSideboard(getByTestId);
      await waitFor(() => expect(getByTestId('sideboard-step')).toBeTruthy());
      expect(tableState.startRoom).not.toHaveBeenCalled();
      fireEvent.click(getByTestId('sideboard-ready'));
      await waitFor(() => expect(tableState.ready).toHaveBeenCalledWith('r-1', true, 't-1'));
      roomPing(); // the server's push of my own write
      await waitFor(() => expect(tableState.startRoom).toHaveBeenCalledWith('r-1', 't-1'));
    });

    /**
     * A real-Forge run found `sideboard-ready` below the fold at 1280×800:
     * `.confirm`'s dialog sizes to its content, and the full editor's card
     * grids are easily taller than the window. The fix (`deckEditor.css`'s
     * own note) is a bounded box with ONE scrolling part; this pins down
     * the structure that makes it work — `sideboard-ready` a SIBLING of the
     * scroller, never a descendant of it, so capping the scroller's height
     * can never also hide the button inside it.
     */
    it('Ready sits OUTSIDE the editor’s scrolling areas, in the deck’s own bar (the fix for the below-the-fold defect)', async () => {
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      tableState.phase = 'sideboarding';
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n60 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      const { getByTestId } = await victoryInRoom();
      await toSideboard(getByTestId);
      const ready = await waitFor(() => getByTestId('sideboard-ready'));
      const step = getByTestId('sideboard-step');
      for (const scroller of [getByTestId('side-grid'), getByTestId('main-grid')]) {
        expect(step.contains(scroller), 'the step holds the editor’s scrolling areas').toBe(true);
        expect(scroller.contains(ready), 'Ready is not inside one').toBe(false);
      }
      expect(ready.closest('.deck-editor__bar'), 'Ready is in the deck’s bar, which never scrolls').not.toBeNull();
    });

    it('the sideboard editor: Ready submits the current 75 through PUT …/deck, then readies — an unchanged deck is a valid submission', async () => {
      const dck = '[Main]\n4 Lightning Bolt\n56 Island\n[Sideboard]\n2 Abrade\n';
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      tableState.phase = 'sideboarding';
      tableState.me = { ready: false, present: true, choice: { deck: { dck }, rules: CONSTRUCTED_RULES } };
      const { getByTestId, queryByTestId } = await victoryInRoom();
      // No Rematch press: the step opens on its own once `phase` says so.
      await toSideboard(getByTestId);
      await waitFor(() => expect(getByTestId('sideboard-step')).toBeTruthy());
      expect(queryByTestId('game-result-rematch'), 'the editor replaces the button, not beside it').toBeNull();

      fireEvent.click(getByTestId('sideboard-ready'));
      await waitFor(() => expect(tableState.ready).toHaveBeenCalledWith('r-1', true, 't-1'));
      expect(tableState.loadDeck).toHaveBeenCalledTimes(1);
      const [calledRoomId, sent] = tableState.loadDeck.mock.calls[0]!;
      expect(calledRoomId).toBe('r-1');
      const roundTripped = deckFromDeckFile(parseDck((sent as { dck: string }).dck));
      expect(roundTripped.main.find((e) => e.card.name === 'Lightning Bolt')?.count).toBe(4);
      expect(roundTripped.main.find((e) => e.card.name === 'Island')?.count).toBe(56);
      expect(roundTripped.sideboard.find((e) => e.card.name === 'Abrade')?.count).toBe(2);
      await waitFor(() => expect(getByTestId('sideboard-ready').getAttribute('aria-pressed')).toBe('true'));
    });

    it('a 409 from the server’s 75 check shows its own sentence', async () => {
      tableState.loadDeckRefusal = 'during sideboarding you may only move cards between your main deck and sideboard';
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [{ id: 't-1', players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'sideboarding' } }],
        pod: null,
      };
      tableState.phase = 'sideboarding';
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n60 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      const { getByTestId } = await victoryInRoom();
      await toSideboard(getByTestId);
      await waitFor(() => expect(getByTestId('sideboard-step')).toBeTruthy());

      fireEvent.click(getByTestId('sideboard-ready'));
      await waitFor(() => expect(getByTestId('sideboard-refusal').textContent).toBe(tableState.loadDeckRefusal));
      // No ready at all is sent once `loadDeck` itself refused.
      expect(tableState.ready).not.toHaveBeenCalled();
    });

    /**
     * A pod room holds several tables (wave 72 §P); this match's OWN table
     * can be any of them, never assumed to be `tables[0]`. Built directly
     * (not through `victoryInRoom`, which always addresses `'r-1'`'s single
     * table) because the room has to be set up with the real match id this
     * screen is showing BEFORE it is rendered: `findMyTable` matches a
     * table by `series.games[].matchId` — the shape a game reaches it in
     * once it has actually ended (`recordGameResult` clears `table.matchId`
     * at that same moment, wave 72 §P's eager series).
     */
    it('a room with several tables: the sideboard step addresses THIS match’s own table, never tables[0]', async () => {
      const s = (server = await startReplayServer());
      const m = (match = startMatch({
        matchId: s.matchId,
        transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
      }));
      roomsClientState.room = {
        settings: { handSmoothing: true },
        tables: [
          {
            id: 't-other0000',
            players: [],
            matchId: null,
            series: { length: 3, wins: [2, 0], games: [{ matchId: 'm-someoneelse', winner: 0 }], phase: 'done' },
          },
          {
            id: 't-mine00000',
            players: [],
            matchId: null,
            series: { length: 3, wins: [0, 1], games: [{ matchId: s.matchId, winner: 1 }], phase: 'sideboarding' },
          },
        ],
        pod: { phase: 'rounds', seats: [], round: 1, rounds: 1, results: [], standings: [], pairings: [], bye: null, drafters: [], built: [] },
      };
      tableState.phase = 'sideboarding';
      tableState.me = { ready: false, present: true, choice: { deck: { dck: '[Main]\n60 Island\n[Sideboard]\n' }, rules: CONSTRUCTED_RULES } };
      const utils = render(createElement(LiveBoard, { match: m, roomId: 'r-1' }));
      await untilMatch(m, () => expect(m.stats.snapshots).toBe(1));
      const frames = fixtureFrames();
      for (const f of frames) s.send(f);
      await untilMatch(m, () => expect(m.stats.applied).toBe(frames.length));
      await waitFor(() => expect(utils.getByTestId('live-turn-n').textContent).toBe('14'));
      const opponentId = m.view!.players.find((p) => !p.isViewer)!.id;
      s.send(gameOverDelta(m.view!.seq + 1, opponentId));
      await untilMatch(m, () => expect(m.over).toBe(true));
      await untilBoardStill();
      await toSideboard(utils.getByTestId);
      await waitFor(() => expect(utils.getByTestId('sideboard-step')).toBeTruthy());

      fireEvent.click(utils.getByTestId('sideboard-ready'));
      await waitFor(() => expect(tableState.ready).toHaveBeenCalledWith('r-1', true, 't-mine00000'));
      expect(tableState.loadDeck).toHaveBeenCalledWith('r-1', { dck: expect.any(String) }, 't-mine00000');
    });
  });
});

/*
 * ── Wave 36 lane L ──────────────────────────────────────────────────────
 */

describe('T5 — the current phase’s highlight on the rail is stronger', () => {
  it('the current row is tinted and barred, in theme tokens, and not with a border every row would share', async () => {
    const css = styled();
    const { container } = await liveBoard();
    const current = container.querySelector('.live__step[data-current]')!;
    const other = container.querySelector('.live__step:not([data-current])')!;
    for (const prop of ['background', 'box-shadow']) {
      expect(css(current, prop), prop).not.toBe(css(other, prop));
      expect(css(current, prop), `${prop}: no raw colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
    // A border would add to the box model every row shares (`--rail-row-h`).
    expect(css(current, 'border-style')).toBe(css(other, 'border-style'));
  });

  it('a real rendered rail still carries exactly one data-current row, for the highlight to land on', async () => {
    const { container } = await liveBoard();
    const current = [...container.querySelectorAll('.live__step')].filter((el) => el.hasAttribute('data-current'));
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toBe('Main 1');
  });
});

describe('T2 — a calm "waiting for the other player"', () => {
  const updateButtons = (enable1: boolean, label1 = 'OK', label2 = 'Cancel') =>
    parseServerFrame({
      kind: 'notify',
      method: 'updateButtons',
      owner: { kind: 'player', id: 0 },
      label1,
      label2,
      enable1,
      enable2: true,
      focus1: enable1,
    });

  it('shows the server’s own fact — a verb, and the host card’s name when the ask has one', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const theirName = m.view!.players.find((p) => !p.isViewer)!.name;
    await sendTheirWaitingOn(s, m, { method: 'getChoices', hostCard: 'Thirst for Knowledge' });
    const waiting = await waitFor(() => getByTestId('live-waiting-pop'));
    expect(waiting.textContent).toBe(`Waiting for ${theirName} to choose cards for Thirst for Knowledge…`);
    expect(isWaitingForOpponent(m)).toBe(true);
  });

  // The rejoin audit, 2026-10-19: a player who closed the tab left the other reading "is choosing…".
  it('says the other player is gone, whatever they were doing, and drops it when they are back', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.sendSeats([
      { seat: 0, claimed: true, playerId: m.playerId },
      { seat: 1, claimed: true, playerId: them.id, name: them.name, away: true },
    ]);
    const waiting = await waitFor(() => getByTestId('live-waiting-pop'));
    expect(waiting.textContent).toBe(`Waiting for ${them.name} to reconnect…`);
    expect(isWaitingForOpponent(m)).toBe(true);
    s.sendSeats([
      { seat: 0, claimed: true, playerId: m.playerId },
      { seat: 1, claimed: true, playerId: them.id, name: them.name },
    ]);
    await waitFor(() => expect(queryByTestId('live-waiting-pop')).toBeNull());
  });

  // AE17: "both players should see the coinflip" — the loser draws the coin landed on the winner,
  // never the sentence; the winner draws the coin beside their own Play/Draw question.
  it('the coin toss: the LOSER draws the coin landed on the winner’s face and name, and no "Waiting for…" sentence', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.sendSeats([
      { seat: 0, claimed: true, playerId: m.playerId, coinToss: { winner: 1, at: Date.now() } },
      { seat: 1, claimed: true, playerId: them.id, name: them.name, avatarId: 'herald', coinToss: { winner: 1, at: Date.now() } },
    ]);
    await untilMatch(m, () => expect(m.coinToss?.winner).toBe(1));
    // This fixture is mid-game (turn 14): a toss arriving now is a rejoin's, and stays silent.
    expect(soundCalls.map((e) => e.role)).not.toContain('g.game-start');
    const coin = await waitFor(() => getByTestId('coin-toss'));
    expect(coin.getAttribute('data-winner')).toBe('1');
    expect(coin.querySelector('.coin-toss__name')?.textContent).toBe(them.name);
    expect(coin.querySelector('.coin-toss__face--front .coin-toss__avatar'), 'the winner’s own face on the coin').not.toBeNull();
    expect(coin.querySelector('.coin-toss__face--back .coin-toss__mark'), 'the loser’s side is a face too, not a blank disc').not.toBeNull();
    expect(queryByTestId('live-waiting-pop'), 'no sentence while the coin is up').toBeNull();
    expect(coin.textContent).not.toContain('Waiting');
    // Withdrawn: the sentence is back for whatever the other seat decides next.
    s.sendSeats([
      { seat: 0, claimed: true, playerId: m.playerId },
      { seat: 1, claimed: true, playerId: them.id, name: them.name, avatarId: 'herald' },
    ]);
    await untilMatch(m, () => expect(m.coinToss).toBeNull());
    expect(queryByTestId('coin-toss')).toBeNull();
  });

  it('the coin toss sounds Game start only in the pregame and only while it is fresh', () => {
    const now = 1_000_000;
    expect(tossSounds(now - 500, 0, now)).toBe(true);
    expect(tossSounds(now - 500, -1, now), 'no turn yet is the pregame too').toBe(true);
    expect(tossSounds(null, 0, now)).toBe(false);
    expect(tossSounds(now - 500, 1, now), 'the game has started').toBe(false);
    expect(tossSounds(now - 60_000, 0, now), 'a rejoin finds an old toss').toBe(false);
  });

  it('the coin toss: the WINNER sees the coin flip first, and their Play/Draw question once it lands', async () => {
    // The operator, 2026-10-11: "can we make it so the cointoss finishes before showing the prompt of who goes first?"
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'showPromptMessage',
        player: { kind: 'player', id: 0 },
        message: 'Seat 1, you have won the coin toss.\n\nPlay or draw?',
        card: null,
      }),
    );
    s.send(updateButtons(true, 'Play', 'Draw'));
    s.sendSeats([
      { seat: 0, claimed: true, playerId: m.playerId, coinToss: { winner: 0, at: Date.now() } },
      { seat: 1, claimed: true, playerId: null, coinToss: { winner: 0, at: Date.now() } },
    ]);
    await untilMatch(m, () => expect(m.coinToss?.winner).toBe(0));
    const host = await waitFor(() => getByTestId('live-play-or-draw-host'));
    expect(host.querySelector('[data-testid="coin-toss"]')?.getAttribute('data-winner')).toBe('0');
    expect(queryByTestId('live-play-or-draw-play'), 'no question while the coin is in the air').toBeNull();
    await waitFor(() => expect(getByTestId('live-play-or-draw-play').textContent).toBe('Play'), { timeout: FLIP_MS + 2_000 });
    expect(host.querySelector('[data-testid="coin-toss"]'), 'the landed coin stays beside the question').not.toBeNull();
  }, FLIP_MS + 10_000);

  it('the coin toss: a toss already landed (a reload, a late joiner) shows the Play/Draw question at once', async () => {
    const { s, m, getByTestId } = await liveBoard();
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'showPromptMessage',
        player: { kind: 'player', id: 0 },
        message: 'Seat 1, you have won the coin toss.\n\nPlay or draw?',
        card: null,
      }),
    );
    s.send(updateButtons(true, 'Play', 'Draw'));
    const at = Date.now() - FLIP_MS - 1_000;
    s.sendSeats([
      { seat: 0, claimed: true, playerId: m.playerId, coinToss: { winner: 0, at } },
      { seat: 1, claimed: true, playerId: null, coinToss: { winner: 0, at } },
    ]);
    await untilMatch(m, () => expect(m.coinToss?.winner).toBe(0));
    expect((await waitFor(() => getByTestId('live-play-or-draw-play'))).textContent).toBe('Play');
  });

  it('`priority` over an EMPTY stack — the other seat merely holds priority — draws NO pop-out: it is for an effect being resolved, never a wait', async () => {
    // The operator, 2026-10-08: "'Waiting for Hadoku…' this shouldn't be showing at all times, that
    // was not the intent. i wanted this to show when player is resolving an effect not simply when
    // waiting on them."
    const { s, m, queryByTestId } = await liveBoard();
    s.send(stackDelta(m));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(0));
    await sendTheirWaitingOn(s, m, { method: 'priority', hostCard: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(queryByTestId('live-waiting-pop')).toBeNull();
    expect(isWaitingForOpponent(m)).toBe(false);
  });

  it('`priority` over the stack is a wait: they are deciding whether to respond to its top item', async () => {
    // The operator, 2026-10-09: "if i'm waiting on my opponent to respond to 'Resolve Cranial
    // Plating?' then there should at least be some kind of waiting indicator for me".
    const { s, m, getByTestId } = await liveBoard();
    const theirName = m.view!.players.find((p) => !p.isViewer)!.name;
    const top = m.view!.stack[0]!;
    expect(top, 'the fixture has a stack').toBeDefined();
    await sendTheirWaitingOn(s, m, { method: 'priority', hostCard: null });
    const waiting = await waitFor(() => getByTestId('live-waiting-pop'));
    expect(waiting.textContent).toBe(`Waiting for ${theirName} to respond to ${top.sourceName}…`);
    expect(isWaitingForOpponent(m)).toBe(true);
  });

  /** The shipped verb table (Settled), one row each, plus no-host-card and the unmapped fallback. */
  it.each([
    ['chooseSingleEntityForEffect', 'Mountain', 'choose for Mountain'],
    ['getChoices', 'Thirst for Knowledge', 'choose cards for Thirst for Knowledge'],
    ['chooseEntitiesForEffect', 'Fact or Fiction', 'choose cards for Fact or Fiction'],
    ['confirm', 'Giant Growth', 'decide for Giant Growth'],
    ['pay', 'Lightning Bolt', 'pay for Lightning Bolt'],
    ['confirm', null, 'decide'],
    ['getAbilityToPlay', null, 'decide'],
  ] as const)('the shipped verb table: %s + %s → "%s"', async (method, hostCard, tail) => {
    const { s, m, getByTestId } = await liveBoard();
    const theirName = m.view!.players.find((p) => !p.isViewer)!.name;
    await sendTheirWaitingOn(s, m, { method, hostCard });
    const waiting = await waitFor(() => getByTestId('live-waiting-pop'));
    expect(waiting.textContent).toBe(`Waiting for ${theirName} to ${tail}…`);
  });

  it('is gone until the server says the other seat actually has something open — the mulligan-end flash', async () => {
    const { m, queryByTestId } = await liveBoard();
    // No `forge:seats` has landed yet: nothing to wait FOR.
    expect(isWaitingForOpponent(m)).toBe(false);
    expect(queryByTestId('live-waiting-pop')).toBeNull();
  });

  it('is gone while a SELECTION is open for the viewer, even with the bar’s OK disabled — a reveal or a discard is their move (T12)', async () => {
    const { s, m, queryByTestId } = await liveBoard();
    const hand = m.view!.players.find((p) => p.isViewer)!.hand!.map((c) => c.id);
    s.send(updateButtons(false));
    s.send(parseServerFrame({ kind: 'notify', method: 'setSelectables', cards: [{ kind: 'card', id: hand[0]! }], min: 1, max: 1 }));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    expect(isWaitingForOpponent(m)).toBe(false);
    expect(queryByTestId('live-waiting-pop')).toBeNull();
  });

  // Ledger Z2 (the operator, 2026-10-07): "when i mulligan once and then keep it just says 'Waiting for Bella…'
  // but it should probably tell me how many cards to put at the bottom."
  it('is gone during the London bottom pick, and Forge’s own instruction is in the decision pop-up with OK as Forge enables it', async () => {
    const { s, m, queryByTestId, getByTestId } = await liveBoard();
    const GAME = String(deltaKey(DELTA_TYPE.game, 1));
    s.send(parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Return 1 card(s) to the bottom of your library', card: null }));
    s.send(updateButtons(false, 'OK', 'Cancel'));
    s.send(parseServerFrame({ kind: 'notify', method: 'applyDelta', payload: { packet: { seq: 900, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: { [GAME]: { _type: DELTA_TYPE.game, _id: 1, Mulligan: { t: 'bool', v: true } } }, events: [] } } }));
    await untilMatch(m, () => expect(choosingMulligan(m)).toBe(true));
    expect(isWaitingForOpponent(m), 'the pick is this seat’s move').toBe(false);
    expect(queryByTestId('live-waiting-pop'), 'no waiting pop-out either').toBeNull();
    const decision = getByTestId('live-decision');
    expect(decision.textContent).toContain('Return 1 card(s) to the bottom of your library');
    expect((getByTestId('live-decision-ok') as HTMLButtonElement).disabled, 'OK off until a card is set aside').toBe(true);
    s.send(updateButtons(true, 'OK', 'Cancel'));
    await waitFor(() => expect((getByTestId('live-decision-ok') as HTMLButtonElement).disabled).toBe(false));
  });

  // The operator, 2026-10-07: "'Return 1 card(s)…' → 'Return 0 card(s)…' is
  // awkward. remove the 'auto' button, grey out OK until the criteria has been met." Forge sends a
  // fresh count-down sentence after every card set aside; the pop-up must keep the FIRST one for the
  // whole pick and never draw Forge's second button ("Auto") for it.
  it('the FIRST "Return N card(s)…" sentence holds for the whole bottom pick, with one button, and lets go once the pick ends', async () => {
    const { s, m, queryByTestId, getByTestId } = await liveBoard();
    const GAME = String(deltaKey(DELTA_TYPE.game, 1));
    const prompt = (message: string) => s.send(parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: null }));
    const setMulligan = (v: boolean) =>
      s.send(
        parseServerFrame({
          kind: 'notify',
          method: 'applyDelta',
          payload: { packet: { seq: 900, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: { [GAME]: { _type: DELTA_TYPE.game, _id: 1, Mulligan: { t: 'bool', v } } }, events: [] } },
        }),
      );

    // Return 1 card(s)… — OK off, no second button.
    prompt('Return 1 card(s) to the bottom of your library');
    s.send(updateButtons(false, 'OK', 'Cancel'));
    setMulligan(true);
    await untilMatch(m, () => expect(choosingMulligan(m)).toBe(true));
    expect(getByTestId('live-decision').textContent).toContain('Return 1 card(s) to the bottom of your library');
    expect((getByTestId('live-decision-ok') as HTMLButtonElement).disabled, 'OK off until a card is set aside').toBe(true);
    expect(queryByTestId('live-decision-cancel'), 'no second button during the pick').toBeNull();

    // the pick narrows — Forge's own count-down sentence arrives and enables OK — but the pop-up
    // keeps the FIRST sentence, not the new one, and still draws no second button.
    prompt('Return 0 card(s) to the bottom of your library');
    s.send(updateButtons(true, 'OK', 'Cancel'));
    await waitFor(() => expect((getByTestId('live-decision-ok') as HTMLButtonElement).disabled).toBe(false));
    expect(getByTestId('live-decision').textContent, 'the first sentence the whole pick, not the count-down').toContain('Return 1 card(s) to the bottom of your library');
    expect(getByTestId('live-decision').textContent).not.toContain('Return 0 card(s)');
    expect(queryByTestId('live-decision-cancel'), 'still no second button once OK is enabled').toBeNull();

    // the pick ends; the next one gets its own fresh FIRST sentence — proof the hold let go.
    setMulligan(false);
    await untilMatch(m, () => expect(choosingMulligan(m)).toBe(false));
    prompt('Return 2 card(s) to the bottom of your library');
    s.send(updateButtons(false, 'OK', 'Cancel'));
    setMulligan(true);
    await untilMatch(m, () => expect(choosingMulligan(m)).toBe(true));
    expect(getByTestId('live-decision').textContent).toContain('Return 2 card(s) to the bottom of your library');
  });

  // The operator, 2026-10-07: "i don't really like the 'yielding until next turn' text. i dont need a way to
  // cancel my 'end turn' decision. if i click end turn i'm locked in" — "no popup is needed for the end turn decision".
  it('Forge’s yield window after End Turn draws no decision pop-up and no cancel', async () => {
    const { s, m, queryByTestId } = await liveBoard();
    s.send(parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Yielding until end of turn.\nYou may cancel this yield at any time.', card: null }));
    s.send(updateButtons(false, 'OK', 'Cancel'));
    await untilMatch(m, () => expect(m.prompt).toMatch(/^Yielding until/));
    await new Promise((r) => setTimeout(r, 30));
    expect(queryByTestId('live-decision-host'), 'no pop-up').toBeNull();
    expect(queryByTestId('live-decision-cancel'), 'and nothing to cancel with').toBeNull();
  });

  it('is gone the instant Forge enables the viewer’s own OK — that is "my move"', async () => {
    const { s, m, queryByTestId } = await liveBoard();
    s.send(updateButtons(true));
    await untilMatch(m, () => expect(m.buttons?.enable1).toBe(true));
    expect(isWaitingForOpponent(m)).toBe(false);
    expect(queryByTestId('live-waiting-pop')).toBeNull();
  });

  it('appears the instant the server reports the other seat’s own ask, and clears the instant it reports none', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    expect(queryByTestId('live-waiting-pop')).toBeNull();
    await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
    expect(getByTestId('live-waiting-pop')).not.toBeNull();
    expect(isWaitingForOpponent(m)).toBe(true);
    await sendTheirWaitingOn(s, m, null);
    expect(queryByTestId('live-waiting-pop')).toBeNull();
    expect(isWaitingForOpponent(m)).toBe(false);
  });

  it('is independent of the viewer’s OWN ask or bar — only the server’s fact about the OTHER seat decides (closes the mulligan-end flash)', async () => {
    const { s, m } = await liveBoard();
    await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
    s.send(updateButtons(true));
    s.send(confirmAsk('c-wait'));
    await untilMatch(m, () => expect(currentAsk(m)).not.toBeNull());
    // The viewer's own stale bar and open ask change nothing about the fact
    // the server reported for the OTHER seat — unlike the old `!myMoveNow`
    // inference, which would have read this as "my move" and hidden it.
    expect(isWaitingForOpponent(m)).toBe(true);
    await sendTheirWaitingOn(s, m, null);
    expect(isWaitingForOpponent(m)).toBe(false);
  });

  // Measured against a real Forge jar with two browsers
  // (`e2e/w62-condescend.spec.ts`): the server sequences the two seats'
  // decisions strictly, but a stale `waitingOn` fact can still outlive the
  // frame that clears it long enough for a render to draw this seat's own
  // NEW ask beside the pop-out still naming the OTHER seat — `isWaitingForOpponent`
  // (the fact, above) stays true, but the POP-OUT must not draw over this
  // seat's own live decision, stale fact or not.
  it('never draws over the viewer’s OWN open ask, even with a stale theirWaitingOn fact', async () => {
    const { s, m, queryByTestId } = await liveBoard();
    await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
    await untilMatch(m, () => expect(isWaitingForOpponent(m)).toBe(true));
    s.send(updateButtons(true));
    s.send(confirmAsk('c-wait'));
    await untilMatch(m, () => expect(currentAsk(m)).not.toBeNull());
    expect(isWaitingForOpponent(m), 'the fact itself is unchanged — this is a render rule, not a fact change').toBe(true);
    expect(queryByTestId('live-waiting-pop'), 'the pop-out does not draw over the viewer’s own open ask').toBeNull();
    expect(queryByTestId('live-prompt'), 'the viewer’s own ask is what draws instead').not.toBeNull();
  });

  it('is gone during a mana payment — the one state neither an open ask nor bar.enable1 alone would catch', async () => {
    const { s, m } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    s.send(updateButtons(true, 'Auto', 'Cancel'));
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'showPromptMessage',
        player: { kind: 'player', id: 0 },
        message: 'Pay Mana Cost: {1}',
        card: { kind: 'card', id: mine[0]! },
      }),
    );
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'setWeaklySelectable',
        cards: mine.map((id) => ({ kind: 'card', id })),
      }),
    );
    await untilMatch(m, () => expect(m.promptCard).toBe(mine[0]!));
    expect(isWaitingForOpponent(m)).toBe(false);
  });

  it('never shows for a spectator, even with nothing enabled for the viewer', async () => {
    const { m, rerender, queryByTestId } = await liveBoard();
    Object.assign(m, { spectator: true });
    rerender(createElement(LiveBoard, { match: m }));
    expect(isWaitingForOpponent(m)).toBe(false);
    expect(queryByTestId('live-waiting-pop')).toBeNull();
  });

  it('never shows once the game has ended — the result screen says so instead', async () => {
    const { m, rerender, queryByTestId } = await liveBoard();
    m.view = { ...m.view!, gameOver: true };
    rerender(createElement(LiveBoard, { match: m }));
    expect(isWaitingForOpponent(m)).toBe(false);
    expect(queryByTestId('live-waiting-pop')).toBeNull();
  });

  it('never shows before the match has a view at all', async () => {
    const s = (server = await startReplayServer());
    const m = (match = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    }));
    const { queryByTestId } = render(createElement(LiveBoard, { match: m }));
    await untilMatch(m, () => expect(m.stats.snapshots).toBe(1));
    expect(m.view).toBeNull();
    expect(isWaitingForOpponent(m)).toBe(false);
    expect(queryByTestId('live-waiting-pop')).toBeNull();
  });
});

/*
 * Wave 42 §L, W1. Operator: *"if opponent is choosing to play/draw something
 * needs to be showing on the other persons screen as well. i think the
 * coinflip prompt should be shown to both players at once. and for the one
 * who lost they get the waiting prompt. same for mulligan, if opponent is
 * chosing to mulligan we need some waiting prompt."* `isWaitingForOpponent`'s
 * small line (above) fires identically for the ordinary mid-game wait AND
 * the pregame one; this is the pregame-only pop-up the operator asked for,
 * in the decision area, the same `.confirm` card chrome the winner's own
 * Play/Draw and Keep/Mulligan pop-ups use. See
 * `isWaitingForPregameDecision`'s own note on why `view.turn` is the signal
 * — Forge sends the losing/non-deciding seat no wire text for this moment at
 * all.
 */
describe('W1 — the pregame decision-area pop-up (the coin toss, either seat’s opening mulligan)', () => {
  const GAME_KEY = String(deltaKey(DELTA_TYPE.game, 1));
  const setTurn = (m: LiveMatch, turn: number) =>
    parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: {
          seq: m.view!.seq + 1,
          checksum: 0,
          checksumProperties: [],
          newObjects: {},
          objectDeltas: { [GAME_KEY]: { _type: DELTA_TYPE.game, _id: 1, Turn: { t: 'int', v: turn } } },
          events: [],
        },
      },
    });

  it('a fresh coin toss in the pregame sounds Game start once, and says so in the match log', async () => {
    const { s, m } = await liveBoard();
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.send(setTurn(m, 0));
    await untilMatch(m, () => expect(m.view!.turn).toBe(0));
    const at = Date.now();
    s.sendSeats([
      { seat: 0, claimed: true, playerId: m.playerId, coinToss: { winner: 1, at } },
      { seat: 1, claimed: true, playerId: them.id, name: them.name, coinToss: { winner: 1, at } },
    ]);
    await waitFor(() => expect(soundCalls.filter((e) => e.role === 'g.game-start')).toHaveLength(1));
    await waitFor(() =>
      expect(s.received.some((r) => r.event === 'forge:client' && (r.payload as { data: Record<string, unknown> }).data.why === 'toss')).toBe(true),
    );
    // The same toss again (a re-sent seats frame) does not sound it twice.
    s.sendSeats([
      { seat: 0, claimed: true, playerId: m.playerId, coinToss: { winner: 1, at } },
      { seat: 1, claimed: true, playerId: them.id, name: them.name, coinToss: { winner: 1, at } },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(soundCalls.filter((e) => e.role === 'g.game-start')).toHaveLength(1);
  });

  it(
    'shows the decision-area pop-up, named, while turn is still 0 and it is not the viewer’s move — the same ' +
      'signal covers the coin toss and either seat’s opening mulligan, since Forge tells this client nothing else',
    async () => {
      const { s, m, getByTestId } = await liveBoard();
      const theirName = m.view!.players.find((p) => !p.isViewer)!.name;
      // The server's own fact, same as T2's first case above;
      // turn 0 is the only extra fact pregame carries.
      await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
      expect(isWaitingForOpponent(m)).toBe(true);
      s.send(setTurn(m, 0));
      await untilMatch(m, () => expect(m.view!.turn).toBe(0));

      const waiting = await waitFor(() => getByTestId('live-waiting-pop'));
      // Pregame has no Forge text for this moment at all (see
      // `isWaitingForPregameDecision`'s own note) — the plain sentence, not
      // the verb table `sendTheirWaitingOn`'s fact would otherwise pick.
      expect(waiting.textContent).toBe(`Waiting for ${theirName}…`);
      expect(isWaitingForPregameDecision(m)).toBe(true);
    },
  );

  it('carries the server’s own verb-based sentence once turn is 1 or more — mid-game priority keeps its own shape, not the pregame’s plain one', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const theirName = m.view!.players.find((p) => !p.isViewer)!.name;
    // The default fixture is already turn 14 — mid-game.
    expect(m.view!.turn).toBeGreaterThan(0);
    await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
    const waiting = await waitFor(() => getByTestId('live-waiting-pop'));
    expect(waiting.textContent).toBe(`Waiting for ${theirName} to decide…`);
    expect(isWaitingForPregameDecision(m)).toBe(false);
  });

  it('is gone once it is the viewer’s own move, even at turn 0 — it is "my move", not pregame waiting', async () => {
    const { s, m, queryByTestId } = await liveBoard();
    s.send(setTurn(m, 0));
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'updateButtons',
        owner: { kind: 'player', id: 0 },
        label1: 'Play',
        label2: 'Draw',
        enable1: true,
        enable2: true,
        focus1: true,
      }),
    );
    await untilMatch(m, () => expect(m.buttons?.enable1).toBe(true));
    expect(isWaitingForPregameDecision(m)).toBe(false);
    expect(queryByTestId('live-waiting-pop')).toBeNull();
  });

  it('the stack band stands aside for the pregame pop-up too, the same as any other question', async () => {
    const { s, m, getByTestId, container } = await liveBoard();
    await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
    s.send(setTurn(m, 0));
    await waitFor(() => getByTestId('live-waiting-pop'));
    expect(container.querySelector('[data-testid="board-mid"]')?.hasAttribute('data-question')).toBe(true);
  });
});

/*
 * ── T4 (shape 1, lane G’s `ConfirmPrompt`) — every yes/no that is an ANSWER
 * moves to the decision area; a priority pass and a mana payment stay on the
 * control bar. See `docs/planning/wave36-evidence/g-shape1.md`.
 */
/*
 * The operator, 2026-10-10: *"for things like 'Use triggered ability of Soul's Attendant? Triggered by:
 * Soul Warden' can we add a checkmark that allows me to always yes?"* — an optional trigger's confirm
 * carries the trigger (`confirmAbility.trigger`); ticked, the answer pressed goes to Forge to keep.
 */
describe("an optional trigger's confirm has an Always box", () => {
  const KEY = 'Whenever another creature enters the battlefield, you may gain 1 life.';
  const bar = () =>
    parseServerFrame({ kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'Yes', label2: 'No', enable1: true, enable2: true, focus1: true });
  function triggerFrames() {
    return [
      parseServerFrame({
        kind: 'notify',
        method: 'showPromptMessage',
        player: { kind: 'player', id: 0 },
        message: "Use triggered ability of Soul's Attendant?\nTriggered by: Memnite",
        card: null,
        confirmAbility: { hostCard: { kind: 'card', id: 40 }, abilityId: 7, trigger: { key: KEY, name: "Soul's Attendant" } },
      }),
      bar(),
    ];
  }
  const sentEvents = (s: { received: { event: string }[] }) =>
    s.received.filter((r) => r.event === 'forge:trigger-decision' || r.event === 'forge:c2s').map((r) => r.event);
  const decisionsSent = (s: { received: { event: string; payload: unknown }[] }) =>
    s.received.filter((r) => r.event === 'forge:trigger-decision').map((r) => r.payload);

  it('ticked with Yes: ACCEPT for the trigger goes before the press', async () => {
    const { s, getByTestId } = await liveBoard();
    for (const f of triggerFrames()) s.send(f);
    const always = (await waitFor(() => getByTestId('live-confirm-always'))) as HTMLInputElement;
    expect(always.checked).toBe(false);
    fireEvent.click(always);
    fireEvent.click(getByTestId('prompt-confirm-yes'));
    await waitFor(() => expect(sentEvents(s)).toEqual(['forge:trigger-decision', 'forge:c2s']));
    expect(decisionsSent(s)).toEqual([{ matchId: s.matchId, key: KEY, decision: 'ACCEPT' }]);
  });

  it('ticked with No: DECLINE', async () => {
    const { s, getByTestId } = await liveBoard();
    for (const f of triggerFrames()) s.send(f);
    fireEvent.click(await waitFor(() => getByTestId('live-confirm-always')));
    fireEvent.click(getByTestId('prompt-confirm-no'));
    await waitFor(() => expect(sentEvents(s)).toEqual(['forge:trigger-decision', 'forge:c2s']));
    expect(decisionsSent(s)).toEqual([{ matchId: s.matchId, key: KEY, decision: 'DECLINE' }]);
  });

  it('unticked, the press is all that is sent; a confirm that is not a trigger has no box', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    for (const f of triggerFrames()) s.send(f);
    await waitFor(() => getByTestId('live-confirm-always'));
    fireEvent.click(getByTestId('prompt-confirm-yes'));
    await waitFor(() => expect(sentEvents(s)).toEqual(['forge:c2s']));

    s.send(parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Watery Grave\n\nPay 2 life?', card: null }));
    s.send(bar());
    await waitFor(() => expect(getByTestId('live-confirm').textContent).toContain('Pay 2 life?'));
    expect(queryByTestId('live-confirm-always')).toBeNull();
  });

  it('the settings list what the server says Forge remembers, and a clear sends ASK', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard(0, true);
    expect(queryByTestId('live-settings-trigger')).toBeNull();
    s.sendTriggerDecisions([{ key: KEY, name: "Soul's Attendant", decision: 'ACCEPT' }]);
    await untilMatch(m, () => expect(m.triggerDecisions).toHaveLength(1));
    expect(getByTestId('live-settings-trigger').textContent).toBe("Soul's Attendant — always yes");
    fireEvent.click(getByTestId('live-settings-trigger-clear'));
    await waitFor(() => expect(decisionsSent(s)).toEqual([{ matchId: s.matchId, key: KEY, decision: 'ASK' }]));
    s.sendTriggerDecisions([]);
    await waitFor(() => expect(queryByTestId('live-settings-trigger')).toBeNull());
  });
});

describe('T4 — every yes/no confirm is the pop-up, never the control bar', () => {
  function buttonFrames(message: string, label1: string, label2: string) {
    return [
      parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: null }),
      parseServerFrame({
        kind: 'notify',
        method: 'updateButtons',
        owner: { kind: 'player', id: 0 },
        label1,
        label2,
        enable1: true,
        enable2: true,
        focus1: true,
      }),
    ];
  }

  it('the shockland’s "pay 2 life?" (Yes/No) renders in the decision area, and the control box answers none of it', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    for (const f of buttonFrames('Watery Grave\n\nPay 2 life?', 'Yes', 'No')) s.send(f);

    await waitFor(() => expect(getByTestId('live-confirm-host')).toBeTruthy());
    expect(getByTestId('live-confirm').textContent).toContain('Pay 2 life?');
    expect(getByTestId('prompt-confirm-yes').textContent).toBe('Yes');
    expect(getByTestId('prompt-confirm-no').textContent).toBe('No');
    expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(true);
    expect(queryByTestId('live-decision'), 'one pop-up at a time').toBeNull();

    const before = m.stats.replies;
    fireEvent.click(getByTestId('prompt-confirm-yes'));
    await untilMatch(m, () => expect(m.stats.replies).toBe(before + 1));
    expect(
      (await s.framesFrom(m)).some((f) => f.ok && f.value.kind === 'act' && f.value.method === 'selectButtonOk'),
    ).toBe(true);
  });

  it('the "No" side sends Forge’s cancel, the same sender the bar already uses', async () => {
    const { s, m, getByTestId } = await liveBoard();
    for (const f of buttonFrames('Watery Grave\n\nPay 2 life?', 'Yes', 'No')) s.send(f);
    await waitFor(() => getByTestId('prompt-confirm-no'));

    fireEvent.click(getByTestId('prompt-confirm-no'));
    await untilMatch(m, () => expect(m.stats.replies).toBe(1));
    expect(
      (await s.framesFrom(m)).some((f) => f.ok && f.value.kind === 'act' && f.value.method === 'selectButtonCancel'),
    ).toBe(true);
  });

  it('the mulligan’s Keep/Mulligan is the same pop-up, with Forge’s own words', async () => {
    const { s, getByTestId } = await liveBoard();
    for (const f of buttonFrames('Keep this hand of seven?', 'Keep', 'Mulligan')) s.send(f);

    await waitFor(() => getByTestId('live-confirm-host'));
    expect(getByTestId('prompt-confirm-yes').textContent).toBe('Keep');
    expect(getByTestId('prompt-confirm-no').textContent).toBe('Mulligan');
  });

  it('an ordinary priority pass (OK/End Turn) with nothing on the stack is the pass pop-up, never the yes/no one', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    s.send(stackDelta(m));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(0));
    for (const f of buttonFrames('Priority: you', 'OK', 'End Turn')) s.send(f);

    await waitFor(() => expect(getByTestId('live-decision-ok').textContent).toBe('Next Phase'));
    expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(false);
    expect(queryByTestId('live-confirm-host')).toBeNull();
  });

  it('a mana payment’s Auto/Cancel is not the yes/no pop-up — AUTO_PAY_LABEL is one of the excluded mechanical words', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    for (const f of buttonFrames('Pay Mana Cost: {1}', 'Auto', 'Cancel')) s.send(f);

    // Forge named no card, so there is no payment window either: the bar is the decision pop-up's.
    await waitFor(() => getByTestId('live-decision'));
    expect(queryByTestId('live-confirm-host')).toBeNull();
  });

  it('the coin toss keeps PlayOrDrawPrompt — the two pop-ups are mutually exclusive by construction', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    for (const f of buttonFrames('You have won the coin toss.\n\nPlay or draw?', 'Play', 'Draw')) s.send(f);

    await waitFor(() => getByTestId('live-play-or-draw-host'));
    expect(queryByTestId('live-confirm-host')).toBeNull();
  });

  /*
   * T4, finished: the bar used to keep showing Forge's own word (`Keep`,
   * `Yes`, `Play`, …) while the pop-up already showed it — a disabled bar
   * repeating the unanswered question. The operator: *"never put yes/no there,
   * always the big pop-up."* Wave 51 makes the box's words ours outright; these
   * two pin that for both pop-ups.
   */
  it('T4, finished: the box reads only its own words while the yes/no pop-up is up', async () => {
    const { s, getByTestId } = await liveBoard();
    for (const f of buttonFrames('Keep this hand of seven?', 'Keep', 'Mulligan')) s.send(f);

    await waitFor(() => getByTestId('live-confirm-host'));
    expect(getByTestId('live-buttons').textContent).toBe('End TurnFull controlConcede');
  });

  it('T4, finished: the box never says "Play" while the coin-toss pop-up is up', async () => {
    const { s, getByTestId } = await liveBoard();
    for (const f of buttonFrames('You have won the coin toss.\n\nPlay or draw?', 'Play', 'Draw')) s.send(f);

    await waitFor(() => getByTestId('live-play-or-draw-host'));
    expect(getByTestId('live-buttons').textContent).toBe('End TurnFull controlConcede');
  });

  /*
   * The stack band stands aside for a question (items 7 and 13,
   * `Board.tsx`'s `data-question` on `board-mid`) — before this wave that
   * only covered the fifteen `ask`s and a mana payment; the yes/no pop-up and
   * the coin toss are two more things that cover the same column and used to
   * leave the band roomy underneath them.
   */
  it('the stack band stands aside for the yes/no pop-up too, the same as any other question', async () => {
    const { s, getByTestId, container } = await liveBoard();
    for (const f of buttonFrames('Keep this hand of seven?', 'Keep', 'Mulligan')) s.send(f);

    await waitFor(() => getByTestId('live-confirm-host'));
    expect(container.querySelector('[data-testid="board-mid"]')?.hasAttribute('data-question')).toBe(true);
  });

  it('the stack band stands aside for the coin-toss pop-up too', async () => {
    const { s, getByTestId, container } = await liveBoard();
    for (const f of buttonFrames('You have won the coin toss.\n\nPlay or draw?', 'Play', 'Draw')) s.send(f);

    await waitFor(() => getByTestId('live-play-or-draw-host'));
    expect(container.querySelector('[data-testid="board-mid"]')?.hasAttribute('data-question')).toBe(true);
  });
});

/*
 * The operator, 2026-10-06: *"any 'Ok' situations are popups decisions
 * instead"* and *"keep the same … buttons in the control box at all times? just
 * grey out … when they are not relevant."* Then 2026-10-24: *"the 'next phase'
 * button must go and instead we should use the decision modal for passing
 * priority always"*, its button saying what the player agrees to.
 */
describe('the control box is fixed furniture; every answer to Forge, passing priority included, is the decision pop-up', () => {
  const notify = (raw: unknown) => parseServerFrame(raw);
  const bar = (label1: string, label2: string, enable1 = true, enable2 = true) =>
    notify({ kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1, label2, enable1, enable2, focus1: enable1 });
  const prompt = (message: string, cardId: number | null = null) =>
    notify({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: cardId === null ? null : { kind: 'card', id: cardId } });
  const box = (getByTestId: (id: string) => HTMLElement) => ({
    labels: [...getByTestId('live-buttons').querySelectorAll('button')].map((el) => el.textContent),
    endTurn: !(getByTestId('live-button-end-turn') as HTMLButtonElement).disabled,
  });
  const THREE = ['End Turn', 'Full control', 'Concede'];
  const acts = (s: ReplayServer) =>
    s.clientFrames().flatMap((f) => (f.ok && f.value.kind === 'act' ? [f.value.method] : []));
  const ok = (queryByTestId: (id: string) => HTMLElement | null) => queryByTestId('live-decision-ok')?.textContent ?? null;

  it('draws the same three buttons in every state; the pop-up answers the pass, with words for what it does', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const states: [string, () => unknown[], { endTurn: boolean; ok: string | null }][] = [
      ['no bar yet', () => [], { endTurn: false, ok: null }],
      ['priority with spells on the stack', () => [prompt('Priority: you'), bar('OK', 'End Turn')], { endTurn: true, ok: 'Resolve' }],
      ['priority, stack empty', () => [stackDelta(m), prompt('Priority: you'), bar('OK', 'End Turn')], { endTurn: true, ok: 'Next Phase' }],
      ['priority after a mana tap (OK + Undo), stack empty', () => [bar('OK', 'Undo (1)')], { endTurn: false, ok: 'Next Phase' }],
      ['a yes/no', () => [prompt('Pay 2 life?'), bar('Yes', 'No')], { endTurn: false, ok: null }],
      ['the coin toss', () => [prompt('Play or draw?'), bar('Play', 'Draw')], { endTurn: false, ok: null }],
      ['a target being chosen', () => [prompt('Select targets for Lightning Bolt'), bar('OK', 'Cancel', false, true)], { endTurn: false, ok: null }],
      ['a payment', () => [bar('Auto', 'Cancel'), prompt('Pay Mana Cost: {1}', mine[0]!)], { endTurn: false, ok: null }],
    ];
    for (const [what, frames, expected] of states) {
      for (const f of frames()) s.send(f as never);
      await waitFor(() => expect({ ...box(getByTestId), ok: ok(queryByTestId) }, what).toEqual({ labels: THREE, ...expected }));
      expect(queryByTestId('live-button-next-phase'), `${what}: no Next Phase in the box`).toBeNull();
      // One pop-up at a time, whichever it is.
      const popups = ['live-decision', 'live-confirm', 'live-play-or-draw', 'live-payment'].filter((id) => queryByTestId(id) !== null);
      expect(popups.length, `${what}: ${popups.join(', ')}`).toBeLessThanOrEqual(1);
    }
  });

  it('priority with spells on the stack: the pop-up’s Resolve passes; End Turn stays in the box', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    expect(m.view!.stack.length, 'the fixture has spells on the stack').toBeGreaterThan(0);
    for (const f of [prompt('Priority: you\nStack: Direct Current'), bar('OK', 'End Turn')]) s.send(f);

    const popup = await waitFor(() => getByTestId('live-decision'));
    expect(getByTestId('live-decision-host').className).toBe('live__prompt');
    expect(popup.textContent).toContain('Stack: Direct Current');
    expect(getByTestId('live-decision-ok').textContent).toBe('Resolve');
    expect(queryByTestId('live-decision-cancel'), 'End Turn is the box’s, never drawn twice').toBeNull();
    expect(box(getByTestId)).toEqual({ labels: THREE, endTurn: true });
    expect(getByTestId('board-mid').hasAttribute('data-question'), 'the stack knows a question is up').toBe(true);

    fireEvent.click(getByTestId('live-decision-ok'));
    await waitFor(() => expect(acts(s)).toEqual(['selectButtonOk']));
    await waitFor(() => expect(queryByTestId('live-decision'), 'pressed: the pop-up goes with the bar').toBeNull());
  });

  it('the empty-stack pass asks to proceed to the next step, and its one Next Phase button presses Forge’s button one', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    s.send(stackDelta(m));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(0));
    expect(m.view!.phase, 'the fixture is in main 1').toBe('MAIN1');
    for (const f of [prompt('Priority: you'), bar('OK', 'End Turn')]) s.send(f);
    const popup = await waitFor(() => getByTestId('live-decision'));
    expect(popup.querySelector('.confirm__message')!.textContent).toBe('Proceed to Combat?');
    expect(getByTestId('live-decision-ok').textContent).toBe('Next Phase');
    expect(queryByTestId('live-decision-cancel'), 'End Turn is the box’s').toBeNull();
    expect(popup.querySelector<HTMLElement>('.answers')!.hasAttribute('data-start'), 'agreeing to a step: bottom right').toBe(false);
    fireEvent.click(getByTestId('live-decision-ok'));
    await waitFor(() => expect(acts(s)).toEqual(['selectButtonOk']));
  });

  it('End Turn presses Forge’s button two', async () => {
    const { s, getByTestId } = await liveBoard();
    s.send(bar('OK', 'End Turn'));
    await waitFor(() => expect(box(getByTestId).endTurn).toBe(true));
    fireEvent.click(getByTestId('live-button-end-turn'));
    await waitFor(() => expect(acts(s)).toContain('selectButtonCancel'));
  });

  it('a target’s Cancel is the pop-up’s, alone, in Forge’s word — and it backs out', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    for (const f of [prompt('Select targets for Lightning Bolt'), bar('OK', 'Cancel', false, true)]) s.send(f);
    await waitFor(() => getByTestId('live-decision'));
    expect(queryByTestId('live-decision-ok'), 'Forge has not enabled OK: not drawn').toBeNull();
    expect(getByTestId('live-decision-cancel').textContent).toBe('Cancel');
    fireEvent.click(getByTestId('live-decision-cancel'));
    await waitFor(() => expect(acts(s)).toEqual(['selectButtonCancel']));
  });

  it('OK + Undo (N) after a mana tap, stack empty: the pass, and Forge’s Undo is not drawn (the land itself untaps)', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    s.send(stackDelta(m));
    s.send(bar('OK', 'Undo (1)'));
    await waitFor(() => expect(getByTestId('live-decision-ok').textContent).toBe('Next Phase'));
    expect(queryByTestId('live-decision-cancel')).toBeNull();
    expect(box(getByTestId)).toEqual({ labels: THREE, endTurn: false });
  });

  it('the payment window and a selection pop-up keep their inputs: no decision pop-up beside them', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    for (const f of [bar('Auto', 'Cancel'), prompt('Pay Mana Cost: {1}', mine[0]!)]) s.send(f);
    await waitFor(() => getByTestId('live-payment'));
    expect(queryByTestId('live-decision')).toBeNull();

    const GRAVEYARD_CARD = 555001;
    s.send(notify({ kind: 'notify', method: 'setSelectables', cards: [{ kind: 'card', id: GRAVEYARD_CARD }], min: 1, max: 1 }));
    for (const f of [prompt('Return a Zombie from your graveyard?'), bar('OK', 'Cancel', false, true)]) s.send(f);
    await waitFor(() => getByTestId('live-selection-host'));
    expect(queryByTestId('live-decision')).toBeNull();
    expect(queryByTestId('selection-done'), 'Forge has not enabled OK: no Done').toBeNull();

    // Enough picked (min 1 of up to 2): Forge enables OK, and the pop-up's Done is where it is pressed now.
    s.send(bar('OK', 'Cancel', true, true));
    await waitFor(() => expect(getByTestId('selection-done').textContent).toBe('OK'));
    expect(queryByTestId('live-decision')).toBeNull();
    fireEvent.click(getByTestId('selection-done'));
    await waitFor(() => expect(acts(s)).toContain('selectButtonOk'));
  });

  /*
   * §A.6 — *"why is the stack carousel so much higher than the decision box?
   * thats silly it should be right above the decision box."* jsdom lays out
   * nothing, so the boxes are given; what is pinned is the arithmetic and that
   * the root carries it only while something is in the column.
   */
  /** jsdom has no `ResizeObserver`: this one reports a target as a real one does, once after it is observed and again when a test resizes it. */
  class Resizes {
    static made = 0;
    static all: Resizes[] = [];
    readonly observed = new Set<Element>();
    constructor(private readonly report: ResizeObserverCallback) {
      Resizes.made += 1;
      Resizes.all.push(this);
    }
    observe(el: Element): void {
      this.observed.add(el);
      queueMicrotask(() => {
        if (this.observed.has(el)) this.report([Resizes.entry(el)], this as unknown as ResizeObserver);
      });
    }
    unobserve(el: Element): void {
      this.observed.delete(el);
    }
    disconnect(): void {
      this.observed.clear();
    }
    static entry(target: Element): ResizeObserverEntry {
      return { target, contentRect: new DOMRect(), contentBoxSize: [], borderBoxSize: [], devicePixelContentBoxSize: [] };
    }
    static resize(el: Element): void {
      for (const o of Resizes.all) if (o.observed.has(el)) o.report([Resizes.entry(el)], o as unknown as ResizeObserver);
    }
  }

  it('§A.6: --question-top is the topmost sheet’s top edge in the band’s frame, and only while a question is up', async () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    onTestFinished(() => {
      vi.unstubAllGlobals();
      Resizes.all = [];
    });
    const { s, m, getByTestId, container, rerender } = await liveBoard();
    const rects = new Map<string, number>([
      ['board', 40],
      ['confirm', 340],
    ]);
    const real = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = [...rects].find(([cls]) => this.classList.contains(cls))?.[1];
      return top === undefined ? real.call(this) : new DOMRect(0, top, 200, 120);
    });
    try {
      const root = container.querySelector<HTMLElement>('.live')!;
      expect(questionTopOf(root), 'nothing in the column').toBeNull();
      for (const f of [prompt('Priority: you\nStack: Direct Current'), bar('OK', 'End Turn')]) s.send(f);
      await waitFor(() => getByTestId('live-decision'));
      expect(questionTopOf(root)).toBe(300);
      await waitFor(() => expect(root.style.getPropertyValue('--question-top')).toBe('300px'));

      // The band moving with no frame from Forge wakes the match's subscribers (the gesture layer's
      // arcs repaint), without a new revision — and an unchanged edge wakes nobody.
      const woken = vi.fn();
      const unsubscribe = subscribe(m, woken);
      const revision = m.revision;
      const made = Resizes.made;
      rerender(createElement(LiveBoard, { match: m }));
      rerender(createElement(LiveBoard, { match: m }));
      expect(Resizes.made, 'a render builds no observer: the one made at mount watches').toBe(made);
      rects.set('confirm', 360);
      act(() => Resizes.resize(container.querySelector('.live__prompt > *')!));
      expect(root.style.getPropertyValue('--question-top'), 'measured on the resize').toBe('320px');
      expect(woken, 'not inside the commit: a landing measured there flies to the wrong slot').not.toHaveBeenCalled();
      await waitFor(() => expect(woken, 'the band moved: subscribers repaint on the next frame').toHaveBeenCalled());
      expect(m.revision, 'and no new revision').toBe(revision);
      woken.mockClear();
      rerender(createElement(LiveBoard, { match: m }));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      expect(woken, 'nothing moved: nobody woken').not.toHaveBeenCalled();
      unsubscribe();

      pressButton(m, 'ok');
      act(() => {
        m.revision += 1;
      });
      // No pop-up: the last measured edge stands (2026-10-07), so the band neither jumps to the column's top
      // when a pop-up closes nor flashes there for the frame before the next one opens.
      await new Promise((r) => setTimeout(r, 30));
      expect(root.style.getPropertyValue('--question-top'), 'no pop-up: the last edge stands').toBe('320px');
    } finally {
      spy.mockRestore();
    }
  });
});

/*
 * Wave 42 §L. A Forge SELECTION (`setSelectables`) that needs more than the
 * board's own highlighted ring — `classifySelection` (`../prompts/index.ts`,
 * lane P's) is the classifier; these cases are about the HANDOVER into it and
 * what `LiveBoard.tsx` mounts off each of its non-`'none'` answers, the same
 * shape the "what the board is told about Forge's input" cases above take
 * for `selectionOpen`/`declaringAttackers`. No `'confirm'` kind: lane P
 * measured Sanctum of Ugin to be an ordinary bar confirm (already handled by
 * the existing `confirmPrompt`, wave 36's T4), never a selection, and
 * removed the speculative kind — see `SelectionPrompt.tsx`'s own header.
 */
describe('W18/W16 — a selection that is an off-board target or a silent on-board choice', () => {
  const notify = (raw: unknown) => parseServerFrame(raw);
  const selectables = (ids: number[], min: number, max: number) =>
    notify({ kind: 'notify', method: 'setSelectables', cards: ids.map((id) => ({ kind: 'card', id })), min, max });
  const promptNaming = (message: string, cardId: number | null) =>
    notify({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: cardId === null ? null : { kind: 'card', id: cardId } });

  /*
   * W18, the soft-lock: Relentless Dead's own dies trigger names a card in
   * the graveyard. No board element draws a graveyard card, so
   * `classifySelection` reads `'off-board'` and the picker carries the whole
   * offer — this is the one case `fixtureFrames()`'s own board has no
   * clickable tile for at all.
   */
  it('a selection naming a card off any battlefield is the picker, not a silent lock', async () => {
    const { s, getByTestId, queryByTestId, container } = await liveBoard();
    const GRAVEYARD_CARD = 555001;
    for (const f of [promptNaming('Return a Zombie from your graveyard?', null), selectables([GRAVEYARD_CARD], 1, 1)]) s.send(f);

    await waitFor(() => getByTestId('live-selection-host'));
    expect(getByTestId('live-selection-host').textContent).toContain('Return a Zombie from your graveyard?');
    expect(container.querySelector(`[data-testid="prompt-choice"][data-card-id="${GRAVEYARD_CARD}"]`)).not.toBeNull();
    // A hard (min 1) target offers no "Done" — Forge has not enabled skipping it.
    expect(queryByTestId('selection-done')).toBeNull();
    // The stack stands aside for this pop-up too, the same as any other question.
    expect(container.querySelector('[data-testid="board-mid"]')?.hasAttribute('data-question')).toBe(true);
  });

  /*
   * W16, Worldbreaker: the choice already had a legal board target; what was
   * silent was Forge's own prompt text. `'on-board'` mounts the SAME picker
   * beside the board's own highlight, never in place of it.
   */
  it('a selection naming only on-board cards still gets the titled picker, beside the board\'s own highlight', async () => {
    const { s, m, getByTestId, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    expect(mine.length).toBeGreaterThan(0);
    for (const f of [promptNaming('Choose a mode', null), selectables([mine[0]!], 1, 1)]) s.send(f);

    await waitFor(() => getByTestId('live-selection-host'));
    expect(getByTestId('live-selection-host').textContent).toContain('Choose a mode');
    // The board's own highlighted ring is untouched — still a real board click target.
    expect(container.querySelector(`[data-board-card="${mine[0]}"][data-selectable]`)).not.toBeNull();
  });

  /*
   * The operator, 2026-10-19, on Bone Shards: the sacrifice sheet read "Destroy target creature or
   * planeswalker. (Additional cost: Sacrifice a creature) Select creature to sacrifice (1 left)".
   * Forge's two real prompts for the cast, with the bridge's split of each (`parts`).
   */
  const BONE_SHARDS = 'Destroy target creature or planeswalker. (Additional cost: Sacrifice a creature)';
  const splitPrompt = (message: string, cardId: number, parts: { question: string; context: string; input: string }) =>
    notify({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: { kind: 'card', id: cardId }, parts });
  const sheetOf = (host: HTMLElement) => ({
    question: host.querySelector('.prompt__title')?.textContent ?? null,
    context: host.querySelector('[data-testid="prompt-source-text"]')?.textContent ?? null,
    source: host.querySelector('[data-testid="prompt-source"]')?.getAttribute('data-card-id') ?? null,
  });

  it('Bone Shards’ sacrifice sheet asks the sacrifice alone, beside the spell’s card', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!;
    const shards = mine.hand![0]!.id;
    const creature = mine.battlefield[0]!.id;
    for (const f of [
      splitPrompt(`Bone Shards (${shards})\n - ${BONE_SHARDS}\nSelect creature to sacrifice (1 left)`, shards, { question: 'Select creature to sacrifice (1 left)', context: BONE_SHARDS, input: 'select' }),
      selectables([creature], 1, 1),
    ])
      s.send(f);
    await waitFor(() => getByTestId('live-selection-host'));
    const host = getByTestId('live-selection-host');
    expect(sheetOf(host)).toEqual({ question: 'Select creature to sacrifice (1 left)', context: null, source: String(shards) });
    expect(host.textContent).not.toMatch(/Destroy|Additional cost/);
    // The line keeps Forge's whole words.
    expect(getByTestId('live-says').textContent).toContain('Destroy target creature or planeswalker.');
  });

  it('Bone Shards’ target sheet asks for the target, with what the spell does as its own line under it', async () => {
    const { s, m, getByTestId } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!;
    const shards = mine.hand![0]!.id;
    const creature = mine.battlefield[0]!.id;
    for (const f of [
      splitPrompt(`Bone Shards (${shards}) - ${BONE_SHARDS}\n\nSelect target creature or planeswalker`, shards, { question: 'Select target creature or planeswalker', context: BONE_SHARDS, input: 'target' }),
      selectables([creature], 1, 1),
    ])
      s.send(f);
    await waitFor(() => getByTestId('live-selection-host'));
    expect(sheetOf(getByTestId('live-selection-host'))).toEqual({ question: 'Select target creature or planeswalker', context: BONE_SHARDS, source: String(shards) });
  });

  it('clicking a tile in the picker sends the same act a board click would, for an off-board card the board never drew', async () => {
    const { s, m, getByTestId } = await liveBoard();
    // A real card this client already knows (its own hand) but that the board
    // draws as a pile, never a per-card clickable tile — the same "off-board"
    // shape as a graveyard target, and one `selectCard` will actually accept.
    const HAND_CARD = m.view!.players.find((p) => p.isViewer)!.hand![0]!.id;
    for (const f of [promptNaming('Discard a card?', null), selectables([HAND_CARD], 1, 1)]) s.send(f);
    await waitFor(() => getByTestId(`live-selection-host`));

    fireEvent.click(getByTestId('prompt-choice'));
    await untilMatch(m, () => expect(m.stats.replies).toBe(1));
    await s.caughtUp(m);
    const sent = s.clientFrames().find((f) => f.ok && f.value.kind === 'act' && f.value.method === 'selectCard');
    expect(sent?.ok && sent.value.kind === 'act' && sent.value.method === 'selectCard' ? sent.value.card.id : null).toBe(HAND_CARD);
  });
});

/*
 * Wave 59 §P, AD4 rule 6. The operator, 2026-10-07: *"why not just show
 * 'Resolve?'"* was wave 53's answer; this wave's design (AD4) supersedes it —
 * the pop-up names what it is asking to resolve.
 */
describe('wave 59 §P — "Resolve {name}?" names the top of the stack', () => {
  /** `match.view.stack[0]`'s own shape (`../adapter.ts`), built by hand so each case pins one field at a time. */
  const stackEntry = (over: Partial<StackEntry>): StackEntry => ({
    id: 1,
    description: 'stack item 1',
    sourceCardId: 9,
    sourceName: 'Remand',
    sourceCard: null,
    controllerName: 'Alice',
    isAbility: false,
    ...over,
  });
  /** Forge's own priority-with-stack status block (`PRIORITY_OVER_STACK`'s own shape, `w20-turn-flow.json`'s real capture). */
  const PRIORITY_WITH_STACK = 'Priority: A\nTurn: 2 (A)\nPhase: Main phase, precombat\nStack: 1 to Resolve.';

  it('a spell names itself', () => {
    expect(decisionMessage(PRIORITY_WITH_STACK, stackEntry({ sourceName: 'Keiga, the Tide Star' }), null)).toBe('Resolve Keiga, the Tide Star?');
  });

  it('a trigger or an ability names its source, with "trigger" — never a bare "Resolve?"', () => {
    expect(decisionMessage(PRIORITY_WITH_STACK, stackEntry({ isAbility: true, sourceName: 'Bitterblossom' }), null)).toBe(
      "Resolve Bitterblossom's trigger?",
    );
  });

  it('no stack item known yet (the view has not caught up to the prompt): the old bare question, never a guessed name', () => {
    expect(decisionMessage(PRIORITY_WITH_STACK, null, null)).toBe('Resolve?');
  });

  it('a stack item that reached this seat with no source name falls back rather than draw "Resolve null?"', () => {
    expect(decisionMessage(PRIORITY_WITH_STACK, stackEntry({ sourceName: null }), null)).toBe('Resolve unknown source?');
  });

  it('priority on an empty stack asks to proceed to the step the rail moves to', () => {
    expect(decisionMessage('Priority: A\nTurn: 2 (A)\nPhase: Main phase, precombat', null, 'Combat')).toBe('Proceed to Combat?');
    expect(decisionMessage('Priority: A', null, 'Declare blockers')).toBe('Proceed to Declare blockers?');
    expect(decisionMessage(PRIORITY_WITH_STACK, stackEntry({ sourceName: 'Remand' }), 'Combat'), 'a stack wins: it resolves, the step does not move').toBe('Resolve Remand?');
  });

  it('the step after each step is the rail\'s next row, combat collapsed outside combat', () => {
    const at = (phase: string) => nextStepName({ phase } as BoardView);
    expect(at('MAIN1')).toBe('Combat');
    expect(at('COMBAT_DECLARE_ATTACKERS')).toBe('Declare blockers');
    expect(at('COMBAT_DECLARE_BLOCKERS'), 'first strike is not a step Forge always runs').toBe('Combat damage');
    expect(at('COMBAT_FIRST_STRIKE_DAMAGE')).toBe('Combat damage');
    expect(at('COMBAT_END')).toBe('Main 2');
    expect(at('END_OF_TURN')).toBe('Cleanup');
    expect(at('CLEANUP')).toBe('Untap');
    expect(at('NOT_A_STEP')).toBeNull();
  });

  it('a prompt that is not the priority-over-stack shape is untouched: Forge\'s own words, same as before this wave', () => {
    expect(decisionMessage('Pay 2 life?', stackEntry({}), null)).toBe('Pay 2 life?');
    expect(decisionMessage('Pay 2 life?', null, null)).toBe('Pay 2 life?');
  });

  it('the real fixture: the decision pop-up names Fire Urchin\'s trigger while it sits on top, then Direct Current once it is the only item left', async () => {
    const { s, m, getByTestId } = await liveBoard();
    expect(m.view!.stack.length, 'the fixture has two items on the stack').toBe(2);
    const [triggerItem, spellItem] = m.view!.stack;
    expect(triggerItem!.isAbility, 'Fire Urchin\'s trigger is on top').toBe(true);
    expect(spellItem!.isAbility, 'Direct Current is the spell underneath').toBe(false);

    for (const f of [
      parseServerFrame({
        kind: 'notify',
        method: 'showPromptMessage',
        player: { kind: 'player', id: 0 },
        message: `Priority: you\nTurn: 14 (you)\nPhase: Main phase, precombat\nStack: 2 to Resolve.`,
        card: null,
      }),
      parseServerFrame({
        kind: 'notify',
        method: 'updateButtons',
        owner: { kind: 'player', id: 0 },
        label1: 'OK',
        label2: 'End Turn',
        enable1: true,
        enable2: true,
        focus1: true,
      }),
    ]) {
      s.send(f);
    }

    await waitFor(() => expect(getByTestId('live-decision').textContent).toContain(`Resolve ${triggerItem!.sourceName}'s trigger?`));

    // The trigger resolves off the stack — only Direct Current is left.
    s.send(stackDelta(m, [spellItem!.id]));
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'showPromptMessage',
        player: { kind: 'player', id: 0 },
        message: `Priority: you\nTurn: 14 (you)\nPhase: Main phase, precombat\nStack: 1 to Resolve.`,
        card: null,
      }),
    );

    await waitFor(() => expect(getByTestId('live-decision').textContent).toContain(`Resolve ${spellItem!.sourceName}?`));
  });
});

describe('the priority ring is gated on a real decision, not drawn from Forge’s raw per-frame fact', () => {
  function fakePlayer(overrides: Partial<BoardPlayer> & Pick<BoardPlayer, 'id' | 'name'>): BoardPlayer {
    return {
      isViewer: false,
      isActive: false,
      hasPriority: false,
      hasLost: false,
      life: 20,
      hand: null,
      handCount: 0,
      libraryCount: 40,
      battlefield: [],
      graveyard: [],
      exile: [],
      ...overrides,
    };
  }
  function fakeView(players: BoardPlayer[]): BoardView {
    return { seq: 1, title: 't', turn: 5, phase: 'UPKEEP', phaseLabel: '', activePlayerId: null, players, stack: [], gameOver: false, missingCardIds: [] };
  }

  describe('withGatedPriority', () => {
    it('draws a player’s hasPriority only while their own side is open', () => {
      const view = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true, hasPriority: true }), fakePlayer({ id: 1, name: 'Them', hasPriority: true })]);
      const out = withGatedPriority(view, false, true);
      expect(out.players.find((p) => p.isViewer)!.hasPriority).toBe(false);
      expect(out.players.find((p) => !p.isViewer)!.hasPriority).toBe(true);
    });

    it('the viewer’s own ring is their open decision alone — lit while they declare blockers, when Forge’s priority player is still the attacker', () => {
      const view = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true, hasPriority: false })]);
      expect(withGatedPriority(view, true, false).players[0]!.hasPriority).toBe(true);
    });

    it('the opponent’s flag is the server’s waiting fact alone — lit while the paced view still says they lack priority (AE16, the ~4.8 s lag behind an End Turn crawl)', () => {
      const view = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true, hasPriority: false }), fakePlayer({ id: 1, name: 'Them', hasPriority: false })]);
      expect(withGatedPriority(view, false, true).players.find((p) => !p.isViewer)!.hasPriority).toBe(true);
      expect(withGatedPriority(view, false, false).players.find((p) => !p.isViewer)!.hasPriority).toBe(false);
    });

    it('returns the SAME view, unchanged, when nothing needs correcting — no object rebuilt most frames', () => {
      const view = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true, hasPriority: false }), fakePlayer({ id: 1, name: 'Them', hasPriority: true })]);
      expect(withGatedPriority(view, false, true)).toBe(view);
    });

    it('rebuilds only when at least one side disagrees, and leaves the other player object untouched', () => {
      const them = fakePlayer({ id: 1, name: 'Them', hasPriority: true });
      const view = fakeView([fakePlayer({ id: 0, name: 'You', isViewer: true, hasPriority: true }), them]);
      const out = withGatedPriority(view, false, true);
      expect(out).not.toBe(view);
      expect(out.players.find((p) => !p.isViewer)).toBe(them);
    });
  });

  describe('through the real board', () => {
    const seatFlag = (container: HTMLElement, who: 'you' | 'opp'): Element | null =>
      container.querySelector(who === 'you' ? '.seat[data-viewer][data-priority]' : '.seat:not([data-viewer])[data-priority]');
    const bothFlagsLit = (container: HTMLElement): boolean => seatFlag(container, 'you') !== null && seatFlag(container, 'opp') !== null;

    const priorityDelta = (seq: number, playerId: number, v: boolean) =>
      parseServerFrame({
        kind: 'notify',
        method: 'applyDelta',
        payload: {
          packet: {
            seq,
            checksum: 0,
            checksumProperties: [],
            newObjects: {},
            objectDeltas: { [String(deltaKey(DELTA_TYPE.player, playerId))]: { _type: DELTA_TYPE.player, _id: playerId, HasPriority: { t: 'bool', v } } },
            events: [],
          },
        },
      });
    // `label2: 'End Turn'`: the control cluster's End Turn button is enabled
    // exactly when Forge's own button two is (`offersEndTurn`), independent
    // of button one.
    const updateButtons = (enable2: boolean) =>
      parseServerFrame({ kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'OK', label2: 'End Turn', enable1: false, enable2, focus1: false });

    it('an auto-passed window’s raw fact ping-pong never reaches the flag — nothing was ever withheld or forwarded for it', async () => {
      const { s, m, container } = await liveBoard();
      const opponentId = m.view!.players.find((p) => !p.isViewer)!.id;
      let seq = m.view!.seq + 1;
      expect(seatFlag(container, 'opp'), 'nothing open for the opponent yet').toBeNull();
      s.send(priorityDelta(seq++, opponentId, true));
      await untilMatch(m, () => expect(m.view!.players.find((p) => !p.isViewer)!.hasPriority).toBe(true));
      expect(seatFlag(container, 'opp'), 'Forge\'s own raw fact flipped, with no server fact behind it').toBeNull();
      s.send(priorityDelta(seq++, opponentId, false));
      await untilMatch(m, () => expect(m.view!.players.find((p) => !p.isViewer)!.hasPriority).toBe(false));
      s.send(priorityDelta(seq, opponentId, true));
      await untilMatch(m, () => expect(m.view!.players.find((p) => !p.isViewer)!.hasPriority).toBe(true));
      expect(seatFlag(container, 'opp'), 'still nothing — the ping-pong alone never moves the drawn flag').toBeNull();
    });

    it('lights for a plain priority hold too — the pop-out ignores `priority` over an empty stack, the flag must not (the 0670a98 regression AE16 found)', async () => {
      const { s, m, container } = await liveBoard();
      s.send(stackDelta(m));
      await untilMatch(m, () => expect(m.view!.stack).toHaveLength(0));
      expect(seatFlag(container, 'opp')).toBeNull();
      await sendTheirWaitingOn(s, m, { method: 'priority', hostCard: null });
      await waitFor(() => expect(seatFlag(container, 'opp')).not.toBeNull());
      expect(container.querySelector('[data-testid="live-waiting-pop"]'), 'and no pop-out for a mere priority hold').toBeNull();
      await sendTheirWaitingOn(s, m, null);
      await waitFor(() => expect(seatFlag(container, 'opp')).toBeNull());
    });

    it('appears the instant the server reports the opponent genuinely parked on something, and is gone the instant the server clears it — Forge’s paced fact moves neither (AE16)', async () => {
      const { s, m, container } = await liveBoard();
      const opponentId = m.view!.players.find((p) => !p.isViewer)!.id;
      const seq = m.view!.seq + 1;
      expect(seatFlag(container, 'opp')).toBeNull();

      // The server's fact alone lights it, while the paced view still says "no priority".
      await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
      await waitFor(() => expect(seatFlag(container, 'opp')).not.toBeNull());

      // A late raw delta does not move it either way…
      s.send(priorityDelta(seq, opponentId, false));
      await untilMatch(m, () => expect(m.view!.seq).toBe(seq));
      expect(seatFlag(container, 'opp')).not.toBeNull();

      // …the server clearing its fact does.
      await sendTheirWaitingOn(s, m, null);
      await waitFor(() => expect(seatFlag(container, 'opp')).toBeNull());
    });

    it('is off the instant the viewer passes a real window of their own — no stale lit flag left behind', async () => {
      const { s, m, container, getByTestId } = await liveBoard();
      const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
      s.send(priorityDelta(m.view!.seq + 1, viewerId, true));
      s.send(updateButtons(true));
      await waitFor(() => expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(false));
      expect(seatFlag(container, 'you'), 'the viewer’s own live window lights their flag').not.toBeNull();

      s.send(updateButtons(false));
      await waitFor(() => expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(true));
      expect(seatFlag(container, 'you'), 'passed: no stale flag left lit').toBeNull();
    });

    it('never lights both flags at once — a stale "waiting for them" fact does not survive the viewer’s own window opening', async () => {
      const { s, m, container, getByTestId } = await liveBoard();
      const opponentId = m.view!.players.find((p) => !p.isViewer)!.id;
      const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
      let seq = m.view!.seq + 1;
      s.send(priorityDelta(seq++, opponentId, true));
      await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
      await waitFor(() => expect(seatFlag(container, 'opp')).not.toBeNull());

      // The viewer's own window opens while the stale "waiting for them" fact has not cleared yet.
      s.send(priorityDelta(seq, viewerId, true));
      s.send(updateButtons(true));
      await waitFor(() => expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(false));
      expect(bothFlagsLit(container), 'the viewer’s own live window is never the stale one').toBe(false);
      expect(seatFlag(container, 'you')).not.toBeNull();
    });

    // The operator, 2026-10-11, under full control: "on full control side i see 'Waiting for Hadoku to
    // decide…'" — over his own live End Turn. The flags held; the pop-out read only the viewer's own
    // pop-ups, never a plain live bar.
    it('the waiting pop-out never draws while the viewer holds a live bar of their own', async () => {
      const { s, m, container, getByTestId } = await liveBoard();
      const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
      const pop = () => container.querySelector('[data-testid="live-waiting-pop"]');
      await sendTheirWaitingOn(s, m, { method: 'confirm', hostCard: null });
      await waitFor(() => expect(pop()).not.toBeNull());

      s.send(priorityDelta(m.view!.seq + 1, viewerId, true));
      s.send(updateButtons(true));
      await waitFor(() => expect((getByTestId('live-button-end-turn') as HTMLButtonElement).disabled).toBe(false));
      expect(pop(), 'the viewer’s own bar is live: nothing to wait for').toBeNull();

      s.send(updateButtons(false));
      await waitFor(() => expect(pop(), 'passed: the other seat’s decision is theirs again').not.toBeNull());
    });
  });
});

describe('rematchOf — who has pressed Rematch, read off the room table', () => {
  const row = (you: boolean, ready: boolean) => ({
    seat: you ? 0 : 1,
    name: '',
    you,
    ready,
  });
  const table = (...players: ReturnType<typeof row>[]) => ({
    room: { id: 'r-1', name: '', gameType: 'constructed-1v1', matchId: null, seats: 2 },
    you: { player: true, leader: false },
    players,
  });

  it('nothing until the table answers', () => {
    expect(rematchOf(null, false)).toEqual({ mine: false, theirs: false, highlight: false, possible: false, agreed: false });
  });

  it('the other pressed: highlighted for me; both pressed: agreed, no highlight', () => {
    expect(rematchOf(table(row(true, false), row(false, true)), false)).toMatchObject({ theirs: true, highlight: true, agreed: false });
    expect(rematchOf(table(row(true, true), row(false, true)), false)).toMatchObject({ mine: true, highlight: false, agreed: true });
  });

  it('the other left a human game: nothing to agree with; alone against the bot: possible', () => {
    expect(rematchOf(table(row(true, true)), false)).toMatchObject({ possible: false, agreed: false });
    expect(rematchOf(table(row(true, false)), true)).toMatchObject({ possible: true, agreed: false });
  });
});

describe('a stop on the phase rail', () => {
  const rowOf = (container: HTMLElement, phase: string) => container.querySelector<HTMLElement>(`[data-testid="live-phases"] li[data-phase="${phase}"]`)!;
  const stopsSent = (s: ReplayServer) => s.received.filter((r) => r.event === 'forge:phase-stop').map((r) => (r.payload as { phase: unknown }).phase);

  it('a click sets the seat’s stop and marks the row; a second click clears it', async () => {
    const { s, m, container } = await liveBoard();
    fireEvent.click(rowOf(container, 'END_OF_TURN'));
    await waitFor(() => expect(stopsSent(s)).toEqual(['END_OF_TURN']));
    expect(m.phaseStop).toBe('END_OF_TURN');
    expect(rowOf(container, 'END_OF_TURN').hasAttribute('data-stop')).toBe(true);

    fireEvent.click(rowOf(container, 'END_OF_TURN'));
    await waitFor(() => expect(stopsSent(s)).toEqual(['END_OF_TURN', null]));
    expect(rowOf(container, 'END_OF_TURN').hasAttribute('data-stop')).toBe(false);
    expect(await s.framesFrom(m)).toEqual([]);
  });

  it('Untap and Cleanup take no stop: Forge opens no window there', async () => {
    const { s, container } = await liveBoard();
    for (const phase of ['UNTAP', 'CLEANUP']) {
      expect(rowOf(container, phase).hasAttribute('data-stoppable')).toBe(false);
      fireEvent.click(rowOf(container, phase));
    }
    fireEvent.click(rowOf(container, 'UPKEEP'));
    await waitFor(() => expect(stopsSent(s)).toEqual(['UPKEEP']));
  });

  it('the collapsed Combat row is a stop on the next combat; in combat, it marks the step it holds this turn', async () => {
    const { s, m, container } = await liveBoard();
    fireEvent.click(rowOf(container, 'COMBAT'));
    await waitFor(() => expect(stopsSent(s)).toEqual(['COMBAT']));
    expect(rowOf(container, 'COMBAT').hasAttribute('data-stop')).toBe(true);

    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'applyDelta',
        payload: {
          packet: {
            seq: m.view!.seq + 1,
            checksum: 0,
            checksumProperties: [],
            newObjects: {},
            objectDeltas: {
              [String(deltaKey(DELTA_TYPE.game, 1))]: { _type: DELTA_TYPE.game, _id: 1, Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: 'COMBAT_BEGIN' } },
            },
            events: [],
          },
        },
      }),
    );
    await waitFor(() => expect(container.querySelector('[data-testid="live-phases"]')!.hasAttribute('data-combat')).toBe(true));
    const whose = container.querySelector('[data-testid="live-phases"]')!.getAttribute('data-whose');
    const marked = [...container.querySelectorAll('[data-testid="live-phases"] li[data-stop]')].map((li) => li.getAttribute('data-phase'));
    expect(marked).toEqual([whose === 'yours' ? 'COMBAT_BEGIN' : 'COMBAT_DECLARE_ATTACKERS']);
  });

  it('the server’s word is the stop: its echo after a reload marks the row, and a spent stop clears it', async () => {
    const { s, m, container } = await liveBoard();
    s.sendPhaseStop('MAIN2');
    await waitFor(() => expect(rowOf(container, 'MAIN2').hasAttribute('data-stop')).toBe(true));
    s.sendPhaseStop(null);
    await waitFor(() => expect(rowOf(container, 'MAIN2').hasAttribute('data-stop')).toBe(false));
    expect(m.phaseStop).toBeNull();
  });
});
