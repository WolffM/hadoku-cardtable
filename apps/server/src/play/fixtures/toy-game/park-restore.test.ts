import type { ParticipantId } from '@wolffm/rooms-protocol';
import { describe, expect, it } from 'vitest';

import type { MatchSpec } from '../../host.js';
import { inProcessHost } from '../../runtimes/in-process.js';
import { toyAdapter } from './adapter.js';
import { ToyMatch, type ToyMatchDeps } from './match.js';
import { type ToyCheckpoint, toyEngine } from './rules.js';

/**
 * w105 §K step 4: a non-Forge game parks at a checkpoint and restores from it — generically,
 * through `MatchShell.latestCheckpoint`/`remember` and `GameAdapter.restoreSpec`, the same seam a
 * generic `HostedMatch` would use to park through `parked.ts` once that is wired (Forge's own
 * stays `ParkedStore.park`, unchanged this wave). Nothing here touches disk: "parking" is letting
 * the first match go and keeping only what a restart would have — its checkpoint and its seats'
 * owners — then building a second `ToyMatch` from them over a FRESH `inProcessHost`, as a
 * restarted server's would be.
 */

const ALICE = 'fk:alice' as ParticipantId;
const BOB = 'fk:bob' as ParticipantId;

const SPEC: MatchSpec = { seats: [{ ai: false, name: 'Alice', deck: null }, { ai: false, name: 'Bob', deck: null }] };

function deps(): ToyMatchDeps {
	return { log: () => undefined, host: inProcessHost(toyEngine()), emit: () => undefined, emitWatchers: () => undefined };
}

describe('a toy match parks at a checkpoint and restores from it through a fresh in-process host', () => {
	it('finishes from 2-1 with the same seats after a restart', () => {
		const first = new ToyMatch('toy-park-1', SPEC, deps());
		first.start();
		expect(first.claim(ALICE)).toEqual({ ok: true, seat: 0, fresh: true });
		expect(first.claim(BOB)).toEqual({ ok: true, seat: 1, fresh: true });

		first.act({ t: 'score', seat: 0 });
		first.act({ t: 'score', seat: 1 });
		first.act({ t: 'score', seat: 0 }); // 2-1, nobody has won yet
		expect(first.status).toBe('running');
		expect(first.latestCheckpoint).toEqual({ score: [2, 1] });

		// What a restart has: the checkpoint and the seats' owners, nothing else of the game in memory.
		// (`latestCheckpoint` is opaque to the shell, `unknown`; only the game that wrote it — here,
		// this test standing in for `ToyMatch`'s own caller — knows it is a `ToyCheckpoint`.)
		const owners = first.owners();
		const checkpoint = first.latestCheckpoint as ToyCheckpoint;

		const second = new ToyMatch('toy-park-1', toyAdapter.restoreSpec(SPEC, checkpoint), deps(), {
			epoch: first.epoch,
			owners,
			startedAt: first.startedAt,
			checkpoint,
		});
		second.start();
		expect(second.status).toBe('running');
		expect(second.seats.map((s) => s.owner)).toEqual(owners);
		expect(second.latestCheckpoint).toEqual({ score: [2, 1] });

		// One more point for seat 0 is the match (3-1), picking up exactly where the first match left off.
		second.act({ t: 'score', seat: 0 });
		expect(second.status).toBe('over');
		expect(second.winners).toEqual([0]);
		expect(second.losers).toEqual([1]);
	});
});
