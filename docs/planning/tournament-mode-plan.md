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
- **Lock:** the leader's "Lock seats" starts round 1 when ≥ 2 entrants (at least 1 human) are seated and every seated
  human is ready. Ready means the mode's own condition: Classic needs a legal deck chosen; Gauntlet and
  All Random need nothing extra. From then on nobody sits or stands; a leaver is dropped by the
  existing pod rules.
- **A tournament table:**
  - **Classic:** best-of-3 with the room's sideboarding setting, on the player's deck. With `locked`,
    that's the deck held at the lock, every round. With `per-round`, each player re-picks before their
    round's game 1, and the table starts when both are ready.
  - **All Random:** best-of-3 on one dealt deck. With `locked`, each player is dealt once at the lock
    (the existing `dealRandom` logic, called once per player) and keeps it every round. With
    `per-round`, it's dealt fresh per round, as a normal All Random table is.
  - **Gauntlet:** the Gauntlet's own built-in flow per match. With `locked`, the player's Gauntlet
    choice set (whatever the Gauntlet deals a player to choose from) is fixed at the lock and reused.
    With `per-round`, it's dealt fresh per match, as today. If the Gauntlet's state can't be carried
    per player without restructuring it, the lane reports instead of guessing.
- **Rounds, standings, end:** exactly the pod's. Results are recorded per match, the next round starts
  by itself, standings use pod tiebreaks, the bracket view and standings come from the pod components,
  and the finished tournament is archived to the stats Tournaments tab.
- **UI:**
  - The Constructed room's options row gains a **Tournament** toggle and, when it's on, a
    **Decks: Locked / Each round** toggle. Port the existing RadioCards/options-row styling.
  - With Tournament on, the room shows the pod seat strip (the same `PodSeats`) and a **Lock seats**
    button for the leader.
  - In rounds, it shows the bracket/standings (the same `PodBracket`) plus "your table" leading into
    the match, as pod rounds already do.
  - No explanatory text.

## Order

One contract commit (the settings schema + `PodView` for a constructed room) lands first. Then the
server (lobby/routes/per-mode deck policy) and the UI work in parallel against it. The UI lands after
the server.

## Watches

- The first real 4-player tournament on production: a Classic one, locked decks.
