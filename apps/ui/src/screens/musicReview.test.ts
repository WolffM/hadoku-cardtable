// @vitest-environment jsdom
/*
 * The match-music review (`#/sounds/music`), through its own props: stub clients and a stub player,
 * never a real fetch or `AudioContext`. The catalogue is the production shape of 2026-10-17: one of
 * the operator's tracks assigned per slot, three generated takes named `<code> · <description>`.
 *
 * `.test.ts` + `createElement`, not `.test.tsx` — see `screens/lobby.test.ts`'s header.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { MUSIC_REVIEW_CODES, type MusicReviewBody, type MusicReviewRecord, type SoundTake } from '@hadoku/shared';

import { DRAFT_KEY, MusicReview } from './MusicReview.tsx';
import type { MusicReviewClient, SoundsClient } from '../sound/builderClient.ts';

const take = (slug: string, name: string): SoundTake => ({
  file: `music-${slug}/take-1.ogg`,
  sound: `music-${slug}`,
  name,
  group: 'Music',
  section: 'Music',
  label: name,
  seconds: 120,
  prompt: `${name}, prompt`,
});

const TAKES: SoundTake[] = [];
const CELLS: Record<string, string[]> = {};
for (const code of MUSIC_REVIEW_CODES) {
  const web = take(`web-${code.toLowerCase()}`, `Web ${code}`);
  TAKES.push(web);
  for (const n of ['one', 'two', 'three']) TAKES.push(take(`${code.toLowerCase()}-${n}`, `${code} · ${n}`));
  CELLS[`music.match.${code}|play`] = [web.file];
}
TAKES.push({ ...take('lobby', 'Lobby'), file: 'music-lobby/take-1.ogg' });

const W = 'music.match.W|play';
const WU = 'music.match.WU|play';

function stubClient(canView = true): SoundsClient {
  return {
    catalogue: async () => TAKES,
    assignments: async () => ({ cells: CELLS, gains: {}, canEdit: false, canView }),
    save: vi.fn(async () => null),
    retire: vi.fn(async () => null),
    restore: vi.fn(async () => false),
    marks: async () => ({}),
    mark: vi.fn(async () => false),
    takeUrl: (f) => f,
  };
}

function stubReviews(initial: MusicReviewRecord | null = null): MusicReviewClient & { sent: MusicReviewBody[]; fail: boolean } {
  let latest = initial;
  const out = {
    sent: [] as MusicReviewBody[],
    fail: false,
    async mine() {
      return latest;
    },
    async submit(body: MusicReviewBody) {
      out.sent.push(body);
      if (out.fail) return null;
      latest = { at: '2026-10-17T12:00:00.000Z', userId: 'bob', name: 'Bob', slots: body.slots };
      return latest;
    },
  };
  return out;
}

function stubPlayer() {
  return { loopFile: vi.fn(), setLevels: vi.fn() };
}

function slot(cell: string): HTMLElement {
  return document.querySelector(`[data-testid="music-review-slot"][data-cell="${cell}"]`) as HTMLElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByTestId('music-review-submit') as HTMLButtonElement;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('MusicReview', () => {
  it('renders nothing below friend tier, once the load has resolved', async () => {
    const reviews = stubReviews();
    const mine = vi.spyOn(reviews, 'mine');
    const { container } = render(createElement(MusicReview, { client: stubClient(false), reviews, player: stubPlayer() }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mine).toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('draws the fifteen slots, monos then pairs, each with its current take badged first and three more', async () => {
    render(createElement(MusicReview, { client: stubClient(), reviews: stubReviews(), player: stubPlayer() }));
    await screen.findByText('Match Music');
    const slots = screen.getAllByTestId('music-review-slot');
    expect(slots.map((s) => s.dataset.cell)).toEqual(MUSIC_REVIEW_CODES.map((c) => `music.match.${c}|play`));
    for (const [i, s] of slots.entries()) {
      const code = MUSIC_REVIEW_CODES[i]!;
      const cards = s.querySelectorAll<HTMLElement>('.music-review__card');
      expect([...cards].map((c) => c.querySelector('.music-review__name')!.textContent)).toEqual([
        `Web ${code}`,
        `${code} · one`,
        `${code} · two`,
        `${code} · three`,
      ]);
      expect([...cards].map((c) => c.dataset.current !== undefined)).toEqual([true, false, false, false]);
      expect(within(cards[0]!).getByTitle('Current')).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: 'Builder' }).getAttribute('href')).toBe('#/sounds');
    // Nothing to send yet.
    expect(submitButton().disabled).toBe(true);
  });

  it('plays one candidate at a time on a loop, and the same card stops it', async () => {
    const player = stubPlayer();
    render(createElement(MusicReview, { client: stubClient(), reviews: stubReviews(), player }));
    await screen.findByText('Match Music');
    expect(player.setLevels).toHaveBeenCalled();
    const jig = screen.getByRole('button', { name: 'Play W · one' });
    fireEvent.click(jig);
    expect(player.loopFile).toHaveBeenLastCalledWith('music-w-one/take-1.ogg');
    fireEvent.click(screen.getByRole('button', { name: 'Play WU · two' }));
    expect(player.loopFile).toHaveBeenLastCalledWith('music-wu-two/take-1.ogg');
    expect(screen.getAllByRole('button', { name: /^Stop / })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop WU · two' }));
    expect(player.loopFile).toHaveBeenLastCalledWith(null);
    expect(screen.queryAllByRole('button', { name: /^Stop / })).toHaveLength(0);
  });

  it('one pick per slot, a rating per candidate, a note per slot; submit sends only what was said, then shows saved', async () => {
    const reviews = stubReviews();
    render(createElement(MusicReview, { client: stubClient(), reviews, player: stubPlayer() }));
    await screen.findByText('Match Music');

    const w = slot(W);
    fireEvent.click(within(w).getByRole('button', { name: 'Pick W · one' }));
    fireEvent.click(within(w).getByRole('button', { name: 'Pick W · two' }));
    expect(within(w).getAllByRole('button', { pressed: true, name: /^Pick / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Pick W · two']);
    expect(w.querySelector('[data-picked]')!.getAttribute('data-file')).toBe('music-w-two/take-1.ogg');

    fireEvent.click(within(within(w).getByRole('group', { name: 'Rate Web W' })).getByRole('button', { name: 'No' }));
    const rateOne = within(within(w).getByRole('group', { name: 'Rate W · one' }));
    fireEvent.click(rateOne.getByRole('button', { name: 'Keep' }));
    fireEvent.click(rateOne.getByRole('button', { name: 'Maybe' }));
    expect(rateOne.getByRole('button', { name: 'Maybe' }).getAttribute('aria-pressed')).toBe('true');
    expect(rateOne.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.change(within(w).getByRole('textbox', { name: 'W note' }), { target: { value: '  the jig  ' } });
    fireEvent.change(within(slot(WU)).getByRole('textbox', { name: 'WU note' }), { target: { value: 'none of these' } });

    expect(submitButton().dataset.state).toBe('unsent');
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)[W].pick).toBe('music-w-two/take-1.ogg');
    await act(async () => {
      fireEvent.click(submitButton());
    });
    expect(reviews.sent).toEqual([
      {
        slots: {
          [W]: {
            pick: 'music-w-two/take-1.ogg',
            ratings: { 'music-web-w/take-1.ogg': 'no', 'music-w-one/take-1.ogg': 'maybe' },
            note: 'the jig',
          },
          [WU]: { pick: null, ratings: {}, note: 'none of these' },
        },
      },
    ]);
    expect(submitButton().dataset.state).toBe('saved');
    expect(submitButton().disabled).toBe(true);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();

    // Unpicking is a change again.
    fireEvent.click(within(w).getByRole('button', { name: 'Pick W · two' }));
    expect(submitButton().dataset.state).toBe('unsent');
  });

  it('re-opening restores the latest submission; an unsent draft wins over it', async () => {
    const record: MusicReviewRecord = {
      at: '2026-10-17T12:00:00.000Z',
      userId: 'bob',
      name: 'Bob',
      slots: { [W]: { pick: 'music-w-three/take-1.ogg', ratings: { 'music-w-one/take-1.ogg': 'keep' }, note: 'three' } },
    };
    const first = render(createElement(MusicReview, { client: stubClient(), reviews: stubReviews(record), player: stubPlayer() }));
    await screen.findByText('Match Music');
    expect(within(slot(W)).getByRole('button', { name: 'Pick W · three' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(within(slot(W)).getByRole('group', { name: 'Rate W · one' })).getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
    expect((within(slot(W)).getByRole('textbox', { name: 'W note' }) as HTMLTextAreaElement).value).toBe('three');
    expect(submitButton().dataset.state).toBe('saved');

    fireEvent.click(within(slot(WU)).getByRole('button', { name: 'Pick WU · one' }));
    first.unmount();

    render(createElement(MusicReview, { client: stubClient(), reviews: stubReviews(record), player: stubPlayer() }));
    await screen.findByText('Match Music');
    expect(within(slot(WU)).getByRole('button', { name: 'Pick WU · one' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(slot(W)).getByRole('button', { name: 'Pick W · three' }).getAttribute('aria-pressed')).toBe('true');
    expect(submitButton().dataset.state).toBe('unsent');
  });

  it('a draft naming a take the slot no longer offers drops it', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ [W]: { pick: 'music-gone/take-1.ogg', ratings: { 'music-gone/take-1.ogg': 'keep' }, note: 'x' } }));
    const reviews = stubReviews();
    render(createElement(MusicReview, { client: stubClient(), reviews, player: stubPlayer() }));
    await screen.findByText('Match Music');
    expect(within(slot(W)).queryAllByRole('button', { pressed: true })).toHaveLength(0);
    await act(async () => {
      fireEvent.click(submitButton());
    });
    expect(reviews.sent).toEqual([{ slots: { [W]: { pick: null, ratings: {}, note: 'x' } } }]);
  });

  it('a refused submit shows failed and keeps the draft', async () => {
    const reviews = stubReviews();
    reviews.fail = true;
    render(createElement(MusicReview, { client: stubClient(), reviews, player: stubPlayer() }));
    await screen.findByText('Match Music');
    fireEvent.click(within(slot(W)).getByRole('button', { name: 'Pick W · one' }));
    await act(async () => {
      fireEvent.click(submitButton());
    });
    expect(submitButton().dataset.state).toBe('failed');
    expect(submitButton().disabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)[W].pick).toBe('music-w-one/take-1.ogg');
  });

  it('stops the music when the page goes', async () => {
    const player = stubPlayer();
    const { unmount } = render(createElement(MusicReview, { client: stubClient(), reviews: stubReviews(), player }));
    await screen.findByText('Match Music');
    fireEvent.click(screen.getByRole('button', { name: 'Play W · one' }));
    unmount();
    expect(player.loopFile).toHaveBeenLastCalledWith(null);
  });
});
