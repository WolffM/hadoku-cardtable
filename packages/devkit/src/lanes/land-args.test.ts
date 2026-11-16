import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Both scripts read their arguments before they load a config or touch git, so a refusal is
 * provable with no repo behind it: DEVKIT_ROOT names a directory that does not exist, and a
 * call that got past its arguments would stop on that (exit 2 too, but with the config's message).
 */
const run = (script: string, args: string[]) =>
	spawnSync('bash', [join(import.meta.dirname, script), ...args], {
		env: { ...process.env, DEVKIT_ROOT: '/nonexistent/devkit-root' },
		encoding: 'utf8',
	});

describe('land-worktree.sh arguments', () => {
	it.each([
		['a flag after the worktree', ['some-wave', '--dry-run']],
		['an unknown flag', ['--dryrun', 'some-wave']],
		['an unknown flag alone', ['--plan']],
		['a second worktree', ['some-wave', 'other-wave']],
		['--dry-run twice', ['--dry-run', '--dry-run', 'some-wave']],
		['--dry-run and no worktree', ['--dry-run']],
		['nothing', []],
	])('refuses %s with the usage line', (_what, args) => {
		const r = run('land-worktree.sh', args);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^usage: land-worktree\.sh \[--dry-run\] </);
		expect(r.stdout).toBe('');
	});

	it.each([[['some-wave']], [['--dry-run', 'some-wave']], [['--dry-run', '/abs/path']]])('reads %j past its arguments', (args) => {
		expect(run('land-worktree.sh', args).stderr).not.toMatch(/^usage:/);
	});
});

describe('land.sh arguments', () => {
	it.each([
		['a misspelt flag', ['--dryrun']],
		['a positional', ['some-wave']],
		['a second argument', ['--dry-run', 'some-wave']],
	])('refuses %s with the usage line', (_what, args) => {
		const r = run('land.sh', args);
		expect(r.status).toBe(2);
		expect(r.stderr).toBe('usage: land.sh [--dry-run]\n');
	});

	it.each([[[]], [['--dry-run']]])('reads %j past its arguments', (args) => {
		expect(run('land.sh', args).stderr).not.toMatch(/^usage:/);
	});
});
