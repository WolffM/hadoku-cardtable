/**
 * A minimal game booted for real, in its own process, for `handover.test.ts`: the kernel as a
 * deploy generation sees it, started by a supervisor with a socket and a ready pipe. `GEN` names
 * it in every answer, so a test can tell which generation served a request.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEdgeAuth, rankOf, tierOf } from '../auth/index.ts';
import { createGate } from '../http/index.ts';
import { createGameServer, type GamePlugin } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'kernel-handover-'));
mkdirSync(join(dir, 'web'));
writeFileSync(join(dir, 'web/index.html'), '<!doctype html><script src="/fake/assets/a.js"></script>');
const edgeAuth = createEdgeAuth({
	edgeAuthSecret: () => 'seal',
	allowUnverifiedEdge: () => false,
	devTier: () => 'friend',
});
const gate = createGate({
	...edgeAuth,
	tierOf,
	rankOf,
	reportSealRefused: () => undefined,
	minTier: () => 'friend',
});
const gen = process.env.GEN ?? '?';

const slow: GamePlugin<Record<string, unknown>, object> = {
	name: 'slow',
	phase: 'routes',
	setup(ctx) {
		// Above the floor, like /health: a request this generation takes and must finish. Inside the
		// shutdown's request grace (300 ms), which is the kernel's promise to an in-flight request.
		ctx.sealed.get('/slow', (_req, res) => {
			console.log(`taken ${gen}`);
			setTimeout(() => res.type('text').send(`slow ${gen}`), 150);
		});
	},
};

await createGameServer({
	id: 'fake',
	config: {
		host: '127.0.0.1',
		port: 0,
		log: (entry) => console.log(JSON.stringify({ gen, ...entry })),
		edgeAuth,
		gate,
		basePrefix: '/fake',
		bundle: {
			indexHtml: join(dir, 'web/index.html'),
			webDir: join(dir, 'web'),
			embedEntries: [],
		},
		repoRoot: dir,
		restartEvent: 'fake-restarting',
		firstSeen: { file: join(dir, 'seen.json'), log: () => undefined },
		erase: { deriveParticipantId: (userId) => `fk:${userId}` },
	},
	state: {},
	plugins: [slow],
});
