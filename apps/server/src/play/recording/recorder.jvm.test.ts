/**
 * §C, "Done when" (`docs/planning/wave77-2026-10-27.md`): a real match, through
 * the wrapped host factory and the registry's own `emit`, against actual
 * Forge — never the engine's own behaviour.
 * This proves only the plumbing: every command the match actually sends comes
 * back out of the action log as one `cmd` line, and every envelope the
 * registry emits for `WATCHER_SEAT` comes back out of the public stream as
 * one `env` line, byte for byte. A handful of real commands is enough to show
 * that — the test does not play, or need, a finished game.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';
import type { ServerEnvelope } from '@hadoku/shared';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeCommand, type MatchSpec } from '../host.js';
import { createMatchRegistry, WATCHER_SEAT } from '../match.js';
import { bridgeDigest, createRecorder, forgePin, serverVersion } from './recorder.js';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from './retention.js';

const available = jvmHostConfig();
const title = available.ok
	? 'records a real match through the wrapped host factory'
	: `records a real match through the wrapped host factory — SKIPPED: ${available.reason}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(p: () => boolean, label: string, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!p()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(50);
	}
}

function precon(name: string): string {
	if (!available.ok) throw new Error('unreachable');
	return readFileSync(join(available.config.res, 'quest', 'precons', `${name}.dck`), 'utf8');
}

function linesOf(path: string): { t: string; [k: string]: unknown }[] {
	return gunzipSync(readFileSync(path))
		.toString('utf8')
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => JSON.parse(l) as { t: string; [k: string]: unknown });
}

describe.skipIf(!available.ok)(title, () => {
	afterAll(async () => {
		await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 20_000);
	});

	it(
		"the action log's cmd count equals the commands sent, and the public stream holds exactly the watcher channel's envelopes",
		async () => {
			if (!available.ok) return;
			const dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-jvm-'));
			try {
				const recorder = createRecorder({
					dir,
					identity: { pin: forgePin(available.config.jar), bridge: bridgeDigest(available.config.bridgeSource), server: serverVersion(process.cwd()) },
					roomOf: () => 'r-jvm-test',
					deckCosts: () => ({}),
					log: () => {},
				});
				const jvm = jvmHostFactory(available.config, { spare: false, log: () => {} });
				const hosted = recorder.host(jvm);

				let sentCommands = 0;
				const watcherEnvelopes: ServerEnvelope[] = [];
				const notes = [0, 1].map(() => ({ prompt: '', ok: false }));
				const registry = createMatchRegistry({
					host: (id, s, events) => {
						const host = hosted(id, s, events);
						return {
							...host,
							send(command: BridgeCommand) {
								sentCommands += 1;
								host.send(command);
							},
						};
					},
					log: () => {},
					overGraceMs: 60_000,
					emit: (match, seat, envelope) => {
						recorder.onEnvelope(match.id, seat, envelope);
						if (seat === WATCHER_SEAT) watcherEnvelopes.push(envelope);
						const f = envelope.frame as { method?: string; message?: string; enable1?: boolean };
						if (seat === 0 || seat === 1) {
							if (f.method === 'showPromptMessage' && typeof f.message === 'string') notes[seat]!.prompt = f.message;
							else if (f.method === 'updateButtons') notes[seat]!.ok = f.enable1 === true;
						}
					},
				});

				const spec: MatchSpec = {
					seed: 20261027,
					seats: [
						{ name: 'A', ai: false, deck: precon('Spirit Flames') },
						{ name: 'B', ai: false, deck: precon('Decay') },
					],
				};
				const match = registry.create(spec);
				expect(await match.whenRunning(120_000)).toEqual({ ok: true });

				// A few seconds of the simplest possible navigation — OK whatever is
				// offered, Cancel if stuck — is enough real traffic to prove the
				// plumbing; this is not a driver of good play (see `scenario.ts`'s own
				// disclaimer) and the match is never carried to a finished game.
				const deadline = Date.now() + 10_000;
				let stuckSince = Date.now();
				let lastPrompts = ['', ''];
				while (Date.now() < deadline && match.status === 'running') {
					for (const seat of [0, 1]) {
						const n = notes[seat]!;
						if (n.ok) match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
						else if (n.prompt !== '' && Date.now() - stuckSince > 1000) match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' }));
					}
					if (notes.map((n) => n.prompt).join('|') !== lastPrompts.join('|')) {
						lastPrompts = notes.map((n) => n.prompt);
						stuckSince = Date.now();
					}
					await sleep(100);
				}
				match.stop();
				await waitUntil(() => liveJvmCount() === 0, 'the match JVM to exit', 20_000);
				jvm.close();

				const actionsPath = join(dir, `${match.id}${ACTIONS_SUFFIX}`);
				const publicPath = join(dir, `${match.id}${PUBLIC_SUFFIX}`);
				await waitUntil(() => existsSync(actionsPath) && existsSync(publicPath), 'the recording to flush to disk', 10_000);

				expect(sentCommands).toBeGreaterThan(0);

				const actionsLines = linesOf(actionsPath);
				expect(actionsLines[0]).toMatchObject({ t: 'header', v: 1, matchId: match.id, roomId: 'r-jvm-test' });
				expect(actionsLines.at(-1)).toMatchObject({ t: 'end' });
				const cmdLines = actionsLines.filter((l) => l.t === 'cmd');
				expect(cmdLines.length).toBe(sentCommands);

				const publicLines = linesOf(publicPath);
				expect(publicLines[0]).toMatchObject({ t: 'header', v: 1, matchId: match.id, roomId: 'r-jvm-test' });
				expect(publicLines.at(-1)).toMatchObject({ t: 'end' });
				const envLines = publicLines.filter((l) => l.t === 'env');
				expect(envLines.length).toBe(watcherEnvelopes.length);
				expect(envLines.map((l) => l.env)).toEqual(watcherEnvelopes);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
