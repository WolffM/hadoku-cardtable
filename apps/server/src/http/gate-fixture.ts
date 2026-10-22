/**
 * TEST SUPPORT — the drafted deck both gate suites check: `gate.test.ts` pins
 * the gate's rules on it, `gate.jvm.test.ts` hands the accepted text to a real
 * Forge. Never imported by the server.
 *
 * The pool is real: 45 cards of the committed cube, read by the server's own
 * loader. The deck is the one the BROWSER writes — the UI's own `deckFromPool`,
 * `setBasicLand` and `.dck` writer — so this is the file a player would submit.
 *
 * Reads a shortlisted cube file (wave 73 §A), not the UI's bundled
 * `pool.json` — see `docs/planning/wave73-2026-10-21.md`'s blast radius table:
 * "gate-fixture.ts's load of the UI's pool.json moves to a shortlisted cube
 * file."
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basicLand, moveToMain, setBasicLand } from '@hadoku/deck';
import type { DraftCard } from '@hadoku/shared';

import { deckFromPool, dckTextOf } from '../../../ui/src/draft/deckFromPool.ts';
import { loadPool } from '../room/pool.js';
import type { DraftPoolLookup, GateContext } from './gate.js';
import { loadTablesLibrary } from './library.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const DRAFT = 'amber-lantern-k7q4';
/** A real library deck, legal in its own era (`Standard (M13)`, 2012) and from before Return to Ravnica (October 2012), which is what makes adding a Hallowed Fountain an illegal card rather than a legal reprint. */
export const UW_DELVER = 'power-2012-1-todd-anderson-uw-delver';
export const POWER_2012 = '2012-07-13';

const cube = loadPool(resolve(REPO_ROOT, 'apps/server/pools/cubes/mtgo-vintage-cube-2025-12.json'));
if (!cube.ok) throw new Error(`cube pool did not load: ${cube.detail}`);

/**
 * Every card of the cube that has two faces, then the first non-land cube cards
 * to make 45: 23 to play, 22 to sideboard.
 *
 * The two-faced cards come first so all of them are in the 23 played: the cube
 * stores each under Scryfall's combined name (`Etali, Primal Conqueror // Etali,
 * Primal Sickness`), which is what the browser writes into the `.dck`, and
 * Forge's card database files only a split card under that name. A real Forge
 * plays every one of them, or this deck's library is short of 40. The other
 * lands are left out so the only lands in the deck are the 17 the table supplies.
 */
const twoFaced = cube.pool.cards.filter((c) => c.name.includes(' // '));
export const POOL: DraftCard[] = [...twoFaced, ...cube.pool.cards.filter((c) => !/\bLand\b/.test(c.typeLine) && !c.name.includes(' // '))].slice(0, 45);

/** The caller's own pool, as the route builds it from `DraftRooms`. */
const draftPool: DraftPoolLookup = (draftId) =>
	draftId === DRAFT ? { ok: true, pool: POOL } : { ok: false, error: `you have no seat in draft ${JSON.stringify(draftId)}` };

export const library = loadTablesLibrary(REPO_ROOT);
export const ctx: GateContext = { library, draftPool };

/** The deck the browser writes: 23 drafted cards promoted, then 17 Islands from the basics buttons. */
export function draftedDeckText(): string {
	let deck = deckFromPool(DRAFT, POOL);
	for (const entry of deck.sideboard.slice(0, 23)) deck = moveToMain(deck, entry.card, entry.count);
	deck = setBasicLand(deck, basicLand('Island'), 17);
	return dckTextOf(deck);
}

export const drafted = (dck: string) => ({ deck: { dck }, rules: { kind: 'draft' as const, draftId: DRAFT } });
