# C → manager: re-aiming the three specs at the new deck chooser

Wave 28 §C, item 2. The deck chooser on the room screen is no longer a
`<select>`; it is a `role="radiogroup"` of card-like rows. **Lane C owns no file
under `e2e/`**, so this is the hand-off, not the change.

Three specs drive the control with Playwright's `selectOption` and need one line
each. Two more mention `deck-mine` and need **nothing** — they only assert that it
is there.

## What stayed the same, so the re-aim is one line

| hook | where it is now |
| --- | --- |
| `data-testid="deck-mine"` | the ROOT of the new control (a `<div role="radiogroup">`) |
| `aria-disabled="true"` | on that root while the pool's legality sweep is still in flight — so `toBeEnabled()` still means "the pool has answered" |
| `data-deck-id="<library id>"` | on every row, and on the Random button |
| `data-testid="deck-option"` | on every row (Random is **not** one — see below) |
| `data-testid="deck-mine-colors"` | unchanged, still the chosen deck's colours beside the control |
| `data-testid="verdict-mine"` | unchanged — and it is still the real wait after a pick |

`data-chosen="<library id>"` on the root and `aria-checked` on each row are new,
and are how a spec can now assert *which* deck is chosen without reading a
`value`.

## The three changes

Each is a single line, and the `toBeEnabled()` line above it is unchanged.

### 1. `e2e/play.spec.ts:648` (inside `loadOwnDeck`)

```diff
   await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
-  await f.page.getByTestId('deck-mine').selectOption(deckId);
+  await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deckId}"]`).click();
   await expect(f.page.getByTestId('verdict-mine'), `${f.name}: their own deck is legal`).toContainText('Legal in');
```

### 2. `e2e/arrow.spec.ts:213`

```diff
     await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
-    await f.page.getByTestId('deck-mine').selectOption(deck);
+    await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
     await expect(f.page.getByTestId('verdict-mine'), `${f.name}: their own deck is legal`).toContainText('Legal in');
```

### 3. `e2e/table-fit.spec.ts:666`

Byte-identical to arrow's — the two blocks are the same six lines, and the
variable is `deck` in both.

```diff
     await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
-    await f.page.getByTestId('deck-mine').selectOption(deck);
+    await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
     await expect(f.page.getByTestId('verdict-mine'), `${f.name}: their own deck is legal`).toContainText('Legal in');
```

## The two specs that need nothing

- `e2e/room-mode.spec.ts:159` — `toBeVisible()`, and `:190` — `toHaveCount(0)`.
  The root keeps the test id and is still visible/absent in exactly the same
  rooms.
- `e2e/streamed-live.spec.ts:299` — `toBeVisible()`. Same.
- `e2e/play.spec.ts:804` — `getByTestId('deck-mine').count()` is still `1`: one
  root per screen.

The old doc-comment in `ConstructedScreen.tsx` claimed **six** specs drove it with
`selectOption`. That was already stale: `grep -rn 'deck-mine' e2e/` finds five
files, and only three of them call `selectOption`.

## Two things worth knowing before the re-aim

**Random is not a row.** It is a button beside the decks
(`data-testid="deck-random"`, `data-deck-id="__random__"`), because it resolves to
one of the decks on offer rather than staying chosen itself. No spec picks it
today; one that wanted to would click `getByTestId('deck-random')`.

**`toBeEnabled()` is still worth keeping.** Playwright treats `aria-disabled="true"`
as disabled, and that attribute is on the root exactly while `deckOptions === null`
— the same condition that used to set `disabled` on the `<select>`. The click that
follows also auto-waits, and the row is a real `<button disabled>` until the sweep
answers, so a spec that raced the sweep would fail on the click rather than pass
against an empty list.

## What lane C already proved, so the manager does not have to guess

`apps/ui/src/screens/constructed.test.ts` drives the control the same way these
specs will — `fireEvent.click` on `[data-deck-id=…]` inside `deck-mine` — across
all 70 tests in the file, including every test that used to call
`fireEvent.change` on the select.
