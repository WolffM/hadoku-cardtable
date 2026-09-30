/*
 * Wave 31 P4 guard: the chrome's dim and faint ink are legible in EVERY theme
 * `@wolffm/themes` ships. `--ink-faint` first aliased `--color-text-tertiary`,
 * which is cyan in ocean-light (2.6:1 on white; the e2e measured 2.77).
 * Reads the real theme stylesheet and the real `styles.css`; nothing is restated.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

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
