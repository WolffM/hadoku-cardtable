/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/capacity` (w93-K3).
 *
 * Every export and signature below is unchanged from before this moved into the kernel:
 * `index.ts` imports this path exactly as it did. The one cardtable-specific bit is which request
 * path is counted on its own, never timed — `/api/art/`, cardtable's card-art redirect — and what
 * the posted event calls that count (`artRedirects`); the kernel's own sampler knows neither.
 */
import type { CapacityDeps as KernelCapacityDeps, CapacitySampler } from '@hadoku/service-kernel/capacity';
import { capacitySampler as kernelCapacitySampler } from '@hadoku/service-kernel/capacity';

export { CAPACITY_WINDOW_MS, SAMPLE_MS, type CapacitySampler, type Gauges } from '@hadoku/service-kernel/capacity';

/** A card image request (`http/card-art.ts`): a redirect to the art host, one per card a page draws. */
export const isArtRedirect = (path: string): boolean => path.startsWith('/api/art/');

export type CapacityDeps = Omit<KernelCapacityDeps, 'uncountedPath' | 'uncountedField'>;

export function capacitySampler(deps: CapacityDeps): CapacitySampler {
	return kernelCapacitySampler({ ...deps, uncountedPath: isArtRedirect, uncountedField: 'artRedirects' });
}
