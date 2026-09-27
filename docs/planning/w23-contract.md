# Wave 23 — the contract the four lanes share

Written by the wave manager BEFORE dispatch, because the four lanes of
`docs/handoff/w23.md` are one feature cut four ways: lane A moves the server,
B the room screen, C the front door, D the proof. Anything two lanes would
otherwise have to agree about at runtime is settled here, and a lane that
deviates breaks another lane's typecheck.

Read `docs/handoff/w23.md` first. This file only fills in the seams.

## 0. The re-cut file lists, and why

The handoff's rows put `apps/ui/src/rooms/api.ts` in no lane, and put
`RoomList.tsx` + `rooms/rooms.test.ts` in lane C while the `RoomView` shape
they assert on belongs to lane B's work. `rooms.test.ts:193` is
`expect(parseRoomView(OPEN)).toEqual(OPEN)` over a full-`RoomView` factory, so
adding a field to `RoomView` in `api.ts` fails a test in another lane's file.
That is the wave-file bug the protocol says to re-cut before dispatch, so:

| lane | owns (exact files) |
| ---- | ------------------ |
| A | `apps/server/src/room/socket.ts`, `socket.test.ts`, `apps/server/src/room/draftRooms.ts`, `draftRooms.test.ts`, `apps/server/src/room/lobby.ts`, `lobby.test.ts`, `apps/server/src/http/rooms.ts`, `rooms.test.ts`, **`apps/server/src/index.ts`**, **`apps/server/src/index.test.ts`** |
| B | `apps/ui/src/screens/ConstructedScreen.tsx`, `constructed.test.ts`, `apps/ui/src/screens/PodScreen.tsx`, `apps/ui/src/screens/screens.css`, **`apps/ui/src/rooms/api.ts`**, **`apps/ui/src/rooms/RoomList.tsx`**, **`apps/ui/src/rooms/rooms.test.ts`** |
| C | `apps/ui/src/screens/LobbyScreen.tsx`, `apps/ui/src/screens/lobby.test.ts`, `apps/ui/src/screens/route.ts`, `route.test.ts`, **`apps/ui/src/App.tsx`** |
| D | `e2e/draft.spec.ts`, `e2e/room-mode.spec.ts` |

Bold is added by the manager. `index.ts` is lane A's because
`attachDraftSocket` gains a required dep and nothing else calls it. `App.tsx`
is lane C's because the route switch is the route's other half. Intersection is
still empty.

**`package.json` belongs to NO lane.** The manager makes one version commit for
the whole wave. Do not touch any `package.json`.

**No lane commits.** Do not run `git add`, `git commit`, `git stash`, `git
rebase` or anything else that writes to the index or refs — four lanes share one
index in one worktree. Leave your work in the working tree and report; the
manager stages `git commit --only -- <your files>` after verifying you.

## 1. The product decisions, settled — write them down, do not re-open

1. **A draft pod is eight seats, always.** `DEFAULT_PARAMS.seatCount` stays 8.
   The leader does not pick a seat count; nothing in the UI offers one.
2. **"Everyone" means every member of the room**, and there must be at least
   one. One member who readies alone starts a draft against seven bots — that
   is today's capability and it is kept.
3. **Bots exist from the instant the draft is dealt and never before.** The
   draft is not built until the room starts it; `createDraft(… humans: [])`
   then fills all eight seats with bots and each human who connects evicts one.
   So "bots fill the remainder at that instant" is achieved by NOT dealing the
   draft at join time, not by counting anybody.
4. **A human who has not readied is never replaced by a bot mid-decision**,
   because no seat is dealt before the start and a seated human's seat is held
   by the existing reservation machinery (`draftRooms.ts`).
5. **A late arrival still gets in**: someone who joins the room after the start
   connects and evicts a bot, exactly as today. Their ready flag is moot.
6. **A draft does not survive a server restart, and the room says so.**
   `draftStartedAt` is never restored (the same rule `matchId` already has,
   `lobby.ts` `openLobby`), so a restart puts the room back in its lobby with
   its ready flags intact rather than showing an empty table. The lobby's copy
   states it in words.
7. **The lobby does not reap a live draft.** `sweep` skips a room whose
   `draftStartedAt` is not null. That flag cannot outlive the process, so this
   cannot make a room immortal.
8. **An old `#/draft/<id>` link keeps working**: it is a legacy alias that
   redirects to `#/room/<id>`. A link to a pod id that was never a room lands
   on the room screen's own "no such room", which is the honest answer.

## 2. The server API (lane A implements; B and D consume)

### `lobby.ts`

```ts
export interface RoomMember {
  id: string;
  name: string;
  joinedAt: string;
  /** NEW. The room's readiness, which is what a draft starts on. */
  ready: boolean;
}

export interface RoomView {
  …unchanged…
  /** NEW. ISO string once the draft has been dealt; null in the lobby phase. */
  draftStartedAt: string | null;
}

export type StartDraftResult =
  | { ok: true; room: RoomView }
  | { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-ready' };

interface Lobby {
  …unchanged…
  /** false when there is no such room or the caller is not a member. Persisted. */
  setReady(roomId: string, memberId: string, ready: boolean): boolean;
  /** Idempotent: a room whose draft has already started answers ok with its view. */
  startDraft(roomId: string, callerId: string): StartDraftResult;
}
```

- `startDraft` requires: the room exists, the caller is a member,
  `gameType === 'draft'`, and every member has `ready === true` (members
  length ≥ 1). It sets `draftStartedAt` and persists. Already started → `ok`.
- `setGameType` **clears every ready flag** (changing the game invalidates
  readiness) and gains a refusal: `reason: 'draft-started'` while
  `draftStartedAt !== null`.
- Persistence is additive, so **`APP_VERSION` does not move** — the same
  argument `clientMode` already carries in that file's codec comment. Member
  `ready` rides the boxed member blob (`app: { state, ready }`, read back with
  a `false` default); `draftStartedAt` rides `StoredApp` (absent → null) and is
  restored as **null**.

### `http/rooms.ts`

```
POST /api/rooms/:id/ready   { ready: boolean }   → 200 RoomView | 400 | 403 | 404 NO_MATCH
POST /api/rooms/:id/start   {} or no body       → 200 RoomView | 403 | 404 NO_MATCH | 409
PATCH /api/rooms/:id                             → …and now 409 while a draft is running
```

- Both new routes allow-list their body keys exactly as the existing ones do; a
  `ready` route carrying anything else is a 400 naming the field.
- A non-member, a missing room and a malformed id are the SAME `404 NO_MATCH`,
  for the reason that file's header already gives. An ephemeral caller is 403
  (`notDurable`), as with create/join.
- `start`'s 409 body is `{ error: <a sentence a person can read> }` for
  `not-draft` and `not-ready`. Any member may call it — like constructed, where
  either browser may ask and the server answers one start to both.
- Neither route logs a body.

### `socket.ts`

- `DraftSocketDeps` gains **`lobby: Lobby`** (required, not optional — two
  behaviours behind a `?` is how the socket path and the HTTP path come to
  disagree).
- `case 'join'` stops minting rooms. It now reads the lobby first:
  - no such room, or `gameType !== 'draft'`, or `draftStartedAt === null`
    → `reject(null, 'unknown-draft', …)` and a log line
      `{ evt: 'join-refused', reason: 'no-room' | 'not-draft' | 'not-started' }`.
  - otherwise `rooms.open(msg.draftId)` exactly as today.
- `leave`, `resync` and `pick` are unchanged (they already use `rooms.find`).
- **This is the readiness gate.** Joining a draft room that has not started
  deals nothing, at the server, whatever a client does.

### `index.ts`

`openLobby` moves ABOVE `attachDraftSocket` and the lobby is passed to it.
Nothing else in that file changes.

## 3. The UI API (lane B implements; C and D consume)

### `apps/ui/src/rooms/api.ts`

- `RoomMember` gains `ready: boolean` (`parseMember`: `v.ready === true`).
- `RoomView` gains `draftStartedAt: string | null` (`parseRoomView`:
  `typeof draftStartedAt === 'string' ? draftStartedAt : null`).
- `GAME_TYPES`' draft entry becomes `{ value: 'draft', label: 'Draft', ready: true }`.
  That one line is what makes the create form's draft option selectable;
  `RoomList` needs no change for it.
- `RoomsClient` gains, with `type RoomOutcome = { ok: true; room: RoomView } | { ok: false; message: string }`:
  ```ts
  ready(roomId: string, ready: boolean): Promise<RoomOutcome>;
  start(roomId: string): Promise<RoomOutcome>;
  ```

### `ConstructedScreen.tsx`

- Props gain `makeTransport?: () => DraftTransport` (from `../draft/socket.ts`).
  Lane C threads it in `App.tsx` under exactly this name.
- The branch is on the room record's `gameType` (from the `rooms.get` poll),
  **not** on the table. `constructed-1v1` renders byte-for-byte what it renders
  today; `constructed.test.ts`'s existing assertions are the proof and must not
  be weakened.
- A draft room:
  - `draftStartedAt === null` → the room's lobby: the members list with a ready
    mark each, a Ready / Stand down toggle (`data-testid="ready-toggle"`, the
    same id constructed uses — only one of the two ever renders), a sentence
    saying the rule (**every member ready**, then the draft deals and **bots
    take the rest of the eight seats**), and a sentence saying a draft ends if
    the server restarts (§1.6).
  - every member ready → either browser calls `rooms.start(roomId)` once,
    guarded by a ref the way the constructed start already is.
  - `draftStartedAt !== null` → the pod. Keep every existing pod hook:
    `data-testid` `pod`, `pod-seats`, `pod-tally`, `pod-waiting`, `pod-error`,
    `invite-url`, `copy-invite`, and the classes `.pod__done`, `ol.pod__pool`.
  - The tables API is NOT used for a draft room: no `loadDeck`, no
    `tables.ready`, no `startRoom` (`routes.ts` answers 409 for a room that is
    not `constructed-1v1`), and the formats/decks/legal-sweep work stays off.
    **Keep the table poll running**, though: its join-on-refusal is what makes
    an invite link a membership, for a draft room as much as a constructed one.
- `PodScreen.tsx` keeps the pod's markup and exports it as a component
  `ConstructedScreen` renders (`{ draftId, makeTransport }`). The pod's invite
  input shows the ROOM url: `routeUrl({ kind: 'room', roomId }, location)`.
  **`inviteUrl` is deleted by lane C — do not import it.**

## 4. The routes (lane C)

- `route.ts`: `Route`, `parseRoute` and `routeHash` keep `{ kind: 'draft' }` —
  it is the legacy alias of §1.8 and nothing else. **Deleted:** `inviteUrl`,
  `draftIdFromInput`, `joinRouteFromInput`, `BARE_MATCH_ID`, `mintDraftId`,
  `ADJECTIVES`, `NOUNS`, `SUFFIX` and the local `secureRandom`. `routeUrl`
  stays and is what an invite is built from now.
- `App.tsx`: `case 'draft'` redirects to `{ kind: 'room', roomId: draftId }`
  and renders nothing; `case 'room'` renders
  `<ConstructedScreen roomId={route.roomId} makeTransport={transport} />`. The
  `PodScreen` import goes. Update the route table in the file header.
- `LobbyScreen.tsx`: the `draft-pods` section, the `start-pod` button, the
  `join-id` box and their handlers and state are deleted. The room list and the
  dev harness link are what is left.
- §C.2's gap check: an invite link is `#/room/<id>`, and entering a room joins
  it (`ConstructedScreen`'s table poll, the effect commented "Entering a room
  joins it"). Verify that by reading it and say so; the box's job is covered.
- `lobby.test.ts` is the FRONT DOOR's test now: one door, no pod furniture, the
  legacy `#/draft/<id>` redirect, a mangled hash lands on the lobby, the
  harness is one hash away. The pod's own behaviour moves to lane B's
  `constructed.test.ts` and lane D's e2e — do not keep driving the pod here.

## 5. The proof (lane D)

`e2e/draft.spec.ts`, same assertions, new door:

1. alice creates the room through the create form (`room-create-name`,
   `room-create-type` = `draft`, `room-create-submit`) and lands on
   `#/room/<id>`.
2. bob opens the front page and enters that room **from the room list**
   (`room-row` / `room-enter`) — that is §D's "from the room list alone".
   Assert alice's `invite-url` is `…/#/room/<id>` while you are there, which is
   what keeps §C's "an invite link still works" honest.
3. **Before both are ready there is no pack**: assert the pod is absent with
   only alice ready.
4. Both click `ready-toggle`; the pod appears, 2 people and 6 bots of 8 seats.
5. Everything after that is today's spec: pick, pass, wheel, refresh mid-draft,
   finish, the isolation report, the art-host boundary.

Two things the new door changes and the spec must not assume:

- **The room id is server-minted and random**, so the pod id is no longer the
  fixed `e2e-two-friends`. The engine's seed is that id, so the pools differ
  from run to run; nothing in the current spec asserts a pinned digest (it only
  reports them), and it must stay that way.
- **Seat order is a race** — both browsers connect the moment the draft starts.
  Derive each player's seat from the wire (`viewer.seatId`) rather than
  hardcoding 0 and 1, including for `checkIsolation`'s `SeatLog`.

`room-mode.spec.ts` uses the same create form; the draft option is now enabled,
so fix anything there that asserted otherwise.

## 6. How to run things here

- Node 24 or nothing:
  `PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`.
- Scoped tests, not the repo gate: three other lanes are editing this same
  worktree, so `pnpm check` will show you their half-finished work. Run
  `pnpm vitest run <your test files>` and read the exit code directly. A
  typecheck error in a file you do not own is not yours — report it, do not fix
  it.
- Lane D only: `pnpm e2e` builds `apps/ui/dist` and `apps/server/dist` and
  binds the e2e ports, and **wave 24 is running on this machine too**. Check
  nothing else is mid-run before you build, and do not run any spec but the two
  you own.
