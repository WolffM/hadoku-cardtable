import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { plan, renameSiblings, repointDeclaration } from './build.ts';
import { PUBLISHED, publishManifest, publishedName, type Manifest } from './manifest.ts';

const REPO = join(import.meta.dirname, '..', '..');
const read = (name: string): Manifest => JSON.parse(readFileSync(join(REPO, 'packages', name, 'package.json'), 'utf8')) as Manifest;
const versions = (sibling: string): string => `9.${PUBLISHED.indexOf(sibling.replace('@wolffm/', '') as (typeof PUBLISHED)[number])}.0`;

describe('the published manifest', () => {
	it.each(PUBLISHED.map((name) => [name]))('%s is @wolffm/<name>, public on GitHub Packages, carrying dist and the licence only', (name) => {
		const workspace = read(name);
		const pkg = publishManifest(workspace, versions);
		expect(pkg.name).toBe(`@wolffm/${name}`);
		expect(pkg.private).toBeUndefined();
		expect(pkg.license).toBe('MIT');
		expect(pkg.files).toEqual(['dist', 'LICENSE']);
		expect(existsSync(join(REPO, 'packages', name, 'LICENSE'))).toBe(true);
		expect(pkg.devDependencies).toBeUndefined();
		// The workflow builds from this manifest, after writing it: the build's leave-out list rides along.
		expect(pkg.publishLeaveOut).toEqual(workspace.publishLeaveOut);
		expect(pkg.publishConfig).toEqual({ registry: 'https://npm.pkg.github.com', access: 'public' });
		// Nothing a registry cannot resolve, and every sibling at the exact version this run gave it.
		const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
		expect(Object.values(deps).filter((s) => /^(npm|workspace|file|link):/.test(s))).toEqual([]);
		for (const [dep, spec] of Object.entries(deps)) {
			if (publishedName(dep.replace('@wolffm/', '@hadoku/')) !== null) expect(spec).toBe(versions(dep));
		}
		expect(Object.keys(deps).filter((d) => d.startsWith('@hadoku/'))).toEqual([]);
	});

	it('maps a named source export to its dist pair', () => {
		const pkg = publishManifest(read('service-kernel'), versions);
		expect(pkg.exports['./auth']).toEqual({ types: './dist/auth/index.d.ts', import: './dist/auth/index.js' });
		expect(Object.keys(pkg.exports)).toEqual(Object.keys(read('service-kernel').exports));
		expect(pkg.dependencies?.['@wolffm/rooms-server']).toMatch(/^\^\d+\.\d+\.\d+$/);
	});

	it('maps a wildcard export, with and without the extension in the specifier', () => {
		expect(publishManifest(read('game-server'), versions).exports).toEqual({ './*': { types: './dist/*.d.ts', import: './dist/*.js' } });
		expect(publishManifest(read('game-ui'), versions).exports).toEqual({
			'./*.ts': { types: './dist/*.d.ts', import: './dist/*.js' },
			'./*.tsx': { types: './dist/*.d.ts', import: './dist/*.js' },
			'./*.css': './dist/*.css',
		});
	});

	it('takes an exact peer as a floor within its major', () => {
		expect(publishManifest(read('game-ui'), versions).peerDependencies).toEqual({ react: '^19.2.8', 'react-dom': '^19.2.8' });
	});

	it('names game-server\'s siblings under their published names', () => {
		const deps = publishManifest(read('game-server'), versions).dependencies!;
		expect(deps['@wolffm/service-kernel']).toBe(versions('@wolffm/service-kernel'));
		expect(deps['@wolffm/platform-wire']).toBe(versions('@wolffm/platform-wire'));
	});

	it('refuses an alias whose key and target disagree, a non-source export, and an unpublished sibling', () => {
		const kernel = read('service-kernel');
		expect(() => publishManifest({ ...kernel, dependencies: { '@wolffm/rooms-server': 'npm:@hadoku/rooms-protocol@1.0.0' } }, versions)).toThrow(/aliases @hadoku\/rooms-protocol/);
		expect(() => publishManifest({ ...kernel, exports: { './auth': './dist/auth/index.js' } }, versions)).toThrow(/not \.\/src\/<path>\.ts/);
		expect(() => publishManifest({ ...kernel, dependencies: { '@hadoku/shared': 'workspace:*' } }, versions)).toThrow(/does not publish/);
		expect(() => publishManifest({ ...kernel, name: '@hadoku/shared' }, versions)).toThrow(/not a package this repo publishes/);
	});

	it('leaves the workspace manifest alone', () => {
		const workspace = read('game-ui');
		publishManifest(workspace, versions);
		expect(workspace.name).toBe('@hadoku/game-ui');
		expect(workspace.private).toBe(true);
	});

	it('is published in the same order the workflow publishes it, a package after its siblings', () => {
		const workflow = readFileSync(join(REPO, '.github', 'workflows', 'publish-kernel.yml'), 'utf8');
		const legs = [...workflow.matchAll(/- \{ package: ([a-z-]+), npmjs: (NPMJS_[A-Z_]+) \}/g)];
		expect(legs.map((m) => m[1])).toEqual([...PUBLISHED]);
		for (const m of legs) expect(m[2]).toBe(`NPMJS_${m[1]!.toUpperCase().replaceAll('-', '_')}`);
		for (const [i, name] of PUBLISHED.entries()) {
			const workspace = read(name);
			for (const [dep, spec] of Object.entries({ ...workspace.dependencies, ...workspace.peerDependencies })) {
				if (spec.startsWith('workspace:')) expect(PUBLISHED.indexOf(dep.replace('@hadoku/', '') as (typeof PUBLISHED)[number]), `${name} → ${dep}`).toBeLessThan(i);
			}
		}
	});
});

describe('the published build', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});
	function tree(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), 'publish-plan-'));
		dirs.push(root);
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, 'src', file)), { recursive: true });
			writeFileSync(join(root, 'src', file), text);
		}
		return join(root, 'src');
	}

	it('leaves out tests, fixtures, a file that leaves the package and everything that imports one', () => {
		const p = plan(
			tree({
				'a.ts': "import { b } from './b.js';\nimport './look.css';",
				'b.ts': "export const b = 1;",
				'look.css': '.x {}',
				'a.test.ts': "import { a } from './a.ts';",
				'help.testing.ts': '',
				'uses-vitest.ts': "import { it } from 'vitest';",
				'fixtures/toy.ts': '',
				'escapes.ts': "import x from '../../../hosting.json' with { type: 'json' };",
				'via.tsx': "import { y } from './escapes.ts';",
				'via2.ts': "export * from './via.js';",
			}),
		);
		expect(p.keep).toEqual(['a.ts', 'b.ts']);
		expect(p.assets).toEqual(['look.css']);
		expect(Object.fromEntries(p.dropped.map((d) => [d.file, d.why]))).toEqual({
			'a.test.ts': 'test or test support',
			'escapes.ts': 'imports ../../../hosting.json, outside the package',
			'fixtures/toy.ts': 'test or test support',
			'help.testing.ts': 'test or test support',
			'uses-vitest.ts': 'imports a test library',
			'via.tsx': 'imports escapes.ts, which is left out',
			'via2.ts': 'imports via.tsx, which is left out',
		});
	});

	it('leaves out what the package lists in publishLeaveOut, a directory or one file, and its importers', () => {
		const p = plan(
			tree({
				'kernel.ts': "export const k = 1;",
				'hosting/fleet.ts': "export const hosts = ['node-a'];",
				'hosting/deep/rules.ts': '',
				'one.ts': '',
				'uses-hosting.ts': "import { hosts } from './hosting/fleet.js';",
				'hostingless.ts': '',
			}),
			['hosting/', 'one.ts'],
		);
		expect(p.keep).toEqual(['hostingless.ts', 'kernel.ts']);
		expect(Object.fromEntries(p.dropped.map((d) => [d.file, d.why]))).toEqual({
			'hosting/deep/rules.ts': 'under publishLeaveOut hosting/',
			'hosting/fleet.ts': 'under publishLeaveOut hosting/',
			'one.ts': 'under publishLeaveOut one.ts',
			'uses-hosting.ts': 'imports hosting/fleet.ts, which is left out',
		});
	});

	it('points a declaration\'s relative .ts/.tsx specifiers at .js, and nothing else', () => {
		const text = "export * from './a.ts';\nimport type { B } from \"../b.tsx\";\nexport type C = import('./c.ts').C;\nimport x from 'pkg/x.ts';";
		expect(repointDeclaration(text)).toBe("export * from './a.js';\nimport type { B } from \"../b.js\";\nexport type C = import('./c.js').C;\nimport x from 'pkg/x.ts';");
	});

	it('renames a published sibling\'s import and leaves every other @hadoku name', () => {
		const text = "import { a } from '@hadoku/platform-wire/look';\nconst m = import(\"@hadoku/game-ui/http.ts\");\nimport '@hadoku/shared';\n// @hadoku/platform-wire in a comment";
		expect(renameSiblings(text)).toBe("import { a } from '@wolffm/platform-wire/look';\nconst m = import(\"@wolffm/game-ui/http.ts\");\nimport '@hadoku/shared';\n// @hadoku/platform-wire in a comment");
	});
});
