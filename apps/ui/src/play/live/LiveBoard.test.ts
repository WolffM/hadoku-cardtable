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

import type { BoardInteraction } from '../Board.tsx';
import type { BoardView } from '../adapter.ts';
import { deltaKey, WireType } from '../wire.ts';
import { PROMPT_FIXTURES, askFor } from '../prompts/fixtures.ts';
import { PROMPT_COMPONENTS, PROMPT_METHODS } from '../prompts/index.ts';

import { isMatchGone, LiveBoard, liveStatus, refusalOf, type LiveStatus } from './LiveBoard.tsx';
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
import { confirmAsk, fixtureFrames, startReplayServer, type ReplayServer } from './replay-server.ts';
import { parseMatchAck } from './transport.ts';

/*
 * `Board` is mocked to CAPTURE the props it is handed and then render the real
 * component. Two things need that and nothing else in this file is affected:
 * the interaction contract lane A reads (`selectionOpen`, `declaringAttackers`)
 * is a set of BOOLEANS, and asserting them off the DOM would be asserting what
 * lane A drew rather than what this component handed over. Every other case
 * here still renders the real board, because the wrapper delegates to it.
 */
const captured = vi.hoisted(() => ({ interaction: null as BoardInteraction | null }));
vi.mock('../Board.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Board.tsx')>();
  return {
    ...actual,
    Board: (props: { view: BoardView; interaction: BoardInteraction }) => {
      captured.interaction = props.interaction;
      return createElement(actual.Board, props);
    },
  };
});

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
    // And the cluster is still a sibling of the board, drawn after it: the
    // chrome is around the canvas, not in it. Wave 24 added the phase rail
    // between them and wave 25 the logbook, and both are siblings for the same
    // reason.
    const live = container.querySelector('.live')!;
    expect([...live.children].map((el) => el.className)).toEqual([
      'live__status',
      'board',
      'live__phases',
      'live__logbook',
      'live__buttons',
    ]);
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
    for (const id of ['live-button-ok', 'live-button-cancel', 'live-leave', 'live-full-control', 'live-concede', 'live-log-toggle']) {
      expect(cluster.querySelector(`[data-testid="${id}"]`), `the cluster still holds ${id}`).not.toBeNull();
    }
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
    // grows, which is the other half of "one box at one window size".
    expect([...cluster.children].map((el) => el.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON', 'BUTTON', 'BUTTON', 'BUTTON']);
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
    // Bounded against `.live`, so an overfull panel clips instead of growing the
    // match's scroll box — which the fit spec reads as a breach.
    expect(decls).toContain('max-height: calc(100% - 12px)');
    expect(decls).toContain('overflow: hidden');
    // Under lane A's overlay root at z 2, like the rail.
    expect(decls).toContain('z-index: 1');
  });

  it('is out of the flow in the bottom-right corner, so the table has the height back', () => {
    const decls = declarations(liveCss(), '.live__buttons');
    expect(decls).toContain('position: absolute');
    expect(decls).toContain('right: 6px');
    expect(decls).toContain('bottom: 6px');
    expect(decls).toContain('width: var(--live-controls-w)');
    expect(decls).toContain('height: var(--live-controls-h)');
    // No full-width bar remains: the token that gave the row under the canvas
    // its height is gone from the file, not merely unused.
    expect(liveCss()).not.toContain('--live-bar-h');
  });

  it('every slot in it is a fixed track, so one window size can never see two boxes', () => {
    const css = liveCss();
    const cluster = declarations(css, '.live__buttons');
    // A track sized by its content is exactly how the box changes between
    // frames — a longer button label from Forge.
    expect(cluster).toContain('grid-template-columns: repeat(6, 1fr)');
    expect(cluster).toContain('grid-template-rows: 30px 26px minmax(22px, 1fr)');
    // So what overflows clips inside its own slot.
    expect(declarations(css, '.live__buttons button')).toContain('text-overflow: ellipsis');
    // The row that was sized by Forge's own words is gone from the grid
    // altogether (§C.1); the `log` area that remains is the TOGGLE's, a button.
    expect(cluster, 'no says row in the cluster').not.toContain('says');
    expect(declarations(css, '.live__buttons .live__logbook-toggle')).toContain('grid-area: log');
    // The text is capped in the logbook instead, where the height is not the
    // cluster's to lose.
    expect(declarations(css, '.live__says')).toContain('overflow: auto');
    expect(declarations(css, '.live__log')).toContain('overflow: hidden');
    // The sizes resolve on `.live` itself, so the dev harness — which mounts it
    // with no shell — gets a fixed box too. A `var()` with no value is an
    // invalid declaration and the cluster would fall back to content size.
    const live = declarations(css, '.live');
    for (const token of ['--live-controls-h:', '--live-controls-w:', '--live-rail-w:']) {
      expect(live, `${token} is defined on .live`).toContain(token);
    }
  });

  /*
   * The invariant two other things rest on, and it was wrong once.
   *
   * `--live-controls-h` is the cluster's `height` AND what the prompt host
   * subtracts to find the room above it. The cluster's tracks are pixels, so
   * the token has to be their sum. It was `9.75rem`, which is that sum at a
   * 16px root font size and nothing else — measured in Chrome, the tracks that
   * needed 153px got 136px at a 14px root and 195px at 20px. So the token is
   * pixels, and this adds them up rather than trusting a literal.
   *
   * Wave 25 §C took two 34px text rows and a gap out, so the sum is 102.
   */
  it('the height token is the exact sum of the cluster’s own tracks, in pixels', () => {
    const css = liveCss();
    const cluster = declarations(css, '.live__buttons');
    const rows = /grid-template-rows: ([^;]+);/.exec(cluster)?.[1];
    expect(rows, 'the cluster declares explicit rows').toBeDefined();
    // `minmax(22px, 1fr)` contributes its 22px floor; nothing here is content-sized.
    const tracks = [...rows!.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
    expect(tracks).toEqual([30, 26, 22]);
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
      '6 + 6 padding + 1 + 1 border + (30 + 26 + 22) rows + 2 × 5 gaps = 102',
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

  it('draws Forge’s thirteen steps and names only the one the game is on', async () => {
    const { container, getByTestId } = await liveBoard();
    const all = steps(container);
    expect(all).toHaveLength(13);
    const current = all.filter((el) => el.hasAttribute('data-current'));
    expect(current).toHaveLength(1);
    // The same phase the turn bar says, and our own word for it.
    expect(current[0]!.dataset.phase).toBe('MAIN1');
    expect(current[0]!.getAttribute('aria-current')).toBe('step');
    expect(current[0]!.textContent).toBe(getByTestId('phase').textContent);
    // A turn in progress: the steps before it are past, the ones after are not.
    const at = all.indexOf(current[0]!);
    expect(all.slice(0, at).every((el) => el.hasAttribute('data-past'))).toBe(true);
    expect(all.slice(at).some((el) => el.hasAttribute('data-past'))).toBe(false);
  });

  it('every step keeps its name for a screen reader, drawn or not', async () => {
    const { container } = await liveBoard();
    expect(steps(container).map((el) => el.textContent)).toEqual([
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
  });

  it('says which turn and whose, off the view and nothing else', async () => {
    const { m, getByTestId } = await liveBoard();
    const view = m.view!;
    const active = view.players.find((p) => p.id === view.activePlayerId);
    const whose = active === undefined ? 'nobody' : active.isViewer ? 'yours' : 'theirs';
    expect(getByTestId('live-phases').dataset.whose).toBe(whose);
    expect(getByTestId('live-turn').textContent).toBe(`${view.turn}${whose}`);
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
    expect(decls).toContain('z-index: 1');
  });

  /*
   * §C.4 — the operator put the rail on the RIGHT. It was already vertically
   * centred, so the anchor is all that changes here; the part that is easy to
   * miss is the current step's NAME, which hangs out of the rail and would run
   * off the window if it still hung to the right.
   */
  it('anchors to the right edge, and the current step’s name hangs inwards from it', () => {
    const css = liveCss();
    const rail = declarations(css, '.live__phases');
    expect(rail).toContain('right: 2px');
    expect(rail, 'no left anchor is left behind').not.toContain('left:');
    // Still vertically centred: that was already right and nothing here moves it.
    expect(rail).toContain('top: 50%');
    expect(rail).toContain('translate: 0 -50%');
    const name = declarations(css, '.live__step-name');
    expect(name).toContain('right: calc(100% + 4px)');
    expect(name, 'the name does not hang off the right edge of the window').not.toContain('left:');
  });
});

/*
 * §C.3 — a prompt belongs where the player is looking.
 *
 * Teetering Peaks' ask *"appeared as text at the bottom of the screen"*. Where
 * it sits is this lane's; what it looks like inside is lane D's.
 */
describe('a prompt belongs where the player is looking', () => {
  it('the host is the room ABOVE the controls, with the sheet centred in it', () => {
    const decls = declarations(liveCss(), '.live__prompt');
    expect(decls).toContain('inset: 0 8px calc(var(--live-controls-h) + 16px)');
    expect(decls).toContain('align-items: center');
    expect(decls).toContain('justify-content: center');
    // Not pinned to an edge any more — that was the bug.
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
    expect([...container.querySelector('.live')!.children].map((el) => el.className)).toEqual([
      'live__status',
      'board',
      'live__phases',
      'live__logbook',
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
    // The whole claim: the payment is IN the centred sheet the other questions
    // use, not in a line in the corner.
    const host = getByTestId('live-payment-host');
    expect(host.contains(sheet)).toBe(true);
    expect(host.className).toBe('live__prompt');
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

