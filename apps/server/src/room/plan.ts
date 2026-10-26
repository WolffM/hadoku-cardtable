/*
 * The verdict for a draft room's plan — verbatim, the operator:
 *
 *   "it shouldn't even get to the drafting stage. if a set/cube is selected
 *   for drafting we should immediately evaluate then whether or not its
 *   forge playable"
 *
 * (`docs/planning/draft-pools-plan.md`'s Rulings #6.) `PUT /api/rooms/:id/pod/plan`
 * (`http/rooms.ts`) calls `checkPlan` BEFORE accepting a leader's pool choice;
 * a refusal leaves the room's plan untouched.
 *
 * ## Structural interfaces, not imports
 *
 * `CubeLookup`/`ForgeChecker` below are this module's OWN minimal read of
 * C's `apps/server/src/pools/cubes.ts` (`CubeStore`) and D's
 * `apps/server/src/pools/forge.ts` (`ForgePools`) — declared here rather than
 * imported, because C and D are being written in parallel lanes this wave
 * (`docs/planning/wave73-2026-10-21.md`'s ordering: "C and D land before A's
 * index.ts wiring commit"). `index.ts` step 6 passes the real modules once
 * they land; until then `index.ts` passes an interim shortlist-backed
 * `CubeLookup` and a `null` `ForgeChecker` (no jar yet either).
 *
 * ## `missingText`: C's own signal, read off the cards themselves
 *
 * `CubeLookup.cards(id)` (C's `apps/server/src/pools/cubes.ts`) marks a name
 * its catalog could not produce text for with `typeLine: ''` — a card that
 * resolved carries a real type line; `DraftCardSchema.typeLine` has no other
 * reason to be empty. `checkSource` reads that signal directly rather than
 * asking C a second question, and never hands those names to Forge at all —
 * there is no text to check playability of.
 */

import type { CubeSummary, DraftCard, DraftPlan, PoolSource, PoolVerdict } from '@hadoku/shared';

/** The slice of C's `CubeStore` this module consumes. */
export interface CubeLookup {
	list(): readonly CubeSummary[];
	cards(id: string): readonly DraftCard[] | null;
	setVerdict(id: string, verdict: PoolVerdict): void;
}

/** The slice of D's `ForgePools` this module consumes. */
export interface ForgeChecker {
	check(names: readonly string[]): Promise<string[]>;
}

/**
 * The slice of E's own `apps/server/src/pools/sets.ts` store this module
 * consumes, for a `kind: 'set'` source (wave 74 §E step 3) — one verdict per
 * CODE, not per style: `realistic` and `set-cube` of the same set need the
 * exact same names checked (`pools/sets.ts`'s own `cardsFor` already unions
 * `setCards` with a booster sample to cover the land/DFC slot), so they
 * share one cache entry — `checkSource`'s own `sets.cardsFor` call below.
 */
export interface SetLookup {
	cardsFor(code: string): Promise<readonly DraftCard[] | null>;
	cachedVerdict(code: string): PoolVerdict | null;
	setVerdict(code: string, verdict: PoolVerdict): void;
}

export interface PlanCheckDeps {
	cubes: CubeLookup;
	/** `undefined` wherever a test does not care about `kind: 'set'` sources — see `checkSource`'s own refusal when it is missing. */
	sets?: SetLookup;
	/** `null` without a jar — "the verdict then refuses every source not already checked at this pin, with a reason. It never passes by default." */
	forge: ForgeChecker | null;
	/** `CONFIG.testUncheckedPools` — see `checkCards`'s own doc. Absent/false everywhere but the jar-less e2e stack. */
	uncheckedWithoutJar?: boolean;
}

/** Two sources are the same deal — see `@hadoku/draft`'s `deal.ts`, which groups rounds the same way. */
function sourceKey(src: PoolSource): string {
	return src.kind === 'cube' ? `cube:${src.cubeId}` : `set:${src.code}:${src.style}`;
}

/**
 * The verdict for a RESOLVED card list — no id, no cache. `checkSource`'s own
 * inner logic, and ALSO `apps/server/src/pools/cubes.ts`'s `attachCubeRoutes`
 * `check` dep directly: an import or a refresh always re-checks fresh, never
 * reusing a cached verdict ("An import is checked when it is saved", the
 * plan's Design) — `index.ts` wires the exact same function both places so
 * the rule can only be written once.
 *
 * - A card the catalog could not resolve (`typeLine === ''`) is counted as
 *   `missingText`, named, and never sent to Forge — there is no text to
 *   check playability of. The RESOLVED cards are still checked when a jar is
 *   up, so a refusal reports everything wrong with a cube at once rather than
 *   hiding an unplayable card behind the first missing-text one found.
 * - Without a jar: refused, with a reason, unless `missingText` alone already
 *   refuses it. Never passes by default —
 * - UNLESS `uncheckedWithoutJar` (`CONFIG.testUncheckedPools`,
 *   `CARDTABLE_E2E_UNCHECKED_POOLS=1`): the jar-less e2e `check` job's own
 *   escape hatch (CI run 39715510788 — without it `Lobby.startDraft` refuses
 *   `plan-not-ready` forever on a server with no jar at all). `missingText`
 *   still refuses even with it set: this is an escape from "no jar", never
 *   from "the catalog has no text for this card". Nothing in this repo's own
 *   deploy path ever sets the flag (`config.test.ts` pins that), and a jar
 *   being up makes it moot either way — the real `forge.check` always runs
 *   when one exists, flag or not.
 */
export async function checkCards(
	cards: readonly DraftCard[],
	forge: ForgeChecker | null,
	opts?: { uncheckedWithoutJar?: boolean },
): Promise<PoolVerdict> {
	const missingText = cards.filter((c) => c.typeLine === '').map((c) => c.name);
	const resolved = cards.filter((c) => c.typeLine !== '');

	if (forge === null) {
		if (missingText.length > 0) return { ok: false, unplayable: [], missingText };
		if (opts?.uncheckedWithoutJar === true) return { ok: true, cards: resolved.length };
		return { ok: false, unplayable: [], missingText: [], message: 'Forge is not available to check playability — try again once the pool service is up' };
	}

	const unplayable = await forge.check(resolved.map((c) => c.name));
	return unplayable.length === 0 && missingText.length === 0
		? { ok: true, cards: resolved.length }
		: { ok: false, unplayable, missingText };
}

/**
 * The verdict for ONE `kind: 'set'` source (wave 74 §E step 3) — by CODE, not
 * by `(code, style)`: `deps.sets.cardsFor` already names every card either
 * style could draw, so realistic and set-cube share one cached verdict.
 *
 * - No `SetLookup` wired (a test that does not care about sets, or a server
 *   with no jar at all — `pools/sets.ts`'s `cardsFor` answers `null` the same
 *   way without one) refuses, same wording `checkCards`'s own no-forge path
 *   uses.
 * - A cached verdict for the code is reused as-is — `pools/sets.ts`'s own
 *   cache, which `pools/refresh.ts`'s catalog-swap hook clears for a
 *   `missingText` refusal, so this never goes stale the way `CubeLookup`'s
 *   cube-store cache could (wave 74 §G step 2).
 * - Otherwise `checkCards` decides over the resolved card list, and the
 *   result is cached back (`setVerdict`).
 */
async function checkSetSource(code: string, deps: PlanCheckDeps): Promise<PoolVerdict> {
	if (deps.sets === undefined) {
		return { ok: false, unplayable: [], missingText: [], message: 'the pool service is not available to check sets — try again once it is up' };
	}
	const cached = deps.sets.cachedVerdict(code);
	if (cached !== null) return cached;

	const cards = await deps.sets.cardsFor(code);
	if (cards === null) {
		return { ok: false, unplayable: [], missingText: [], message: `unknown set, or Forge cannot answer for it: ${code}` };
	}
	const verdict = await checkCards(cards, deps.forge, { uncheckedWithoutJar: deps.uncheckedWithoutJar });
	deps.sets.setVerdict(code, verdict);
	return verdict;
}

/**
 * The verdict for ONE source, by id.
 *
 * - An unknown cube id is refused, named.
 * - Without a jar, an already-cached verdict for that cube (`CubeSummary.verdict`,
 *   from `cubes.list()`) is reused as-is, UNLESS the cube now has a
 *   `missingText` card — that signal is read straight off this call's own
 *   `cards()`, never stale the way a cache can be, so it always wins.
 * - Otherwise, `checkCards` decides, and the result is cached back onto the
 *   store (`setVerdict`) whenever a jar actually ran.
 */
export async function checkSource(src: PoolSource, deps: PlanCheckDeps): Promise<PoolVerdict> {
	if (src.kind === 'set') {
		return checkSetSource(src.code, deps);
	}

	const cards = deps.cubes.cards(src.cubeId);
	if (cards === null) return { ok: false, unplayable: [], missingText: [], message: `unknown cube: ${src.cubeId}` };

	if (deps.forge === null && !cards.some((c) => c.typeLine === '')) {
		const cached = deps.cubes.list().find((c) => c.id === src.cubeId)?.verdict ?? null;
		if (cached !== null) return cached;
	}

	const verdict = await checkCards(cards, deps.forge, { uncheckedWithoutJar: deps.uncheckedWithoutJar });
	if (deps.forge !== null) deps.cubes.setVerdict(src.cubeId, verdict);
	return verdict;
}

/**
 * The verdict for a WHOLE plan: every DISTINCT source among its three rounds
 * must be ok (deduped by `sourceKey`, same grouping `deal()` uses, so two
 * rounds of one cube are checked once). This wave's Cube tab fills all three
 * rounds identically, so this is one check in practice; a future Custom
 * tab's per-round sources (wave 74) are covered by the same loop with no
 * change here.
 */
export async function checkPlan(plan: DraftPlan, deps: PlanCheckDeps): Promise<PoolVerdict> {
	const seen = new Set<string>();
	const unplayable: string[] = [];
	const missingText: string[] = [];
	const without = new Set(plan.without);
	let message: string | undefined;
	let cards = 0;
	let ok = true;

	for (const src of plan.rounds) {
		const key = sourceKey(src);
		if (seen.has(key)) continue;
		seen.add(key);

		const verdict = await checkSource(src, deps);
		if (verdict.ok) {
			cards += verdict.cards;
			continue;
		}
		const left = await draftedWithout(src, verdict, without, deps);
		if (left !== null && left > 0) {
			cards += left;
			continue;
		}
		ok = false;
		if (left === 0) message ??= 'Every card in it is one Forge can’t play — there is nothing left to draft';
		if (verdict.message !== undefined) message ??= verdict.message;
		for (const name of verdict.unplayable) if (!unplayable.includes(name)) unplayable.push(name);
		for (const name of verdict.missingText) if (!missingText.includes(name)) missingText.push(name);
	}

	if (ok) return { ok: true, cards };
	return message === undefined ? { ok: false, unplayable, missingText } : { ok: false, unplayable, missingText, message };
}

/**
 * A refused source's card count once the plan's `without` takes out every card it was refused for —
 * the leader's "Draft without them" — 0 when that leaves none, or null when leaving cards out cannot
 * answer the refusal: one with no card list (`message`), a card refused that `without` does not name,
 * or a realistic round, whose packs are Forge's own boosters and never drawn from a list it could filter.
 */
async function draftedWithout(src: PoolSource, verdict: Extract<PoolVerdict, { ok: false }>, without: ReadonlySet<string>, deps: PlanCheckDeps): Promise<number | null> {
	if (without.size === 0 || verdict.message !== undefined) return null;
	if (src.kind === 'set' && src.style === 'realistic') return null;
	if (![...verdict.unplayable, ...verdict.missingText].every((name) => without.has(name))) return null;
	const all = src.kind === 'cube' ? deps.cubes.cards(src.cubeId) : ((await deps.sets?.cardsFor(src.code)) ?? null);
	return all?.filter((card) => !without.has(card.name)).length ?? 0;
}

/** Each round's bare name (`PodView.roundNames`), by the caller's own say in one source's name. */
export function roundNamesOf(plan: DraftPlan, nameOf: (src: PoolSource) => string): [string, string, string] {
	const [first, second, third] = plan.rounds;
	return [nameOf(first), nameOf(second), nameOf(third)];
}
