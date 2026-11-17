// @vitest-environment jsdom
/*
 * A name wears its effect, gradient and font; a name with none is plain text.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { FaceDecor, PlayerName } from './look.tsx';

afterEach(cleanup);

/** `rect`'s own corner, as `getBoundingClientRect` would report it — jsdom does no layout, so every
 * box a test cares about is stubbed by hand (below). */
function domRect(width: number, height: number, top = 40, left = 20): DOMRect {
  return {
    width,
    height,
    top,
    left,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

describe('PlayerName', () => {
  it('is plain text, with the class it was given, for someone who wears nothing on their name', () => {
    const { container } = render(createElement(PlayerName, { name: 'Ari', face: { id: 'sage', look: { cosmetics: { overlay: 'overlay.halo' } } }, className: 'n' }));
    expect(container.innerHTML).toBe('<span class="n">Ari</span>');
    expect(render(createElement(PlayerName, { name: 'Bo', face: { id: null } })).container.textContent).toBe('Bo');
  });

  it('draws the fleet’s name for someone who wears an effect, a gradient or a font, and escapes the name', () => {
    for (const cosmetics of [{ effect: 'effect.glint' }, { gradient: 'gradient.gild' }, { font: 'font.script' }]) {
      const { container, unmount } = render(createElement(PlayerName, { name: '<b>Ari</b>', face: { id: 'sage', look: { cosmetics } }, className: 'n' }));
      const span = container.querySelector('span.n')!;
      expect(span.hasAttribute('data-dressed')).toBe(true);
      expect(span.querySelector('.hc-name')).not.toBeNull();
      expect(span.querySelector('b')).toBeNull();
      expect(span.textContent).toContain('<b>Ari</b>');
      unmount();
    }
  });

  it('adds no stylesheet of its own: the entry puts the renderer’s sheet in before anything is drawn (`main.tsx`)', () => {
    render(createElement(PlayerName, { name: 'Ari', face: { id: 'sage', look: { cosmetics: { effect: 'effect.aura' } } } }));
    render(createElement(PlayerName, { name: 'Bo', face: { id: 'mage', look: { cosmetics: { font: 'font.surf' } } } }));
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });
});

describe('FaceDecor near a screen-reader-only list', () => {
  /*
   * The front page's room card draws its member list for screen readers only — `rooms.css`'s
   * `.rooms__sr`: `position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)` — a box
   * sitting right in the card's visible body, beside the room's own name (`room-card__name`). The
   * operator's screenshot (2026-11-16): one of the room's spectators wore a floating overlay (a halo), and
   * it showed up under the room owner's name on the card, not on the (invisible) spectator's own face.
   *
   * `decorHost` (`look.tsx`) escapes a clipping ancestor so a crown can clear a ROUND RING roughly the
   * face's own size; the bug was that it escaped THIS clip too, which is not sized to the face at all —
   * it is sized to show nothing, on purpose. The fix keeps an overlay inside any ancestor clipped down
   * to near-nothing. jsdom never lays anything out, so every box this test cares about is a stub.
   */
  const originalRect: typeof Element.prototype.getBoundingClientRect = Element.prototype.getBoundingClientRect;
  const RECTS: Readonly<Record<string, { width: number; height: number }>> = {
    'room-card-body': { width: 260, height: 140 },
    'members-sr': { width: 1, height: 1 },
    'member-face': { width: 18, height: 18 },
  };

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
  });

  it('keeps a spectator’s halo inside the hidden member list, off the card itself', () => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const id = this.getAttribute('data-testid');
      const sized = id === null ? undefined : RECTS[id];
      return sized === undefined ? domRect(0, 0) : domRect(sized.width, sized.height);
    };

    const { container } = render(
      createElement(
        'div',
        { 'data-testid': 'room-card-body', style: { position: 'relative' } },
        createElement('span', { 'data-testid': 'owner-name' }, "Kawakimi’s Room"),
        createElement(
          'span',
          {
            'data-testid': 'members-sr',
            className: 'rooms__sr',
            style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden', clip: 'rect(0px, 0px, 0px, 0px)' },
          },
          createElement('img', { 'data-testid': 'member-face' }),
          createElement(FaceDecor, { avatarId: 'spectator', look: { cosmetics: { overlay: 'overlay.halo' } } }),
        ),
      ),
    );

    const membersSr = container.querySelector('[data-testid="members-sr"]');
    const decor = container.querySelector('[data-hc-art]');
    expect(decor, 'the spectator’s halo art is drawn').not.toBeNull();
    expect(membersSr?.contains(decor), 'the halo stays a descendant of the hidden member list, never escapes onto the visible card').toBe(true);
  });
});
