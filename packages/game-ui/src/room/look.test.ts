// @vitest-environment jsdom
/*
 * A name wears its effect, gradient and font; a name with none is plain text.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { FaceDecor, PlayerName } from './look.tsx';

afterEach(cleanup);

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
   * face's own size — that clip is `overflow` plus a border-radius, never `clip`/`clip-path`. The bug
   * was that it escaped `.rooms__sr`'s clip too, which hides its content on purpose, the same way. The
   * fix reads the computed `clip`/`clip-path` rather than a measured size: jsdom never lays anything
   * out (`getBoundingClientRect()` is 0×0 for every box here, ring or sr-only alike), so a rule tied to
   * size cannot tell them apart in a unit test — or, for that matter, in a real browser, where both
   * boxes can be exactly the same size.
   */
  it('keeps a spectator’s halo inside the hidden member list, off the card itself (jsdom: every box is 0×0, so only the computed clip tells them apart)', () => {
    const { container } = render(
      createElement(
        'div',
        { 'data-testid': 'room-card-body' },
        createElement('span', { 'data-testid': 'owner-name' }, "Kawakimi’s Room"),
        createElement(
          'span',
          {
            'data-testid': 'members-sr',
            className: 'rooms__sr',
            style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0px, 0px, 0px, 0px)' },
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

  it('still escapes a plain seat ring the same size as the hidden box (`overflow` alone, no `clip`/`clip-path`)', () => {
    const { container } = render(
      createElement(
        'span',
        { className: 'outer' },
        createElement(
          'span',
          { className: 'ring', style: { width: '1px', height: '1px', overflow: 'hidden' } },
          createElement('img', {}),
          createElement(FaceDecor, { avatarId: 'seated', look: { cosmetics: { overlay: 'overlay.halo' } } }),
        ),
      ),
    );
    const decor = container.querySelector('[data-testid="face-decor"]');
    expect(decor?.parentElement?.className, 'a ring with no clip style still lets the overlay clear it').toBe('outer');
  });
});
