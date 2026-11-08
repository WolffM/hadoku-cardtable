/**
 * Anonymising a shared record (account erase, `index.ts`): a room, a pod, a tournament or an
 * event that other players own too keeps its shape, and the erased person in it becomes a
 * placeholder id nobody can be traced back to.
 *
 * One mechanism for every store, so a store's erase is "which object to walk"
 * and never a list of the fields that happen to hold an id today: a field added
 * tomorrow is covered without anyone remembering this file.
 */

import { randomBytes } from 'node:crypto';

/** The id an erased person becomes: fresh per erase, so two erased people never merge into one. */
export function placeholderId(): string {
	return `erased:${randomBytes(4).toString('hex')}`;
}

/**
 * Replace every string in `ids` with `to`, in place, wherever it sits in `value`: a string
 * value, an array element, an object key, a Map key or value, a Set member. Functions are
 * left alone, an object reached twice is walked once, and nothing is written that does not
 * change (a record may share a frozen constant). Answers how many it replaced.
 */
export function replaceIds(value: unknown, ids: ReadonlySet<string>, to: string): number {
	const seen = new WeakSet<object>();
	const swap = (v: unknown): { v: unknown; n: number } => (typeof v === 'string' && ids.has(v) ? { v: to, n: 1 } : { v, n: walk(v) });

	function walk(node: unknown): number {
		if (node === null || typeof node !== 'object' || seen.has(node)) return 0;
		seen.add(node);
		let n = 0;
		if (Array.isArray(node)) {
			for (let i = 0; i < node.length; i++) {
				const r = swap(node[i]);
				if (r.v !== node[i]) node[i] = r.v;
				n += r.n;
			}
		} else if (node instanceof Map) {
			for (const [k, v] of [...node]) {
				const key = swap(k);
				const val = swap(v);
				if (key.v !== k) node.delete(k);
				if (key.v !== k || val.v !== v) node.set(key.v, val.v);
				n += key.n + val.n;
			}
		} else if (node instanceof Set) {
			for (const m of [...node]) {
				const r = swap(m);
				if (r.v !== m) {
					node.delete(m);
					node.add(r.v);
				}
				n += r.n;
			}
		} else {
			const record = node as Record<string, unknown>;
			for (const k of Object.keys(record)) {
				const val = swap(record[k]);
				if (ids.has(k)) {
					delete record[k];
					record[to] = val.v;
					n += 1 + val.n;
				} else {
					if (val.v !== record[k]) record[k] = val.v;
					n += val.n;
				}
			}
		}
		return n;
	}

	return walk(value);
}
