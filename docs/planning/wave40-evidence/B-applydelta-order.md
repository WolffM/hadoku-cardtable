# B — a proposal for the tracker, not shipped: `SeatGui.applyDelta`'s own ordering

**Reverted.** `PlayBridge.java` is byte-identical to HEAD
(`git diff --quiet HEAD -- apps/server/src/play/bridge/PlayBridge.java` exits 0). Nothing in this file
shipped this wave. Recorded here only as a proposal, per the manager's instruction: a bridge change
with no failing test behind it does not go into production games this wave.

## What it was

`SeatGui.applyDelta` sent the wire frame naming a delta's new objects (`frame(f)`) **before** calling
`super.applyDelta(packet)` — the call that creates and registers those objects in this seat's own
client-side tracker. The proposed diff swapped the two statements, so registration happens first:

```diff
@@ SeatGui.applyDelta @@
-            if (packet != null && (!packet.getNewObjects().isEmpty() || !packet.getObjectDeltas().isEmpty())) {
-                final JsonObject f = notify("applyDelta");
-                final JsonObject payload = new JsonObject();
-                payload.add("packet", packetJson(packet));
-                f.add("payload", payload);
-                frame(f);
-            }
-            super.applyDelta(packet);
+            super.applyDelta(packet);
+            if (packet != null && (!packet.getNewObjects().isEmpty() || !packet.getObjectDeltas().isEmpty())) {
+                final JsonObject f = notify("applyDelta");
+                final JsonObject payload = new JsonObject();
+                payload.add("packet", packetJson(packet));
+                f.add("payload", payload);
+                frame(f);
+            }
```
(`+24/−1` as actually diffed; the real change is just this reorder, the rest is doc comment.)

## The argument for it

An incoming act (`card()`/`player()` in the same class) resolves an id reference off THIS seat's own
tracker (`getGameView().getTracker().getObj(...)`), on the `bridge-stdin` reader thread — a different
thread from the one `applyDelta` itself always runs on (`BridgeGui#invokeInEdtLater` routes a client's
inbound protocol calls to that seat's own `ui` executor). The old order told Node about new objects
before this seat's own tracker had them, so a reply fast enough to race it could reach `card()` before
the object it names exists, throwing `IllegalArgumentException("no card N in seat S's view")` — caught
by `readCommands` and logged as `rejected`, never crashing the match, but silently dropping the click.
`packetJson` (what the frame actually sends) reads only the packet's own maps, never the tracker, so
sending it after `super.applyDelta` changes nothing about its content. Read against Forge's own
`NetworkGuiGame.applyDelta` (`forge/forge-gui/src/main/java/forge/gamemodes/net/NetworkGuiGame.java`):
it only mutates the tracker, no GUI callouts, so the reorder is safe to make. `setGameView`, right
above this method in the same class, already does it in this (registration-first) order; this was the
one place in `SeatGui` that still did not.

## Why it is not shipped this wave

Mutation-tested against both pinned flakes it was hunted down for, with it reverted and every other fix
in place:

| test | bridge order | runs | fail |
| --- | --- | --- | --- |
| `auto-pass-land.jvm.test.ts` | reverted | 8 | 0 |
| `scenario-thoughtseize.jvm.test.ts` | reverted | 10 | 0 |
| `scenario-thoughtseize.jvm.test.ts` | fixed | 10 | 0 |

No test in this suite fails without it and passes with it. It is a real, independently-arguable
ordering bug (same shape as wave37's decode race, one level up — the ACT path instead of the DELTA
path), but "independently arguable" is not "proven necessary", and per the manager's instruction a
bridge change with no failing test behind it should not land this wave.

## For the tracker

If this is worth taking anyway (closing a latent race before it is ever observed, rather than after):
compiles clean (`javac -cp forge.jar`), passes `jvm.test.ts` (3/3) and `mulligan.jvm.test.ts` (2/2)
no-scenario, and every scenario suite this lane ran green with it in place. The diff is one two-line
swap in one method, isolated from everything else in the file. No test currently distinguishes its
presence from its absence.
