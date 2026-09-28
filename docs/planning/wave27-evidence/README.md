# Wave 27 — the evidence that would otherwise have died with `/tmp`

Every lane this wave produced its proof in `/tmp/claude-1000/w27/`, and `/tmp`
on this host is **tmpfs**: a reboot empties it. The wave protocol says an
artifact a closing note cites is committed before the note is written, so these
are the ones a closing note actually leans on — not every log, just the ones
that are the *only* record of a claim.

The manager re-ran at least one claim per lane independently; where a number
below came from a lane's artifact rather than the manager's own run, the
manager's closing note says so.

## `row-budget-*` — lane A, the wave's headline fix

`row-budget-widths.txt` is the before/after table, measured in Chromium against
the real `Board` markup and real CSS at 960×705 and 1046×683. It is the evidence
that §A.1 fixed a real defect rather than moved a number:

| split @960 (lands/arti/crea/other) | wave 26 | wave 27 |
| --- | --- | --- |
| 16/0/4/0 — the committed screenshot | creatures **27px** | **57px** |
| 20/4/12/2 | **15px, and the lane OVERFLOWED** | **40px**, no overflow |
| 9/2/8/1 — `table-fit.spec.ts`'s own crowd | 33px, lanes at 59/33/61/35 | 60/61px, every lane one width |

The two PNGs are the same board, same split, before and after.
`row-budget-measure.mjs` re-runs the measurement.

**The root cause, for anyone reading this later:** a lane's `flex-grow` was its
PILE count while it drew `ceil(piles / rows)` COLUMNS, and `--rows` was decided
per lane. A lane that stepped to two rows kept asking for two rows' worth of
width and spent one, starving its neighbour. `e2e/table-fit.spec.ts` never
caught it because its probe spreads the crowd EVENLY (9/2/8/1); a real board is
lopsided.

## `stop-policy-boot/` — lane C, proof the hatch works on the product path

Three boots of the real server (`pnpm --filter @hadoku/server exec tsx
src/index.ts`), not vitest. This is the only record that
`CARDTABLE_PLAY_STOP_POLICY` is read by the product and not merely by a test:

- `selected-strictPayment.jsonl` — `{"evt":"stop-policy-selected",…,"name":"strictPayment",…}`
- `unset-production-default.jsonl` — **zero** `stop-policy` lines, which is production's posture
- `unknown-name-is-loud.jsonl` — `{"evt":"stop-policy-unknown",…,"known":["default","strictPayment","arena","fullControl"]}`

These contain no secrets. The `EDGE_AUTH_SECRET` line says that secret is
**unset** (the local-dev hatch), and the only other match for "key" is the words
"room-keyed streams".

## `pip-deletion-*` — lane D, "no rendered pip changed", made provable

`pip-deletion-rendered-diff.txt` is the verdict: **144 probes** (all 48
`readManaToken` shapes × 3 inherited font contexts), **0 rendered differences**.
The 141 wrapper-only differences are `display: contents` on both sides, so they
generate no box and their computed values are unobservable.

`pip-deletion-probe.mjs` serves the built `apps/ui/dist` over loopback so the
vendored woff2 actually loads, then dumps computed style, `::before`/`::after`
`content`, box and text for every shape. `pip-deletion-RERUN.txt` has the
commands.

The three context screenshots were compared with `cmp -s` and were byte-identical
before and after; the **control** — the same run with `.pip--unknown` removed —
gave 50 rendered differences and three differing PNGs, which is what shows the
probe is not just photographing a blank page. The PNGs themselves are not
committed (the probe regenerates them); the verdict file and the rig are.

## Not committed, and where it went instead

- Lane B's `table-fit.spec.ts` evidence is **in the spec**, not here: its
  truncation assertion, its `--cols` guard and its `flex-grow === ceil(cards /
  rows)` check are now part of the suite, so they re-run on every CI pass
  instead of sitting in a log.
- The re-recorded markup digest lives in `apps/ui/src/play/live/parity.test.ts`,
  whose header carries the full per-lane attribution of its +53.
- Lane E's diagnosis is at `docs/planning/wave27-probe-race.md`.
