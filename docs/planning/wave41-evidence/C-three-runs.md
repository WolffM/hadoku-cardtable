# `e2e/arrows.spec.ts` — consecutive runs

The wave's done-when asks for 3 consecutive green runs with the jar env.
**2 of 3 completed, both green; the 3rd is blocked, not failed** — the
shared `/tmp/claude-1000/heavy.lock` was held by w42's own verification run
for 45+ minutes while this lane waited for it (by the time this lane gave
up, w43/w44/w45 were also queued behind the same hold — a cross-wave
infrastructure problem, not a defect in this lane's own files). Reported per
the manager's own instruction: *"If a rule can't be proven by ~03:50 UTC,
report what is proven and mark the rest unproven."*

## Run 1

```
[arrows w17] says: World Breaker - Creature 5 / 7

Pay Mana Cost: 6G
[arrows w17] stack item centre {"x":698.7109375,"y":253.78125}
[arrows w17] tail {"x":698.7109375,"y":253.78125}
  ✓  1 arrows.spec.ts:80:1 › W17 — … (9.6s)
[arrows w5] stack before 0, after 0
  ✓  2 arrows.spec.ts:158:1 › W5 — … (9.6s)

  2 passed (20.6s)
```

## Mutation check, between run 1 and run 2

`clickOrigin`'s `stackItemBox` fallback was reverted (one line commented
out), the UI rebuilt, and the W17 test alone re-run:

```
✘  1 arrows.spec.ts:80:1 › W17 — …
Error: the click-targeting arrow is drawn
Expected: 1
Received: 0
```

No arrow drew at all — matching the ledger's own diagnosis ("falls back to
(0,0)-ish") rather than a literal zero coordinate: `clickOrigin()` returns
`null` with the fallback gone, and a `null` origin draws nothing. The fix
was restored, the UI rebuilt again, and confirmed back to passing before
continuing.

## Run 2 (after the mutation check, fix restored)

```
[arrows w17] says: Priority: Alice
Turn: 1 (Alice)
Phase: Main phase, precombat
Stack: Empty
[arrows w17] stack item centre {"x":698.7109375,"y":253.78125}
[arrows w17] tail {"x":698.7109375,"y":253.78125}
  ✓  1 arrows.spec.ts:80:1 › W17 — … (10.5s)
[arrows w5] stack before 0, after 0
  ✓  2 arrows.spec.ts:158:1 › W5 — … (10.2s)

  2 passed (22.0s)
```

## Run 3 — blocked, not run

Queued behind the shared `heavy.lock` for over 20 minutes while w42's own
verify script held it (its own output file stayed at 0 bytes for 30+
minutes — `ps` showed it 45 minutes into the hold when this lane stopped
waiting). This lane's queued attempt was killed rather than left to keep
polling past the manager's stated deadline. `e2e/arrows.spec.ts` itself is
unchanged since run 2 and there is no reason to expect a different result —
but "no reason to expect a different result" is not the same claim as "ran
and passed", so this is reported as unproven, not assumed.

## Run 3 — the manager's confirmation (2026-10-05 04:04 UTC)

Run by the wave manager under `heavy.lock`, jar env set, after a fresh
`pnpm --filter @hadoku/ui --filter @hadoku/server build` of the final tree
(the lane's files plus a comment trim in `install.ts`). No `— SKIPPED:` title.

```
[arrows w17] stack item centre {"x":698.7109375,"y":253.78125}
[arrows w17] tail {"x":698.7109375,"y":253.78125}
  ✓  1 arrows.spec.ts:80:1 › W17 — … (10.9s)
[arrows w5] stack before 0, after 0
  ✓  2 arrows.spec.ts:158:1 › W5 — … (9.9s)

  2 passed (22.0s)
e2e exit 0
```

3 of 3 consecutive runs green.
