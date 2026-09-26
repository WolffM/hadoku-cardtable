// @vitest-environment jsdom
/*
 * The live board in a DOM: a real server replaying a real game, a real
 * socket, and a person's click on the confirm dialog travelling back to the
 * server as the reply Forge is waiting on.
 *
 * Every wait is RTL's `waitFor`, because the updates come from socket events
 * outside React's `act` — `waitFor` is what makes that legitimate.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ComponentType } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { parseServerFrame } from '@hadoku/forge-wire';

import { PROMPT_FIXTURES, askFor } from '../prompts/fixtures.ts';
import { PROMPT_COMPONENTS, PROMPT_METHODS } from '../prompts/index.ts';

import { isMatchGone, LiveBoard, liveStatus, refusalOf, type LiveStatus } from './LiveBoard.tsx';
import {
  answerAsk,
  closeMatch,
  currentAsk,
  pressButton,
  selectCard,
  socketIoMatchTransport,
  startMatch,
  type LiveMatch,
  type MatchTransport,
} from './match.ts';
import { confirmAsk, fixtureFrames, startReplayServer, type ReplayServer } from './replay-server.ts';
import { parseMatchAck } from './transport.ts';

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;

afterEach(async () => {
  cleanup();
  if (match !== null) closeMatch(match);
  match = null;
  if (server !== null) await server.close();
  server = null;
});

async function liveBoard(playerId = 0) {
  const s = (server = await startReplayServer({ playerId }));
  const m = (match = startMatch({
    matchId: s.matchId,
    transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
  }));
  const utils = render(createElement(LiveBoard, { match: m }));
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
  await waitFor(() => expect(utils.getByTestId('turn').textContent).toBe('Turn 14'));
  return { s, m, ...utils };
}

/**
 * Every row of text the board draws ABOUT ITSELF, in DOM order — the status
 * line and, while the board is live, the error line. `LiveBoard` marks them
 * with `data-live-line`, and three of these at once is the bug §F.2 names.
 */
const lines = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-live-line]')].map((el) => el.textContent ?? '');

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
    expect(queryByTestId('turn')).toBeNull();

    const frames = fixtureFrames();
    s.send(frames[0]!);
    await waitFor(() => expect(getByTestId('turn')).toBeTruthy());
    for (const f of frames.slice(1)) s.send(f);
    await waitFor(() => expect(getByTestId('turn').textContent).toBe('Turn 14'));
    expect(getByTestId('phase').textContent).toBe('Main 1');
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
    const { container, getByTestId } = await liveBoard(0);
    const viewer = container.querySelector<HTMLElement>('[data-viewer]')!;
    expect(viewer.dataset.playerId).toBe('0');
    expect(getByTestId('live-status').textContent).toBe('Seat 1, live.');
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
    await waitFor(() => expect(getByTestId('turn')).toBeTruthy());
    const turnBefore = getByTestId('turn').textContent;

    s.send(askFor('getChoices'));
    await waitFor(() => getByTestId('live-prompt'));
    const red = () => container.querySelector<HTMLInputElement>('[data-testid="prompt-choice"][data-key="red"]')!;
    fireEvent.click(red());
    expect(red().checked).toBe(true);

    // The rest of the game arrives with the question open.
    for (const f of frames.slice(8)) s.send(f);
    await waitFor(() => expect(getByTestId('turn').textContent).toBe('Turn 14'));
    expect(turnBefore).not.toBe('Turn 14');
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
    const { s, m, getByTestId } = await liveBoard();

    for (const f of buttonFrames('Choose', 'OK', 'Cancel')) s.send(f);
    await waitFor(() => expect((getByTestId('live-button-ok') as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(getByTestId('live-button-ok'));
    // The bar stays where it is; its buttons go disabled until Forge sends a fresh one.
    await waitFor(() => expect((getByTestId('live-button-ok') as HTMLButtonElement).disabled).toBe(true));
    expect(getByTestId('live-buttons')).toBeTruthy();
    expect((getByTestId('live-button-cancel') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(getByTestId('live-button-ok'));
    expect(pressButton(m, 'ok')).toBe(false);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(m.stats.replies).toBe(1);
  });

  it('the bar is there before Forge has sent one: neutral labels, both buttons disabled, nothing said', async () => {
    const { getByTestId } = await liveBoard();
    expect(getByTestId('live-says').textContent).toBe('');
    const ok = getByTestId('live-button-ok') as HTMLButtonElement;
    const cancel = getByTestId('live-button-cancel') as HTMLButtonElement;
    expect([ok.textContent, cancel.textContent, ok.disabled, cancel.disabled]).toEqual(['OK', 'Cancel', true, true]);
  });

  it('the bar stays while a question is open, disabled, and a press sends nothing', async () => {
    const { s, m, getByTestId } = await liveBoard();
    for (const f of buttonFrames('Priority', 'OK', 'End Turn')) s.send(f);
    await waitFor(() => expect((getByTestId('live-button-ok') as HTMLButtonElement).disabled).toBe(false));

    s.send(confirmAsk('c-open'));
    await waitFor(() => getByTestId('confirm-dialog'));
    const ok = getByTestId('live-button-ok') as HTMLButtonElement;
    expect([ok.disabled, (getByTestId('live-button-cancel') as HTMLButtonElement).disabled]).toEqual([true, true]);
    expect(getByTestId('live-button-cancel').textContent).toBe('End Turn');
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
 * Dragging, and the targeter arrow (Wave 19 §B items 2 and 3).
 *
 * Every assertion here is about WHAT WAS SENT — the frames that left through
 * `selectCard` / `selectPlayer` and reached the replay server — not about what
 * was drawn. The arrow has two assertions of its own and they are about
 * existence and snapping, because a picture is not a proof that the right
 * thing happened.
 *
 * The overlay root is lane A's (`[data-board-overlay]`). These tests add one
 * by hand where they need it, and the case that does NOT is the guard: with no
 * overlay the arrow is not drawn and the drag still sends.
 *
 * jsdom has no layout, so every `getBoundingClientRect` is zeroes and the
 * arrow's geometry is all 0 — which is why nothing here asserts a coordinate.
 * What it does assert is which element the arrow snapped to, and that is read
 * off the DOM, not off a number.
 */
describe('dragging a card, and the targeter arrow', () => {
  function notify(raw: unknown[]) {
    return raw.map((r) => parseServerFrame(r));
  }
  const prompt = (message: string) =>
    parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: null });
  const actionable = (ids: number[]) =>
    parseServerFrame({ kind: 'notify', method: 'setWeaklySelectable', cards: ids.map((id) => ({ kind: 'card', id })) });
  const selectables = (ids: number[], min: number, max: number) =>
    parseServerFrame({ kind: 'notify', method: 'setSelectables', cards: ids.map((id) => ({ kind: 'card', id })), min, max });

  /**
   * Lane A's overlay root. It is theirs to render, so this looks for it and
   * only falls back to one of its own if the contract is not met yet — which
   * keeps these cases independent of their landing order.
   */
  function overlayOf(container: HTMLElement): HTMLElement {
    const found = container.querySelector<HTMLElement>('[data-board-overlay]');
    if (found !== null) return found;
    const made = document.createElement('div');
    made.setAttribute('data-board-overlay', '');
    container.querySelector('.live')!.appendChild(made);
    return made;
  }

  const cardEl = (c: HTMLElement, id: number) => c.querySelector<HTMLElement>(`[data-board-card="${id}"]`)!;
  const faceEl = (c: HTMLElement, id: number) => c.querySelector<HTMLElement>(`[data-player-face][data-player-id="${id}"]`)!;

  /** Press on `from`, move over `over`, release there. Past the slop, so it is a drag. */
  function drag(from: HTMLElement, over: HTMLElement): void {
    fireEvent.pointerDown(from, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(over, { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(over, { clientX: 200, clientY: 140 });
  }

  /** What actually left this client, as `[method, id]` pairs. The whole point of these tests. */
  const sent = (s: ReplayServer): unknown[] =>
    s.clientFrames().map((f) => {
      if (!f.ok || f.value.kind !== 'act') return f;
      const act = f.value;
      if (act.method === 'selectCard') return ['selectCard', act.card.id];
      if (act.method === 'selectPlayer') return ['selectPlayer', act.player.id];
      return [act.method];
    });

  it('a drag from a card Forge offered onto the opponent’s seat sends selectCard then selectPlayer', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const [source, other] = [mine[0]!, mine[1]!];
    // A selection Forge wants TWO of, so the source is sent as well as the drop.
    for (const f of notify([prompt('Choose two'), selectables([source, other], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    drag(cardEl(container, source), faceEl(container, 1));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
    expect(sent(s)).toEqual([
      ['selectCard', source],
      ['selectPlayer', 1],
    ]);
  });

  it('a drag from one offered card onto another sends both, in order', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const [source, target] = [mine[0]!, mine[1]!];
    for (const f of notify([prompt('Choose two'), selectables([source, target], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    drag(cardEl(container, source), cardEl(container, target));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
    expect(sent(s)).toEqual([
      ['selectCard', source],
      ['selectCard', target],
    ]);
  });

  it('Forge wants ONE thing: the drop is what the player pointed at, and it is the only frame sent', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const [source, target] = [mine[0]!, mine[1]!];
    for (const f of notify([prompt('Choose a target'), selectables([source, target], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables!.max).toBe(1));

    drag(cardEl(container, source), cardEl(container, target));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', target]]);
  });

  it('a drag of a card Forge did not offer does nothing and says nothing', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const theirs = m.view!.players.find((p) => !p.isViewer)!.battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    // The opponent's card is not offered — dragged to the stack (the one
    // zone no seat owns, so nothing is under it) or off the board entirely,
    // it sends nothing. A drop inside a seat WOULD point at that player;
    // that is the pointing gesture, and it has its own test below.
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    drag(cardEl(container, theirs[0]!), stack);
    drag(cardEl(container, theirs[0]!), document.body);
    expect(m.lastError).toBeNull();
    expect(container.querySelector('[data-testid="live-error"]')).toBeNull();
    expect(s.clientFrames()).toHaveLength(0);

    // Proven against a barrier: the next legitimate act must be the FIRST
    // frame the server sees, so a refused drag cannot be hiding behind a wire.
    fireEvent.click(cardEl(container, mine[0]!).querySelector('button')!);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('inside a selection, an offered card dropped where nothing is offered is used — a spell drags out of its own target ask', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const theirs = m.view!.players.find((p) => !p.isViewer)!.battlefield.map((c) => c.id);
    // Forge is asking for a target (the spell's own ask) and has named the
    // spell among the candidates. The drag lands on an unoffered card in a
    // zone — `targetUnder` stops at that card and names nothing — so the drop
    // is the card's own click: one selectCard for the source, nothing else.
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!, mine[1]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    drag(cardEl(container, mine[0]!), cardEl(container, theirs[0]!));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);

    // And a drop outside every zone still does nothing and says nothing.
    drag(cardEl(container, mine[1]!), document.body);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(1);
  });

  it('outside a selection, a drop on the table is the one frame a click sends — and it is not sent twice', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await waitFor(() => expect(m.weaklySelectable).not.toBeNull());

    const zone = container.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    drag(cardEl(container, mine[0]!), zone);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('a press that does not move is still a click, and sends exactly once', async () => {
    const { s, m, container } = await liveBoard();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await waitFor(() => expect(m.weaklySelectable).not.toBeNull());

    const face = cardEl(container, mine[0]!).querySelector<HTMLButtonElement>('button')!;
    fireEvent.pointerDown(face, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(face, { clientX: 12, clientY: 11 });
    fireEvent.pointerUp(face, { clientX: 12, clientY: 11 });
    fireEvent.click(face);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('the arrow is drawn into lane A’s overlay and snaps to the legal target under the pointer', async () => {
    const { s, m, container } = await liveBoard();
    const overlay = overlayOf(container);
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    const theirs = m.view!.players.find((p) => !p.isViewer)!.battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull();
    fireEvent.pointerDown(cardEl(container, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    // Over nothing in particular: the arrow follows the pointer, unsnapped.
    fireEvent.pointerMove(cardEl(container, theirs[0]!), { clientX: 120, clientY: 90 });
    const arrow = await waitFor(() => overlay.querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.source).toBe(String(mine[0]));
    expect(arrow.dataset.target).toBeUndefined();
    expect(arrow.dataset.snapped).toBeUndefined();
    expect(arrow.querySelector('line')).not.toBeNull();
    expect(arrow.querySelector('polygon')).not.toBeNull();

    // Over a card Forge DID offer: it snaps.
    fireEvent.pointerMove(cardEl(container, mine[1]!), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(overlay.querySelector<SVGElement>('[data-testid="targeter"]')!.dataset.target).toBe(`card:${mine[1]}`));
    expect(overlay.querySelector<SVGElement>('[data-testid="targeter"]')!.dataset.snapped).toBe('true');

    fireEvent.pointerUp(cardEl(container, mine[1]!), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull());
    expect(sent(s)).toEqual([
      ['selectCard', mine[0]!],
      ['selectCard', mine[1]!],
    ]);
  });

  it('with no overlay root the arrow is not drawn, and the drag still sends', async () => {
    const { s, m, container } = await liveBoard();
    // Lane A owns the overlay; a board drawn without one must still be
    // playable, so take it away and drive the same gesture.
    container.querySelector('[data-board-overlay]')?.remove();
    expect(container.querySelector('[data-board-overlay]')).toBeNull();
    const mine = m.view!.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose two'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    fireEvent.pointerDown(cardEl(container, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(cardEl(container, mine[1]!), { clientX: 200, clientY: 140 });
    expect(document.querySelector('[data-testid="targeter"]')).toBeNull();
    fireEvent.pointerUp(cardEl(container, mine[1]!), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
    expect(sent(s)).toEqual([
      ['selectCard', mine[0]!],
      ['selectCard', mine[1]!],
    ]);
  });

  it('a pointing gesture inside a selection needs no source: the drop alone is sent', async () => {
    const { s, m, container } = await liveBoard();
    const theirs = m.view!.players.find((p) => !p.isViewer)!.battlefield.map((c) => c.id);
    // Forge offers only the opponent's creature — nothing of the viewer's to
    // drag from, which is the ordinary shape of a targeting input.
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]') ?? container.querySelector<HTMLElement>('.board')!;
    fireEvent.pointerDown(stack, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(faceEl(container, 1), { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(faceEl(container, 1), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectPlayer', 1]]);
  });
});

/*
 * The says, the full-control toggle, and the ability label — Wave 19's §C
 * items as they reach the player's eyes. All three assert on the WIRE (what
 * `s.received` / `s.clientFrames()` hold) or on the text drawn, never on
 * internals.
 */
describe('the says, the toggle, and the ability label', () => {
  const says = (text: string) => parseServerFrame({ kind: 'notify', method: 'message', message: text, title: '' });

  it('draws the newest two says in a slot that is there before any arrive', async () => {
    const { s, container } = await liveBoard();
    const log = container.querySelector('[data-testid="live-log"]')!;
    expect(log.querySelectorAll('li')).toHaveLength(0); // the slot, empty, not gone

    for (const f of [says('auto-passed Upkeep step'), says('paid U — Volcanic Island'), says('auto-passed Draw step')]) {
      s.send(f);
    }
    await waitFor(() => expect(log.querySelectorAll('li')).toHaveLength(2));
    expect([...log.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
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
    const utils = render(createElement(LiveBoard, { match: m, onLeave: () => {} }));
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

  it('live: the seat and nothing else — the string three playwright specs wait on', async () => {
    const { m, container, queryByTestId } = await liveBoard();
    only(container, m, 'live', 'Seat 1, live.');
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
    only(container, m, 'match-gone', 'Match gone.');
    // The operator's three, as they were: the refusal, the seat line and the
    // waiting line. Exactly one of them is drawn now, and it is none of them.
    expect(container.textContent).not.toContain('Connected, not seated.');
    expect(container.textContent).not.toContain('Waiting for the game state.');
    expect(container.textContent).not.toContain('was refused');
    expect(queryByTestId('live-error')).toBeNull();
    // A state, and where it can be acted on: the bar's Leave says so.
    expect(getByTestId('live-leave').dataset.urgent).toBe('true');
    expect(getByTestId('live-status').title).toContain('unknown-match');
  });

  it('match-gone, from lane E’s ACTUAL ack: the outcome and the sentence do not make it malformed', () => {
    const { stub, m, container, queryByTestId, getByTestId } = stubBoard();
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
    only(container, m, 'match-gone', 'Match gone.');
    expect(container.textContent).not.toContain('is not a snapshot');
    expect(queryByTestId('live-error')).toBeNull();
    expect(getByTestId('live-leave').dataset.urgent).toBe('true');
  });

  it('a gone match that the socket then drops is still gone, not connecting', () => {
    const { stub, m, container } = stubBoard();
    act(() => stub.fire('connect'));
    act(() => stub.answer({ error: 'unknown-match' }));
    act(() => stub.fire('disconnect'));
    expect(m.connected).toBe(false);
    only(container, m, 'match-gone', 'Match gone.');
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
    expect(lines(container)).toEqual([
      'Seat 1, live.',
      'refused to send an answer to showConfirmDialog that fails its wire schema',
    ]);
    expect(getByTestId('live-error')).toBeTruthy();
    expect(s.clientFrames()).toEqual([]);
  });
});

/*
 * §F.1 — Leave, moved off the floor.
 *
 * *"'Leave the match' button is in a really weird spot, why is it below the
 * game canvas?"* It is in the bar now. What these assert is where it sits in
 * the DOM, that a keyboard can reach it, and that it is not inside the canvas —
 * the canvas boxes are lane C's and this lane may not move one.
 */
describe('Leave is with the match controls', () => {
  it('is a button in the bar, first in it, and not inside the board', async () => {
    const { container, getByTestId } = await liveBoard();
    const leave = getByTestId('live-leave');
    const bar = getByTestId('live-buttons');
    expect(leave.tagName).toBe('BUTTON');
    expect(bar.contains(leave)).toBe(true);
    // First in the bar: the far end from OK and Cancel, so a reach for Leave
    // is never a misclick on Forge's answer.
    expect(bar.firstElementChild).toBe(leave);
    expect(container.querySelector('.board')!.contains(leave)).toBe(false);
    // And the bar is still a sibling of the board, drawn after it: the chrome
    // is around the canvas, not in it.
    const live = container.querySelector('.live')!;
    expect([...live.children].map((el) => el.className)).toEqual(['live__status', 'board', 'live__buttons']);
  });

  it('a keyboard reaches it, and a press leaves', async () => {
    let left = 0;
    const s = (server = await startReplayServer());
    const m = (match = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    }));
    const { getByTestId } = render(
      createElement(LiveBoard, {
        match: m,
        onLeave: () => {
          left += 1;
        },
      }),
    );
    const leave = getByTestId('live-leave') as HTMLButtonElement;
    expect(leave.disabled).toBe(false);
    expect(leave.tabIndex).toBe(0);
    leave.focus();
    expect(document.activeElement).toBe(leave);
    // The Enter a focused button takes is a click; fire what the browser fires.
    fireEvent.click(leave);
    expect(left).toBe(1);
    // It is not one of Forge's answers: nothing left over the wire.
    expect(s.clientFrames()).toEqual([]);
  });

  it('is pressable with a question open — leaving is not an answer', async () => {
    const { s, getByTestId } = await liveBoard();
    s.send(confirmAsk('c-leave', true));
    await waitFor(() => getByTestId('confirm-dialog'));
    expect((getByTestId('live-leave') as HTMLButtonElement).disabled).toBe(false);
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
