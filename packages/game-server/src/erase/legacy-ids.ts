/**
 * `legacy-ids.done.json`: the record the R12 identity reset's one-off remap left behind on
 * prod (old key-derived id → the userId it was moved to). Nothing reads it any more, but it
 * names people by userId, so an erase removes the person's entries from it. Absent is fine.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { EraseStep } from './index.js';

export function legacyIdsStep(file: string): EraseStep {
	return {
		what: 'legacyIds',
		erase: ({ userId }) => {
			if (!existsSync(file)) return 0;
			const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
			const theirs = Object.keys(map).filter((old) => map[old] === userId);
			if (theirs.length === 0) return 0;
			for (const old of theirs) delete map[old];
			writeFileSync(`${file}.tmp`, JSON.stringify(map));
			renameSync(`${file}.tmp`, file);
			return theirs.length;
		},
	};
}
