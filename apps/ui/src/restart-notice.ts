/**
 * A planned restart, told apart from a lost connection.
 *
 * Before a deploy's SIGTERM closes its sockets, the server tells every one of
 * them it is restarting (`SERVER_RESTARTING_EVENT`). A socket that heard that
 * and then dropped is `updating` for the next {@link QUIET_RECONNECT_MS}: it is
 * coming back on its own, so the screen says so quietly. Past that, or after a
 * drop with no notice, it is an ordinary lost connection again.
 */
import { SERVER_RESTARTING_EVENT } from '@hadoku/shared';

/** How long a planned restart reads as updating before it reads as reconnecting. */
export const QUIET_RECONNECT_MS = 8_000;

/** How old a notice may be and still explain the drop that follows it. */
export const NOTICE_FRESH_MS = 10_000;

interface Listens {
	on(event: string, handler: () => void): void;
}

export interface RestartClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: RestartClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Watch `socket` for a planned restart. `onChange(updating)` runs when the
 * socket drops after a notice (true) and again when it reconnects or the quiet
 * window ends (false); `back` says which, since a socket back is not yet a
 * screen back (a match's rejoin, `play/live/match.ts`).
 */
export function watchRestart(socket: Listens, onChange: (updating: boolean, back: boolean) => void, clock: RestartClock = realClock): void {
	let noticedAt: number | null = null;
	let updating = false;
	let quiet: unknown = null;
	const set = (next: boolean, back = false) => {
		if (quiet !== null) clock.clearTimeout(quiet);
		quiet = null;
		if (next === updating) return;
		updating = next;
		onChange(next, back);
	};
	socket.on(SERVER_RESTARTING_EVENT, () => {
		noticedAt = clock.now();
	});
	socket.on('disconnect', () => {
		const planned = noticedAt !== null && clock.now() - noticedAt <= NOTICE_FRESH_MS;
		noticedAt = null;
		if (!planned) return set(false);
		set(true);
		quiet = clock.setTimeout(() => set(false), QUIET_RECONNECT_MS);
	});
	socket.on('connect', () => {
		noticedAt = null;
		set(false, true);
	});
}
