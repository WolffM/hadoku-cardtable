// @vitest-environment jsdom
/*
 * game-ui ships the paint for its front page and its seats: every class `RoomFront`, `LobbyShell`,
 * `SeatList` and `SpectatorRow` draw is styled by a stylesheet in this package or in ui-shell, so a
 * game gets a finished page by importing the components, never by copying cardtable's sheets
 * (bomberman's `lobby.css` and `SeatOverlay.css` were exactly those copies). The few classes left
 * to the host are named below with why.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../sound/index.ts', () => ({ playRole: () => undefined }));

import { RoomFront, type RoomFrontClient, type RoomFrontFeed, type RoomFrontRoom } from './RoomFront.tsx';
import { LobbyShell } from './LobbyShell.tsx';
import { SeatList } from '../seats/SeatChip.tsx';
import { SpectatorRow } from '../seats/SpectatorRow.tsx';
import { registerPlayerMark } from '../components/Avatar.tsx';

registerPlayerMark(({ className }) => createElement('svg', { className }));

afterEach(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [resolve(HERE, '..'), resolve(HERE, '../../../ui-shell/src')];

/** Every class some sheet under game-ui's or ui-shell's `src` styles. */
function styledClasses(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.css')) {
        const css = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of css.matchAll(/([^{};]+)\{/g)) for (const c of m[1]!.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(c[1]!);
      }
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

/** Classes these components draw that the host app paints, by design. */
const HOST: Record<string, string> = {
  shell: 'the host’s own screen shell (`LobbyShell.css` adds to it under `lobby-shell`)',
  'shell--fit': 'the host’s own screen shell, fitted to the window',
  'ct-surface': 'not drawn here: a host passes its raised surface as `createPanelClassName`',
  'ct-panel': 'the trim hook: ui-shell’s `trim.css` decorates it only when a trim is chosen',
  'ct-panel__title': 'the trim hook’s title, decorated only when a trim is chosen',
  'ct-error': 'the host’s error-line class, beside `rooms__error` (which this package paints)',
  pill: 'StatusPill’s own block: its paint is still cardtable’s `screens.css`, not this package’s (see the closing report)',
  'pill--ready': 'StatusPill, as above',
  pill__mark: 'StatusPill, as above',
  'hdk-icon': '`@wolffm/themes`’ own icon (the dialog’s close), painted by the themes package',
};

const room = (over: Partial<RoomFrontRoom>): RoomFrontRoom => ({
  id: 'r-1',
  name: 'One',
  gameType: 'toy',
  locked: false,
  members: [{ id: 'm-1', name: 'Ann', avatarId: 'knight' }],
  you: { id: 'm-1' },
  view: { seatsFilled: 1, seatsCapacity: 2, state: { key: 'lobby', label: 'Lobby', detail: 'Waiting' }, primaryAction: 'Join', extraWatch: true },
  ...over,
});

const quiet: RoomFrontFeed = {
  follow(_target, refresh) {
    refresh();
    return () => undefined;
  },
};

function client(rooms: RoomFrontRoom[]): RoomFrontClient<RoomFrontRoom> {
  return {
    list: () => Promise.resolve({ rooms }),
    create: () => Promise.reject(new Error('unused')),
    join: () => Promise.reject(new Error('unused')),
    reset: () => Promise.resolve({ ok: true }),
  };
}

/** Every class token in the document, the portalled dialog included. */
const drawn = (): Set<string> => new Set([...document.querySelectorAll('[class]')].flatMap((el) => [...el.classList]));

function unpainted(): string[] {
  const styled = styledClasses();
  return [...drawn()].filter((c) => !styled.has(c) && HOST[c] === undefined).sort();
}

const mount = (el: ReactElement): void => {
  render(el);
};

describe('the front page’s and the seats’ stylesheets', () => {
  // Any game draws these, and a game has the theme's tokens (`@wolffm/themes`) and nothing else:
  // cardtable's own `--ink`/`--danger` aliases resolve to nothing on bomberman's page.
  it('read the theme’s own tokens and their own hooks, never a host app’s aliases', () => {
    const OWN = /^--(color-|hdk-|z-modal$|room-front-|lobby-shell-|seat-)/;
    const sheets = ['front/RoomFront.css', 'front/LobbyShell.css', 'seats/SeatChip.css'];
    const foreign = sheets.flatMap((rel) =>
      [...readFileSync(resolve(HERE, '..', rel), 'utf8').matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!).filter((name) => !OWN.test(name)).map((name) => `${rel}: ${name}`),
    );
    expect(foreign).toEqual([]);
  });
});

describe('game-ui paints what it draws', () => {
  it('the front page: shell, list, a full row, a testing row, the stale line and the create dialog', async () => {
    mount(
      createElement(LobbyShell, {
        navTools: createElement('span', null, 'tools'),
        disclaimer: 'small print',
        children: createElement(RoomFront<RoomFrontRoom>, {
          rooms: client([
            room({ locked: true }),
            room({ id: 'r-2', testing: true }),
          ]),
          gameTypes: [
            { id: 'toy', label: 'Toy' },
            { id: 'other', label: 'Other' },
          ],
          feed: quiet,
          onOpenRoom: () => undefined,
          rowExtras: () => ({
            scene: createElement('svg'),
            typeIcon: createElement('svg'),
            trophy: createElement('svg'),
            modeChip: createElement('span', { className: 'room-card__mode-chip' }, createElement('span', { className: 'room-card__mode-text' }, 'Mode')),
            seriesChip: createElement('span', { className: 'room-card__series-chip' }, 'Bo3'),
            legacyMeta: 'streamed',
          }),
        }),
      }),
    );
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));
    screen.getByTestId('room-create-open').click();
    await waitFor(() => expect(screen.getByTestId('room-create')).toBeTruthy());
    expect(unpainted()).toEqual([]);
  });

  it('the seats: open, closed, the bot, a member with every action, and the spectators', () => {
    mount(
      createElement('div', null, [
        createElement(SeatList, {
          key: 'seats',
          slots: [
            { seat: 0, occupant: { kind: 'member', id: 'm-1', name: 'Ann', ready: true, leader: true, mine: true } },
            { seat: 1, occupant: { kind: 'member', id: 'm-2', name: 'Bo', ready: false, leader: false, mine: false } },
            { seat: 2, occupant: { kind: 'bot', name: 'Knight' } },
            { seat: 3, occupant: { kind: 'closed' } },
            { seat: 4, occupant: { kind: 'open' } },
          ],
          iLead: true,
          realSeatCount: 5,
          mySeat: 0,
          onRemoveMember: () => undefined,
          onBotReplace: () => undefined,
          onMakeLeader: () => undefined,
        }),
        createElement(SpectatorRow, {
          key: 'spectators',
          spectators: [{ id: 'm-3', name: 'Cy' }],
          myId: 'm-1',
          leaderId: 'm-3',
          under: true,
          onWatch: () => undefined,
          onMakeLeader: () => undefined,
        }),
      ]),
    );
    expect(unpainted()).toEqual([]);
  });
});
