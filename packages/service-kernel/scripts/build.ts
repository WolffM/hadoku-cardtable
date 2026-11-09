// The published build: tsc emits dist/ from src/ (tests excluded), then the
// declarations get the same `.ts` → `.js` rewrite tsc already gave the
// JavaScript. TypeScript 5.9's rewriteRelativeImportExtensions leaves .d.ts
// specifiers alone, and a consumer resolving `./x.ts` from a .d.ts finds no
// such file under dist/. Inside this workspace nothing reads dist/.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
// Resolved, not looked up on PATH: CI runs this with node directly.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });

let rewritten = 0;
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
	const file = join(entry.parentPath, entry.name);
	const src = readFileSync(file, 'utf8');
	const out = src.replace(/(from\s+'\.{1,2}\/[^']*)\.ts'/g, "$1.js'");
	if (out !== src) {
		writeFileSync(file, out);
		rewritten++;
	}
}
console.log(`service-kernel: built dist/, ${rewritten} declaration files re-pointed at .js`);
