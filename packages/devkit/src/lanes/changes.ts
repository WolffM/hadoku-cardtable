/**
 * A branch's changes in the shape of GitHub's compare API `files`: `[{ filename, status,
 * previous_filename?, patch? }]`, from git alone, for a proof's selection hook to read the way
 * the proof workflow reads the real compare.
 *
 *   node packages/devkit/src/lanes/changes.ts <repo> <base> <head> > changes.json
 *
 * Three-dot, as a dispatch's compare is: the branch's own commits since it left `base`.
 */
import { execFileSync } from 'node:child_process';

export interface Change {
	filename: string;
	status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
	previous_filename?: string;
	patch?: string;
}

const STATUS: Record<string, Change['status']> = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'changed' };

/** `git diff --name-status -z` output as changes, without patches. */
export function parseNameStatus(z: string): Change[] {
	const parts = z.split('\0').filter((p) => p !== '');
	const out: Change[] = [];
	for (let i = 0; i < parts.length; ) {
		const code = parts[i++];
		const status = STATUS[code[0]] ?? 'changed';
		if (code[0] === 'R' || code[0] === 'C') {
			const from = parts[i++];
			out.push({ filename: parts[i++], status, previous_filename: from });
		} else out.push({ filename: parts[i++], status });
	}
	return out;
}

export function changes(repo: string, base: string, head: string): Change[] {
	const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	const range = `${base}...${head}`;
	return parseNameStatus(git('diff', '--name-status', '-z', '-M', range)).map((c) => {
		// GitHub's patch is the hunks without the file header.
		const patch = git('diff', '-M', range, '--', ...(c.previous_filename ? [c.previous_filename, c.filename] : [c.filename]))
			.split('\n')
			.filter((line, i, all) => i >= all.findIndex((l) => l.startsWith('@@')))
			.join('\n');
		return patch.includes('@@') ? { ...c, patch } : c;
	});
}

if (import.meta.main) {
	const [repo, base, head] = process.argv.slice(2);
	if (!repo || !base || !head) {
		console.error('usage: changes.ts <repo> <base> <head>');
		process.exit(2);
	}
	console.log(JSON.stringify(changes(repo, base, head), null, 2));
}
