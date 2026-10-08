# §W — the wire and the other screen (wave 59)

## The two messages

1. **`presence` gains `placing`** (`packages/shared/src/presence.ts`,
   `PresenceSchema`): `placing: { at: PresenceSpotSchema } | null`, default
   `null`. Sent only on a release (`sendRelease`, in the SAME message as
   `held: false`), carrying the exact release point — the same spot `from`
   already carries on a release, but as a durable, dedicated field the
   receiver can wait a back AT (rather than inferring the wait from timing,
   the old `backWas`/`HANDOFF_MS` heuristic). A pre-deploy sender (no
   `placing` key at all) still parses, defaulted to `null`.

2. **`forge:placed`** (new `packages/shared/src/placed.ts`): `{ matchId,
   type: 'placed', spell: <stack item id>, at: PresenceSpotSchema }`. Sent by
   `apps/ui/src/play/live/presence.ts` when the OWNER's `placed.ts` (lane S)
   fires `onSpellMoved` for a spell NOT in `theirCards()` (i.e. this seat's
   own — a move the wire itself just echoed in, for the OPPONENT's spell,
   never bounces back out). The server (`apps/server/src/play/socket.ts`)
   relays it to the match's other sockets stamped with the seat, the same
   shape `forge:arrangement`'s relay is.

## The replay

`socket.ts` keeps a `Map<string, PlacedEcho>` (`placed`, keyed
`${matchId}#${spell}`, bounded at `ARRANGEMENTS_KEPT` entries like
`arrangements`/`placements` already are) and, on `forge:join`, replays every
entry for the match to the joining socket — the same loop `forge:placement`'s
own replay already is. This is what makes a reload still show a placed
spell where its owner last dragged it to.

## The receive path (`presence.ts`)

- A release carrying `placing.at` parks a `.presence__back[data-waiting]` at
  the exact point (`placeSpot`), not a battlefield gap — a spell has none.
  `waiting` now carries a `forBattlefield` flag so the existing permanent
  path (`onPlacement`/`forge:placement`, which still supersedes this the
  moment it arrives) and this new spell-wait never fight over the same
  "is the card here yet" check — the permanent's own `pendingPlacementFor`
  reservation only ever applies to `forBattlefield: true`.
- `handoff()` (woken by `host.watch`) drops its `.stack__item` lookup — the
  stack gallery is gone — and instead, once a NEW id is in `theirCards()`
  that is **not** already on the battlefield (an unrelated permanent arriving
  mid-wait is ignored), calls `placeSpell(id, backAt, 'them')` then
  `commitSpell(id)` — lane S's own doc confirms `commitSpell` only flips
  `committed`, never repositions, so the point has to come from `placeSpell`
  first, at the exact spot the back was waiting (`backAt`).
- `forge:placed` is received and calls `moveSpell(parsed.data.spell,
  placeSpot(canvas, parsed.data.at))`.
- `jvm-harness.ts`: `forge:placed` joins `forge:presence`/`forge:arrangement`/
  `forge:client` in the side-channel allow-list the harness's fake transport
  never routes through `Match.fromClient`.

## Mutation counts

- **Drop the replay** (`socket.ts`'s `for (const [k, held] of placed) { … }`
  loop at join): `socket.test.ts` — **1 of 56 FAILS**
  (`relays a seat’s move of a placed spell … and replays the last one per
  spell to whoever joins next`, timed out waiting for the reload’s replay).
  Restored: 56/56.
- **Drop `placing` from `PresenceSchema`** (the whole field, schema-wide):
  **12 of 87 FAIL** across `packages/shared/src/presence.test.ts`,
  `apps/ui/src/play/live/presence.test.ts` and
  `apps/server/src/play/socket.test.ts` (parses rejecting the field outright,
  and `draw()` throwing on `echo.placing` being `undefined`). Restored:
  87/87.
- **Drop the `placing.at` wait specifically** (the `else if (placingAt !==
  null)` branch in `presence.ts`'s `draw()`, disabled in place): `presence
  .test.ts` (UI) — **1 of 20 FAILS** (`a release carrying placing.at waits a
  back at that exact point …` — the back never parks; nothing but the old
  generic fallback, which drops it at once instead of waiting). Restored:
  20/20.

## Claw proof

**Not run yet.** Lane S's `placed.ts`/`placed.css`/`Board.tsx` changes are on
disk in this worktree but not yet committed (no `S:`-titled commit on
`git log` as of this note). Per the brief: schema, server, unit tests and the
UI receive path are done and green locally (see below); claw proof of
`presence.spec.ts` (including the new cast/drag/reload test, item 4) waits
for S's commit to land on HEAD, since it draws the `[data-placed-spell]`
elements that test reads. **Status: ready for proof — report sent, lane
paused here per the brief's own instruction, resuming once S lands.**

## Local verification (this worktree, no jar env)

- `pnpm --filter @hadoku/shared run typecheck` — clean.
- `pnpm --filter @hadoku/server run typecheck` — clean.
- `pnpm --filter @hadoku/ui run typecheck` — clean (the one remaining error
  in the UI package is in lane S's own `placed.test.ts`, still being
  authored; nothing of mine).
- `pnpm --filter @hadoku/e2e run typecheck` — clean.
- `pnpm exec vitest run packages/shared/src/presence.test.ts
  apps/ui/src/play/live/presence.test.ts apps/server/src/play/socket.test.ts`
  — **87/87 passed.**
