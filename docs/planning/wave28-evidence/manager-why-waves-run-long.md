# To the planner: why these waves keep taking an hour and a half

Written by wave 28's manager, from wave 28's own clock, at the operator's
request: *"this process is way too slow… i've had that issue several times
already."*

**The tests are not the problem.** That is the first thing to fix, because it is
where the instinct goes and it is the wrong lever.

## 1. What the time is actually spent on

Every number below is measured, not estimated.

| what | measured |
| --- | --- |
| `constructed.test.ts`, §C's whole suite | **2.5 s** |
| §D's six suites in one run | **2.7 s** |
| §B's three scoped suites | **3.3 s** |
| `auto.jvm.test.ts`, three real Forge matches | **44 s** |
| `e2e/play.spec.ts`, a real 40.8 s Forge match | **42.5 s** |
| full `pnpm check` (wave 27's measurement) | **~32 s** |

Against sub-agent wall clock:

| lane | wall clock | brief |
| --- | --- | --- |
| §C | 27 min | 36 lines |
| §D | 28 min | 28 lines |
| §B | 45 min to commit, 62 min including resumes | 33 lines |
| §A | **42 min**, and it started at minute 55 | **121 lines** |

Total test execution across the whole wave is on the order of **10–20 minutes**.
Everything else — roughly **80%** — is agents reading, reasoning and editing.
Halving test time would save a rounding error. This is not a CI problem and it
is not a Forge problem.

## 2. The real cause: the biggest lane starts last

Wave 28's clock:

```
21:27  worktree ready, wave file committed
21:31  operator amends the wave file — adds item 15 to the LARGEST lane
21:36  §B, §C, §D dispatched
22:05  §C commits          (minute 29)
22:06  §D commits          (minute 30)
22:21  §B commits          (minute 45)
22:27  manager: §C's e2e recipe taken up in the two unowned specs
22:31  §A dispatched       (minute 55)
23:13  §A commits          (minute 97)  — 42 min of work, begun at minute 55
23:22  manager: table-fit re-aimed      (minute 106)
       + §A sent back for a flaky jvm suite — still open
```

**The arithmetic that matters: §A took 42 minutes and started at minute 55.**
Dispatched at 21:36 beside the others it would have been committed by ~22:18 —
*before §B finished*. The wave would have cost roughly **55 minutes instead of
110+**, for exactly the same work and exactly the same verification.

§A carries **11 of the 15 items** (6, 7, 8, 9, 10, 11-render, 12-backs, 13, 14,
15, 4-avatar). Its brief is **121 lines against 33 / 36 / 28**. It is over half
the wave's work, and the wave file ordered it to start **after** two other lanes
finished.

So the critical path is `§B (45 min) → manager verification (~10 min) → §A
(42 min) → §A's flake round`, and the wave costs `55 min + §A`. Had §A been
dispatched at 21:36 beside the others, the wave would have cost
`max(§A, §B + verification)` — the same work, **half the wall clock**, with no
verification given up. This is measured, not modelled: §A's 42 minutes and §B's
45 are both on the clock above.

**The long pole must start first. Wave 28 started it last, on purpose, and that
single choice is most of the hour.**

## 3. The ordering constraints that caused it were over-broad and, in one case, wrong

The wave file gave two orderings. Both were applied to a whole **lane** when
they constrained only a small **task** inside it.

### 3a. "B before A" gated 100% of §A to protect ~10% of it

The stated reason: *"B's policy change alters what
`apps/ui/src/play/live/*.jvm.test.ts` observe, and those files are §A's. B
reports which of them moved; A re-aims them once, rather than A doing it
twice."*

That is a real dependency — and it touches **four jvm test files**. It does not
touch item 15's state layer, the stack, the seats, the graveyard, the prompts,
the card backs, the log's render half, the tokens, or the avatar's render half —
which is to say it does not touch **the other ninety percent of §A**. §A could
have built all of that from minute zero and picked up §B's findings at the end,
which is exactly where the jvm re-aim happens anyway.

**Rule for the next wave: order the TASK, not the LANE.** Write the dependency as
*"§A does its jvm re-aim after §B reports; everything else starts now"*, and
dispatch every lane at t=0.

### 3b. "D before A" bought nothing, because the dependency did not exist

The stated reason: *"D delivers `avatarId` to the client; A draws it. A written
against a guessed shape will not compile against D."*

It was not checked before it was written down. The manager traced it before
dispatch and §D confirmed it independently: **the avatar cannot reach §A's
surface at all.** `PlayerFace` draws a `BoardPlayer` built from Forge's
`PlayerView`; `MatchScreen.tsx` hands `LiveBoard` a `matchId` and a socket and
nothing else; `play/socket.ts:250` says its seat names *"are never an
identity"*. The remaining hop runs `routes.ts` (§D) → `play/socket.ts` (§B) →
`play/match.ts` (§B) → `adapter.ts` (§A), and **three of those four files were
not §A's**. §A can only build the render half against a field that nothing
populates.

So a serialization constraint was imposed to protect a hand-off that this wave
was never able to make. **A dependency asserted in a wave file is a claim; grep
it before you let it order the lanes.**

## 4. Lane sizing: the wave file knew, and said so, and did it anyway

> *"§A owns `apps/ui/src/play/` WHOLE — every subdirectory and every test in it.
> That is not generosity: `Board.tsx` is pinned by ten test files across four
> directories and `adapter.ts` by thirteen, so the play UI cannot be split
> across lanes without collisions."*

The file-ownership argument is **correct** — the manager re-verified it, and two
of those pins (`ManaPip.test.ts`, `art/ids.test.ts`) sit in directories no lane
owned. But the conclusion drawn from it is backwards:

> the play UI cannot be split across lanes **within one wave**

does not imply

> therefore put eleven items into it **in one wave**.

It implies the opposite. If a surface can only ever be one lane, then that
surface is the wave's fixed unit of concurrency, and the only way to keep the
wave short is to **put fewer items into it per wave**. Wave 28 put in nine, and
then the operator added a tenth and an eleventh mid-flight.

**Rule: when one lane cannot be split, cap its item count instead — and size the
wave to that lane, because it IS the wave.** Three items on the play surface per
wave, shipped weekly, costs less wall clock than eleven in one wave and carries
far less risk of a lane failing whole.

## 5. Mid-flight amendment lands on the critical path

`fa963e2` (21:31, four minutes after the worktree was ready) added **item 15 as
§A's headline** — replacing every card-state chip with a drawn state layer,
plus a harder screenshot requirement. It landed on the largest lane, which was
also the last to start and the one lane that could not absorb it in parallel.

This is the memory already recorded as *"a dispatched wave is not mine to
edit"*. It is worth restating with the cost attached: **an amendment to the
critical-path lane is not an edit, it is a re-plan.** Because §A had not yet
been dispatched, wave 28 absorbed it for free. Four minutes later it would have
cost a restart of the wave's biggest lane.

**Rule: amendments go to the next wave unless the target lane is unstarted — and
the manager, not the planner, is the one who can tell.**

## 6. Verification rigour needs a stated budget, not just a cap on flakes

§B's attribution work — re-running each moved suite **with its change reverted
in place**, to prove *it* caused the move rather than assuming — was the single
most valuable artifact of the wave. It is why §A's brief could say precisely
which suites moved, which was already red, and why. It also cost roughly
**15 minutes of pure JVM wall clock**, because `prompts.jvm.test.ts` has a 150 s
timeout and `flow.jvm.test.ts` times out too, and each was run twice.

The brief capped *flake reproduction* at 3 runs and said nothing about
*attribution* runs. That asymmetry is the bug.

**Rule: every instruction that says "prove it by re-running" carries its own run
budget in the same sentence.** `"attribute it with at most one reverted run per
suite"` would have bought the same artifact for half the clock.

## 7. Jar-gated suites are the only genuinely slow thing, and CI never runs them

§B found that `auto.jvm.test.ts` had been **red since `88ca6fb` (2026-09-27)**
and nobody knew, because CI runs no jar-gated vitest at all. So either CI runs
them, or a wave has to — and if a wave has to, **that cost belongs in the wave's
budget as an explicit line item**, not discovered by whichever lane happens to
touch them.

At ~44 s for the fast one and 150 s timeouts for the slow ones, a lane told to
run four jvm suites one-at-a-time under a shared lock is being given ten to
twenty minutes of unavoidable wall clock. That is fine — but it should be
*planned*, and it should not also be the lane carrying eleven items.

## 8. What to change, in priority order

1. **Dispatch every lane at t=0.** Ordering constraints gate a *task* inside a
   lane, never the lane's start. This alone is worth ~45 minutes on wave 28's
   shape.
2. **Grep every dependency before it orders anything.** "D before A" was
   spurious and cost real serialization.
3. **Cap the unsplittable lane's item count.** `apps/ui/src/play/` is one lane
   forever; that makes it the wave's clock. Three items, not eleven.
4. **Give every "prove it by re-running" instruction a run budget in the same
   sentence.**
5. **Budget jar-gated suites explicitly**, and do not put them on the lane that
   is already the largest.
6. **Amendments go to the next wave** unless the manager confirms the target
   lane is unstarted.

## 9. What was NOT the problem, so it does not get optimised by mistake

- **Test speed.** 10–20 minutes across the whole wave. Leave it alone.
- **Lock contention.** Wave 27 over-serialized by putting `pnpm check` behind
  the build lock; wave 28 used a separate `jvm.lock`, no lock on scoped suites,
  and one authoritative full check by the manager. That worked — zero queueing
  observed, and the three parallel lanes never blocked each other.
- **Sub-agent quality.** All four lanes produced work that survived independent
  re-verification, including two mutation counts reproduced exactly by the
  manager (§C 33/70 on revert, §B 13/138/151, §D 1/65). Nothing here argues for
  more supervision; the supervision worked.
- **The manager's own verification.** Re-running one claim per lane cost minutes,
  not tens of minutes, and caught a false premise in the wave file. Keep it.
