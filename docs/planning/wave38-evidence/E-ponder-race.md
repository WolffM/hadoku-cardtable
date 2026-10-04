# E-ponder-race — §E2's probe answers an `order` ask that opened mid-wait (w38 §E item 1)

**Now true:** Ponder's own look/reorder decision reaches the browser as a real ask every time this
spec's probe checks for it — the probe no longer answers that ask itself before the assertion below
it ever gets to see it.

## The artifact

`gh run download 37170731156 -R WolffM/hadoku-cardtable -n forge-e2e-evidence-1`, stack `zml38G`.
`play-server-stack-zml38G.jsonl`:

```
{"evt":"ask-answered","matchId":"m-e684c6972e6e","seat":0,"callId":"s0-1","method":"getAbilityToPlay","ms":6}
{"evt":"ask-auto-answered","matchId":"m-e684c6972e6e","seat":0,"callId":"s0-2","method":"getAbilityToPlay","why":"forge re-asked its own already-answered getAbilityToPlay"}
{"evt":"ask-answered","matchId":"m-e684c6972e6e","seat":0,"callId":"s0-3","method":"order","ms":222}
```

`s0-3`'s `order` ask was answered by the **client** (`ask-answered`, not `ask-auto-answered`) 222ms
after being sent — inside `w34.spec.ts`'s own probe loop, which is exactly the bug: the loop checked
`promptMethod !== 'order'` **before** `waitForTimeout(50)`, then called `answerPrompt` unconditionally
after the wait with no second check — so an `order` ask that opened during that 50ms window was
answered by the probe itself, and the later `expect.poll(() => promptMethod(...)).toBe('order')`
this test actually wants to observe timed out, because the ask was already closed.

## Fix (`e2e/w34.spec.ts`, the §E2 test's probe loop)

Re-read `promptMethod` again, after the wait and before calling `answerPrompt`, and `break` without
answering when it now reads `'order'` — leaving the ask open for the `expect.poll` right after the
loop, which is what the test is actually checking.

## Mutation proof

Forced the ask to open inside the window deterministically: the wait widened from 50ms to 2000ms
(so the `order` ask reliably opens during it, rather than racing it under ambient load), with the
fix's re-check removed (reverted to the original blind-answer shape) — reverted after the run:

- **Reverted (buggy logic) + widened window: 1/1 FAILS.** Not the same surface error as CI (that
  one was the `expect.poll` after the loop timing out at 90s); here the loop itself never exits —
  every 2000ms cycle, the order ask opens, `answerPrompt` answers it blindly, `promptMethod` reads
  `null` again next check (ask already closed), so the loop's own `!== 'order'` condition never
  flips and it spins until the test's own 180s timeout kills it mid-`waitForTimeout`. Same
  mechanism, a louder failure.
- **Restored (fix) + normal 50ms window: 3/3 PASSES** (11.9s, 12.3s, 12.4s — real Forge, not a
  skip: `forge.ok` true, each run against a real JVM-backed stack).
