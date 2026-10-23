/**
 * Seven mulligans at most, against a real Forge (the operator, 2026-10-22: "we need to cap mulligant
 * count at 7. at 8 mulligan the game softlocks because 8 cards cannot be returned to the bottom").
 *
 * Forge's London mulligan offered another while the CURRENT bottom fit the hand, so after seven it
 * offered an eighth, whose keep asked for eight cards of a seven-card hand and could not be answered.
 * Our fork (`LondonMulligan.canMulligan`) offers one only while the bottom AFTER it fits: seat 0 says
 * Mulligan to every keep it is asked, is asked seven times, and is then told to put seven under.
 *
 * SKIPS without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/mulligan-cap.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount } from './host.js';
import { createMatchRegistry } from './match.js';
import type { ServerEnvelope } from '@hadoku/shared';

const available = jvmHostConfig();
const title = available.ok ? 'seven mulligans at most, against real Forge' : `seven mulligans at most, against real Forge — SKIPPED: ${available.reason}`;

const DECK = '[metadata]\nName=Half lands\n[main]\n20 Forest\n20 Grizzly Bears\n';

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe.skipIf(!available.ok)(title, () => {
	it('a seat that mulligans every hand is asked to keep seven times, then returns seven cards to the bottom', { timeout: 180_000 }, async () => {
		if (!available.ok) return;
		const sent: { seat: number; envelope: ServerEnvelope }[] = [];
		const jvm = jvmHostFactory(available.config, { spare: false, log: () => {} });
		const registry = createMatchRegistry({
			host: (id, spec, events) => jvm(id, spec, events),
			log: () => {},
			overGraceMs: 60_000,
			emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
		});
		const match = registry.create({
			seed: 7,
			seats: [
				{ name: 'A', ai: false, deck: DECK },
				{ name: 'B', ai: false, deck: DECK },
			],
		});
		try {
			expect(await match.whenRunning(120_000)).toEqual({ ok: true });
			const press = (seat: number, method: 'selectButtonOk' | 'selectButtonCancel'): void => {
				expect(match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method }))).toEqual({ ok: true });
			};
			const keeps: string[] = [];
			let bottom: string | null = null;
			const handled = new Set<number>();
			const deadline = Date.now() + 120_000;
			while (bottom === null && Date.now() < deadline) {
				for (const seat of [0, 1]) {
					const at = sent.findLastIndex((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage');
					if (at < 0 || handled.has(at)) continue;
					const message = (sent[at]!.envelope.frame as unknown as { message: string }).message;
					const buttons = sent.slice(0, at + 1).findLast((x) => x.seat === seat && x.envelope.frame.method === 'updateButtons')?.envelope.frame as unknown as
						| { enable1?: boolean }
						| undefined;
					if (seat === 0 && /to the bottom of your library/i.test(message)) {
						bottom = message;
					} else if (/keep your hand/i.test(message)) {
						handled.add(at);
						if (seat === 0) keeps.push(message);
						// Seat 0 mulligans every hand it is offered; seat 1 keeps.
						press(seat, seat === 0 ? 'selectButtonCancel' : 'selectButtonOk');
					} else if (buttons?.enable1 === true) {
						// Play or draw, and whatever else stands before the keep: take the default.
						handled.add(at);
						press(seat, 'selectButtonOk');
					}
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			console.log(`[mulligan-cap] keeps asked of seat 0: ${keeps.length}; then: ${JSON.stringify(bottom)}`);
			expect(keeps, 'the opening hand and six redraws are offered; the seventh redraw is kept').toHaveLength(7);
			expect(bottom, 'then seven go under').toMatch(/Return 7 card\(s\) to the bottom of your library/);
			match.stop();
		} finally {
			jvm.reapOnExit();
			await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
		}
	});
});
