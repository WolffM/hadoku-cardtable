# Architecture

How a Forge fork and the hadoku-watchparty room layer become one thing.

> **Status: design, not implementation.** Nothing in this repo runs yet.
> Every factual claim about Forge has now been checked against a real clone —
> the evidence lives in **`FORGE_ANALYSIS.md`**, which supersedes the
> `[assumed]` markers this document originally carried.

## The one-paragraph version

Forge already has the hard half of what we want and the wrong half of what we
need. Its network play is **server-authoritative**: the host process runs the
real rules engine and pushes *GUI calls* — "show this card", "you have priority",
"choose a target" — to remote clients, which are pure renderers. That is exactly
the shape a browser client wants. What makes it unusable from a browser is only
the **transport**: Java object serialization over Netty. So the plan is not
"bolt networking onto Forge". It is: keep Forge's server-authoritative model,
**replace its wire format at the seam Forge itself already drew**, and let the
watchparty room layer own everything above the match — identity, rooms, chat,
presence, pods, lobby.

## The seam

Forge's netplay lives in `forge-gui/src/main/java/forge/gamemodes/net/`. **[verified]**

```
net/
├── server/
│   ├── FServerManager.java        listens, accepts, owns the lobby
│   ├── ServerGameLobby.java       pre-match slot/deck state
│   ├── RemoteClient.java          one connected player
│   ├── IToClient.java         ←   THE SEAM. server → one client.
│   ├── RemoteClientGuiGame.java   implements the GUI interface, but for a
│   │                              REMOTE player: every call is marshalled
│   │                              and sent instead of drawn
│   ├── DeltaSyncManager.java      sends state diffs, not whole snapshots
│   └── GameServerHandler.java
├── client/                        the mirror image, in the remote JVM
├── draft/
│   └── BoosterDraftHost.java      networked draft already exists
├── event/
├── GameProtocolSender.java  }     RPC framing
├── GameProtocolHandler.java }
├── CObjectInputStream.java  }
├── CObjectOutputStream.java }     Java serialization ← the part to replace
├── CompatibleObjectEncoder/Decoder.java
├── TrackableSerializer.java       serializes the view layer (below)
├── WireClassFilter.java     }     deserialization gadget guards — a hint that
└── WireStreamLimits.java    }     Java-serialization-over-network is a known
                                   liability even upstream
```

`RemoteClientGuiGame` is the whole argument for this project. Forge's authors
already factored "a player whose GUI is not in this process" into a class. A
browser player is that, with a different encoder.

### Why the view layer makes this tractable

Forge does **not** ship raw game objects to clients. `forge-game/src/main/java/forge/trackable/`
holds a change-tracked view layer that `GameView`, `PlayerView`, `CardView`,
`CardStateView` and `StackItemView` are built on.

**Checked, and it's a go:** `TrackableProperty` is a **closed enum of 214
constants**, each declared with its type. A JSON encoder is therefore a
mechanical mapping over 214 typed properties and 5 object types — not an
open-ended object graph problem.

Better still, **per-client visibility is already solved**: `DeltaSyncManager`
tracks which objects each client has been told about, and the serializer gates on
`trackable.hasConsumer(consumerId)`. Your opponent's hand is never placed in your
delta. Forge is not a trust-the-client architecture.

### Why the transport has to go

- Java serialization is Java-only. No browser speaks it.
- It's a deserialization-gadget surface; upstream already carries
  `WireClassFilter` and `WireStreamLimits` to contain it.
- Every version skew is a `serialVersionUID` incident.

And the seam is *tiny*. `IToClient` is `interface IToClient extends IRemote {}`
— empty — and `IRemote` is three methods (`send`, `sendAndWait`, `write`).
Putting a browser behind Forge is one class implementing three methods.

A JSON/WS encoder behind the same `IToClient` interface fixes all three, and the
Java client can keep using the Netty path unchanged — the two transports coexist.

## The other half: what watchparty already solved

`~/repos/hadoku-watchparty` is not a video player with rooms bolted on. The room
layer is separable and is roughly what this project needs above the match:

| watchparty                              | what it gives us                                   |
| --------------------------------------- | -------------------------------------------------- |
| `apps/server/src/rooms/store.ts`        | room lifecycle, client registry, reconnect identity |
| `apps/server/src/ws/join.ts`            | room-key auth, seat assignment                      |
| `apps/server/src/ws/chat.ts`            | chat + system messages + image attachments          |
| `apps/server/src/ws/presence.ts`        | heartbeat, roster, identity updates                 |
| `apps/server/src/ws/readyCheck.ts`      | "is everyone ready" — literally the draft-start gate |
| `apps/server/src/middleware/userIdentity.ts` | friend-tier `X-User-Key` → stable identity     |
| `packages/shared/src/protocol.ts`       | Zod-validated wire schemas shared by both ends      |
| `apps/ui/src/lib/socket.ts`             | reconnect, resync, event typing                     |
| `apps/ui/src/components/Chat*.tsx`      | the whole chat UI                                   |

The single most transferable idea is `GAME_EVENTS` in that protocol file: a
**game-agnostic relay** where the server elects a host, assigns player slots,
issues a shared seed, and relays opaque per-game payloads without interpreting
them. Bomberman rides on it today.

**Where it stops being enough:** in that relay the authority is a browser tab. For
Magic the authority must be the Forge JVM — a browser client cannot be trusted
with a hidden library, and "host migrates" is not a thing you can do to a game of
Magic in progress. So the relay's *shape* ports; its *host election* does not.
See `requests/WATCHPARTY_ROOM_MODULE.md` for the file-by-file call.

## Target topology

```
   browser (friend tier)                hokon
  ┌────────────────────┐        ┌───────────────────────────┐
  │ ui/  React SPA     │        │ apps/server  Node + WS     │
  │  ├ lobby / pods    │◄──WS──►│  rooms, chat, presence,    │
  │  ├ cube draft      │        │  pods, draft state          │
  │  └ play client (P4)│        │  ── owns everything ABOVE  │
  └────────────────────┘        │     a match ──              │
                                │            │                │
                                │            │ WS/JSON (P3)    │
                                │            ▼                │
                                │ ┌────────────────────────┐ │
                                │ │ forge/  headless JVM   │ │
                                │ │  forge-game + forge-ai │ │
                                │ │  FServerManager        │ │
                                │ │  + our JSON IToClient  │ │
                                │ │  ── owns the MATCH ──  │ │
                                │ └────────────────────────┘ │
                                └───────────────────────────┘
        all of it behind hadoku.me/cardtable/ (friend-tier edge gate)
```

Two processes on purpose. The Node side never needs to understand Magic; the JVM
never needs to understand rooms or auth. It also keeps the licence boundary a
process boundary (see `LICENSING.md`).

## Phases

Ordered so each one is independently useful and the risky part is last.

### P1 — Browser cube draft *(the only phase with a near-term payoff)*

Drafting is the social bottleneck and it is a *small* protocol: build pods, open
packs, pass, pick, timebox, chat. No rules engine involved at all — a pick is a
card id moving between two lists.

- Port the watchparty room/chat/presence layer (`requests/WATCHPARTY_ROOM_MODULE.md`).
- Cube list ingest — **import Forge's 96 bundled cubes verbatim** from
  `forge/forge-gui/res/cube/*.dck`; card data from Scryfall bulk
  (`LICENSING.md` governs images — do **not** mirror them).
- Draft protocol + pack generation.
- Output: a `.dck` per player.

**Revised since first draft:** I originally assumed P1 would owe nothing to
Forge. That was wrong — `forge-gui/src/main/java/forge/gamemodes/limited/` is
6,781 lines of working draft logic (`BoosterDraft`, `CubeImporter`,
`BoosterDraftAI`, `WinstonDraft`) and there's a networked draft host already. So
P1 is now a real trade-off: reimplement in TS and stay JVM-free, or reuse and
pull the bridge forward into P1. *Leaning reimplement*, because staying JVM-free
is the entire point of shipping draft first — but steal Forge's pack-generation
rules rather than inventing them, and take its cube lists outright.

**Done when:** eight friends draft a cube in a browser and each downloads a deck.

### P2 — Play the match in Forge desktop

The decks from P1 import into stock Forge; the match runs on Forge's existing
netplay. Ugly (everyone installs Java) but it closes the loop and it is nearly
free — mostly `.dck` export correctness and a "here's how to connect" panel,
exactly the connect-blob pattern `hadoku-games-host` already uses for
brave-quartet.

**Done when:** a drafted deck plays a real game without hand-editing files.

**Note:** upstream describes netplay as a work in progress, with mid-game bugs
that force both sides to restart. **[verified — community reports]** P2 is a
bridge, not a destination, and its flakiness is the argument for P3.

### P3 — The JSON bridge

Fork work begins. A new module (`forge-net-json`) implementing `IToClient` over
WS/JSON, plus headless boot of `FServerManager` without the desktop GUI. Forge
already runs headless for AI simulation **[verified: `sim` CLI mode]**, which is
evidence the engine has no hard display dependency — though the *lobby/server*
path is a different entry point and needs its own check. **[assumed]**

Start by reading `TrackableSerializer` and enumerating `TrackableProperty`. That
read is the go/no-go for this phase.

### P4 — Browser play client

Render `GameView`/`CardView` deltas; send back choices. Still the biggest phase,
but now an enumerable one. Of the 47 server→client protocol methods: ~25 are
fire-and-forget view updates, ~8 are chrome, and **~14 are blocking prompts** —
`showConfirmDialog`, `getChoices`, `order`, `confirm`,
`chooseSingleEntityForEffect`, `assignCombatDamage`, `sideboard`, … *Those 14 are
the UI.* Client→server is only 15 small methods.

So: a board renderer over `CardView` plus ~14 prompt components. Ship them one at
a time — each unlocks a class of cards, and an unimplemented prompt degrades to
"finish this game in Forge desktop" rather than breaking.

## Decisions already made

| Decision | Choice | Why |
| --- | --- | --- |
| Repo name | `hadoku-cardtable`, route `/cardtable/` | engine- and format-neutral; leaves room past MTG |
| Fork layout | Forge vendored in-repo at `forge/` | one checkout, one session context |
| Vendor mechanism | **git submodule** → `WolffM/forge` | honours "vendored" while keeping ~70k upstream commits out of this repo's history; upstream merges stay a Java-repo concern. One-line switch to `git subtree` if we ever want a single object store more than we want a clean log. |
| Sequencing | draft-first (P1→P4) | playable in weeks instead of months |
| Licence | GPL-3.0 for the whole repo | consequence of vendoring; see `LICENSING.md` |

## Open questions

**Answered by `FORGE_ANALYSIS.md`:** `TrackableProperty` is a closed 214-constant
enum (go). `FServerManager` is GUI-free and headless is regression-tested (go).
Cube draft is first-class with 96 bundled cubes. Maven: **no `mvnw` upstream** —
only `.mvn/maven.config` — and hokon has no `mvn`, so that's a real prerequisite
to install.

Still open:

1. **P1: reuse Forge's draft engine or reimplement in TS?** See the P1 note above.
2. **One JVM per match, or one hosting many?** Per-match bounds the blast radius
   of a rules-engine crash; shared is cheaper. Affects the room module's
   backend-attachment lifecycle. Defer to P3, decide before building it.
3. **`FSerializableFunction` crosses the wire** in `getChoices`/`one` — a
   *function* used to label choices. Cannot be sent to a browser; needs
   pre-rendered labels on the JSON path. Not yet investigated.
4. **jUPnP** must be actively disabled — `FServerManager` punches a port via UPnP
   and we're behind cloudflared.
5. **Does watchparty take the extraction request?** (`requests/WATCHPARTY_ROOM_MODULE.md`.)
   We're not blocked either way, but it changes whether we own a copy.
