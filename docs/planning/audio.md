# Audio — roles, triggers, builder, sandbox

Alpha phase 4 (`roadmap-alpha.md`). Opened 2026-10-09.

## The operator's brief (verbatim, 2026-10-09) — the goal

Kept word for word so the work never drifts from it. Measure every wave
against these four numbered items.

> two more workstreams beyond the ongoing alpha work:
>
> 1. i need to figure out how we're gonna get audio into the game. when it even makes sense to play sounds. i dont want to completely overdo it but the game does need a lot of audio. touching cards, hovering cards, spells resolving, creatures being played, cards being destroyed, drawing cards, turn start, etc. so pretty much all game actions need some audio. I already started bootcamping sounds with a local AI model here but those sounds were mostly for color-specific cards. however, lots of those sounds can theoretically also be used for generic things. this will need a lot of testing.
>
> 2. i need a sound testing sandbox. one a where i can play sounds, assign them to certain roles, and then have different testing scenarios where i can hear them all in sequence.
>
> so really theres a bit more:
> 1. figure out what the entire corpus of sounds are that are needed.
> 2. figure out how to actually get them to play at the right times
> 3. build the ui for assigning sounds and testing individual sounds manually.
> 4. build the testing sandbox for complex scenarios i can hear and tweak.

Later directions, verbatim, in order:

- *"spells will have their own sound. so it'll be a stack of: spell cast -> creature sound -> creature lands on table sound. quite the stack. i guess i want to keep the spell sounds somewhat low, maybe just one for each spell type and not worry about the colors."*
- Music: *"it's in scope, shouldn't be too hard to get that right. just a couple of tracks will be easy to find."*
- Shuffle: *"shuffle will have a sound"*.
- *"i haven't actually assigned any sounds yet, so you dont have any idea where the gaps are. we can generate gap filers once i've gone through and done the first assignment"*
- *"the 140 assigned takes you found was part of a builder session i did but i wasn't certain yet where sounds should actually go so i need the ui to land that"*
- *"help me get to the sandbox and picker UI as quick as possible so i can iterate on the sounds"* (2026-10-10: shipped as wave A)
- *"keep going on the audio work, i'll review the sounds in the morning."*
- On round 5 (2026-10-11): *"a lot of the new sounds are useless and mostly sound the same as other sounds. you didn't get creative enough here. way too many of the sounds are the same. all the lifegain sounds basically sound the same and it's not what i want for lifegain."* / *"in most cases bells sound bad and a ton of sounds are bells. also many of the sounds are really extreme. like the bant creature sounds are just maxing out my speakers."* / *"bant: harbour sounds — can you try something like this?"* / *"can you look at what types of sounds succeeded? use that also to guide the new sounds"* — measured and answered in `scripts/sfx/README.md` (Round 6, Loudness).
- *"can we get a "start of game" sound that plays before the coinflip? maybe something when both plays are ready and the room is initiated?"* — `g.match-start`, sounded at the room's hand-off into a new match (`play/live/matchStart.ts`).
- On round 6 (2026-10-11): *"some good ones in there. but a lot of these sounds are just way too loud and end up sounding really weird. like they're capping out something. also in a lot of cases the sounds are too long. many sounds like hovering, tapping, destroying should be shorter and simpler"* — the takes were clipped when saved (`scripts/sfx/README.md`, Clipping); quick roles got short limits in `finish.py`.
- On the frequency graph (2026-10-11): *"yep that phase change sound i do become very familiar with"* (62 a game from one take) and *"a lot of that can be fixed if 'end turn' skips the remaining phases and goes straight to the opponents turn"* — after End Turn the phases left go by at once and silently (`LiveBoard.tsx`'s `endTurn`, the pacer's `setEndingTurn`).
- Asked whether Auto Yield should pass the opponent's phases silently too: *"naw auto yield is just for decisions not for phases. shouldn't impact how phases are handled"*. The opponent's turn keeps its phase pacing and sounds.
- 2026-10-12: *"lets smoothen out the 'hover' sound it's a bit harsh"*, *"can we also try to normalize all the sound effects a bit? some peaks and variance is okay i just wanna make sure there aren't too mayn crazy outliers"*, *"i notice i'm hearing some duplicate sounds"* (the other seat's End Turn stepping past with a phase sound each, 0297056), and *"'colorless land, boros land' need new sounds ... fill the remaining gaps and also create more sounds for the most common ones until i have at least two for each of the common ones"* — `scripts/sfx/README.md`, Outliers and Round 7.

| Brief item | Where it stands |
| --- | --- |
| 1. the corpus | `SOUND_ROLE_GROUPS` in `packages/shared/src/sounds.ts` (57 roles); round 4 put 9 candidates on every role that had none (396 takes) |
| 2. playing at the right times | wave B ✔ (`play/live/sound-events.ts`, live from 2026-10-10) |
| 3. assigning + testing single sounds | `#/sounds` (wave A) |
| 4. the scenario sandbox | `#/sounds/sandbox` (wave A); the captured game replays there (wave C) |
| (music review) | `#/sounds/music` (2026-10-17): compare the 15 match-music slots' candidates, pick, rate, submit; read back from `music-reviews.jsonl` |

## Operator decisions (2026-10-09)

| Question | Decision |
| --- | --- |
| Layering | A **generic** event sound always plays, with the **colour-identity** take mixed on top. An empty colour cell means generic only. |
| Who hears | The whole table. The opponent's touches and hovers are silent; their game events play **quieter**. |
| Sandbox | Both: **scripted timelines** and **recorded-match replays**. |
| Casting a creature (2026-10-09) | A three-sound stack: **spell cast** (generic, one per spell type, low, no colour) → **creature sound** (the colour × creature cell) → **lands on the table** (generic). Spell-cast sounds stay quiet and colourless. |
| Music | **In scope for alpha.** A couple of found tracks on their own bus. The operator, 2026-10-16: *"lobby & draft, and in a match sounds are gonna be longer soundscapes that i need to find somewhere else"*: never generated here; `add-track.py` brings a found one in. |
| Shuffle | Has a sound, so the server forwards Forge's shuffle event. |
| Generation | Claude writes prompts, runs Stable Audio and imports takes; the operator picks. **Only after the operator's first assignment pass.** |

The 140 takes and the server's `assignments.json` come from a scratch builder
session. They are not decisions and not a gap list.

Order: **role list → builder + scripted sandbox → operator assigns → in-game
wiring → gap generation.**

## What exists today

- `apps/ui/src/sound/`: five synthesised cues (`hover select drag drop deny`),
  wired only in draft tiles and the room list. `cue-manifest.json` is empty.
- `#/sounds` (w50): the builder. Since 2026-10-17 every `#/sounds` screen is
  friend tier and above (the operator: *"make sure /sounds/ is friendtier+
  gated"*): a friend listens, only an admin edits, and every `/api/sounds`
  route sits behind `requireMinTier`. The grid is 27 colour identities × 5
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
| (button hover) | pointer enters an enabled button in a match | plays `ui.hover-card`; its own role was dropped 2026-10-16 (the operator: *"drop hover a button. make it the same as hover a card"*) |
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
| `g.shuffle` | a library reordered in place: Forge re-sends the `Library` id list on every shuffle (`Zone.shuffle` → `onChanged` → `updateZoneForView`), so no bridge change was needed; `mulligan.jvm.test.ts` proves both seats see it | — |
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
| `g.tap` / `g.untap` | `tapped` flips; the untap step plays `g.untap` once per card, 90 ms apart, at most 8 (2026-10-10; `g.untap-all` retired). Since 2026-10-15 `g.untap` has no cell: it plays the Tap take backwards (`REVERSED_ROLES`). The operator: *"untap should always be the reverse of tap, doesn't need its own sound"* |
| `g.counter-on` / `g.counter-off` | `counters` count changes |
| `g.attach` | `attachedToId` changes |
| `g.transform` | `changedFrom` appears or changes |
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
| `g.turn-mine` | `activePlayerId` changes to the viewer. Mana and the opponent's turn are silent since 2026-10-16 (the operator: *"i dont need a sound for their turn nor for mana"*) |
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

- Four buses: **ui**, **game**, **colour** and **music**, each with its own volume. Music plays a couple of tracks (lobby/draft and match), loops them, and ducks under `g.win`/`g.lose`/`g.turn-mine`. Tracks must carry a licence that allows this use (CC0/CC-BY or similar, with attribution in `NOTICE.md`). Their bytes live in `CARDTABLE_SOUNDS_DIR` like takes, never in the repo. The
  player's settings expose mute, overall volume and music volume (per browser,
  `sound/mute.ts`), in cardtable's own settings popover — the avatar in a
  match, the gear in a screen's head row elsewhere (`apps/ui/src/settings/`).
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

## Match-music review (`#/sounds/music`, friend tier)

The operator, 2026-10-17: *"post it as a new route under /sounds/ i want to be
able to go there, test, then send the results for review later. make sure
/sounds/ is friendtier+ gated"*. One section per `MATCH_MUSIC_ROLES` cell,
monos then pairs. Candidates come from data, in one place
(`musicReviewSlots`, `packages/shared/src/music-review.ts`): the cell's current
assignment (badged) and every Music take named `<code> · `. Each card loops its
take on the music bus at the player's levels, one at a time; two lane buttons
put it in the slot's **normal** or **16-bit** lane (2026-10-18: *"2 tracks for
every slot. one 'normal' and one 16-bit"*; one take per lane, any take in
either); keep / maybe / no rate it; a note goes with the slot. A take named
16-bit carries a small chip. Submit is `POST /api/sounds/music-review`,
validated against the same grouping and appended to
**`<sounds dir>/music-reviews.jsonl`** — in production
`apps/server/data/sounds/music-reviews.jsonl` in the deploy tree — as
`{at, userId, name, slots: {<cell>: {picks: {normal, chiptune}, ratings, note}}}`.
Lines from before the lanes carry one `pick`; they read as `picks.normal`, and
the file is never rewritten. Re-opening restores the browser's unsent draft,
else the viewer's latest line (`GET /api/sounds/music-review/mine`).

**Reset** (pressed twice; *"a 'reset' button so i can give a fresh round of
feedback"*) blanks the form and drops the draft. It writes nothing to the
server: the browser remembers the `at` of the submission it set aside
(`cardtable.sound.music-review.fresh-since`), and a re-open restores nothing at
or before it. The next submission is simply a later line, so "latest line per
viewer" stays the answer. The marker is per browser: another device still
restores the old line until it is reset there too.

Nothing writes the assignments: a later session reads the file and sets them
(`scripts/sfx/README.md`, Music review). **Next step: two-lane playback** — a
16-bit role per slot and a player setting choosing the lane, so the review's
`chiptune` picks have somewhere to go.

## Sandbox (`#/sounds/sandbox`, friend tier; gain saves admin-only)

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
| **A** ✔ 2026-10-10 | role registry, builder rework, per-cell gain, mixer (buses, collapse, duck), scripted sandbox (9 scenarios in `apps/ui/src/sound/scenarios.ts`) | no |
| — | **operator's first assignment pass** | |
| **B** ✔ 2026-10-10 | `play/live/sound-events.ts` derives role events from consecutive board views (proved against the committed Tier C capture); `LiveBoard` plays them per paced view, plus `ui.prompt` on a new decision and `ui.pass` on a bar press; gestures play `ui.lift`/`ui.place`/`ui.deny`/`ui.target`; long-press plays `ui.inspect`. The synthesised cues (`cues.ts`, `manifest.ts`, `cue-manifest.json`, `webaudio.ts`, `sink.ts`) are deleted: every sound is a role. Round-4 candidates generated for the 44 roles with no take. Its two leftovers, the volume setting and `g.shuffle` outside a mulligan, are wave D | yes |
| **C** (part) 2026-10-10 | music bus: `music.lobby` / `music.match` loop roles, ducked under the big moments, picked per screen (`setScreenMusic`) and per match (`setMatchMusic`); `scripts/sfx/add-track.py` brings a found track in (credit → `NOTICE.md`). The sandbox plays music under a scenario and replays the committed captured game through the live deriver. **Left:** recording live matches to replay; tracks themselves (the operator finds them) | no |
| **C2** 2026-10-16 | match music by colour: `music.match.W` … `music.match.G`, five of the operator's own tracks; the server tells each seat its deck's colours (`forge:deck-colors`) and the match plays one, picked once per match (`apps/ui/src/sound/match-music.ts`), falling back to `music.match`, then to one of the five | no |
| **C3** 2026-10-17 | match music by colour pair: `music.match.WU` … `music.match.GU` (spelled as `COLOUR_PAIRS`, the guild rows of `COLOUR_IDS`), ten more of the operator's own tracks. Mono plays its colour, two colours their pair, three colours one of the three pairs inside them, four or more — and a colourless deck or a watcher — any of the fifteen, each picked once per match; a role with no take falls through to the deck's other candidates, its mono colours, `music.match`, then the rest of the fifteen | no |
| **D** ✔ 2026-10-10 | `g.shuffle` from the library's own reorder, and a London mulligan heard at all (it is one delta with both counts unchanged, which the old rule never matched); player volume and music volume; the game's settings moved out of the host's header into cardtable's own popover | yes |
| — | gap generation from the operator's empty roles | |

## Open questions

1. Is the colour × `spell` cell the resolve sound for instants and sorceries,
   or is it dropped? Decide by ear in the sandbox.
2. Which tracks? The operator finds them; the licence goes in `NOTICE.md`.
