/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/limits` (w93-K3). Every export and
 * signature below is unchanged from before this moved into the kernel — this path's ~20 importers
 * (routes, pools, play/socket.ts) need no edit.
 *
 * `httpCaller` binds the kernel's injected caller-id deriver to this app's own identity scheme
 * (`room/identity.ts`). `callerOf` builds the full `Caller` the room layer wants: it is NOT moved
 * into the kernel (`room/lobby.ts`'s `Caller` and `UNNAMED` stay app-side, by the wave's own
 * ruling), and `UNNAMED` is copied here rather than imported from `room/lobby.ts` — this file is
 * `platform` and `room/lobby.ts` is `tangled` (`scripts/layers/layers.json`), so importing it back
 * would restore the very `platform→tangled` edge this wave cuts
 * (`scripts/layers/ratchet.test.ts`, the `http/request.ts→../room/lobby.js` edge). The object
 * `callerOf` builds matches `room/lobby.ts`'s `Caller` shape structurally, which is all a caller
 * of `callerOf` needs — nothing here imports that type either.
 */
import type { ParticipantId } from '@wolffm/rooms-protocol';
import type { RateLimitConfig } from '@wolffm/rooms-server';
import type { Request, Response } from 'express';

import {
	bodyErrors,
	makeCallerId,
	parseBody,
	readBody,
	costlyActLimit as kernelCostlyActLimit,
	perCallerLimit as kernelPerCallerLimit,
	type BodySchema,
} from '@hadoku/service-kernel/limits';

import { accountIdOf, userNameOf, verifiedOf } from '../edge-auth.js';
import { identityFromHeaders } from '../room/identity.js';

export { bodyErrors, parseBody, readBody };
export type { BodySchema };

/**
 * The caller, by the edge's headers. A request the edge named nobody on gets a
 * fresh ephemeral id, which matches no seat and no member — the right answer
 * for someone the edge could not name.
 */
export const httpCaller: (req: Request) => ParticipantId = makeCallerId(identityFromHeaders);

/** `room/lobby.ts`'s own word for an unnamed member. Kept in sync by hand — see this file's header. */
const UNNAMED = 'friend';

/**
 * Who is asking, for a lobby call: the id, the DISPLAY NAME (`X-User-Name`, never the opaque
 * userId — a roster is for humans; a key the edge sent no name for gets `UNNAMED`), and the userId
 * a saved room keeps instead of the name (R12), and whether the operator verifies them.
 */
export function callerOf(req: Request) {
	return { id: httpCaller(req), name: userNameOf(req) ?? UNNAMED, userId: accountIdOf(req), verified: verifiedOf(req) };
}

/**
 * A per-caller token bucket for a costly step: each pass reports `costly-act` and each refusal
 * `rate-limited`, both named by `act`, so telemetry shows who is spending the expensive steps and
 * who hit the ceiling (`telemetry.ts` throttles the posts). `headers` are the caller's own, for
 * the report. `null` is no limit — the e2e stacks' `CARDTABLE_E2E_NO_RATE_LIMITS`, where one test
 * identity makes every room and starts every match of a run.
 */
export function costlyActLimit(
	cfg: RateLimitConfig | null,
	opts: { act: string; now?: () => number; onRefused?: () => void },
): (caller: ParticipantId, headers: Request['headers']) => boolean {
	return kernelCostlyActLimit(cfg, opts);
}

/**
 * {@link costlyActLimit} for a route: false once the 429 (with `Retry-After`) is sent. A route
 * asks AFTER reading its body, so only a request that would do the work spends a token.
 */
export function perCallerLimit(
	cfg: RateLimitConfig | null,
	refusal: string,
	opts: { act: string; now?: () => number; onRefused?: () => void },
): (req: Request, res: Response) => boolean {
	return kernelPerCallerLimit(cfg, refusal, { ...opts, callerId: httpCaller });
}
