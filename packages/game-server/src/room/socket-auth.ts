/**
 * `tierOf` over the sanitized handshake headers — the same tier floor every
 * socket handshake is gated on, whatever it carries once admitted. Generic:
 * nothing here names a draft, a pod or a game type.
 *
 * Split out of `room/socket.ts` (wave 110 §L). `room/serve.ts`'s room feed
 * (not a draft) reads the same tier floor from the same handshake read —
 * see that file's own `requireMinTier`-equivalent — rather than a second copy
 * of this cast, which is exactly how the socket path and the HTTP path used
 * to come to disagree about who is allowed in.
 */
import type { Request } from 'express';
import type { IncomingHttpHeaders } from 'node:http';

import { tierOf } from '../edge-auth.js';

export function handshakeTier(headers: IncomingHttpHeaders): string {
	// `tierOf` reads exactly one header off `req.headers`, but it is typed for an
	// express `Request` and a handshake carries a bare `IncomingMessage`. The
	// cast is here rather than a second copy of the header read: a duplicated
	// tier lookup is precisely how the socket path and the HTTP path come to
	// disagree about who is allowed in, which is the bug `edge-auth.ts`'s header
	// is written about.
	return tierOf({ headers } as unknown as Request);
}
