# §G item 2 — §E1/§E2, handed over from S: diagnosed to a one-line fix outside this lane's files

**Claim the brief asked to settle**: find why, with Full Control on, the click on
your own instant does not produce Pay Mana Cost / a rendered prompt (§E1), and why
Ponder's decisions never reach a click (§E2); fix it in `prompts/**`,
`live/gestures/**`, `inspect/**`, or stop and report if the fix needs
`LiveBoard.tsx`.

**Result: no bug in any file this lane owns. The render/answer pipeline
(`LiveBoard.tsx`'s `ask`/`LivePrompt` wiring → `prompts/index.ts` →
`ChoicePrompts.tsx`'s `GetAbilityToPlayPrompt`) renders and answers every ask
Forge sends, correctly, every time, confirmed against a real match with real
React — including every repeat. The actual mechanism is `LiveBoard.tsx:1021`,
one line, not mine to edit; the exact change is below for the manager to land or
reject.**

## Method — a real jvm + real `LiveBoard`, not just the wire-level `Scenario` harness

S's evidence (`s1-full-control.md`, `s2-ponder.md`) traced the wire with
`apps/server/src/play/scenario.ts`'s harness (`Match.fromClient` directly, no
React) and correctly identified `LiveBoard.tsx:1021` as the only place
`match.fullControl` changes anything, but could not say whether the ask actually
*renders* without a live browser. This lane built that: `apps/ui/src/play/live/
jvm-harness.ts`'s `startLiveMatch` (a real child Forge JVM) plus two real,
mounted `<LiveBoard>` trees (`@testing-library/react`'s `render`, the same
mechanism `board-play.jvm.test.ts`/`search.jvm.test.ts` already use), driven by
real DOM clicks on the real card buttons Forge's `setWeaklySelectable` offers
— not a synthetic ask object, not `answerOpenPrompt`'s auto-driver. `setFullControl`
(`../live/match.ts`, read-only import) is the exact client call the settings
panel's own button makes. Two scenarios, both already committed:
`scenarios/lone-spell.state` (§E1) and `scenarios/ponder.state` (§E2). Not
committed as a test (see "What this lane did NOT add" below) — this was a
one-off repro, run several times by hand to separate the real behaviour from an
artifact of the repro script itself (see the false start below).

## §E1 — Mana Leak over Memnite, Full Control on

Bob casts Memnite (clicked, as a real player would). Alice is given priority
with `Stack: 1 to Resolve.`. `setFullControl(alice.live, true)` is called (the
exact client call the settings toggle makes). Alice clicks Mana Leak.

**First finding (a false start, written down because it cost real time and is
worth not repeating): a repro script that clicks the ability ONE time
reproduces "nothing happens" perfectly** — but that is the SCRIPT's bug, not
the product's. `LiveBoard.tsx`'s own two-round `getAbilityToPlay` dance (S
already found this at the wire level: Forge/the bridge re-asks the identical
one-ability offer a second time before payment, for ANY single-ability cast,
full control or not) means a single click answers round 1 and a **second,
live-prompt, identical-looking, genuinely new `ask.callId`** appears and sits
open. A script (or a person) that stops after one click sees exactly the
reported symptom: no Pay Mana Cost, stack unchanged, nothing visibly different.

**Clicking the SAME ability a second time** (on the second render, a real
`live-prompt` with its own fresh `callId` — confirmed in the DOM) answers it
and the match proceeds. Full writeup of this exact shape is §E2's below,
where it was chased all the way through because Ponder's downstream asks give
a clear "did it actually work" signal.

## §E2 — Ponder, Full Control on, chased to the end

Alice holds Ponder and 3 Islands, Full Control on. Clicking Ponder:

| round | what happened | render |
| --- | --- | --- |
| 1 | `getAbilityToPlay`, one ability ("Ponder: Look at the top three…") | renders correctly, clicked, answered `{ok:true}` |
| 2 | **Identical** `getAbilityToPlay` ask, fresh `callId` | renders correctly, clicked, answered `{ok:true}` |
| 3 | **A THIRD, identical** `getAbilityToPlay` ask — arrived **not immediately**, but measurably later (the gap spanned the time this repro spent attempting to pay mana by clicking a land — call it several seconds; the original report's own words, *"a generic getAbilityToPlay ask surfaces ~15s later on its own schedule,"* describe exactly this) | **renders correctly** (`data-method="getAbilityToPlay"` on the live `live-prompt` div, confirmed for 15 straight seconds of polling) — just never clicked again by this repro, which had stopped expecting more rounds |

Three separate runs were needed to pin this down (the number and timing of
rounds is not perfectly deterministic — two rounds were seen reliably, a third
appeared in two of three runs, at a visibly irregular delay). **In every run,
every round that appeared rendered as a real `live-prompt` with the correct
method and a clickable ability button.** The render layer never once failed,
dropped a frame, or showed a stale/wrong ask.

Clicking a land to pay `{U}` while a `getAbilityToPlay` ask is open does
nothing (correctly — `boardInteraction`/`payingMana` both gate on `askOpen`,
and an ask that is not a land-selection ask should not accept one); this
repro's land click was not what produced round 3. `PaymentWindow`
(`LiveBoard.tsx`, not this lane's) is never reached because an ask is always
open by the time this repro got far enough to try.

## Root cause

**Forge/the bridge re-issues `getAbilityToPlay`, for the identical single
ability, on its own schedule — more than twice, at irregular delays — for a
cast that needs a mana payment afterward.** This is bridge/Forge-level
behaviour (S already ruled out `match.ts` and `auto.ts` being in the call path
between rounds; this lane's own trace adds that it is not bounded at two, and
the third round's delay is NOT click-driven). No lane may install a jar
change; this is `docs/FORGE_ANALYSIS.md`/operator territory if it is to be
fixed at the source.

**Why it is invisible without Full Control, and why `LiveBoard.tsx:1021` is
the one place to fix it:**

```ts
// apps/ui/src/play/live/LiveBoard.tsx:1021
const auto = pending === null || match.fullControl || spectator ? null : autoAnswer(pending);
```

`rules.ts`'s `autoAnswer` (this lane's file, unit-tested, unchanged) already
encodes the brief's own rule exactly: a `getAbilityToPlay` with **exactly one**
ability is answered (it is not a choice — there is no alternative to decide
between); two or more abilities are left alone (a real choice). With full
control OFF, every one of Forge's repeat rounds is silently answered the
instant it arrives, so a player never sees the dance at all — which is why
"with Full Control off the same click casts" (the original report's own
words). With full control ON, `match.fullControl` forces `auto` to `null`
**unconditionally**, including for this exact single-ability, no-alternative
case — so a human (or an e2e driver) must click through however many
identical-looking repeats Forge decides to send, with no signal that a NEW,
real `ask.callId` is waiting under the same words, and no way to know when
Forge will stop. That is indistinguishable, to a player, from "the game
swallowed my click."

## What would fix it, and why this lane is not the one to land it

```diff
- const auto = pending === null || match.fullControl || spectator ? null : autoAnswer(pending);
+ const auto = pending === null || spectator ? null : autoAnswer(pending);
```

One line, in `LiveBoard.tsx` — owned by nobody, not this lane. Dropping
`match.fullControl ||` lets the EXISTING, already-correct `autoAnswer` keep
silently clearing a single-ability `getAbilityToPlay` (and the single
obvious-stack-target `getChoices`, Q7) regardless of full control, because
neither is a "choice that changes game state" by the brief's own rule — full
control's job (stopping on every REAL decision: Ponder's reorder, the shuffle
confirm, a multi-ability menu, a real mana-payment choice) is untouched by
this change, since `autoAnswer` returns `null` for all of those exactly as it
does today. This removes the repeated-click burden at its root, for both §E1
and §E2, without a Forge/bridge change.

**The alternative reading** — that full control's stated purpose, *"the
escape hatch for every stop the defaults skip"* (this wave's own framing),
means it should show EVEN a no-alternative ask, on principle — is why this
lane is reporting rather than landing the diff. Both readings are defensible;
the brief's literal rule text ("only a decision with exactly one legal answer
may be auto-answered") reads as unconditional to this lane, but the change
touches a file no lane owns and changes full control's behaviour for every
future single-ability ask, not only these two scenarios, so it is the
manager's call.

## What this lane did NOT add

No `.jvm.test.ts` lands from this item: the fix (if taken) lives in
`LiveBoard.tsx`, not in any file this lane owns, so there is nothing here to
pin with a mutation-tested unit test — the same position S recorded in
`s1-full-control.md`/`s2-ponder.md`. The two throwaway repro scripts used
above (`zzdiag-g2.jvm.test.ts`, `zzdiag-g3.jvm.test.ts`) were deleted before
this report was written; if the manager wants the repro re-run, the recipe
above (scenario file, `startLiveMatch`, two mounted `<LiveBoard>`s,
`setFullControl`, click, click again) reproduces it in under a minute per run.

## For lane E (passed through from `s2-ponder.md`, confirmed independently)

`e2e/w34.spec.ts`'s Ponder spec expects `promptMethod(alice.page)` to become
`'manipulateCardList'`; `s2-ponder.md` traced the real ask to `'order'` against
the raw wire (`PlayerControllerHuman.orderMoveToZoneList`'s `Library` case
calls `getGui().order(...)`). This lane's own repro never reached that ask (it
stalled on the repeated `getAbilityToPlay` rounds above, which is the item this
lane was asked to chase) so it does not add a second, independent confirmation
of the method name — but `PROMPT_COMPONENTS['order']` (`apps/ui/src/play/
prompts/index.ts`) is `OrderPrompt.tsx`, this lane's own file, and it is
already exercised and unit-tested (`order.test.ts`) against that exact method,
so no rendering gap exists on this lane's side regardless. One-line
expected-value fix in lane E's file.
