# A — the stop-preference message shape

Written within the first few minutes of the lane, per the wave brief's own
instruction ("fit the existing convention for client→server play messages …
you choose"). Lane B reads this file.

## Shape

One new socket.io event, client → server only, no ack and no echo — the same
device `forge:full-control` uses, and for the same reason: this is a
preference of the person in the seat, not a Forge frame.

```
event:   forge:stop-preference
payload: { matchId: string, type: 'stopPreference', stopAtEndStep: boolean }
```

- `matchId` — same field, same meaning, as every other client→server event on
  this wire (`forge:join`, `forge:resync`, `forge:full-control`).
- `type: 'stopPreference'` — a literal string tag on the payload. The event
  name already disambiguates it, but the tag means a client that logs the raw
  payload (or a future second preference riding the same event, should one
  ever be added) can tell what it sent without cross-referencing the event
  name. This is the wave brief's own suggested shape, kept literally.
- `stopAtEndStep: boolean` — item 2/6's whole preference: *"always stop at end
  step — default off."*

## Where it lives

- **Client (mine):** `apps/ui/src/play/live/transport.ts` —
  `MATCH_EVENTS.stopPreference`, `StopPreferenceSchema`, `stopPreferenceFrame`.
  `apps/ui/src/play/live/match.ts` — `LiveMatch.stopAtEndStep` (this client's
  own last word; there is no server echo to read back) and the one sender,
  `sendStopPreference(match, stopAtEndStep, force?)`.
- **Server (lane B's, read-only from here):**
  `apps/server/src/play/transport.ts` — `MATCH_EVENTS.stopPreference`,
  `StopPreferenceSchema`, `StopPreferenceRequest`.
  `apps/server/src/play/socket.ts` — the `socket.on(MATCH_EVENTS.stopPreference,
  …)` handler, which reads the seat's current `StopPolicy`
  (`Match.stopPolicy`), toggles `END_OF_TURN` in or out of
  `stopOnTheirTurn` depending on `stopAtEndStep`, and writes it back through
  the already-existing `Match.setStopPolicy` (wave 26 §E) — no second
  mechanism, no new field on `StopPolicy` itself.

## How this settled

This file did not exist when lane B reached the item, so B built its handler
against the wave brief's own literal suggestion — `{ type: 'stopPreference',
stopAtEndStep: boolean }` — as a documented fallback, and noted in its own
comment that "the manager reconciles this against whatever §A actually
built." Having read B's already-built server-side schema
(`apps/server/src/play/transport.ts:139-174`) before writing this client side,
I adopted B's shape exactly rather than diverging from it — it *is* the
brief's own suggestion, so there was no real disagreement to reconcile, only a
race on who typed it first. The client's `StopPreferenceSchema` in
`apps/ui/src/play/live/transport.ts` is byte-for-byte the same shape as the
server's mirror, the same discipline `FullControlSchema` already keeps between
the two files.

## Not verified

- **No re-send after a resync.** `sendStopPreference`'s `force` parameter
  exists so the settings panel can push a persisted preference into a
  *freshly joined* match (a new match's `StopPolicy` starts at
  `DEFAULT_STOP_POLICY` with no memory of an earlier match's preference). It
  does **not** re-fire on every `forge:resync` — only on the settings panel's
  own mount, once its persisted value has loaded. A player who changes the
  preference, loses the connection mid-match and resyncs keeps whatever the
  *server* still holds for that seat (unaffected by the resync either way,
  since `StopPolicy` lives on the `Match` object, not the socket) — so this
  gap only matters for a match that restarts server-side without the client
  remounting, which was not reachable to test end-to-end this wave (no jar
  harness scenario for it).
- **End-to-end wire proof.** No jar-gated test sends a real
  `forge:stop-preference` frame through a real socket to a real server and
  reads back `Match.stopPolicy(seat).stopOnTheirTurn`. `LiveBoard.test.ts`
  proves the CLIENT sends the right frame on the right event (a stub
  transport, asserting the exact payload); the SERVER side of the contract is
  lane B's own tests to prove, against B's own handler.
