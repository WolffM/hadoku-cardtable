/**
 * The one call site of `MatchRegistry.restore`: failover starts a match again elsewhere, from its
 * latest turn-start snapshot or, before the first one, from its spec. Null only for a match the
 * registry does not know.
 */

import type { MatchRegistry } from '../match.js';
import type { Restorer } from './coordinator.js';

export function registryRestorer(registry: MatchRegistry): Restorer {
	return {
		restore(matchId) {
			const restored = registry.restore(matchId);
			if (restored === null) return null;
			return restored.from === 'snapshot' ? { from: 'snapshot', turn: restored.turn } : { from: 'spec' };
		},
	};
}
