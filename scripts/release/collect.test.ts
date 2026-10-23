import { describe, expect, it } from 'vitest';

import { changedRows, parseLedgerRow, render } from './collect.ts';

const ROW = '| AF374 | (2026-10-23, operator) "concede from the card" | 1 | **built** | `table-actions.test.ts` | Press Concede game on your card | ✅ |';

describe('parseLedgerRow', () => {
	it('reads the columns a release note needs', () => {
		expect(parseLedgerRow(ROW)).toEqual({
			id: 'AF374',
			item: '(2026-10-23, operator) "concede from the card"',
			status: '**built**',
			checkItBy: 'Press Concede game on your card',
			operatorCheck: '✅',
		});
	});

	it('reads the last two columns from the right when a row carries an extra design column', () => {
		const row = parseLedgerRow('| AF373 | asked | 1 | **built** | how it works | `match.test.ts` | Watch another table, go back | |');
		expect(row?.checkItBy).toBe('Watch another table, go back');
		expect(row?.operatorCheck).toBe('');
	});

	it('keeps an escaped pipe inside a cell', () => {
		expect(parseLedgerRow('| AF1 | a \\| b | 1 | done | e | c | |')?.item).toBe('a \\| b');
	});

	it('is null for headers, separators and prose', () => {
		expect(parseLedgerRow('| ID | item | asked | status | evidence | check it by | your check |')).toBeNull();
		expect(parseLedgerRow('| --- | --- |')).toBeNull();
		expect(parseLedgerRow('AF374 was built')).toBeNull();
	});
});

describe('changedRows', () => {
	it('takes added lines only, the newest version of each row', () => {
		const diff = [
			'--- a/docs/planning/playtest-ledger.md',
			'+++ b/docs/planning/playtest-ledger.md',
			'-| AF2 | old | 1 | open | | | |',
			'+| AF2 | old | 1 | built | | see it | |',
			'+| AF3 | new | 1 | built | | see it too | |',
			'-| AF9 | removed | 1 | built | | | |',
			'+| AF2 | old | 2 | done | | see it now | |',
		].join('\n');
		expect(changedRows(diff).map((row) => [row.id, row.status, row.checkItBy])).toEqual([
			['AF2', 'done', 'see it now'],
			['AF3', 'built', 'see it too'],
		]);
	});
});

describe('render', () => {
	it('lists rows then commits', () => {
		const text = render({ since: 'release/v0.33.0', to: 'origin/main' }, [parseLedgerRow(ROW)!], [{ sha: 'abc1234', subject: 'fix: a thing' }]);
		expect(text).toContain('# Release content: release/v0.33.0..origin/main');
		expect(text).toContain('### AF374 — **built**');
		expect(text).toContain('- a player sees it by: Press Concede game on your card');
		expect(text).toContain("- operator's check: ✅");
		expect(text).toContain('- abc1234 fix: a thing');
	});
});
