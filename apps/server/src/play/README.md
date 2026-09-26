# `apps/server/src/play` — the match server

Wave 9, lane A. Starts a real Forge match behind the existing socket server,
maps our participants to Forge's players, and streams each seat **its own**
projection of the game over the A↔B transport contract.

```
browser ──forge:join / forge:c2s──►  socket.ts ──► match.ts ──► host.ts ──stdin──► bridge/PlayBridge.java (child JVM)
        ◄──────forge:s2c──────────   (per seat)    (per seat:     (one JVM                  Forge server + one stock
                                                    projector,     per match)                FGameClient per human seat
                                                    cursor,                                  over loopback Netty
                                                    history, asks) ◄──stdout JSON lines──
```

Since Wave 22 that stdin/stdout pair is **two named pipes in the match's run
directory**, not pipes inherited from this process, and the JVM is detached — so
the match outlives the server that started it. See "The run directory" and "A
match outlives its server" below.

| file | what |
| --- | --- |
| `index.ts` | the exports `src/index.ts` needs: `attachPlay`, `jvmHostConfig`, `jvmHostFactory` (plus `MAX_CONCURRENT_MATCHES`) |
| `socket.ts` | `attachPlay(io, api, deps)`: the HTTP routes and socket handlers, the gate, identity, per-recipient emit |
| `match.ts` | one match, socket-free: seat binding, per-seat projector/cursor/history, asks, lifecycle |
| `visibility.ts` | the hidden-information projection (Forge's `canBeShownTo`, server side) |
| `transport.ts` | the A↔B wrapper schemas (lane B mirrors them at `apps/ui/src/play/live/transport.ts`) |
| `host.ts` | the `MatchHost` seam, the one-JVM-per-match implementation, its warm spare, the concurrency ceiling, the run directory, and the re-attach seam a match survives a restart through (`orphans`/`attach`/`handOver`) |
| `auto.ts` | pure decisions: an ask with one legal reply, a stop with nothing to do, a payment with one source. `match.ts` acts on them; a seat's `fullControl` turns the file off for that seat |
| `bridge/PlayBridge.java` | the Java side: runs as a single-file source program, no build step |
| `dev/seat.ts` | a command-line seat, for local testing (see "Two seats locally") |
| `dev/spare-bench.ts` | cold start vs warm spare, measured (see "The warm spare, measured") |
| `fixtures/` | a recorded real bridge transcript, its replay host, the leak oracle, and `w20-turn-flow.json` (real priority/payment windows off a live match; see its own header) |

## The `src/index.ts` edit

`attachPlay` is the one call. It hangs its routes off the existing `api` router
(which `index.ts` mounts behind `requireMinTier`) and its handlers off the same
`io`. Exact edit:

```diff
--- a/apps/server/src/index.ts
+++ b/apps/server/src/index.ts
@@ -70,6 +70,7 @@
 import { createDraftRooms } from './room/draftRooms.js';
 import { loadPool } from './room/pool.js';
 import { attachDraftSocket } from './room/socket.js';
+import { attachPlay, jvmHostConfig, jvmHostFactory } from './play/index.js';
 
 mkdirSync(CONFIG.logDir, { recursive: true });
 
@@ -201,4 +202,17 @@ attachDraftSocket(io, {
 	minTier: CONFIG.minTier,
 });
 
+// ── Matches ──────────────────────────────────────────────────────────────────
+// One child JVM per match; see src/play/README.md. Without a configured Forge
+// build the route answers 503 and nothing else changes.
+const forge = jvmHostConfig();
+if (!forge.ok) console.warn(`[cardtable] play: no Forge (${forge.reason}) — POST /api/play/matches answers 503`);
+attachPlay(io, api, {
+	minTier: CONFIG.minTier,
+	host: forge.ok ? jvmHostFactory(forge.config) : null,
+	// Diagnostics for a live check only. Never set in production (see socket.ts).
+	probe: process.env.CARDTABLE_PLAY_PROBE === '1',
+	devIdentity: CONFIG.allowUnverifiedEdge && CONFIG.edgeAuthSecret === '',
+});
+
 // ── Listen ───────────────────────────────────────────────────────────────────
```

Verified without touching `index.ts`: a scratch server wired exactly this way
ran a two-seat match end to end (below), and `esbuild src/play/index.ts` with
the `build` script's flags bundles (814.8 kB, exit 0). From `dist/`, the bridge
source is found at `dist/../src/play/bridge/PlayBridge.java`.

That diff is the Wave 9 wiring and is still the whole of the attachment. Since
Wave 22 `index.ts` also has a **`SIGTERM`/`SIGINT` handler** that calls
`PlayHandle.shutdown` before it closes the sockets — without it a deploy kills
every live match, which is exactly what happened. See "A match outlives its
server".

## In-process or child process: one child JVM per match

Node cannot host a JVM, so the real choice was one JVM per match or one hosting
many. **One per match**, because Forge's network server is a per-JVM singleton
holding one lobby (`FServerManager.getInstance()`, `FServerManager.java:212`)
and the bridge drives the match through it. Lane D measured the same wall
(`docs/spikes/jvm-per-match.md`: a second match fails with `Hook previously
registered` at `FServerManager.java:276`) and recommends the same shape: ready
in ~3.4 s, ~650–730 MB RSS per JVM, and killing one leaves the others running.

Aligned with lane D's asks: **`matchId` on every line** in both directions (the
bridge stamps its own and refuses a command without it; `host.ts` checks and
strips it), **exit = match over** (an exit while starting or running fails that
match only), **close = `stop` → SIGTERM → SIGKILL**. **The warm spare is built
(Wave 10)** — see "Match lifecycle" below. The `MatchHost` interface did not
change for it, and would not for a shared host later.

## HTTP

All under `/api/play`, behind the same tier floor as every API route.

**`POST /api/play/matches`** — body (all optional):

```json
{ "opponent": "human" | "ai", "decks": [".dck text" | null, ".dck text" | null] }
```

`null` deck = a random Forge quest precon with ≥ 40 cards. The response comes
**after** Forge has opened the game for every human seat (~4–5 s), so a join
right after it is served at once:

| status | body |
| --- | --- |
| 201 | `{ matchId, epoch, seats: [{ seat, kind: "human"\|"ai", deck }] }` |
| 400 | `{ error }` — body not understood; no JVM is started |
| 404 | below the tier floor (same as every route) |
| 500 | `{ matchId, error }` — Forge could not start it (the bridge's `fatal`) |
| 503 | `{ error }` — Forge not configured, or `maxMatches` (default 2) already running |

**`GET /api/play/matches/:id`** → `{ matchId, status, failure, winner, seats: [{ seat, kind, deck, claimedBy }] }`.
`claimedBy` is the participant's 6-character digest handle, never the id.

**Only with `CARDTABLE_PLAY_PROBE=1`** (a dev diagnostic; never in production):

- `POST /api/play/matches/:id/probe` `{ seat, message? }` — Forge's **server
  side** sends that seat a real `showConfirmDialog` through the stock
  `RemoteClientGuiGame.sendAndWait` → Netty → the seat's `FGameClient` → the
  bridge → the socket → the browser, and blocks until the answer comes back.
  Answers `{ answer, ms }` (`ms` is measured inside Forge, around
  `sendAndWait`). The default is **No**, so a `true` can only have come from the
  seat.
- `GET /api/play/matches/:id/seats/:seat/state` → `{ cursor, objects }`: that
  seat's projected history folded — exactly what its browser should hold at
  `cursor`. It is that seat's hand, hence the flag.

## The socket contract, as implemented

Same `io`, same default path, same edge gate as the draft (re-installed here —
see `socket.ts`). Identity is `identityFromHeaders` over the sanitized
handshake, never a payload.

- `forge:join { matchId }` → ack `MatchSnapshot` or a refusal. The first join
  by a participant **claims** a seat: first free human seat, in order.
  Errors: `unknown-match`, `match-full`, `match-starting` (still booting after
  8 s), `a seat needs a durable identity …` (an `eph:` id).
- `forge:resync { matchId }` → ack `MatchSnapshot` or a refusal (`not-joined`
  if this connection never joined).
- **A refusal that means the match is GONE says so in words (Wave 22).** Join
  and resync share one path (`snapshotFor` in `socket.ts`), and exactly two
  outcomes get the wider shape:

  ```json
  { "error": "unknown-match", "outcome": "match-gone", "message": "<a sentence>" }
  ```

  `error` is **unchanged on purpose** — it is still the machine code, so nothing
  that only reads `error` changes behaviour. `outcome` is what the client keys
  off (`match-gone`, one of the six states lane F renders) and `message` is what
  it puts on the page, instead of the string `unknown-match`, which is what the
  operator was left looking at when a deploy killed their game.

  The two cases: the registry has never heard of the id (`socket.ts:428-431`),
  and the match is `failed`/`stopped` and this participant has no board to come
  back to (`:436-443`, which uses the match's own failure instead of the
  default sentence). The default is exported as **`MATCH_GONE_WORDS`** from
  `socket.ts` (`:155-157`) so the tests and any other caller quote one string.

  **Every other refusal keeps the bare `{ error }` it always had** — a malformed
  request, `not-joined`, and everything `claim`/`whenRunning` refuses
  (`match-full`, `match-starting`, the ephemeral-identity refusal). A client
  that has not learned the two new fields keeps working for all of them; only
  `match-gone` needs them.

  **The two schema mirrors disagree about this today (checked 2026-09-26, at
  `2ea81c0`).** The server BUILDS the three-field refusal through a type, not a
  schema — `MatchRefusal = MatchError & { outcome?: 'match-gone'; message?: string }`
  (`socket.ts:153`) — and its own `MatchErrorSchema` still allows only `error`
  (`apps/server/src/play/transport.ts:168`, `.strict()`). The client's mirror has
  been widened and parses the wide shape
  (`apps/ui/src/play/live/transport.ts:202-208`: `outcome` and `message` optional
  non-empty strings, and still `.strict()`, so a misspelled field is an error
  rather than being swallowed). Nothing is broken by the difference, because the
  server never parses what it builds — but the mirrors are the contract, and both
  being `.strict()` means **a client mirror that has not been widened cannot
  parse a `match-gone` at all**. `socket.ts:61`'s comment claims both mirrors are
  already aligned; they are not, at the version above.
- `forge:c2s { matchId, frame }` — `frame` parsed with `safeParseClientFrame`.
  A reply must match an open ask of **this seat** by `callId` and `method`.
- `forge:s2c { matchId, cursor, frame }` — per seat. `seq` counts every frame
  to that seat from 1, by exactly 1; `epoch` is `<matchId>:<start ms>`.
- `forge:full-control { matchId, on }` — **both ways, one schema.** Client →
  server it is a request, bound to the seat `claim` gave that connection and
  never to anything in the payload. Server → client it is that seat's CURRENT
  state, emitted to the socket that has just been answered a snapshot (join and
  resync alike, `on: false` included). It carries nothing about the game; it is
  a preference the server holds and no frame carries, so without the second
  direction a refreshed page drew the toggle off while the server still had the
  seat in full control (wave 21 §C.1). It is not a field of `MatchSnapshot`
  because that schema is mirrored in two packages and this event already
  existed — `transport.ts`'s header has the argument.

Three clarifications of the contract. The first two were agreed with the
manager mid-wave; the third is this lane's decision:

1. **`MatchSnapshot.cursor` is the seat's latest cursor of any kind**, not the
   last state frame's. Otherwise an ask re-sent after the snapshot lands as a
   `gap` and the client resyncs forever.
2. **A disconnect is an abort — after a grace (Wave 10).** When a seat's
   **last** connection goes and **stays gone for `disconnectGraceMs`** (default
   30 s), each open ask is aborted with `disconnected` (Forge gets its own
   answer to a null reply). A refresh aborts nothing, in either order — new tab
   first, or (what a browser actually does) old tab closed first; both tested.
3. After every snapshot the server re-sends, as ordinary frames on the next
   cursors: the seat's latest `showPromptMessage`, latest `updateButtons`, and
   every open ask. (The contract only required the ask; the prompt and buttons
   are what a player needs to know what to do, and the state channel does not
   carry them. A client that ignores them loses nothing.)

Also: a seat's `openView` is always its first state frame (state that arrives
before it is held, then projected once the viewer is known). Spectators are not
supported — a third person is refused, not given a view.

## Participants → seats → Forge players

`match.ts`'s header has the argument. In short: a participant binds to a seat
on first join **permanently** — a disconnect never unseats, a seat is never
transferred (that seat has a hand), and an ephemeral id cannot claim one. Seat
*i* is Forge lobby slot *i* (the bridge connects clients in seat order and
asserts it). The seat's Forge `PlayerView` id is learned from **that seat's
own** `openView`, and a seat reopened as a different player fails the match
rather than re-projecting for the wrong person.

## Hidden information

**Forge's per-client stream is not per-player safe. Verified, not assumed.**
`DeltaSyncManager.collectDeltas` walks the whole shared `GameView` for every
client and `toNetworkValue` never drops a property; there is no `canBeShownTo`
anywhere in `forge/.../gamemodes/net/`. Forge's client hides cards at render
time. In real streams — Wave 8's fixture and this lane's own captures — each
client receives **both hands and both libraries, named, in order**, and the
events arm names every drawn card.

So `visibility.ts` projects each seat's stream on the server, transcribing
`CardView.canBeShownTo` / `canFaceDownBeShownTo`: an opponent's hand, every
library and face-down exile arrive as `Owner`/`Controller`/`Zone`/`HiddenId`
only, with no face; a face-down permanent shows only its face-down face; a
card's visibility is recomputed after every packet and re-sent whole when it
changes (a draw), or wiped when it is lost. **The events arm is dropped
entirely** (it names cards; no per-event rule exists yet) and **the checksum
is zeroed** (it is computed over the unredacted state).

**Not fixed, recorded:** card ids are stable in Forge. A card the viewer once
saw and that is shuffled back into a library can be followed by id through the
ordered `Library` list. Forge's own client has the same property; `HiddenId`
is passed through for that reason.

## Finding: the one-JVM deadlock, and the fix

In the first live two-seat run the game froze at turn 2's cleanup discard. A
thread dump showed `AWT-EventQueue-0` parked in `ReplyPool.get` under
`InputSelectEntitiesFromList`. Forge's **server** side runs `tempShowZones`
inside `FThreads.invokeInEdtNowOrLater` (`InputSelectEntitiesFromList.java:65-68`)
and blocks the EDT waiting for the reply; the **client** dispatches every call
on the EDT (`GameClientHandler.java:38`, `runInEdt = true`). Stock Forge never
puts the two in one process. The bridge does, so the ask queued behind the wait
for it. Waves 6 and 7 never met it: their remote seat was handed to the AI.

Fix, inside the bridge: each seat's client gets its own serial "EDT"
(`SeatGui.ui`), and `BridgeGui` routes work submitted from a seat client's
Netty thread there, leaving the real EDT to the server. Per-seat order is
kept. Verified live: the same discard's `tempShowZones` reached its seat and
was answered in 3 ms, and a probe ran alongside it in 4.4 ms.

## Tests

| suite | what | real data |
| --- | --- | --- |
| `visibility.test.ts` (21) | both seats projected from Wave 8's 27-packet fixture; whole-payload leak check; own hand fully visible after draws; public cards untouched; events dropped (real `GameEventCardChangeZone`); `setGameView`; a face-down permanent | `apps/ui/src/play/fixtures/tierc-game1-seq1-27.json`, `packages/forge-wire/src/events/fixtures/` |
| `match.test.ts` (44) | identity binding and its failure modes, per-seat emission and the leak check, cursor, snapshot, asks (reply by callId, other seat cannot answer, disconnect/timeout/browser abort, re-send), invalid frames, lifecycle; the 'Flying' regression; **crash** (both seats told, once, at the next cursor; kept across a resync) and **reconnect** (the grace, the same board and ask after a refresh) | `fixtures/bridge-two-seats.ndjson`, `fixtures/bridge-flying-seat1.ndjson` |
| `socket.test.ts` (18) | real express + socket.io + clients with edge headers: POST, joins, match-full, whole-transcript leak check, contiguous cursors from the snapshot, reply routing, disconnect vs refresh, tier gate, dev identity refused without the hatch; a refresh in browser order (old socket closed first) outliving the grace; a crash leaving the server up; full control echoed to every join and resync, restored across a refresh, per seat, and withheld from a refused join | same transcript |
| `host.test.ts` (22) | the JVM pool against `fixtures/fake-bridge.mjs` (a child process speaking the bridge's line protocol, no Forge): spare adoption and re-addressing, a still-booting spare, spare off, `close()`, the ceiling counting the spare, the heap cap, a spare that keeps dying, a match's JVM SIGKILLed; the run directory (removed on a clean end, kept and pruned on a crash); the boot sweep against a **fixture** work dir (dead removed; live, fresh, in-bound crash records and anything not ours spared; the record bound; it runs when the pool is made); and Wave 22's re-attach — a JVM still running after the process that started it is gone and naming itself on disk, offered back and replayed into a new match, killed when nobody claims it, handed over on the way out and taken back by a second pool, a live spare ended from its own record, an orphan past `ORPHAN_MAX_MS` ended, and a live dir whose record names a different process left alone | fake bridge — runs in CI |
| `auto.test.ts` (76) | the shortcuts as rules: every committed prompt fixture stays a question; the bounds cases that answer themselves; `autoPassReason` and `autoPayReason` over typed frames AND over `fixtures/w20-turn-flow.json`'s real windows; the same through a whole `Match` over the replay host; `fullControl` turning all of it off | `apps/ui/src/play/prompts/fixtures/*.json`, `fixtures/w20-turn-flow.json` |
| `auto.jvm.test.ts` (1) | the same against a real Forge: stops passed only where Forge named nothing, every cast says what it paid, the scry asks about the scried cards; **skips visibly** without a jar | live |
| `jvm.test.ts` (3) | real matches in real JVMs — fixed decks + seed (cold), and seeded variety **through the warm spare**; then a refresh with a real ask parked in Forge, and a SIGKILL; **skips visibly** without `CARDTABLE_FORGE_JAR`/`CARDTABLE_FORGE_RES` | live |

The leak oracle (`fixtures/transcript.ts`, `secretsFor`) is defined from zones
— opponent's hand and every library, minus anything the viewer legitimately
saw — independently of `visibility.ts`. Each leak test also asserts the raw
stream contains every secret, so it cannot pass vacuously.

### The red JVM run the manager hit: an oracle false positive, not a leak

`jvm.test.ts` failed once in two manager runs with `expected [ 'Flying' ] to
deeply equal []`. The run was captured with the test's `CARDTABLE_PLAY_DUMP`
hook (red on the 4th of a loop; decks "Spirit Flames" v "Decay") and diagnosed
from the frames:

- The emitted "Flying" was `Keywords.v[0]` (a `keywords` value) on the faces of
  cards 96 **Abyssal Specter** and 100 **Foul Imp** — both in **seat 1's own
  hand**, correctly shown to seat 1.
- The "secret" came from card 99 **Bog Imp**, in **seat 1's own library**
  (hidden, correctly: its name was not emitted), whose face's `AbilityText` is
  the bare string `"Flying"`.
- `allowed` was built from `str` values only, so the visible flyers' keyword
  lists never counted as legitimately seen.

Fix, in the oracle only: `allowed` is now every string on a legitimately-seen
card at any depth (`everyString`); the secrets are unchanged. `visibility.ts`
did not change. The captured seat-1 frames are committed as
`fixtures/bridge-flying-seat1.ndjson`, and `match.test.ts` holds the exact case.
With the old oracle line restored, 2 of those tests fail; with the fix, they
pass. The guard mutation (below) still fails them.

The JVM runs are now repeatable. The fixed run uses the red run's decks and seed
20260918. The variety run prints its seed; rerun it with `CARDTABLE_PLAY_SEED`.
The seed drives Forge's `MyRandom` (shuffles, the coin toss) and the precon
pick. The AI and thread timing are not seeded, so a seed narrows a failure down
but does not replay it exactly.

### The JVM test, run for real on this host

```console
$ CARDTABLE_FORGE_JAR=~/.cache/cardtable-w8/forge-build/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar \
  CARDTABLE_FORGE_RES=~/.cache/cardtable-w8/forge-build/forge-gui/res \
  pnpm exec vitest run apps/server/src/play ; echo $?
[jvm] fixed: Spirit Flames v Decay, seed 20260918: running after 4480 ms (Forge boot 3673 ms); decks: Spirit Flames v Decay
[jvm] probe: {"answer":true,"ms":53.098452}
[jvm] seat 0: 14 envelopes, 142 secrets, 142 in Forge's raw stream, 0 in what was emitted
[jvm] seat 1: 15 envelopes, 148 secrets, 148 in Forge's raw stream, 0 in what was emitted
[jvm] variety: random precons, seed 715966380: running after 4344 ms (Forge boot 3650 ms); decks: Built from Scratch v Core Set 2019 Welcome Deck (RW)
[jvm] probe: {"answer":true,"ms":52.420301}
[jvm] seat 0: 14 envelopes, 332 secrets, 332 in Forge's raw stream, 0 in what was emitted
[jvm] seat 1: 15 envelopes, 333 secrets, 333 in Forge's raw stream, 0 in what was emitted
      Tests  69 passed (69)
0
```

Five times in a row, each exit read directly: `0 0 0 0 0`, 69/69 each, which is
ten real matches (the fixed pair five times, plus five variety seeds: 715852730,
715881046, 715909616, 715937879, 715966380). There were no leak dumps and no JVM
left afterwards.

Without the variables: `↓ apps/server/src/play/jvm.test.ts (2 tests | 2 skipped)`, and the
suite's name carries the reason (`… — SKIPPED: CARDTABLE_FORGE_JAR is not set`).
After the run, `liveJvmCount()` is 0 (asserted) and `ps` shows no bridge JVM.

### Wave 10's gated run

```console
$ CARDTABLE_FORGE_JAR=/home/hadoku/.cache/w7b-forge/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar \
  CARDTABLE_FORGE_RES=/home/hadoku/.cache/w7b-forge/forge-gui/res \
  pnpm vitest run apps/server/src/play/jvm.test.ts ; echo $?
[jvm] fixed: Spirit Flames v Decay, seed 20260918, cold: running after 4679 ms (JVM up 4533 ms, match start 3924 ms); decks: Spirit Flames v Decay
[jvm] seat 0: 14 envelopes, 144 secrets, 144 in Forge's raw stream, 0 in what was emitted
[jvm] seat 1: 15 envelopes, 142 secrets, 142 in Forge's raw stream, 0 in what was emitted
[jvm] variety: random precons, seed 754322428, through the warm spare: running after 464 ms (JVM up 4714 ms, match start 313 ms); decks: Gruul Wilding v Morph Mayhem
[jvm] seat 0: 17 envelopes, 173 secrets, 173 in Forge's raw stream, 0 in what was emitted
[jvm] seat 1: 16 envelopes, 180 secrets, 180 in Forge's raw stream, 0 in what was emitted
[jvm] refresh: seat 0 away 1500 ms with the ask open; board 103 objects, equal; Forge got {"answer":true,"ms":1555.235264}
[jvm] crash: SIGKILL pid 568767 → match failed, both seats told in 101 ms; failure: the JVM exited (code null, signal SIGKILL); see /tmp/cardtable-play/m-f86a32eae7ea/bridge.stderr.txt
      Tests  3 passed (3)
0
```

The ready line's `bootMs` is now from the JVM's own start (for a spare, including
its idle wait) and `startMs` from the moment the match was handed over.

Mutations, each reverted → failing, restored (`cmp`-identical) → passing, over
`match.test.ts`, `socket.test.ts` and `jvm.test.ts` with the JVM configured:

| mutation | failed | restored |
| --- | --- | --- |
| `fail()` no longer calls `tellSeatsItEnded` | 5 (3 match, 1 socket, 1 live JVM) | 8/8 of `-t crash` |
| `seatDisconnected` ignores the grace (Wave 9: abort at once) | 5 (3 match, 1 socket, 1 live JVM — the ask was aborted, never re-sent) | 8/8 of `-t refresh` |
| `forge:join` no longer calls `seatConnected` | 1 (socket: the 1 s grace outlived after the rejoin) | 14/14 socket |

### Mutation: remove the guard, watch it fail

The guard is applied in exactly one place, `Match.sendState`. Mutation: emit
Forge's raw frame instead of the projection.

```diff
-		const projected = s.projector.project(raw) as unknown as ServerFrame;
+		const projected = raw as unknown as ServerFrame; // MUTATION: the guard removed
```

```console
$ <JVM env as above> pnpm exec vitest run apps/server/src/play ; echo $?     # mutated
   × per-recipient emission, over whole serialised payloads > seat 0's envelopes carry none of the other seat's hidden cards
   × per-recipient emission, over whole serialised payloads > seat 1's envelopes carry none of the other seat's hidden cards
   × regression: the red jvm.test.ts run ('Flying'), from its captured frames > puts none of seat 1's secrets in what seat 1 is sent …
   × the cursor > folds the seat's own history into the state that seat should hold
   × two seats over the socket > never puts one byte of the other seat's hidden cards in what either peer received
   × a real Forge match in a child JVM > fixed: Spirit Flames v Decay, seed 20260918 — …
   × a real Forge match in a child JVM > variety: random precons, seed 716003498 — …
      Tests  7 failed | 62 passed (69)
1
$ <restored, cmp-identical> pnpm exec vitest run apps/server/src/play ; echo $?
      Tests  69 passed (69)
0
```

A second mutation one level down — `redactCard` and `faceAllowed` made to pass
everything — fails 6 of `visibility.test.ts`'s 21 (both seats' byte check,
both seats' hidden-card shape check, `setGameView`, face-down).

## The run directory

Every JVM gets `<workDir>/<id>` — `m-<12 hex>` for a match, `spare-<12 hex>` for
the spare — staged by `stageRunDir` in `host.ts`. `workDir` is
`CARDTABLE_PLAY_WORK_DIR`, default `<os tmpdir>/cardtable-play`, which is tmpfs
here: a directory nobody removes is RAM nobody gets back. The JVM's **cwd is
this directory**, and that fact is load-bearing twice over — Forge resolves
`res/` and its profile against the cwd, and `/proc/<pid>/cwd` is how a later
process tells a live run dir from a dead one.

| in `<workDir>/<id>` | written by | what it is |
| --- | --- | --- |
| `res` (symlink), `user/`, `cache/`, `forge.profile.properties`, `user/preferences/forge.preferences` | `stageRunDir` | Forge's own scaffolding, per match, so nothing is written into the build it reads from. The preferences file is `FORGE_PREFERENCES` — see its doc comment |
| `config.json` | `BridgeJvm.adopt`, and the pool before a cold spawn (the bridge reads it as its one argument) | the match the bridge is to run: id, seed, seats, decks. Kept in a crash record, so a crashed match can be replayed |
| `in.fifo`, `out.fifo` | `makeFifos` (shells out to `mkfifo(1)`; `node:fs` has no binding) | the JVM's stdin and stdout. **Named** pipes, not inherited ones, so a process that did not spawn the JVM can still speak to it. Both ends open them `O_RDWR` (`openJvmIo`), which on Linux succeeds with no peer and means neither side ever reads EOF — the bridge exits on stdin EOF, so a read-only fd would end the match the moment the server let go |
| `bridge.stderr.txt` | the JVM, through an `O_APPEND` fd | Forge's and the bridge's stderr — ~200 KB a match, and the only record of *why* a crash happened. A file rather than a pipe for the same reason as the fifos |
| `stream.jsonl` | `BridgeJvm.persist`, on every line **and** every command sent | the match's whole protocol history, in order, both directions (a command is stored as `{"c":{…}}`). It is what a re-attach replays to rebuild the per-seat projectors, cursors and open asks. A line that cannot be appended sets `durable = false` and **deletes `jvm.json`**: a replay from a stream with a hole would hand a seat a board Forge does not have |
| `jvm.json` | `BridgeJvm.writeRecord` — at spawn for a spare, on `adopt`, on `remember` (`match.ts:319`, `:340`, `:421`: the epoch at start/resume and the seats' owners as they are claimed) and on `handOver` | the handle a later process re-attaches by; below |
| `crash.json` | `keepCrashRecord`, on an unclean exit | marks the directory as a crash record and says how it ended (`reason`, `code`, `signal`, `at`) |

`jvm.json` is a `JvmRecord`: `{matchId, pid, run, startedAt, epoch, owners,
spec, spare?, orphanedAt?}`. Each field is there because a re-attach cannot be
done without it — `pid` + `run` are the identity check, `spec` is the match to
rebuild, **`epoch` is why a client resyncs on the cursor it already holds
instead of starting over**, and **`owners` (seat → participant id) is why seat 1
cannot come back as seat 0**, which would hand them the other player's hand.
`spare: true` marks a JVM that holds no game (never re-attached, killed at boot
from its own record); `orphanedAt` is stamped by `handOver` so the orphan bound
runs from the hand-over, not from the match's start. Nothing in it is something
a seat could not already see: `owners` are participant ids, which never leave
this host. It is read back by `readJvmRecord`, which returns null for anything
that is not a record — a record with no `spec` and no `spare` flag is not
re-attachable and is treated as absent.

What happens to the directory when the JVM is gone is decided by *how* it went,
and `host.ts`'s header ("The run directory") has the whole rule: a clean end —
we asked it to stop and it exited 0 — is removed whole; anything else is kept as
a crash record pruned to `CRASH_RECORD_FILES`, bounded by `CRASH_RECORDS_KEPT`
(20) and `CRASH_RECORD_MAX_AGE_MS` (7 days).

## Match lifecycle: warm spare, crash, reconnect (Wave 10)

### The warm spare

`jvmHostFactory` keeps one bridge JVM booted and matchless (`PlayBridge
--spare <spareId>`): Forge's model, card database and network server are up, and
it is blocked on stdin. `bootForge()` in the bridge is everything that does not
depend on the match, so a spare and a cold start run the same code in a
different order. A new match adopts the spare with one line:

```
Node → spare   {"t":"start","match":"spare-…","config":{"matchId":"m-…","seed":…,"seats":[…]}}
spare → Node   {"t":"ready",…,"match":"m-…"}            every line from here carries the match's id
```

Before `start` the spare's only line is `{"t":"warm","bootMs":…,"match":"spare-…"}`.
A replacement spare is spawned as soon as one is adopted — subject to the ceiling
below. A spare still booting is adopted anyway (never behind a fresh spawn). One
that dies idle is replaced after 5 s, and after 3 such deaths in a row the pool
gives up and starts matches cold (`spare-disabled` in the log). It is still one
JVM per match: a spare becomes exactly one match's JVM. Turn it off with
`CARDTABLE_PLAY_WARM_SPARE=0`. `attachPlay`'s `close()` stops the idle spare.

### The warm spare, measured

`dev/spare-bench.ts`, 5 rounds alternating cold and warm, same decks (Spirit
Flames v Decay) and seed, through `Match` exactly as the socket server uses it;
time from `registry.create()`. Host load average 3.1 → 6.3 during the run (other
lanes were active); `-Xmx1g`.

```console
$ CARDTABLE_FORGE_JAR=/home/hadoku/.cache/w7b-forge/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar \
  CARDTABLE_FORGE_RES=/home/hadoku/.cache/w7b-forge/forge-gui/res \
  pnpm --filter @hadoku/server exec tsx src/play/dev/spare-bench.ts --runs 5 ; echo $?
run 1 cold: first event 4649 ms, running 4651 ms, RSS at running 853 MB
run 1 warm: first event 461 ms, running 462 ms, RSS at running 750 MB, idle spare RSS 633 MB
run 2 cold: first event 4654 ms, running 4654 ms, RSS at running 751 MB
run 2 warm: first event 497 ms, running 499 ms, RSS at running 851 MB, idle spare RSS 637 MB
run 3 cold: first event 4754 ms, running 4755 ms, RSS at running 764 MB
run 3 warm: first event 479 ms, running 485 ms, RSS at running 738 MB, idle spare RSS 603 MB
run 4 cold: first event 4681 ms, running 4681 ms, RSS at running 745 MB
run 4 warm: first event 447 ms, running 447 ms, RSS at running 762 MB, idle spare RSS 637 MB
run 5 cold: first event 5302 ms, running 5303 ms, RSS at running 757 MB
run 5 warm: first event 438 ms, running 442 ms, RSS at running 764 MB, idle spare RSS 627 MB
cold: n=5, first event median 4681 ms (min 4649, max 5302), running median 4681 ms, RSS median 757 MB
warm: n=5, first event median 461 ms (min 438, max 497), running median 462 ms, RSS median 762 MB
0
```

**The spare saves ~4.2 s per match: 4,681 ms → 461 ms median to the first
event, n = 5 each.** "First event" is the first envelope any seat is sent (its
`openView`); "running" is both seats opened, which is when `POST
/api/play/matches` answers. What is left warm (~0.45 s) is deck parsing, two
loopback Netty clients joining the lobby, and Forge dealing the opening hands.
A warm run is measured the way production meets it: adopting the spare spawns
its replacement at once, so the match starts beside a booting JVM. An idle spare
holds ~600–640 MB of RSS; that is the price.

`jvm.test.ts` shows the same from the other side on every gated run: the cold
fixed run reaches running in 4,737 ms, the warm variety run in 484 ms.

### The ceiling: 2 concurrent matches, spare included

`MAX_CONCURRENT_MATCHES = 2` in `host.ts`, whose header has the whole argument.
In short: G1 does not hand committed heap back, so a JVM's RSS only ratchets up
while it lives and is budgeted at its peak; every JVM now gets **`-Xmx1g`**
(unless `CARDTABLE_PLAY_JVM_OPTS` names its own `-Xmx`) so that peak has a bound;
and the spare only exists while fewer than 2 matches do, so the JVM count — and
the memory bound — is 2 with or without it: ~1.5 GB expected (measured
745–853 MB per JVM at running, above), ~2.6 GB worst case. Two simultaneous
games is the friend group's real peak, and the host has ~25 GB free, so the
number is a deliberate choice rather than a memory limit: raising it should be a
decision, and a runaway match cannot take the box. `POST /api/play/matches`
refuses a third with 503 before any JVM is spent (`PlayDeps.maxMatches`), and
the pool applies the same number to its spare (`JvmPoolOptions.maxJvms`); both
default to the constant. Lane D's "revisit" line is ~8 concurrent matches.

### Crash

When the JVM dies mid-match (or the bridge sends `fatal`), `Match.fail`:

- moves this match — only this one — to `failed`, and `GET /api/play/matches/:id`
  says why (`failure`, with the stderr path);
- releases anything waiting on it and closes every open ask, so a late answer is
  refused rather than written to a dead pipe;
- sends **every seat that has a board** a `showErrorDialog` notify on its own
  stream at its next cursor, title `Match ended`, message `Forge stopped, and
  this match cannot continue: <cause>.` The server's paths stay out of it. It is
  a frame forge-wire already defines, so no contract changes.
- keeps it: a seat that resyncs or refreshes afterwards gets the board it had,
  then the same notice.

The socket server, the room and every other match carry on; the next `POST`
starts a new match (tested). Live: a SIGKILLed Forge JVM had both seats told
within 51–101 ms (the test polls every 50 ms).

**For lane A / the UI:** `LiveBoard` does not render `showErrorDialog` today.
The frame arrives, parses and is counted; showing it is a UI change.

### Reconnect

A browser refresh closes the old socket **before** the new page connects. Wave
9 aborted the seat's open asks on that close, so a refresh during a prompt gave
Forge a null answer and Forge acted for the player. Now the close arms a timer
(`disconnectGraceMs`, default 30 s in `attachPlay`, 0 in bare `Match` for
Wave 9's behaviour); the new page's `forge:join` (`Match.seatConnected`) disarms
it, gets a snapshot of the same board on the same epoch, and then the open ask
re-sent with its original `callId`, which it can answer. The rest was already
the draft's machinery: the seat is bound to the participant permanently (the
reservation never lapses — a Forge seat has a hand), and the client's
`classifySeq` continues from the snapshot's cursor. A seat gone longer than the
grace has its asks aborted as `disconnected`, as before.

Live: with a real `showConfirmDialog` parked in Forge's `sendAndWait` (default
NO), seat 0 went away for 1.5 s and came back; its 103-object board was equal
before and after, the same ask was re-sent, and Forge's call returned `true` —
the answer given after the refresh.

## A match outlives its server (Wave 22, lane E)

Until this wave every deploy ended every live game. `pm2 restart` SIGTERMs this
process, there was no handler, and `host.ts`'s `process.on('exit')` hook
**SIGKILLed every match JVM** on the way out — so two docs-only pushes killed
the operator's match four minutes apart, and the 08:00 UTC restart had been
doing it silently since the beginning. The client's reconnect was answered
`unknown-match`, which is also why the refusal now uses words (above).

Three things make a match survive, and each is forced by the one before it.
`host.ts`'s header, "A match outlives its server", is the long form.

1. **The JVM is spawned detached, on a transport that lives on disk.**
   `detached: true` puts it in its own process group, so a signal aimed at ours
   never reaches it; `child.unref()` keeps it off our event loop. Its stdio is
   three fds nobody inherits: the two fifos and the appended stderr file (see
   "The run directory"). **The exit hook is gone, on purpose** — an orphan is
   bounded by the sweep and the two constants below, not by our last breath.
2. **SIGTERM hands over instead of killing.** `index.ts`'s `shutdown()` calls
   `PlayHandle.shutdown(reason)`, which (a) sets `draining`, so
   `POST /api/play/matches` answers **503 with the sentence** rather than
   starting something that is about to die; (b) `matches.handOver()` — every
   `starting`/`running` match lets go of its JVM without signalling it, stamps
   `orphanedAt`, and **emits nothing** (a frame sent now would take a `seq` the
   next server's replay cannot reproduce); (c) a match that *cannot* be handed
   over is told to its seats in words by `Match.serverStopping` and then
   stopped; (d) the spare is closed either way, because it holds no game. Then
   the sockets are closed and the process exits within `SHUTDOWN_DEADLINE_MS`
   (5 s) whatever happens — pm2's `kill_timeout` is 1.6 s, so a handler that can
   hang buys nothing.
3. **The next process rebuilds the match from `stream.jsonl`.** The JVM still
   holds Forge's game, but the per-seat projectors, histories, cursors and
   parked asks died with the old process. `sweepRunDirs` (run once, when the
   factory is made) hands back a `JvmRecord` for every run dir whose recorded
   pid is still the process standing in it; `attachPlay` — at the very end, so a
   resumed match is in the registry and has its room before any client can ask
   for it — calls `matches.adopt(record)` for each, and `Match.resume` replays
   the whole stream **synchronously, before the first live line**. Replay is
   deterministic, so every seat's `seq` comes back identical; the epoch and the
   seat owners come off `jvm.json` because a replay cannot reproduce them. A
   client therefore resyncs on the cursor it already held. A re-attached JVM is
   nobody's child, so it has no `exit` event: its death is noticed by polling
   `process.kill(pid, 0)` every second (`PID_POLL_MS`).

### Nothing keeps an orphan for ever

Three bounds, each with its own reason, values read from the code:

| bound | value | what it does |
| --- | --- | --- |
| `ORPHAN_MAX_MS` (`host.ts`) | **12 h** (`12 * 60 * 60 * 1000`) | measured from `orphanedAt` (or `startedAt`). Past it the sweep does not offer the match back at all: it kills the pid and removes the directory. Nobody is coming back to yesterday's game |
| `ORPHAN_CLAIM_MS` (`host.ts`) | **60 s** (`60_000`) | an orphan nobody claimed this long after boot is killed and swept. This is what makes `orphans()` safe to ignore: a caller that never calls it cannot leak a JVM, and the spare comes back |
| the rejoin grace | **5 min** (`match.ts`, `deps.rejoinGraceMs ?? 5 * 60_000`; `PlayDeps.rejoinGraceMs`) | a match taken back that nobody rejoins is `stop()`ped. A resumed match with no players is a JVM nobody wants |

Orphans also count against `maxJvms` from the moment they are found, so a
re-attach cannot push the JVM count past the ceiling of 2.

`host.ts`'s header says this bound is enforced by `Match.expectRejoin`. **There
is no such method** — it is `Match.resume`'s `rejoinGraceMs` timer
(`match.ts:332-360`), fed from `createMatchRegistry`'s default at
`match.ts:1038`. The behaviour is as described; only the name in that comment is
wrong, and it is lane E's file to fix.

### The boot sweep's live-process guard is a safety control

`sweepRunDirs` spares any directory that **some live process on this host has as
its cwd** — `processCwds()` reads `/proc/*/cwd`, and a JVM's cwd is its own run
dir. That one condition is the difference between "clean up after a crash" and
"delete a running match's files":

- It is what lets **another server's** match survive our boot, including one
  started by a version of this code that predates the record. A live directory
  whose `jvm.json` we cannot match to the process standing in it is spared
  **and left alone** — it may not be ours.
- Identity is `pidIsStandingIn(record.pid, dir)`: the recorded pid must be the
  very process whose cwd is *this* directory. That is what makes it safe against
  pid reuse — a recycled pid is some other program, in some other directory. The
  record's own `run` string is deliberately *not* compared, because `runDirs`
  resolves `workDir` through `realpath` and the writer did not.
- Where `/proc` cannot be read the sweep does **nothing at all** and says why
  (`SweepResult.skipped`). A live directory cannot be told from a dead one there,
  and guessing wrong deletes a running match.
- Since this wave the guard also answers *whose*: a live dir with a re-attachable
  record becomes a `SweepResult.orphans` entry. The only directories the sweep
  ends while live are ones whose own record condemns them — a `--spare` (it holds
  no game) or an orphan past `ORPHAN_MAX_MS`.

**Do not "simplify" that condition away.** The manager mutation-tested it this
wave: disabling the live-cwd check alone turns **8 of the 22 tests in
`host.test.ts` red**. (Lane Q did not re-run it — this lane owns no code and ran
no suite; the number is the manager's.) The failure mode it guards against is
not a red test in production, it is a game deleted under two people who were
playing it.

## Running a real match locally

Prerequisites: the prebuilt jar and Forge's `res/` (read-only), and the
user-local JDK 21 (found automatically under `~/.local/opt/jdk-21*`; the JRE on
`PATH` cannot run a source-file program).

```sh
# 1. The server (after the index.ts edit above), bare-local, with diagnostics on.
export CARDTABLE_FORGE_JAR=~/.cache/cardtable-w8/forge-build/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar
export CARDTABLE_FORGE_RES=~/.cache/cardtable-w8/forge-build/forge-gui/res
export CARDTABLE_INSECURE_NO_EDGE_AUTH=1 CARDTABLE_PLAY_PROBE=1
pnpm --filter @hadoku/server dev                    # listens on 127.0.0.1:9008

# 2. A match (returns once Forge has opened it, ~5 s).
curl -s -X POST -H 'content-type: application/json' -d '{"opponent":"human"}' \
  http://127.0.0.1:9008/api/play/matches
# → {"matchId":"m-…","epoch":"…","seats":[…]}

# 3. Seat 0: the browser (lane B's harness; join order decides the seat).
#    http://localhost:<vite port>/cardtable/src/play/live/harness.html?match=m-…&server=http://127.0.0.1:9008

# 4. Seat 1: the command-line seat, pressing OK so the game moves.
pnpm --filter @hadoku/server exec tsx src/play/dev/seat.ts --match m-… --user bob --ok

# 5. The question: a real showConfirmDialog to seat 0, answered in the browser.
curl -s -X POST -H 'content-type: application/json' -d '{"seat":0,"message":"Answer me"}' \
  http://127.0.0.1:9008/api/play/matches/m-…/probe
# → {"answer":true,"ms":…}   (blocks until the browser answers; default is No)

# 6. Compare the browser's board with the server's view of that seat.
curl -s http://127.0.0.1:9008/api/play/matches/m-…/seats/0/state
```

### Two seats locally, and why a browser tab alone is not enough

With the bare-local hatch open, every header-less caller is the same
`local-dev` participant, and a browser cannot set `x-user-id` on a websocket
handshake — so two browser tabs are ONE participant and both land on seat 0.
Two supported ways to get two people:

- **Browser + CLI seat** (no code change anywhere): steps 3 and 4 above. The
  CLI is a real socket.io client on the same contract; it sets its own
  `x-user-id` (`cli-seat-<user>`), which the hatch believes. `--answer yes`
  also answers `showConfirmDialog` and acknowledges `tempShowZones`.
- **Two browsers, dev identity:** the server accepts `auth: { devUser }` or
  `?devUser=` on the handshake, **only** when the hatch is open (checked
  against `CONFIG`, and tested refused otherwise). Lane B's
  `socketIoMatchTransport` sends neither today; the one-line change is to pass
  `auth: { devUser: params.get('devUser') }` (or `query`) into `io(...)` in its
  harness. That file is lane B's.

Note: lane B's UI renders `showConfirmDialog` only. The browser seat therefore
cannot press Play/Keep/OK, so the game waits on it at the coin toss or the
mulligan — that is the game waiting on a human, not a hang. The probe is
independent of the game thread and works at any point; it is the reliable way
to put a `showConfirmDialog` in front of the browser. The engine's own
`showConfirmDialog` is rare — its one in-game caller is the "mana floating,
pass priority anyway?" check (`InputPassPriority.java:318`), which needs a land
tapped first.

### What was run end to end here

Scratch server wired as in the diff (deleted afterwards), bare-local hatch,
two CLI seats (`alice` `--ok --answer yes`, `bob` `--ok --answer yes`):
`POST` → 201 in 4.4 s; seat 0 → `dev:3a100b28a4561b2b`, seat 1 →
`dev:6662f2f6da7a4596`; both seats played through turn 1 into turn 2; the
cleanup discard's `tempShowZones` reached seat 0 and was answered (3 ms); the
probe to seat 0 answered `{"answer":true,"ms":4.42}`; `GET` showed
`running`, both seats claimed. Every process stopped afterwards.

## The 15 asks and the 29 frames

The bridge encodes **every** Tier A/B frame a browser needs except
`applyYieldUpdate` (not forwarded) and answers `sideboard` with `null` (keep the
deck) — a one-game match never asks it. Exercised live: `showConfirmDialog`
(probe) and `tempShowZones` (the discard); the notifies `setGameView`,
`openView`, `applyDelta`, `showPromptMessage`, `updateButtons`,
`setSelectables`; the act `selectButtonOk`. **Encoded but never exercised
live:** `showOptionDialog`, `showInputDialog`, `confirm`, `getChoices`, `order`,
`chooseSingleEntityForEffect`, `chooseEntitiesForEffect`, `manipulateCardList`,
`getAbilityToPlay`, `assignCombatDamage`, `assignGenericAmount`, `openZones`,
and the acts `selectCard`, `selectPlayer`, `selectAbility`, `useMana`,
`concede`, `nextGameDecision`, `requestResync`. Every frame is parsed with
forge-wire on the Node side before it is forwarded; one that fails is dropped,
counted (`Match.invalidFrames`) and logged. No refused `GameEvent` was needed
(events are not forwarded at all). No sixteenth method.

## Not verified

- **A browser on the live path.** Everything live here used the CLI seat; lane
  B's UI against this server is the manager's integration check.
- **Most asks, live** (list above). Their encoders are exercised only by what
  the two live runs hit.
- ~~**Reconnect across a Node restart.** A restart kills the JVM (by design: the
  exit hook SIGKILLs children)~~ — **no longer true, and it was the bug**: Wave
  22 removed the exit hook and a match now survives a restart (see "A match
  outlives its server"). What is verified is the mechanism, in `host.test.ts`
  against the fake bridge: a JVM outliving its starter, the hand-over, the
  re-attach and the replay, and every orphan bound — and once with a **real
  Forge match and a real SIGTERM** against a fixture server on a scratch port
  and work dir (lane E: handed over in 1 ms, the JVM survived, the next boot
  swept `live:[m-…] orphans:[m-…] removed:0`, replayed 9 lines and answered
  `running` on the same epoch with both seats back at `seq 4`). **Not watched: a
  real `pm2 restart` under two live browsers** — that is the operator's check,
  and the honest half of the fix (the seats told in words) is the path taken when
  it fails.
- **The `faceOnly` whitelist in a real game.** Tested on a real battlefield
  card flipped face down in a fixture; no real morph was captured.
- **Card ids through a shuffle** (see "Hidden information").
- ~~Memory and startup of this bridge specifically~~ — measured in Wave 10
  ("The warm spare, measured"): 745–853 MB RSS at running with `-Xmx1g`, cold
  start 4.6–5.3 s to the first event.
- **RSS late in a real 20–40-minute match.** Measured at `running` only. The
  heap cap bounds it; nobody has watched one grow.
- **A hung (alive, silent) JVM.** A crash is detected by the process exiting.
  A JVM that stops talking without exiting is caught only by the per-ask
  timeout (10 min), and only while an ask is open.
- **The crash notice in a browser.** It reaches the socket and parses; the UI
  does not render `showErrorDialog` yet (lane A's side).
- **A refresh through lane B's browser client.** Tested with socket.io clients
  in browser order; not with the real `LiveBoard` in a real tab.

## Follow-ups owed

- Add `zod` to `@hadoku/server` (and `@hadoku/ui`) and move the A↔B schemas
  into one shared package; both mirrors are built from borrowed instances today.
- A per-event visibility rule, so the events arm can be forwarded.
- Lane B: pass `devUser` on the handshake in the harness (two local browsers).
- `sideboard` and `applyYieldUpdate` when multi-game matches exist.
- UI: render `showErrorDialog` (the crash notice) in `LiveBoard`.
- A liveness check for a JVM that hangs without exiting (see "Not verified").
