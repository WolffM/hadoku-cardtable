# §D evidence — the waiting pop-out; one decision at a time (AE3, AE9)

Wave 62. Playtest 15, the operator:

- AE3: *"the 'Waiting for Hadoku to decide for Serum Visions…' text at the
  top is a bit easy to miss. can we instead move text like that to the
  'decision popout' area? similar to how it shows 'Waiting for
  {opponent}…' during the mulligan phase? i think that would be cleaner."*
- AE9: *"i cast 'condescend' which lets me scry as part of the resolution
  of the spell, but also asks the opponent about paying the cost. lets be
  careful and resolve these things one at at time, i dont think it should
  be showing simultaneously."*

## AE3 — one component, one testid

`LiveBoard.tsx`'s `WaitingPop({ sentence })` replaces two previously
separate shapes:

- the top-line `live__waiting` (`:2127–2133` in the wave file's own line
  numbers) — a `<p role="status">` out of flow over the board, with a
  breathing dot (`live.css`'s `.live__waiting`/`.live__waiting-dot`/
  `@keyframes live-waiting-breathe`). **Deleted outright**, element and
  CSS both.
- the pregame-only pop-up (`live-pregame-wait-host` wrapping
  `live-pregame-wait`, a `section.confirm[role=status]` in the
  `.live__prompt` decision slot).

Both are now the ONE `section.confirm[role=status]`, `data-testid`
`live-waiting-pop`, drawn in the `.live__prompt` slot whenever
`pregameWait` or `theirWaitingOn` is present. The sentence: pregame always
gets the plain `"Waiting for {name}…"` (Forge sends the losing/non-
deciding seat no wire text for that moment — `isWaitingForPregameDecision`'s
own note); the ordinary mid-game case gets the server's own fact through
`waitingSentence`'s unchanged verb table.

`live-pregame-wait` and `live-pregame-wait-host` are gone from the whole
tree; every e2e/unit read of them was renamed to `live-waiting-pop`
(`e2e/waiting.spec.ts`, `e2e/w60-waiting.spec.ts`, `e2e/w31.spec.ts`,
`LiveBoard.test.ts`'s T2/W1 blocks).

**For lane I**: `apps/ui/src/play/inspect/index.ts:410` reads
`doc.querySelector('.live__prompt:not(:has([data-testid="live-pregame-wait"]))')`
to find "the open prompt that asks something" excluding the pregame wait.
That line needs `live-pregame-wait` → `live-waiting-pop`, now covering
both the pregame AND mid-game shapes. `inspect/index.test.ts:247`'s own
fixture (`data-testid="live-pregame-wait-host"`/`"live-pregame-wait"`)
needs the same rename. Neither file is in this lane's row — not edited
here, only reported, per the wave file's own ordering note (D lands before
I; I rebases on D's land).

**Mutation**: reverting `LiveBoard.tsx` to the old shape fails 12 of the 27
T2/W1 tests in `LiveBoard.test.ts` (confirmed, reverted and restored).

## AE9 — measured against a real Forge jar, two ways

### 1. The server: `w62-condescend.jvm.test.ts`

New scenario `scenarios/w62-condescend.state`: alice (`human…` keys) holds
Condescend + 4 Islands; bob (`ai…` keys) holds Grizzly Bears + 3 Forests
(one spare, so his own "pay {X}" choice is affordable and real, not
skipped for lack of mana). Bob casts Grizzly Bears in his own Main Phase
1; alice responds with Condescend, X=1, targeting it (the only spell on
the stack).

**Both of the wave file's own guessed ask shapes are wrong, measured**:

- Bob's "pay {X} or be countered" is **not** a `confirm` ask (not a
  `kind: 'ask'` at all) — it is the ordinary mana-payment channel every
  cost uses (`showPromptMessage` + `updateButtons`, Auto/Cancel), and this
  harness's default auto-pay policy (`match.ts`'s `autoPayReason`) pays it
  instantly and invisibly whenever affordable — which it always is here
  (the spare Forest). **Full control** (`s.match.setFullControl`, the same
  escape hatch `scenario-w46-b-counterspell.jvm.test.ts` uses) is the one
  thing that turns it into a real, observable stop; the jvm test turns it
  on for BOTH seats (bob's own cost, and it also disables alice's
  single-legal-target auto-shortcut, so her own "Select target spell" ask
  has to be answered too — harmless, not what this item is about).
- Alice's Scry 2 is **not** `manipulateCardList` under this host's own
  `FORGE_PREFERENCES` (`UI_SELECT_FROM_CARD_DISPLAYS: 'false'`, `host.ts`):
  `PlayerControllerHuman.arrangeForScry` (two cards, that pref off) calls
  `getGui().many(…, min: -1, max: -1, …)` to pick which cards go to the
  bottom, and `AbstractGuiGame.many` with an unbounded `max` delegates
  straight to `order(…)`. The FIRST (and, in every run observed, only) ask
  Scry 2 raises on the wire is `order`.

**The measurement**: every ask/prompt frame is timestamped on arrival
(`scenario.ts`'s `Stamped.t`); bob's own payment window and alice's `order`
ask are each recorded, unresolved, the instant either is found in `s.sent`
— before the test has replied to anything new that tick. Run three times
against the real jar:

| run | bob's payment window | alice's `order` ask | gap | overlap at first sight |
| --- | --- | --- | --- | --- |
| 1 | 4947.1ms | 4976.6ms | 29.5ms | **false** |
| 2 | 5055.4ms | 5083.4ms | 28.0ms | **false** |
| 3 | 5179.0ms | 5209.4ms | 30.4ms | **false** |
| 4 (final) | 6511.7ms | 6544.1ms | 32.4ms | **false** |

Every run: alice's `order` ask never appears until this test has
explicitly declined bob's payment (`s.cancel(1)`) — Forge's own resolution
of Condescend blocks on bob's reply before it ever computes alice's scry.
**Conclusion: sequential, not concurrent.** `match.ts`'s `openAsk` needs no
cross-seat hold — there is nothing for it to hold back, so `match.ts` is
untouched this wave (`match.test.ts:445`, "a selection wins over a
concurrently open ask", stays as it was).

### 2. The client: `e2e/w62-condescend.spec.ts`

Two real browsers, the same scenario, driven through the real UI (full
control for bob only — alice's own single-legal-target shortcut stays on,
so there is no target picker to drive on her side). Polled every 50ms from
the moment Condescend starts resolving.

**First run (no client fix) found a real overlap** — not the one the wave
file guessed (bob's window and alice's scry open at once isn't possible,
per the jvm proof above), but a STALE-FACT one: on **alice's own single
page**, her waiting pop-out (naming bob, `live-waiting-pop`) and her own
scry sheet (`live-prompt[data-method="order"]`) were BOTH visible at
tick +152ms:

```
+3ms   bobPay=false aliceScry=false aliceWaiting=false
+57ms  bobPay=true  aliceScry=false aliceWaiting=true
+152ms bobPay=true  aliceScry=true  aliceWaiting=true   <- both on alice's own page
```

Diagnosis: `theirWaitingOn` (the OTHER seat's fact, driving the pop-out)
and this seat's OWN new ask arrive on separate wire frames; nothing in
`LiveBoard.tsx`'s render stopped a stale `waitingForOpponent` fact from
drawing the pop-out over this seat's OWN brand-new decision. This is
exactly the "closed ask's sheet must leave before the next is drawn"
alternative the wave file names for the sequential case.

**The fix (client-side, `LiveBoard.tsx` only)**: a new `myOwnDecisionOpen`
flag (`askOpen || paying || playOrDraw || confirmPrompt || selectionPopup
|| decision`) gates the pop-out: `waitingForOpponent && !myOwnDecisionOpen`.
It is never coherent to tell the viewer to wait for the other seat while
this seat has ITS OWN live decision open, stale fact or not — this holds
regardless of wire timing, so it needs no server change either.
`pregameWait` is deliberately not in `myOwnDecisionOpen`'s list: it is a
degenerate case of `waitingForOpponent` itself, not a competing decision
of the viewer's own.

After the fix, re-run three times, no overlap on either axis (the
cross-seat one, checked with a `bobPending` guard so bob's own post-click
round-trip lag — an ordinary network latency artifact, not a decisions-at-
once bug — is never counted against the rule; and the same-page one):

```
run 1: 1 passed (12.9s)
run 2: 1 passed (12.5s)
run 3: 1 passed (11.9s)
```

**Mutation**: reverting the `!myOwnDecisionOpen` guard (`LiveBoard.tsx`)
reproduces the exact same-page overlap (`aliceWaiting && aliceScry` both
true at +174ms) and fails `e2e/w62-condescend.spec.ts`'s own assertion for
it, while leaving the cross-seat assertion green — confirming that
assertion is pinned on the right thing and the fix is the right scope.
`LiveBoard.test.ts` also gained a dedicated unit pin for the same rule
("never draws over the viewer's OWN open ask, even with a stale
theirWaitingOn fact (AE9)"), mutation-confirmed the same way.

## Decision taken

- **AE3**: shipped as specified (one component, one testid, old shape
  deleted).
- **AE9**: the wave file's own conditional branch resolved to "Forge asks
  in sequence" — `match.ts` is untouched; the fix is client-side only,
  and it is NOT the exact "a closed ask's sheet must leave before the next
  is drawn" framing (nothing needed "closing" — the two ask TYPES never
  coexist on the wire at all) but its spirit: the viewer's own live
  decision always wins over a stale fact about the other seat.
