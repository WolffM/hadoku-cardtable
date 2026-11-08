/*
 * The generic `moveLegacyDir`/`moveLegacyState` behaviour is proved in
 * `@hadoku/service-kernel`'s own suite now (w93-K2). What stays here is
 * cardtable's own config pin (the `CARDTABLE_*` env var names and the
 * directory layout `config.ts` derives from `CARDTABLE_STATE_DIR`) plus a
 * smoke test that this path's re-export still works end to end.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveLegacyState } from './state-dir.ts';

describe('moveLegacyState (adapter smoke test)', () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'cardtable-state-'));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('moves the in-clone data/ into a state dir through cardtable\'s own import path', () => {
		const legacy = { dataDir: join(root, 'clone/data'), logDir: join(root, 'clone/logs') };
		mkdirSync(legacy.dataDir, { recursive: true });
		writeFileSync(join(legacy.dataDir, 'tournaments.json'), '[]');
		mkdirSync(legacy.logDir, { recursive: true });
		const state = join(root, 'state');
		const log = vi.fn();
		const moves = moveLegacyState({ stateDir: state, dataDir: state, logDir: join(state, 'logs') }, legacy, log);
		expect(moves.map((m) => m.moved)).toEqual([['tournaments.json'], []]);
	});
});

describe('CONFIG with CARDTABLE_STATE_DIR', () => {
	const KEYS = ['CARDTABLE_STATE_DIR', 'CARDTABLE_LOG_DIR', 'CARDTABLE_ROOMS_DIR', 'CARDTABLE_RECORDINGS_DIR'] as const;
	const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
	beforeEach(() => {
		for (const k of KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		vi.resetModules();
	});
	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('puts data directly in the state dir and logs in its logs/', async () => {
		process.env.CARDTABLE_STATE_DIR = '/srv-data/cardtable';
		const { CONFIG } = await import('./config.ts');
		expect(CONFIG.stateDir).toBe('/srv-data/cardtable');
		expect(CONFIG.dataDir).toBe('/srv-data/cardtable');
		expect(CONFIG.logDir).toBe('/srv-data/cardtable/logs');
		expect(CONFIG.roomsDir).toBe('/srv-data/cardtable/rooms');
		expect(CONFIG.recordingsDir).toBe('/srv-data/cardtable/recordings');
		expect(CONFIG.callersSeenFile).toBe('/srv-data/cardtable/callers-seen.json');
	});

	it('keeps the in-clone layout when unset, and a per-path env still wins', async () => {
		process.env.CARDTABLE_ROOMS_DIR = '/elsewhere/rooms';
		const { CONFIG, LEGACY_STATE } = await import('./config.ts');
		expect(CONFIG.stateDir).toBe('');
		expect(CONFIG.dataDir).toBe(LEGACY_STATE.dataDir);
		expect(CONFIG.logDir).toBe(LEGACY_STATE.logDir);
		expect(CONFIG.roomsDir).toBe('/elsewhere/rooms');
	});

	it('an explicit CARDTABLE_LOG_DIR still wins over the state dir', async () => {
		process.env.CARDTABLE_STATE_DIR = '/srv-data/cardtable';
		process.env.CARDTABLE_LOG_DIR = '/var/log/cardtable';
		const { CONFIG } = await import('./config.ts');
		expect(CONFIG.logDir).toBe('/var/log/cardtable');
		expect(CONFIG.dataDir).toBe('/srv-data/cardtable');
	});
});
