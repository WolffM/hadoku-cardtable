# L — V7: the log keeps the whole game, not the last 8

Operator (playtest 6, `docs/planning/playtest-ledger.md`): *"the log shows only the current
turn; keep the whole game's log."*

## What changed

`apps/ui/src/play/live/match.ts`: `SAYS_KEPT` raised from `8` to `2000`. It used to equal the
server's own per-seat cap (`apps/server/src/play/match.ts`'s own `SAYS_KEPT`) on purpose — a
snapshot's clear-and-re-send reproduced exactly what it cleared. That coupling is now gone on
purpose: the client's cap only bounds how much the CLIENT holds once a line has arrived, and
2000 lines is a generous bound chosen to keep memory finite over a very long game, not a mirror
of the server's own number.

`apps/ui/src/play/live/LiveBoard.tsx`'s `SAYS_SHOWN = SAYS_KEPT` already drew everything the
match held, so no second cap needed raising — the logbook shows all 2000 once the client holds
them.

## What this does NOT fix (server's half, w40 lane C's file)

A reconnect still refills from `forge:join`/`forge:resync`, which the server answers with
its own kept says — `apps/server/src/play/match.ts`'s `SAYS_KEPT`, still `8`, not this wave's
file. So a seat that reconnects mid-game still sees its history drop to whatever the server
resends. Not a regression this change introduces (the cap was 8 on both ends before this); not
fixed by this change either, and not this lane's file this wave.

## Unit tests

`apps/ui/src/play/live/match.test.ts`, `describe('the says, and full control')`:

- `holds a generous history, not the server's old eight` — sends 40 `message` notifies in one
  batch and asserts all 40 survive, newest last.
- `is still bounded, so a very long game cannot grow the log forever` — fills to exactly
  `SAYS_KEPT` (2000) lines in one round trip, then sends one more and asserts the total stays at
  2000 with the oldest line gone.

Run from the worktree root (`npx vitest run apps/ui/src/play/live/match.test.ts
apps/ui/src/play/live/LiveBoard.test.ts`): **266/266 passed, exit 0** (109 in `match.test.ts`,
157 in `LiveBoard.test.ts`).

`pnpm --filter @hadoku/ui exec tsc --noEmit -p tsconfig.json`, errors outside `Board.tsx` and
`gestures/*` (lane G's files, mid-edit this wave): **none** — exit effectively clean for this
lane's files.

## Mutation test

Set `SAYS_KEPT` back to `8` in `match.ts`, ran the new test alone
(`npx vitest run apps/ui/src/play/live/match.test.ts -t "holds a generous history"`):

- **Mutated (cap = 8): 1 failed** — `expected [ 'line 33', ... ] to have a length of 40 but got
  8`.
- **Restored (cap = 2000): 1 passed.**

Full suite re-run after restoring: 266/266 passed, exit 0.
