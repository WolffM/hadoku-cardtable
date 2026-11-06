import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveLegacyDir, moveLegacyState } from './state-dir.ts';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'cardtable-state-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An in-clone `data/` as production has it: files and nested directories. */
function seedLegacy(dir: string): void {
	mkdirSync(join(dir, 'rooms'), { recursive: true });
	writeFileSync(join(dir, 'rooms', 'r1.json'), '{"id":"r1"}');
	mkdirSync(join(dir, 'recordings', 'm1'), { recursive: true });
	writeFileSync(join(dir, 'recordings', 'm1', 'actions.jsonl'), 'a\n');
	writeFileSync(join(dir, 'tournaments.json'), '[]');
}

describe('moveLegacyDir', () => {
	it('moves every entry into a state dir that does not exist yet, and removes the old dir', () => {
		const from = join(root, 'clone/apps/server/data');
		const to = join(root, 'state');
		seedLegacy(from);
		const move = moveLegacyDir(from, to);
		expect(move).toEqual({ from, to, moved: ['recordings', 'rooms', 'tournaments.json'], kept: [] });
		expect(existsSync(from)).toBe(false);
		expect(readFileSync(join(to, 'rooms', 'r1.json'), 'utf8')).toBe('{"id":"r1"}');
		expect(readFileSync(join(to, 'recordings', 'm1', 'actions.jsonl'), 'utf8')).toBe('a\n');
	});

	it('moves into a state dir that already exists (the deploy creates it before the first boot)', () => {
		const from = join(root, 'data');
		const to = join(root, 'state');
		seedLegacy(from);
		mkdirSync(join(to, 'logs'), { recursive: true });
		expect(moveLegacyDir(from, to)?.moved).toEqual(['recordings', 'rooms', 'tournaments.json']);
		expect(readdirSync(to).sort()).toEqual(['logs', 'recordings', 'rooms', 'tournaments.json']);
	});

	it('never overwrites what the state dir already holds: that entry stays in the clone and is reported', () => {
		const from = join(root, 'data');
		const to = join(root, 'state');
		seedLegacy(from);
		mkdirSync(to, { recursive: true });
		writeFileSync(join(to, 'tournaments.json'), '[1]');
		const move = moveLegacyDir(from, to);
		expect(move?.kept).toEqual(['tournaments.json']);
		expect(move?.moved).toEqual(['recordings', 'rooms']);
		expect(readFileSync(join(to, 'tournaments.json'), 'utf8')).toBe('[1]');
		expect(readFileSync(join(from, 'tournaments.json'), 'utf8')).toBe('[]');
	});

	it('does nothing when there is no old dir, or the state dir IS the old dir', () => {
		expect(moveLegacyDir(join(root, 'missing'), join(root, 'state'))).toBeNull();
		expect(existsSync(join(root, 'state'))).toBe(false);
		seedLegacy(join(root, 'data'));
		expect(moveLegacyDir(join(root, 'data'), join(root, 'data/'))).toBeNull();
		expect(existsSync(join(root, 'data', 'rooms', 'r1.json'))).toBe(true);
	});

	it('a second boot finds nothing left to move', () => {
		seedLegacy(join(root, 'data'));
		moveLegacyDir(join(root, 'data'), join(root, 'state'));
		expect(moveLegacyDir(join(root, 'data'), join(root, 'state'))).toBeNull();
	});
});

describe('moveLegacyState', () => {
	it('moves nothing without a state dir: dev, tests and e2e keep the in-clone layout', () => {
		seedLegacy(join(root, 'data'));
		const log = vi.fn();
		expect(moveLegacyState({ stateDir: '', dataDir: join(root, 'data'), logDir: join(root, 'logs') }, { dataDir: join(root, 'data'), logDir: join(root, 'logs') }, log)).toEqual([]);
		expect(log).not.toHaveBeenCalled();
		expect(existsSync(join(root, 'data', 'rooms', 'r1.json'))).toBe(true);
	});

	it('moves data/ into the state dir and logs/ into its logs/, one log line each', () => {
		const legacy = { dataDir: join(root, 'clone/data'), logDir: join(root, 'clone/logs') };
		seedLegacy(legacy.dataDir);
		mkdirSync(legacy.logDir, { recursive: true });
		writeFileSync(join(legacy.logDir, 'access.log'), 'x');
		const state = join(root, 'state');
		const log = vi.fn();
		const moves = moveLegacyState({ stateDir: state, dataDir: state, logDir: join(state, 'logs') }, legacy, log);
		expect(moves.map((m) => m.moved)).toEqual([['recordings', 'rooms', 'tournaments.json'], ['access.log']]);
		expect(log.mock.calls.map(([e]) => (e as { event: string }).event)).toEqual(['state-moved', 'state-moved']);
		expect(readFileSync(join(state, 'logs', 'access.log'), 'utf8')).toBe('x');
		expect(existsSync(join(root, 'clone/data'))).toBe(false);
		expect(existsSync(join(root, 'clone/logs'))).toBe(false);
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
