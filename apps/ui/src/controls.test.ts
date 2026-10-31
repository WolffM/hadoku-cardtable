/*
 * The browser's own controls are coloured by the fleet, once, at the page's root: `@wolffm/task-ui-components`'s
 * `controls.css` under `hdk-controls` gives every checkbox, radio, range and progress the theme's accent. The
 * settings panel's sliders showed the browser's blue in the header's popout (the operator, 2026-10-30: "i noticed a
 * hardcoded color or default color on the volume slider"), because the only `accent-color` reaching them was a
 * `.ct-popover` rule, and that panel no longer sits in one. A per-component rule misses whatever container it was not
 * written for, so none is allowed.
 */
// @reads apps/ui/src/ apps/ui/index.html
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

function sheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : [],
  );
}

describe('native controls take the theme’s accent from the fleet, at the root', () => {
  it('the page and the embed both load controls.css and carry hdk-controls on their root', () => {
    expect(read('../index.html')).toMatch(/<html[^>]*class="[^"]*\bhdk-controls\b/);
    expect(read('main.tsx')).toContain("import '@wolffm/task-ui-components/controls.css';");
    const embed = read('embed/index.tsx');
    expect(embed).toContain("import '@wolffm/task-ui-components/controls.css';");
    expect(embed).toMatch(/container\.className = '[^']*\bhdk-controls\b/);
  });

  it('no stylesheet of ours sets accent-color', () => {
    const setting = sheets(SRC).filter((f) => /(^|[\s;{])accent-color\s*:/m.test(readFileSync(f, 'utf8')));
    expect(setting.map((f) => relative(SRC, f))).toEqual([]);
  });
});
