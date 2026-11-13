/**
 * Wave 106 §R — "the AI wears its character" (`e2e/draft.spec.ts:1112`, carried from w105-Q):
 * `freeAiAvatar`'s exclusion pool reads `room.members`' avatarIds, which `people.ts`'s `applyPerson`
 * fills LAZILY, off the join (`plugins/routes.ts`'s `accounts.arrived`, fired-and-forgotten after
 * `join()` returns). A member seated behind an AI, with an AI seat drawn in the window before their
 * own account's look comes back, reads as avatar-less at draw time — so the AI can land on the exact
 * face the member is given moments later, and two faces in the same room end up sharing one.
 *
 * This file forces the exact collision (rather than racing the real async lookup) to isolate the
 * mechanism pods.ts owns: `resolvedAiAvatar`'s self-heal, read on every view rather than fixed at
 * seat time.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openLobby } from './lobby.ts';

const dirs: string[] = [];
afterAll(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-pods-'));
	dirs.push(dir);
	return dir;
}

const alice = { id: 'fk:0000000000000001', name: 'alice', userId: 'u-alice' };

describe('an AI seat drawn before its drafter’s own look resolves', () => {
	it('never shows the AI wearing the face a human in the room now wears', async () => {
		const lobby = await openLobby({ dir: await tempDir(), now: () => 1_700_000_000_000, log: () => undefined });
		const made = lobby.create(alice, { name: 'solo pod', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.sitSeat(id, alice.id).ok).toBe(true);
		// Down to the smallest pod: alice's own seat 0, and seat 1 for the AI.
		for (const seat of [2, 3, 4, 5, 6, 7]) expect(lobby.closeSeat(id, alice.id, seat, true).ok, `seat ${seat} closes`).toBe(true);

		// The AI seat is drawn while alice's own avatarId is still unset — exactly the state a fresh
		// join leaves a member in before `people.ts`'s `applyPerson` ever runs.
		expect(lobby.get(id)!.members.find((m) => m.id === alice.id)?.avatarId).toBeUndefined();
		expect(lobby.aiSeat(id, alice.id, 1, true).ok).toBe(true);
		const drawnForAi = lobby.get(id)!.game!.ai.avatarId;

		// The lazy lookup lands moments later and happens to give alice the very face the AI already
		// drew (the collision the race makes possible, forced here to isolate the mechanism).
		expect(lobby.setAvatar(id, alice.id, drawnForAi)).toBe(true);
		expect(lobby.get(id)!.members.find((m) => m.id === alice.id)?.avatarId).toBe(drawnForAi);

		// The AI's shown face must no longer be the one its own drafter now wears.
		expect(lobby.get(id)!.game!.ai.avatarId, 'the AI wears its character, not alice’s').not.toBe(drawnForAi);
		// And the redraw is stable: reading it again gives the same answer, not a fresh roll each time.
		expect(lobby.get(id)!.game!.ai.avatarId).toBe(lobby.get(id)!.game!.ai.avatarId);
	});
});
