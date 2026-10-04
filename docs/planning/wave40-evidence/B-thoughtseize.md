# B — Thoughtseize R4: diagnosed, NOT fixed (unlike auto-pass-land, a different mechanism)

**Status: root cause found and reproduced with evidence. The fix is designed but was NOT validated by
any passing run before this lane's time ran out, so it was reverted rather than shipped unverified.**
`finishMulligan` in `scenario.ts` is back to its pre-wave40 behaviour (only the dump-on-timeout context
from item 1 was kept — additive, already proven safe separately).

## Rate

- 10/10 clean, no load (`heavy`-locked, shared host contention only).
- 10/10 clean, bridge's `applyDelta` reorder REVERTED (mutation arm).
- 10/10 clean, bridge's `applyDelta` reorder RESTORED.
- **1/10 reproduced under `taskset -c 0`** (single-core pin, same method wave 37 used) — same order of
  magnitude as CI's 1 of 4 (37204094431).

So this flake needs real resource contention to show up locally; the shared host's own background load
was not enough across 20 tries, a single core was.

## What the dump shows

The `taskset -c 0` failure (`ts-c0-run3.log`) failed at **`castThoughtseize`'s first wait**
(`"seat 0's hand to reflect Thoughtseize"`, `scenario.ts:85` at the time), i.e. before Thoughtseize is
even cast — not at `"Thoughtseize targeted and paid for"`, the wait the pinned CI test name itself
times out on. Both waits are inside the same helper function `castThoughtseize` the two `it()` blocks
share, so a stall at either one surfaces as the SECOND `it()` (the pinned one) timing out if it runs
second and the JVM/port state from the first failure carries over — consistent with CI's report of a
stall specifically on `the land is never a legal choice…`.

The dump's `frames` (`seat-0-s-hand-to-reflect-thoughtseize-*.dump.json`) stop dead right after:

```
t=17576  s0 showPromptMessage "A, you have won the coin toss. Would you like to play or draw?"
t=17601  s0 updateButtons {Play/Draw enable1:false}
t=17661  s1 showPromptMessage "Waiting for A..."          buttons {OK enable1:false}
t=17878  s0 showPromptMessage "Waiting for B..."          buttons {OK enable1:false}
t=18007  s0 showPromptMessage "A, you are going first! Do you want to keep your hand?"
         buttons {Keep enable1:true, Mulligan enable1:true}
                                                            <- nothing else, ever, for the rest of the run
```

**`finishMulligan` had already returned** by the time `castThoughtseize`'s own wait started (the error
names ITS label, not `finishMulligan`'s) — yet seat 0's REAL keep-or-mulligan question is sitting there
fully enabled and unanswered in the very last frame. The only way that is possible: at some poll tick
*before* t=18007, both seats' LATEST message satisfied `finishMulligan`'s old exit test
(`msg !== '' && !isMulliganish(msg)`) — and the two `"Waiting for …"` lines at t=17661/t=17878 are
exactly that: neither starts with `Priority:` and neither matches `/keep your hand|play or draw/i`, so
the original code treated them as "done". `finishMulligan` returned, `keepHands()` was never called
again, and seat 0's real keep prompt — which hadn't even been sent yet at that tick — arrived into a
void with nobody left to press it.

## Fix attempt 1 — wrong, caught by mutation testing before shipping

Treating `/^Waiting for /` as mulligan-ish too (same text, same `isMulliganish` helper) seemed like the
direct fix. **Mutation-tested it immediately: 6/6 fresh `taskset -c 0` runs hung for the full 60 s test
timeout**, every time — strictly worse than the 1-in-10 baseline. Cause: `"Waiting for {name}..."` is
not exclusive to the coin-toss handoff — Forge sends the identical message any time one seat has
already passed priority and is waiting on the other, for the rest of an ordinary game (confirmed in
`auto-pass-land`'s own dump: `{'seat': 0, 't': 18052, 'message': 'Waiting for B...'}` during Declare
Blockers Step, nothing to do with mulligan). Classifying it as "still not done" made `finishMulligan`
hang on perfectly normal later gameplay too, not just the handoff it was meant to guard.

## Fix attempt 2 — designed, untested, left for the next pass

Stop classifying the CURRENT message at all. Track, per seat, whether `s.sent` has EVER recorded a
`showPromptMessage` starting with `Priority:` — the one unambiguous sign the mulligan sequence is
behind that seat, regardless of what it happens to be showing at this exact tick:

```ts
const reachedPriority = (seat: number): boolean =>
  s.sent.some(
    (x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage'
      && (x.envelope.frame as unknown as { message: string }).message.startsWith('Priority:'),
  );
await waitUntil(() => {
  s.keepHands();
  s.answerAsks();
  return [0, 1].every((seat) => reachedPriority(seat));
}, 'both seats to finish the coin toss and the keep-or-mulligan question', 90_000, s);
```

This compiles and lints clean. It was written, then this lane's clock ran out before a single
`taskset -c 0` validation batch could run against it (the previous batch, still testing fix attempt 1,
had to be killed mid-flight along with the JVMs and `heavy.lock` hold it left behind — see "left behind"
below). **Not shipped**: an unvalidated change to a function twelve other jvm test files share
(`grep -rl finishMulligan apps/server/src/play/*.jvm.test.ts`: `auto-pass-land`, `scenario-glen`,
`scenario-combat`, `scenario-blockers`, `two-mana-pass`, `scenario-start`, `scenario-ability-repeat`,
`scenario-order`, `scenario-priority`, `scenario-targets`, plus `cast-hidden` — lane A's new file) is a
worse risk than one more pinned flaky line. `finishMulligan` in `scenario.ts` as shipped by this lane is
byte-for-byte the pre-wave40 behaviour; only the dump-on-timeout `s` argument (item 1, validated
separately via `jvm.test.ts`/`mulligan.jvm.test.ts`/both `auto-pass-land` and `scenario-thoughtseize`
batches above) was kept.

## For whoever picks this up

1. Apply fix attempt 2 above to `finishMulligan` in `scenario.ts`.
2. `taskset -c 0`, serial, `scenario-thoughtseize.jvm.test.ts`, 10+ runs — the repro rate here was 1/10,
   so budget accordingly.
3. Also re-run `jvm.test.ts` and `mulligan.jvm.test.ts` (no-scenario proof) and at least one of the
   twelve other `finishMulligan` callers listed above, since this function is shared.
4. If clean, the `known_flaky` line for Thoughtseize R4 can come off:
   `R4: casting Thoughtseize, against real Forge the land is never a legal choice: picking the land is
   refused by Forge itself`.

## Left behind, cleaned up before handback

A `taskset -c 0` validation loop for fix attempt 1 was killed mid-run (it was already proven wrong) and
orphaned a `npm exec vitest`/`node`/`java` process tree plus three stray `PlayBridge.java` JVMs under
`$CARDTABLE_PLAY_WORK_DIR` (`m-8d50bb957953`, `m-ea6ce282af27`, `m-f0f3463f0e22`, `m-4b18848d3fbd`) that
were also holding `/tmp/claude-1000/heavy.lock` and blocking lane A's own queued run. All killed by PID;
lane A's command picked up the lock immediately after and was left running normally. No stray JVM or
lock holder from this lane remained at handback.
