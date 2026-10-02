# §S item 2 (§E2) — Ponder resolves with no decision: the only silent
auto-answer in the whole chain is the SAME browser-side mechanism as §E1; the
reorder and shuffle decisions are real, un-auto-answered stops

**Claim the brief asked to settle**: something answers the look-at-three /
reorder / shuffle decisions; find what. A choice that changes the game state
is the player's; only a decision with exactly one legal answer may be
auto-answered. If the auto-answer is in the browser, hand it to G.

## What w33's e-findings.md already recorded (not re-tested)

`ponder.state` with no intervention at all: the stack goes from holding
Ponder to empty with no ask ever reaching the browser (repeated across six
runs). Full control made it WORSE (0/5 vs. an intermittent partial pass rate).
An explicit Cancel on the generic priority stop sometimes handed priority to
bob in a way auto-pass never does. Two hypotheses were left open: `auto.ts`'s
policy set extending further than "one legal reply", or the real ask racing
the test's own polling.

## What casting Ponder actually takes, traced against real Forge

Using `apps/server/src/play/scenario.ts`'s harness directly (`Match.fromClient`,
no browser, no socket), casting Ponder from `ponder.state` with NOTHING
auto-answered reproduces the exact same first symptom §E1 found: a single
`getAbilityToPlay` ask (one ability: Ponder's own) that never gets auto-answered
server-side (`onlyAnswer` has no case for it) and simply sits open — the "stack
stays empty" a bystander would observe here is just the UNCHANGED pre-cast
state, not a resolved spell.

Answering that ask with its own only ability does **not** reach payment —
it produces a **second, identical** `getAbilityToPlay` ask for the same host
card (confirmed via `bridge.stderr.txt`: two consecutive
`GameProtocolHandler: Received: GuiGameEvent N: getAbilityToPlay (0 args)`...
`getAbilityToPlay`... entries before `showPromptMessage`/`Pay Mana Cost` ever
appears). This two-round dance is Forge/bridge-level behaviour for any
single-ability hand-card cast over a non-empty-vs-empty-stack context; it is
not specific to Ponder (the same pattern reproduces for Mana Leak in
`s1-full-control.md`) and nothing in `match.ts`/`auto.ts` is in the call path
between the two rounds.

Answering BOTH rounds (plain `{kind:'spellAbility', id, label}` echoed back,
Forge's own shape) reaches `Pay Mana Cost: {U}`; `auto.ts`'s `decidePay`
auto-pays it (`unambiguousPayment: 'forgeAuto'`, logged `auto-paid`), both
seats auto-pass their own-spell priority (`passOwnSpell`, logged twice), and
Ponder lands on the stack — `Stack: 1 to Resolve`.

**Only then does Ponder's own resolution ask anything**, and it asks TWO
separate, genuine questions, neither auto-answered by the server:

1. **`order`** — *"Choose order of cards to put into the library"*, THREE
   `sourceChoices` (the revealed cards), `showRememberCheckbox: false`,
   `remainingObjectsMin/Max: 0`. Checked directly against `auto.ts`'s
   `onlyAnswer`: **returns `null`** — this does NOT match the Q8
   `orderSimultaneous` branch (that branch requires `showRememberCheckbox:
   true`, which this ask does not have; see `s3-q8.md` for the ask shape that
   DOES). This is a real, always-reaches-the-wire ask, confirmed reaching
   `s.sent` as a raw `ask` frame with no `ask-auto-answered` log entry, in
   both policies.
2. **`showPromptMessage`/`updateButtons`: *"Do you want to shuffle the
   library?"*** — a plain Yes/No confirm (button labels, not a `kind:'ask'`
   envelope). `auto.ts`'s `readPromptFacts` classifies it as `window: 'other'`
   (the message does not start with `Priority:`), and `decideStop` returns
   `null` for any window that is not `'priority'` — so this is never
   auto-passed either, under any policy. Confirmed: a harness given nothing
   but the two `getAbilityToPlay` replies and the order ask parks here
   indefinitely (30s+ observed, no further bridge output of any kind), because
   nothing — not the test, not `match.ts`, not `auto.ts` — presses its OK or
   Cancel.

## Conclusion

**The only silent, no-ask-reaches-the-browser mechanism anywhere in Ponder's
resolution is the identical one §E1 already names**: the two-round
`getAbilityToPlay` dance for the initial cast, invisible under full control
and silently chained by `apps/ui/src/play/prompts/rules.ts`'s `autoAnswer`
(browser-side) when full control is off. Downstream of that, Ponder's real
decisions — the reorder (`order`, three distinct cards, genuinely more than
one legal outcome) and the shuffle confirm — are correctly **never**
auto-answered server-side under either policy; they are real stops that need
a real click. This directly answers e-findings.md's open question: `auto.ts`'s
policy set does **not** extend to Ponder's reorder/shuffle choice (verified:
`onlyAnswer(orderAsk, DEFAULT_STOP_POLICY)` returns `null` for the actual ask
Forge sends here, because `showRememberCheckbox` is `false`).

This does not fully explain the ORIGINAL e2e observation (stack reaching fully
EMPTY within 15s with no `says()` ever reading the shuffle prompt's text) —
that would require the order ask AND the shuffle confirm both being answered
by something, and nothing server-side does either. The most likely remaining
explanation, consistent with everything measured here and with §E1: the
browser session in that original run never advanced past the FIRST,
invisible-under-full-control `getAbilityToPlay` ask either, and the "stack:
empty" reading was the unchanged pre-cast state, exactly as it is in this
lane's own from-nothing repro — not a sign that Ponder actually finished
resolving unattended. Confirming that needs a live browser (console + DOM),
which is G's half, not this lane's scenario harness.

**Handed to G** alongside `s1-full-control.md`: fixing §E1's browser-side gap
(so a full-control `getAbilityToPlay` ask actually renders a `live-prompt`)
is the one fix that would let a human player get through Ponder's cast at
all under full control; the `order` and shuffle stops downstream of it are
already correctly real stops and need no server-side change, only a human
(or e2e driver) that can see and answer them.

## For lane E: `e2e/w34.spec.ts`'s Ponder spec names the wrong wire method

`e2e/w34.spec.ts` ("§E2 — Ponder's look/reorder decision reaches the browser
as a real ask...") asserts `promptMethod(alice.page)` becomes
`'manipulateCardList'`. Traced to source: Ponder's card script
(`forge/forge-gui/res/cardsfolder/p/ponder.txt`) uses `SP$
RearrangeTopOfLibrary`, whose effect
(`RearrangeTopOfLibraryEffect.rearrangeTopOfLibrary`) calls
`activator.getController().orderMoveToZoneList(topCards, ZoneType.Library,
sa)`, and `PlayerControllerHuman.orderMoveToZoneList`'s `Library` case calls
`getGui().order(localizer.getMessage("lblChooseOrderCardsPutIntoLibrary"), …)`
— the **`order`** method, not `manipulateCardList`. This matches this lane's
own real-Forge capture exactly: `{"method":"order","title":"Choose order of
cards to put into the library", …}`. `manipulateCardList` is a different
`IGuiGame` method Forge uses elsewhere (library search/tutor effects), not
this one. `e2e/w34.spec.ts`'s assertion will fail against a real jar as
written; the fix is a one-line expected-value change in lane E's file, not a
rendering gap — `apps/ui/src/play/prompts/OrderPrompt.tsx` (G's file) already
renders `order` asks, which is what both Ponder's reorder and Q8's
simultaneous-trigger order use.

## Real-Forge verification trail (reproducible)

Driven by hand against `apps/server/src/play/scenario.ts`'s harness; no
`.jvm.test.ts` is added for this item specifically because there is no
server-side fix to pin — the two ask shapes above (`order` with
`showRememberCheckbox: false`, and the plain shuffle confirm) are exercised
incidentally by `scenario-order.jvm.test.ts`'s own harness functions and by
any future e2e spec G or E write against `ponder.state` once §E1 is fixed.
