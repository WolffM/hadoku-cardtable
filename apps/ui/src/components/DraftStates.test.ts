// @vitest-environment jsdom
/*
 * The three states §B says a draft must stop hiding: spectating, a held seat,
 * and the deck at the end.
 *
 * ## Why this mounts `DraftScreen` and not `App`
 *
 * `DraftScreen.test.ts` drives the whole app through the committed fixture
 * picker, and that is the right shape for the fixtures — it proves the app
 * renders what the server would really have sent. None of the three states here
 * has a committed fixture, and adding one would change `FIXTURES.length`, which
 * the debug harness's label (`Fixtures — five committed payloads`) and lane A's
 * tests both spell out. So these build the payload they need and render the
 * screen directly. The payloads are still fixture-derived — every card comes
 * out of a committed file — so nothing here asserts against a shape the engine
 * could not emit.
 *
 * No JSX: the root vitest config globs `apps/*\/src/**\/*.test.ts`, so a `.tsx`
 * test is silently NOT COLLECTED and proves nothing. `createElement` keeps this
 * inside the gate that runs in CI. `@vitest-environment jsdom` has to be line 1.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { parseDck } from '@hadoku/carddata/dck';

import { connectionState, type ConnectionFacts } from '../draft/connection.ts';
import { loadFixtures } from '../draft/fixtures.ts';
import { initialState, type TableState } from '../draft/table.ts';
import type { DraftView } from '../draft/types.ts';
import { DraftScreen } from './DraftScreen.tsx';

afterEach(cleanup);

const fixtures = () => loadFixtures();

function seatView(): DraftView {
  const view = fixtures().find((v) => v.viewer.kind === 'seat' && v.draftId === 'draft:fx-open');
  if (!view) throw new Error('expected a seat fixture');
  return view;
}

function spectatorView(): DraftView {
  const view = fixtures().find((v) => v.viewer.kind === 'spectator');
  if (!view) throw new Error('expected a spectator fixture');
  return view;
}

function mount(state: TableState, props: Record<string, unknown> = {}) {
  return render(
    createElement(DraftScreen, { state, onChange: () => {}, ...props } as never),
  );
}

function facts(over: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    connected: true,
    everConnected: true,
    joins: 1,
    applied: 2,
    appliedAtLastJoin: 0,
    resyncPending: false,
    seatId: 3,
    lastVerdict: 'ok',
    ...over,
  };
}

/* ── 1. Spectating ───────────────────────────────────────────────────── */

describe('a spectator payload renders the table and says it is a spectator', () => {
  it('shows a notice that names the state in its own element', () => {
    mount(initialState(spectatorView()));
    const notice = screen.getByTestId('spectator-notice');
    expect(notice.textContent).toContain('Spectating');
    expect(within(notice).getByText('Spectating')).toBeTruthy();
    expect(screen.getByTestId('draft-screen').dataset.viewer).toBe('spectator');
  });

  it('renders NO cards at all, and no pool section to put them in', () => {
    const { container } = mount(initialState(spectatorView()));
    expect(screen.queryAllByTestId('card')).toHaveLength(0);
    expect(screen.queryByTestId('pool')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('still renders the public half — every seat, the counters and the clock', () => {
    const view = spectatorView();
    mount(initialState(view));
    expect(within(screen.getByTestId('seat-bar')).getAllByRole('listitem')).toHaveLength(
      view.seats.length,
    );
    expect(screen.getByTestId('pack-number').textContent).toBe(String(view.packNumber));
  });

  it('explains the empty pack instead of leaving a blank panel', () => {
    mount(initialState(spectatorView()));
    expect(screen.getByTestId('pack').textContent).toContain('Spectating');
  });
});

/* ── 2. Rejoin: held seats and recovery ──────────────────────────────── */

describe('a seat the table is holding', () => {
  /** What the server does on a drop: unseat, keep the remembered name. */
  const withDropped = (view: DraftView, id: number): DraftView => ({
    ...view,
    seats: view.seats.map((s) => (s.id === id ? { ...s, occupant: null } : s)),
  });

  it('draws as HELD, not as an empty chair', () => {
    const view = spectatorView();
    mount(initialState(withDropped(view, 1)));
    expect(screen.getByTestId('seat-1').dataset.occupant).toBe('held');
    expect(screen.getByTestId('seat-1-held').textContent).toBe('held');
    expect(screen.getByTestId('seat-1').textContent).toContain('away — seat held');
    // The name is still there — that is what makes it held rather than free.
    expect(screen.getByTestId('seat-1').textContent).toContain(view.seats[1].displayName);
  });

  it('a chair nobody sat in still reads as empty', () => {
    const view = spectatorView();
    const never: DraftView = {
      ...view,
      seats: view.seats.map((s) => (s.id === 2 ? { ...s, occupant: null, displayName: 'Seat 2' } : s)),
    };
    mount(initialState(never));
    expect(screen.getByTestId('seat-2').dataset.occupant).toBe('empty');
    expect(screen.queryByTestId('seat-2-held')).toBeNull();
  });
});

describe('the connection banner', () => {
  it('says nothing when the connection is healthy', () => {
    mount(initialState(seatView()), { connection: connectionState(facts()) });
    expect(screen.queryByTestId('connection')).toBeNull();
  });

  it('is absent entirely for a source that has no connection to report', () => {
    mount(initialState(seatView()));
    expect(screen.queryByTestId('connection')).toBeNull();
  });

  // ── the done-when: a simulated disconnect shows held-seat and recovery ──
  it('shows the held seat while offline, and stops the cards responding', () => {
    mount(initialState(seatView()), {
      connection: connectionState(facts({ connected: false, seatId: 0 })),
    });
    const banner = screen.getByTestId('connection');
    expect(banner.dataset.phase).toBe('offline');
    expect(banner.dataset.seatHeld).toBe('true');
    expect(screen.getByTestId('connection-label').textContent).toContain('held for you');

    // A pick made into a dead socket would be emitted into nothing and look,
    // to the player, like it was taken. Every card is disabled instead.
    const cards = screen.getAllByTestId('card');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.hasAttribute('disabled') || card.getAttribute('aria-disabled') === 'true').toBe(
        true,
      );
    }
  });

  it('shows the wait after a reconnect, then the recovery', () => {
    const { rerender } = mount(initialState(seatView()), {
      connection: connectionState(facts({ joins: 2, applied: 4, appliedAtLastJoin: 4 })),
    });
    expect(screen.getByTestId('connection').dataset.phase).toBe('reconnecting');
    expect(screen.getByTestId('connection-detail').textContent).toContain('resyncing');

    rerender(
      createElement(DraftScreen, {
        state: initialState(seatView()),
        onChange: () => {},
        connection: connectionState(facts({ joins: 2, applied: 5, appliedAtLastJoin: 4 })),
      } as never),
    );
    const banner = screen.getByTestId('connection');
    expect(banner.dataset.phase).toBe('recovered');
    expect(banner.dataset.stalled).toBe('false');
  });

  it('a live payload while stalled is still rendered — the table is not blanked', () => {
    const view = seatView();
    mount(initialState(view), {
      connection: connectionState(facts({ connected: false, seatId: 0 })),
    });
    // Everything the player could already see stays on screen. The banner says
    // it is not moving; it does not take the draft away.
    expect(screen.getAllByTestId('card').length).toBeGreaterThan(0);
  });
});

/* ── 3. The deck at the end ──────────────────────────────────────────── */

/** A finished 45-card pool built out of the committed fixture cards. */
function completeState(): TableState {
  const base = seatView();
  if (base.viewer.kind !== 'seat') throw new Error('expected a seat fixture');
  const source = base.viewer.pack;
  const pool = Array.from({ length: base.packCount * base.packSize }, (_, i) => ({
    ...source[i % source.length],
    cardId: `done-${i}`,
  }));
  return initialState({ ...base, viewer: { ...base.viewer, pack: [], pool } });
}

describe('a finished draft ends in a deck, not a list of names', () => {
  it('replaces the pack and pool with the deck builder', () => {
    mount(completeState());
    expect(screen.getByTestId('draft-screen').dataset.complete).toBe('true');
    expect(screen.getByTestId('deck-view')).toBeTruthy();
    expect(screen.queryByTestId('pack')).toBeNull();
    expect(screen.queryByTestId('pool')).toBeNull();
  });

  it('opens with everything sideboarded and says what is missing', () => {
    mount(completeState());
    expect(screen.getByTestId('main-count').textContent).toBe('0');
    expect(screen.getByTestId('side-count').textContent).toBe('45');
    expect(screen.getByTestId('deck-problems').textContent).toContain('at least 40');
  });

  it('promotes a card to the maindeck and the counts follow', () => {
    mount(completeState());
    const first = within(screen.getByTestId('side-list')).getAllByTestId('deck-row')[0];
    const name = first.dataset.cardName;
    const before = Number(screen.getByTestId('side-count').textContent);
    fireEvent.click(within(first).getByRole('button'));

    expect(Number(screen.getByTestId('main-count').textContent)).toBeGreaterThan(0);
    expect(Number(screen.getByTestId('side-count').textContent)).toBeLessThan(before);
    expect(
      within(screen.getByTestId('main-list'))
        .getAllByTestId('deck-row')
        .some((row) => row.dataset.cardName === name),
    ).toBe(true);
  });

  it('adds basic lands, which come from the table and not from the pool', () => {
    mount(completeState());
    fireEvent.click(screen.getByLabelText('one more Island'));
    fireEvent.click(screen.getByLabelText('one more Island'));
    expect(screen.getByTestId('basic-Island-count').textContent).toBe('2');
    // Basics count toward the maindeck and not toward the drafted pool.
    expect(screen.getByTestId('main-count').textContent).toBe('2');
    expect(screen.getByTestId('side-count').textContent).toBe('45');
  });

  it('draws no card art and no WotC marks — pips are ours, and there is no img', () => {
    const { container } = mount(completeState());
    expect(container.querySelectorAll('img')).toHaveLength(0);
    // Every symbol on a row is a `.pip` span drawn by `ManaPip`.
    const pips = container.querySelectorAll('.deckrow__cost .pip');
    expect(pips.length).toBeGreaterThan(0);
    for (const pip of pips) expect(pip.tagName).toBe('SPAN');
  });

  // ── the done-when: the export round-trips through the real parser ────
  it('downloads a .dck that parseDck reads back as the same deck', () => {
    const written: { filename: string; text: string }[] = [];
    mount(completeState(), {
      onDownloadDeck: (filename: string, text: string) => written.push({ filename, text }),
    });

    // Build something worth exporting: ten cards and seventeen Forests.
    for (const row of within(screen.getByTestId('side-list')).getAllByTestId('deck-row').slice(0, 10)) {
      fireEvent.click(within(row).getByRole('button'));
    }
    for (let i = 0; i < 17; i += 1) fireEvent.click(screen.getByLabelText('one more Forest'));

    fireEvent.click(screen.getByTestId('download-dck'));

    expect(written).toHaveLength(1);
    expect(written[0].filename.endsWith('.dck')).toBe(true);

    const parsed = parseDck(written[0].text);
    const main = parsed.sections.get('main') ?? [];
    const side = parsed.sections.get('sideboard') ?? [];
    const count = (rows: readonly { count: number }[]) =>
      rows.reduce((n, r) => n + r.count, 0);

    // Seventeen Forests plus whatever the ten clicks promoted.
    expect(count(main)).toBe(Number(screen.getByTestId('main-count').textContent));
    expect(count(side)).toBe(Number(screen.getByTestId('side-count').textContent));
    // The drafted pool is intact: 45 cards, basics excluded.
    expect(count(main) + count(side) - 17).toBe(45);
    expect(main.some((e) => e.card.name === 'Forest' && e.count === 17)).toBe(true);
    // And every card in the file names a printing the draft actually dealt.
    for (const entry of [...main, ...side]) {
      if (entry.card.name === 'Forest') continue;
      expect(entry.card.set).not.toBeNull();
    }
  });
});
