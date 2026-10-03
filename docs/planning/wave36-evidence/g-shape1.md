# Shape 1 — `ConfirmPrompt` (T4), for lanes L and E

Status: API fixed. `apps/ui/src/play/prompts/ConfirmPrompt.tsx` exists, type-clean, with its own
tests (`ConfirmPrompt.test.ts`) and a real-JVM proof (`confirm.jvm.test.ts`). Read the file's
module header for the full Forge citation trail; this is the short version for wiring.

## Signature

```ts
export function isConfirmPrompt(bar: LiveButtons | null): boolean;

export interface ConfirmPromptProps {
  message: string;   // Forge's own prompt line verbatim (same source as PlayOrDrawPrompt's `message`)
  label1: string;     // Forge's own button text, verbatim — not fixed, not retranslated
  label2: string;
  enable1: boolean;
  enable2: boolean;
  onYes: () => void;  // button 1 — InputConfirm's `result = true` side
  onNo: () => void;   // button 2 — InputConfirm's `result = false` side
}

export function ConfirmPrompt(props: ConfirmPromptProps): JSX.Element;
```

Both `isConfirmPrompt` and `ConfirmPrompt` are named exports of `prompts/ConfirmPrompt.tsx` (no
barrel re-export needed — import directly, the way `PlayOrDrawPrompt.tsx` is imported today).

## The buttons

- `data-testid="prompt-confirm-yes"` — text content is `label1` **verbatim** (Forge's own word:
  "Yes", "Keep", "Heads", "Top", …, never retranslated or regexed).
- `data-testid="prompt-confirm-no"` — text content is `label2` verbatim ("No", "Mulligan", "Tails",
  "Bottom", …).
- Each is `disabled` when its own `enableN` is false (in practice `isConfirmPrompt` already
  requires both true, so this is defensive, not load-bearing).

## The true/false rule, with citations

`isConfirmPrompt(bar)`:

```ts
if (bar === null || !bar.enable1 || !bar.enable2) return false;
if (isPlayOrDrawPrompt(bar)) return false;   // the coin toss stays PlayOrDrawPrompt
return bar.label1 !== 'OK' && bar.label1 !== 'Auto' && bar.label1 !== '';
```

**TRUE** for: the shockland's "pay 2 life?" (Yes/No — `InputConfirm`'s own default pair,
`InputConfirm.java:51,108`, reached from `PlayerControllerHuman.confirmReplacementEffect:1489` →
`confirmPayment:2075` → `HumanCostDecision.visit(CostPayLife):733`), Keep/Mulligan
(`InputConfirmMulligan.java:74`), and every other two-button `InputConfirm`/`chooseBinary` text pair
a card script can produce (Heads/Tails, Tap/Untap, Left/Right, a scry's Top/Bottom, …,
`PlayerControllerHuman.java:1816-1841`) — **this is an exclusion rule, not an allowlist**, because
no finite allowlist covers every card script's custom confirm text.

**FALSE** for: a priority pass (OK+EndTurn or OK+Undo(N), `InputPassPriority.java:171,174`), mana
payment (Auto+Cancel or ""+Cancel, `InputPayMana.java:391,393,405`), the London mulligan's OK+Auto
(`InputLondonMulligan.java:65`), an attack declaration (OK+alpha-strike/Call-Back,
`InputAttack.java:90`), any default-overload selection bar (OK+Cancel — `InputBlock`,
`InputSelectManyBase`, `InputSelectTargets`, `InputSelectEntitiesFromList`, all via
`IGuiGame.java:82-85`'s boolean-only overload), and the coin toss (Play/Draw — already
`PlayOrDrawPrompt`).

**Every one of the FALSE cases puts `lblOK` ("OK") or `lblAuto` ("Auto") in `label1`.** That is the
load-bearing fact: Forge never uses either word as an *answer* to a question, only as "continue
what I'm already doing" / "let me decide". So the rule above is the complement of that small, fixed
mechanical set, not a guess at every possible confirm text.

**One gap, checked and currently dead:** `InputPassPriority.showYieldSuggestionPrompt` puts
Accept/Decline on this same bar (`InputPassPriority.java:154-156`), which neither label-equals
check catches. It only fires when `YIELD_DECLINE_SCOPE_STACK_YIELD` or
`YIELD_DECLINE_SCOPE_NO_ACTIONS` is something other than `NEVER`
(`InputPassPriority.java:102-106`). Both default to `"NEVER"` (`ForgePreferences.java:145-146`), and
`apps/server/src/play/host.ts`'s `FORGE_PREFERENCES` never touches either key — verified by reading
it; it sets only `UI_SELECT_FROM_CARD_DISPLAYS`. So this path is unreachable **today**. If a future
change ever sets one of those two prefs, `isConfirmPrompt` needs a third exclusion
(`label1 !== 'Accept'`) added at the same time — flagged here so it isn't a silent regression.

## How L wires it (not built by G — L owns `LiveBoard.tsx`)

Same shape as `PlayOrDrawPrompt`: mount `ConfirmPrompt` in the decision area whenever
`isConfirmPrompt(match.buttons)` is true (checked before `isPlayOrDrawPrompt`, after it, order
doesn't matter — they're mutually exclusive by construction), leave the control bar bar's Yes/No
empty while it's up (same `bar === null` check the control bar already does for other overlays),
and wire:

```ts
<ConfirmPrompt
  message={match.prompt ?? ''}
  label1={match.buttons!.label1}
  label2={match.buttons!.label2}
  enable1={match.buttons!.enable1}
  enable2={match.buttons!.enable2}
  onYes={() => pressButton(match, 'ok')}
  onNo={() => pressButton(match, 'cancel')}
/>
```

`pressButton` is the same sender every other control-bar button already uses (see
`PlayOrDrawPrompt.tsx`'s own header for the precedent — `onPlay`/`onDraw` wire the identical way).

## How E wires it

`answerConfirm(page, 'yes' | 'no')` in `e2e/play/`: click
`[data-testid="prompt-confirm-yes"]` or `[data-testid="prompt-confirm-no"]`. No label-text
assertion needed to pick the button — the testid is fixed regardless of which Forge question it
is; assert on the label TEXT separately if a spec wants to confirm which question is open (e.g.
`expect(await page.textContent('[data-testid="prompt-confirm-yes"]')).toBe('Keep')`).
