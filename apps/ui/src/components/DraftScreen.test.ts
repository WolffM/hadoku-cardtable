// @vitest-environment jsdom
/**
 * The done-when, as something the manager can re-run.
 *
 * §C's bar is "`pnpm --filter @hadoku/ui dev` renders a full pack from a
 * fixture and a pick updates the view". A dev server and a screenshot prove
 * that once; this mounts the real `DraftScreen` against the real committed
 * fixtures, counts the cards, clicks one, and asserts the view changed — which
 * proves it every time anyone runs `pnpm check`.
 *
 * No JSX here on purpose: the root vitest config globs `apps/*\/src/**\/*.test.ts`,
 * so a `.tsx` test would not be collected by the gate that actually runs in CI.
 * `createElement` costs one line and keeps the test inside the gate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment, useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/** The player's saved preferences, as `@wolffm/prefs-client` would hold them: a save re-renders every reader. */
const prefsStore = vi.hoisted(() => ({ prefs: {} as Record<string, unknown>, saved: [] as Record<string, unknown>[], readers: new Set<() => void>() }));
vi.mock('@wolffm/prefs-client/react', async () => {
  const { useEffect, useReducer } = await import('react');
  return {
    usePrefs: () => {
      const [, rerender] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        prefsStore.readers.add(rerender);
        return () => void prefsStore.readers.delete(rerender);
      }, []);
      return {
        prefs: prefsStore.prefs,
        save: (patch: Record<string, unknown>) => {
          prefsStore.saved.push(patch);
          prefsStore.prefs = { ...prefsStore.prefs, ...patch };
          prefsStore.readers.forEach((r) => r());
          return Promise.resolve();
        },
        loading: false,
        error: null,
      };
    },
  };
});
vi.mock('../play/live/prefs.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../play/live/prefs.ts')>()),
  getPlayPrefsClient: () => ({}),
}));

import { FIXTURES, loadFixtures } from '../draft/fixtures.ts';
import { applyPayload, initialState, type TableState } from '../draft/table.ts';
import { TopLayer } from '../topLayer.tsx';
import { DraftScreen } from './DraftScreen.tsx';
import { POOL_ENTER_MS } from './PoolView.tsx';

afterEach(() => {
  cleanup();
  prefsStore.prefs = {};
  prefsStore.saved = [];
});

/**
 * The screen on the committed fixtures: a button per fixture, titled with its
 * file, and the payload after the one shown as the screen's "next payload".
 */
function OnFixtures() {
  const views = useMemo(() => loadFixtures(), []);
  const [state, setState] = useState<TableState>(() => initialState(views[0]!));
  const next = views.find((v) => v.draftId === state.view.draftId && v.seq > state.view.seq) ?? null;
  return createElement(
    Fragment,
    null,
    FIXTURES.map((fixture, i) =>
      createElement('button', { key: fixture.file, type: 'button', title: fixture.file, onClick: () => setState(initialState(views[i]!)) }, fixture.label),
    ),
    createElement(DraftScreen, {
      state,
      onChange: setState,
      nextPayload: next,
      onAdvance: next === null ? undefined : () => setState((prev) => applyPayload(prev, next)),
    }),
    createElement(TopLayer, { fixed: true }),
  );
}

const mount = () => render(createElement(OnFixtures));

const packCards = () => within(screen.getByTestId('pack')).queryAllByTestId('card');
const poolCards = () => within(screen.getByTestId('pool')).queryAllByTestId('card');

/** Click the fixture button whose title is that file name. */
function chooseFixture(file: string) {
  fireEvent.click(screen.getByTitle(file));
}

describe('the draft screen, on committed fixtures', () => {
  it('renders a full 15-card pack', () => {
    mount();
    expect(packCards()).toHaveLength(15);
    expect(screen.getByTestId('pack').dataset.cardCount).toBe('15');
  });

  it('wraps every pack tile in a synthetic w<n> id for the shared inspector, without touching the real one', () => {
    mount();
    const slots = screen.getByTestId('pack').querySelectorAll('.pack__slot');
    expect(slots).toHaveLength(15);
    for (const [i, slot] of [...slots].entries()) {
      // The wrapper's own id is the inspector's vocabulary (`play/inspect/index.ts`'s `TILE_ID`).
      expect(slot.getAttribute('data-card-id')).toBe(`w${i}`);
      // The tile inside keeps its REAL id — what a pick and every other test reads.
      const tile = slot.querySelector('[data-testid="card"]');
      const realId = tile?.getAttribute('data-card-id');
      expect(realId).toBeTruthy();
      expect(realId).not.toMatch(/^w\d+$/);
    }
  });

  it('the pool numbers its own synthetic ids past the pack’s, so the two never collide on one screen', () => {
    mount();
    chooseFixture('seat0-pack1-pick3.json');
    const packMax = [...screen.getByTestId('pack').querySelectorAll('.pack__slot')]
      .map((el) => Number(el.getAttribute('data-card-id')?.slice(1)))
      .reduce((a, b) => Math.max(a, b), -1);
    const poolIds = [...screen.getByTestId('pool').querySelectorAll('.pool__tile')].map((el) =>
      Number(el.getAttribute('data-card-id')?.slice(1)),
    );
    expect(poolIds.length).toBeGreaterThan(0);
    expect(Math.min(...poolIds)).toBeGreaterThan(packMax);
  });

  it('renders each card as our own layout — name, cost, type, text, stat', () => {
    mount();
    const bolt = packCards().find((el) => within(el).queryByText('Lightning Bolt'));
    if (!bolt) throw new Error('expected Lightning Bolt in the opening pack');
    expect(within(bolt).getByText('Instant')).toBeTruthy();
    expect(bolt.textContent).toContain('deals 3 damage to any target');
    // One red pip, drawn by us — a <span>, never an image.
    const pips = bolt.querySelectorAll('.pip');
    expect(pips).toHaveLength(1);
    expect(pips[0].getAttribute('data-token')).toBe('R');

    const angel = packCards().find((el) => within(el).queryByText('Serra Angel'));
    if (!angel) throw new Error('expected Serra Angel in the opening pack');
    expect(within(angel).getByText('4/4')).toBeTruthy();
    expect([...angel.querySelectorAll('.pip')].map((p) => p.getAttribute('data-token'))).toEqual([
      '3',
      'W',
      'W',
    ]);
  });

  it('renders no image for a payload that carries no scryfallId (D13)', () => {
    // The committed fixtures predate card art and carry no `scryfallId`, so
    // nothing here can build a URL. This asserts the FALLBACK — a card with no
    // id is a complete, readable text tile — not "images are forbidden".
    //
    // It used to assert exactly that, and it kept passing after images shipped,
    // because fixtures have no ids. A control that cannot fail is not a
    // control; the real D13 invariant is asserted in `draft/cardImage.test.ts`
    // and on the live source, where images actually render.
    const { container } = mount();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="card"]').length).toBeGreaterThan(0);
  });

  it('shows the pack and pick counters', () => {
    mount();
    expect(screen.getByTestId('pack-number').textContent).toBe('1');
    expect(screen.getByTestId('pick-number').textContent).toBe('1');
  });

  it('shows whose turn it is, by seat', () => {
    mount();
    const bar = screen.getByTestId('seat-bar');
    expect(within(bar).getAllByRole('listitem')).toHaveLength(8);
    // Pick 1: everyone is still on the clock.
    for (let id = 0; id < 8; id += 1) {
      expect(screen.getByTestId(`seat-${id}`).dataset.waiting).toBe('true');
    }
    expect(screen.getByTestId('seat-0').dataset.occupant).toBe('human');
    expect(screen.getByTestId('seat-7').dataset.occupant).toBe('bot');
    expect(screen.getByTestId('pass-direction').dataset['direction']).toBe('left');
  });

  it('shows only the seats still owing a pick when the payload says so', () => {
    mount();
    chooseFixture('seat0-pack1-pick3.json');
    const waiting = [0, 1, 2, 3, 4, 5, 6, 7].filter(
      (id) => screen.getByTestId(`seat-${id}`).dataset.waiting === 'true',
    );
    expect(waiting).toEqual([0, 2, 5]);
  });

  // ── the done-when ────────────────────────────────────────────────────
  it('a pick updates the view: the card leaves the pack and joins the pool', () => {
    mount();
    expect(poolCards()).toHaveLength(0);
    expect(screen.getByTestId('pool-count').textContent).toBe('0');

    const chosen = packCards()[4];
    const chosenId = chosen.getAttribute('data-card-id');
    const chosenName = chosen.querySelector('.card__name')?.textContent ?? '';
    expect(chosenId).toBeTruthy();

    fireEvent.click(chosen);

    // The pool gained exactly the card that was clicked…
    expect(poolCards()).toHaveLength(1);
    expect(screen.getByTestId('pool-count').textContent).toBe('1');
    expect(poolCards()[0].getAttribute('data-card-id')).toBe(chosenId);
    expect(within(screen.getByTestId('pool')).getByText(chosenName)).toBeTruthy();

    // …and the pack says it has moved on rather than pretending to know the next one.
    expect(packCards()).toHaveLength(0);
    expect(screen.getByTestId('pack').textContent).toContain('Waiting for the next pack.');
  });

  it('the pool groups by colour, not mana value — a 4-mana white card and a 1-mana black one land in different buckets', () => {
    mount();
    // This fixture's pool already holds Wrath of God (W, mv4) and Thoughtseize
    // (B, mv1): the bucket testid below is the colour letter, not a mana
    // value number — the thing that would read `pool-bucket-4` / `-1` if the
    // old grouping were still live.
    chooseFixture('seat0-pack1-pick3.json');
    expect(within(screen.getByTestId('pool-bucket-W')).queryByText('Wrath of God')).toBeTruthy();
    expect(within(screen.getByTestId('pool-bucket-B')).queryByText('Thoughtseize')).toBeTruthy();
    expect(screen.getByTestId('pool').querySelectorAll('[data-testid^="pool-bucket-"]').length).toBe(2);
  });

  it('a pick is a FLIP, not a pop: the pool tile is set to the pack slot’s position, then eased back, then drops the class', async () => {
    // `setTimeout` only — a real `requestAnimationFrame` is what turns the
    // transform back off, and faking it too would mean nothing here ever runs.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      fireEvent.click(packCards()[4]);

      const tile = poolCards()[0].closest('.pool__tile') as HTMLElement | null;
      expect(tile).not.toBeNull();
      expect(tile?.classList.contains('pool__tile--enter')).toBe(true);
      // The FLIP's "invert": a transform is on the tile before the browser
      // ever paints it at its real position. jsdom lays nothing out, so the
      // pack slot and the pool tile are both the zero rect — the interesting
      // assertion is that a transform exists at all, not its exact values.
      expect(tile?.style.transform).not.toBe('');

      // The real rAF clears it — "play".
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(r));
      });
      expect(tile?.style.transform).toBe('');

      act(() => {
        vi.advanceTimersByTime(POOL_ENTER_MS);
      });
      expect(poolCards()[0].closest('.pool__tile')?.classList.contains('pool__tile--enter')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pick whose frame never comes before the arrival clears is not left inverted over the pack', () => {
    // A loaded browser can run DraftScreen's own POOL_ENTER_MS timer (which
    // clears the arrival) before the FLIP's requestAnimationFrame. The tile
    // must still end at its own place with its class dropped — a tile left
    // `display: block` at the pack slot's offset takes the next pick's click
    // (draft.spec.ts:518 on CI, 120e763e: "pool subtree intercepts pointer events").
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    try {
      mount();
      fireEvent.click(packCards()[4]);
      expect(poolCards()[0].closest('.pool__tile')?.classList.contains('pool__tile--enter')).toBe(true);

      act(() => {
        vi.advanceTimersByTime(POOL_ENTER_MS);
      });
      const tile = poolCards()[0].closest('.pool__tile') as HTMLElement | null;
      expect(tile?.classList.contains('pool__tile--enter')).toBe(false);
      expect(tile?.style.transform).toBe('');
    } finally {
      raf.mockRestore();
      vi.useRealTimers();
    }
  });

  it('the colour counters on the pool follow the pick', () => {
    mount();
    const wrath = packCards().find((el) => within(el).queryByText('Wrath of God'));
    if (!wrath) throw new Error('expected Wrath of God in the opening pack');
    expect(screen.getByTestId('pool-color-W').textContent).toContain('0');
    fireEvent.click(wrath);
    expect(screen.getByTestId('pool-color-W').textContent).toContain('1');
  });

  it('a second click is refused while the first pick is in flight', () => {
    mount();
    const first = packCards()[0];
    fireEvent.click(first);
    expect(poolCards()).toHaveLength(1);
    // There is nothing left to click, which is the strongest form of "refused".
    expect(packCards()).toHaveLength(0);
  });

  it('the next authoritative payload replaces the optimistic one', () => {
    mount();
    fireEvent.click(packCards()[0]);

    const advance = screen.getByTestId('advance');
    expect(advance.textContent).toContain('seq 2');
    fireEvent.click(advance);
    expect(screen.getByTestId('pick-number').textContent).toBe('2');
    // A fresh pack of 14 — the payload's, not the one this client guessed.
    expect(packCards()).toHaveLength(14);
    expect(poolCards()).toHaveLength(1);
    expect(within(screen.getByTestId('pool')).getByText('Wrath of God')).toBeTruthy();
  });

  it('renders the far side of the draft: pack 2, passing right, one seat on the clock', () => {
    mount();
    chooseFixture('seat3-pack2-pick5.json');
    expect(screen.getByTestId('pack-number').textContent).toBe('2');
    expect(screen.getByTestId('pick-number').textContent).toBe('5');
    expect(screen.getByTestId('pass-direction').dataset['direction']).toBe('right');
    expect(packCards()).toHaveLength(11);
    expect(poolCards()).toHaveLength(19);
    const waiting = [0, 1, 2, 3, 4, 5, 6, 7].filter(
      (id) => screen.getByTestId(`seat-${id}`).dataset.waiting === 'true',
    );
    expect(waiting).toEqual([3]);
  });

  it('a spectator sees the table and none of the cards', () => {
    mount();
    chooseFixture('spectator-pack2-pick5.json');

    expect(screen.queryByTestId('pool')).toBeNull();
    expect(packCards()).toHaveLength(0);
    expect(screen.getByTestId('pack').textContent).toContain('Spectating');

    // The public half is all still there.
    expect(within(screen.getByTestId('seat-bar')).getAllByRole('listitem')).toHaveLength(8);

    // And not one card name from anybody's pool reached the DOM.
    expect(screen.queryAllByTestId('card')).toHaveLength(0);
  });

  it('switching fixtures drops any pending pick', () => {
    mount();
    fireEvent.click(packCards()[2]);
    expect(poolCards()).toHaveLength(1);
    chooseFixture('seat0-pack1-pick1.json');
    expect(poolCards()).toHaveLength(0);
    expect(packCards()).toHaveLength(15);
  });

  it('the fan and the grid render the same cards in the same order', () => {
    mount();
    const fanned = packCards().map((el) => el.getAttribute('data-card-id'));
    fireEvent.click(screen.getByRole('button', { name: 'grid' }));
    expect(packCards().map((el) => el.getAttribute('data-card-id'))).toEqual(fanned);
  });

  it('remembers fan or grid as the player’s own preference (the operator, 2026-10-23: "so they dont have to click it every time")', () => {
    const pressed = () => screen.getByRole('group', { name: 'Pack layout' }).querySelector('[aria-pressed="true"]')?.textContent;
    mount();
    expect(pressed()).toBe('fan');
    fireEvent.click(screen.getByRole('button', { name: 'grid' }));
    expect(prefsStore.saved).toEqual([{ packLayout: 'grid' }]);
    expect(pressed()).toBe('grid');
    // The next draft opens on the saved choice, with no click.
    cleanup();
    mount();
    expect(pressed()).toBe('grid');
    expect(screen.getByTestId('pack').dataset.layout).toBe('grid');
  });
});
