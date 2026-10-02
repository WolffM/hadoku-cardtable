# §S item 1 (§E1) — Full Control blocks your own response: the server and
bridge are not the cause; the ask reaches the wire identically either way

**Claim the brief asked to settle**: find where the click is lost when Full
Control is on and a seat tries to respond to an opponent's spell (the client's
offer, `match.ts`'s act path, the bridge, or Forge's `YieldController` with
`FULL_CONTROL_POLICY`); write a real-Forge test that reproduces it, then fix
the cause, or hand it to G with evidence if the cause is in the browser half.

## What w33's e-findings.md already ruled out (not re-tested)

Wrong card id, a click-timing race in the e2e test's own polling, host
contention, and toggle timing (before vs. after the cast is offered) — all
ruled out in `wave33-evidence/e-findings.md`. What it left open: whether the
cause is `match.ts`'s full-control wiring, `boardInteraction`'s
`weaklySelectable` union, or `PlayBridge.java`'s `setFullControl` handling not
re-pushing the actionable set. All three are now ruled out below.

## What a real Forge match actually does, traced end to end

A real-Forge jvm harness (`apps/server/src/play/scenario.ts`'s `startScenario`,
which calls `Match.fromClient` directly — the same path `socket.ts` calls from
a real socket, with no browser in between) against `lone-spell.state`: bob
(seat 1) casts Memnite, alice (seat 0) is given priority with Mana Leak
offered. Clicking Mana Leak (`selectCard`) sends `{kind:'act',
method:'selectCard', card:{id:81}}` to the server.

**With `Match.setFullControl(0, true)` called first**, the server forwards the
click to the bridge exactly as it does with it off, and Forge replies with a
single frame to seat 0:

```json
{"kind":"ask","callId":"s0-1","method":"getAbilityToPlay","hostCard":{"kind":"card","id":81},
 "abilities":[{"kind":"spellAbility","id":189,"label":"Counter target spell unless its controller pays {3}."}],
 "triggerEvent":null}
```

**With full control left off** (never toggled at all), the identical click, in
the identical scenario, produces the **exact same frame**, byte for byte
(down to `callId: "s0-1"`): same method, same one ability, same host card.
Nothing about the server's or the bridge's behaviour for this click differs
between the two runs — confirmed by running both side by side off the same
scenario and diffing `s.sent`.

**This ask is never auto-answered server-side, in either mode.** `auto.ts`'s
`onlyAnswer` does not have a case for `getAbilityToPlay` — by design, per the
file's own comment: *"A one-ability offer of it IS answered, but on the
BROWSER side, by `autoAnswer` in `apps/ui/src/play/prompts/rules.ts`."* So
`match.ts`'s `s.fullControl ? null : onlyAnswer(frame, s.policy)` returns
`null` either way for this method, and the ask is queued (`s.asks.set(...)`)
and forwarded to the client unchanged (`match.ts:964-1014`) regardless of
`fullControl`.

**Casting a single-ability hand card over a non-empty stack takes TWO rounds
of `getAbilityToPlay`, not one** — confirmed against `ponder.state` (same
mechanism, see `s2-ponder.md`): answering the first one-ability ask with its
own only ability produces a SECOND, identical `getAbilityToPlay` ask for the
same host card before the cast actually proceeds to payment. This is Forge's
own bridge-level behaviour (traced in `bridge.stderr.txt`'s
`GameProtocolHandler: Received: GuiGameEvent N: getAbilityToPlay` lines, two
in a row for one click), not anything `match.ts` or `auto.ts` does — neither
file is in the call path between the two rounds at all.

## The actual difference between "off" and "on": only in the browser

`apps/ui/src/play/live/LiveBoard.tsx:1021` (not lane S's file — "owned by
nobody" per the wave table):

```ts
const auto = pending === null || match.fullControl || spectator ? null : autoAnswer(pending);
```

`autoAnswer` (`apps/ui/src/play/prompts/rules.ts`) answers a one-ability
`getAbilityToPlay` ask automatically. With full control **off**, this fires on
EVERY new ask — including the second round — via a `useEffect` keyed on
`autoCallId`, so each of the two rounds is silently answered the instant it
arrives and the cast proceeds to payment and the stack without the player
ever seeing a prompt. That is why "with Full Control off the same click
casts" (instantly, per the original report).

With full control **on**, `auto` is forced to `null` and the ask should fall
through to the live-prompt render path (`ask = auto === null && !spectator ?
pending : null`, then `{ask !== null && (<div data-testid="live-prompt" ...
data-method={ask.method}>...`) — a `GetAbilityToPlayPrompt` component exists,
is registered in `apps/ui/src/play/prompts/index.ts`, and is unit-tested
(`choices.test.ts`). The ORIGINAL e2e report (`wave33-evidence/e-findings.md`
§E) is that no `live-prompt` ever appears for 15s, and a generic,
click-unrelated `getAbilityToPlay` ask surfaces on its own schedule after
that — i.e. the ask that the server/bridge DOES send, deterministically and
immediately, is never rendered to the player.

## Conclusion

**Not `match.ts`'s full-control wiring, not `boardInteraction`'s
`weaklySelectable` union, not `PlayBridge.java`'s `setFullControl` handling.**
All three were measured directly and are byte-identical between the two
modes. The one and only place `match.fullControl` changes behaviour anywhere
in this chain is `LiveBoard.tsx`'s own gate on calling `rules.ts`'s
`autoAnswer` — which is the intended behaviour (full control should NOT
auto-answer) — and the bug, if the original symptom is accurate, is
downstream of that gate, in how (or whether) the resulting `ask` actually
reaches a rendered `live-prompt` in a live browser session. That is the
browser half (`LiveBoard.tsx` / `apps/ui/src/play/prompts/**`), outside this
lane's owned files (`apps/server/src/play/**`, `apps/ui/src/play/live/
{match,match.test,transport,replay-server,game-driver,jvm-harness}.ts`).

**Handed to G** with this evidence. No server-side fix was made (there was
nothing server-side to fix); this item's mutation-test requirement does not
apply since no fix landed here.

## Real-Forge verification trail (reproducible)

```
CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
pnpm exec vitest run apps/server/src/play/scenario-priority.jvm.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
```

(Existing Q7 test, re-read for this investigation — still green, 2/2, and its
own `s.answerAsks()` driver is what silently clears the two-round
`getAbilityToPlay` dance the same way `LiveBoard.tsx`'s browser-side
`autoAnswer` does with full control off, which is what let it pass without
ever surfacing this gap.)
