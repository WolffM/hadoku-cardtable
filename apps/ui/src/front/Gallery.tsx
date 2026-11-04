/*
 * A front card as a manual gallery (`./gallery.ts`): one page at a time, its title in the card's
 * head with the arrows beside it, its own action in the foot with the dots. The reader turns it
 * with the arrows, a dot or a sideways swipe; it never turns itself. Upcoming (Calendar | Polls)
 * and the wildcard are both one.
 */

import { useRef, useState, type ReactNode } from 'react';

import { playRole } from '../sound/index.ts';
import { keepPage, stepPage, swipeStep } from './gallery.ts';

/**
 * The arrow inside a gallery's round button, drawn, not typed: a text ‹ › sits wherever its font
 * puts the glyph in its line box (1.25 px low and 0.4 px aside, measured on Linux; it moves with the
 * system font), so it never centred in the circle. The chevron's box is the viewBox's centre.
 */
export function ArrowGlyph({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <svg className="gallery__chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d={dir === 'prev' ? 'M15.5 5l-7 7 7 7' : 'M8.5 5l7 7-7 7'} />
    </svg>
  );
}

export interface GalleryPage {
  key: string;
  title: string;
  body: ReactNode;
  /** The page's own action, beside the dots. */
  action?: ReactNode;
}

/** `opening` is the page shown until the reader turns one; the first page without it. */
export function Gallery({ testId, pages, opening }: { testId: string; pages: readonly GalleryPage[]; opening?: string }) {
  const [key, setKey] = useState<string | null>(null);
  const at = keepPage(
    pages.map((p) => p.key),
    key ?? opening ?? null,
    0,
  );
  const page = pages[at];
  const down = useRef<{ x: number; y: number } | null>(null);
  if (page === undefined) return null;

  const turn = (to: number): void => {
    const next = pages[to];
    if (next === undefined || next.key === page.key) return;
    playRole('ui.select');
    setKey(next.key);
  };
  const many = pages.length > 1;

  return (
    <>
      <header className="front-card__head">
        <h3 className="front-card__title" data-testid={`${testId}-title`}>
          {page.title}
        </h3>
        {many && (
          <span className="gallery__arrows">
            <button type="button" className="gallery__arrow" aria-label="Previous" data-testid={`${testId}-prev`} onClick={() => turn(stepPage(at, -1, pages.length))}>
              <ArrowGlyph dir="prev" />
            </button>
            <button type="button" className="gallery__arrow" aria-label="Next" data-testid={`${testId}-next`} onClick={() => turn(stepPage(at, 1, pages.length))}>
              <ArrowGlyph dir="next" />
            </button>
          </span>
        )}
      </header>
      <div
        key={page.key}
        className="gallery__page"
        data-testid={`${testId}-page`}
        data-page={page.key}
        onPointerDown={(e) => {
          down.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const from = down.current;
          down.current = null;
          if (from === null || !many) return;
          const step = swipeStep(e.clientX - from.x, e.clientY - from.y);
          if (step !== 0) turn(stepPage(at, step, pages.length));
        }}
        onPointerCancel={() => {
          down.current = null;
        }}
      >
        {page.body}
      </div>
      {(many || page.action !== undefined) && (
        <div className="front-card__foot">
          {many && (
            <span className="gallery__dots">
              {pages.map((p, i) => (
                <button
                  key={p.key}
                  type="button"
                  className="gallery__dot"
                  aria-label={p.title}
                  aria-current={i === at ? 'true' : undefined}
                  data-testid={`${testId}-dot`}
                  data-page={p.key}
                  onClick={() => turn(i)}
                />
              ))}
            </span>
          )}
          {page.action}
        </div>
      )}
    </>
  );
}
