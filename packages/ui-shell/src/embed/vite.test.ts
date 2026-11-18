import { describe, expect, it } from 'vitest';

import { embedBuild, requireOneStylesheet, shadowRootSelectors, toShadowSelector, withHostTheme } from './vite.ts';

describe('the embed stylesheet’s selectors', () => {
  it('turns the document roots into the shadow host and leaves look-alikes alone', () => {
    expect(toShadowSelector(':root')).toBe(':host');
    expect(toShadowSelector(':root, [data-theme]')).toBe(':host, [data-theme]');
    expect(toShadowSelector('body')).toBe(':host');
    expect(toShadowSelector('body > .x')).toBe(':host > .x');
    expect(toShadowSelector('.prompt__body')).toBe('.prompt__body');
    expect(toShadowSelector('.body-row, tbody')).toBe('.body-row, tbody');
  });

  it('lets every bare theme selector theme the host too, once', () => {
    expect(withHostTheme(['[data-theme=dark]'])).toEqual(['[data-theme=dark]', ':host([data-theme=dark])']);
    expect(withHostTheme([':host', '[data-theme]', '.cardtable-chrome'])).toEqual([':host', '[data-theme]', ':host([data-theme])', '.cardtable-chrome']);
    expect(withHostTheme(['[data-theme=dark] .x', '.a[data-theme=dark]'])).toEqual(['[data-theme=dark] .x', '.a[data-theme=dark]']);
    const once = withHostTheme(['[data-theme=light]']);
    expect(withHostTheme(once), 'postcss revisits a changed rule').toEqual(once);
  });

  it('themes the host only when asked', () => {
    // postcss's own shape: `selectors` is `selector` split on commas, both ways.
    const rule = (selector: string) => ({
      selector,
      get selectors() {
        return this.selector.split(', ');
      },
      set selectors(list: string[]) {
        this.selector = list.join(', ');
      },
    });
    const plain = rule('[data-theme=dark]');
    shadowRootSelectors().Rule(plain);
    expect(plain.selector).toBe('[data-theme=dark]');
    const themed = rule(':root, [data-theme=dark]');
    shadowRootSelectors({ hostTheme: true }).Rule(themed);
    expect(themed.selectors).toEqual([':host', '[data-theme=dark]', ':host([data-theme=dark])']);
  });
});

describe('embedBuild', () => {
  it('names the entry and the one stylesheet after the app, and hashes the rest', () => {
    const config = embedBuild({ app: 'g', base: '/g/' });
    expect(config.base).toBe('/g/');
    expect(config.build.cssCodeSplit).toBe(false);
    expect(config.build.emptyOutDir).toBe(false);
    const { output, input } = config.build.rollupOptions;
    expect(input).toBe('src/embed/index.tsx');
    expect(output.entryFileNames).toBe('embed/g-embed.js');
    expect(output.assetFileNames({ names: ['index.css'] })).toBe('embed/g-embed.css');
    expect(output.assetFileNames({ names: ['font.woff2'] })).toBe('embed/assets/[name]-[hash][extname]');
  });

  it('keeps the game’s output options and its PostCSS plugins after the rewrite', () => {
    const extra = { postcssPlugin: 'x' };
    const config = embedBuild({ app: 'g', base: '/g/', postcssPlugins: [extra], output: { codeSplitting: { groups: [] } } });
    expect(config.css.postcss.plugins.at(-1)).toBe(extra);
    expect(config.build.rollupOptions.output.codeSplitting).toEqual({ groups: [] });
  });

  it('fails the build unless exactly the one stylesheet came out', () => {
    const plugin = requireOneStylesheet('embed/g-embed.css');
    const errors: string[] = [];
    const ctx = { error: (m: string): never => { errors.push(m); throw new Error(m); } };
    plugin.writeBundle.call(ctx, {}, { 'embed/g-embed.css': {}, 'embed/g-embed.js': {} });
    expect(errors).toEqual([]);
    expect(() => plugin.writeBundle.call(ctx, {}, { 'embed/g-embed.css': {}, 'embed/assets/x.css': {} })).toThrow(/exactly embed\/g-embed.css/);
    expect(() => plugin.writeBundle.call(ctx, {}, {})).toThrow(/no stylesheet/);
  });
});
