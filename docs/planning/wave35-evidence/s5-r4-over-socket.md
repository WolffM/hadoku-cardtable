# Wave 35 §S follow-up, item 2 — R4 over the real socket path

## The finding reported (lane E)

Casting Thoughtseize through the browser against `scenarios/thoughtseize.state`,
the caster's page received `notify:setSelectables`, never
`chooseSingleEntityForEffect` — implying the fold built in `match.ts` never
fires over the real socket path, only over the bare `Match.fromClient` harness
`scenario-thoughtseize.jvm.test.ts` uses.

## What this file reproduces

New: `socket-thoughtseize.jvm.test.ts` — a real `express` + `socket.io` server
via `attachPlay` (the exact function `index.ts` wires in production), a real
`jvmHostFactory` host (not the replayed-fixture host `socket.test.ts` uses),
two real `socket.io-client` peers, and `POST /api/play/matches` with
`scenario: scenarioText('thoughtseize')` (the probe-only scenario hatch,
`parseStartBody`). The peers drive the match themselves: mulligan, casting,
targeting, payment — exactly what a browser's own click handlers would send,
reconstructed from the wire frames each peer actually receives.

## Result: the fold DOES hold over the real socket path

Once driven correctly, the caster receives **exactly one**
`chooseSingleEntityForEffect` ask — the same merged shape the raw-Match test
found: `optionList` is the two nonland cards, `delayedReveal` carries the
whole hand (all three cards) owned by the discarder, no raw `getChoices` ever
reaches the caster, and **the discarder receives no ask at all** (the trailing
reveal is dropped unconditionally, per the operator's ruling). Confirmed 4/4
clean runs.

So the specific claim *"the caster's page receives `setSelectables`, never
`chooseSingleEntityForEffect`"* is not reproducible at the wire level through
this path — the ask genuinely is `chooseSingleEntityForEffect` once the match
reaches the discard choice.

## What "driving correctly" turned out to require — and the real bug it surfaced

Getting the match to that point over the real socket needed three answers a
browser's own UI sends automatically, none of which my first attempt sent:

1. **Targeting** (Thoughtseize's `ValidTgts$ Player`) — a `selectPlayer` act
   at the opponent once the prompt reads "Select target player".
2. **Payment** — Forge's own Auto button (one unambiguous `{1}{B}` off two
   lands), not a manual land click.
3. **`openZones`** (`tempShowZones`'s own ask, fired by the targeting input's
   constructor) — and this is where a real, if currently inert, bug was
   found: `OpenZonesReplySchema` is `PlayerZoneUpdatesSchema`, an **array**.
   `scenario.ts`'s own `answerAsks()` helper replied `true` for it — accepted
   without complaint by the raw `Match.fromClient` harness (which calls
   `match.fromClient` directly, bypassing `transport.ts`'s
   `parseClientEnvelope`/`safeParseClientFrame` reply-shape check entirely)
   but **silently rejected** (`c2s-malformed`, logged and dropped) by the real
   socket route — which hangs the match forever: Forge's thread sits on that
   ask and nothing ever answers it again. My first attempt at this test hit
   exactly that hang (60 s timeout, stuck one frame past `ASK openZones`,
   confirmed via the server's own `c2s-malformed` log once I stopped
   discarding `PlayDeps.log`).

   Fixed in `scenario.ts`: `openZones` now replies `[]`. Confirmed no
   regression: `scenario-thoughtseize.jvm.test.ts` (2/2) and
   `scenario-glen.jvm.test.ts` (1/1) both still pass against the real jar
   with this change — `[]` is simply the *correct* answer, and the raw
   harness tolerated the wrong one by accident.

   This bug is almost certainly **inert in production** — `apps/ui` has its
   own typed handling for `openZones` (`apps/ui/src/play/prompts/ZonePrompts.tsx`),
   not a hand-written test stub — but it was a live landmine for any FUTURE
   socket-level test built on `scenario.ts`'s helper, and is now fixed.

## What lane E's `setSelectables` sighting most likely was

Not reproduced here, and not this lane's file to chase further: casting
Thoughtseize's own TARGETING step (choosing the opponent) is itself a
player-target selection, and — unlike this test, which answers it with a
direct `selectPlayer` act the moment the prompt says "Select target player" —
a real browser's click-to-target flow for an `Any`/`Player` target plausibly
renders via the UI's own selectable/highlight affordance before that act is
ever sent. In this reproduction, once `selectPlayer` fires, the very next
caster frames are two `setHighlighted` notifications, not `setSelectables` —
so the targeting step in THIS run never produced a `setSelectables` frame
either, but it is the step immediately before the ask lane E says never
arrived, and the one most likely to be what an e2e capture actually caught —
either a targeting-affordance frame mislabelled in the evidence note, or a
genuine client-side rendering question for whoever owns `apps/ui`'s targeting
UI (not `apps/server/src/play/**`, outside this lane's files). The R4 fold
itself, at the wire level the server controls, is confirmed working.

## Counts

- Real Forge, real socket, real jar: 4/4 clean passes of
  `socket-thoughtseize.jvm.test.ts`'s full assertion set (merged ask shape,
  no raw `getChoices` to the caster, zero asks to the discarder).
- `scenario.ts`'s `openZones` fix: no regression — `scenario-thoughtseize.jvm.test.ts`
  2/2 and `scenario-glen.jvm.test.ts` 1/1 still pass.

## `pnpm --filter @hadoku/server typecheck` / `eslint`

Both clean.
