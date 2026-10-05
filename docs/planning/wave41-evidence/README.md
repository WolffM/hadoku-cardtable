# Wave 41, lane A — evidence index

- `A-w17-worldbreaker.md` — W17, fixed and proven.
- `B-w5-hand-return.md` — W5, proven (no code change needed; the gap was missing proof).
- `C-three-runs.md` — the raw logs for `e2e/arrows.spec.ts`'s consecutive runs (2 of 3 — the 3rd blocked by cross-wave lock contention).
- `D-w9-w14-blocked-outside-lane.md` — W9 and W14, diagnosed and blocked outside this lane's row.

## Scenarios added (new files only, per the wave's rule — `scenarios/README.md` is not edited)

| File | Proves |
| --- | --- |
| `apps/server/src/play/scenarios/w41-worldbreaker.state` | W17 — World Breaker's own cast trigger, with 8 legal targets so Forge opens a real `InputSelectTargets` ask rather than auto-targeting. |
| `apps/server/src/play/scenarios/w41-grasp.state` | W9 diagnosis — Doom Blade with TWO legal creature targets (one per side), so a genuine selection opens; used to confirm the current `boardInteraction` behaviour for the "both avatars legal" report. |
| `apps/server/src/play/scenarios/w41-planeswalker.state` | W14 diagnosis — an uncontested declare-attackers window (seat 0's Memnite) against an opposing planeswalker (Jace Beleren), same shape as the existing `attackers-declared.state`. |

W5's real-Forge proof reuses the existing `own-spell` scenario (Memnite in
hand) — no new scenario needed for it.
