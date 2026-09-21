/*
 * The bench's refusals.
 *
 * This is temporary production code with a proxy in it, which is exactly the
 * combination that earns a test rather than a promise. Two properties matter:
 * it does not exist unless switched on, and its websocket half applies the tier
 * floor by hand — because `upgrade` runs no express middleware, so nothing else
 * will apply it for us.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

import { attachLab, labIsOn, labLayout, streamIndexOf } from './index.ts';

const ORIGINAL = process.env.CARDTABLE_LAB;
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.CARDTABLE_LAB;
	else process.env.CARDTABLE_LAB = ORIGINAL;
	vi.restoreAllMocks();
});

// `on` is injected everywhere so these assertions do not depend on whether THIS
// host has the bench switched on. The first run of this file failed for exactly
// that reason, which is the bug the seam exists to prevent.
const deps = { minTier: 'friend', cheerpjDir: null, streamBasePort: 6080, streamCount: 2 };
const off = { ...deps, on: () => false };

describe('the bench does not exist unless switched on', () => {
	it('attaches nothing at all without CARDTABLE_LAB=1', () => {
		delete process.env.CARDTABLE_LAB;
		const server = createServer();
		const before = server.listenerCount('upgrade');
		expect(attachLab(express.Router(), server, off)).toBeNull();
		// The real assertion: no upgrade listener, so a websocket cannot reach it
		// even if something guessed the path.
		expect(server.listenerCount('upgrade')).toBe(before);
		server.close();
	});

	it('refuses any value that is not exactly "1"', () => {
		const server = createServer();
		for (const v of ['0', 'true', 'yes', '']) {
			process.env.CARDTABLE_LAB = v;
			// The marker file is the other switch; this asserts the env one alone.
			expect(attachLab(express.Router(), server, { ...deps, on: () => labIsOn(() => false) }), `CARDTABLE_LAB=${v}`).toBeNull();
		}
		server.close();
	});

	it('an unreadable marker is not an on switch — it fails CLOSED', () => {
		delete process.env.CARDTABLE_LAB;
		// A thing that opens a proxy must not switch itself on because a stat
		// threw. The check is injectable precisely so this is provable rather
		// than asserted in a comment.
		expect(
			labIsOn(() => {
				throw new Error('EACCES');
			}),
		).toBe(false);
	});

	it('the marker file turns it on without any env var', () => {
		delete process.env.CARDTABLE_LAB;
		expect(labIsOn(() => true)).toBe(true);
		expect(labIsOn(() => false)).toBe(false);
	});
});

describe('which container a path names', () => {
	it('reads the index out of a stream path', () => {
		expect(streamIndexOf('/lab/stream/0/websockify', 2)).toBe(0);
		expect(streamIndexOf('/lab/stream/1', 2)).toBe(1);
		expect(streamIndexOf('/lab/stream/1?token=x', 2)).toBe(1);
	});

	it('refuses an index outside the containers that exist', () => {
		// The live hazard: /lab/stream/9/ must not reach port 6089, where
		// something unrelated may be listening on this host.
		expect(streamIndexOf('/lab/stream/2/websockify', 2)).toBeNull();
		expect(streamIndexOf('/lab/stream/99/websockify', 2)).toBeNull();
		expect(streamIndexOf('/lab/stream/-1/websockify', 2)).toBeNull();
	});

	it('is not a stream path at all', () => {
		expect(streamIndexOf('/socket.io/?EIO=4', 2)).toBeNull();
		expect(streamIndexOf('/lab/cheerpj/index.html', 2)).toBeNull();
		expect(streamIndexOf(undefined, 2)).toBeNull();
		// Adjacent but not ours — must fall through so socket.io still gets it.
		expect(streamIndexOf('/lab/streaming/0', 2)).toBeNull();
	});
});

describe('what the bench exposes, read off the disk', () => {
	const noFiles = () => false;

	it('exposes nothing when nothing is staged', () => {
		expect(labLayout(noFiles, () => '0')).toEqual({ cheerpjDir: null, streamCount: 0 });
	});

	it('a malformed container count is ZERO containers, not a guess', () => {
		// Each container is a proxy to a port. Guessing here is a port scan.
		for (const bad of ['', 'two', '-1', '1.5', 'NaN', '99']) {
			expect(labLayout(() => true, () => bad).streamCount, `STREAMS=${bad}`).toBe(0);
		}
	});

	it('is bounded at 8 even if the file says more', () => {
		expect(labLayout(() => true, () => '8').streamCount).toBe(8);
		expect(labLayout(() => true, () => '9').streamCount).toBe(0);
	});

	it('an unreadable STREAMS file exposes no containers', () => {
		expect(
			labLayout(
				() => true,
				() => {
					throw new Error('EACCES');
				},
			).streamCount,
		).toBe(0);
	});
});
