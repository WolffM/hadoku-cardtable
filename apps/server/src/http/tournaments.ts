/*
 * GET /api/tournaments — every past pod, newest first (`room/tournaments.ts`).
 * Member-gated like every other `/api` route.
 *
 * A record keeps its people by userId (R12); each is looked up here, when shown
 * (`people.ts`): their name as it is now, their character and their look. The
 * userIds themselves never leave the server. A record from before they were
 * kept draws its people by the names it kept, with no faces.
 */

import type { Request, Response, Router } from 'express';
import type { Tournament } from '@hadoku/shared';

import { faceOfPerson, type People } from '../people.js';
import type { Tournaments } from '../room/tournaments.js';
import { UNNAMED } from '../room/lobby.js';

export function attachTournaments(api: Router, deps: { tournaments: Tournaments; people: People }): void {
	api.get('/tournaments', async (_req: Request, res: Response) => {
		const list = await deps.tournaments.list();
		const found = await deps.people.resolve(list.flatMap((t) => Object.values(t.users ?? {})));
		res.json({
			tournaments: list.map(({ users = {}, ...t }): Tournament => {
				const names = { ...t.names };
				const faces = { ...t.faces };
				for (const [id, userId] of Object.entries(users)) {
					const person = found.get(userId);
					// Unreachable, or an account that is gone: the word an unnamed caller gets.
					names[id] = person?.name ?? names[id] ?? UNNAMED;
					if (person !== undefined) faces[id] = faceOfPerson(person);
				}
				return { ...t, names, faces };
			}),
		});
	});
}
