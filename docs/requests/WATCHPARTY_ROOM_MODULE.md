# Request to hadoku-watchparty: extract the room layer as a standalone module

**From:** hadoku-cardtable
**Status:** request / not yet agreed
**Asking for:** `@wolffm/rooms` — the room, chat, presence and seating layer,
extracted from watchparty as a reusable package, with three capabilities added
that watchparty doesn't currently need but we do.

---

## Why you're getting this

We're building a Magic: The Gathering cube-drafting and play service
(`hadoku.me/cardtable/`) on a fork of [Forge](https://github.com/Card-Forge/forge).
Forge gives us a rules engine. It does **not** give us anything we'd want above a
match: identity, rooms, chat, presence, lobbies, pods, reconnect. You already
built all of that, and built it well.

Rather than copy-paste it and let two divergent copies rot, we'd like it
extracted once, properly, as a package we both consume. The extraction is the
ask; the three new capabilities in §3 are what makes it usable for a card game
rather than a watch party.

**What's in it for watchparty:** the same thing extraction always gives you —
`rooms/store.ts` currently carries `playheadMs`, `mediaId`, `playlist`, `votes`,
`activeGameId`, `botCount` and `gameSessionWins` in one 518-line interface. Room
mechanics and watchparty product state are the same object today. Splitting them
is work you'd eventually want anyway, and this gives it a second consumer to
prove the boundary is real.

---

## 1. What we want extracted (it's already good — mostly move, not rewrite)

| Source | What it gives us |
| --- | --- |
| `apps/server/src/rooms/store.ts` | room lifecycle, client registry, stable identity across reconnect (`fk:`/`cid:` persist keys) |
| `apps/server/src/rooms/gc.ts` | idle/empty room reaping |
| `apps/server/src/ws/join.ts` | room-key auth, snapshot-on-join |
| `apps/server/src/ws/chat.ts` | chat, system messages, image attachments |
| `apps/server/src/ws/presence.ts` | heartbeat, roster, identity updates |
| `apps/server/src/ws/readyCheck.ts` | "is everyone ready" gate |
| `apps/server/src/ws/handlers.ts` | handler registration |
| `apps/server/src/util/safeEmit.ts` | backpressure-aware emit + `broadcastToRoom` |
| `apps/server/src/util/rateLimiter.ts` | per-client rate limiting |
| `apps/server/src/middleware/userIdentity.ts` | `X-User-Key` → friend identity |
| `packages/shared/src/protocol.ts` | the core/chat/presence/ready Zod schemas |
| `packages/shared/src/room-keys.ts`, `auth.ts`, `errors.ts` | key config + constants |
| `apps/ui/src/lib/socket.ts` | typed client, reconnect, resync |
| `apps/ui/src/components/Chat*.tsx`, `FloatingChat.tsx` | chat UI |
| `apps/ui/src/lib/auth.ts`, `authGate.ts` | friend-tier gate |

Roughly 3,000 lines, most of which moves unchanged.

### The one structural change we need in the extraction

`RoomState` must become generic over app state:

```ts
interface RoomState<TApp = unknown> {
  roomId: string; roomKey: string;
  clients: Map<string, ClientMeta>;
  createdAt: number; updatedAt: number;
  lastEventSeq: number;
  readyCheck: { active: boolean; ready: Set<string> };
  app: TApp;            // ← watchparty puts playhead/media/playlist here.
}                       //   we put draft/match state here.
```

Everything in today's `RoomState` that isn't in that list is watchparty's `app`.

Same for identity: `spriteId` generalises to `avatarId`, and `CHARACTER_ORDER`
moves out of the module (it's a watchparty asset list, not a room concept) into
config the host app supplies.

---

## 2. Explicit non-goals

Please **don't** try to generalise these — we don't want them and carrying them
would hurt the module:

- MSE / fragment delivery / the media priority queue / `playheadMs`
- playlists, voting, the tierlist, recap
- bomberman and the `GAME_EVENTS` host-election relay (see §3.3 for why)
- Redis chat persistence as a *hard* dependency — keep it behind an interface;
  we'd start with in-memory

---

## 3. The three capabilities we need that you don't have

These come directly from reading Forge's network layer. Full evidence is in
`docs/FORGE_ANALYSIS.md` in our repo; the short version is below.

### 3.1 Request/response with correlation ids — **hard requirement**

Forge's protocol is not a broadcast stream. It's **62 RPC methods**
(`forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java`), and 14 of
the server→client ones **block the rules engine until one specific player
answers**:

```java
showConfirmDialog          (Mode.SERVER, Boolean.TYPE, ...)
getChoices                 (Mode.SERVER, List.class, ...)
order                      (Mode.SERVER, OrderResult.class, ...)
chooseSingleEntityForEffect(Mode.SERVER, GameEntityView.class, ...)
assignCombatDamage         (Mode.SERVER, Map.class, ...)
```

A Forge game thread calls `sendAndWait`, parks on a future keyed by event id, and
the game is *stopped* until that player picks a target. Nothing in watchparty
does this today — I grepped for ack/callback usage in `apps/server/src/ws/` and
there is none; every path is fire-and-forget `emit`.

**What we need:**

```ts
// server → one client, expecting an answer
const answer = await room.ask(clientId, 'choose_target', payload, {
  timeoutMs: 60_000,
  onTimeout: 'default' | 'throw',
  signal,                       // cancellable: player disconnects, game ends
});
```

with, at minimum: monotonic correlation ids, a pending-request registry, timeout
with a declared fallback, cancellation, and **pending requests replayed on
reconnect** (if you refresh mid-targeting, the prompt must come back — the game
is still blocked on you).

> Note for whoever implements this: Forge's own version of this registry,
> `ReplyPool.java`, will NPE if a reply arrives for an id it never initialised.
> Don't copy that part.

### 3.2 Per-recipient payloads — **hard requirement**

Watchparty broadcasts one payload to the whole room. That is structurally wrong
for a card game: I must not receive my opponent's hand **at all**, not even to
filter it at render time.

Forge already does this correctly server-side — `DeltaSyncManager` tracks, per
connected client, which objects that client has been told about, and
`TrackableSerializer.replace()` gates on `trackable.hasConsumer(consumerId)`. We
need the room layer to preserve that property rather than flatten it.

**What we need** — and the good news is `broadcastToRoom` in `safeEmit.ts`
already iterates sockets individually, so this is a small extension:

```ts
// today
broadcastToRoom(io, room, event, payload)

// also needed
emitPerRecipient(io, room, event, (client) => payload | null)  // null = send nothing
```

Plus the same for role-scoped sends (players vs. spectators).

### 3.3 A trusted backend participant — **hard requirement**

Your `GAME_EVENTS` relay elects a **browser tab** as authority, assigns slots and
a seed, and relays opaque payloads. The shape is right and we want it. The
authority model is not transferable:

- a browser cannot hold a hidden library — that's the whole game
- "host migrates" is not something you can do to a game of Magic in progress
- our authority is a **JVM process** running Forge, not a tab

**What we need:** a room can have a **service participant** — a trusted,
non-browser peer attached over a separate channel (local socket; it never faces
the internet) that:

- attaches to / detaches from a room, with a lifecycle the room owns
- receives client actions routed to it
- emits per-recipient state (§3.2) and issues asks (§3.1)
- has a defined crash/reconnect story: room survives, clients are told, state is
  resynced rather than silently diverging

Related: we need **sequence numbers and gap detection** exposed to clients so a
client can request a resync. Forge has this internally (`DeltaPacket.sequenceNumber`,
a `requestResync` protocol method) and we need the room layer not to hide it.

---

## 4. Two softer requests

**4.1 Seats.** Generalise `buildPlayerRoster` into seats: capacity, **stable
ordering** (a draft passes left, then right, then left — seat order is
load-bearing, not cosmetic), roles (player / spectator), and AI padding (you have
`botCount`; we have bot drafters). Keep spectators first-class — MTG wants them
more than watchparty does.

**4.2 Room persistence.** `rooms/store.ts` is `const rooms = new Map()`, and
`gc.ts` reaps empty rooms after a grace period. A cube draft runs 45+ minutes.
A server restart or a moment where everyone is briefly disconnected must not
destroy it. We'd like a pluggable snapshot/restore interface — in-memory by
default so nothing changes for watchparty.

---

## 5. Shape and acceptance

Suggested: `@wolffm/rooms-server`, `@wolffm/rooms-client`, `@wolffm/rooms-protocol`
(mirroring your existing apps/packages split), MIT, published from the watchparty
repo alongside what's there now.

**The acceptance test we care about is that watchparty is refactored onto it.**
An extraction that doesn't have its original consumer migrated isn't proven — it's
just a second copy with better naming. If watchparty still passes its 446 tests
running on `@wolffm/rooms`, the boundary is real and we'll trust it.

Beyond that:

- no watchparty domain vocabulary in the public API (no playhead, media,
  fragment, playlist, tierlist, sprite)
- §3.1–3.3 each have tests: an ask that times out, an ask replayed after
  reconnect, a per-recipient emit proving client A never receives B's payload,
  a service participant crash-and-resync
- the `X-User-Key` friend-tier contract is preserved exactly — we're behind the
  same edge gate

---

## 6. What we'll do either way

We're not blocked on this. Our P1 (browser cube draft) can run on a copied room
layer, and we'll build §3.1–3.3 ourselves on top of the copy if extraction isn't
something you want to take on.

But we'd be building it in a second copy of your code, and the first time
watchparty fixes a reconnect bug we won't get it. Hence the ask.

If it helps, we're happy to do the extraction work ourselves against the
watchparty repo and hand it back as a branch — tell us which you'd prefer.

---

### Appendix: why we're confident this is worth doing

The Forge side turned out far more separable than expected. Its entire transport
seam is a **three-method interface**:

```java
public interface IRemote {
    void send(NetEvent event);
    Object sendAndWait(IdentifiableNetEvent event);
    default void write(NetEvent event) { send(event); }
}
```

and `IToClient`, the server→browser seam, is `interface IToClient extends IRemote {}`
— empty. The protocol above it is a closed 62-method enum; the view layer is a
closed 214-property enum; the server already runs headless and already computes
per-client visibility.

Which means the hard, uncertain part of this project is not the Magic engine.
It's the room layer — and that part already exists, in your repo.
