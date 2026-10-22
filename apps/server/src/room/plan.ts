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

export interface PlanCheckDeps {
	cubes: CubeLookup;
	/** `null` without a jar — "the verdict then refuses every source not already checked at this pin, with a reason. It never passes by default." */
	forge: ForgeChecker | null;
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
 *   refuses it. Never passes by default.
 */
export async function checkCards(cards: readonly DraftCard[], forge: ForgeChecker | null): Promise<PoolVerdict> {
	const missingText = cards.filter((c) => c.typeLine === '').map((c) => c.name);
	const resolved = cards.filter((c) => c.typeLine !== '');

	if (forge === null) {
		if (missingText.length > 0) return { ok: false, unplayable: [], missingText };
		return { ok: false, unplayable: ['Forge is not available to check playability — try again once the pool service is up'], missingText: [] };
	}

	const unplayable = await forge.check(resolved.map((c) => c.name));
	return unplayable.length === 0 && missingText.length === 0
		? { ok: true, cards: resolved.length }
		: { ok: false, unplayable, missingText };
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
		// Unreachable this wave (the route refuses it at 400) — defensive, not load-bearing.
		return { ok: false, unplayable: [], missingText: ['set sources are not supported this wave'] };
	}

	const cards = deps.cubes.cards(src.cubeId);
	if (cards === null) return { ok: false, unplayable: [`unknown cube: ${src.cubeId}`], missingText: [] };

	if (deps.forge === null && !cards.some((c) => c.typeLine === '')) {
		const cached = deps.cubes.list().find((c) => c.id === src.cubeId)?.verdict ?? null;
		if (cached !== null) return cached;
	}

	const verdict = await checkCards(cards, deps.forge);
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
		ok = false;
		for (const name of verdict.unplayable) if (!unplayable.includes(name)) unplayable.push(name);
		for (const name of verdict.missingText) if (!missingText.includes(name)) missingText.push(name);
	}

	return ok ? { ok: true, cards } : { ok: false, unplayable, missingText };
}
