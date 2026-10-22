/**
 * Cube Cobra import: turn a link (or a bare cube id) into the mainboard's
 * card names — and nothing else.
 *
 * `GET https://cubecobra.com/cube/api/cubeJSON/<id>` returns a cube's own
 * metadata, its deck lists, EVERY printing detail Scryfall has (prices,
 * EDHREC rank, `legalities`, art tags…) and several image fields
 * (`image`, `details.image_small`, `details.image_normal`, `details.art_crop`,
 * `details.tokens[].image_small`, …) on every mainboard card — verified
 * 2026-10-21 against `LSVCube` (checked into
 * `apps/server/src/pools/fixtures/`, trimmed).
 *
 * This file keeps exactly two fields per card: `name` and `scryfall_id` (as
 * `scryfallId`, never a URL — AGENTS.md: no copied Cube Cobra image blob, and
 * `scryfallId` is a *reference* a browser can derive art from, not a copy of
 * Cube Cobra's own art metadata). Never a `{...card}` or `{...details}`
 * spread anywhere in this file — see `build-pool.ts`'s header for why that is
 * how an image field reaches a payload without anyone deciding to send one.
 * Gameplay text (mana cost, oracle text, …) is NOT fetched from Cube Cobra at
 * all; `catalog.ts`'s `CardCatalog` fills it in by name once the card is in
 * `cubes.ts`'s store.
 */

/** A URL fetcher that returns parsed JSON. Injectable so tests never touch the network. */
export type FetchJson = (url: string) => Promise<unknown>;

export const defaultFetchJson: FetchJson = async (url: string) => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Cube Cobra answered ${res.status} for ${url}`);
	return res.json();
};

/** A card as kept from Cube Cobra: a name, and an id the browser can derive art from — nothing else. */
export interface CubeCobraCard {
	readonly name: string;
	readonly scryfallId: string | null;
}

export interface CubeCobraCube {
	readonly name: string;
	readonly cards: readonly CubeCobraCard[];
}

/** `/cube/overview/<id>`, `/cube/list/<id>`, or a bare id — Cube Cobra's own `shortId` or Mongo `_id`. */
const CUBE_PATH_RE = /\/cube\/(?:overview|list|api\/cubejson)\/([^/?#]+)/i;

export type ParsedCubeCobraLink = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string };

/** Pull the cube id out of whatever the importer pasted. Never throws. */
export function parseCubeCobraLink(link: string): ParsedCubeCobraLink {
	const trimmed = link.trim();
	if (trimmed.length === 0) return { ok: false, error: 'paste a Cube Cobra link or cube id' };

	const pathMatch = CUBE_PATH_RE.exec(trimmed);
	if (pathMatch?.[1] !== undefined && pathMatch[1].length > 0) {
		return { ok: true, id: decodeURIComponent(pathMatch[1]) };
	}

	// No slash and no whitespace: a bare id (`LSVCube`, or a Mongo `_id`).
	if (!trimmed.includes('/') && !/\s/.test(trimmed)) {
		return { ok: true, id: trimmed };
	}

	return { ok: false, error: `not a Cube Cobra cube link or id: ${JSON.stringify(link)}` };
}

/**
 * Keep `mainboard` only, and only `name` + `scryfall_id` per card. Everything
 * else Cube Cobra's `cubeJSON` response carries — including every image
 * field — is dropped here, at the one place this repo ever sees that
 * response.
 */
export function projectCubeCobraCube(raw: unknown, fallbackName: string): CubeCobraCube {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('Cube Cobra response was not an object');
	}
	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : fallbackName;

	const cardsField = obj.cards;
	const mainboardField =
		typeof cardsField === 'object' && cardsField !== null ? (cardsField as Record<string, unknown>).mainboard : undefined;
	const mainboard = Array.isArray(mainboardField) ? mainboardField : [];

	const cards: CubeCobraCard[] = [];
	for (const entry of mainboard) {
		if (typeof entry !== 'object' || entry === null) continue;
		const details = (entry as Record<string, unknown>).details;
		if (typeof details !== 'object' || details === null) continue;
		const cardName = (details as Record<string, unknown>).name;
		if (typeof cardName !== 'string' || cardName.length === 0) continue;
		const scryfallIdRaw = (details as Record<string, unknown>).scryfall_id;
		cards.push({ name: cardName, scryfallId: typeof scryfallIdRaw === 'string' && scryfallIdRaw.length > 0 ? scryfallIdRaw : null });
	}

	if (cards.length === 0) throw new Error('Cube Cobra cube has no mainboard cards');
	return { name, cards };
}

/** Fetch and project one cube. `fetchJson` is injectable so a test never reaches the network. */
export async function fetchCubeCobraCube(id: string, fetchJson: FetchJson = defaultFetchJson): Promise<CubeCobraCube> {
	const url = `https://cubecobra.com/cube/api/cubeJSON/${encodeURIComponent(id)}`;
	const raw = await fetchJson(url);
	return projectCubeCobraCube(raw, id);
}
