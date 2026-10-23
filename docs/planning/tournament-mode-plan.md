# Tournament mode: the operator's plan, and how it is built

The operator's words are quoted verbatim. **Design** is ours and may change. The quotes and rulings may not.

## The ask (2026-10-22, verbatim)

> can you focus on getting me a tournament mode? basically we want the pairing and lobby logic of how
> the draft rooms work but for constructed gameplay. in theory any of the three modes (classic/gauntlet/all
> random) should work. just that in tournament mode, we lock all the seats first, construct a bracket and
> then split players off to play their games. make sense?

## Rulings (2026-10-22, the operator's answers)

1. **Format: Swiss, like draft pods.** Round 1 pairs by seat (across the table), later rounds pair by
   score (`@hadoku/draft`'s `pairRound`). The round count is `roundsFor(humans)`. An odd count gives a
   bye (pods' ruling 3).
2. **Entry point: a toggle in a Constructed room.** The mode row (Classic / Gauntlet / All Random) stays
   as it is.
3. **Decks, verbatim:** *"depends on the game mode. in theory we could keep the same draft set for
   gauntlet and the same all-random deck throughout the whole tournament also. but classic is the more
   resonable one. For now make it a toggle. in tournament mode. either lock deck or re-pick each round."*
   So a second toggle, **deck: locked / re-pick each round**, shown only when Tournament is on.
4. **Match length, verbatim:** *"Bo3 for classic/all-random means same deck. Bo3 for gauntlet is already
   built in."* A Classic or All Random tournament match is best-of-3 on one deck. A Gauntlet match is the
   Gauntlet's own built-in format, unchanged.

5. **AI entrants, verbatim:** *"AI can sit in the tournament, but we can also allow byes. it will be
   determined before the start. no additional ai will be added to a tournament once it's started."* AI
   seats are allowed in the lobby. The field (humans + AI) is fixed at Lock seats, and an odd count still
   gives a bye. After the lock, nothing adds an AI: no auto-fill, and no AI replacing a leaver.

6. **Gauntlet's locked decks, verbatim:** *"can't we keep the locked decks the same way we keep it for
   the other game modes? i guess in the case of gauntlet it's an array of decks rather than a single."*
   and *"i just meant both locked and unlocked mode should work. we can play gauntlet tournament with
   locked deck after the first draft, or play it so each match is a fresh gauntlet"*. One per-entrant
   locked-deck slot serves all three modes. For a Gauntlet entrant it holds what their FIRST match's
   Gauntlet draft produced (an array of decks), and every later match skips the draft and plays from
   it. With Each round, every match is a fresh Gauntlet.

7. **No Lock seats button, verbatim (2026-10-22):** *"why is there a 'lock seats' button? that seems
   pointless the seats lock when all players are ready and the games start."* The lock fires BY ITSELF,
   server-side, the instant the field is valid (`room/lobby.ts`'s `#maybeLockTournament`, called from
   every Ready/sit/stand/AI write) — there is nothing for the leader to press, and the leader has no
   special role in it. An edge the operator accepted in the same breath: a human who readies while
   others are still sitting down can lock the field early; no countdown or confirm step guards it.

8. **The hub and game rooms, verbatim (2026-10-23):** *"the tournament UI needs a bit of work still. I
   think things like the deck selection should happen inside game rooms. in the top level lobby room i
   would prefer to just show standings and links to the open rooms. then players can enter their game
   rooms and perform the game room actions there."* Answers to follow-ups:
   - a game room is a **table page inside the tournament** (its own link, e.g. `…/room/<id>/table/<table>`),
     not a separate room;
   - **anyone may open any match**: its two players play, and everyone else watches;
   - **draft pods use the same hub and game room** after the draft.

   So once rounds start, the room page is a hub: standings, the bracket, and a link per live match.
   Everything a match does (deck pick, Ready, sideboard, the game itself) happens on its table page.

## What exists (2026-10-22, from code)

- **Pods** (`apps/server/src/room/lobby.ts`) have everything Swiss needs:
  - `podSeats` (8, `POD_SEATS`) with sit/stand/AI/close;
  - `PodRecord` with `round`/`rounds`/`results`/`pairings`/`bye`;
  - `#advancePodRound` (pairs with `pairRound` and makes one table per pairing via `#newPodTable`);
  - the next round starting by itself when every table of the round is `done`;
  - `#archive` into the stats Tournaments tab (`room/tournaments.ts`).

  `PodView` (`packages/shared/src/pod.ts`, phases lobby / drafting / building / rounds / done) carries
  standings and pairings. The UI already draws pod seats (`screens/pod/PodSeats.tsx`, the new avatar
  strip), the bracket (`screens/pod/PodBracket.tsx`) and standings.
- **Constructed rooms** carry `mode` (`classic | gauntlet | random`, `packages/shared/src/room-modes.ts`)
  with per-mode options. Classic seats choose a deck. All Random deals per table (`http/routes.ts`
  `dealRandom`). Gauntlet runs its own choose-then-play flow (`room/gauntlet.ts`, `screens/gauntlet/`).
  `RoomSettingsSchema` (`room-requests.ts`) is `{ handSmoothing }` today.

## Design

**One mechanism, not two.** A Constructed room with Tournament on gets the SAME pod: `room.podSeats`,
`room.pod`, the same `#advancePodRound` / `#newPodTable`, the same `PodView` on `RoomView.pod`, the same
archive. Its phases are `lobby → rounds → done`, skipping `drafting` and `building`. Anything pod-only
that assumes a draft (a built deck, a plan) is generalised behind one question: *what deck does this
player sit down with at this table?*

- **Settings:** the room gains `tournament: boolean` and `tournamentDecks: 'locked' | 'per-round'`
  (default `'locked'`). Both are the leader's, editable only while the pod is in `lobby`, and locked
  once the seats lock.
- **Seats:** with Tournament on, the room seats through `podSeats` (up to 8), exactly as a draft pod
  does, AI seats included (ruling 5). Its 1v1 table seats are hidden while the pod is in lobby. AI
  entrants are always ready. An AI's table plays the Forge AI as a vs-AI table does. Two AI paired
  together settle without a game.
- **Lock:** round 1 starts BY ITSELF (ruling 7) the instant ≥ 2 entrants (at least 1 human) are seated
  and every seated human is ready — no button, nothing the leader presses. Ready means the mode's own
  condition: Classic needs a legal deck chosen; Gauntlet and All Random need nothing extra.
  `#maybeLockTournament` runs the same `#lockTournament` check from every write that could complete the
  field (a Ready, a sit, a stand, an AI seated), mirroring how a draft pod deals its own rounds the
  instant the last human presses Play (`playPod`'s `#dealPodRounds` call) rather than adding a second
  trigger. From then on nobody sits or stands; a leaver is dropped by the existing pod rules. The lock
  ALSO retires every table the room held before it (`#interruptSeries`, unseating them) — a real run,
  2026-10-22, found the room's own stale 1v1 table left seated and un-ready after the lock, because
  nothing had ever stood its occupant up; the screen's own "my table" reads were fixed the same day to
  stop reading `tables[0]` for a tournament room, in any mode.
- **A tournament table:**
  - **Classic:** best-of-3 with the room's sideboarding setting, on the player's deck. With `locked`,
    that's the deck held at the lock, every round. With `per-round`, each player re-picks before their
    round's game 1, and the table starts when both are ready.
  - **All Random:** best-of-3 on one dealt deck. With `locked`, each player is dealt once at the lock
    (the existing `dealRandom` logic, called once per player) and keeps it every round. With
    `per-round`, it's dealt fresh per round, as a normal All Random table is.
  - **Gauntlet:** the Gauntlet's own built-in flow, built and landed — a tournament round pairs
    several Gauntlet tables of the same room at once, each keyed by its OWN table id
    (`room/lobby.ts`'s `gauntlets`, one `GauntletState` per table rather than per room; `tournamentPairingOf`
    reads each table's entrants and deck policy). With `locked`, an entrant's FIRST match runs the
    full draft; the instant that match's banpick ends, each entrant who had no stored pick set yet
    gets one now (never overwritten once set), and every later match of theirs resumes straight into
    `choose` from it — no draw, no banpick. With `per-round`, every match draws fresh and nothing is
    ever stored. **Ruling 6's open edge, decided:** a table pairing an already-locked entrant against
    one on their first match (a bye recipient's late first round, say) has no well-formed "resume for
    one seat, draft for the other" — a Gauntlet's ban/pick snake is a match between the TWO seats of
    ONE freshly drawn pool. The simplest faithful rule: that match draws fresh for BOTH seats, and only
    the newcomer's half of the result is stored (the already-locked seat's stored picks are untouched,
    since the storage rule is "set if unset", not "set when a match ends"). An AI entrant's picks are
    stored and resumed the same way a human's are; a human paired against the tournament's own AI
    entrant readies with no extra flag — the pairing alone says the other seat is AI, always ready.
- **Rounds, standings, end:** exactly the pod's. Results are recorded per match, the next round starts
  by itself, standings use pod tiebreaks, the bracket view and standings come from the pod components,
  and the finished tournament is archived to the stats Tournaments tab.
- **UI:**
  - The Constructed room's options row gains a **Tournament** toggle and, when it's on, a
    **Decks: Locked / Each round** toggle. Port the existing RadioCards/options-row styling. All three
    modes are a live choice with Tournament on, Gauntlet included (the mode row never disables it).
  - With Tournament on, the room shows the pod seat strip (the same `PodSeats`) and the Ready toggle —
    no Lock seats button (ruling 7): the round starts the instant the field locks itself.
  - In rounds, it shows the bracket/standings (the same `PodBracket`) plus "your table" leading into
    the match, as pod rounds already do — Classic/All Random reuse the 1v1 table's own deck
    chooser/sideboard; a **Gauntlet** table reuses `screens/gauntlet/GauntletScreen.tsx` verbatim
    (`TournamentRounds`'s own `gauntlet` slot), scoped to the player's own round table (`gauntletTableId`),
    never `tables[0]`.
  - No explanatory text.
  - Ruling 8 (2026-10-23) moves all of this onto a hub + per-match table page, built by the lane after
    this one; what is here is what plays today.

## Order

One contract commit (the settings schema + `PodView` for a constructed room) lands first. Then the
server (lobby/routes/per-mode deck policy) and the UI work in parallel against it. The UI lands after
the server.

## Open: `http/routes.ts`'s own adapter is not yet per-table (2026-10-22)

`room/lobby.ts`'s Gauntlet storage, `http/gauntlet.ts`'s routes and `GauntletDeps`/`GauntletHandle`
are all keyed by `(roomId, tableId)` now, but `routes.ts`'s adapter — the object it builds to satisfy
`GauntletDeps`, and the 4 call sites (`seated`/`setReady`/`dealGame`, `holdsTable`/`startRefusal`/
`afterGame`) — still call with no table id, which every one of those signatures defaults to
`tables[0]`. `routes.ts` was held by another session throughout this lane (`All Random hides the dealt
deck`), so the patch is prepared, not applied: thread the real `table.id` (already resolved at every
one of those call sites) through the 3 adapter closures and the 4 callers. Until it lands, a
tournament's several simultaneous Gauntlet tables collapse onto one shared state, same as before this
lane — a plain, non-tournament Gauntlet room is unaffected either way.

## Watches

- The first real 4-player tournament on production: a Classic one, locked decks.
- The first real Gauntlet tournament, once `routes.ts`'s own patch lands (see "Open", above): two
  simultaneous Gauntlet tables of one round, and a locked entrant's second match skipping its banpick.
