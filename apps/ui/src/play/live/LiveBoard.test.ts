// @vitest-environment jsdom
/*
 * The live board in a DOM: a real server replaying a real game, a real
 * socket, and a person's click on the confirm dialog travelling back to the
 * server as the reply Forge is waiting on.
 *
 * Every wait is RTL's `waitFor`, because the updates come from socket events
 * outside React's `act` — `waitFor` is what makes that legitimate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ComponentType } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { parseServerFrame } from '@hadoku/forge-wire';

import type { BoardInteraction, BoardLayout } from '../Board.tsx';
import { HeaderSettingsHost, HeaderSettingsProvider } from '../../chrome/HeaderSettings.tsx';
import { PHASE_LABEL, type BoardView } from '../adapter.ts';
import { deltaKey, WireType } from '../wire.ts';
import { PROMPT_FIXTURES, askFor } from '../prompts/fixtures.ts';
import { PROMPT_COMPONENTS, PROMPT_METHODS } from '../prompts/index.ts';

import {
  isMatchGone,
  LiveBoard,
  liveStatus,
  MATCH_GONE_SENTENCE,
  refusalOf,
  statusText,
  type LiveStatus,
} from './LiveBoard.tsx';
import {
  answerAsk,
  boardInteraction,
  closeMatch,
  currentAsk,
  pressButton,
  selectCard,
  socketIoMatchTransport,
  startMatch,
  type LiveMatch,
  type MatchTransport,
} from './match.ts';
import type { PlayPrefs } from './prefs.ts';
import { confirmAsk, fixtureFrames, startReplayServer, type ReplayServer } from './replay-server.ts';
import { parseMatchAck } from './transport.ts';

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

afterEach(async () => {
  cleanup();
  if (match !== null) closeMatch(match);
  match = null;
  if (server !== null) await server.close();
  server = null;
  prefsState.prefs = null;
  prefsState.saved = [];
});

/**
 * `menu`: render the header gear's popout host beside the board, as `AppChrome`
 * does while the popout is open — the match's settings are drawn INTO it
 * (wave 32 Q15), so a test that wants them needs it.
 */
async function liveBoard(playerId = 0, menu = false) {
  const s = (server = await startReplayServer({ playerId }));
  const m = (match = startMatch({
    matchId: s.matchId,
    transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
  }));
  const utils = render(
    menu
      ? createElement(HeaderSettingsProvider, null, createElement(HeaderSettingsHost), createElement(LiveBoard, { match: m }))
      : createElement(LiveBoard, { match: m }),
  );
  await waitFor(() => expect(m.stats.snapshots).toBe(1));
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
  await waitFor(() => expect(m.stats.applied).toBe(frames.length), { timeout: 10_000 });
  // The turn number is the RAIL's: §A deleted `.board__bar`, which carried
  // `turn`, and `live-turn-n` is Forge's own counter on its own (wave 26 §B.2).
  await waitFor(() => expect(utils.getByTestId('live-turn-n').textContent).toBe('14'));
  return { s, m, ...utils };
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
    await waitFor(() => expect(getByTestId('live-status').textContent).toBe('Seat 1, waiting for the state.'));
    expect(lines(container)).toEqual(['Seat 1, waiting for the state.']);
    // No state, so no rail: the turn indicator arrives with the board.
    expect(queryByTestId('live-turn-n')).toBeNull();

    const frames = fixtureFrames();
    s.send(frames[0]!);
    await waitFor(() => expect(getByTestId('live-turn-n')).toBeTruthy());
    for (const f of frames.slice(1)) s.send(f);
    await waitFor(() => expect(getByTestId('live-turn-n').textContent).toBe('14'));
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
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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
      await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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
    await waitFor(() => expect(m.stats.snapshots).toBe(1));
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
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
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
      await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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

  it('draws the coin toss and sends the click Forge is waiting for', async () => {
    const { s, m, getByTestId } = await liveBoard();

    for (const f of buttonFrames('Seat 1, you have won the coin toss.\n\nPlay or draw?', 'Play', 'Draw')) {
      s.send(f);
    }

    await waitFor(() => expect(getByTestId('live-button-ok').textContent).toBe('Play'));
    expect(getByTestId('live-says').textContent).toContain('coin toss');
    expect(getByTestId('live-button-cancel').textContent).toBe('Draw');

    const before = m.stats.replies;
    fireEvent.click(getByTestId('live-button-ok'));

    await waitFor(() => expect(m.stats.replies).toBe(before + 1));
    await waitFor(() =>
      expect(
        s
          .clientFrames()
          .some((f) => f.ok && f.value.kind === 'act' && f.value.method === 'selectButtonOk'),
      ).toBe(true),
    );
  });

  it('a bar Forge has disabled is not pressable, so a stale click cannot answer the NEXT question', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();

    for (const f of buttonFrames('Choose', 'OK', 'Cancel')) s.send(f);
    await waitFor(() => expect((getByTestId('live-button-ok') as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(getByTestId('live-button-ok'));
    // The bar stays where it is; its buttons go disabled until Forge sends a fresh one.
    await waitFor(() => expect((getByTestId('live-button-ok') as HTMLButtonElement).disabled).toBe(true));
    expect(getByTestId('live-buttons')).toBeTruthy();
    // Forge disabled the second button too, so it is not drawn at all (Q15b).
    expect(queryByTestId('live-button-cancel')).toBeNull();

    fireEvent.click(getByTestId('live-button-ok'));
    expect(pressButton(m, 'ok')).toBe(false);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(m.stats.replies).toBe(1);
  });

  it('the bar is there before Forge has sent one: neutral labels, both buttons disabled, nothing said', async () => {
    const { getByTestId, queryByTestId } = await liveBoard();
    expect(getByTestId('live-says').textContent).toBe('');
    const ok = getByTestId('live-button-ok') as HTMLButtonElement;
    expect([ok.textContent, ok.disabled]).toEqual(['OK', true]);
    // No bar, so Forge has enabled no second button, so none is drawn (Q15b).
    expect(queryByTestId('live-button-cancel')).toBeNull();
  });

  it('the bar stays while a question is open, disabled, and a press sends nothing', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    for (const f of buttonFrames('Priority', 'OK', 'End Turn')) s.send(f);
    await waitFor(() => expect((getByTestId('live-button-ok') as HTMLButtonElement).disabled).toBe(false));
    expect(getByTestId('live-button-cancel').textContent, 'Forge’s own word, drawn while Forge enables it').toBe('End Turn');

    s.send(confirmAsk('c-open'));
    await waitFor(() => getByTestId('confirm-dialog'));
    const ok = getByTestId('live-button-ok') as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    expect(queryByTestId('live-button-cancel'), 'a question is open: the second button is not drawn').toBeNull();
    expect(getByTestId('live-says').textContent).toBe('Priority');
    fireEvent.click(ok);
    expect(pressButton(m, 'ok')).toBe(false);
    expect(m.stats.replies).toBe(0);

    fireEvent.click(getByTestId('confirm-dialog').querySelector('[data-answer="yes"]')!);
    await waitFor(() => expect((getByTestId('live-button-ok') as HTMLButtonElement).disabled).toBe(false));
    expect(s.clientFrames().map((f) => (f.ok ? f.value.kind : null))).toEqual(['reply']);
  });
});

/*
 * The board's cards, clicked. `Board` draws a card as a button only when
 * `boardInteraction` offers it; the click goes to `selectCard`, which checks
 * Forge's CURRENT state before sending.
 */
describe('clicking a card on the live board', () => {
  function notify(raw: unknown[]) {
    return raw.map((r) => parseServerFrame(r));
  }

  it('a card Forge lists is clickable and sends selectCard; once Forge clears the list it is inert and sends nothing', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const [target, other] = [mine[0]!, mine[1]!];
    const button = (id: number) => container.querySelector<HTMLButtonElement>(`[data-board-card="${id}"] button`);
    expect(button(target)).toBeNull();

    for (const f of notify([
      { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Select a target', card: null },
      { kind: 'notify', method: 'setSelectables', cards: [{ kind: 'card', id: target }], min: 1, max: 1 },
    ])) {
      s.send(f);
    }
    await waitFor(() => expect(button(target)).not.toBeNull());
    expect(button(other)).toBeNull();
    expect(container.querySelector(`[data-board-card="${target}"]`)!.hasAttribute('data-selectable')).toBe(true);

    fireEvent.click(button(target)!);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(s.clientFrames()[0]).toEqual({
      ok: true,
      value: { kind: 'act', method: 'selectCard', card: { kind: 'card', id: target }, otherCardViewsToSelect: [], triggerEvent: null },
    });
    // Spent: not a button again until Forge speaks.
    await waitFor(() => expect(button(target)).toBeNull());

    s.send(parseServerFrame({ kind: 'notify', method: 'clearSelectables' }));
    await waitFor(() => expect(m.selectables).toBeNull());
    expect(button(target)).toBeNull();
    expect(button(other)).toBeNull();
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
    const { s, getByTestId } = await liveBoard();
    const toggle = getByTestId('live-full-control') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(s.received.filter((r) => r.event === 'forge:full-control')).toEqual([]);

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(s.received.filter((r) => r.event === 'forge:full-control')).toHaveLength(1));
    expect(s.received.filter((r) => r.event === 'forge:full-control')[0]!.payload).toEqual({
      matchId: s.matchId,
      on: true,
    });

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('false'));
    await waitFor(() => expect(s.received.filter((r) => r.event === 'forge:full-control')).toHaveLength(2));
    expect(s.received.filter((r) => r.event === 'forge:full-control')[1]!.payload).toEqual({
      matchId: s.matchId,
      on: false,
    });
    // A preference, not a frame: none of it crossed forge:c2s.
    expect(s.clientFrames()).toEqual([]);
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
    expect(offered.map((b) => b.textContent)).toEqual(['Tap: Add R.', '2, Sacrifice Pyrite Spellbomb: Draw a card.']);
    expect(sheet.textContent).not.toMatch(/ability #/);

    fireEvent.click(offered[1]!);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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
   * at all"*. The policy is `rules.ts`'s `autoAnswer`; this is the wiring.
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
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(s.clientFrames()[0]).toMatchObject({
      ok: true,
      value: { kind: 'reply', callId: 'fx-only-one', method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 9001 } },
    });
    // Nothing was ever drawn for it, and nothing is left open.
    expect(queryByTestId('live-prompt')).toBeNull();
    expect(m.asks).toEqual([]);
    // And it said what it played, in Forge's own words: a shortcut nobody can
    // see is a swallowed click. The braces are said in words at the draw
    // (`plainRulesText`), as every other says line is.
    expect(m.says).toContain('played {T}: Add {R}.');
  });

  it('full control makes that same one-ability offer a question again', async () => {
    const { s, m, getByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-full-control'));
    await waitFor(() => expect(m.fullControl).toBe(true));
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
    await waitFor(() => expect(getByTestId('live-prompt').dataset.callId).toBe('fx-full-control'));
    expect(s.clientFrames()).toEqual([]);
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
    expect(s.clientFrames()).toEqual([]);
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
    const { container, getByTestId } = await liveBoard();
    const concede = getByTestId('live-concede');
    const bar = getByTestId('live-buttons');
    expect(concede.tagName).toBe('BUTTON');
    expect(bar.contains(concede)).toBe(true);
    // Not adjacent to OK or Cancel: Full control stands between, so a reach
    // for Concede is never a misclick on Forge's answer.
    const order = [...bar.children].map((el) => (el as HTMLElement).dataset.testid);
    expect(order.indexOf('live-full-control'), 'Full control stands between Forge’s answers and Concede').toBe(
      order.indexOf('live-concede') - 1,
    );
    expect(container.querySelector('.board')!.contains(concede)).toBe(false);
    // The cluster still holds five children — item 7 put `Settings` in the
    // slot item 5's deletion of `Leave` vacated — and is still a sibling of
    // the board, drawn after it: the chrome is around the canvas, not in it.
    const live = container.querySelector('.live')!;
    expect([...live.children].map((el) => el.className)).toEqual([
      'board',
      'live__phases',
      'live__logbook',
      'live__log-button',
      'live__buttons',
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
      '.shell--match .live, .live > .board',
      '.live > .board',
      '.live .card__rules',
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
 * with `live-button-ok` and `live-button-cancel` in it, and that box is at the
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
    for (const id of ['live-button-ok', 'live-full-control', 'live-concede']) {
      expect(cluster.querySelector(`[data-testid="${id}"]`), `the cluster still holds ${id}`).not.toBeNull();
    }
    // Wave 32 Q15 took Settings out: it is in the header's gear.
    expect(cluster.querySelector('[data-testid="live-settings"]')).toBeNull();
    // Item 5 deleted `Leave`: the cluster no longer holds it at all.
    expect(cluster.querySelector('[data-testid="live-leave"]')).toBeNull();
    /*
     * And in the order they are DRAWN (wave 27 §B.1). The cluster is one
     * column, so the tab order and the reading order are the same order —
     * `Settings` (item 7) is written in the slot `Leave` vacated.
     */
    expect([...cluster.querySelectorAll('button')].map((b) => b.dataset.testid)).toEqual([
      'live-button-ok',
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

  it('the logbook is out of flow over the board and takes no pointer events, so it moves and blocks nothing', async () => {
    const { container, getByTestId } = await liveBoard();
    expect(container.querySelector('.board')!.contains(getByTestId('live-logbook'))).toBe(false);
    const decls = declarations(liveCss(), '.live__logbook');
    expect(decls).toContain('position: absolute');
    expect(decls).toContain('pointer-events: none');
    // On the LEFT, which is the edge the phase rail vacated (§C.4).
    expect(decls).toContain('left: 6px');
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

  it('is out of the flow in the right-hand gutter under the rail, so the table has the height back', () => {
    const decls = declarations(liveCss(), '.live__buttons');
    expect(decls).toContain('position: absolute');
    expect(decls).toContain('right: var(--live-gutter)');
    /*
     * §B.3 — it sits DIRECTLY UNDER the rail, in the same column, at the
     * percentage the operator dragged it to (67% down, against the rail's 31% +
     * 35%). It is not bottom-anchored any more, and that matters: the rail's
     * height is definite, so the two boxes cannot drift into each other.
     */
    expect(decls).toContain('top: 67%');
    expect(decls, 'not anchored to the bottom edge any more').not.toContain('bottom:');
    expect(decls).toContain('width: var(--live-controls-w)');
    expect(decls).toContain('height: var(--live-controls-h)');
    /*
     * The WIDTH the operator drew, and it is the one number that may not move
     * (wave 27 §B.1): `board.css` derives `--right-gutter` from it — *"controls
     * 6 + 112 = 118px <- the widest, and what this token is for"* — so widening
     * the cluster takes the reservation out of every row of a 960px table. The
     * HEIGHT is what gave instead, 84 → 136, when the five buttons became one
     * column so that `Full control` and `Concede` stopped being clipped. Item
     * 5 (wave 30) deleted `Leave` and item 7 put `Settings` in its slot; wave 32
     * Q15 took `Settings` out again (it is in the header's gear), so the
     * cluster is four rows and the number is 110.
     */
    const live = declarations(liveCss(), '.live');
    expect(live).toContain('--live-controls-w: 112px');
    expect(live).toContain('--live-controls-h: 110px');
    // No full-width bar remains: the token that gave the row under the canvas
    // its height is gone from the file, not merely unused.
    expect(liveCss()).not.toContain('--live-bar-h');
  });

  it('every slot in it is a fixed track, so one window size can never see two boxes', () => {
    const css = liveCss();
    const cluster = declarations(css, '.live__buttons');
    /*
     * A track sized by its content is exactly how the box changes between
     * frames — a longer button label from Forge. `1fr` IS such a track:
     * it is `minmax(auto, 1fr)`, floored by the widest thing in the column, so
     * the one column is written `minmax(0, 1fr)` (wave 27 §B.1).
     */
    expect(cluster).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(cluster).toContain('grid-template-rows: repeat(4, 22px)');
    // Four rows, one column: no label shares a row with another, which is what
    // stopped `Full control` and `Concede` ellipsizing. Cancel (Forge's second
    // button) comes and goes without a track of its own appearing or vanishing.
    expect(cluster).not.toContain('grid-template-areas');
    expect(cluster, 'item 5: no row for Leave any more').not.toContain('leave');
    /*
     * The ellipsis stays, as the LAST RESORT for a label Forge chose and not for
     * one of ours: `label1`/`label2` come off the wire and the five that do not
     * now have 92px each. `e2e/table-fit.spec.ts` is what proves none of ours is
     * clipped in a real browser — `scrollWidth` against `clientWidth`, because a
     * clipped label breaches no box and no overflow check can see it.
     */
    expect(declarations(css, '.live__buttons button')).toContain('text-overflow: ellipsis');
    // The row that was sized by Forge's own words is gone from the grid
    // altogether (§C.1); the `log` area that remains is the TOGGLE's, a button.
    expect(cluster, 'no says row in the cluster').not.toContain('says');
    // And no row for the log either — its button is its own overlay now (§B.4).
    expect(cluster, 'no log row in the cluster').not.toContain('log');
    // The text is capped in the logbook instead, where the height is not the
    // cluster's to lose.
    expect(declarations(css, '.live__says')).toContain('overflow: auto');
    expect(declarations(css, '.live__log')).toContain('overflow: hidden');
    // The sizes resolve on `.live` itself, so the dev harness — which mounts it
    // with no shell — gets a fixed box too. A `var()` with no value is an
    // invalid declaration and the cluster would fall back to content size.
    const live = declarations(css, '.live');
    for (const token of ['--live-controls-h:', '--live-controls-w:', '--live-rail-w:', '--live-col-x:', '--live-col-w:', '--live-gutter:']) {
      expect(live, `${token} is defined on .live`).toContain(token);
    }
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
    expect(tracks).toEqual([22, 22, 22, 22]);
    const padY = Number(/padding: (\d+)px/.exec(cluster)?.[1]);
    const gap = Number(/gap: (\d+)px/.exec(cluster)?.[1]);
    const token = Number(/--live-controls-h: (\d+)px/.exec(declarations(css, '.live'))?.[1]);
    const border = 1;
    expect(
      tracks.reduce((a, b) => a + b, 0) + gap * (tracks.length - 1) + padY * 2 + border * 2,
      'padding + border + rows + gaps === --live-controls-h',
    ).toBe(token);
    // And the arithmetic is written out beside the token, so the next reader of
    // the file does not have to run this to see where the number came from.
    expect(css, 'the comment beside the token says the same sum').toContain(
      '4 + 4 padding + 1 + 1 border + (22 + 22 + 22 + 22) rows + 3 × 4 gaps = 110',
    );
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
    const decls = declarations(liveCss(), '.live__phases');
    expect(decls).toContain('position: absolute');
    expect(decls).toContain('pointer-events: none');
    // Under lane A's overlay root (z 2), so the inspector's enlarged card still
    // comes out on top of the rail rather than behind it.
    expect(decls, 'wave 32 Q16: the rail is on the overlay layer').toContain('z-index: var(--z-overlay, 20)');
  });

  /*
   * ── Wave 26 §B, items 1 and 2: the two overlays the operator DREW ─────────
   *
   * `docs/planning/board-layout-2026-09-27.md` is a spec made by dragging the real
   * regions on a 1280×800 canvas, and this is the one case that pins the two
   * numbers that file is FOR: the question's column and the rail's anchor. Both
   * are read off `live.css`'s own text, because jsdom applies no stylesheet — the
   * boxes themselves are measured on every frame of a real match by
   * `e2e/table-fit.spec.ts`.
   *
   * Reverting either one fails here: a question centred in the room above the
   * cluster has no `left`, and a rail that is 2rem wide against the old anchor has
   * neither the width token nor the percentage behind it.
   */
  it('the rail anchors right at 8.4%, and the question has ONE home at 59.4% across', () => {
    const css = liveCss();
    const live = declarations(css, '.live');
    const rail = declarations(css, '.live__phases');

    // The rail: the right-hand gutter, and the width the operator widened it to.
    expect(rail).toContain('right: var(--live-gutter)');
    expect(rail).toContain('width: var(--live-rail-w)');
    /*
     * 8.4% is the proportion the operator drew and 6.75rem is the 108px they drew
     * it at; the floor is not decoration. In a watchparty ROOM the chat sits beside
     * the match and `.live` is 944px wide, where 8.4% is 79px and "Beginning of
     * combat" truncates — which is the one thing §B.2 widened the rail to prevent.
     */
    expect(live, 'the rail is 8.4% of the width, and never below the 108px that fits the names').toContain(
      '--live-rail-w: max(8.4%, 6.75rem)',
    );
    expect(rail, 'no left anchor is left behind').not.toContain('left:');
    /*
     * And what the rail's floor actually LEAVES a name, which is the number wave
     * 26 got wrong (wave 27 §B.2).
     *
     * 108 − 2 border − 2 × side padding − the mark − the gap is a name's whole
     * budget, and at 9.5px type `Beginning of combat` needed 94 of the 94 it had
     * — but only at weight 400. The CURRENT step is drawn at 600, where the same
     * word needs 97, so it ellipsized for the handful of frames a turn spends in
     * that step, and no box anywhere breached. Measured in Chromium against the
     * app's own font stack; the table is in `live.css` beside the rule.
     *
     * This adds the terms up off the file rather than trusting a literal, the
     * way the cluster's height token is added up above — and the worst case it
     * is compared against is the BOLD one.
     */
    const px = (decls: string, prop: string): number[] =>
      [...(new RegExp(`(?:^|; )${prop}: ([^;]+)`).exec(decls)?.[1] ?? '').matchAll(/([\d.]+)px/g)].map((m) => Number(m[1]));
    const name = declarations(css, '.live__step-name');
    const floorRem = Number(/--live-rail-w: max\(8\.4%, ([\d.]+)rem\)/.exec(live)?.[1]);
    // Wave 32 Q3 took the mark (and its gap) out of every row: the name has the
    // whole of it, centred.
    const budget = floorRem * 16 - 2 * 1 - 2 * px(rail, 'padding')[1]!;
    expect(budget, 'a step name’s own budget at the rail’s floor').toBe(104);
    expect(px(name, 'font-size')[0], 'the type the budget was measured at').toBe(9);
    // `Beginning of combat` at 9px/600, the longest of Forge's thirteen at the
    // weight the current step is actually drawn at.
    expect(budget, 'the widest step name, BOLD, fits the budget').toBeGreaterThanOrEqual(92);
    // Its own percentages, which is what makes the cluster's `top: 67%` land
    // directly under it rather than wherever thirteen rows happened to end.
    expect(rail).toContain('top: 31%');
    expect(rail, 'a full turn is 35% of the canvas').toContain('(35% - var(--rail-chrome))');
    expect(rail, 'not centred any more: the gutter is a strip, in the drawn order').not.toContain('translate:');

    // The question: a fixed column, not a sheet centred on whatever height it is.
    const host = declarations(css, '.live__prompt');
    expect(host).toContain('left: var(--live-col-x)');
    expect(host).toContain('width: var(--live-col-w)');
    expect(host).toContain('top: 24%');
    expect(host).toContain('height: 48%');
    expect(live).toContain('--live-col-x: 59.4%');
    expect(live).toContain('--live-col-w: 24.1%');
    // The column is where it is so that it CLEARS the gutter, not so that it stops
    // above the cluster: 59.4% + 24.1% = 83.5%, and the gutter starts past that.
    expect(59.4 + 24.1, 'the question’s column ends clear of the overlay gutter').toBeLessThan(84.4);
    expect(host, 'no inset shorthand from the centred placement survives').not.toContain('inset:');
  });
});

/*
 * §C.3 — a prompt belongs where the player is looking.
 *
 * Teetering Peaks' ask *"appeared as text at the bottom of the screen"*. Where
 * it sits is this lane's; what it looks like inside is lane D's.
 */
describe('a prompt belongs where the player is looking', () => {
  it('the host is a fixed column over the board, with the sheet centred in it', () => {
    const decls = declarations(liveCss(), '.live__prompt');
    // Where the column is, is pinned in its own case above (§B items 1 and 2).
    // What this asserts is the mechanism: a definite box, a centred sheet, and a
    // host that does not swallow the table's clicks.
    expect(decls).toContain('top: 24%');
    expect(decls).toContain('height: 48%');
    expect(decls).toContain('align-items: center');
    expect(decls).toContain('justify-content: center');
    // `top` + `height` is what makes the height definite; a `bottom` as well
    // would over-constrain the box and `bottom` is the one the browser drops.
    expect(decls).not.toContain('bottom:');
    // The host now covers the board, so it must not swallow the table's clicks;
    // the sheet takes them back.
    expect(decls).toContain('pointer-events: none');
    expect(declarations(liveCss(), '.live__prompt > .prompt, .live__prompt > .confirm')).toContain(
      'pointer-events: auto',
    );
  });

  it('an open prompt is a sibling of the board, drawn last — nothing in the canvas moves for it', async () => {
    const { s, container, getByTestId } = await liveBoard();
    s.send(confirmAsk('c-centre', true));
    await waitFor(() => getByTestId('live-prompt'));
    // No `live__status`: a live board draws no line about itself (§B.5). The log's
    // button is its own child of `.live` now, not the cluster's (§B.4).
    expect([...container.querySelector('.live')!.children].map((el) => el.className)).toEqual([
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
 * its own popover modal on top of the game not in some shitty text box."*
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
    await waitFor(() => expect(live.m.promptCard).toBe(mine[0]!));
    return live;
  }

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
    expect(sheet.textContent).toContain('Pay Mana Cost: 3');
    expect(sheet.textContent).toContain('Mana Leak');
    // Forge's labels, not ours.
    expect(getByTestId('live-payment-ok').textContent).toBe('Auto');
    expect(getByTestId('live-payment-cancel').textContent).toBe('Cancel');
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
    expect(getByTestId('live-payment').textContent).toContain('Pay Mana Cost: 3');
    expect(getByTestId('live-logbook').hasAttribute('hidden')).toBe(true);
  });

  it('its buttons are the same sender as the cluster’s: one press, one act, and the window is gone', async () => {
    const { s, m, getByTestId, queryByTestId } = await payment();
    await waitFor(() => getByTestId('live-payment'));
    fireEvent.click(getByTestId('live-payment-ok'));
    await waitFor(() => expect(m.stats.replies).toBe(1));
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
    await waitFor(() => expect(m.stats.replies).toBe(1));
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
    expect(sheet.textContent).toContain('Pay Mana Cost: 3');
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
    expect(s.clientFrames()).toEqual([]);
    expect(m.stats.replies).toBe(0);
    expect(ask.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(ask.textContent).toContain('You lose this game.');
    // The safe button has the focus: Enter on a dialog nobody read must not end
    // the game.
    expect(document.activeElement).toBe(getByTestId('live-concede-no'));
  });

  it('cancel closes it and sends nothing', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-concede'));
    await waitFor(() => getByTestId('live-concede-ask'));
    fireEvent.click(getByTestId('live-concede-no'));
    await waitFor(() => expect(queryByTestId('live-concede-ask')).toBeNull());
    expect(s.clientFrames()).toEqual([]);
    expect(m.stats.replies).toBe(0);
  });

  it('escape is cancel, and sends nothing', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-concede'));
    const ask = await waitFor(() => getByTestId('live-concede-ask'));
    fireEvent.keyDown(ask, { key: 'Escape' });
    await waitFor(() => expect(queryByTestId('live-concede-ask')).toBeNull());
    expect(s.clientFrames()).toEqual([]);
  });

  it('the confirmation’s own yes is the one thing that reaches the wire, exactly once', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    fireEvent.click(getByTestId('live-concede'));
    await waitFor(() => getByTestId('live-concede-ask'));
    fireEvent.click(getByTestId('live-concede-yes'));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(s.clientFrames()[0]).toEqual({ ok: true, value: { kind: 'act', method: 'concede' } });
    // And it closes, so it cannot be conceded twice.
    await waitFor(() => expect(queryByTestId('live-concede-ask')).toBeNull());
    expect(s.clientFrames()).toHaveLength(1);
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
 * The pointer layer's handover (wave 24, lanes B and C).
 *
 * The drag, the slop, the arrow and every test that asserted what they sent are
 * lane B's now, in `./gestures/`. What is left here is the install, and this is
 * the proof it is all that is left — a component that grew a pointer handler
 * back would pass every other test in this file.
 */
describe('the frame installs the gesture layer and owns none of it', () => {
  it('one effect, and nothing about a drag in the component', () => {
    const src = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/live', 'LiveBoard.tsx'), 'utf8');
    expect(src).toContain('installGestures({ canvas, match })');
    expect(src).toContain('handle.dispose()');
    for (const gone of ['commitDrag', 'DRAG_SLOP_PX', 'onPointerDown', 'pointermove', 'pointerup', 'createPortal']) {
      expect(src, `${gone} is ./gestures/'s now`).not.toContain(gone);
    }
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
  const GAME_KEY = String(deltaKey(WireType.Game, 1));
  const notify = (raw: unknown) => parseServerFrame(raw);
  const selectables = (ids: number[], min: number, max: number) =>
    notify({ kind: 'notify', method: 'setSelectables', cards: ids.map((id) => ({ kind: 'card', id })), min, max });
  const actionable = (ids: number[]) =>
    notify({ kind: 'notify', method: 'setWeaklySelectable', cards: ids.map((id) => ({ kind: 'card', id })) });
  const prompt = (message: string) =>
    notify({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: null });
  /** A Game delta: the phase, and whose turn it is. Forge's own structured facts. */
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
              _type: WireType.Game,
              _id: 1,
              Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: name },
              PlayerTurn: { t: 'int', v: playerTurn },
            },
          },
          events: [],
        },
      },
    });

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
    await waitFor(() => expect(m.selectables).not.toBeNull());
    await waitFor(() => expect(container.querySelector(`[data-board-card="${mine[0]}"] button`)).not.toBeNull());
    expect(captured.interaction!.selectionOpen).toBe(true);
    // Exactly `match.selectables !== null`, which is also what `boardInteraction`
    // put on `LiveClickables` — one source, so the two can never disagree.
    expect(captured.interaction!.selectionOpen).toBe(m.selectables !== null);
    expect(boardInteraction(m).selectionOpen).toBe(true);
    expect(captured.interaction!.declaringAttackers).toBe(false);

    s.send(notify({ kind: 'notify', method: 'clearSelectables' }));
    await waitFor(() => expect(m.selectables).toBeNull());
    await waitFor(() => expect(container.querySelector(`[data-board-card="${mine[0]}"] button`)).toBeNull());
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
    await waitFor(() => expect(m.view!.phase).toBe('COMBAT_DECLARE_ATTACKERS'));
    await waitFor(() => expect(getByTestId('live-phases').dataset.phase).toBe('COMBAT_DECLARE_ATTACKERS'));
    expect(getByTestId('live-phases').dataset.whose).toBe('yours');
    expect(captured.interaction!.declaringAttackers).toBe(true);
    // And it is NOT a selection: `InputAttack` publishes none.
    expect(captured.interaction!.selectionOpen).toBe(false);
    expect(m.selectables).toBeNull();

    // The same step, but the OTHER seat is the one declaring.
    s.send(phase(m, 'COMBAT_DECLARE_ATTACKERS', them.id));
    await waitFor(() => expect(m.view!.activePlayerId).toBe(them.id));
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
  const GAME_KEY = String(deltaKey(WireType.Game, 1));
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
              _type: WireType.Game,
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
            ids.map((id) => [String(id), { _type: WireType.Card, _id: id, Attacking: { t: 'bool', v: true } }]),
          ),
          events: [],
        },
      },
    });

  it('paints Forge’s label2 while Forge enables it, and refuses it whether or not an attacker is declared', async () => {
    const { s, m, getByTestId, queryByTestId } = await liveBoard();
    const me = m.view!.players.find((p) => p.isViewer)!;
    const cancel = () => queryByTestId('live-button-cancel') as HTMLButtonElement | null;

    // 1. Outside combat, Forge's word is Forge's word. Nothing here filters it.
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

    // 3. One attacker declared. Forge's own `canCallBackAttackers()` is true now
    //    and it sends `Call Back` — item 16 refuses this one too, on the operator's
    //    own instruction, so the button stays absent instead of becoming Forge's undo.
    s.send(attacking(m, [me.battlefield.find((c) => !c.tapped)!.id]));
    s.send(bar('Call Back'));
    await waitFor(() => expect(m.buttons!.label2).toBe('Call Back'));
    expect(cancel(), 'Call Back is refused too (item 16)').toBeNull();
    expect(getByTestId('live-buttons').textContent).not.toContain('Call Back');
  });

  /*
   * Wave 32 Q15b — *"what is the point of the cancel button in the control
   * pane?"* It is Forge's second prompt button, so it is drawn only while Forge
   * enables it and in Forge's own word; the cluster's box is a fixed token, so
   * it appearing moves nothing.
   */
  it('Q15b: the second button is drawn only while Forge enables it, in Forge’s word, and the cluster box does not move', async () => {
    const { s, getByTestId, queryByTestId } = await liveBoard();
    expect(queryByTestId('live-button-cancel'), 'no bar yet').toBeNull();

    s.send(bar('Auto'));
    await waitFor(() => expect(queryByTestId('live-button-cancel')).not.toBeNull());
    expect(getByTestId('live-button-cancel').textContent).toBe('Auto');

    s.send(bar('Auto', false));
    await waitFor(() => expect(queryByTestId('live-button-cancel')).toBeNull());
    // Both states share the one container and its fixed-track CSS.
    expect(getByTestId('live-buttons').querySelectorAll('button').length).toBe(3);
  });
});

/* ── §A.11 — the log, as something you can read ──────────────────────── */

/**
 * The render half of item 11. Lane B shipped the server half at `2cb7293`:
 * `sayToTable` composes each line once per recipient from that recipient's own
 * folded history, so the whole table's events reach both seats and a name the
 * recipient may not know cannot ride along. This is what the result LOOKS like.
 */
describe('§A.11 — the log is coloured by what happened, and its card names reveal the card', () => {
  const says = (text: string) => parseServerFrame({ kind: 'notify', method: 'message', message: text, title: '' });
  const lines = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-testid="live-log"] li')];

  it('marks each line with its kind, and each kind has an ink of its own', async () => {
    const { s, container } = await liveBoard();
    for (const f of [
      says('paid U — Volcanic Island'),
      says('Fire Urchin deals 2 damage to Goblin Replica'),
      says('full control on'),
      says('played Island'),
      says('nothing in particular'),
    ]) {
      s.send(f);
    }
    await waitFor(() => expect(lines(container)).toHaveLength(5));
    expect(lines(container).map((li) => li.dataset.logKind)).toEqual(['payment', 'damage', 'control', 'play', 'said']);
    /*
     * Colour is never the only signal — the words are, and always were. These are
     * tints on the text rather than badges, so a log read with no colour at all
     * still says everything it said before.
     */
    for (const kind of ['payment', 'damage', 'life', 'play', 'control']) {
      const rule = new RegExp(`\\.live__log li\\[data-log-kind='${kind}'\\] \\{([^}]*)\\}`).exec(liveCss());
      expect(rule, `${kind} has a rule`).not.toBeNull();
      expect(rule![1], `${kind} sets an ink`).toMatch(/color:/);
    }
  });

  it('tells the table’s lines from your own, by the attribution the server already puts on them', async () => {
    const { s, m, container } = await liveBoard();
    const them = m.view!.players.find((p) => !p.isViewer)!;
    s.send(says('paid U — Volcanic Island'));
    s.send(says(`${them.name} paid R — Mountain`));
    await waitFor(() => expect(lines(container)).toHaveLength(2));
    // `sayToTable` attributes the OPPONENT's copy and leaves the actor's own
    // unattributed, so an unattributed line is by construction your own doing.
    expect(lines(container).map((li) => li.dataset.logWho)).toEqual(['you', 'them']);
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
 * `liveBoard(0, true)` renders the header popout's host beside the board, which
 * is what `AppChrome` does while the gear is open.
 */
describe('the match settings live in the header menu (items 4-7, Q15)', () => {
  it('there is no Settings button and no floating panel in the match any more', async () => {
    const { container, queryByTestId } = await liveBoard(0, true);
    expect(queryByTestId('live-settings')).toBeNull();
    expect(container.textContent).not.toContain('Settings');
    // The controls are in the header's popout host, not inside `.live`.
    const host = queryByTestId('header-app-settings')!;
    expect(host.contains(queryByTestId('live-settings-panel'))).toBe(true);
    expect(container.querySelector('.live')!.contains(queryByTestId('live-settings-panel'))).toBe(false);
    expect(container.querySelector('.live__ask')).toBeNull();
  });

  it('draws nothing when the popout is not open (no host)', async () => {
    const { queryByTestId } = await liveBoard();
    expect(queryByTestId('live-settings-panel')).toBeNull();
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

  it('always-stop-at-end-step: off by default, the checkbox sends forge:stop-preference and persists the change', async () => {
    const { s, m, getByTestId } = await liveBoard(0, true);
    expect(m.stopAtEndStep).toBe(false);
    const checkbox = getByTestId('live-settings-stop-end-step') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    await waitFor(() => expect(m.stopAtEndStep).toBe(true));
    const sent = s.received.filter((r) => r.event === 'forge:stop-preference');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({ matchId: s.matchId, type: 'stopPreference', stopAtEndStep: true });
    expect(prefsState.saved).toContainEqual({ stopAtEndStep: true });
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    await waitFor(() => expect(m.stopAtEndStep).toBe(false));
    expect(s.received.filter((r) => r.event === 'forge:stop-preference')).toHaveLength(2);
    // A preference, not a Forge frame: none of it crossed forge:c2s.
    expect(s.clientFrames()).toEqual([]);
  });

  it('a persisted preference is sent to the server on join, without the panel ever opening — the manager’s own instruction', async () => {
    prefsState.prefs = { boardLayout: 'type-separated', stopAtEndStep: true };
    const { s, m } = await liveBoard();
    await waitFor(() => expect(m.stopAtEndStep).toBe(true));
    expect(captured.boardLayout).toBe('type-separated');
    const sent = s.received.filter((r) => r.event === 'forge:stop-preference');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({ matchId: s.matchId, type: 'stopPreference', stopAtEndStep: true });
    // No popout host was rendered in this test at all.
  });

  it('a persisted OFF preference is still sent on join — force, because off already matches the client default', async () => {
    prefsState.prefs = { stopAtEndStep: false };
    const { s, m } = await liveBoard();
    await waitFor(() => expect(s.received.filter((r) => r.event === 'forge:stop-preference')).toHaveLength(1));
    expect(m.stopAtEndStep).toBe(false);
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
  const GAME_KEY = String(deltaKey(WireType.Game, 1));
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
              _type: WireType.Game,
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
  const flag = (m: LiveMatch, patch: { spectator?: boolean; over?: boolean }, rerender: (ui: ReturnType<typeof createElement>) => void) => {
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
    await waitFor(() => expect(m.selectables).not.toBeNull());
    await waitFor(() => expect(m.buttons?.enable1).toBe(true));
    expect(queryByTestId('live-spectator')).toBeNull();
    const frames = s.clientFrames().length;

    flag(m, { spectator: true }, rerender);
    expect(getByTestId('live-spectator').textContent).toBe('Watching: this seat is being played in another window');
    expect(queryByTestId('confirm-dialog'), 'a watcher is asked nothing').toBeNull();
    expect(queryByTestId('live-prompt')).toBeNull();
    for (const id of ['live-button-ok', 'live-full-control', 'live-concede']) {
      expect((getByTestId(id) as HTMLButtonElement).disabled, `${id} is inert`).toBe(true);
    }
    expect(queryByTestId('live-button-cancel'), 'a watcher is offered no second button').toBeNull();
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
    expect(s.clientFrames()).toHaveLength(frames);

    // Promotion: no reload, the prompt comes back and the controls live.
    flag(m, { spectator: false }, rerender);
    expect(queryByTestId('live-spectator')).toBeNull();
    await waitFor(() => getByTestId('confirm-dialog'));
    expect((getByTestId('live-concede') as HTMLButtonElement).disabled).toBe(false);
    expect((getByTestId('live-full-control') as HTMLButtonElement).disabled).toBe(false);
    expect(fireEvent.dragStart(card)).toBe(true);
  });

  it('spectator: a click on a card Forge offered sends nothing — and does, for the seat’s own window', async () => {
    const { s, m, rerender } = await liveBoard();
    const offeredId = m.view!.players.find((p) => p.isViewer)!.battlefield[0]!.id;
    s.send(selectables([offeredId]));
    await waitFor(() => expect(m.selectables).not.toBeNull());
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

  it('P6: the table and the chat sit inside the header’s own inset, on both sides', () => {
    // jsdom has no layout, so this pins the rules; the boxes are measured in a
    // real browser in `docs/planning/wave31-evidence/p6-boundary.md`.
    const chrome = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/live', '../../chrome/chrome.css'), 'utf8');
    const inset = /\.cardtable-chrome > \.app-header \{[^}]*?margin-inline: ([\d.]+rem)/.exec(chrome)?.[1];
    expect(inset, 'the bar’s own side inset').toBe('2rem');
    const css = liveCss();
    // The content block holds the table and, in a room, watchparty's chat aside
    // (a flex item of a frame 100% of this block): insetting it by the bar's own
    // number moves both.
    expect(declarations(css, '.cardtable-chrome__content:has(.shell--match)')).toContain(`padding-inline: ${inset}`);
    // And the table starts where the content does: no side padding of its own.
    expect(declarations(css, '.shell.shell--match')).toContain('padding: 4px 0 2px');
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
    const css = liveCss();
    expect(css, 'and from the stylesheet').not.toContain('.live__mark');
    expect(declarations(css, '.live__step-name')).toContain('text-align: center');
    expect(declarations(css, '.live__step')).toContain('justify-content: center');

    const rail = declarations(css, '.live__phases');
    expect(rail, 'out of combat: eight rows').toContain('--rail-rows: 8');
    expect(declarations(css, ".live__phases[data-combat]"), 'in combat: thirteen').toContain('--rail-rows: 13');
    expect(rail, 'the height is the rows’ own, up to the 35% of a full turn').toContain('height: calc(var(--rail-chrome) + var(--rail-rows)');
    expect(rail).toContain('transition: height');
    expect(rail, 'still an overlay that takes no pointer events').toContain('pointer-events: none');
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
              [String(deltaKey(WireType.Game, 1))]: {
                _type: WireType.Game,
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

  it('Q16: the question and the dialogs sit on the popover layer, the cluster, log button and rail on the overlay layer', () => {
    const css = liveCss();
    for (const sel of ['.live__prompt', '.live__ask']) {
      expect(declarations(css, sel), sel).toContain('z-index: var(--z-popover, 40)');
    }
    for (const sel of ['.live__buttons', '.live__log-button', '.live__phases']) {
      expect(declarations(css, sel), sel).toContain('z-index: var(--z-overlay, 20)');
    }
  });
});
