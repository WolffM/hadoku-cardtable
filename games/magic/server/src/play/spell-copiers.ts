/*
 * Which cards copy a spell, read off Forge's own card scripts.
 *
 * The operator, 2026-10-19: *"for instant cards that copy spells like lutri and
 * others of that nature can we default to having the player hold priority after
 * casting any spell that is a valid target for those? (assuming the copy spell is
 * playable)"*. `auto.ts`'s `judgeStop` passes the caster's priority on its own
 * spell (Q17, `own-spell`); this index is what lets it keep that window when the
 * seat holds a playable copier the spell is a target for (`copy-available`).
 *
 * The index is Forge's `CopySpellAbility` scripts, never a hand-kept list:
 *
 *  - `A:SP$ CopySpellAbility | ValidTgts$ Instant,Sorcery | TargetType$ Spell`
 *    (Twincast, Reverberate) — copied by CASTING the card;
 *  - an `ETB` or "when you cast this" trigger whose `Execute$` SVar is one
 *    (Lutri, Dualcaster Mage) — copied by casting it too;
 *  - `A:AB$ CopySpellAbility` (Izzet Guildmage) — copied by ACTIVATING it, so
 *    from the battlefield.
 *
 * A copy reached through `SubAbility$`, `Execute$` or a charm's `Choices$` counts
 * as the ability it hangs off. A copy that names no target (`Defined$`, "copy
 * it") is a trigger the seat never chooses to play, and is left out, as is one
 * whose `TargetType$` takes only abilities (Strionic Resonator's
 * `Triggered.YouCtrl`): it cannot copy a spell.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** How a copier's copy is played: by casting the card, or by activating it on the battlefield. */
export type CopyVia = 'cast' | 'activate';

/** One spell-copying ability: Forge's own `ValidTgts$` terms, and its `TargetType$` when it has one. */
export interface SpellCopy {
	readonly via: CopyVia;
	readonly validTgts: readonly string[];
	readonly targetType: readonly string[] | null;
}

/** Card face name → its spell-copying abilities. */
export type SpellCopierIndex = ReadonlyMap<string, readonly SpellCopy[]>;

/** `Key$ Value | Key$ Value` → a map, Forge's own ability-line shape. */
function params(line: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of line.split('|')) {
		const at = part.indexOf('$');
		if (at < 0) continue;
		out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
	}
	return out;
}

const terms = (value: string): string[] => value.split(',').map((t) => t.trim()).filter((t) => t !== '');

/** A `TargetType$` term that can name a SPELL — not only an activated or triggered ability. */
const SPELL_TARGET_TYPE = /^(Spell|SpellAbility|Instant|Sorcery|Card)(\.|$)/;

/**
 * How the seat sets off a trigger by playing the card itself — casting it (it is cast,
 * or it enters), or turning it face up on the battlefield — or null for a trigger the
 * seat does not choose to set off ("whenever you cast an instant").
 */
function playedTrigger(trigger: Map<string, string>): CopyVia | null {
	if (!(trigger.get('ValidCard') ?? '').split(/[.+]/).includes('Self')) return null;
	const mode = trigger.get('Mode');
	if ((mode === 'ChangesZone' && trigger.get('Destination') === 'Battlefield') || mode === 'SpellCast') return 'cast';
	return mode === 'TurnFaceUp' ? 'activate' : null;
}

/** Every face of one card script, with the spell copies each face's own abilities reach. */
export function parseCardScript(text: string): { name: string; copies: SpellCopy[] }[] {
	const faces: string[][] = [[]];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === 'ALTERNATE') faces.push([]);
		else faces[faces.length - 1]!.push(line);
	}
	const out: { name: string; copies: SpellCopy[] }[] = [];
	for (const lines of faces) {
		const name = lines.find((l) => l.startsWith('Name:'))?.slice(5).trim();
		if (name === undefined || name === '') continue;
		const svars = new Map<string, string>();
		for (const l of lines) {
			if (!l.startsWith('SVar:')) continue;
			const rest = l.slice(5);
			const at = rest.indexOf(':');
			if (at > 0) svars.set(rest.slice(0, at), rest.slice(at + 1));
		}
		const copies: SpellCopy[] = [];
		const walk = (ability: string, via: CopyVia, seen: Set<string>): void => {
			const p = params(ability);
			const api = p.get('SP') ?? p.get('AB') ?? p.get('DB');
			const validTgts = p.get('ValidTgts');
			if (api === 'CopySpellAbility' && validTgts !== undefined) {
				const targetType = p.has('TargetType') ? terms(p.get('TargetType')!) : null;
				if (targetType === null || targetType.some((t) => SPELL_TARGET_TYPE.test(t))) copies.push({ via, validTgts: terms(validTgts), targetType });
			}
			const next = [p.get('SubAbility'), p.get('Execute'), ...terms(p.get('Choices') ?? '')].filter((n): n is string => n !== undefined && n !== '');
			for (const n of next) {
				const body = svars.get(n);
				if (body === undefined || seen.has(n)) continue;
				seen.add(n);
				walk(body, via, seen);
			}
		};
		for (const l of lines) {
			if (l.startsWith('A:')) {
				const p = params(l.slice(2));
				walk(l.slice(2), p.has('AB') ? 'activate' : 'cast', new Set());
			} else if (l.startsWith('T:')) {
				const p = params(l.slice(2));
				const exec = p.get('Execute');
				const body = exec === undefined ? undefined : svars.get(exec);
				const via = playedTrigger(p);
				if (body !== undefined && via !== null) walk(body, via, new Set([exec!]));
			}
		}
		// An activated ability a keyword grants the card (level up, max speed) is an `AB$` SVar.
		for (const [n, body] of svars) if (params(body).get('AB') === 'CopySpellAbility') walk(body, 'activate', new Set([n]));
		if (copies.length > 0) out.push({ name, copies });
	}
	return out;
}

const READ_BATCH = 256;

/**
 * The index over a Forge `res/cardsfolder`. Only files that mention
 * `CopySpellAbility` are parsed; the rest are read and dropped.
 */
export async function loadSpellCopiers(cardsfolder: string): Promise<SpellCopierIndex> {
	const index = new Map<string, SpellCopy[]>();
	const dirs = await readdir(cardsfolder, { withFileTypes: true });
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		const at = join(cardsfolder, dir.name);
		const files = (await readdir(at)).filter((f) => f.endsWith('.txt'));
		// In batches: a letter holds thousands of scripts, more than a process may hold open.
		for (let i = 0; i < files.length; i += READ_BATCH) {
			const texts = await Promise.all(files.slice(i, i + READ_BATCH).map((f) => readFile(join(at, f), 'utf8')));
			for (const text of texts) {
				if (!text.includes('CopySpellAbility')) continue;
				for (const face of parseCardScript(text)) index.set(face.name, [...(index.get(face.name) ?? []), ...face.copies]);
			}
		}
	}
	return index;
}

/**
 * `MatchDeps.spellCopiers` over a Forge `res/`: built once in the background at boot,
 * and answering nothing (every own spell passed, as before) until it is.
 */
export function spellCopierLookup(res: string, log: (entry: Record<string, unknown>) => void): (name: string) => readonly SpellCopy[] | undefined {
	let index: SpellCopierIndex = new Map();
	const begun = Date.now();
	loadSpellCopiers(join(res, 'cardsfolder')).then(
		(built) => {
			index = built;
			log({ evt: 'spell-copiers-indexed', cards: built.size, ms: Date.now() - begun });
		},
		(err: unknown) => log({ evt: 'spell-copiers-failed', error: String(err) }),
	);
	return (name) => index.get(name);
}

/* ── Is the spell on the stack a target ─────────────────────────────── */

/** The spell on top of the stack, as {@link copyTargets} reads it. */
export interface StackSpell {
	/** Its core types, as Forge's `CardTypeView` names them (`Instant`, `Creature`, …). */
	readonly types: readonly string[];
	/** The seat asking controls it. */
	readonly mine: boolean;
}

const PERMANENT_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Kindred', 'Land', 'Planeswalker'];
const CORE_TYPES = new Set([...PERMANENT_TYPES, 'Instant', 'Sorcery', 'Tribal']);

/**
 * One Forge restriction word against the spell: `true`/`false` when it can be read,
 * `null` when it cannot (a mana-value bound, a colour, `wasCast`) — which the caller
 * treats as a match, since a missed stop is worse than one extra press.
 */
function word(w: string, spell: StackSpell): boolean | null {
	if (w === 'Card' || w === 'Spell' || w === 'SpellAbility') return true;
	if (w === 'Emblem' || w === 'Activated' || w === 'Triggered') return false;
	if (w === 'Permanent') return spell.types.some((t) => PERMANENT_TYPES.includes(t));
	if (w === 'nonPermanent') return !spell.types.some((t) => PERMANENT_TYPES.includes(t));
	if (CORE_TYPES.has(w)) return spell.types.includes(w);
	if (w.startsWith('non') && CORE_TYPES.has(w.slice(3))) return !spell.types.includes(w.slice(3));
	if (w === 'YouCtrl' || w === 'YouOwn') return spell.mine;
	if (w === 'OppCtrl' || w === 'OppOwn') return !spell.mine;
	return null;
}

/** `Instant.YouCtrl+cmcLE2`: the base word and every `+` property must hold. */
function termMatches(term: string, spell: StackSpell): boolean {
	const dot = term.indexOf('.');
	const base = dot < 0 ? term : term.slice(0, dot);
	const props = dot < 0 ? [] : term.slice(dot + 1).split('+');
	return [base, ...props].every((w) => word(w, spell) !== false);
}

/** Whether this copy can target the spell: any `TargetType$` term and any `ValidTgts$` term match it. */
export function copyTargets(copy: Pick<SpellCopy, 'validTgts' | 'targetType'>, spell: StackSpell): boolean {
	if (copy.targetType !== null && !copy.targetType.some((t) => termMatches(t, spell))) return false;
	return copy.validTgts.some((t) => termMatches(t, spell));
}
