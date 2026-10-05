# Roadmap to the alpha

The operator, 2026-10-05: *"once we get through these 4 i think we can release the alpha."*

Today everything happens as fast as Forge emits it. The operator calls that **Fast Mode**: *"we can keep this
functionality if someone really wants it, but the default will not be this."*

| phase | what it makes true | named state when done | waves |
| --- | --- | --- | --- |
| 1 | Arrows work everywhere (curved; attacking a planeswalker verified) and the stack looks nice. No critical bugs left. | — | w46 |
| 2 | Reasonable delays for nearly everything: a cast card lingers before it leaves the stack, and phase changes, card draws and resolutions are spaced so the game "feels nice". Today's speed stays available as a setting. | **Graphics Quality: Low, Fast Mode: True** available, Fast Mode off by default | w47 (the pacing engine, built beside w46) |
| 3 | Real animations (cards travelling, tapping, drawing, resolving) so that Fast Mode: Off looks like motion rather than waiting. | Graphics Quality: High | later |
| 4 | Make it pretty: visual polish, sound effects, a product feel. | — | later |
| — | **Alpha release** | | |

## Rules that carry through every phase

- No explanatory text on the board (operator, twice). Affordances are visual.
- e2e runs in Fast Mode. Pacing must never slow the suite down; each phase measures forge-e2e wall time before
  and after it.
- A motion change must pass `table-fit`: a transform counts toward scroll overflow (w44's revert).
- Delays are DATA, held in one table the operator can tune by feel, never scattered timeouts.

## Order and parallelism

Phase 1 (w46) and the phase 2 engine (w47) run side by side, because their files do not intersect: w47 wraps
the match transport and never touches `match.ts` or the board. Phase 2 is only CALLED done once phase 1 is in
and the operator sees no critical bugs. Phase 3 builds on w47's event timing, so it waits for w47.
