import { gunzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMatchRecordingWriter } from './writer.js';

let dir: string;

afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function linesOf(path: string): unknown[] {
	const text = gunzipSync(readFileSync(path)).toString('utf8');
	return text
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => JSON.parse(l));
}

describe('createMatchRecordingWriter', () => {
	it('writes a gzipped header, every buffered cmd/env line, and the end line, in order', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recordings-'));
		const writer = createMatchRecordingWriter({
			dir,
			matchId: 'm-1',
			actionsHeader: { matchId: 'm-1', roomId: 'r-1', pin: 'abc', bridge: 'def', server: '0.0.0', startedAt: '2026-01-01T00:00:00.000Z', spec: { seed: 1 } },
			publicHeader: { matchId: 'm-1', roomId: 'r-1', players: ['A', 'B'], ai: [false, false], decks: [null, null], art: [], startedAt: '2026-01-01T00:00:00.000Z' },
		});
		writer.actionCmd({ seat: 0, cmd: { t: 'act', seat: 0, frame: { method: 'selectButtonOk' } } });
		writer.actionCmd({ seat: 1, ask: 0, cmd: { t: 'reply', seat: 1, callId: 'c1', result: true } });
		writer.publicEnv({ at: 10, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify' } } });
		await writer.finish({ endedAt: '2026-01-01T00:10:00.000Z', reason: 'clean' }, { endedAt: '2026-01-01T00:10:00.000Z', winner: 0 });

		const actions = linesOf(join(dir, 'm-1.actions.jsonl.gz'));
		expect(actions).toEqual([
			{ t: 'header', v: 2, matchId: 'm-1', roomId: 'r-1', pin: 'abc', bridge: 'def', server: '0.0.0', startedAt: '2026-01-01T00:00:00.000Z', spec: { seed: 1 } },
			{ t: 'cmd', seat: 0, cmd: { t: 'act', seat: 0, frame: { method: 'selectButtonOk' } } },
			{ t: 'cmd', seat: 1, ask: 0, cmd: { t: 'reply', seat: 1, callId: 'c1', result: true } },
			{ t: 'end', endedAt: '2026-01-01T00:10:00.000Z', reason: 'clean' },
		]);

		const pub = linesOf(join(dir, 'm-1.public.jsonl.gz'));
		expect(pub).toEqual([
			{ t: 'header', v: 2, matchId: 'm-1', roomId: 'r-1', players: ['A', 'B'], ai: [false, false], decks: [null, null], art: [], startedAt: '2026-01-01T00:00:00.000Z' },
			{ t: 'env', at: 10, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify' } } },
			{ t: 'end', endedAt: '2026-01-01T00:10:00.000Z', winner: 0 },
		]);
	});

	it('writes an empty public stream (header + end only) for a match with no watcher envelopes', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recordings-'));
		const writer = createMatchRecordingWriter({
			dir,
			matchId: 'm-2',
			actionsHeader: { matchId: 'm-2', roomId: null, pin: null, bridge: 'def', server: '0.0.0', startedAt: '2026-01-01T00:00:00.000Z', spec: {} },
			publicHeader: { matchId: 'm-2', roomId: null, players: ['A', 'B'], ai: [false, true], decks: [null, null], art: [], startedAt: '2026-01-01T00:00:00.000Z' },
		});
		await writer.finish({ endedAt: '2026-01-01T00:01:00.000Z', reason: 'stopped' }, { endedAt: '2026-01-01T00:01:00.000Z', winner: null });
		expect(linesOf(join(dir, 'm-2.public.jsonl.gz'))).toHaveLength(2);
	});

	it('logs a write failure instead of throwing, and still resolves', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recordings-'));
		// A file where the writer expects a directory it can create a temp file inside.
		const blocked = join(dir, 'blocked');
		writeFileSync(blocked, 'not a directory');
		const errors: Record<string, unknown>[] = [];
		const writer = createMatchRecordingWriter({
			dir: blocked,
			matchId: 'm-3',
			actionsHeader: { matchId: 'm-3', roomId: null, pin: null, bridge: 'def', server: '0.0.0', startedAt: '2026-01-01T00:00:00.000Z', spec: {} },
			publicHeader: { matchId: 'm-3', roomId: null, players: ['A', 'B'], ai: [false, false], decks: [null, null], art: [], startedAt: '2026-01-01T00:00:00.000Z' },
			log: (e) => errors.push(e),
		});
		await expect(writer.finish({ endedAt: '2026-01-01T00:01:00.000Z', reason: 'clean' }, { endedAt: '2026-01-01T00:01:00.000Z', winner: null })).resolves.toBeUndefined();
		expect(errors.some((e) => e.evt === 'recording-dir-failed')).toBe(true);
		expect(errors.some((e) => e.evt === 'recording-write-failed')).toBe(true);
		expect(existsSync(join(blocked, 'm-3.actions.jsonl.gz'))).toBe(false);
	});
});
