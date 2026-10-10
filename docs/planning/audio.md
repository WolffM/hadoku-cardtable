# Audio — roles, triggers, builder, sandbox

Alpha phase 4 (`roadmap-alpha.md`). Opened 2026-10-09.

## Operator decisions (2026-10-09)

| Question | Decision |
| --- | --- |
| Layering | A **generic** event sound always plays, with the **colour-identity** take mixed on top. An empty colour cell means generic only. |
| Who hears | The whole table. The opponent's touches and hovers are silent; their game events play **quieter**. |
| Sandbox | Both: **scripted timelines** and **recorded-match replays**. |
| Casting a creature (2026-10-09) | A three-sound stack: **spell cast** (generic, one per spell type, low, no colour) → **creature sound** (the colour × creature cell) → **lands on the table** (generic). Spell-cast sounds stay quiet and colourless. |
| Music | **In scope for alpha.** A couple of found tracks on their own bus. |
| Shuffle | Has a sound, so the server forwards Forge's shuffle event. |
| Generation | Claude writes prompts, runs Stable Audio and imports takes; the operator picks. **Only after the operator's first assignment pass.** |

The 140 takes and the server's `assignments.json` come from a scratch builder
session. They are not decisions and not a gap list.

Order: **role list → builder + scripted sandbox → operator assigns → in-game
wiring → gap generation.**

## What exists today

- `apps/ui/src/sound/`: five synthesised cues (`hover select drag drop deny`),
  wired only in draft tiles and the room list. `cue-manifest.json` is empty.
- `#/sounds` (w50): admin-gated builder. The grid is 27 colour identities × 5
  card types, plus 13 `m-*` moments. Takes live in `CARDTABLE_SOUNDS_DIR`,
  served by `/api/sounds`.
- **The two systems never meet.** No game event plays a builder assignment.
- `play/live/pace.ts` releases each Forge frame on a schedule. That release is
  the moment a sound belongs to, because it is when the board changes on screen.

## The role list (draft for the operator to cut)

A **role** is one slot the operator assigns takes to. Each role holds a pool of
takes, one chosen at random without immediate repeats, plus a gain setting.
"Colour layer" means a colour × card-type take mixes on top of the generic one.
The trigger column names the `BoardView` difference (`play/adapter.ts`)
between two paced releases that fires the role. *Unverified* means the signal
has not been checked against a real dump.

### Interface — local only, never heard by the other seat

| Role | When | Notes |
| --- | --- | --- |
| `ui.hover-card` | pointer enters a card (hand, board, pack) | quietest, ~30 ms throttle |
| `ui.hover-control` | pointer enters a button | quieter still, or off |
| `ui.select` | a click that took effect | |
| `ui.lift` | press-drag latches a card | the shared press-drag slop from 05843b8 |
| `ui.place` | a drag lands somewhere legal (arrangement, zone) | |
| `ui.deny` | refused drop, illegal target, disabled control | |
| `ui.target` | a targeting arrow locks onto a target | |
| `ui.pass` | OK / pass priority / end turn pressed | |
| `ui.prompt` | a decision window opens for **you** | the "your move" ping; most important UI role |
| `ui.inspect` | the expanded card view opens | |
| `ui.draft-pick` | a draft pick is taken | |

### Cards moving

| Role | Trigger | Colour layer |
| --- | --- | --- |
| `g.draw` | id joins `hand`, `libraryCount` falls | — |
| `g.shuffle` | Forge's `GameEventShuffle`, forwarded by `PlayBridge` (the board itself shows nothing) | — |
| `g.land` | land id joins `battlefield` from `hand` | land (basic name) |
| `g.cast.<type>` | spell joins `stack` (`!isAbility`). One role per spell type: creature, instant, sorcery, artifact, enchantment, planeswalker, battle. Low in the mix. | **none** (operator: no colours on cast) |
| `g.ability` | ability joins `stack` (`isAbility`) | — |
| `g.resolve` | top `stack` entry leaves | — |
| `g.creature` | a creature spell resolves: the creature's own voice, played just before it lands | **colour × creature cell** (artifact creature → colour × artifact-creature) |
| `g.enter` | permanent joins `battlefield` (not a land play): the generic "lands on the table" | non-creature artifact → colour × artifact cell |
| `g.token` | `token` card joins `battlefield` | — |
| `g.counter` | stack entry leaves with no `GameEventSpellResolved` | from Forge's event *(unverified)* |
| `g.dies` | creature `battlefield → graveyard` | — |
| `g.destroy` | non-creature permanent `battlefield → graveyard` | — |
| `g.exile` | any zone → `exile` | — |
| `g.bounce` | `battlefield → hand` | — |
| `g.discard` | `hand → graveyard` | — |
| `g.mill` | `graveyard` grows, `libraryCount` falls | — |
| `g.reanimate` | `graveyard → battlefield` | — |

Zone moves assume a card keeps its id across zones. **Verify against a
`CARDTABLE_PLAY_DUMP`** before building on that. `fold.ts` replaces the
object, but the id may still be stable.

### State changes

| Role | Trigger |
| --- | --- |
| `g.tap` / `g.untap` | `tapped` flips; an untap-step burst collapses to one `g.untap-all` |
| `g.counter-on` / `g.counter-off` | `counters` count changes |
| `g.attach` | `attachedToId` changes |
| `g.transform` | `changedFrom` appears or changes |
| `g.mana` | `manaPool` grows (subtle) |
| `g.lifegain` | `life` rises |

### Combat

| Role | Trigger |
| --- | --- |
| `g.attack` | `attacking` turns on (a burst collapses to one) |
| `g.block` | `blocking` turns on |
| `g.damage` | creature `damage` rises |
| `g.damage-player` | `life` falls |

### Turn and game

| Role | Trigger |
| --- | --- |
| `g.turn-mine` / `g.turn-theirs` | `activePlayerId` changes |
| `g.phase` | `phase` changes (maybe only combat and end step) |
| `g.game-start` | coin toss resolves |
| `g.mulligan` | a mulligan is taken |
| `g.win` / `g.lose` | `gameOver`, `hasLost` |

**Forge's own events are the better trigger where they exist.** `forge-game/.../event/`
has `GameEventShuffle`, `GameEventCardChangeZone` (from and to zone, so it
answers the card-id question outright), `GameEventSpellResolved` and
`GameEventCardCounters`. `visibility.ts` already handles `GameEventCardChangeZone`
for draws. Wave B decides, per role, between a forwarded event and a board diff.
Whichever it picks, the sound still fires on the **paced release** of the frame
it rides with.

The colour × `spell` column has no role yet: casting is colourless. It could
become the instant/sorcery **resolve** flavour. Decide that by ear in the sandbox.

Today's 13 `m-*` events map into this list one to one (`m-tapcard` →
`g.tap`/`g.untap`, `m-damage` → `g.damage`, …). The colour matrix stays as the
colour layer.

## Mixing rules

- Four buses: **ui**, **game**, **colour** and **music**, each with its own volume. Music plays a couple of tracks (lobby/draft and match), loops them, and ducks under `g.win`/`g.lose`/`g.turn-*`. Tracks must carry a licence that allows this use (CC0/CC-BY or similar, with attribution in `NOTICE.md`). Their bytes live in `CARDTABLE_SOUNDS_DIR` like takes, never in the repo. The
  player's settings expose master and per-bus volume. Mute stays.
- **Opponent multiplier** on game and colour (start around 0.6). The
  opponent's `ui.*` is never sent or played.
- **Burst collapse**: the same role within ~80 ms plays once (a board wipe is
  one `g.dies`, not six). A role may carry a separate "many" take.
- **Ducking**: `g.win`/`g.lose`/`g.turn-*` duck the other buses briefly.
- **Voice cap** (about 8) and per-role cooldown.
- **Fast Mode** widens the collapse window, because frames arrive back to back.

## Architecture

- **One role registry** in `packages/shared/src/sounds.ts`, read by both the
  builder and the runtime. It replaces `Cue` (`sound/cues.ts`) and `EVENT_IDS`.
- **Assignments are the only source.** At load, the client fetches
  `/api/sounds/assignments` and decodes each take into an `AudioBuffer`.
  **Delete** `cue-manifest.json` and `manifest.ts`. The synthesised envelopes
  stay only as the fallback for an unassigned `ui.*` role. An unassigned
  `g.*` role is silent.
- **Event deriver**: a pure `deriveSoundEvents(prev, next, viewerId)` →
  `{role, colour?, cardType?, seat: 'me'|'opp'}[]`. It is called once per paced
  release in `LiveBoard`. Being pure, it is unit-tested on fixtures and the
  replays, so no audio device is needed.
- **Mixer**: `sound/webaudio.ts` gains buses, buffers, collapse and ducking.
  It stays the only `AudioContext`. `playCue` becomes `playRole`.

## Builder (`#/sounds`) rework

- Laid out by role groups (Interface, Cards moving, State, Combat, Turn &
  game), with the colour matrix as its own tab.
- Each role shows its take pool, a per-role gain slider (stored in
  `assignments.json`) and an audition button that plays a random pick, mixed
  as the game would.
- Catalogue side panel: search and filter by section/group, length, and
  "unassigned only". Drag a take onto a role. Writes stay admin-gated.

## Sandbox (`#/sounds/sandbox`, admin-gated)

**Scripted timelines.** Each beat is `{at, role, colour?, cardType?, seat}`,
played through the real mixer. Controls: play, stop, loop, speed (0.5×–2×), a
Fast Mode toggle, and per-bus mute. Gain changes made during playback save
straight to assignments. A live event log shows each beat as it fires; click a
beat to re-fire it. Starting scenarios:

1. Opening: game start, draw 7, mulligan, draw 7
2. A quiet turn: untap all, draw, land, cast a creature, it enters, pass
3. Combat: three attackers, two blocks, damage, one dies, damage to a player
4. Stack fight: cast, respond, respond, counter, resolve ×2
5. Board wipe: six creatures die at once (collapse test)
6. Hover fatigue: sweep across a 7-card hand ten times
7. Colour tour: cast one of each colour × card type, generic + layer
8. Endings: win, lose

**Replays.** Load captured frames (committed fixtures, `CARDTABLE_PLAY_DUMP`
output, and later recorded live matches) and run them through `fold` →
adapter → deriver → mixer, with the same transport controls and event log.
That is the real game with real timing, and nothing Forge needs to run.
Recording live matches to a file server-side is not built *(unverified that
anything records them today)*.

## Waves

| Wave | Contents | Touches the board? |
| --- | --- | --- |
| **A** | role registry, builder rework, per-role gain, mixer (buses, collapse, duck), scripted sandbox. Delete the cue manifest. | no, so it can run beside alpha work |
| — | **operator's first assignment pass** | |
| **B** | deriver + `PlayBridge` event forwarding (shuffle, zone change, resolved) + in-game playback in `LiveBoard`, `ui.*` wiring on gestures, opponent multiplier, settings volumes | yes |
| **C** | replay sandbox, live-match recording, music bus + track picker in the builder | no |
| — | gap generation from the operator's empty roles | |

## Open questions

1. Is the colour × `spell` cell the resolve sound for instants and sorceries,
   or is it dropped? Decide by ear in the sandbox.
2. Which tracks? The operator finds them; the licence goes in `NOTICE.md`.
