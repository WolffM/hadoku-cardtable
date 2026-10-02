# §G item 1 — the Choose X slider: OK was faint, not for the reason it looked like

**Claim the brief asked to settle**: with `choose-x.state`, the slider's max equals
the mana available, the default is the minimum, and OK is enabled and readable at
every legal value.

## What was actually wrong

The logic was already correct. `GetChoicesPrompt` (`ChoicePrompts.tsx`) defaults
`chosen` to `[String(range.min)]` whenever Forge sent no prior selection, and
`range.max` is already Forge's own capped max — the comment at `rules.ts:141-145`
records that `PlayerControllerHuman.announceRequirements` caps it at the available
mana before the wire ever sees it (`max = Math.min(max, costX)`). For the common
"Choose X" shape (`oneOrNone`: `ask.min=0, ask.max=1`), a slider's reply is always
exactly one key, so `getChoicesProblems` can never see "too few" or "too many" —
confirmed below, and already true before this item (`choices.test.ts`'s pre-existing
cases on `announceXAsk`).

So "OK faint at X=0" in w33's screenshot was never a `disabled` bug. **`.prompt__submit`
had no CSS rule of its own at all.** `prompts.css` styled every other interactive
element in the sheet (`.prompt__list`'s rings, `.prompt__cards`' ticks, `.prompt__link`,
`.prompt__dropzone`) but never the submit button, so it fell through to the one
global rule that touches a bare `<button>` (`styles.css:113-117`):

```css
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
}
```

`color: inherit` resolves to `--ink` (pale, theme text), with **no `background`
rule at all** — so the button drew with the browser's own native button face
(light grey on every platform tested) under pale theme text. That is low contrast
in every theme, at every legal value, `disabled` or not; w33's screenshot happened
to be taken at X=0, but the button was never readable at any X. "Readable" really
did mean a contrast number, not `disabled === false`, exactly as the brief said to
check.

## The fix

`apps/ui/src/play/prompts/prompts.css` — a `.prompt__submit` rule, filling with
the theme's own primary-action pair (the same pair `styles.css`'s `.fixtures__on`
already uses for "this is the one filled, accent surface in the chrome"):

```css
.prompt__submit {
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  color: var(--on-accent);
  padding: 6px 14px;
  font-weight: 600;
}

.prompt__submit:disabled {
  opacity: 0.4;
  cursor: default;
}
```

`--on-accent` (`styles.css:68`, `var(--color-on-primary, #10131a)`) is the theme
package's own token for text drawn ON a `--color-primary` fill — not `--ink` (text
on the page) and not `--accent-ink` (the accent mixed toward ink, for when the
accent itself is the glyph colour on a plain background) — so legibility here
comes from the theme author's own design, the same way `screens/tokens.test.ts`
already trusts `--color-text-secondary` for `--ink-dim`/`--ink-faint`.

## Measurement — contrast, every theme, not just `disabled`

`PromptShell.test.ts`'s new describe block (`'OK is styled for real contrast, not
just enabled'`) reads the real `@wolffm/themes` stylesheet and `prompts.css`
directly (the same method `screens/tokens.test.ts` already uses for `--accent-ink`):
resolve `--color-primary`/`--color-on-primary` per theme, compute WCAG contrast.

| check | result |
| --- | --- |
| themes read from `@wolffm/themes` | 18 (≥16 required) |
| worst `--on-accent` on `--accent` contrast, across all 18 themes | **all ≥ 4.5:1** (`worst` array empty) |
| fallback pair, no theme loaded (`#10131a` on `#7bb0ff`) | **8.43:1** |

And the logic half, against a fixture ask shaped exactly like Forge's own
`chooseNumber` (`announceXAsk`, `choices.test.ts`): OK (`submit().disabled`) is
`false` at every integer from the ask's min through its max, not only the default.

## Mutation test

| mutation | result |
| --- | --- |
| delete the `.prompt__submit` rule from `prompts.css` (restoring the pre-fix file exactly) | **1 failed / 7 passed** in `PromptShell.test.ts` (`.prompt__submit has its own rule: expected null not to be null`) — restored, 8/8 pass |
| `choiceBounds` mutated to always report `max: 0` (sanity check that the new enablement test is not vacuous) | the new `'OK stays enabled at every legal value'` case fails immediately (the slider disappears — `range !== null` gate) — restored, 33/33 pass |

## Real-Forge verification — and two more bugs it found

`apps/ui/src/play/prompts/choose-x.jvm.test.ts` casts the scripted Fireball from
`scenarios/choose-x.state` through `apps/server/src/play/scenario.ts`'s `Scenario`
harness, intercepts the real `getChoices` ask for the X announce (via `reply`,
before `answerAsks()`'s default — X=the first key — would auto-answer it), mounts
it through this lane's own `mountPrompt('getChoices', ask)`, drags the slider
through every value it offers, and feeds the component's own real answer back into
the match (`match.fromClient`, through `Scenario`'s own wire).

**This found the feature had never actually worked against a real match — two
separate bugs, both now fixed in `rules.ts`/`ChoicePrompts.tsx` (this lane):**

### Bug 1 — `numericChoiceRange` never matched a real ask at all

The real wire key for every `getChoices` option is `PlayBridge.choices()`'s own
`"c" + index` (`PlayBridge.java:1186`), positional, regardless of what the choice
means — **never the integer itself**. The measured ask for Fireball's X:

```json
{"method":"getChoices","message":"Choose X for Fireball","min":0,"max":1,
 "choices":[{"key":"c0","label":"0","ref":null}, …, {"key":"c9","label":"9","ref":null},
            {"key":"c10","label":"Other…","ref":null}], "selected":[]}
```

`numericChoiceRange`'s old structural test required `c.key === c.label` (both the
bare integer). That is **never** true on the real wire, so the function returned
`null` for every real numeric announce, and `GetChoicesPrompt` always fell through
to the ordinary checkbox list — the slider this whole lane item was shipped to
build had never rendered against a real match. The checkbox-list fallback is ALSO
where w33's "OK faint" screenshot most likely came from (it renders a `.prompt__submit`
with no selection ticked, same missing CSS as above), though the CSS bug would have
made it faint either way.

Two more call sites assumed the same false equality and were broken the same way:
the default-selection code picked `String(range.min)` (e.g. `"0"`) as the initial
*key*, which is never a real key; and the slider's value display parsed the current
*key* as an integer (`Number.parseInt("c3", 10)` is `NaN`). **Fixed**: `rules.ts`'s
`NumericChoiceRange` now carries `keys: readonly string[]` (Forge's own key for
each integer `min..max`, positional), and `ChoicePrompts.tsx` translates in both
directions through it instead of assuming key-equals-value anywhere.

### Bug 2 — "Forge's own max is already the available mana" is false for a mana X

The brief's (and the old code comment's) premise — `announceRequirements` caps
`max` to `Cost.getMaxForNonManaX`, so the slider is already bounded by what the
caster can pay — is true only for a **non-mana** X cost (`Sacrifice X creatures`,
written as a `CostPart` whose amount is the literal string `"X"`). `Cost.java:1117-1131`'s
`getMaxForNonManaX` walks exactly those parts; Fireball's `X` lives in the **mana**
cost itself (`{X}{R}`), which this method never inspects, so it returns `null` and
`announceRequirements`'s cap (`PlayerControllerHuman.java:373-376`) never applies.

Measured directly: `choose-x.state` gives seat 0 five untapped Mountains (so the
legal cap paying `{R}` first is X=4), and the real ask offered is Forge's plain,
**unconstrained** `getInteger` shape — `0..9` plus `"Other…"` — not `0..4`. The
`getChoices` ask carries no mana figure at all for this lane to cap it by; the
claim "the slider's max equals the mana available" is not something the client can
verify or enforce from this ask, for the single most common shape of "Choose X"
(a plain mana X spell). Capping the announce itself is a Forge-side behaviour
(`announceRequirements`/`Cost.getMaxForNonManaX`), and no lane may install a jar
change; achieving a client-side cap would need new plumbing (the caster's own
available mana, which neither the ask nor `PromptLookup` carries today) — **flagged
for the manager**, not attempted here. What this lane DID verify and fix is that
whatever range Forge DOES offer renders as a working, readable slider, defaulted
to the minimum, with OK always enabled on it.

### Measured, final (fixed build)

| | |
| --- | --- |
| ask method | `getChoices`, after one `getAbilityToPlay` (Fireball's one spell ability) |
| real `choices` | `c0`‥`c9` (labels `"0"`‥`"9"`), `c10` (label `"Other…"`) |
| `numericChoiceRange(ask)` | `{ min: 0, max: 9, keys: ["c0",…,"c9"], otherKey: "c10" }` |
| rendered slider | `min="0" max="9" value="0"` (not the checkbox fallback) |
| OK (`prompt-submit`) disabled, X=0 through X=9 | **never** (asserted every value) |
| reply sent for X=9 (dragged, then submitted) | `["c9"]` — Forge's own key, round-tripped through `match.fromClient` with no refusal |

## Mutation test

| mutation | result |
| --- | --- |
| delete the `.prompt__submit` rule from `prompts.css` (restoring the pre-fix file exactly) | **1 failed / 7 passed** in `PromptShell.test.ts` — restored, 8/8 pass |
| `choiceBounds` mutated to always report `max: 0` (sanity check the enablement test is not vacuous) | the `'OK stays enabled at every legal value'` case fails immediately — restored, 33/33 pass |
| revert `rules.ts`/`ChoicePrompts.tsx` to the pre-item-1 committed version (`key === label` detection, `String(range.min)` default, key-as-integer parsing) | **9 failed / 94 passed** across `rules.test.ts`, `choices.test.ts` and the real-jar `choose-x.jvm.test.ts` (which times out: the ask is never recognised, so the `reply` hook never fires and the match hangs waiting for an answer it never gets) — restored, all pass (`choose-x.jvm.test.ts` 1/1, `rules.test.ts` 69/69, `choices.test.ts` 33/33) |
