/**
 * An ask the server cannot parse, still answered by the player.
 *
 * Forge's game thread is parked on every ask until it is answered, and an
 * abort answers most of them with a null many effects do not check
 * (`match.ts`'s "Asks"). So an ask frame that fails forge-wire's schema is
 * neither dropped nor aborted: it is shown as a plain `getChoices` of its
 * whole answers, read leniently off the raw frame, and the keys the browser
 * picks are turned back into the answer Forge's method takes. The bridge
 * resolves that answer exactly as it would the real prompt's
 * (`PlayBridge.SeatGui.lookup`/`byKeys`), so it can be no less valid than one.
 *
 * Only the methods whose answer is a pick among what the frame itself lists
 * have a fallback; for any other, {@link fallbackFor} is null and the ask
 * stays open, logged `ask-unparsed` and `ask-unclassified`.
 *
 * The pick keeps the ask's own minimum. Whether the seat can meet it is the
 * one rule's (`auto.ts`'s `answerability`), which `match.ts` asks of the
 * fallback exactly as of any parsed ask: fewer answers than the minimum is
 * answered with every one, never shown.
 */

import { safeParseServerFrame, type ServerFrame } from '@hadoku/forge-wire';

type Raw = Record<string, unknown>;

export interface Fallback {
	/** The `getChoices` the seat is shown, under the real ask's callId. */
	frame: Extract<ServerFrame, { kind: 'ask'; method: 'getChoices' }>;
	/** The chosen keys → the answer Forge's real method takes. */
	answer(keys: readonly string[]): unknown;
}

interface Candidate {
	label: string;
	value: unknown;
}

const isRef = (v: unknown): v is { kind: string; id: number } =>
	typeof v === 'object' && v !== null && typeof (v as Raw).kind === 'string' && typeof (v as Raw).id === 'number';

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) ? v : fallback);

const MANA_WORD: Readonly<Record<number, string>> = { 0: 'colorless', 1: 'white', 2: 'blue', 4: 'black', 8: 'red', 16: 'green' };

/**
 * Every way to place `total` over the entries, each within its own maximum —
 * the whole answers of a division. Capped: a division with more answers than
 * a list can usefully show has no fallback.
 */
function divisions(maxes: readonly number[], total: number, atLeastOne: boolean, cap = 60): number[][] | null {
	const out: number[][] = [];
	const walk = (i: number, left: number, picked: number[]): boolean => {
		if (i === maxes.length) {
			if (left === 0) out.push(picked);
			return out.length <= cap;
		}
		for (let n = Math.min(left, maxes[i]!); n >= (atLeastOne ? 1 : 0); n -= 1) if (!walk(i + 1, left - n, [...picked, n])) return false;
		return true;
	};
	return walk(0, total, []) ? out : null;
}

/** The method's whole answers, or null when it has no fallback. `min`/`max` bound how many may be picked. */
function candidates(raw: Raw, name: (ref: { kind: string; id: number }) => string): { list: Candidate[]; min: number; max: number; many: boolean } | null {
	const refLabel = (v: unknown, i: number): string =>
		isRef(v) ? name(v) : typeof (v as Raw | null)?.label === 'string' ? ((v as Raw).label as string) : `option ${i + 1}`;
	switch (raw.method) {
		case 'getChoices': {
			if (!Array.isArray(raw.choices)) return null;
			const list = (raw.choices as Raw[]).map((c, i) => ({
				label: typeof c?.label === 'string' && c.label !== '' ? c.label : isRef(c?.ref) ? name(c.ref) : `option ${i + 1}`,
				value: c?.key,
			}));
			if (list.some((c) => typeof c.value !== 'string')) return null;
			return { list, min: num(raw.min, 1), max: num(raw.max, 1), many: true };
		}
		case 'chooseSingleEntityForEffect':
		case 'getAbilityToPlay': {
			const items = raw.method === 'getAbilityToPlay' ? raw.abilities : raw.optionList;
			if (!Array.isArray(items)) return null;
			const optional = raw.method === 'getAbilityToPlay' || raw.isOptional === true;
			return { list: items.map((v, i) => ({ label: refLabel(v, i), value: v })), min: optional ? 0 : 1, max: 1, many: false };
		}
		case 'chooseEntitiesForEffect': {
			if (!Array.isArray(raw.optionList)) return null;
			return { list: raw.optionList.map((v, i) => ({ label: refLabel(v, i), value: v })), min: num(raw.min, 0), max: num(raw.max, raw.optionList.length), many: true };
		}
		case 'confirm':
		case 'showConfirmDialog':
			return { list: [{ label: 'Yes', value: true }, { label: 'No', value: false }], min: 1, max: 1, many: false };
		case 'showOptionDialog': {
			if (!Array.isArray(raw.options)) return null;
			return { list: raw.options.map((o, i) => ({ label: typeof o === 'string' ? o : `option ${i + 1}`, value: i })), min: 1, max: 1, many: false };
		}
		case 'assignGenericAmount': {
			if (!Array.isArray(raw.target) || typeof raw.amount !== 'number') return null;
			const entries = raw.target as Raw[];
			const keyLabel = (key: unknown, i: number): string => {
				const k = key as Raw | null;
				if (typeof k?.color === 'number') return MANA_WORD[k.color] ?? `colour ${k.color}`;
				return isRef(k?.ref) ? name(k.ref) : `target ${i + 1}`;
			};
			const all = divisions(entries.map((e) => num(e?.amount, raw.amount as number)), raw.amount, raw.atLeastOne === true);
			if (all === null) return null;
			const list = all.map((amounts) => ({
				label: amounts.flatMap((n, i) => (n > 0 ? [`${n} ${keyLabel(entries[i]?.key, i)}`] : [])).join(', '),
				value: amounts.map((n, i) => ({ key: entries[i]?.key, amount: n })),
			}));
			return { list, min: 1, max: 1, many: false };
		}
		default:
			return null;
	}
}

export function fallbackFor(raw: unknown, callId: string, name: (ref: { kind: string; id: number }) => string): Fallback | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const r = raw as Raw;
	// A card-name ask is already a pick: each name its own key, drawn as a search.
	if (r.method === 'getChoices' && Array.isArray(r.names) && r.names.every((n) => typeof n === 'string')) {
		const parsed = safeParseServerFrame({ kind: 'ask', callId, method: 'getChoices', message: typeof r.message === 'string' ? r.message : 'Name a card', min: num(r.min, 1), max: num(r.max, 1), choices: [], names: r.names, selected: [] });
		if (!parsed.ok || parsed.value.kind !== 'ask' || parsed.value.method !== 'getChoices') return null;
		return { frame: parsed.value, answer: (keys) => [...keys] };
	}
	const found = candidates(r, name);
	if (found === null || found.list.length === 0) return null;
	const message = [(raw as Raw).message, (raw as Raw).title, (raw as Raw).question].find((m): m is string => typeof m === 'string' && m !== '') ?? `Choose (${String((raw as Raw).method)})`;
	const parsed = safeParseServerFrame({
		kind: 'ask',
		callId,
		method: 'getChoices',
		message,
		min: found.min,
		max: Math.min(found.max, found.list.length),
		choices: found.list.map((c, i) => ({ key: String(i), label: c.label, ref: null })),
		selected: [],
	});
	if (!parsed.ok || parsed.value.kind !== 'ask' || parsed.value.method !== 'getChoices') return null;
	const { list, many } = found;
	return {
		frame: parsed.value,
		answer(keys) {
			const picked = keys.map((k) => list[Number(k)]?.value).filter((v) => v !== undefined);
			return many ? picked : (picked[0] ?? null);
		},
	};
}
