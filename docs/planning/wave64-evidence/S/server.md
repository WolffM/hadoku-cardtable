# §S — server policy, asks, the transport mirror

All of S1-S13 addressed below. `pnpm check`/whole-app vitest were NOT run from
this lane (hokon's load; per the manager's instruction mid-wave, proof runs on
a claw). Everything below is scoped to this lane's own files, run directly.

## S1/S8 — the match transport schemas live once

New `packages/shared/src/match-wire.ts` (365 lines) carries the nine schemas
the inventory named (`MATCH_EVENTS`, `WireCursorSchema`, `MatchRequestSchema`,
`ClientEnvelopeSchema`, `FullControlSchema`, `StopPreferenceSchema`,
`ServerEnvelopeSchema`, `MatchSnapshotSchema`, `MatchErrorSchema`) plus a
**tenth the inventory's count missed**: `AutoYieldSchema` was byte-identical
in both mirrors too (added after the inventory was taken, same fork commit as
the rest) — left duplicated would have been inconsistent with fixing the
other nine. `fullControlEcho`/`fullControlFrame` → one name, `fullControlFrame`.
The false "mirrors disagree" note on the UI's old `MatchErrorSchema` is gone
with the schema it was attached to.

**One real divergence found, resolved without breaking either side:**
`ServerEnvelopeSchema.frame` was eager (`ServerFrameSchema`) on the server and
`unknown` (checked second, to preserve the cursor on a bad frame) on the
client — not the identical duplicate the inventory assumed. Both server test
files (`match.test.ts`, `browser/*.test.ts`, `socket.test.ts`) call
`ServerEnvelopeSchema.parse`/`.safeParse` directly and need the eager shape;
the client's `parseServerEnvelope` needs the lenient one. Fix: the ONE shared
`ServerEnvelopeSchema` stays eager (the server's original, and both apps' test
suites' expectation); `parseServerEnvelope` derives its own lenient variant
via `.extend({ frame: z.unknown() })` rather than hand-duplicating a second
schema. No test anywhere needed to change for this.

Both apps' `transport.ts` are now thin re-exports — `apps/server/src/play/transport.ts`
328 → 48 lines of its own code (and no schema definitions at all);
`apps/ui/src/play/live/transport.ts` 419 → 90 (`SeatIdentitySchema`/
`MatchSeatsSchema`/`MatchRoleSchema`/`MatchAckSchema` stay there on purpose —
nothing server-side parses those, only the EVENT NAMES were ever duplicated,
and `MATCH_EVENTS` carries `seats`/`role` now too; `socket.ts`'s two bare
`'forge:seats'` strings were switched to `MATCH_EVENTS.seats`).

**Mutation (required by S8's own "Done when"):** new
`apps/ui/src/play/live/transport.test.ts` asserts, by REFERENCE equality (not
deep-equal — a structurally-identical second copy would pass a deep check),
that both apps' `transport.ts` export the exact same instance as
`@hadoku/shared` for all ten names. Mutated: reintroduced a locally-built
`FullControlSchema` (via the same `borrowed`-primitives device the original
duplication used) in the UI's `transport.ts` → **1 failing**. Reverted → **5
passing**.

New `packages/shared/src/match-wire.test.ts` (13 tests): every schema's
accept/reject boundary, both builders, and `parseServerEnvelope`'s documented
property (a bad frame's errors are all under `$.frame`, never `$`/`$.cursor`).

## S2 — `toYieldUpdates` deleted (dead code)

No caller existed (`PlayBridge.java` has no `sendYieldUpdate` act). Deleted
the function, `PlayerRef`/`YieldSeat`, and its own `describe` block in
`auto.test.ts` (88 lines of tests). The four header paragraphs that presented
it as live (`auto.ts`'s own module doc, the "Full control" section, "What the
next wave must add") rewritten to say plainly that no translation exists yet
and point at the mapping table on `StopPolicy`'s own fields instead.

## S1 (auto.ts half) — `ARENA_STOP_POLICY` deleted

It equalled `DEFAULT_STOP_POLICY` since wave 28; the exported constant is
gone, `NAMED_STOP_POLICIES`'s `'arena'` entry now points at
`DEFAULT_STOP_POLICY` directly. `auto.test.ts`: every `ARENA_STOP_POLICY`
reference re-aimed to `DEFAULT_STOP_POLICY` (47 call sites via a scripted,
paren-aware rewrite — verified by reading the diff, not by eyeballing a
regex), the now-tautological self-equality assertions removed.

## S3 — the env hatch narrowed to documented names

`CARDTABLE_PLAY_STOP_POLICY` answered to `everyPriority` and `fullControl`
with no documented reason an OPERATOR would reach for the environment
instead of the wire flag (`fullControl`) or a direct import (`everyPriority`,
pinned only by `apps/ui/src/play/live/*.jvm.test.ts`, never through this
hatch). Narrowed to `default`/`strictPayment`/`arena` — the three
`docs/.../scenarios/README.md`/wave-27-evidence actually name a reason for.
`EVERY_PRIORITY_POLICY`/`FULL_CONTROL_POLICY` themselves are UNTOUCHED exports
— deleting them would have broken `apps/server/src/play/auto.jvm.test.ts`,
`scenario-order.jvm.test.ts` and two UI jvm suites, none of which this lane
owns. **Known drift not fixed, out of lane:** `apps/server/src/play/README.md`
still lists "the four names are default, strictPayment, arena and
fullControl" — now stale (three names, and `fullControl` for a different
reason than the README implies). Not touched; not this lane's file.

## S4 — one `openAskFrame()` tail

`openAsk`, `openMergedChoice`, `openDisplayOnlyReveal` each ended in the same
five lines (register the timer, `s.asks.set`, `send`, `checkWaitingOn`).
Folded into `Match.openAskFrame(s, callId, method, frame)`. `checkWaitingOn`'s
own doc used to hand-list every ask-opening call site; now says there is one.

## S5 — one guard for the four auto-decision gates

`maybeAutoPass`, `maybeAutoPay`, `maybeCancelUnpayable`, `maybeConfirmChosenCost`
each repeated `if (s.fullControl || s.ai || this.status !== 'running') return`
and separately turned `notesOf(s)` into `PromptFacts` via `readPromptFacts` —
twice over, in `maybeAutoPay`'s case (once directly, once more inside the
`autoPayReason` wrapper it called). New `Match.autoGateFacts(s)` computes the
guard and the facts ONCE; the three one-line wrappers in `auto.ts`
(`autoPassReason`/`autoPayReason`/`autoCancelReason`) are deleted — the gates
call `decideStop`/`decidePay`/`decideCancel` directly on the shared result.
`auto.test.ts`'s ~47 direct calls to the deleted wrappers were rewritten to
`decideX(readPromptFacts(notes), policy)` (the same paren-aware script as S1).

## S6 — `onlyStackTarget` measured, KEPT (not redundant)

Against real Forge (`w49-a-counterspell-opponent.state`, Counterspell at a
real Memnite on the stack): the "Select target card" ask is `getChoices`,
`min: 0`, one `stackItem` choice — `onlyAnswer`'s own "one option, `min === 1`"
arm never fires on it (confirmed: `onlyAnswer(ask)` returns `null` on the real
frame). `rules.ts`'s `autoAnswer` (which reaches `onlyStackTarget`) answers it
anyway, with the one stack item's key. **This is not redundant with
`onlyAnswer` — it answers the ONE case `onlyAnswer` must leave, by design**
(answering a `min: 0` `getChoices` server-side would also answer an unrelated
optional "you may sacrifice a creature" question the same shape; the
client's rule is narrower — one `stackItem` option only). Proof:
`apps/server/src/play/yield.jvm.test.ts`'s new "S6" describe block, run
against the pinned jar (`702b207e`): **passed**, 5.3 s. `onlyStackTarget`
stays. (Placement note: no jvm test file was named for S6 in the manager's
grants; it landed in `yield.jvm.test.ts` since that is the one jvm file this
lane holds and S13 already established a precedent of adding a second
describe block there for a different sub-item.)

## S7 — `ended`/`finished` → one latch

`SeatState.ended`/`.finished` (two `ServerFrame | null` fields, same "set
once, resend after every snapshot" shape, different content: Forge's own
`finishGame` vs. the server's fabricated failure dialog) → one
`endNotices: { kind: 'finished' | 'ended'; frame }[]`. `resendAfterSnapshot`
sends `'finished'` before `'ended'` when both are present — the exact order
the two fields were always sent in, so no behaviour changed. A later
`finishGame` still replaces the earlier entry (Forge can call it more than
once); `ended` is still appended at most once per seat.

**Heads-up relayed by the coordinator, not yet landed as of this report:** a
tracker worker is adding `coinToss: { winner, at }` beside `waitingOn` on the
seats channel in `match.ts`. This fold (and `resendAfterSnapshot`'s own small
loop) are the obvious rebase point — both are self-contained, few-line hunks,
touching neither `seatIdentities()` nor the `coinToss` fields that change is
expected to add. Flagging for the manager's rebase, not blocking.

## S9 — `pace.ts` imports, one of two done

`WireType.Game`/`WireType.Player` now imported from `../wire.ts` (replacing
the two hardcoded bare numbers `3`/`1`) — done, typechecked, `pace.test.ts`
green (22/22, unchanged).

**`INPUT_FRAMES` from `match.ts`: BLOCKED, not done.** `match.ts`'s own
`INPUT_FRAMES` (line ~2499) is a bare, non-`export`ed module `const`, and
`match.ts` is lanes J's and T's this wave (their own regions), not this
lane's to edit even for one keyword. Reported per the manager's own
instruction ("if `INPUT_FRAMES` is not exported, report"). `pace.ts` keeps its
own `INPUT_NOTIFY_METHODS` copy, with a comment naming exactly what is needed
(`export` added to that one line) and by whom.

## S10 — the Preordain/Serum Visions scry, re-measured

Measured fresh against the pinned jar (`702b207e`), `scenarios/w62-scry.state`,
`UI_SELECT_FROM_CARD_DISPLAYS` flipped BOTH ways on the same scripted hand:

- **`'true'` (Forge's own default):** `manipulateCardList`, 6 cards (the
  scripted library), 2 `manipulable` — the exact bug #12 complains about,
  reproduced live.
- **`'false'` (this file's override, unchanged):** `order`, title "Select
  cards to be put on the bottom of your library", `sourceChoices` carrying
  only the 2 scried cards.

**The pref still changes something — kept at `'false'`.** `host.ts`'s own
comment was not wrong about the MECHANISM (true→manipulateCardList,
false→"the scried cards alone" — confirmed exactly), only missing the actual
ask NAME for the false branch (`order`), which is what let an earlier reading
assume `manipulateCardList` was still the live shape. Comment rewritten to
name `order` explicitly and cite this measurement.

(Both runs used a disposable, never-committed test file,
`apps/server/src/play/zzz-scratch-s10.test.ts`, deleted immediately after the
second measurement — `git status` confirms it was never tracked.)

## S11 — one timeout-dump function, both jvm harnesses

`apps/server/src/play/scenario.ts`: `dumpOnTimeout`'s body is now
`summarizeFrame` (exported, one frame → readable record) +
`dumpTimeoutReport` (exported, `{label, frames, decisions, stderrPath} → string`,
writes the JSON file and the stderr tail). `apps/ui/src/play/live/jvm-harness.ts`'s
`waitUntil` gained the same optional `dump` parameter `scenario.ts`'s own
`waitUntil` already had (backward compatible — the four unowned
`*.jvm.test.ts` files that import `waitUntil` with the old 3-arg call still
typecheck and run unchanged); `startLiveMatch`'s own internal boot-wait and
the returned `LiveHarness` (which gained a `workDir` field) both now dump on
timeout. Before this fold a UI-side jvm timeout had NOTHING to diagnose from
— no stderr, no frames — which is exactly what made `flow.jvm.test.ts`'s
three reds of 2026-10-08 unreadable.

Not run against a real jar (deferred to the claw per the load note) — this is
the one S-item without a jar-side pass locally; `tsc` is clean and the
mechanism is identical to `scenario.ts`'s own (already proven working while
measuring S10).

## S12 — AE16, the 4.7-5.0 s lag: found and fixed at the source

**Root cause (reasoned from the code, confirmed by a passing unit proof, not
yet confirmed on a live claw/e2e):** `pace.ts`'s leaky-bucket queue is FIFO
with no cap. An End Turn crawl through several non-stop phases enqueues each
phase's own delta — every auto-passed window still SENDS its prompt/buttons
before the server presses OK on it (`match.ts`'s `onFrame` forwards every
frame unconditionally) — and the INPUT-classed frame that finally matters
(the one with delay 0) only reaches the front of the queue once every item
ahead of it has served its OWN full delay. A burst of N items at up to 600 ms
each sums, not maxes — which is exactly "once per match, after a crawl,
several seconds late".

**Fix, in `pacedMatchTransport`:**
1. `pump()` now scans the queue for the first `'input'`-classed item and, if
   found, flushes everything up to and including it immediately (ordering is
   unaffected — nothing is ever reordered, only un-paced).
2. Pushing a NEW `'input'` payload while a different item's timer is still in
   flight cancels that timer outright (only one timer runs at a time, so a
   live one otherwise blocks `pump()` from even looking again until it
   fires) — this is what makes the fix hold for ANY burst depth, not just
   "one item's own delay".

**Proof:** `pace.test.ts` gained two tests. "a whole burst ahead of an input
frame does not sum into its wait" (resolve+phase+draw+ask, delivered in one
tick once the burst completes) and "an input frame arriving WHILE a burst
item is still timing cancels that wait outright" (same burst, input arrives
mid-flight). **Mutation: reverted both mechanisms → 2 failing / restored → 24
passing** (whole file). All 22 pre-existing tests unchanged.

**Not done, by design — not this lane's file:** the "flag moves within one
pacer tick after an End Turn" assertion belongs in `e2e/w63-flash.spec.ts`
(T's row). Proposed hunk, for the manager to place or reject:

```ts
// after an End Turn that crawls through several auto-passed phases, the
// opponent's priority flag must move within one pacer tick, not several
// seconds later (AE16, fixed at the source in pace.ts, wave 64 §S)
await page.click('[data-testid="end-turn"]');
const flaggedAt = Date.now();
await expect(opponentPage.locator('[data-priority-flag]')).toBeVisible({ timeout: 1_000 });
expect(Date.now() - flaggedAt).toBeLessThan(1_000);
```

T10's resolution ("decisions only": the pop-out never shows for a held
priority window) does not change this measurement — the ASSERTION is about
the priority FLAG (`adapter.ts`'s own fact, unaffected by T10), not the
"Waiting for…" pop-out (`waitingOn`, which T10 changed when it is drawn at
all). Noted so the manager does not read T10 as invalidating this.

## S13 — the precedence pin, against the jar

"Full control wins over auto-yield wins over the stop policy" was pinned only
with synthetic frames before this (`match.test.ts`'s `maybeAutoPass` cases).
S5's fold makes this ONE ordered check in code
(`Match.autoGateFacts`: `s.fullControl` is read before anything else, every
time). New test in `yield.jvm.test.ts`: the SAME seat, same turn, BOTH
`setAutoYield(true)` and `setFullControl(true)` — against a real Forge match,
bob's Bolt still reaches alice's own wire with a real bar, and no
`auto-passed` log line is written for her. **Passed against the jar**
(`702b207e`), 5.0 s; the pre-existing Auto Yield test alongside it also still
passes (6.2 s) — 3/3 in this file.

## knip, before/after (this lane's files only — see note)

Measured on `ddda60a` before any edit, and again just now; **both runs are
on a worktree another lane (J) edits in parallel**, so the absolute repo-wide
totals (309 → 311) are not a clean A/B for this lane alone — the per-file
breakdown below is.

| file | before | after |
| --- | --- | --- |
| `auto.ts`/`match.ts`/`host.ts`/`socket.ts` | 0 unused (no change) | 0 unused |
| `scenario.ts` | 4 (`strOf`, `Stamped`, `Buttons`, `Card`) | 4 (unchanged — pre-existing, not from this wave's edits) |
| `apps/server/transport.ts` | 0 (namespace-imported by three test files, so knip cannot see individual unused names either side) | 0 |
| `apps/ui/live/transport.ts` exports | 12 unused | 8 unused (`WireCursorSchema`/`SeatIdentitySchema`/`MatchSeatsSchema`/`MatchRoleSchema` now genuinely consumed) |
| `apps/ui/live/transport.ts` types | 2 unused (pre-existing: `MatchRequest`, `SeatIdentity`) | 2 (unchanged — the 4 new unused type re-exports this fold would have added — `FullControlRequest`/`AutoYieldRequest`/`StopPreferenceRequest`/`MatchError` — were removed once knip flagged them; nothing imports them by name) |
| `jvm-harness.ts` types | 3 unused (pre-existing) | 4 (adds `DumpSource`, the new dump-source interface — exported for its own documentation value; no consumer needs it by name yet) |
| `match-wire.ts` (new) | n/a | 1 unused (`WireCursor`, re-exported for API completeness since `index.ts` re-exports that type from `wire.ts` instead — a deliberate 1-line redundancy, not a drift) |

Net for this lane's files: **-4** stale exports fixed (the transport.ts
re-export cleanup), **+2** new, both deliberate and documented above, not
accidental duplication.

## Line counts

Tracked files: **+828 / -1012** (net **-184**). New files:
`packages/shared/src/match-wire.ts` (+365), `packages/shared/src/match-wire.test.ts`
(+146), `apps/ui/src/play/live/transport.test.ts` (+75) — net **+586**.
Lane total: **+402**. The growth is concentrated in two places the wave's own
rules ask for: new tests proving a deletion's mutation count (S8, S12 —
~260 lines), and the one shared module that now holds, once, what used to be
written twice (S1/S8) — not duplicated logic kept "for safety".

## Mutation counts, all required ones

| item | reverted | restored |
| --- | --- | --- |
| S8: schema re-export identity (`transport.test.ts`) | 1 failing | 5 passing |
| S12: burst-flush + timer-cancel (`pace.test.ts`) | 2 failing | 24 passing |
| S1/S5 (pre-existing `auto.test.ts`/`match.test.ts` suites, unaffected) | — | 185 / 118 passing throughout |

## What could NOT be verified from this lane

- S9's `INPUT_FRAMES` import (blocked on an `export` keyword in `match.ts`,
  owned by J/T this wave).
- S12's live magnitude (the 4.7–5.0 s number) on a real browser/claw — the
  mechanism is proven at the unit level; the e2e assertion is proposed above,
  not written (T's file).
- S11's dump path against a real jar (mechanism identical to `scenario.ts`'s,
  proven working during S10; not independently re-run under jvm-harness.ts
  itself to save JVM time, per the load note).
- Whole-suite `*.jvm.test.ts` on the push set, and `check` — deferred to a
  claw dispatch (requested below).

## Decisions made because the brief was ambiguous

- **S3**: kept `EVERY_PRIORITY_POLICY`/`FULL_CONTROL_POLICY` as exported
  constants (only narrowed the ENV-NAME map) rather than deleting them
  outright, because the literal reading ("FULL_CONTROL_POLICY deleted")
  would have broken two unowned jvm-test files and one unowned server jvm
  test that import the constants directly, never through the env hatch.
- **S6**: placed the jvm proof in `yield.jvm.test.ts` (no file was named for
  it in the manager's grants) since it is the one jvm file this lane holds.
- **S8**: added a 10th schema (`AutoYieldSchema`) beyond the inventory's
  named nine, and fixed a real (not cosmetic) divergence in
  `ServerEnvelopeSchema.frame` rather than treating it as "the same nine,
  byte for byte" — the inventory's own count was taken before four later
  fixes landed, and this lane re-read its base as instructed.

## Dispatch requested

- `only=jvm` — the full `*.jvm.test.ts` push set, to confirm S6, S11, S13 and
  that nothing else regressed (`auto.jvm.test.ts`, `scenario-order.jvm.test.ts`,
  the UI's `*.jvm.test.ts` files that import `EVERY_PRIORITY_POLICY`/
  `FULL_CONTROL_POLICY` or `jvm-harness.ts`).
- `check` — whole-workspace typecheck/lint/unit, since this lane touched
  `packages/shared` (a dependency of both apps) and added a new workspace
  dependency (`@hadoku/forge-wire` on `@hadoku/shared`).
