# Base flakes — main's forge-e2e before wave 36's lanes

Asked by the tracker (2026-10-03): which of the specs that reddened CI's `forge-e2e` on main's
last three docs-only commits fail on the BASE, before any w36 lane, and how often.

## CI (from `gh run view --log-failed`)

| run | commit | failed spec(s) | time to fail |
| --- | --- | --- | --- |
| 37096104856 | `1f6c8c4` (docs) | w34 §E1 (Full Control, instant in response), w35 the swallowed press | 1.6 m, 53.9 s |
| 37096676821 | `39ddd0d` (docs) | w33 Q7 (lone counterspell) | 1.8 m |
| 37098721258 | `03e5301` (docs) | w33 Q18 (stack ability) | 23.2 s |

`e2aea1e` (w35's last code-carrying state, same code as all three) went green on a re-run.

## Base, locally (the manager, 2026-10-03 06:01–06:03 UTC)

Detached worktree at `origin/main` = `03e5301`, ui+server built from it, the installed jar
(`89e824c9`), `CARDTABLE_FORGE_RES` = the main checkout's pinned `forge/forge-gui/res`, Node 24.18.

```sh
cd <base>/e2e && npx playwright test -c playwright.config.ts --repeat-each=3 --reporter=list \
  -g "Q18 — a stack ability|Q7 — with exactly one spell|§E1 — with Full Control on, clicking an instant|the swallowed press" \
  w33.spec.ts w34.spec.ts w35.spec.ts
```

| spec | runs | passed | per-run time |
| --- | --- | --- | --- |
| w33 Q7 — one spell on the stack, the counterspell targets it | 3 | 3 | 9.6 s, 8.9 s, 11.2 s |
| w33 Q18 — a stack ability is not selectable because its source is | 3 | 3 | 7.9 s, 8.8 s, 10.5 s |
| w34 §E1 — Full Control, an instant in response actually casts | 3 | 3 | 8.7 s, 11.7 s, 12.7 s |
| w35 the swallowed press — Ponder under Full Control, one OK | 3 | 3 | 8.4 s, 11.6 s, 11.0 s |

**12 of 12 passed, 0 skipped, 2.1 min total.** None reproduced on the base here.

## Reading

Locally each spec takes about 10 s. On CI the failing runs spent 1–2 minutes before failing, which
looks like a wait that timed out, not an assertion that failed fast. The tracker's own observation
is that every one of these casts while something is on the stack, the timing w35's Arena casting
changed. Both point to a timing race that shows up under load: `forge-e2e` runs on hokon, the host
that also runs the waves' local e2e and JVM suites. This file does not prove that; it only shows the
specs are green on an unloaded run of the same code. Not fixed in w36 (the tracker plans it for w37).
To settle it: re-run CI's `forge-e2e` on a docs commit while no local e2e is running
(`gh run rerun <id> --failed`) and compare.
