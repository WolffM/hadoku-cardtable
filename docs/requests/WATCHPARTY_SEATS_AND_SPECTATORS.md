# Handoff: seats and spectators at a table inside a watchparty room

**Filed 2026-10-12 by a watchparty session, for the cardtable tracker to
design.** The operator ran the first crowd test of cardtable inside a
production watchparty room ahead of a party. The table loads and plays. What
it has no answer for is **everyone who isn't one of the two players**.

This is a design brief. **§5 holds the one operator ruling made so far**
(standing up, 2026-10-12). Everything else in §5 is watchparty's suggestions,
**not decisions**, and §6 lists what still needs the operator's ruling. Code references are verified against cardtable `0b7196e2` unless marked
otherwise.

---

## 1. What the operator asked

> "if i have a room with many people in it, how can someone actually take a
> seat? it would be cool if spectators had the ability to watch without being
> able to perform game actions and also have the ability to change
> perspective."

## 2. What the production run showed

Watchparty's `e2e/production/cardtable-party.spec.ts` (`07d90735`) puts a
leader and four bots into one room. Each is a distinct `wp-*` friend account,
signed in through `/session/create`, so they go through the real edge and real
sockets. The leader starts Cardtable from Select Media → Play. It passed in
~32s on 2026-10-12:

| step | leader + bot1 (players) | bots 2–4 |
| --- | --- | --- |
| mount | bound to the same `wp-<hash>` table, `constructed` visible, no `embed-error` | same |
| seat | Random → deck loaded, Ready enabled | "Table full — watching.", no deck picker |
| match | board + phase rail, Forge's coin-toss "Play or Draw?" | **"Refused: match-full"** on an empty board, with Next Phase / End Turn / **Full control / Concede** still drawn |
| end | leader concedes → Victory / Defeat screen | unchanged |

No console errors on any client. Step 3's unseated view is **logged, not
asserted**, so the spec keeps passing while you change it. Make it assert the
new view once a spectator view lands (§7).

## 3. How it works today

**A seat is a deck.** `PUT /rooms/:roomId/deck` writes the member's
`TablePlayerState`, stamped `seatedAt` (`apps/server/src/http/routes.ts:763-802`).
`playersOf` (`:377-385`) treats any member who has that state as a player,
ordered earliest first. A third member gets **409 "this table already has two
players"** (`:784-785`, `TABLE_SEATS = 2` at `:311`). So the seat goes to
whoever clicks a deck first, which is a race in a crowded room.

**There is no "stand up".** The table routes are `GET /rooms/:roomId`,
`PUT …/deck` and `POST …/ready` (`routes.ts:754-845`). The seat lives on the
member row (`lobby.ts:1078-1089`), so it is released only when the member
leaves the room. *Unverified, from a survey:* inside a `wp-` room the only
thing that leaves is the in-match Leave (`LiveBoard.tsx:1767`). Closing the game
in watchparty unmounts the bundle but does not leave, so someone who loads a
deck and walks away may hold the seat until the room is gone. Please confirm
this.

**Everyone who mounts is a member.** The bind is
`POST /api/rooms/watchparty` → `lobby.bindWatchparty`, and the member list is
uncapped (survey: `lobby.ts:1140-1190`). That is what makes **"Play vs Forge
AI" vanish at a party.** The button renders only for a one-member room
(`ConstructedScreen.tsx:1936`). The server refuses with "a bot game is for a
room with one player in it" (`routes.ts:938`). When the leader starts Cardtable,
the bundle mounts for the whole room at once, so the room is never down to one
member.

**The unseated cannot see the match.** `snapshotFor` (`play/socket.ts:717`)
requires a successful `Match.claim`, which returns `match-full` when no human
seat is free (`play/match.ts:1320`). The only spectator that exists is the w31
**same-person** case: a second socket on a seat you already hold sees that
seat's view, including its hand, and its inputs are dropped (`c2s-spectator`,
`socket.ts:851, 890, 912, 933`; `isSpectator` in `LiveBoard.tsx:368-373`).

**Hidden info is already projected per seat.** `play/visibility.ts` transcribes
Forge's `canBeShownTo` because Forge's own stream is not per-player safe. Its
header has the evidence: both libraries arrive named, in order. Each seat's
envelope goes out via `emitPerRecipient`, and everyone else gets `SKIP`. **That
file is the foundation a spectator view would sit on.**

**The `@wolffm/rooms-server` seat table is not used by constructed.**
`lobby.ts:1006` writes `createSeatTable(null)` as a placeholder. Draft pods do
use it: `seatParticipant`, `roleOf`, `emitPerRecipient`, and `spectatorView`
for the unseated (survey: `room/draftRooms.ts:120-127, 320-327, 391-485`).

## 4. Problems to solve

1. **Claiming a seat is implicit and racy.** Loading a deck is both "I want to
   play" and "here is my deck", and there is no way to give the seat back.
2. **A seat can be held by someone who left** (if §3's unverified point holds).
3. **The unseated get a dead screen**, plus controls they cannot use.
4. **No spectator view, so no perspective to change.**
5. **Vs-AI is unreachable in any room with more than one person.**
6. **Nothing turns over between games.** After a game, who plays next is
   unanswered (Rematch keeps the same two).

## 5. Design direction

### Operator ruling (2026-10-12): giving up a seat

> "players should be able to give up their seat, but not after both players
> are ready. when both players are ready and the match is initiated then they
> are locked in until they concede"

What that ruling requires:

- **Before the match:** a seated player can stand up. That holds whether they
  are ready or not, as long as the two players are not both ready.
- **Once both players are ready and the match is initiated, both seats are
  locked.** No stand-up. Conceding is the only way out (or the game ending).
  The lock should be enforced **on the server**, not just by hiding a button.
- *Not covered by the ruling. Confirm with the operator:* whether a locked-in
  player who **disconnects** mid-match still holds the seat, and for how long
  (this is §6 Q3). Also how the ruling interacts with the in-match Leave that
  exists today.

### Suggestions from the watchparty side (not decisions)

**Make sitting down its own action.** Add a "Sit here" button on each empty
seat and a "Stand up" button for the seated player; the deck picker appears
once you are seated. The `rooms-server` seat table already provides what this
needs, and draft proves it works here:

- seats keyed by `ParticipantId`, so a reconnect keeps the seat
- `unseatParticipant(…, { hold })` for leaving on purpose versus dropping off
- `createSeatTable(capacity, { reservationTtlMs })` to hold a dropped player's
  seat against other people for a bounded time (lazy expiry, JSON-safe, so it
  survives your persistence)

Moving constructed onto it also retires the placeholder in `lobby.ts:1006`.
Gate seat claims on **account** tier: in rooms-protocol, `device` is not an
authorization boundary.

**A "next up" queue** (optional) answers problem 6. It could be first-come,
winner-stays, or loser-rotates. The rule is the operator's to pick.

**Spectators get one public projection.** Add a no-seat case to
`visibility.ts`:

- shown: battlefield, graveyards, stack, exile (face-up), life, counters, and
  hand/library **counts**
- hidden: every hand's and library's contents

Because the view is identical for every spectator, it can go out as **one
broadcast** (or `emitToRole('spectator')`) rather than a per-recipient build.
That cost matters at a 10+ person party. Inputs are dropped exactly as w31
drops them. The UI hides Next Phase / End Turn / Full control / Concede for a
spectator, which the w31 `isSpectator` gate partly does already.

**Perspective is then client-side.** If the spectator view holds no hidden
information, then choosing which player sits at the bottom just flips the
layout. That means no new server state, and no leak no matter which way it
flips.

**"Over the shoulder" (seeing a player's hand) is a separate, explicit
choice.** It is the one feature that sends hidden cards to a non-player, and
`P3_PER_RECIPIENT_EMIT.md` currently says a spectator must **never** receive
another player's hidden cards. It needs the operator's ruling (§6), and probably
the watched player's opt-in or a delay.

**Vs-AI in a crowded room.** One option: gate it on "at most one seated
human" rather than "exactly one member". Then a party can watch one friend
play the AI.

## 6. Open questions for the operator

1. Seat claim: explicit "Sit here", or keep deck-load-as-claim and add only
   "Stand up"? (Standing up itself is ruled — see §5.)
2. Who may unseat someone else: nobody, cardtable's room leader, or
   watchparty's leader? D21 has the embed ignore `ctx.isLeader`; this would be
   the first reason to revisit that.
3. Seat reservation on disconnect: how long? (Draft and a 1v1 may want
   different values.)
4. Between games: rematch, a queue, or winner-stays?
5. Is over-the-shoulder wanted at all? If yes: opt-in, delayed, or both?
6. Should vs-AI be allowed in a room with spectators?
7. More than two seats (multiplayer formats) in scope for this design, or
   explicitly not?

## 7. What watchparty provides, and what it needs from you

- **Watchparty needs no change for any of §5.** The bundle context already
  carries the room id, the registry `userId` and `isLeader`.
- **The regression spec is yours to tighten.** When a spectator view lands,
  watchparty's `cardtable-party.spec.ts` step "Record what the unseated see"
  should assert it. Tell us the `data-testid`s, or land the change in
  watchparty yourselves. Re-run it with:

  ```sh
  cd hadoku-watchparty
  E2E_SKIP_WEBSERVER=1 PRODUCTION_SERVER_URL=https://watchparty.hadoku.me \
  PRODUCTION_UI_URL=https://hadoku.me/watchparty/ \
  node ../hadoku_site/scripts/secrets/dev-vault.mjs -- \
    npx playwright test e2e/production/cardtable-party.spec.ts --project=chromium
  ```

  `CARDTABLE_BOTS` (default 4) scales the crowd, up to 14 with the keys
  provisioned. Screenshots per client per step land in
  `test-results/cardtable-party/`.

## 8. Done when

- Someone in a crowded `wp-` room can take a seat and give it back before the
  match, and the seat can't be held by someone who's gone.
- Once both players are ready and the match starts, the server refuses a
  stand-up and conceding is the only way out (operator ruling, §5).
- An unseated viewer sees the match live, from either side, with no hidden
  card on the wire to them. That needs a test reading the **payload**, not the
  DOM.
- An unseated viewer has no game controls.
- The watchparty spec asserts all three against production.

---

## 9. Rulings and what landed (cardtable, 2026-10-12)

The operator ruled on §6 the same afternoon, ahead of the party:

| § 6 | ruling |
| --- | --- |
| 1 | **Explicit "Sit here."** Each empty seat offers it; a seated player has "Stand up". Loading a deck still seats an unseated caller when a seat is free, so the Random → Ready flow (and watchparty's production spec) is unchanged. |
| 2 | **Nobody** may unseat someone else tonight. A seat held by someone who walked away is cleared by that person standing up or leaving. |
| 3 | Not changed: a locked-in player who disconnects keeps the seat under the match's existing rejoin grace; the opponent's concede is the way out. |
| 4 | Not changed: Rematch keeps the same two. Standing up after the game ends is how the table turns over. |
| 5 | **No over-the-shoulder.** The rule in `P3_PER_RECIPIENT_EMIT.md` stands; the watcher channel is what enforces it. |
| 6 | **Vs-AI is allowed when exactly one human is seated**, however many members the room has. |
| 7 | Two seats. Multiplayer formats are out of scope. |

What the code does now:

- `POST /api/tables/rooms/:roomId/sit` and `…/stand` (body `{}`); both return the
  table view. `stand` is refused with 409 once the room has a live match or both
  players are ready — the lock is the server's, not the button's. The table view
  carries `room.locked` for that fact.
- A socket with no seat that joins a full match is a **watcher**: `forge:role`
  says `'watcher'` (wave 31's `'spectator'` keeps meaning "your own other tab").
  Its snapshot is oriented by seat 0 and its frames come from one shared
  projection built with no viewer — public zones, face-up exile, counts for
  every hand and library, no prompt or window ever. Its input is dropped and
  logged as `c2s-watcher`. Perspective is flipped on the client.
- `e2e/watcher.spec.ts` asserts the lobby flow and, on the wire, that no card
  face reaches a watcher before a card is played.

**For `cardtable-party.spec.ts`'s "Record what the unseated see" step**, the
`data-testid`s to assert:

| where | testid / attribute | meaning |
| --- | --- | --- |
| lobby | `seat-sit` | one per empty seat; absent for a seated player |
| lobby | `seat-stand` | on your own row; disabled when `room.locked` |
| lobby | `room-spectator` | unseated with the table full |
| match | `[data-role="watcher"]` on the board root | this client is a watcher |
| match | `watcher-status` | the "Watching" status line |
| match | `perspective-flip` | swaps which player is at the bottom; watchers only |
| match | `live-concede`, `live-button-end-turn` | **absent** for a watcher |
