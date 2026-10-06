/**
 * Wave 34 §D, "done when": a real match starts with one deck from each of the
 * nine power-summer eras.
 *
 * `library-resolve.jvm.test.ts` proves every card resolves in Forge's own
 * database; this proves a step further, that the decks actually START A GAME
 * — the two decks are accepted, Forge deals, and the match reaches running.
 * Nine separate matches, one per era, run SERIALLY and each torn all the way
 * down (`match.stop()`, `jvm.reapOnExit()`, waited out to `liveJvmCount() === 0`)
 * before the next starts, because nine live JVMs at once is exactly the kind
 * of host-memory problem this wave's protocol warns about.
 *
 * Each era's two decks are its own first two catalogued decks — not chosen for
 * being a good matchup, chosen for being UNAMBIGUOUSLY the library's own, so a
 * failure here points straight at a specific `.dck` file.
 *
 * NIGHTLY (`nightly` in `../play/scenario.ts`): 31 matches at ~10 s each is five
 * minutes — a fifth of the whole jar-gated run, measured on CI run 37487474250 —
 * and what it guards only changes when a `.dck` file or the library catalogue
 * does. SKIPS without a Forge build, like every `*.jvm.test.ts`. To run it:
 *
 *   CARDTABLE_JVM_NIGHTLY=1 CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   pnpm exec vitest run apps/server/src/http/library-match.jvm.test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import { LIBRARY, deckPath } from '@hadoku/deck/library';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type MatchSpec } from '../play/host.js';
import { createMatchRegistry, type Match } from '../play/match.js';
import { nightly } from '../play/scenario.js';

const available = jvmHostConfig();
const title = available.ok
	? '[nightly] a real match starts with one deck from each power-summer era'
	: `[nightly] a real match starts with one deck from each power-summer era — SKIPPED: ${available.reason}`;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function deckText(eraIndex: number, deckIndex: number): { name: string; text: string } {
	const collection = LIBRARY[eraIndex]!;
	const entry = collection.decks[deckIndex]!;
	return { name: entry.id, text: readFileSync(join(REPO_ROOT, deckPath(collection, entry)), 'utf8') };
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** One match, started and immediately torn down. Throws if Forge never reached running. */
async function startsAndRuns(seatA: { name: string; text: string }, seatB: { name: string; text: string }): Promise<void> {
	if (!available.ok) throw new Error('unreachable');
	const jvm = jvmHostFactory(available.config, { spare: false, log: () => {} });
	try {
		const registry = createMatchRegistry({
			host: jvm,
			log: () => {},
			askTimeoutMs: 60_000,
			overGraceMs: 60_000,
			emit: () => {},
		});
		const spec: MatchSpec = {
			seats: [
				{ name: 'Seat 1', ai: false, deck: seatA.text },
				{ name: 'Seat 2', ai: false, deck: seatB.text },
			],
		};
		const match: Match = registry.create(spec);
		const running = await match.whenRunning(120_000);
		if (!running.ok) throw new Error(`${seatA.name} vs ${seatB.name} did not start: ${running.error}`);
		match.stop();
	} finally {
		jvm.reapOnExit();
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
	}
}

describe.skipIf(!available.ok || !nightly)(title, () => {
	it.each(LIBRARY.map((c, i) => [i, c.id] as const))('era %i (%s): its own first two decks start a real match', async (eraIndex) => {
		const a = deckText(eraIndex, 0);
		const b = deckText(eraIndex, Math.min(1, LIBRARY[eraIndex]!.decks.length - 1));
		await startsAndRuns(a, b);
	}, 150_000);
});
