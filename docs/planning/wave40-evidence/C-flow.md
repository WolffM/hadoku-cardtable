# C — `flow.jvm.test.ts`: 3 serial runs, plus the mutation checks

Env: `heavy` lock, `apps/ui`, `CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w40-C/work`,
`npx vitest run src/play/live/flow.jvm.test.ts --fileParallelism=false`. All runs below
are the full file (7 tests), not `-t` filtered, except where noted.

## 3 serial runs of the fixed file — 7/7 every time

| run | duration | result |
| --- | --- | --- |
| 1 | 31.49s | 7 passed |
| 2 | 33.02s | 7 passed |
| 3 | 60.79s | 7 passed |

Every test in the file, every run:

- `a card with one ability asks nothing — the offer arrives and is answered without a prompt`
- `a one-land Preordain reaches the stack with no prompt drawn at all`
- `a creature with no responses resolves with ZERO clicks from either player`
- `a turn never advances past a main phase unattended`
- `full control restores the stop the one-ability shortcut removed`
- `Forge's own re-ask of the one ability is answered server-side: one click, one ask, the player sees neither` (the rewritten test)
- `a refused click is rare, and never the last word`

## Mutation A — restore the retired assertion (`repeatedOffers.length > 0`)

First attempt hit an unrelated `beforeAll` flake (the scenario's own cast refused reaching
the stack on turn 2 — the same first-cast-after-start shape lane B is chasing elsewhere,
nothing to do with this assertion) — all 7 tests reported skipped because setup itself
threw. Retried once, clean setup:

With `expect(record.repeatedOffers.length, ...).toBeGreaterThan(0)` restored in place of
`expect(record.repeatedOffers).toEqual([])`: **6 passed, 1 failed** —

```
AssertionError: []: expected 0 to be greater than 0
```

`record.repeatedOffers` is empty every run now (the repeat never reaches the client), so
the old premise fails exactly as the brief says it should. The other 6 tests in the file
pass unaffected. Restored to `toEqual([])`; diff against the pre-mutation file is clean.

## Mutation B — break the real claim (`why` string that never occurs)

With the `ask-auto-answered` filter's `why` changed to `'MUTATION: this string never
occurs'`: **6 passed, 1 failed** —

```
AssertionError: [... full server log ...]: expected 0 to be greater than 0
```

The dumped log (`JSON.stringify(record.log)` on failure) shows the real event was there
all along:

```
{"evt":"ask-auto-answered","matchId":"m-b03963169939","seat":0,"callId":"s0-3",
 "method":"getAbilityToPlay","why":"forge re-asked its own already-answered getAbilityToPlay"}
```

So the mutation fails for the right reason (the bogus string matches nothing), and the
log line it's supposed to find is genuinely there. Restored the real `why` string;
diff against the pre-mutation file is clean.

## Final confirmation after restoring

One more full run after restoring: **7 passed** (49.12s). File is byte-identical to
before the mutation passes (`diff` clean against the backup taken before mutation A).

## Conclusion

The rewritten test is correct and stable: 3/3 clean serial passes, fails the right way
under both mutations (the retired premise, and a broken version of the new one), passes
again once restored. The CI `known_failing` line for this suite's old full test name
(`wave 20 lane B: turns that flow, against a real Forge match Forge offers the same one
ability twice for one click, and the player sees neither`) can be removed — that exact
`fullName` no longer exists in the report (the `it` was renamed as part of the fix), and
its replacement passes.
