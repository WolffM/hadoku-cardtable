/*
 * Build the browser-fps harness the way production builds the app: `apps/ui/vite.config.ts`'s own
 * plugins, defines and UI-scale PostCSS, React in production mode. Not minified and source-mapped, so a profile names
 * components and functions and `measure.mjs` maps them back to file:line (a little parse time, nothing per frame).
 *
 *   node scripts/fps/build.mjs [outDir]   (default ~/.cache/cardtable-fps/dist)
 */
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ui = resolve(here, '../../apps/ui');
const require = createRequire(resolve(ui, 'package.json'));
const vite = await import(pathToFileURL(require.resolve('vite')).href);

const outDir = resolve(process.argv[2] ?? resolve(process.env.HOME, '.cache/cardtable-fps/dist'));
const loaded = await vite.loadConfigFromFile({ command: 'build', mode: 'production' }, resolve(ui, 'vite.config.ts'), ui);
const uiModules = resolve(ui, 'node_modules');
await vite.build(
  vite.mergeConfig(loaded.config, {
    configFile: false,
    root: here,
    base: './',
    mode: 'production',
    logLevel: 'warn',
    resolve: { alias: { react: resolve(uiModules, 'react'), 'react-dom': resolve(uiModules, 'react-dom') } },
    build: { outDir, emptyOutDir: true, minify: false, sourcemap: true, rollupOptions: { input: resolve(here, 'harness.html') } },
  }),
);
console.log(`built ${outDir}`);
