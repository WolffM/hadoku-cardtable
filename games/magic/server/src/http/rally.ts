/**
 * `/api/rally` — Cardtable's drafts as a Rally pick catalogue (cardtable#24; the brief is
 * hadoku-rally `docs/requests/CARDTABLE_PICK_CATALOGUES.md`).
 *
 *   GET /api/rally/sources                    → the three catalogues, each listing its Pack view, and the symbols stylesheet
 *   GET /api/rally/symbols.css, keyrune.woff2 → set symbols for Rally's option rows (`rally-symbols.ts`)
 *   GET /api/rally/options/:kind?q=           → up to 8 matches, best first, each with its kind and a line per source
 *   GET /api/rally/views/:kind/:id/cards      → every card a source drafts from (what an option's line opens)
 *   GET /api/rally/views/:kind/:id/pack       → a freshly opened pack (one per round for a mixed preset)
 *
 * Every answer is Rally's `{ success, data }` wrapper. The first two are read by Rally's builder,
 * the last two by Cardtable's own view pages (`games/magic/ui/src/rally/`), which Rally frames under its
 * ranking row. All four sit behind the `api` router's `requireMinTier`, like every other route.
 *
 * ## One plan per option
 *
 * Each option becomes the `DraftPlan` a room drafting it would run (`planOf`): a cube three times,
 * a set as three realistic rounds, a preset as itself. Both views read that plan and nothing else,
 * so a sample pack is dealt by the same `deal()` and the same Forge booster call a room's `/start`
 * makes, and the cards page lists the same pools `deal()` shuffles (less the plan's `without`).
 *
 * Rounds drawing from one pool are one group on either page: a cube's three identical rounds are
 * one card list and one pack, while a preset mixing Alara and Alara Reborn shows each pool, and a
 * pack from each round. A set's realistic and set-cube styles draw on the same card list, so the
 * cards page joins them into one group; the pack page, and the line that opens it, do not, since
 * a line names one line view id and the two styles deal from different pools (a realistic pack is
 * Forge's own booster collation; a set-cube pack is a `deal()` round like a cube's). A set's line
 * view id carries its style when it is not realistic, `set/BLB:set-cube/cards` — realistic stays
 * the bare `set/BLB/cards`, so every line already in a stored Rally snapshot still means realistic.
 *
 * ## Options are snapshots
 *
 * Rally keeps `{id, label, detail, image, lines}` in the form. An option deleted since (an imported cube,
 * a preset) answers 404 with a sentence the page shows, never a blank frame.
 */

import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import type { RateLimitConfig } from '@wolffm/rooms-server';

import {
	RALLY_IMAGE_HOSTS,
	RALLY_OPTION_ID,
	RallyCatalogueSchema,
	RallyViewSchema,
	planDisplayName,
	sourceLabel,
	type DraftCard,
	type DraftPlan,
	type PoolSource,
	type RallyCardGroup,
	type RallyCardsView,
	type RallyCatalogue,
	type RallyLine,
	type RallyPackView,
	type RallySource,
	type RallySuggestion,
} from '@hadoku/shared';
import { deal, planPool } from '@hadoku/draft';

import type { ArtKeys } from '../pools/art-keys.js';
import type { CubeStore } from '../pools/cubes.js';
import type { PresetStore } from '../pools/presets.js';
import type { SetsStore } from '../pools/sets.js';
import { DEFAULT_PARAMS } from '../room/draftRooms.js';
import { artLocation } from './card-art.js';
import { perCallerLimit } from '@hadoku/game-server/http/request';
import { resolveBoosterCard, type RealisticBoosterSource, type RealisticCatalog } from './rooms.js';
import { jsonLogger } from '@hadoku/service-kernel/log';
import type { RallySymbols } from './rally-symbols.js';

export interface RallyDeps {
	cubes: Pick<CubeStore, 'list' | 'cards'>;
	sets: Pick<SetsStore, 'list' | 'nameOf' | 'cardsFor'>;
	presets: Pick<PresetStore, 'list'>;
	/** Forge's booster collation; null without a jar, when a realistic round has no pack to show. */
	boosters: RealisticBoosterSource | null;
	catalog: RealisticCatalog;
	/** Sample packs per caller: each is a pool-JVM round trip. `null` is no limit (the e2e stacks). */
	packRateLimit?: RateLimitConfig | null;
	/** Keyrune, for the set symbols Rally draws beside each line (`rally-symbols.ts`). */
	symbols: RallySymbols;
	/** Which card images are on our CDN: a cover is stored as the URL a browser would be sent. */
	art: ArtKeys;
	log?: (entry: Record<string, unknown>) => void;
}

/** Where `/sources` points Rally for the set symbols, relative to Cardtable's base. */
export const SYMBOLS_PATH = 'api/rally/symbols.css';

/** A burst of 20 packs, then one every three seconds: a respondent reloading every pack in a form, not a script. */
export const PACK_RATE_LIMIT: RateLimitConfig = { capacity: 20, refillAmount: 1, refillIntervalMs: 3_000 };

/** "About 8 results, best match first." */
const MAX_SUGGESTIONS = 8;

/** The pack is the one view a source lists; an option's cards open from its lines. */
const VIEWS: RallySource['views'] = [{ id: 'pack', label: 'Pack' }];

/** Rally's cap on a line's text. */
const LINE_MAX = 80;

const SOURCES: readonly RallySource[] = [
	{ kind: 'draft-preset', label: 'Draft presets', views: VIEWS },
	{ kind: 'set', label: 'Sets', views: VIEWS },
	{ kind: 'cube', label: 'Cubes', views: VIEWS },
];

const RARITY_ORDER: Record<DraftCard['rarity'], number> = { mythic: 0, rare: 1, special: 2, uncommon: 3, common: 4 };

/** Refused with a status already chosen and a sentence the view page shows as it is. */
class RallyRefusal extends Error {
	constructor(
		readonly status: 404 | 409 | 503,
		message: string,
	) {
		super(message);
	}
}

/** A card's art as Rally may store it: where `/api/art` would send a browser, and only from a host the CSP draws. */
function coverUrl(scryfallId: string | null | undefined, keys: ArtKeys): string | null {
	const url = scryfallId == null ? null : artLocation(scryfallId, 'normal', keys);
	return url !== null && RALLY_IMAGE_HOSTS.some((host) => url.startsWith(host)) ? url : null;
}

/** A set's cover: its rarest card with art, so a set reads as its headline mythic rather than a common. */
function setCover(cards: readonly DraftCard[] | null, keys: ArtKeys): string | null {
	const ranked = (cards ?? []).filter((c) => c.scryfallId !== undefined).sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]);
	return coverUrl(ranked[0]?.scryfallId, keys);
}

/**
 * How well `text` answers `q`: 0 for a prefix, 1 for a word starting with it, 2 for anywhere, null
 * for no match. An empty query matches everything equally, so the catalogue's own order stands.
 */
function matchRank(q: string, ...texts: readonly string[]): number | null {
	if (q === '') return 0;
	let best: number | null = null;
	for (const raw of texts) {
		const text = raw.toLowerCase();
		const at = text.indexOf(q);
		if (at < 0) continue;
		const rank = at === 0 ? 0 : text.split(/[^a-z0-9]+/).some((word) => word.startsWith(q)) ? 1 : 2;
		best = best === null ? rank : Math.min(best, rank);
	}
	return best;
}

/** The best `MAX_SUGGESTIONS`, stable within a rank so the catalogue's own order (newest first) breaks ties. */
function best<T>(items: readonly T[], rank: (item: T) => number | null): T[] {
	return items
		.map((item, i) => ({ item, i, r: rank(item) }))
		.filter((x): x is { item: T; i: number; r: number } => x.r !== null)
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.slice(0, MAX_SUGGESTIONS)
		.map((x) => x.item);
}

/** A cube or a set drafted all three rounds: what a room drafting it runs. */
const thrice = (src: PoolSource): DraftPlan => ({ rounds: [src, src, src] });

/** One card list per key: a set's two styles draw on the same cards, so they share a cards page. */
const poolKey = (src: PoolSource): string => (src.kind === 'cube' ? `cube:${src.cubeId}` : `set:${src.code}`);

/** One line, and one pack, per key: unlike `poolKey`, a set's two styles are different lines and different
 * packs (a realistic pack is Forge's booster, a set-cube pack a plain `deal()` round), so they key apart. */
const lineKey = (src: PoolSource): string => (src.kind === 'cube' ? `cube:${src.cubeId}` : `set:${src.code}:${src.style}`);

/** A set source's id in a line/view, e.g. `BLB` for realistic — what every snapshot already stored — or
 * `BLB:set-cube` for any other style. */
const setViewId = (src: Extract<PoolSource, { kind: 'set' }>): string => (src.style === 'realistic' ? src.code : `${src.code}:${src.style}`);

/** The set style enum, copied from `PoolSourceSchema` (`packages/shared/src/pool.ts`) to check a view id's suffix. */
const SET_STYLES: readonly Extract<PoolSource, { kind: 'set' }>['style'][] = ['realistic', 'set-cube'];

/** A set's code and style from a line/view id: bare `BLB` defaults to realistic; `BLB:style` names any
 * other style. Null for an unknown style suffix (refused the same way as an unknown set). */
function parseSetId(id: string): { code: string; style: Extract<PoolSource, { kind: 'set' }>['style'] } | null {
	const i = id.indexOf(':');
	if (i < 0) return { code: id, style: 'realistic' };
	const style = id.slice(i + 1);
	return (SET_STYLES as readonly string[]).includes(style) ? { code: id.slice(0, i), style: style as Extract<PoolSource, { kind: 'set' }>['style'] } : null;
}

const KIND_LABEL = (src: PoolSource): string => (src.kind === 'cube' ? 'Cube' : src.style === 'realistic' ? 'Realistic' : 'Set cube');

/** The plan's draft kinds in first-round order: `Cube`, `Realistic`, or `Realistic + Set cube`. */
const kindOf = (plan: DraftPlan): string => [...new Set(plan.rounds.map(KIND_LABEL))].join(' + ');

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const isPlayable = (verdict: { ok: boolean } | null): boolean => verdict === null || verdict.ok;

export function attachRally(api: Router, deps: RallyDeps): void {
	const log = deps.log ?? jsonLogger('cardtable-rally');
	const packLimit = perCallerLimit(deps.packRateLimit === undefined ? PACK_RATE_LIMIT : deps.packRateLimit, 'too many sample packs; wait a little and try again', {
		act: 'rally-pack',
		onRefused: () => log({ evt: 'rally-pack-limited' }),
	});

	/**
	 * A source's bare name. A set's is known once the sets store has answered `list()` (warmed at
	 * boot, but not necessarily by the first request): every path that names a preset's rounds
	 * awaits `named()` first, so a label never reads as a bare set code.
	 */
	const named = async (): Promise<void> => {
		await deps.sets.list();
	};
	const nameOf = (src: PoolSource): string =>
		src.kind === 'cube' ? (deps.cubes.list().find((c) => c.id === src.cubeId)?.name ?? src.cubeId) : (deps.sets.nameOf(src.code) ?? src.code);

	async function sourceCover(src: PoolSource): Promise<string | null> {
		if (src.kind === 'cube') return coverUrl(deps.cubes.list().find((c) => c.id === src.cubeId)?.artId, deps.art);
		return setCover(await deps.sets.cardsFor(src.code), deps.art);
	}

	/** A plan as one search result: its kind, and a line per source opening that source's cards. */
	function optionOf(id: string, label: string, plan: DraftPlan, image: string | null): RallySuggestion {
		return { id, label, detail: kindOf(plan), image, lines: linesOf(plan) };
	}

	/** `3x Bloomburrow packs`, or `1x Final Fantasy`, linked to that source's own cards page. A set's two
	 * styles are two lines (`lineKey`), even though they open the same cards page (`poolKey` joins them
	 * there): the line's view id is what Rally later swaps to the pack view, and the two styles must
	 * open their own packs. */
	function linesOf(plan: DraftPlan): RallyLine[] {
		return grouped(plan, lineKey).map(({ src, rounds }) => {
			const n = rounds.length;
			const text = n === 1 ? `1x ${clip(nameOf(src), LINE_MAX - 3)}` : `${n}x ${clip(nameOf(src), LINE_MAX - 9)} packs`;
			return { text, view: src.kind === 'cube' ? `cube/${src.cubeId}/cards` : `set/${setViewId(src)}/cards` };
		});
	}

	/** Every source in the plan has an id Rally can carry in a line's view. */
	const linkable = (plan: DraftPlan): boolean => plan.rounds.every((src) => RALLY_OPTION_ID.test(src.kind === 'cube' ? src.cubeId : src.code));

	async function suggest(kind: RallyCatalogue, q: string): Promise<RallySuggestion[]> {
		switch (kind) {
			case 'cube':
				return best(
					deps.cubes.list().filter((c) => isPlayable(c.verdict) && RALLY_OPTION_ID.test(c.id)),
					(c) => matchRank(q, c.name),
				).map((c) => optionOf(c.id, c.name, thrice({ kind: 'cube', cubeId: c.id }), coverUrl(c.artId, deps.art)));
			case 'set': {
				const sets = (await deps.sets.list()).filter((s) => isPlayable(s.verdict) && RALLY_OPTION_ID.test(s.code));
				return Promise.all(
					best(sets, (s) => matchRank(q, s.name, s.code)).map(async (s) =>
						optionOf(s.code, s.name, thrice({ kind: 'set', code: s.code, style: 'realistic' }), setCover(await deps.sets.cardsFor(s.code), deps.art)),
					),
				);
			}
			case 'draft-preset': {
				await named();
				const presets = deps.presets.list().filter((p) => RALLY_OPTION_ID.test(p.id) && linkable(p.plan));
				const described = presets.map((p) => ({ preset: p, plan: planDisplayName(p.plan, roundNames(p.plan)) }));
				return Promise.all(
					best(described, (d) => matchRank(q, d.preset.name, d.plan)).map(async ({ preset }) =>
						optionOf(preset.id, preset.name, preset.plan, await sourceCover(preset.plan.rounds[0])),
					),
				);
			}
		}
	}

	const roundNames = (plan: DraftPlan): [string, string, string] => [nameOf(plan.rounds[0]), nameOf(plan.rounds[1]), nameOf(plan.rounds[2])];

	/** The plan a room drafting this option would run, and its display name — or a refusal saying the option is gone. */
	async function planOf(kind: RallyCatalogue, id: string): Promise<{ plan: DraftPlan; name: string }> {
		switch (kind) {
			case 'cube': {
				const cube = deps.cubes.list().find((c) => c.id === id);
				if (cube === undefined) throw new RallyRefusal(404, 'This cube is no longer on Cardtable.');
				return { plan: thrice({ kind: 'cube', cubeId: id }), name: cube.name };
			}
			case 'set': {
				const parsed = parseSetId(id);
				if (parsed === null) throw new RallyRefusal(404, 'Cardtable cannot draft this set.');
				const set = (await deps.sets.list()).find((s) => s.code === parsed.code);
				if (set === undefined) throw new RallyRefusal(404, 'Cardtable cannot draft this set.');
				return { plan: thrice({ kind: 'set', code: parsed.code, style: parsed.style }), name: set.name };
			}
			case 'draft-preset': {
				const preset = deps.presets.list().find((p) => p.id === id);
				if (preset === undefined) throw new RallyRefusal(404, 'This draft preset has been deleted.');
				await named();
				return { plan: preset.plan, name: preset.name };
			}
		}
	}

	/** Every card a source deals from: a cube's list, or every card a set's packs can hold. */
	async function sourceCards(src: PoolSource): Promise<readonly DraftCard[]> {
		const cards = src.kind === 'cube' ? deps.cubes.cards(src.cubeId) : await deps.sets.cardsFor(src.code);
		if (cards === null || cards.length === 0) throw new RallyRefusal(409, `Cardtable could not read the cards of ${nameOf(src)}.`);
		return cards;
	}

	/** "Rounds 1 and 3", "Round 2", or null when every round is this one. */
	function roundsLabel(rounds: readonly number[]): string | null {
		if (rounds.length === 3) return null;
		const n = rounds.map((r) => r + 1);
		return n.length === 1 ? `Round ${n[0]}` : `Rounds ${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
	}

	/** The plan's rounds grouped by `key`, in first-round order. */
	function grouped(plan: DraftPlan, key: (src: PoolSource) => string): { src: PoolSource; rounds: number[] }[] {
		const groups = new Map<string, { src: PoolSource; rounds: number[] }>();
		plan.rounds.forEach((src, r) => {
			const k = key(src);
			const group = groups.get(k);
			if (group === undefined) groups.set(k, { src, rounds: [r] });
			else group.rounds.push(r);
		});
		return [...groups.values()];
	}

	const groupLabel = (rounds: readonly number[], one: boolean, label: string): string | null => {
		if (one) return null;
		const which = roundsLabel(rounds);
		return which === null ? label : `${which} · ${label}`;
	};

	async function cardsView(kind: RallyCatalogue, id: string): Promise<RallyCardsView> {
		const { plan, name } = await planOf(kind, id);
		const groups = grouped(plan, poolKey);
		const resolved = new Map<PoolSource, readonly DraftCard[]>();
		for (const { src } of groups) resolved.set(src, await sourceCards(src));
		return {
			name,
			groups: groups.map(({ src, rounds }): RallyCardGroup => ({
				label: groupLabel(rounds, groups.length === 1, nameOf(src)),
				cards: [...planPool(plan, (s) => resolved.get(s) ?? [], src)],
			})),
		};
	}

	async function packView(kind: RallyCatalogue, id: string): Promise<RallyPackView> {
		const { plan, name } = await planOf(kind, id);
		const seed = randomUUID();
		const groups = grouped(plan, lineKey);

		const pools = new Map<string, readonly DraftCard[]>();
		const realistic = new Map<number, DraftCard[][]>();
		for (const { src, rounds } of groups) {
			if (src.kind === 'set' && src.style === 'realistic') {
				const forge = deps.boosters;
				if (forge === null) throw new RallyRefusal(503, 'Sample packs of a set need Forge, which this server is running without.');
				for (const r of rounds) {
					const boosters = await forge.boosters(src.code, 1, `rally:${seed}:${r}`);
					realistic.set(
						r,
						boosters.map((pack) => pack.map((card) => resolveBoosterCard(deps.catalog, card))),
					);
				}
			} else pools.set(lineKey(src), await sourceCards(src));
		}

		const dealt = deal(plan, (src) => pools.get(lineKey(src)) ?? [], seed, 1, DEFAULT_PARAMS.packSize, (r) => realistic.get(r));
		return {
			name,
			packs: groups.map(({ src, rounds }) => ({
				label: groupLabel(rounds, groups.length === 1, sourceLabel(src, nameOf(src))),
				// Round 1's pack of a pool the plan drafts more than once: one pack per pool, opened fresh.
				cards: dealt[rounds[0]!]![0]!,
			})),
		};
	}

	const rally = express.Router();

	const fail = (res: Response, status: number, error: string): void => {
		res.status(status).json({ success: false, error });
	};

	const answer = (res: Response, work: Promise<unknown>, evt: string, fields: Record<string, unknown>): void => {
		work.then(
			(data) => res.json({ success: true, data }),
			(err: unknown) => {
				if (err instanceof RallyRefusal) return fail(res, err.status, err.message);
				log({ evt, ...fields, detail: (err as Error).message });
				fail(res, 500, 'Cardtable could not answer just now.');
			},
		);
	};

	rally.get('/sources', (_req: Request, res: Response) => {
		res.json({ success: true, data: { sources: SOURCES, symbols: SYMBOLS_PATH } });
	});

	rally.get('/symbols.css', (_req: Request, res: Response) => {
		deps.symbols.css().then(
			(css) => res.type('text/css').set('Cache-Control', 'public, max-age=86400').send(css),
			(err: unknown) => {
				log({ evt: 'rally-symbols-failed', detail: (err as Error).message });
				res.status(404).end();
			},
		);
	});

	rally.get('/keyrune.woff2', (_req: Request, res: Response) => {
		deps.symbols.font().then(
			(font) => res.type('font/woff2').set('Cache-Control', 'public, max-age=86400').send(font),
			(err: unknown) => {
				log({ evt: 'rally-symbols-failed', detail: (err as Error).message });
				res.status(404).end();
			},
		);
	});

	rally.get('/options/:kind', (req: Request, res: Response) => {
		const kind = RallyCatalogueSchema.safeParse(req.params.kind);
		if (!kind.success) return fail(res, 404, `Cardtable has no catalogue ${JSON.stringify(req.params.kind)}`);
		const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 100) : '';
		answer(res, suggest(kind.data, q).then((suggestions) => ({ suggestions })), 'rally-options-failed', { kind: kind.data });
	});

	rally.get('/views/:kind/:id/:view', (req: Request, res: Response) => {
		const kind = RallyCatalogueSchema.safeParse(req.params.kind);
		const view = RallyViewSchema.safeParse(req.params.view);
		const id = String(req.params.id);
		if (!kind.success || !view.success || !RALLY_OPTION_ID.test(id)) return fail(res, 404, 'Cardtable has no such page.');
		if (view.data === 'cards') return answer(res, cardsView(kind.data, id), 'rally-cards-failed', { kind: kind.data, id });
		// A pack is opened fresh on every load: nothing between here and the page may keep one.
		res.setHeader('Cache-Control', 'no-store');
		if (!packLimit(req, res)) return;
		answer(res, packView(kind.data, id), 'rally-pack-failed', { kind: kind.data, id });
	});

	api.use('/rally', rally);
}
