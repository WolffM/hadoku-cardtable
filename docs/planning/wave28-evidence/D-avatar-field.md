# §D evidence — the avatar field, for §A to code against

Wave 28, lane D. Item 4: *"i noticed you're still not pulling in the watchparty
selected avatars. why not?"*

**Answer, for the record:** because the last hop was never wired. The field was on
`@wolffm/rooms-protocol`'s `RosterIdentity`/`LocalIdentity` and persisted by
`packages/room-store/src/snapshot.ts` the whole time; nothing in
`apps/server/src` or `apps/ui/src` had ever read it. It reached our room store
and was dropped before it reached a seat. This lane wired it as far as the TABLE
VIEW, which is where lane D's done-when stops. **It does not reach the board, and
§2 below is why that is not a thing §A should try to force.**

---

## 1. The field, precisely enough to code against

### Name and type

**`avatarId`**, everywhere. Not `sprite` — that is watchparty's own internal
spelling for the same string, and it appears in exactly one file on our side
(`apps/ui/src/room/avatar.ts`, which is where their bundle is quoted).
`avatarId` is the name `@wolffm/rooms-protocol` uses (`dist/resync.d.ts:77-88`)
and the name `packages/room-store`'s `SerializedMember` already persists.

```ts
avatarId?: string   //  our shape, in every direction, everywhere §A will see it
```

**Not `string | null`.** Upstream types it `avatarId?: string | null` and that is
three states; ours is two. See §3.

### Where it lands

Three places, all live:

| Surface | Path | Shape |
| --- | --- | --- |
| the room's member row | `RoomMember.avatarId` — `apps/server/src/room/lobby.ts` | `avatarId?: string` |
| **the table view** | `players[].avatarId` — `tableView()` in `apps/server/src/http/routes.ts` | `avatarId?: string` |
| the browser's room type | `RoomMember.avatarId` — `apps/ui/src/rooms/api.ts` | `avatarId?: string` |

The table view's player row, as a browser receives it from
`GET /api/tables/rooms/:id` (and from the deck PUT and the ready POST, which
answer the same body):

```jsonc
{
  "seat": 0,
  "name": "user-alice",
  "avatarId": "wanderer",   // ← ABSENT for a player who has none. Never "" or null.
  "you": true,
  "deckName": "…", "rulesName": "…", "legal": true, "issueCount": 0,
  "ready": true, "verdict": { … }, "choice": { … }
}
```

It is **not caller-scoped**, unlike `verdict` and `choice`: a face is not hidden
information, and both seats already read each other's names. Both players' copies
of the table carry both players' avatars.

### Turning it into something drawable

`apps/ui/src/room/avatar.ts`. Two functions §A wants:

```ts
import { avatarSquareUrl, selectedAvatarId } from '../room/avatar.ts';

avatarSquareUrl('wanderer')  // → 'https://hadoku.me/watchparty/media/sprites/square_wanderer.png'
avatarSquareUrl(undefined)   // → null   ← draw your fallback
avatarSquareUrl('')          // → null   ← and for this too
```

`avatarSquareUrl` takes `string | null | undefined` and answers `string | null`,
so **one null check is the whole fallback**. It never returns a URL ending
`square_.png`; that would be a 404 drawn as a broken image exactly where the
caller wanted its fallback.

The origin is derived from the page (`watchpartyOrigin()`, also exported there),
so a local e2e stays local — do not hardcode a host, and do not build the path
yourself. `square_` is a file-naming convention inside
`@wolffm/watchparty-ui@0.39.8`'s bundle, not an API, and
`docs/requests/WATCHPARTY_AVATAR_ACCESSOR.md` §3 asks for it as a function.

### Where the id comes from at all

There is no `X-User-Avatar` edge header and there is no typed accessor on
`RoomChrome`: `@wolffm/watchparty-ui@0.39.8` ships two `.d.ts` files and neither
contains the string `avatar` or `sprite`. So the value is read out of watchparty's
own prefs write-through cache and asserted to our room by the browser —
`selectedAvatarId(userId)` in `avatar.ts`, called once per room by
`RoomShell.tsx`, posting to `POST /api/rooms/:id/identity { avatarId }`.

Every constant in that file quotes the shipped bundle function it was derived
from, and `avatar.test.ts` asserts the derivations, so a package bump that moves
the cache key or the sprite path reds there rather than quietly drawing nobody.
The request doc is the ask that would delete all of it.

**§A does not need any of that.** §A reads `avatarId` off a player row and calls
`avatarSquareUrl`. The source is lane D's problem.

### What draws it today, and the one surface that could next

`apps/ui/src/rooms/RoomList.tsx` — the front page's roster — draws a face beside
each member who has one, which is what makes this feature demonstrable rather
than a field nobody can see. A member with no avatar gets **nothing**, not a
placeholder: a row of identical squares says less than the names already beside
them.

The next surface, and it needs no new wire at all: **`ConstructedScreen.tsx`'s
`room-players`** (lane C's file this wave). It already renders the table view's
`players[]`, so `avatarId` is in the object it is holding — one `avatarSquareUrl`
call away. It is named here rather than done because that file is §C's.

---

## 2. The hop that is still missing, and the files that would carry it

**The board cannot see the table view, and nothing in wave 28 was assigned to make
it.** Traced, not assumed:

- `PlayerFace` draws a `BoardPlayer`, which `apps/ui/src/play/adapter.ts` builds
  from **Forge's** `PlayerView`. `BoardPlayer` has `id: number` (a Forge player
  id) and `name: string`, and no identity of ours.
- `apps/ui/src/screens/MatchScreen.tsx:34-53` hands `LiveBoard` a `matchId` and a
  socket and nothing else. The play client has **no room and no table data at
  all**; `apps/ui/src/play/live/match.ts` tracks `seat: number | null` and
  `playerId`, and there is no member, no name and no avatar on that wire.
- `apps/server/src/play/socket.ts:250-252` says of the names it hands Forge:
  *"Forge shows these names to both seats; they are never an identity."* The
  seats are literally `Seat 1` and `Seat 2` (or `Forge AI`). An avatar cannot ride
  that path, and it should not: those names go into Forge's own view.

So the remaining hop is **table view → play seat → board player**, and it is four
files, three of them not lane D's:

| File | Owner in w28 | What the hop would have to do |
| --- | --- | --- |
| `apps/server/src/http/routes.ts` | **D (done)** | `startFromRoom` already holds both `TablePlayer`s when it rewrites `req.body` to `{ opponent: 'human', decks }` (`:871` today; the call is `startFromRoom`). It would add the per-seat identity — `players.map(p => p.member.avatarId)` — in seat order, which is already the order the decks are in. |
| `apps/server/src/play/socket.ts` | **B** | `parseStartRequest`/`specFor` would have to accept and carry it. **Not onto `MatchSpec.seats[].name`** — that is what Forge renders. A separate per-seat identity field on the match, beside `deck` and `ai`. |
| `apps/server/src/play/match.ts` | **B** | `Match` already holds a seat's `owner` (a ParticipantId) from `claim`, so the seat table is where an avatar belongs. The join envelope at `socket.ts:648` already lists `seats.map(s => ({ seat, claimed, playerId }))` — the avatar goes beside `playerId`, which is exactly the field the client uses to line a seat up with a Forge player. |
| `apps/ui/src/play/adapter.ts` + `live/match.ts` | **A** | `toBoardView` would read the per-seat avatar off the match state (not off Forge's `PlayerView`) and join it to `BoardPlayer` by the `playerId` the seat envelope already carries. |

The join key already exists and is the important part: `seats[].playerId` is
Forge's player id for that seat, and `BoardPlayer.id` is a Forge player id. So the
hop needs no new correlation — only a field to carry.

**Do not do this in wave 28.** Three of those four files are lane B's or lane A's,
and the two halves would have to land together. It is a wave of its own, and a
small one now that the field exists and the join key is identified.

---

## 3. The three-state rule, so §A's fallback agrees with the server

`@wolffm/rooms-protocol` types it `avatarId?: string | null`, which is three
states that genuinely mean three things:

| state | means |
| --- | --- |
| absent | the member never picked one |
| `null` | it was explicitly cleared upstream |
| a string | a real character id |

**The decision: three states in, two states out.**

- **Out of the server, and out of `apps/ui/src/rooms/api.ts`'s parser:** either a
  **non-blank string** or **no key at all**. `null` collapses to absent; so do
  `''`, whitespace, a non-string and anything over 32 characters. Enforced in one
  function per side — `avatarIdOf` in `apps/server/src/room/lobby.ts`,
  `normalizeAvatarId` in `apps/ui/src/room/avatar.ts`.
- **In, at the one write route** (`POST /api/rooms/:id/identity`): all three are
  distinguished, because only there do they differ. A **string** sets; **`null`**
  clears; **absent** is a `400`, not a no-op 200 — a body that says neither "this
  is my character" nor "I have none" is not a request, which is the same
  discipline `/ready` already has. `''` is also a 400: it is a client bug and
  saying so is cheaper than the client finding out from a face that will not draw.
  (The lobby folds `''` anyway, so the two layers cannot store different things —
  they differ only in whether the caller is told.)

**Why `null` collapses.** To anything drawing a face, "never picked one" and
"cleared it" are the same instruction: draw the fallback. A third state on the
wire is a third branch in every consumer for no new fact. So §A's fallback is one
check and it is the same check everywhere:

```ts
const url = avatarSquareUrl(player.avatarId);   // null ⇒ draw the generated SVG
```

**Why an empty string is the bug this clause exists to stop.** `''` survives a
`!== undefined` check and a truthiness check on the key, and then resolves to
`…/media/sprites/square_.png` — a 404 rendered as a broken image in the one place
the code had a perfectly good fallback. It is refused at the route, folded in the
lobby, folded again in the browser's parser, and three tests assert on the bytes
that it never appears on the wire.

**Why the key is absent rather than `avatarId: undefined`.** Both survive
`JSON.stringify` identically, so over the wire it makes no difference — but an
in-process reader sees `'avatarId' in member` as true for the second, and the
lobby and the table view are both read in-process by their own tests. Every
builder therefore spreads (`...(avatarId === undefined ? {} : { avatarId })`)
rather than assigning, and every test asserts absence with `toHaveProperty`, not
`toBeUndefined()`.

---

## 4. Mutation evidence

Baseline, then the hop reverted, then restored. Suites named.

| mutation | suite | reverted | restored |
| --- | --- | --- | --- |
| the `avatarId` spread removed from `tableView()`, `apps/server/src/http/routes.ts` | `apps/server/src/http/tables.test.ts` | **1 failed, 65 passed (66)** — `expected undefined to be 'wanderer'` | 66 passed (66) |
| the `avatarId` spread removed from `viewOf()`, `apps/server/src/room/lobby.ts` | `apps/server/src/room/lobby.test.ts` | **6 failed, 30 passed (36)** | 36 passed (36) |
| " | `apps/server/src/http/rooms.test.ts` | **3 failed, 38 passed (41)** | 41 passed (41) |
| " | `apps/server/src/http/tables.test.ts` | 66 passed — *correctly unaffected: that suite uses a fake lobby* | 66 passed (66) |
| the `client.setAvatar` call removed from `useAvatarAssert`, `apps/ui/src/room/RoomShell.tsx` | `apps/ui/src/room/RoomShell.test.ts` | **1 failed, 7 passed (8)** | 8 passed (8) |
| `avatarSquareUrl(m.avatarId)` forced to `null` in `apps/ui/src/rooms/RoomList.tsx` | `apps/ui/src/rooms/rooms.test.ts` | **1 failed, 39 passed (40)** | 40 passed (40) |

The named done-when — *"a server test proves a member's `avatarId` reaches the
table view, and a missing one is absent rather than empty"* — is
`apps/server/src/http/tables.test.ts`, *"carries a member's avatarId to the table
view, and leaves the key off a member with none"*.
