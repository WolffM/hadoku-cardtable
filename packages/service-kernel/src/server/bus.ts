/**
 * The event bus a game's plugins share (`ctx.bus`): a typed emitter, synchronous, so a
 * listener runs inside `emit` and a plugin set up later hears what an earlier one emits from
 * then on. The kernel emits `listening` and `shutdown`; each game declares its own events in
 * the type parameter and emits them itself.
 */

/** The events the kernel itself emits. A type, not an interface, so it is an `EventMap`. */
export type KernelEvents = {
	/** The HTTP server is listening, before any `onListen` hook or `warm` plugin runs. */
	listening: { host: string; port: number };
	/** A signal began the shutdown, before any plugin's own `shutdown` runs. */
	shutdown: { signal: string; deadlineMs: number };
};

export type EventMap = Record<string, unknown>;

export interface Bus<E extends EventMap> {
	/** Listen for `event`; the returned function stops listening. */
	on<K extends keyof E & string>(event: K, listener: (payload: E[K]) => void): () => void;
	/** Call every listener of `event`, in the order they were added. */
	emit<K extends keyof E & string>(event: K, payload: E[K]): void;
}

export function createBus<E extends EventMap>(): Bus<E> {
	const listeners = new Map<string, Set<(payload: never) => void>>();
	return {
		on(event, listener) {
			const set = listeners.get(event) ?? new Set();
			listeners.set(event, set);
			set.add(listener as (payload: never) => void);
			return () => void set.delete(listener as (payload: never) => void);
		},
		emit(event, payload) {
			for (const listener of [...(listeners.get(event) ?? [])]) (listener as (p: typeof payload) => void)(payload);
		},
	};
}
