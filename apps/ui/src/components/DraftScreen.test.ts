// @vitest-environment jsdom
/**
 * The done-when, as something the manager can re-run.
 *
 * §C's bar is "`pnpm --filter @hadoku/ui dev` renders a full pack from a
 * fixture and a pick updates the view". A dev server and a screenshot prove
 * that once; this mounts the real `App` against the real committed fixtures,
 * counts the cards, clicks one, and asserts the view changed — which proves it
 * every time anyone runs `pnpm check`.
 *
 * No JSX here on purpose: the root vitest config globs `apps/*\/src/**\/*.test.ts`,
 * so a `.tsx` test would not be collected by the gate that actually runs in CI.
 * `createElement` costs one line and keeps the test inside the gate.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { App } from '../App.tsx';

afterEach(cleanup);

/**
 * Mount `App` and switch it to the fixture source.
 *
 * The app now boots into a LIVE draft — the real engine over the real bundled
 * cube — because that is what someone opening it wants. These tests are the
 * fixture regression net, so they select the fixture source explicitly rather
 * than relying on which source happens to be the default. That coupling is why
 * they all failed the moment the default changed, and selecting here is the fix
 * that survives the default changing again.
 */
function mount() {
  const result = render(createElement(App));
  fireEvent.click(screen.getByText('Fixtures — five committed payloads'));
  return result;
}

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

  it('shows the pack and pick counters and the payload seq', () => {
    mount();
    expect(screen.getByTestId('pack-number').textContent).toBe('1');
    expect(screen.getByTestId('pick-number').textContent).toBe('1');
    expect(screen.getByTestId('seq').textContent).toBe('1');
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
    expect(screen.getByTestId('pass-direction').textContent).toContain('passes left');
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
    expect(screen.getByTestId('status').textContent).toContain('Waiting for the next payload');
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

    expect(screen.getByTestId('seq').textContent).toBe('2');
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
    expect(screen.getByTestId('pass-direction').textContent).toContain('passes right');
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
    expect(screen.getByTestId('pack').textContent).toContain('spectator payload carries no pack');

    // The public half is all still there.
    expect(within(screen.getByTestId('seat-bar')).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByTestId('seat-3-picked').textContent).toBe('19');
    expect(screen.getByTestId('seq').textContent).toBe('20');

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
});
