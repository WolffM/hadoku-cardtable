/*
 * Wave 31 P4 guard: the chrome's dim and faint ink are legible in EVERY theme
 * `@wolffm/themes` ships. `--ink-faint` first aliased `--color-text-tertiary`,
 * which is cyan in ocean-light (2.6:1 on white; the e2e measured 2.77).
 * Reads the real theme stylesheet and the real `styles.css`; nothing is restated.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

// @reads apps/ui/src/*.css
const themeCss = readFileSync(new URL('../../node_modules/@wolffm/themes/src/style.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const ownCss = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

function hex(v: string | undefined): Rgb | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === 'white') return [255, 255, 255];
  if (t === 'black') return [0, 0, 0];
  const m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m === null) return null;
  const h = m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
/** A theme colour as written: `#rrggbb` or `rgba(r, g, b, a)`; an alpha is composited over `over`. */
function paint(v: string | undefined, over: Rgb): Rgb | null {
  const a = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec((v ?? '').trim());
  if (a === null) return hex(v);
  const alpha = Number(a[4]);
  return [1, 2, 3].map((i) => Number(a[i]) * alpha + over[i - 1] * (1 - alpha)) as Rgb;
}
const channel = (x: number): number => (x / 255 <= 0.03928 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4);
const lum = (c: Rgb): number => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The theme tokens `--name` reads, in order: `var(--color-a, var(--color-b, #fallback))` → ['a', 'b']. */
function tokensOf(token: string): string[] | null {
  const m = new RegExp(`--${token}:\\s*(var\\(--color-[^;]+);`).exec(ownCss);
  return m === null ? null : [...m[1].matchAll(/--color-([a-z-]+)/g)].map((x) => x[1]);
}

const themes: { name: string; bg: Rgb; card: Rgb; vars: Record<string, string> }[] = [];
for (const m of themeCss.matchAll(/^([^\n{}/]+(?:,\n[^\n{}/]+)*)\{\n([\s\S]*?)^\}/gm)) {
  const v = Object.fromEntries([...m[2].matchAll(/--color-([a-z-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2]]));
  const [bg, card] = [hex(v.bg), hex(v['bg-card'])];
  if (bg === null || card === null || hex(v.text) === null) continue;
  const name = /data-theme='([a-z-]+)'/.exec(m[1])?.[1] ?? 'light';
  themes.push({ name, bg, card, vars: v });
}

describe('the chrome’s dim and faint ink', () => {
  it('alias the theme’s text tokens, and never the accent-tinted tertiary one', () => {
    for (const token of ['ink-dim', 'ink-faint']) {
      const names = tokensOf(token);
      expect(names, token).not.toBeNull();
      expect(names, token).not.toContain('text-tertiary');
      expect(names, token).not.toContain('text-muted');
    }
  });

  it('read the stylesheet of every theme', () => {
    expect(themes.length).toBeGreaterThanOrEqual(16);
    expect(themes.map((t) => t.name)).toContain('ocean-light');
  });

  it('clear 4.5:1 on the page and on a card in every theme', () => {
    const worst: string[] = [];
    for (const token of ['ink-dim', 'ink-faint']) {
      const names = tokensOf(token) ?? [];
      for (const t of themes) {
        // What the browser resolves: the first token the theme defines.
        const ink = paint(t.vars[names.find((n) => t.vars[n] !== undefined) ?? ''], t.bg);
        if (ink === null) {
          worst.push(`${token} in ${t.name}: resolves to nothing the theme defines`);
          continue;
        }
        const c = Math.min(contrast(ink, t.bg), contrast(ink, t.card));
        if (c < 4.5) worst.push(`${token} in ${t.name}: ${c.toFixed(2)}`);
      }
    }
    expect(worst).toEqual([]);
  });
});

/*
 * Wave 32 (a w31 leftover): `--accent` as TEXT was 1.56:1 in izakaya-light and
 * 2.28:1 in ocean-light. `--accent-ink` is the text token; `--accent` stays the
 * fill. The mix is computed the way `color-mix(in srgb, …)` does it: per channel
 * in gamma space.
 */
describe('the accent as text', () => {
  const mixOf = /--accent-ink:\s*color-mix\(in srgb,\s*var\(--accent\)\s*(\d+)%,\s*var\(--ink\)\)/.exec(ownCss);
  const share = mixOf === null ? 1 : Number(mixOf[1]) / 100;

  it('is a mix toward the ink, and the fill token is still the theme primary', () => {
    expect(mixOf).not.toBeNull();
    expect(ownCss).toMatch(/--accent:\s*var\(--color-primary\);/);
  });

  it('clears 4.5:1 on the page and on a card in every theme (the old accent did not)', () => {
    const failures: string[] = [];
    let oldWorst = Infinity;
    for (const t of themes) {
      const primary = hex(t.vars.primary);
      const ink = hex(t.vars.text);
      if (primary === null || ink === null) continue;
      const mixed = primary.map((c, i) => Math.round(c * share + ink[i] * (1 - share))) as Rgb;
      const c = Math.min(contrast(mixed, t.bg), contrast(mixed, t.card));
      oldWorst = Math.min(oldWorst, contrast(primary, t.bg), contrast(primary, t.card));
      if (c < 4.5) failures.push(`${t.name}: ${c.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
    // The reason the token exists: the raw accent is under 3:1 somewhere.
    expect(oldWorst).toBeLessThan(3);
  });

  it('is what the stylesheet draws glyphs with: no `color: var(--accent)` left in styles.css', () => {
    expect(ownCss).not.toMatch(/(^|[^-])color:\s*var\(--accent\)/m);
  });
});

/*
 * 2026-10-06: the board borrowed the colour-pie's red, green and blue for
 * damage, a life gain and a buffed number. They are the theme's danger, success
 * and primary now, and as TEXT each is a mix toward the ink, like the accent.
 */
describe('danger and success as text', () => {
  const inks = [
    { token: 'danger', theme: 'danger' },
    { token: 'success', theme: 'success' },
  ];

  for (const { token, theme } of inks) {
    const mixOf = new RegExp(`--${token}-ink:\\s*color-mix\\(in srgb,\\s*var\\(--${token}\\)\\s*(\\d+)%,\\s*var\\(--ink\\)\\)`).exec(ownCss);
    const share = mixOf === null ? 1 : Number(mixOf[1]) / 100;
    const worstAt = (s: number): number => {
      let worst = Infinity;
      for (const t of themes) {
        const fill = hex(t.vars[theme]);
        const ink = hex(t.vars.text);
        if (fill === null || ink === null) continue;
        const mixed = fill.map((c, i) => Math.round(c * s + ink[i] * (1 - s))) as Rgb;
        worst = Math.min(worst, contrast(mixed, t.bg), contrast(mixed, t.card));
      }
      return worst;
    };

    it(`--${token} is the theme's own, and --${token}-ink clears 4.5:1 on the page and on a card in every theme`, () => {
      expect(ownCss).toContain(`--${token}: var(--color-${theme});`);
      expect(mixOf).not.toBeNull();
      expect(worstAt(share)).toBeGreaterThanOrEqual(4.5);
      // The reason the ink token exists: the raw fill does not.
      expect(worstAt(1)).toBeLessThan(3);
    });
  }

  it('nothing on the board says danger, success or emphasis in a colour-pie hue any more', () => {
    const play = ['../play/card.css', '../play/live/live.css', '../play/live/gestures/gestures.css'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'));
    for (const css of play) expect(css).not.toMatch(/var\(--c-(red|green|blue|white|black)\)/);
    // board.css keeps them for exactly one thing, the mana pool's pips, which ARE the colour pie.
    const board = readFileSync(new URL('../play/board.css', import.meta.url), 'utf8');
    for (const rule of board.matchAll(/([^{}]+)\{[^{}]*var\(--c-(?:red|green|blue|white|black)\)[^{}]*\}/g)) {
      expect(rule[1], 'a colour-pie hue outside the mana pool').toMatch(/seat__mana-pip/);
    }
  });
});

describe('the stacking scale (wave 32 shape 2)', () => {
  it('declares the four layers on :root, in order', () => {
    const z = (n: string): number => Number(new RegExp(`--z-${n}:\\s*(\\d+);`).exec(ownCss)?.[1] ?? Number.NaN);
    expect([z('board'), z('card-badge'), z('overlay'), z('popover')]).toEqual([0, 1, 20, 40]);
  });
});

/*
 * The operator, 2026-10-10: "do not use hardcoded colors, that is forbidden.
 * use a color from the theme system". Every stylesheet the app owns, comments
 * aside, holds no literal colour — not even as a `var()` fallback, which paints
 * its literal the moment a token is missing. The one exception is the
 * colour-pie palette in `styles.css`: a card's colour identity, which no theme
 * has a token for. The vendored symbol fonts' sheets are third-party.
 */
describe('no hardcoded colours', () => {
  const root = new URL('../', import.meta.url);
  const sheets: string[] = [];
  const walk = (dir: URL, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) {
        if (name !== 'symbols') walk(new URL(`${name}/`, dir), `${rel}${name}/`);
      } else if (name.endsWith('.css')) sheets.push(`${rel}${name}`);
    }
  };
  walk(root, '');
  const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(|(?<![-\w])(?:white|black|red|blue|green|gray|grey|silver)(?![-\w])/i;
  const PALETTE = /^\s*--c-(?:white|blue|black|red|green|generic):\s*#[0-9a-f]{6};\s*$/i;

  it('finds the app’s stylesheets', () => {
    expect(sheets).toContain('styles.css');
    expect(sheets).toContain('settings/settings.css');
  });

  it('no stylesheet writes a literal colour, outside the colour-pie palette', () => {
    const found: string[] = [];
    for (const rel of sheets) {
      const css = readFileSync(new URL(rel, root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
      css.split('\n').forEach((line, i) => {
        if (LITERAL.test(line) && !(rel === 'styles.css' && PALETTE.test(line))) found.push(`${rel}:${String(i + 1)}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('every theme defines every colour token the stylesheets read, so nothing resolves to nothing', () => {
    const used = new Set<string>();
    for (const rel of sheets) for (const m of readFileSync(new URL(rel, root), 'utf8').matchAll(/var\(--color-([a-z-]+)\)/g)) used.add(m[1]);
    const missing: string[] = [];
    for (const t of themes) for (const name of used) if (t.vars[name] === undefined) missing.push(`${t.name}: --color-${name}`);
    expect(used.size).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
