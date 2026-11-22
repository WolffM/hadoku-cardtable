/*
 * The motion switches' build pass (`@hadoku/ui-shell/motion`'s `motionCss`), run as the build runs it: vite's
 * own PostCSS pipeline, on a sheet under an app's `src/` (the pass skips anything else), and on every real
 * sheet the app ships, which it must rewrite without refusing one.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { preprocessCSS, resolveConfig, type ResolvedConfig } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

import { ambientPlayState, gateSelector, motionCss } from '@hadoku/ui-shell/motion';

const REPO = resolve(import.meta.dirname, '../../..');
const OWN = join(REPO, 'apps/ui/src/fixture.css');

let config: ResolvedConfig;
beforeAll(async () => {
  config = await resolveConfig({ root: REPO, configFile: false, logLevel: 'silent', css: { postcss: { plugins: [motionCss] } } }, 'build');
});

const run = async (css: string, file = OWN): Promise<string> => (await preprocessCSS(css, file, config)).code.replace(/\s+/g, ' ').trim();

describe('motionCss', () => {
  it('a reduce query is gated off under data-motion=full, and copied out for data-motion=reduce', async () => {
    const out = await run('@media (prefers-reduced-motion: reduce) { .a { animation: none; } }');
    expect(out).toContain("@media (prefers-reduced-motion: reduce) { :where(:not([data-motion='full'], [data-motion='full'] *)) .a { animation: none; } }");
    expect(out).toContain("} :where([data-motion='reduce']) .a { animation: none; }");
  });

  it('a no-preference query is gated off under data-motion=reduce, and copied out for data-motion=full', async () => {
    const out = await run('@media (prefers-reduced-motion: no-preference) { .b { animation: x 1s; } @keyframes x { to { opacity: 1; } } }');
    expect(out).toContain(":where(:not([data-motion='reduce'], [data-motion='reduce'] *)) .b");
    expect(out).toContain("} :where([data-motion='full']) .b { animation: x 1s; } @keyframes x");
  });

  it('a selector that starts at :root takes the gate on its own compound', () => {
    expect(gateSelector(":root[data-layout='portrait'] .dock", "[data-motion='reduce']")).toBe(":root[data-layout='portrait']:where([data-motion='reduce']) .dock");
    expect(gateSelector('html .x', "[a='b']")).toBe("html:where([a='b']) .x");
    expect(gateSelector('.x::after', "[a='b']")).toBe(":where([a='b']) .x::after");
  });

  it('pauses only the infinite entries of a loop, under data-ambient=off', async () => {
    const out = await run('.c { animation: in 1s both, bob 2s 1s infinite; }');
    expect(out).toContain(":where([data-ambient='off']) .c { animation-play-state: running, paused; }");
    expect(out, 'and under the system\'s own query while the player has not set it').toContain("@media (prefers-reduced-motion: reduce) {:where(:not([data-ambient='on'], [data-ambient='on'] *)) .c { animation-play-state: running, paused; } }");
    expect(ambientPlayState('animation', 'spin 1s linear infinite')).toBe('paused');
    expect(ambientPlayState('animation', 'in 1s both')).toBeNull();
    expect(ambientPlayState('animation', 'cubic-bezier(0, 0, 1, 1) 1s x, y 2s infinite')).toBe('running, paused');
  });

  it('a loop with a still look in a reduce query takes that look with looping animations off', async () => {
    const out = await run('.ring::after { opacity: 0; animation: grace 1s infinite; } @media (prefers-reduced-motion: reduce) { .ring::after { animation: none; opacity: 1; } .other { transition: none; } }');
    expect(out).toContain(":where([data-ambient='off']) .ring::after { animation: none; opacity: 1; }");
    expect(out, 'a reduce rule for no loop is not copied').not.toContain(":where([data-ambient='off']) .other");
    expect(out, 'ambient left to the system takes the still look under the query, card motion forced on or not').toContain(":where(:not([data-ambient='on'], [data-ambient='on'] *)) .ring::after { animation: none; opacity: 1; }");
    expect(out.indexOf(":where([data-ambient='off']) .ring::after { animation: none"), 'the still look comes after the pause').toBeGreaterThan(out.indexOf(":where([data-ambient='off']) .ring::after { animation-play-state"));
  });

  it('follows a custom property that holds a loop', async () => {
    const out = await run('.d { --path: fly 4s linear infinite; } .e { animation: var(--path), tilt 1s; }');
    expect(out).toContain(":where([data-ambient='off']) .e { animation-play-state: paused, running; }");
  });

  it('refuses a keyframes name defined both inside a motion query and outside it', async () => {
    await expect(run('@keyframes k { to { opacity: 1; } } @media (prefers-reduced-motion: reduce) { @keyframes k { to { opacity: 0; } } }')).rejects.toThrow(/@keyframes k/);
  });

  it('leaves a sheet outside an app or package src alone', async () => {
    const css = '@media (prefers-reduced-motion: reduce) { .a { animation: none; } }';
    expect(await run(css, join(REPO, 'node_modules/x/y.css'))).toBe(css);
  });

  it('rewrites every sheet the app ships without refusing one', async () => {
    const sheets: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.css')) sheets.push(path);
      }
    };
    for (const root of ['apps/ui/src', 'packages', 'games/magic/ui/src']) walk(join(REPO, root));
    let mirrored = 0;
    for (const sheet of sheets) {
      const out = await run(readFileSync(sheet, 'utf8'), sheet).catch((e: Error) => {
        throw new Error(`${relative(REPO, sheet)}: ${e.message}`);
      });
      if (out.includes("[data-motion='reduce']") || out.includes("[data-ambient='off']")) mirrored++;
    }
    expect(mirrored).toBeGreaterThan(30);
  });
});
