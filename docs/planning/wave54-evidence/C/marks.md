# §C evidence — the attacker mark and the picked card

Real Forge, on the claws, against this lane's files merged onto `27bcc09`.

## Runs

- **37583671123** — `w31.spec.ts w46-attack.spec.ts -g "London bottom pick survives|attacks the planeswalker|vigilant attacker" --repeat-each=3`, 0 SKIPPED.
  - `e2e/w31.spec.ts` — *reload with a selection open: the London bottom pick survives a refresh and can be answered (P10)* — ✓✓✓
  - `e2e/w46-attack.spec.ts` — *a vigilant attacker (Serra Angel) is marked whether or not it turns* — ✓✓✓
  - `e2e/w46-attack.spec.ts` — *dragging Memnite onto Jace attacks the planeswalker; a lasting arrow joins them through declare-blockers and is gone by Main 2* — ✘✘✘, but **not at this lane's assertions**: this test's `data-attacking`/outline check and its `logMarks` call (the evidence line below) all ran and printed before the failure. The failure is at the pre-existing arrow-geometry assertion ("the arrow's tip lands on one of Jace's eight edge points", `{"x":160.79,"y":348.49}` vs `{"x":131,"y":348.49}`), which the manager reproduced on plain `origin/main` at `71e673c` (run **37584193771**) — the tracker's regression, not this lane's.
- **37583673380** — `table-fit.spec.ts`: **5 passed, 0 SKIPPED**. The attacker outline and the picked badge add no layout width and no transform; table-fit stayed green with both new marks on the page.

## The four cases, as real computed styles

Identical across all 3 repeats of run 37583671123:

| case | outline-style | outline-width | outline-color | outline-offset | box-shadow (face) | transform (art) | badge present | badge background |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| picked-card | none | 3px | rgb(15, 23, 42) | 0px | none | none | **true** | rgb(37, 99, 235) |
| offered-not-picked-card | none | 3px | rgb(15, 23, 42) | 0px | none | none | **false** | — |
| non-vigilant-attacker (Memnite) | **solid** | **2px** | rgb(249, 115, 22) | **2px** | none | matrix(0, 1, -1, 0, -21.375, -29.7812) | false | — |
| vigilant-attacker (Serra Angel) | **solid** | **2px** | rgb(249, 115, 22) | **2px** | none | **none** | false | — |

**Z6 (the operator's own claim) is proven by this table, not asserted against it:** the vigilant attacker (Serra Angel) carries the exact same `outline: 2px solid rgb(249, 115, 22)` mark the non-vigilant attacker (Memnite) does — the committed-attacker mark does not depend on whether the creature turns — and its `transform` is `none` where Memnite's is a 90° rotation matrix, confirming Serra Angel is genuinely not turned while still carrying the mark. `rgb(249, 115, 22)` is this theme's live `var(--danger)` (the component's own stylesheet fallback, `#d4715f`, is not what the running theme resolved it to — expected, themes override the fallback; the computed value is what matters here, and it is a single theme-consistent value across both attackers).

**W2 is proven the same way for the picked card**: `picked-card` carries `badgePresent: true` with `badgeBackground: rgb(37, 99, 235)` (this theme's live `var(--accent)`); `offered-not-picked-card` carries neither — it is still offered (not asserted here again, but pinned separately in the spec) with no badge at all. A picked card and a merely-offered card are now two different drawings, which is the whole of the operator's complaint.

## The honest answer on `boxShadow: "none"` for the hand cards

Both hand-card cases show `boxShadow: "none"` on `.board-card__face` even though both are genuinely offered (`data-selectable="true"`) and should be carrying the accent ring. **This is the evidence probe reading the wrong element, not a missing ring.** `card.css`'s own rule:

```css
.board-card[data-selectable] > .board-card__face .card {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}
```

is a **descendant** selector — `.board-card__face .card`, not `.board-card__face` itself. The ring is drawn on `.card` (`CardTile`'s own root element, nested inside the face), never on the face. `logMarks`' `boxShadow` field reads `getComputedStyle(face)` (the `.board-card__face` element), which this rule never targets for `box-shadow` — only the outline rules (`:focus-visible`, and this lane's new attacker mark) are ever set directly on the face. The probe's `transform` field reads the right element for that fact (`art`, i.e. `.card`), but `boxShadow` should have read `artCs.boxShadow` instead of `faceCs.boxShadow`. Per the manager's instruction this is recorded here rather than re-run: the ring itself is not in doubt (`offered-not-picked-card`'s separate `data-selectable="true"` assertion already proves it is offered, and the rule above is unconditional on any card with that attribute — the real browser box-shadow was never read for this report), only this one field of the evidence capture pointed at the face instead of the art.

The `outline-width: 3px` / `outline-color: rgb(15, 23, 42)` on the hand cards (with `outline-style: none`) is the browser's own initial computed values for an unset outline (Chromium's `medium` width resolves to `3px`, and `outline-color`'s initial `invert`/`currentColor` resolves to the inherited ink colour) — not a rule firing. Nothing here claims otherwise.

## Mutation counts (unit, no lock — see the handback for the full "Tests" lines)

Against `apps/ui/src/play/Board.test.ts` (215 tests clean):

- drop `data-picked` → 1 failed | 214 passed
- drop the attacker-mark CSS rule → 1 failed | 214 passed
- drop the picked-badge CSS rules → 1 failed | 214 passed
- drop `aria-pressed` → 1 failed | 214 passed
- restored → 215/215 (and 393/393 combined with `LiveBoard.test.ts` + `parity.test.ts`)

## Made dead / deleted

Nothing deleted this lane — every change is additive (`BoardInteraction.highlighted`, `data-picked`, the picked badge, the attacker-mark outline rule), and `parity.test.ts` needed no re-record because the fixture path renders with no `interaction` prop (see the handback for the full argument). −0 lines.
