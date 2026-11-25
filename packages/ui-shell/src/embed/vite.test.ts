import { describe, expect, it } from 'vitest';

import { embedBuild, emitManifest, requireOneStylesheet, shadowRootSelectors, toShadowSelector, withHostTheme } from './vite.ts';

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

describe('the embed manifest', () => {
  const emitted = (plugin: ReturnType<typeof emitManifest>): Array<{ fileName: string; source: string }> => {
    const files: Array<{ fileName: string; source: string }> = [];
    plugin.generateBundle.call({ emitFile: (f) => (files.push(f), f.fileName) });
    return files;
  };

  it('is written beside the entry as the host reads it, the default hold filled in', () => {
    const config = embedBuild({ app: 'g', base: '/g/', manifest: { label: 'G', seats: { min: 1, max: 4 } } });
    const plugin = config.plugins.find((p) => p.name === 'embed-manifest') as ReturnType<typeof emitManifest>;
    const [file, ...more] = emitted(plugin);
    expect(more).toEqual([]);
    expect(file!.fileName).toBe('embed/manifest.json');
    expect(JSON.parse(file!.source)).toEqual({ label: 'G', seats: { min: 1, max: 4 }, seatRejoinGraceMs: 120_000 });
  });

  it('is not written when the game names none', () => {
    expect(embedBuild({ app: 'g', base: '/g/' }).plugins.map((p) => p.name)).toEqual(['embed-one-stylesheet']);
  });

  it('fails the build when a host would refuse it', () => {
    expect(() => embedBuild({ app: 'g', base: '/g/', manifest: { label: 'G', seats: { min: 3, max: 2 } } })).toThrow(/seats: seats.min is more than seats.max/);
  });
});
