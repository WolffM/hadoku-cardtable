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

describe('prove-and-land.sh arguments', () => {
	// Everything after the worktree is handed to `gh workflow run`, after the rebase and the verify
	// push: a stray flag there (2026-11-28, `<worktree> --plan -f full=true`) rebased and pushed the
	// branch before gh refused it. It is refused first, with no repo behind it.
	it.each([
		['--plan after the worktree', ['some-wave', '--plan', '-f', 'full=true']],
		['--dry-run after the worktree', ['some-wave', '-f', 'full=true', '--dry-run']],
		['an unknown flag', ['--dryrun', 'some-wave', '-f', 'full=true']],
		['a field with no value', ['some-wave', '-f']],
		['a field that is not key=value', ['some-wave', '-f', 'full']],
		['a bare word', ['some-wave', 'full=true']],
		['no worktree', ['--dry-run']],
	])('refuses %s with the usage line', (_what, args) => {
		const r = run('prove-and-land.sh', args);
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(/^scripts\/lanes\/prove-and-land\.sh \[--dry-run\] </);
		expect(r.stdout).toBe('');
	});

	it.each([[['some-wave', '-f', 'full=true']], [['--plan', 'some-wave']], [['--dry-run', '/abs/path', '-f', 'only=e2e', '-F', 'specs=a b']]])(
		'reads %j past its arguments',
		(args) => {
			expect(run('prove-and-land.sh', args).stderr).not.toMatch(/^scripts\/lanes\/prove-and-land\.sh \[--dry-run\] </);
		},
	);
});
