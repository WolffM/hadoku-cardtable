/**
 * Anonymising a shared record (account erase, `index.ts`): a room, a pod, a tournament or an
 * event that other players own too keeps its shape, and the erased person in it becomes a
 * placeholder id nobody can be traced back to.
 *
 * One mechanism for every store, so a store's erase is "which object to walk"
 * and never a list of the fields that happen to hold an id today: a field added
 * tomorrow is covered without anyone remembering this file.
 *
 * An account merge walks the same way (`renameIds`, `moveIds`): the merged-away person's ids
 * become the kept account's, each to its own counterpart (a userId to a userId, a derived
 * participant id to a derived participant id), rather than every id to one placeholder.
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
	return renameIds(value, new Map([...ids].map((id) => [id, to])));
}

/**
 * `replaceIds` with each id renamed to its own new id (`renames`: old → new). Where a renamed
 * key meets one that is already there (an object key, a Map key, a Set member), the one already
 * there wins and the renamed entry is dropped: the kept account's own entry is never overwritten.
 * Answers how many it renamed or dropped.
 */
export function renameIds(value: unknown, renames: ReadonlyMap<string, string>): number {
	const seen = new WeakSet<object>();
	const swap = (v: unknown): { v: unknown; n: number } => {
		const to = typeof v === 'string' ? renames.get(v) : undefined;
		return to === undefined ? { v, n: walk(v) } : { v: to, n: 1 };
	};

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
				if (key.v !== k) {
					node.delete(k);
					if (!node.has(key.v)) node.set(key.v, val.v);
				} else if (val.v !== v) node.set(k, val.v);
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
				const to = renames.get(k);
				if (to !== undefined) {
					delete record[k];
					if (!Object.hasOwn(record, to)) record[to] = val.v;
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

/** Does any string in `ids` sit anywhere in `value`, by the same walk `replaceIds` makes? Writes nothing. */
export function namesAny(value: unknown, ids: ReadonlySet<string>): boolean {
	const seen = new WeakSet<object>();
	const hit = (v: unknown): boolean => (typeof v === 'string' ? ids.has(v) : visit(v));
	function visit(node: unknown): boolean {
		if (node === null || typeof node !== 'object' || seen.has(node)) return false;
		seen.add(node);
		if (Array.isArray(node)) return node.some(hit);
		if (node instanceof Map) return [...node].some(([k, v]) => hit(k) || hit(v));
		if (node instanceof Set) return [...node].some(hit);
		return Object.entries(node as Record<string, unknown>).some(([k, v]) => ids.has(k) || hit(v));
	}
	return visit(value);
}

/** One merge's two people, as `moveIds` reads them (`erase.ts`'s `MergedAccounts` is one). */
export interface IdMove {
	/** The kept account's ids. */
	into: { ids: ReadonlySet<string> };
	/** Each of the merged-away account's ids → the kept account's counterpart. */
	renames: ReadonlyMap<string, string>;
}

/**
 * Account merge in one shared record: the merged-away person's ids become the kept account's,
 * unless the record already names the kept account. Such a record is a conflict (one person in
 * it twice: a match between their two accounts, a room both sat in), and the kept account's
 * place in it wins: the record is left alone, and the account erase that follows every merge
 * anonymises the merged-away person's place in it as it would for anyone. Answers how many ids
 * it renamed, 0 for a conflict or a record that names neither.
 */
export function moveIds(value: unknown, move: IdMove): number {
	if (namesAny(value, move.into.ids)) return 0;
	return renameIds(value, move.renames);
}
