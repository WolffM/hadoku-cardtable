# Q4b — the pointer drag, as observable (lane B, for lane E)

No HTML5 drag events anywhere any more: no `dragstart`, `dragover`, `drop`, `dragend`,
no `DataTransfer`. The old `dragBetweenRows` in `e2e/table-fit.spec.ts` (which fires
those on the card and the row) will do nothing. Drive the new one with **real mouse
input** (`page.mouse.move/down/move/up`) — it is built on `pointerdown` / `pointermove`
/ `pointerup` on `window`, so Playwright's mouse and touch both produce it.

## What starts a drag

- A press (primary button / touch / pen) on a card that carries `draggable="true"` AND
  `data-arrange-card="<slot>"`. `draggable="true"` is kept ONLY as the seam marker the
  gestures layer (`install.ts: nativelyDraggable`) already stands down on; the browser's
  own drag never starts (the press is cancelled, and `dragstart` is cancelled as a backstop).
- The set of arrangeable cards is unchanged from w31 (viewer's own battlefield + hand;
  not a card Forge is asking about, not an attacker while declaring, not an offered or
  any hand card while Forge asks / a selection is open / attackers are declared).
- The drag **begins after 4px of pointer movement**; a press that never moves is a plain
  click (a selectable card still selects). After a real drag the trailing `click` is swallowed.
- If the gestures layer claimed the press (combat declaration, mana payment), the arrangement
  stands down: it only drags when `pointerdown.defaultPrevented` is still false after
  the gestures layer ran.

## Attributes while a drag is live (all removed on drop / cancel)

| where | attribute | meaning |
| --- | --- | --- |
| `section.board` | `data-arrange-active` | a drag is in flight |
| the dragged card's `<li>` | `data-arrange-dragging` | the source, drawn dimmed in place |
| `section.board > [data-arrange-ghost]` (a direct child of `section.board`) | `data-arrange-ghost="<cardId>"` | OUR ghost: a clone of the card following the pointer, lifted (scale + tilt + shadow), `pointer-events: none`, `aria-hidden`. It carries no `data-card-id`, so card ids stay unique |
| `section.board > [data-arrange-indicator]` | `data-arrange-kind="before" \| "end" \| "stack-top" \| "stack-bottom"` and `data-arrange-slot="<slot>"` | the target indicator: a bar where the card will land (vertical bar for before/end, horizontal for a stack) |
| the slot box under the snap | `data-arrange-target="<kind>"` | which slot the card will land in (an EMPTY slot snaps too: `end`) |
| the card the indicator is on | `data-arrange-target="<kind>"` | for `before` / `stack-*` |

`<slot>` is a battlefield row key (`front` / `back` in the default layout; `lands`,
`artifacts`, `creatures`, `other` in type-separated) or `hand`. Each slot box carries
`data-arrange-slot="<slot>"` permanently (not just during a drag):
the hand's `ul.zone__cards`, each single-layout tier `ul.zone__cards`, each
type-separated lane `li.zone__row`.

## Snapping (complete freedom)

The snap is the nearest slot box in the card's own zone (a hand card only ever lands in the
hand; a permanent only on the battlefield), whether or not the pointer is inside it, EMPTY
slots included. Within the slot: the nearest pile; inside a battlefield card's box the top
third is `stack-top`, the bottom third `stack-bottom`, the middle splits at the centre into
`before` / after (after = before the next pile, or `end`). A hand has no stacking: `before`
or `end`. Dropping writes the same `ARRANGED` store the HTML5 drop wrote — nothing is sent.

## Default placement (Q4a), also observable

In the default layout the battlefield is two tiers: **back row = lands, front row = everything
else**, each filled left to right, in `data-arrange-slot="back"` and `="front"`. For the
viewer the front tier is the upper one (towards the centre line); the opponent is mirrored
(back on top). The old single flat `ul.zone__cards` directly under `.zone--battlefield` is
now `.zone__tiers > ul.zone__cards`.

## To drive it from Playwright

```ts
const box = await page.locator('[data-card-id="107"]').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(targetX, targetY, { steps: 8 });
await expect(page.locator('[data-arrange-ghost]')).toHaveCount(1);
await expect(page.locator('[data-arrange-indicator]')).toHaveCount(1);
await page.mouse.up();
await expect(page.locator('[data-arrange-ghost]')).toHaveCount(0);
```

## Notes for the spec

- The ghost and bar are positioned with inline `left`/`top` (px, relative to `section.board`); the ghost's
  inline `width` is the source card's width.
- Releasing with no snap (pointer more than 80px from every slot of the card's own zone, e.g. over the
  opponent's side, or a hand card over the battlefield) moves nothing: `[data-arrange-indicator]` carries `hidden`.
- Escape or `pointercancel` ends the drag without moving anything.
- A pile is targeted through its BASE card: stack-top puts the card right above the base, stack-bottom right under it.
- Verified in real Chromium (playwright, mouse): the native HTML5 drag never starts and the pointer stream
  continues to `pointerup`. Frames: `q4-drag-1..4-*.png`.
