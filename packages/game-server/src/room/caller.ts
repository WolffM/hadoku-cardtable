/**
 * Who is asking. Generic to every room, whatever it plays: `id` from
 * `identityFromHeaders`, `name` from `userNameOf`, `userId` from
 * `accountIdOf` — the registry userId `id` was minted from, which is what a
 * saved room keeps (R12). null for a caller the edge named nobody, and for
 * the testing seed.
 *
 * Split out of `room/lobby.ts` (wave 110 §L): nothing here names a game
 * type, a pod, a draft or a format, so a non-Magic room (bomberman's) is
 * exactly as much a `Caller` as a Magic one.
 */
export interface Caller {
	id: string;
	name: string;
	userId: string | null;
	/**
	 * The edge's `X-Hadoku-Verified`: the operator verifies this person (`verifiedOf`). Absent is
	 * not verified, as the header's own absence is: a restored or synthetic caller verifies nobody.
	 */
	verified?: boolean;
}
