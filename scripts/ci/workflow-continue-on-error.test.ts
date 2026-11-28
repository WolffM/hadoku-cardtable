import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(import.meta.dirname, '..', '..', '.github', 'workflows');

// On a `uses:` step the runner evaluates continue-on-error with `steps` empty,
// so `${{ steps.x.outputs.live != 'true' }}` is always true there. That is how
// game-server's refused live npmjs publish stayed green for a day
// (hadoku-actions#12, measured on runner 2.338.2). A `run:` step evaluates it
// correctly, so only `uses:` steps are held to this.
function offenders(file: string, text: string): string[] {
	const found: string[] = [];
	for (const step of text.split(/^\s*- (?=name:|id:|uses:|run:|if:|continue-on-error:|env:|with:)/m)) {
		const coe = /^\s*continue-on-error:\s*(.+)$/m.exec(step);
		if (coe && /\bsteps\./.test(coe[1]!) && /^\s*uses:/m.test(step)) found.push(`${file}: ${coe[1]!.trim()}`);
	}
	return found;
}

describe('workflow continue-on-error', () => {
	it('never reads steps.* on a uses: step', () => {
		const found = readdirSync(WORKFLOWS)
			.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
			.flatMap((f) => offenders(f, readFileSync(join(WORKFLOWS, f), 'utf8')));
		expect(found).toEqual([]);
	});

	it('catches the shape that hid the refusal, and lets a run: step through', () => {
		const caught = `
      - name: Stage for npmjs
        continue-on-error: \${{ steps.npmjs.outputs.live != 'true' }}
        uses: WolffM/hadoku-actions/publish-npmjs@v1
`;
		const fine = `
      - name: probe
        continue-on-error: \${{ steps.npmjs.outputs.live != 'true' }}
        run: exit 1
      - name: Stage for npmjs
        continue-on-error: \${{ vars[matrix.npmjs] != 'live' }}
        uses: WolffM/hadoku-actions/publish-npmjs@v1
`;
		expect(offenders('caught.yml', caught)).toHaveLength(1);
		expect(offenders('fine.yml', fine)).toEqual([]);
	});
});
