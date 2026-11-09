import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { publishManifest, type Manifest } from '../scripts/publish-manifest.ts';

const root = join(import.meta.dirname, '..');
const workspace = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

describe('the published manifest', () => {
	const pkg = publishManifest(workspace);

	it('is @wolffm/service-kernel on GitHub Packages, public, carrying dist and the licence only', () => {
		expect(pkg.name).toBe('@wolffm/service-kernel');
		expect(pkg.private).toBeUndefined();
		expect(pkg.license).toBe('MIT');
		expect(pkg.files).toEqual(['dist', 'LICENSE']);
		expect(pkg.publishConfig).toEqual({ registry: 'https://npm.pkg.github.com', access: 'public' });
	});

	it('points every export at the dist file built from the source the workspace exports', () => {
		for (const [sub, target] of Object.entries(pkg.exports)) {
			const src = workspace.exports[sub] as string;
			expect(existsSync(join(root, src)), `${sub}: ${src}`).toBe(true);
			const stem = src.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '');
			expect(target).toEqual({ types: `${stem}.d.ts`, import: `${stem}.js` });
		}
		expect(Object.keys(pkg.exports)).toEqual(Object.keys(workspace.exports));
	});

	it('names its @wolffm dependencies plainly, so the fleet resolves them on GitHub Packages', () => {
		const specs = Object.values({ ...pkg.dependencies, ...pkg.peerDependencies });
		expect(specs.filter((s) => /^(npm|workspace|file|link):/.test(s))).toEqual([]);
		expect(pkg.dependencies?.['@wolffm/rooms-server']).toMatch(/^\^\d+\.\d+\.\d+$/);
	});

	it('refuses an alias whose key and target disagree, and an export that is not a source file', () => {
		const crossed = { ...workspace, dependencies: { '@wolffm/rooms-server': 'npm:@hadoku/rooms-protocol@1.0.0' } };
		expect(() => publishManifest(crossed)).toThrow(/aliases @hadoku\/rooms-protocol/);
		const built = { ...workspace, exports: { './auth': './dist/auth/index.js' } };
		expect(() => publishManifest(built)).toThrow(/not \.\/src\/<path>\.ts/);
	});

	it('leaves the workspace manifest alone', () => {
		expect(workspace.name).toBe('@hadoku/service-kernel');
		expect(workspace.private).toBe(true);
	});
});
