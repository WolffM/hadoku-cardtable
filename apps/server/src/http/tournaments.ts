/*
 * GET /api/tournaments — every past pod, newest first (`room/tournaments.ts`).
 * Friend-gated like every other `/api` route.
 */

import type { Request, Response, Router } from 'express';

import type { Tournaments } from '../room/tournaments.ts';

export function attachTournaments(api: Router, deps: { tournaments: Tournaments }): void {
	api.get('/tournaments', (_req: Request, res: Response) => {
		res.json({ tournaments: deps.tournaments.list() });
	});
}
