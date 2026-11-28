# Tournament and pod state matrix (pre-tournament, 2026-11-28)

What every phase of a draft pod does with every event a tournament night throws at it, for every field
shape, decided from the rulings in `tournament-mode-plan.md` and `draft-pods-plan.md`. Built for Sunday
2026-11-29, the first many-player Bloomburrow set-cube pod into Swiss.

**Every cell is a test.** `games/magic/server/src/room/tournament-state-matrix.test.ts` drives the real
`Lobby` and pod code (`room/lobby.ts`, `room/pods.ts`, `@hadoku/draft`'s pairing) to each phase, fires each
event, and checks the invariants below. Then it plays the rest of the pod to its end and checks again:
7 phases × 11 events × 8 fields = 616 cells. The draft socket's side (who picks for a seat) is
`room/socket.test.ts`. Pairing across every mix of people and bots is `@hadoku/draft`'s `pairing.test.ts`.

## Invariants (checked after every event, and after every round to the end)

1. **No AI after the lock.** The entrants are the ones the deal fixed. No AI is added or swapped in, and a
   leaver is never replaced (ruling 5).
2. **Swiss holds.** Every entrant still in plays exactly once a round, as a table, a bot game or the bye.
   Nobody meets the same opponent twice.
3. **Nobody is stranded.** Every human at a live table is a room member who holds their seat at it. A table
   never waits for someone who left or was dropped.
4. **Everyone is named.** Every entrant in the standings is named by the room (a member, or a persona for a
   bot or a departed entrant). No raw id.
5. **It ends.** From wherever the event left it, the pod plays to `done` and is archived exactly once.
6. **Spectators stay.** A member watching from no seat is still in the room, and the room's one view is the
   hub (bracket, standings, a card per live match).

## Fields

| field | entrants | rounds | notes |
| --- | --- | --- | --- |
| 8 humans | 8 | 3 | no bye |
| 6 humans + 2 AI | 8 | 3 | the 2 bots play each other headless (a bot game) |
| 7 humans | 7 | 3 | a bye each round, never twice to one player |
| 5 humans | 5 | 3 | a bye each round |
| 2 humans + 6 AI | 8 | 3 | humans first: the two meet in round 1, then bots |
| 1 human + 7 AI | 8 | 3 | a solo pod's bots play whatever `botsPlay` says |
| 9 humans | 9 | 3 | the leader splits 5 + 4, two drafts, one Swiss of the humans, a bye |
| 16 humans | 16 | 3 | two full pods |

## Phases

`lobby` (seating, Ready) → `drafting` → `building` (the draft is done, round 1 is dealt at once, nobody has
pressed Play yet) → `in-play` (round 1, a game live) → `between` (one table done, others live) →
`last-round` (round = rounds, a game live) → `finished`.

## The matrix

✓ = holds as built. **FIXED** = was wrong, fixed by this lane (bugs below). — = the event has nothing
to act on in that phase (no table, no game), and nothing changes.

| event ↓ / phase → | lobby | drafting | building | in-play | between | last-round | finished |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tab closed, back inside 30 s | ✓ seat kept | ✓ draft seat held | ✓ | ✓ same match | ✓ | ✓ | ✓ |
| tab closed for minutes | ✓ pod seat kept | ✓ seat held; picks wait for them unless the **pick timer** is on (Sunday note 1) | **FIXED** (bug 2) kept their table seat | ✓ (a live match holds the seat) | **FIXED** (bug 2) | **FIXED** (bug 2) | ✓ |
| leaves for good | ✓ seat freed | **FIXED** (bugs 1, 5): seat picked by the draft bot at once; dropped at the deal, opponent wins round 1 | ✓ dropped, match forfeited 2–0 | ✓ dropped, game let go, match forfeited | ✓ | ✓ pod ends, archived | ✓ named in the standings |
| DQ by the leader | refused (`no-pod`): remove the seat instead | refused until the draft ends (workaround below) | ✓ dropped, match conceded | ✓ their game conceded | ✓ their done match stands, byes after | ✓ | refused (`no-pod`) |
| a player drops their table (Concede match) | — | — | ✓ a loss, stays in | ✓ | ✓ | ✓ | — |
| the leader resets a table's game | — | — | refused (`no-game`) | ✓ score and seats stand, the next start replays the game | ✓ (a live table) | ✓ | — |
| the leader resets the whole room | ✓ | refused (`pod-under-way`) | refused | refused | refused | refused | refused |
| server restart (a deploy, PM2) | ✓ (the plan's verdict is checked again) | ✓ draft restored from its snapshot | ✓ | ✓ same match id, same pairings | ✓ | ✓ | ✓ |
| a claw fails over a live match | — | — | — | ✓ the match keeps its id | ✓ | ✓ | — |
| the failover fails (game ends with no result) | — | — | — | ✓ series stands, the table replays the game | ✓ | ✓ | — |
| a chess clock flags | — | — | — | ✓ a loss for that seat, the series goes on | ✓ | ✓ | — |

Every row holds for every field above. The pairing rows (invariant 2) were wrong for every field with
both people and bots until bug 3.

### Bugs found and fixed (each RED first)

1. **A drafter who left mid-draft was dealt a round-1 table.** The pod's seats keep a drafter once the
   draft is dealt, so `#dealPodRounds` paired them like anyone. Their opponent's table waited forever on
   nobody, and only a DQ cleared it. Now an entrant gone before the deal is dropped at it: their pairing is
   the opponent's win, and they are named in the standings.
2. **A paired player away past the 30 s seat window lost their pod-table seat.** `releaseAbandonedSeats`
   freed a seat at a table with no game yet (a player closing the tab while building). Nothing gave it back,
   and any member could sit in it. Now a pod pairing's table keeps its players' seats, and `sit` refuses
   anyone else at it. The admin-only seeded testing rooms are the one exception: their seed leaves its seat
   for an admin to take.
3. **Humans-first Swiss repeated pairings.** Pairing each side alone (the operator's 2026-11-16 ruling)
   meant a side of two had nobody new after round 1. Two humans among six bots met all three rounds, and so
   did two bots among six humans. 17 of the 21 human/bot mixes repeated somewhere. Now a later round whose
   split pairing repeats falls back to a whole-field repeat-free pairing that still pairs humans first. A
   human meets a bot only when no fresh human is left for them, and an odd field's bye still goes to a bot
   first.
4. **The second pod of a split room had no pick timer and the default bots.** The socket read the room's
   settings with the pod's draft id (`<room>~1`), which names no room. Pod 2 ignored the leader's pick timer
   and bot model. Now the room is found through `podOfDraftId`.
5. **A drafter who pressed Leave mid-draft froze the whole pod** while the pick timer was off (the
   default). Their seat had nobody to pick for it. Now a dealt drafter no longer in the room is on a
   zero-length deadline, timer or not, and the draft bot picks for them at once. If they come back before
   the draft ends, the seat waits for them again.

### The known leftover from wtourney: a leaver shown as a raw id

Already fixed on main before this lane (e23485ea4: a tournament's entrants are locked in at the start, and
a leaver keeps their name through `RoomRecord.departed` and the boot's account sweep). Invariant 4 checks
it in every cell, a restart included, with the real `attachPeople` sweep.

## Sunday notes

1. **Turn the pick timer on in the draft room before dealing.** Without it, a drafter who closes the tab
   (rather than pressing Leave) holds their pod until they come back. With it, their seat picks the card
   they last pointed at, or the bot's, when time runs out. Severity: high (one AFK drafter stalls 7 people).
   Workaround if it is off and someone vanishes: the vanished player presses Leave from any tab. Their seat
   then picks at once (bug 5).
2. **DQ waits for the draft to end.** `dqPlayer` refuses until round 1 is dealt, and round 1 is dealt the
   instant the last pick is made. Severity: low. Workaround: DQ them the moment the draft ends. Their round-1
   match is conceded, and their opponent plays on.
3. **No whole-room reset once the draft is dealt.** That is intended: a reset would throw away every
   pool. Reset a single table's game instead (the score stands).
4. **A Concede match is not a drop.** The player who concedes stays in and is paired next round. To take
   someone out for good, DQ them (or they press Leave).

## Decisions made without the operator (2026-11-28, overnight)

- **A drafter who leaves mid-draft is dropped, never handed to a bot** (bug 1). Rejected: letting the draft
  bot's seat play their Swiss rounds as an AI entrant. That is ruling 5's "no AI replacing a leaver", and
  the 2026-11-20 ruling *"as soon as a tournament begins, the players are locked in"*.
- **The draft bot picks for a seat whose drafter left, even with the timer off** (bug 5). Rejected: waiting
  for the leader to turn the timer on. Nothing else unsticks the pod, and the seat's player is already out
  of the event.
- **A pod table's seats belong to its pairing** (bug 2). Rejected: re-seating a returning player
  automatically. That keeps a window where a spectator can take the seat, and adds a second path.
- **Humans-first pairing falls back to the whole field only when the split would repeat** (bug 3).
  Rejected: always pairing the whole field. That changes rounds the operator has already seen pair the way
  they ruled.

## The claw e2e for Sunday

`e2e/pre-pod-state.spec.ts`, real Forge, two fields (four drafters, and five for an odd field's bye): a
mid-draft leaver with the pick timer off, a server restart mid-draft and mid-round 1, a DQ at a round-2
table, and standings that name everyone. Each step asserts every remaining entrant has exactly one place
in the round (a table, a bye or a leaver's win). `e2e/w72-pod.spec.ts` (three humans, a bye in round 1)
and `e2e/w83c-leader-tools.spec.ts` (DQ, game reset) cover the rest, proven in the same claw runs. Run
ids are in the lane's closing note (`~/.cache/cardtable-manager/pre-state-machine-closing.md`).
