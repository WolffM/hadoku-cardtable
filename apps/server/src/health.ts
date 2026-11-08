/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/health`. Every name
 * and signature below is unchanged from before this module moved into the
 * kernel (w93-K2); `index.ts` and `health.test.ts` import this path exactly as
 * they did. The only cardtable-specific bit is `serviceIdOf`'s fallback: this
 * app's own id, used only when the base prefix is empty.
 */
import { healthResponse, readCommit, serviceIdOf as kernelServiceIdOf, type Commit, type HealthInput } from '@hadoku/service-kernel/health';

export { healthResponse, readCommit, type Commit, type HealthInput };

/** cardtable's child-apps id, from the prefix the edge serves it under (`/cardtable`, `/cardtable-ppe`). */
export function serviceIdOf(basePrefix: string): string {
	return kernelServiceIdOf(basePrefix, 'cardtable');
}
