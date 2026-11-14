import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fixtureConfig, writeConfig } from '../config.testing.ts';

const SCRIPT = join(import.meta.dirname, 'claim.sh');
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch repo root whose devkit.config.json keeps its state under it. */
function scratchApp(): { root: string; stateDir: string } {
	const root = mkdtempSync(join(tmpdir(), 'claim-test-'));
	dirs.push(root);
	const stateDir = join(root, 'state');
	writeConfig(root, fixtureConfig(stateDir));
	return { root, stateDir };
}

const claim = (root: string, area: string, owner: string, extra: NodeJS.ProcessEnv = {}) =>
	spawnSync('bash', [SCRIPT, 'claim', area, owner], { env: { ...process.env, DEVKIT_ROOT: root, ...extra }, encoding: 'utf8' });

/** Claims `held` as one owner in a fresh file, then `asked` as another: true when the second is refused. */
function collides(held: string, asked: string): boolean {
	const { root } = scratchApp();
	expect(claim(root, held, 'first').status).toBe(0);
	const second = claim(root, asked, 'second');
	expect([0, 1]).toContain(second.status);
	return second.status === 1;
}

describe('claim.sh overlaps', () => {
	it.each([
		['apps/ui/src/play/Board.tsx', 'apps/ui/src/play/Board.tsx#command'],
		['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/Board.tsx'],
		['apps/ui/src/play/', 'apps/ui/src/play/Board.tsx#command'],
		['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play'],
		['apps/ui/src/play/*.tsx', 'apps/ui/src/play/Board.tsx#command'],
		['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/**/Board.tsx'],
		['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/Board.tsx#command'],
		['apps/ui/src/play/Board.tsx', 'apps/ui/src/play/Board.tsx'],
		['e2e/*.spec.ts', 'e2e/room-mode.spec.ts'],
	])('%s blocks %s', (held, asked) => {
		expect(collides(held, asked)).toBe(true);
	});

	it.each([
		['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/Board.tsx#departures'],
		['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/board.css#command'],
		['apps/ui/src/play/Board.tsx', 'apps/ui/src/play/Board.test.tsx'],
		['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/Board.tsxx'],
		['cost-payment', 'apps/ui/src/play/Board.tsx#cost-payment'],
	])('%s leaves %s free', (held, asked) => {
		expect(collides(held, asked)).toBe(false);
	});
});

describe('claim.sh reads its file from the app config', () => {
	it("writes to the config's claims file, <stateDir>/claims.tsv by default", () => {
		const { root, stateDir } = scratchApp();
		expect(claim(root, 'docs/', 'me').status).toBe(0);
		expect(readFileSync(join(stateDir, 'claims.tsv'), 'utf8')).toMatch(/^docs\/\tme\t\d+\t\n$/);
	});

	it('takes <envPrefix>_CLAIMS over the config', () => {
		const { root, stateDir } = scratchApp();
		const file = join(root, 'elsewhere.tsv');
		expect(claim(root, 'docs/', 'me', { FIXTURE_CLAIMS: file }).status).toBe(0);
		expect(readFileSync(file, 'utf8')).toContain('docs/\tme');
		expect(existsSync(join(stateDir, 'claims.tsv'))).toBe(false);
	});

	it('refuses to run, naming the field, when the config does not validate', () => {
		const root = mkdtempSync(join(tmpdir(), 'claim-test-'));
		dirs.push(root);
		writeConfig(root, { ...fixtureConfig(join(root, 'state')), appId: 'Not An Id' });
		const got = claim(root, 'docs/', 'me');
		expect(got.status).toBe(2);
		expect(got.stderr).toContain('appId: lower-case letters');
	});
});
