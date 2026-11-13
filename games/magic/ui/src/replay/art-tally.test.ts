// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ART_TALLY_GIVE_UP_MS, ART_TALLY_SETTLE_MS, tallyArt, whenArtSettles } from './art-tally.ts';

/** A face as `CardTile` draws it: with an art image in the given state, or none (the text tile). */
function face(img: { complete: boolean; naturalWidth: number; hidden?: boolean } | null): HTMLElement {
  const card = document.createElement('article');
  card.dataset.testid = 'card';
  if (img !== null) {
    const el = document.createElement('img');
    el.className = 'card__art';
    Object.defineProperty(el, 'complete', { value: img.complete });
    Object.defineProperty(el, 'naturalWidth', { value: img.naturalWidth });
    if (img.hidden === true) el.style.display = 'none';
    card.append(el);
  }
  return card;
}

afterEach(() => vi.useRealTimers());

describe('tallyArt', () => {
  it('counts decoded art, the text tile (no art, or an image that failed), and art still loading', () => {
    const root = document.createElement('div');
    root.append(
      face({ complete: true, naturalWidth: 488 }),
      face(null),
      face({ complete: true, naturalWidth: 0, hidden: true }),
      face({ complete: true, naturalWidth: 0 }),
      face({ complete: false, naturalWidth: 0 }),
    );
    expect(tallyArt(root)).toEqual({ faces: 5, withArt: 1, fallback: 3, pending: 1 });
  });
});

describe('whenArtSettles', () => {
  it('reports once nothing is pending, and once only', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.append(face({ complete: true, naturalWidth: 488 }), face({ complete: false, naturalWidth: 0 }));
    const report = vi.fn();
    whenArtSettles(() => root, report);
    vi.advanceTimersByTime(ART_TALLY_SETTLE_MS);
    expect(report, 'the second face is still loading').not.toHaveBeenCalled();
    root.lastElementChild!.replaceWith(face({ complete: true, naturalWidth: 488 }));
    vi.advanceTimersByTime(ART_TALLY_SETTLE_MS * 10);
    expect(report.mock.calls).toEqual([[{ faces: 2, withArt: 2, fallback: 0, pending: 0 }]]);
  });

  it('reports what it has at the give-up time, and nothing for a board with no faces', () => {
    vi.useFakeTimers();
    const stuck = document.createElement('div');
    stuck.append(face({ complete: false, naturalWidth: 0 }));
    const empty = document.createElement('div');
    const reported = vi.fn();
    const none = vi.fn();
    whenArtSettles(() => stuck, reported);
    whenArtSettles(() => empty, none);
    vi.advanceTimersByTime(ART_TALLY_GIVE_UP_MS + ART_TALLY_SETTLE_MS);
    expect(reported.mock.calls).toEqual([[{ faces: 1, withArt: 0, fallback: 0, pending: 1 }]]);
    expect(none).not.toHaveBeenCalled();
  });

  it('a cancel stops it', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.append(face({ complete: true, naturalWidth: 488 }));
    const report = vi.fn();
    whenArtSettles(() => root, report)();
    vi.advanceTimersByTime(ART_TALLY_GIVE_UP_MS * 2);
    expect(report).not.toHaveBeenCalled();
  });
});
