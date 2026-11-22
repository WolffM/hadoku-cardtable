/**
 * The platform tier ladder, complete, and its one ordering: the server's gates
 * (`@hadoku/service-kernel/auth` re-exports both) and the page's (`game-ui`'s
 * friends-only check) read the same list. Here, not in the kernel, because the
 * browser needs it too and a published package cannot reach into another's src.
 *
 * `wife` sits above `service` and below `admin` deliberately: full reach across
 * the apps, none of the credential-management surface. `guest` is an account a
 * visitor made themselves (or the edge made on arrival): a passkey and a name,
 * no key anyone handed out. `member` is a guest the operator has verified.
 */
export const TIER_ORDER = ['public', 'guest', 'member', 'friend', 'service', 'wife', 'admin'] as const;
export type Tier = (typeof TIER_ORDER)[number];

export function rankOf(tier: string): number {
	const i = TIER_ORDER.indexOf(tier as Tier);
	// An unknown tier is not a high one. A future tier name this build has never
	// heard of must not out-rank the floor by accident.
	return i === -1 ? 0 : i;
}
