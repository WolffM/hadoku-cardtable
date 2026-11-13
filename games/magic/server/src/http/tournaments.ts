/*
 * GET /api/tournaments — every past pod two or more people played, newest first (`room/tournaments.ts`,
 * `playedByPeople`).
 * GET /api/tournaments/featured — the one the front page's wildcard opens on
 * (`room/featured-tournament.ts`), or `null`.
 * Member-gated like every other `/api` route.
 *
 * A record keeps its people by userId (R12); each is looked up here, when shown
 * (`people.ts`): their name as it is now, their character and their look. The
 * userIds themselves never leave the server. A record from before they were
 * kept draws its people by the names it kept, with no faces.
 */

import type { Request, Response, Router } from 'express';
import type { FeaturedTournament, Tournament } from '@hadoku/shared';

import { faceOfPerson, type People, type Person } from '@hadoku/game-server/people';
import { featuredTournament, playedByPeople } from '../room/featured-tournament.js';
import type { Tournaments } from '../room/tournaments.js';
import { UNNAMED } from '@hadoku/game-server/room/constants';

/** `t` as it is served: each person named and drawn as they are now, and no userIds. */
function shown({ users = {}, ...t }: Tournament, found: ReadonlyMap<string, Person>): Tournament {
	const names = { ...t.names };
	const faces = { ...t.faces };
	for (const [id, userId] of Object.entries(users)) {
		const person = found.get(userId);
		// Unreachable, or an account that is gone: the word an unnamed caller gets.
		names[id] = person?.name ?? names[id] ?? UNNAMED;
		if (person !== undefined) faces[id] = faceOfPerson(person);
	}
	return { ...t, names, faces };
}

export function attachTournaments(api: Router, deps: { tournaments: Tournaments; people: People; now?: () => number }): void {
	const now = deps.now ?? Date.now;
	const serve = async (list: readonly Tournament[]): Promise<Tournament[]> => {
		const found = await deps.people.resolve(list.flatMap((t) => Object.values(t.users ?? {})));
		return list.map((t) => shown(t, found));
	};
	api.get('/tournaments', async (_req: Request, res: Response) => {
		res.json({ tournaments: await serve((await deps.tournaments.list()).filter(playedByPeople)) });
	});
	api.get('/tournaments/featured', async (_req: Request, res: Response) => {
		const featured = featuredTournament(await deps.tournaments.list(), now());
		const body: FeaturedTournament = { tournament: featured === null ? null : ((await serve([featured]))[0] ?? null) };
		res.json(body);
	});
}
