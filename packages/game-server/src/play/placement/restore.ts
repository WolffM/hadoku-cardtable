/**
 * The one call site of `MatchRegistry.restore`: failover starts a match again elsewhere, from its
 * latest turn-start snapshot or, before the first one, from its spec. Null only for a match the
 * registry does not know.
 */

import type { Restorer } from './coordinator.js';

/** What this needs of `match.ts`'s `MatchRegistry`, which satisfies it structurally. */
export interface Restorable {
	restore(id: string): { from: 'snapshot'; turn: number } | { from: 'spec' } | null;
	get(id: string): { status: string } | undefined;
}
export function registryRestorer(registry: Restorable): Restorer {
	return {
		restore(matchId) {
			const restored = registry.restore(matchId);
			if (restored === null) return null;
			return restored.from === 'snapshot' ? { from: 'snapshot', turn: restored.turn } : { from: 'spec' };
		},
		over: (matchId) => registry.get(matchId)?.status === 'over',
	};
}
