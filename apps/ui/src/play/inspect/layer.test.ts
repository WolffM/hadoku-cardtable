import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// The operator, 2026-10-04: the hover zoom "should always show on top of all
// other screen elements. at the moment that control bar is displaying on top."
// And 2026-10-13: "currently it renders below the phase tracker" — the panel
// carried `--z-zoom` inside the board overlay, whose own layer the rail won.
describe('the hover zoom is the top layer', () => {
  it('the zoom layer is --z-zoom, and --z-zoom is above every other --z-* layer', () => {
    expect(read('../board.css')).toMatch(/\.board__zoom\s*\{[^}]*z-index:\s*var\(--z-zoom/);
    const scale = [...read('../../styles.css').matchAll(/--z-([a-z-]+):\s*(\d+)/g)].map(([, name, v]) => [name, Number(v)] as const);
    const zoom = scale.find(([name]) => name === 'zoom');
    expect(zoom, '--z-zoom is defined').toBeDefined();
    for (const [name, v] of scale) if (name !== 'zoom') expect(v, `--z-${name}`).toBeLessThan(zoom![1]);
  });

  it('the panel and the tooltip rank by the layer, not by a number of their own', () => {
    expect(read('./inspect.css')).not.toMatch(/--z-zoom/);
    expect(read('../tip/tip.css')).not.toMatch(/--z-zoom/);
  });
});
