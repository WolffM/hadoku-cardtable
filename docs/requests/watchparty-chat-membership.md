# Request to `hadoku-watchparty`: a room's chat accepts any member, not only its own members

**From:** hadoku-cardtable
**Status:** finding / not yet agreed — filed while fixing a client-side bug (wave 90 item 1), not
asking for anything to change here. Read `hadoku-watchparty` at `main`, current as of this filing.

## What this is answering

Cardtable's `App.tsx` used to mount watchparty's `RoomChrome` for a `room` route the moment
`whoami` answered, before the viewer had actually joined that cardtable room — so a password room
showed its chat beside the password form (the operator: *"this one exposed a bug in the site, the
chat shouldn't load if the room hasn't been joined yet"*). Fixed on cardtable's side: the chat does
not mount until `rooms/joined.ts` has a 200 join (or an already-successful read) for that room.

That fix is a CLIENT change. It stops our own UI from ever asking watchparty's socket to join a
room the viewer has not joined on cardtable's side — it does not, and cannot, stop a DIFFERENT
client (a modified build, a raw socket.io connection, anything that is not our React app) from
asking directly. Whether that matters turns on what `hadoku-watchparty`'s own server checks, so:

## The finding

**Watchparty's join does not check cardtable membership at all — only the caller's account tier.**
Read from `apps/server/src/ws/join.ts` (handleJoin):

- `resolveRoomKey` matches `room_key` against the configured ephemeral namespace
  (`cardtable-<[a-z0-9-]{1,40}>`, per `WATCHPARTY_ROOM_CHROME.md` §3) — a FORMAT check, not an
  identity check.
- The only further gate for an ephemeral key is `tierAtLeast(tier, 'member')` — the caller's own
  account tier from `whoami`, nothing about which room they are asking for.
- There is no call back to cardtable, and no shared secret or token that would let watchparty ask
  "is this account actually in cardtable room `r-xxxx`?" — by original design
  (`WATCHPARTY_ROOM_CHROME.md` §3: *"cardtable never learns a leader key… Cost to us: zero server
  code, zero secrets"*), and that design has not changed.

So: **yes, watchparty's chat server accepts a connection to any room id** (in the ephemeral
namespace) from any signed-in member-tier-or-above account, regardless of whether that account is
a member of the corresponding cardtable room. Concretely, since cardtable's room list already
shows every room to every signed-in member (the operator's own rule, "every friend sees every
room" — `RoomList.tsx`), **every member already knows every room's id**, and nothing stops that
member's browser from opening a raw socket.io connection with `room_key: "cardtable-<any id>"` and
reading or posting in a room's chat they were never let into — locked or not, since the lock is
cardtable's own join, which watchparty's socket never asks about.

## What this is not

Not a report of a live incident, and not urgent in the way a game-state leak would be: it reaches
chat only, never a deck, a hand or a match. It requires a signed-in cardtable member (D24: free,
open sign-up), not an anonymous caller. And it is not new — this has been true since
`WATCHPARTY_ROOM_CHROME.md` shipped; wave 90 is the first time cardtable's OWN client stopped
making the mistake easy to reach by accident, which is what surfaced that the server-side gap was
never closed either.

## The ask, if the operator wants it closed

Nothing is requested yet — this is the finding, for the operator to rule on. If they want it
closed, the two shapes `WATCHPARTY_ROOM_CHROME.md` §3 already weighed for the OPPOSITE problem
(minting a key) apply here too:

1. **Cardtable signs the key.** A short-lived token minted by cardtable's own server (it already
   knows the caller and the room) and verified by watchparty on join — no new secret watchparty
   holds, no server-to-server call per join, just a signature watchparty checks with a public key.
2. **Watchparty asks cardtable.** A server-to-server membership check per join — simple, but it is
   exactly the "zero server code, zero secrets" trade `WATCHPARTY_ROOM_CHROME.md` was written to
   avoid, now on the other side of the same tradeoff.

Either needs the operator's ruling on whether the risk (a member can read another room's CHAT —
never game state) is worth the coupling cost, and whether it should happen before or after
cardtable leaves friend tier. Not acted on here.
