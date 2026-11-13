# The room record goes generic

A room's record (in memory, `RoomRecord`) and its stored `app` blob are both shaped around Magic: 23
Magic fields sit beside the room's own. This note sets the target shape, the codec's mapping and the
rollback rule. It was written before the code. The lobby's *logic* stays in `room/lobby.ts` (Magic)
for now. Moving that out is the next step, and it needs this one first.

## The platform record

`packages/game-server/src/room/record.ts` (platform, MIT):

```ts
interface PlatformRoomRecord<G, M extends PlatformMember = PlatformMember> {
  id: string;
  name: string;
  creator: string;
  leader: string;          // mirrors ledger.leaderId (ruling 6: moves only on Leave)
  gameType: string;        // narrowed by the game (Magic: GameType)
  testing: boolean;        // a seeded admin room: never swept (room-list.ts)
  scheduledFor?: number;   // an event's room (events.ts)
  createdAt: number;
  updatedAt: number;
  members: M[];            // id, userId, joinedAt, state; ready is per userId, in the ledger
  ledger: MembershipLedger;
  seats: GameSeats;        // the game seats, below
  game: G;                 // the game type's own part, opaque to the platform
}
```

- **Password salt/hash** stay where they are today: `Lobby.#secrets` in memory (out of the record, so no
  view can reach them), `app.secret` on disk.
- **Chat refs:** the record holds none. Chat is keyed by room id outside it, and that does not change here.
- **Ready** stays per member in the membership ledger (`isMemberReady`), not per seat. A 1v1 table also keeps
  a Ready per seat (`TableSeats.ready`), which is Magic's and stays in Magic's `tables`.

## The seat model

`GameSeats = (string | null)[]`: the holder of each game seat, by seat number. A holder is a member id
or a seat marker the game type owns (Magic: `ai`, `closed`). `null` is an open seat. A member who holds no
seat is watching.

- **The game seats are the pod's seats.** `podSeats` is renamed `seats` and moves to the platform record.
  A draft pod of 30 seats plays tables of 2: the 30 are the game seats, and the tables (`game.tables`, with
  their series) are Magic's.
- A bomberman room (spec `seats.max` 10) already seated through `podSeats`. It now seats through the platform
  seats, and its relay roster's `roomSeatOf` reads them through the platform's `gameSeatOf`.
- A plain 1v1 constructed room plays one two-seat table. Its seats stay on Magic's `tables[0]` (Ready per
  seat, a series, a Gauntlet that holds the table). Its platform `seats` exist and stay unused. Magic's
  `gameSeatsOf` answers from the table for that room. Folding the 1v1 table's seats into the platform seats is
  a behaviour change (ready and stand rules differ), so it is not done here.
- Considered and not used: the store's own `RoomSnapshot.seats` (`@wolffm/rooms-server`'s `SeatTable`, written
  empty today). Its entries are participant tenures with holds and reservations, and a pod seat holds markers
  that are not participants.

## Magic's game blob

`MagicRoomGame` (`games/magic/server/src/room/lobby-codec.ts`), on `RoomRecord.game`:

| field | was |
| --- | --- |
| `format`, `settings`, `mode`, `modeOptions`, `clientMode` | top level of `RoomRecord` |
| `tables` (2-seat tables + series), `matches` | top level |
| `draftStartedAt`, `plan`, `planVerdict` | top level |
| `podAi`, `podDrafts`, `podSplit`, `pod`, `podPlaying` | top level |
| `lockedDecks`, `gauntlets` | top level |
| `scenario`, `historical`, `historicalStructure`, `aiDeckAssignments`, `seatDecks` | top level |

`RoomRecord = PlatformRoomRecord<MagicRoomGame, MemberRecord> & { gameType: GameType }`. The platform
names none of these fields. Every read in Magic goes through `room.game.<field>` (a type-checked
codemod), and `room.podSeats` becomes `room.seats`.

A bomberman room still carries a Magic `game` blob, because Magic's lobby still hosts it. That stops when
the lobby's logic moves to the platform.

## The codec

Stored `app`, app version **2** still (additive: every new field reads with a fallback):

| stored field | new build writes | new build reads |
| --- | --- | --- |
| `app.seats` | the game seats | `app.seats`, else `app.game.podSeats`, else open seats (`initialPodSize`) |
| `app.game.settings` | yes | `app.game.settings`, else `app.settings`, else defaults |
| `app.game.tables` | yes | `app.game.tables`, else `app.tables`, else the pre-wave-71 migration from `matchId` |
| `app.game.matches` | yes | `app.game.matches`, else `app.matches`, else `[]` |
| `app.settings`, `app.tables`, `app.matchId`, `app.matches` | **yes, dual** (rollback) | fallback only |
| `app.game.podSeats` | **yes, dual** (rollback) | fallback only |
| every other `app.game.*` | unchanged | unchanged |
| version-1 flat records | never written | lifted as today (`liftV1`) |

A record holding both shapes reads the new one. The new build always writes both in step. An old build
writes only the old shape, and its `#persist` builds the blob from scratch. So a record that an old build
touched carries no stale new field, and the new build falls back to the old one.

## Rollback: write both

v0.68.0's codec (`appCodec.deserialize`) reads app version 2, ignores keys it does not know at the top level
and under `game`, and reads `settings`, `tables`, `matchId` and `matches` at the top level and `podSeats` under
`game`. The new build writes those exactly as v0.68.0 did, beside the new fields. A rollback loads every room
the new build wrote, with nothing lost. Proof: a committed test decodes a new-build record with the new
fields stripped, and a scratch run opens the base build's `openLobby` over a directory the new build wrote.

**Dated drop, 2026-11-13:** drop the dual-written `app.settings`, `app.tables`, `app.matchId`,
`app.matches` and `app.game.podSeats` in the first release after the one that ships this, together with
the fallback reads. Until then, every reader keeps the fallback.

Quarantine (`STORE_VERSION`, `decodeSnapshot`) is not the plan: a version bump would make an old build
quarantine every room, which loses them.

## The `gameType ===` branches in `lobby.ts`

The 14 literal branches at the base (3182c194a). Two more, `room.gameType === gameType` in
`setGameType` and `room.gameType === type` in `useGameType`, compare against an argument, are generic
already, and stay. Each literal becomes a Magic predicate (`isDraftRoom`, `isConstructedRoom` in `pods.ts`,
beside `isTournamentRoom`/`usesPod`) or moves into Magic's decode:

| base line | where | what it guards | becomes |
| --- | --- | --- | --- |
| 1362 | `restore` | re-check a draft plan on boot | `isDraftRoom` (Magic-only work; a non-Magic room is never a draft) |
| 1480 | `poolNamesChanged` | re-send draft rooms when pool names change | `isDraftRoom` |
| 1502 | `#ensurePlanChecked` | only draft rooms check a plan | `isDraftRoom` |
| 2210 | `#leftSeries` | a pod's series is not left by standing | `isDraftRoom` |
| 2492 | `setReady` | a held split locks Ready | `isDraftRoom` |
| 2497 | `setReady` | Ready sits you in a draft pod | `isDraftRoom` |
| 2583 | `startDraft` | guard: only a draft deals | `isDraftRoom` guard at the door of a Magic-only path |
| 2604 | `splitPod` | guard | `isDraftRoom` guard |
| 2770 | `setMode` | guard: modes are Constructed's | `isConstructedRoom` guard |
| 2937 | `releaseLostDrafts` | only draft rooms lose a draft | `isDraftRoom` |
| 3029 | `setPodPlan` | guard | `isDraftRoom` guard |
| 3144 | `playPod` | a draft pod has a build phase | `isDraftRoom` |
| 3228 | `openLobby` restore | a constructed room on a `draft:` format | Magic's restore (`restoreMagicGame`, lobby-codec) |
| 3231 | `openLobby` restore | a pre-modes constructed room is Classic | Magic's restore (`restoreMagicGame`) |

None of these needs a per-type hook today: each is a Magic rule, and every non-Magic room answers false to it,
as it did. They become hooks when the lobby's logic moves to the platform. That step needs the list of
generic rules in `lobby.ts`, which the closing note carries.

## Not in this step

- The lobby's logic (`join`, seating, ready, persist, restore) stays in `lobby.ts`.
- The view (`RoomView`) is unchanged on the wire. `seats` was already sent (dea0ea3ab).
- `settings`, `tables` and `locks` are still in the view for every room. That is the next readers-first sweep.
