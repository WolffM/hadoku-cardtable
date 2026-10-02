# The swallowed first OK press (wave 35 §S item 2)

Tracker's w34 re-verification: `scenario-ability-repeat.jvm.test.ts` failed 5
of 10 runs. The seat pressed OK once after casting Ponder under Full
Control, and the match stayed at "Stack: 1 to Resolve" with OK enabled; a
second press ~3 s later always worked. "Same shape as Q12's root cause" was
the only lead.

## Root cause — found by reading `InputPassPriority.java`, not by probing

`InputPassPriority.showMessage()` (`forge-gui/.../match/input/InputPassPriority.java`)
does not always show the ordinary "Priority: …" prompt. Before it does, it
checks two conditions and can show a **yield suggestion** instead:

```java
if (!isSuggestionDeclined(STACK_YIELD) && shouldShowStackYieldPrompt()) {
    // "You cannot respond to the stack. Yield until stack clears?"
    showYieldSuggestionPrompt(); return;
}
if (!isSuggestionDeclined(NO_ACTIONS) && shouldShowNoActionsPrompt()) {
    // "You have no available actions. Yield until your turn?"
    showYieldSuggestionPrompt(); return;
}
```

`shouldShowNoActionsPrompt()` fires exactly when the seat has priority, the
stack is empty (or non-empty for the stack-yield variant), and
`!checkHasAvailableActions()` — precisely Ponder's own stop-1-to-resolve
window under Full Control, where the seat genuinely has nothing else to do.
`showYieldSuggestionPrompt()` sends:

```java
showMessage(fullMessage);                              // NOT "Priority: …"
getController().getGui().updateButtons(getOwner(),
    loc.getMessage("lblAccept"), loc.getMessage("lblDecline"), true, true, true);
```

`lblAccept` = **"Accept"**, `lblDecline` = **"Decline"**
(`forge-gui/res/languages/en-US.properties:1723-1724`) — NOT "OK"/"End Turn".
But button 1 is still wired to the same `selectButtonOk` act Forge's
`InputPassPriority.onOk()` always answers:

```java
protected final void onOk() {
    if (pendingSuggestion != null) {
        ...                                   // accept/decline bookkeeping
        if (isAlreadyYielding()) { stop(); }
        else { showNormalPrompt(); }          // <-- does NOT call stop()
        return;
    }
    passPriority();                           // only reached with no pending suggestion
}
```

**This is the swallowed press.** A seat that presses "OK" — because in every
OTHER window OK means "pass priority" — spends that press on a question it
was never shown as a question: the suggestion is accepted (or, more often
here, its state is reconciled) and `showNormalPrompt()` reshows the REAL
"Priority: …" / "OK"/"End Turn" bar, without ever calling `stop()`. The
window looks identical — "Stack: 1 to Resolve", a live OK button — but the
first press did not pass priority at all. The second, genuine press (now
with `pendingSuggestion == null`) reaches `passPriority()` and works.

**Why `maybeAutoPass` doesn't already protect against this**: the
yield-suggestion's prompt text ("You have no available actions…") never
matches `auto.ts`'s `PRIORITY` regex (`^Priority: `), so `readPromptFacts`
already classifies that window `'other'` and `decideStop` refuses to press
anything there (`if (facts.window !== 'priority') return null;`). That is
correct for a window we cannot identify, but it means **no existing
mechanism ever even LOOKS at this specific button bar** — the bug is not a
misclassification, it is a button bar our own classification system was
never told about.

**Why this is not specific to Full Control**: Full Control merely forces the
window to need an EXPLICIT press (nothing auto-passes for that seat), which
is what makes the bug visible as "I pressed OK and nothing happened." Outside
Full Control, if `autoPassReason` ALSO declines to press here (it does — the
window is `'other'`), a real human player hits the identical trap. The
original report happened to be under Full Control because that is the
scenario the w34 re-verification ran.

## The fix — `Match.maybeDeclineYieldSuggestion` (`apps/server/src/play/match.ts`)

Decline the suggestion the instant it appears, unconditionally (not gated on
`s.fullControl`, unlike every other shortcut in this file): the moment an
`updateButtons` frame carries exactly `label1 === 'Accept'`,
`label2 === 'Decline'` (Forge's own literal, localized labels — the same
practice as `AUTO_PAY_LABEL`/`CALL_BACK_LABEL`, never a regex over prose),
the server presses "Decline" on the seat's behalf before the browser (or a
test) can ever read that bar. Forge's own `onCancel()` branch for a pending
suggestion calls `declineSuggestion()` then `showNormalPrompt()` — the SAME
re-show `onOk()`'s accept branch reaches — so nothing about the actual
decision changes; the seat lands directly on the real "Priority: …" window
with correctly-labelled buttons, and whatever press it makes there is a
genuine, un-swallowed pass.

This is deliberately unconditional of Full Control: declining preserves
exactly "ask me every time," which is full control's own stated default —
the one answer that would be wrong to send automatically is ACCEPT (it
silently hands Forge's own auto-yield feature control of the seat's future
priority windows), and this fix never sends that one.

## A second, independent bug: the TEST'S own land-click loop

The first full 20-run attempt (with only the server-side fix above) still
failed 2 of 9 runs before this was found — same symptom, no
`yield-suggestion-declined` log entry either time, so a DIFFERENT cause. A
diagnostic copy of the Ponder case with full frame + log dumping caught one:
after paying for Ponder, the match produced THREE separate `getAbilityToPlay`
asks (not the usual one-plus-its-known-Forge-side-duplicate) and landed on a
button bar reading **`[OK][Undo (1)]`** instead of `[OK][End Turn]` —
`InputPassPriority.showNormalPrompt()`'s OTHER branch
(`canUndoLastAction()`), meaning Forge considered an EXTRA action undoable.

Root cause: both land-payment loops in
`apps/server/src/play/scenario-ability-repeat.jvm.test.ts` re-evaluate
`find(c => c.land && !c.tapped)` and re-select on EVERY ~25ms poll tick while
the prompt matches "Pay Mana Cost", with no memory of which land was already
clicked. If this script's own local fold lags Forge's actual state by even
one tick — more likely now that lane F's land-tapping fix makes every
untapped land independently actionable at priority, adding wire traffic per
window — the script can click a SECOND, unneeded land, which Forge treats as
an extra, undoable action: a DIFFERENT button bar than the one the test's
single, already-spent OK press was aimed at. Same "script's own bug" shape
`docs/planning/wave34-evidence/g2-full-control-ponder.md` already warned
about for a different repro.

**Fixed** (this lane's own file, not F's `lands.jvm.test.ts`): both the Mana
Leak and Ponder cases now track a `Set<number>` of land ids already clicked
and skip any id already in that set — note a `Set`, not a single id, because
Mana Leak is `{1}{U}` (needs two DIFFERENT lands; capping at one click total,
tried first, under-paid it and made that case fail a different way by timing
out waiting for "Stack: 2 to Resolve"). A land, once clicked, is simply never
clicked again; a cost needing more than one land can still tap as many
different ones as it needs.

## Mutation count — both fixes validated against the real jar

`apps/server/src/play/scenario-ability-repeat.jvm.test.ts`'s Ponder case (a
single `s.ok(0)` press at "Stack: 1 to Resolve", no retry), 20 runs at a
time, one jar at a time under the heavy lock, lock released between runs:

- **Restored** (`match.ts`'s `maybeDeclineYieldSuggestion` wired in, test's
  land click idempotent): **20 of 20 PASS.**
- **Reverted** (`maybeDeclineYieldSuggestion`'s call site removed, land-click
  idempotency KEPT): **10 of 10 PASS.** This isolates the two fixes: the
  idempotent click alone already clears this specific scenario every time in
  this sample, so the dominant cause of THIS test's historical flakiness was
  the test's own re-click bug, not the Accept/Decline prompt. The
  Accept/Decline fix is still kept — it is a real, independently-confirmed
  Forge behaviour (found by reading `InputPassPriority.java`, not by
  probing) that can surface at ANY priority window with nothing to do, not
  only this one test's exact setup, and declining it is the conservative,
  full-control-consistent default either way (see above).

`match.ts` restored to the fixed state after the reverted run; confirmed by
`grep` (`maybeDeclineYieldSuggestion(s)` called from `onFrame`) and
`pnpm --filter @hadoku/server typecheck` (exit 0). All four affected unit
suites green afterward: `auto.test.ts` (164), `match.test.ts` (73),
`apps/ui/.../match.test.ts` (106), `socket.test.ts` (52) — 395 tests.

## Files

- `apps/server/src/play/match.ts` — `Match.maybeDeclineYieldSuggestion`,
  `YIELD_ACCEPT_LABEL`/`YIELD_DECLINE_LABEL`, wired into `onFrame`'s
  `updateButtons` handling.
- `apps/server/src/play/scenario-ability-repeat.jvm.test.ts` — both land-
  payment loops (Mana Leak, Ponder) made idempotent (`Set<number>` of
  already-clicked land ids).
- No scenario file changes — `scenarios/ponder.state` (existing) already
  reproduces the exact window.
