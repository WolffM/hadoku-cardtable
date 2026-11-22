#!/usr/bin/env node
/**
 * The motion ratchet: the lines with a direct `.animate(` or `requestAnimationFrame(` in a game's or an app's
 * source, tests aside, per file. Games move through `@hadoku/ui-shell/motion` (`animate()`, `everyFrame`), so a
 * count may only fall (`ratchet.test.ts`). Run, this writes `baseline.json`, refusing (exit 1) when one rose.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
export const BASELINE_PATH = join(import.meta.dirname, 'baseline.json');
export const CALLS = ['.animate(', 'requestAnimationFrame('] as const;
export type Counts = Record<(typeof CALLS)[number], Record<string, number>>;

function count(call: string): Record<string, number> {
	const args = ['grep', '-c', '--untracked', '-F', call, '--', 'games/**/*.ts', 'games/**/*.tsx', 'apps/**/*.ts', 'apps/**/*.tsx', ':!*.test.ts', ':!*.test.tsx', ':!*.spec.ts'];
	let out = '';
	try {
		out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
	} catch (e) {
		if ((e as { status?: number }).status !== 1) throw e; // 1: none left anywhere
	}
	return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => [l.slice(0, l.lastIndexOf(':')), Number(l.slice(l.lastIndexOf(':') + 1))]));
}

export const countCalls = (): Counts => Object.fromEntries(CALLS.map((c) => [c, count(c)])) as Counts;
export const total = (byFile: Record<string, number>): number => Object.values(byFile).reduce((a, b) => a + b, 0);

/** Every file whose count of `call` is above `baseline`'s, as `file: now (baseline n)`. */
export const risen = (now: Counts, baseline: Counts, call: (typeof CALLS)[number]): string[] =>
	Object.entries(now[call])
		.filter(([file, n]) => n > (baseline[call][file] ?? 0))
		.map(([file, n]) => `${file}: ${n} ${call} (baseline ${baseline[call][file] ?? 0})`);

if (import.meta.main) {
	const now = countCalls();
	const before = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Counts;
	const up = CALLS.flatMap((call) => risen(now, before, call));
	if (up.length > 0) {
		console.error(`motion baseline: refused, ${up.length} file(s) rose:\n${up.join('\n')}\nUse animate()/everyFrame from @hadoku/ui-shell/motion.`);
		process.exit(1);
	}
	writeFileSync(BASELINE_PATH, `${JSON.stringify(now, null, '\t')}\n`);
	for (const call of CALLS) console.log(`${call} ${total(now[call])} (was ${total(before[call])})`);
}
