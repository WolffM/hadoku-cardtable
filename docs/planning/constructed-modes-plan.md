# Constructed modes: Classic, Gauntlet, All Random

The operator's words are quoted verbatim so the goal cannot drift through
paraphrase. Everything under **Design** is ours and may change; the quotes may
not.

## The ask (2026-10-21, verbatim)

> help me reorganize the UI a bit. firstly, i want to rename the room types to
> "Constructed" and "Draft". we dont need a drop down for this, just a radio
> selector is better.
>
> next, Constructed rooms should be: "Classic" (meaning the current room mode
> with picking decks) "Gauntlet"(a new mode i will describe shortly) or "All
> Random" (should be able to do Full random, Random Standard, Random Modern or
> Random Legacy)
>
> when creating a constructed room there should be an optional additional
> setting to select this mode, if none is selected then that's the first thing
> that happens when the room opens.
>
> the room leader is presented with the three choices and after one is selected
> then the room converts into what is needed.
>
> this is basically adding one extra initialization step before the deck
> selection loader in classic. So for how rooms work currently to get to the
> same state you'd either have to select classic before creating the room, or
> after selecting classic inside the room then the deck picker is revealed.
>
> for the other two it'll work differently.
>
> Gauntlet - Bo3 only. first the leader will select optionaly select
> standard/modern/legacy and the year or allow random. then we will show 10
> randomly selected decks from the selected filter conditions. It would be cool
> if there was an animated reveal process that first showed the format at the
> top like "Modern - 2022" then revealed the 10 decks in a pretty way and the
> players will take turns doing the following:
>
>     P1 ban, P2 ban
>     P1 pick 1, P2 pick 2.
>     P2 ban, P1 ban.
>     P2 pick 2, P1 pick 1
>
> then once the decks have been picked, they will each pick their opening deck.
> each deck can only be played once, so no sideboarding.
>
> All Random - Bo1 or Bo3 with sideboarding. this is basically just classic
> mode but we will use the pre-selection process that gauntlet mode has and
> instead of doing the drafting process the game just throws us in. if players
> select rematch then the room is converted to a Bo3 and we send them to
> sideboarding, otherwise we record the match result as Bo1. I would like it if
> we utilized this smart-sideboarding and converting Bo1-Bo3 rule for classic
> also rather than pre-selecting whether or not sideboarding happens. that
> would be better.

## Rulings (2026-10-21)

1. **Gauntlet pick order:** a snake with 3 decks each. P1 ban, P2 ban · P1
   picks 1, P2 picks 2 · P2 ban, P1 ban · P1 picks 2, P2 picks 1. Of the 10
   decks, 4 are banned and 6 picked.
2. **Gauntlet, games 2 and 3:** before every game, both players secretly choose
   one of their unplayed decks. *("Revealed together" is superseded by ruling 9.)*
3. **All Random has no reveal**, verbatim: *"all random doesn't need a reveal,
   it should just go straight into the game. that reveal of the format/year and
   then the decks is just the interim gauntlet phase. all pick can skip that."*
4. **All Random decks:** a random era of the chosen format (any format for Full
   random), then a *different* random deck from it for each player.
5. **Bo1 → Bo3 on Rematch:** the finished Bo1 game counts as game 1. The Bo3
   starts 1-0, goes to sideboarding, and stats record one Bo3 match.
6. **Gauntlet P1:** a coin flip, shown in the reveal.
7. **Vs AI:** both new modes work against the AI. In Gauntlet the AI bans,
   picks and chooses its deck for each game at random.
8. **Changing the mode,** verbatim: *"not anymore once players ready up, but if
   we select a mode and the game (or gauntlet) hasn't started yet then yeah we
   should be able to go back and select a different one. i guess i wouldn't
   call it "back" it would be nice to just show the three options, then when
   one is selected reveal options below and once those are selected players
   can ready up. i guess in the case of classic we need space for the whole
   deck picker thing. so we gotta rethink the UI for the room a bit so it
   fits."*
9. **A Gauntlet choice stays hidden until its game is over** (2026-10-21), verbatim:
   *"when decks are being chosen we need to make sure the opponent cannot see
   it. it's good to show the avaliable decks, but we shouldn't reveal what decks
   are chosen."* *"no, we shouldn't reveal the deck to the opponent. even when
   the game starts we shouldn't know what deck they picked. only after the game
   is over and we record stats and potentially go to a new game can it be seen
   what deck they played by it being greyed out or the recorded match result."*
   *"also make sure that this page works when we go to game 2. when players
   select 'Next Game' it should take them back to the deck picker with the
   previously chosen decks (for both the player and the opponent) greyed out."*

10. **A Bo3 left before it is decided** (2026-10-21), verbatim: *"in that
    case we just record the completed games as Bo1, uncompleted games are
    trashed"*. "Left" is the lobby's own test for a Bo1 that can no longer be
    rematched: a player leaves the room or stands up from the seat they played
    in, or the room closes or is swept. A draft pod's tables are the pod's.
11. **The bot's deck against the AI** (2026-10-21), verbatim: *"if rematch is
    clicked, yes the bot keeps the same deck. if we go back to room then it
    picks a new deck"*. A Rematch and every game of the Bo3 it converts into
    keep it; a start that begins a new series draws a new one. All Random and
    Gauntlet deal the bot's deck as before. Also ruled: Classic keeps the seats
    above the deck picker (no change).

12. **A game not brought to victory/defeat is not finished** (2026-10-21),
    verbatim: *"i dont know how forge can finish a game that a player left? i
    guess if they left and the opponent killed them? if a match was not
    brought to victory/defeat then it was not finished."* *"correct, if the
    match is aborted during sideboarding then we record the Bo1 result and the
    match is closed"*. An explicit concede is a defeat, so it counts. A game the
    server ends any other way (a player leaves or nobody comes back, the room
    closes, the JVM dies, the server stops) produces no game report and no game
    in its series. One classification decides it, `play/match.ts`'s
    `gameOutcome`, read by the stats report and the series alike. The
    sideboarding half was already true by ruling 10 (`lobby.test.ts`, "a player
    leaves the room during sideboarding").

13. **Gauntlet feedback** (2026-10-21), verbatim:
    *"1. when match is finished don't show 'rematch' button.
    2. i notice there seems to be a brief interim where we show the lobby
    screen after a deck is selected and before the new game begins. this is a
    bit weird, let's go stragiht from deck selection into the next game.
    3. let's display the matches vertically after a match is conclued rather
    than in a horizontal line."* *"also after a match is concluded i should be
    able to start a new match and standup or even convert the room to a new
    type. 'both players are ready — the table is locked'
    https://hadoku.me/cardtable/#/room/r-70206f58bbf1 this room appears to be
    locked now even though the match is done?"* A decided Gauntlet holds
    nothing an unfinished one does: no Rematch, the table unlocked, the mode
    the leader's again, and a Ready begins the next Gauntlet.

## Design

### Words and ids

- The UI says **Constructed** / **Draft**. The wire ids `constructed-1v1` /
  `draft` stay, so no stored room migrates for a label.
- Constructed modes: `classic | gauntlet | random`. A room's `mode` is `null`
  until chosen.
- All Random pools: `full | standard | modern | legacy`.

### Room model (server, `apps/server/src/room/lobby.ts`)

- `Room.mode: ConstructedMode | null` plus `modeOptions`:
  - Gauntlet: `{ family?: FormatFamily; era?: FormatId }`; leaving both out
    means random.
  - All Random: `{ pool: 'full' | 'standard' | 'modern' | 'legacy' }`.
- `POST /api/rooms` takes an optional `mode` (and its options).
  `PATCH /api/rooms/:id {mode}` is leader-only. It is refused with
  `mode-locked` once any seated player is ready, or once a Gauntlet's reveal
  has started.
- Changing the mode clears holds and readiness, exactly as `setFormat` does
  today.
- Restored constructed rooms come back as `mode: 'classic'` (they were
  Classic). Log `room-mode-restored`.
- The wire schemas for mode and options move into `packages/shared`, and the
  server's and UI's two `GameType` copies collapse into it. Owner: lane A.

### Match length: smart Bo1 → Bo3 (Classic and All Random)

- `RoomSettings.matchLength` and `.sideboarding` go away, and so do the room
  toggles. Every Constructed series starts as Bo1.
- **Rematch** converts it in place. `series.length` 1 → 3, the finished game
  stays as game 1 (1-0), and the phase becomes `sideboarding` (the existing
  `beginSideboarding` / `SideboardStep`).
- With no rematch, the series ends as Bo1.
- **Gauntlet** is always Bo3 with no sideboarding.
- **Draft** pods stay Bo3 with sideboarding, unchanged.
- **Stats:** every game report gains `attrs.mode` and `attrs.bestOf`. A series
  result (its winner and score) is recorded once the series ends: when a Bo1
  is left without a rematch, or when a Bo3 is decided. The prefs-api `attrs`
  are free-form (`match.<attr>=` filters exist), so no hadoku_site change is
  expected. Lane D checks this first.

### Gauntlet (server state machine: `apps/server/src/room/gauntlet.ts`, pure, unit-tested)

Its phases are `options → reveal → banpick → choose → playing → done`.

1. **Options:** the leader picks a family and era, or random. Only eras with at
   least 10 library decks are offered or drawn; Standard 1995–2005 and
   legacy-2005 have 6–9 (see the library counts).
2. **Ready:** both seats ready. The server draws the era, 10 distinct decks,
   and the coin flip, all with `secureRandom` on the server. It stores them in
   the room, so a reconnect replays the same reveal.
3. **Ban/pick:** the snake from ruling 1. Each step is
   `{ seat, act: 'ban' | 'pick', count }`, a fixed table in the module. The
   server refuses an act out of turn or on a taken deck. The AI seat acts at
   random after a short beat.
4. **Choose:** before each game, both players submit a hidden choice from their
   unplayed picks (ruling 2). A choice is its chooser's alone until its game is
   over (ruling 9). The AI chooses at random.
5. **Playing:** a Bo3 of normal Forge matches, each using its chosen `.dck`.
   Played decks are struck off. After a game, it's back to Choose until the
   series is decided.
6. **Done:** the room shows the result, one game to a row. The table is free
   (ruling 13): seats stand, the leader may pick a mode again, and a Ready
   begins the next Gauntlet.

### All Random

- **Options:** the pool (Full / Standard / Modern / Legacy).
- On ready, the server draws the era (any family for Full) and two different
  decks from it, then starts the match directly with no reveal. The decks
  appear on the board as they always do.
- Then the smart Bo1 → Bo3: a rematch keeps both decks and sideboards them.

### Room UI layout (`ConstructedScreen.tsx` rework)

```
┌ room header (name, seats, watchers) ───────────────────────────┐
│ [ Classic ]  [ Gauntlet ]  [ All Random ]   ← radio cards,      │
│                                               leader-only;      │
│                                               others see the    │
│                                               choice            │
├────────────────────────────────────────────────────────────────┤
│ options for the chosen mode                                     │
│  Classic:    format tabs + era · Free pick · hand smoothing     │
│              (one row)                                          │
│  Gauntlet:   Standard/Modern/Legacy/Random + year (or Random)   │
│  All Random: Full / Standard / Modern / Legacy                  │
├────────────────────────────────────────────────────────────────┤
│ main area, the rest of the height                               │
│  Classic:  the deck picker (12-tile skeleton → tiles), Ready    │
│  Gauntlet: Ready → reveal → ban/pick board → choose → play      │
│  All Random: Ready                                              │
└────────────────────────────────────────────────────────────────┘
```

- With no mode chosen, only the radio row shows. A non-leader sees the row
  disabled, with no help text (memory: no explanatory UI text).
- The options row is one line at 1280×800 and every UI scale (the table-fit
  rules apply).
- **Create dialog:** a type radio (Constructed / Draft). For Constructed there
  is an optional mode radio (Classic / Gauntlet / All Random, none selected by
  default). No dropdowns.

### Gauntlet reveal (UI)

- The format title lands first ("Modern — 2022"), then the coin flip, then the
  10 deck tiles deal in one by one (the room deck tile, with colours and a peek
  on hover).
- Bans grey out and cross the tile. Picks slide to the picker's side (two
  columns, P1 and P2).
- A turn banner names who acts and what ("Ban 1", "Pick 2").
- `prefers-reduced-motion` gets the end state with no animation.
- The motion is reviewed as an artifact (bundle the real component) before it
  lands. See memory "show motion as an artifact".

## Lanes

Each path has one owner. **A lands first** (small: types, wire, migration);
B–F start at t=0 against A's types and rebase when A lands.

| Lane | Owns | Delivers | Red spec first |
|---|---|---|---|
| **A**: model & wire | `packages/shared` (new `room-modes.ts`), `lobby.ts` mode fields, `rooms.ts` create/patch parse, restore migration | `mode`/`modeOptions` on Room, create and PATCH `{mode}`, `mode-locked`, the single `GameType`, the classic migration | unit: lobby mode lock/clear/migrate; parse refuses an unknown mode |
| **B**: room & create UI | `RoomList.tsx` (create dialog), `ConstructedScreen.tsx` layout, the mode radio row, the options row; removing the Bo/sideboarding toggles from the UI | the layout above; mounts C's, E's and F's components through props | e2e: create Constructed+Classic → deck picker shows; create with no mode → the leader picks Classic → deck picker; mode change refused after ready |
| **C**: Gauntlet engine | `apps/server/src/room/gauntlet.ts` (new), its routes, the AI policy, eras with ≥10 decks | the state machine, ban/pick/choose routes, per-game deck from picks, feed pings | unit: the snake order, out-of-turn refusal, played-once, AI acts; jar e2e: a full Gauntlet vs AI to game 1 |
| **D**: smart Bo1 → Bo3 + stats | `effectiveMatchLength`, `recordGameResult`, `beginSideboarding` conversion, `RoomSettings` removal, `LiveBoard` Rematch, `TableSideboard`, the stats report `attrs` and series result | the Rematch conversion at 1-0, Bo1 recorded when no rematch, `attrs.mode`/`bestOf` | e2e: Classic Bo1 → Rematch → sideboarding → game 2 shows 1-0; unit: series record |
| **E**: All Random | the server draw (`random-decks.ts`, new), its start path in routes, the `AllRandomOptions` component | the pool radio, the era + two-deck draw, the straight-into-game start | jar e2e: All Random Modern vs AI starts a match with two different decks from one era |
| **F**: Gauntlet UI | `apps/ui/src/screens/gauntlet/` (new): the reveal, ban/pick board, choose, result | the components B mounts; the motion artifact | e2e: the reveal shows the title, then 10 tiles; a ban greys a tile; a pick moves it |

**Shared-path rules:**
- Only B edits `ConstructedScreen.tsx`.
- Only A edits the shared types. Other lanes ask A (or wait for A to land)
  instead of adding parallel types.
- D owns series code. C *calls* D's series functions for Gauntlet's Bo3 and
  does not fork them.

**Landing order:** A → (C, D, E in any order) → F → B last, because B mounts
everything. Each lane lands itself with `scripts/lanes/land-worktree.sh`, and
each landing commit adds its own `| AF??? |` ledger row.

**Deletes (net-negative where possible):** the Best-of / Sideboarding toggles
and `RoomSettings.matchLength`/`.sideboarding`, the `<select>` in the create
dialog, and the UI's duplicate `GameType`.

## Open (decide during the build, report in the lane's ledger row)

- The AI's beat between Gauntlet acts (proposal: 600 ms).
- Whether the rest of the room sees a Gauntlet's hidden per-game choices:
  decided no (ruling 9) — a watcher is told no choice until its game is over,
  the same as the other seat.
