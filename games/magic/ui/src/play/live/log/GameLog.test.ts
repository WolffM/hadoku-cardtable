// @vitest-environment jsdom
/*
 * The log panel's own behaviour (`./GameLog.tsx`); what its lines look like is `../LiveBoard.test.ts`'s
 * and the tree they are drawn from `./model.test.ts`'s.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseServerFrame, type GameLogLine, type ServerFrame } from '@hadoku/forge-wire';

import { createReplayPlayer } from '../../../replay/player.ts';
import type { ReplayData, ReplayHeader } from '../../../replay/transport.ts';
import { closeMatch } from '../match.ts';

import type { Say } from '../match.ts';
import { GameLog } from './GameLog.tsx';
import { revealScroll } from './reveal.ts';

afterEach(cleanup);

const say = (text: string, type: GameLogLine['type'], meta: Omit<GameLogLine, 'type' | 'cards'> = {}): Say => ({ text, log: { type, cards: [], ...meta } });

/** Four turns of a land each: the first two fold, the last two are open. */
const SAYS: Say[] = [1, 2, 3, 4].flatMap((turn) => [
  say(`Turn ${turn} (alice)`, 'TURN', { actor: 0, turn, phase: 'UNTAP' }),
  say('alice played Mountain', 'LAND', { actor: 0, phase: 'MAIN1' }),
]);

describe('revealScroll: how far the log scrolls to show what a press opened or closed', () => {
  const box = { top: 100, bottom: 300 };

  it('stays put for a turn wholly in view', () => {
    expect(revealScroll(box, { top: 120, bottom: 280 })).toBe(0);
  });

  it('scrolls down by what ends below the box', () => {
    expect(revealScroll(box, { top: 250, bottom: 360 })).toBe(60);
  });

  it('never scrolls a turn taller than the box past its own header', () => {
    expect(revealScroll(box, { top: 150, bottom: 900 })).toBe(50);
  });

  it('scrolls up to a header left above the box', () => {
    expect(revealScroll(box, { top: 40, bottom: 70 })).toBe(-60);
  });
});

/*
 * The operator, 2026-11-19: *"expanding/collapsing cards in the log is a bit awkward, i would expect
 * it to always scroll to the bottom if the displayed text is offscreen."*
 */
describe('a turn opened in the log is scrolled into view', () => {
  /** jsdom lays nothing out: the scroll box is 100–300, and a turn is where `at` says, by whether it is open. */
  function laidOut(container: HTMLElement, at: (open: boolean) => { top: number; bottom: number }): HTMLElement {
    const scroll = container.querySelector<HTMLElement>('[data-testid="live-log"]')!;
    const rect = (r: { top: number; bottom: number }): DOMRect => ({ ...r, left: 0, right: 0, x: 0, y: r.top, width: 0, height: r.bottom - r.top, toJSON: () => r });
    scroll.getBoundingClientRect = () => rect({ top: 100, bottom: 300 });
    for (const turn of container.querySelectorAll<HTMLElement>('[data-testid="log-turn"]')) {
      turn.getBoundingClientRect = () => rect(at(turn.hasAttribute('data-open')));
    }
    scroll.scrollTop = 500;
    return scroll;
  }
  const head = (container: HTMLElement, index: number): HTMLElement => container.querySelector<HTMLElement>(`[data-log-turn-index="${index}"] button`)!;

  it('opening a turn whose rows end below the box scrolls them into it', () => {
    const { container } = render(createElement(GameLog, { says: SAYS, view: null }));
    const scroll = laidOut(container, (open) => (open ? { top: 270, bottom: 370 } : { top: 270, bottom: 295 }));
    expect(head(container, 0).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head(container, 0));
    expect(head(container, 0).getAttribute('aria-expanded')).toBe('true');
    expect(scroll.scrollTop, 'down by the 70px that ended below the box').toBe(570);
  });

  it('opening a turn that fits where it is moves nothing', () => {
    const { container } = render(createElement(GameLog, { says: SAYS, view: null }));
    const scroll = laidOut(container, () => ({ top: 120, bottom: 200 }));
    fireEvent.click(head(container, 0));
    expect(scroll.scrollTop).toBe(500);
  });

  it('closing a turn whose header was held above its rows keeps the header in the box', () => {
    const { container } = render(createElement(GameLog, { says: SAYS, view: null }));
    const scroll = laidOut(container, (open) => (open ? { top: -200, bottom: 400 } : { top: -200, bottom: -175 }));
    fireEvent.click(head(container, 3));
    expect(head(container, 3).getAttribute('aria-expanded')).toBe('false');
    expect(scroll.scrollTop, 'up to the folded header').toBe(200);
  });
});

/*
 * The operator, 2026-11-21: *"replays show the old name — can we make it so replays keep track of
 * player ids instead of hardcoding player names?"* Forge plays a seat by the name it had when the
 * game began, and writes that name into its own words (a turn's header, a log line, a stack item).
 * A replay names its people as they are now (`GET /api/replays/:id/people`), so those words do too.
 */
describe('a replay names its people as they are now, in Forge\'s own words too', () => {
  const player = (id: number, name: string): Record<string, unknown> => ({
    _type: 1, _id: id, Name: { t: 'str', v: name }, LobbyPlayerName: { t: 'str', v: name }, Life: { t: 'int', v: 20 },
    MaxHandSize: { t: 'int', v: 7 }, MaxLandPlay: { t: 'int', v: 1 }, DraftNotes: { t: 'map', v: [] }, Mana: { t: 'map', v: [] },
  });
  const gameView = {
    268435456: player(0, 'Player 8'),
    268435457: player(1, 'Player 80583'),
    536870919: { _type: 2, _id: 7, Description: { t: 'str', v: 'Ice - Tap Fyndhorn Elves. Player 80583 draws a card.' }, Key: { t: 'str', v: 'Ice (166): Tap target permanent.' }, ActivatingPlayer: { t: 'int', v: 1 } },
    805306369: {
      _type: 3, _id: 1, Players: { t: 'list', v: [{ t: 'int', v: 0 }, { t: 'int', v: 1 }] }, Stack: { t: 'list', v: [{ t: 'int', v: 7 }] },
      GameType: { t: 'enum', c: 'forge.game.GameType', v: 'Constructed' }, Title: { t: 'str', v: 'Player 8 vs Player 80583 (0-0)' }, WinningTeam: { t: 'int', v: -1 }, NumGamesInMatch: { t: 'int', v: 1 }, PoisonCountersToLose: { t: 'int', v: 10 },
    },
  };
  const header: ReplayHeader = { matchId: 'm-renamed', roomId: 'r-1', players: ['Player 8', 'Player 80583'], ai: [false, false], decks: [], art: [], startedAt: '2026-11-21T08:00:00.000Z' };
  const env = (seq: number, frame: ServerFrame) => ({ at: seq * 100, env: { matchId: header.matchId, cursor: { epoch: 'e1', seq }, frame } });
  const message = (message: string, log: Omit<GameLogLine, 'cards'>): ServerFrame => parseServerFrame({ kind: 'notify', method: 'message', message, title: '', log: { cards: [], ...log } }, 'message');
  const data: ReplayData = {
    header,
    envs: [
      env(1, parseServerFrame({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: -1 } }, 'setGameView')),
      env(2, parseServerFrame({ kind: 'notify', method: 'openView', payload: { myPlayers: [0] } }, 'openView')),
      env(3, message('Turn 14 (Player 80583)', { type: 'TURN', actor: 1, turn: 14, phase: 'UNTAP' })),
      env(4, message('Ice - Tap Fyndhorn Elves. Player 80583 draws a card.', { type: 'STACK_RESOLVE', phase: 'MAIN1' })),
      env(5, message('Player 8 played Island', { type: 'LAND', phase: 'MAIN1' })),
    ],
    presence: [],
    relays: [],
    end: {
      endedAt: '2026-11-21T08:55:46.389Z',
      winner: 0,
      seats: [
        { seat: 0, claimed: true, playerId: 0, avatarId: 'mage' },
        { seat: 1, claimed: true, playerId: 1, avatarId: 'dreamer' },
      ],
    },
    people: { 1: { name: 'coffeetraveler' } },
  };

  it('the log, its turn headers and the stack say the name a seat has now, never the one Forge was dealt', () => {
    vi.useFakeTimers();
    const { match, clock } = createReplayPlayer(data);
    clock.play();
    vi.advanceTimersByTime(1000);
    const { container } = render(createElement(GameLog, { says: match.says, view: match.view }));
    const text = container.textContent ?? '';
    expect(text).toContain('coffeetraveler');
    expect(text).toContain('Ice - Tap Fyndhorn Elves. coffeetraveler draws a card.');
    expect(text, 'a seat nobody renamed keeps its name, and a name inside another is never touched').toContain('Player 8 played Island');
    expect(text).not.toContain('80583');
    const stack = match.view?.stack[0];
    expect([stack?.description, stack?.controllerName]).toEqual(['Ice - Tap Fyndhorn Elves. coffeetraveler draws a card.', 'coffeetraveler']);
    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });
});
