# Q18 — a spec that could not fail, and the fix

## The defect the manager measured

Lane B's fix (committed): `apps/ui/src/play/Board.tsx:2112`,

```js
const selectable =
  interaction !== undefined && sourceId !== null && !item.isAbility && interaction.selectable.has(sourceId);
```

The e2e `Q18` in `e2e/w33.spec.ts` used `glint-hawk.state`, which scripted
Prodigal Sorcerer — a **tap** ability (`T: deal 1 damage`). The manager
reverted lane B's fix (removed `&& !item.isAbility`), rebuilt, and Q18 still
**PASSED 2/2**. Reason: the moment Prodigal Sorcerer's ability is activated,
the permanent itself taps. Forge's `setSelectables` then never re-offers a
tapped permanent (it has nothing left to do), so at the instant the ability
sits on the stack, `interaction.selectable` does not contain the source
card's id either way — the assertion "the stack entry is not selectable"
holds whether or not the fix exists. **A spec that cannot fail is not a
spec.**

## The fix: a repeatable, non-tap ability

`apps/server/src/play/scenarios/glint-hawk.state` now scripts **Shivan
Dragon** (`{R}: +1/+0`) instead of Prodigal Sorcerer: a non-mana activated
ability that uses the stack, needs **no target**, costs no tap, and is
repeatable — plus three untapped Mountains (enough mana to activate it more
than once). Because the ability never taps its own source, Forge's
`setSelectables` offers the permanent again immediately after it is
activated, for as long as mana remains — which is exactly the moment the bug
needs: the SOURCE is selectable, independently of whether the STACK ITEM
built from it should be.

`e2e/w33.spec.ts`'s Q18 test now asserts, in order:

1. **Precondition 1** — an ability entry (not a spell) is on the stack
   (`.stack__item` with text matching `/ability/i`).
2. **Precondition 2** (new) — AT THAT SAME MOMENT, the source permanent's
   board card carries `data-selectable="true"`. This is the situation the
   bug needs and the old Prodigal-Sorcerer scenario could never produce.
3. **Behaviour** — the stack's ability entry carries no `data-selectable`
   attribute at all, and renders no `button.stack__select`.

`apps/server/src/play/scenario-targets.jvm.test.ts`'s "Q18 evidence" test was
updated to match (card name, no target-answering loop — Shivan Dragon's
ability needs none); its own real-Forge evidence
(`/tmp/claude-1000/w33-Q18/glint-hawk-stackitem.json`, reproduced below)
confirms the stack item's `SourceCard` is the permanent (id 85), the
permanent is still on the battlefield, **untapped**, and `TargetCards` is
empty — Shivan Dragon's ability targets nothing, unlike Prodigal Sorcerer's
original "any target" design:

```json
{
  "stackItem": {
    "_type": 2, "_id": 2,
    "Description": { "t": "str", "v": "Shivan Dragon (85) - Shivan Dragon (85) gets +1/+0  until end of turn." },
    "SourceCard": { "t": "int", "v": 85 },
    "ActivatingPlayer": { "t": "int", "v": 0 },
    "TargetCards": { "t": "list", "v": [] },
    "TargetPlayers": { "t": "list", "v": [] },
    "Ability": { "t": "bool", "v": true }
  },
  "sourceCardId": 85,
  "dragonId": 85,
  "dragonTapped": false
}
```

## Mutation counts

Suite: `e2e/w33.spec.ts -g "Q18"`, via
`pnpm --filter @hadoku/ui --filter @hadoku/server build` then
`pnpm exec playwright test -c playwright.config.ts w33.spec.ts -g "Q18"`,
jar env (`CARDTABLE_FORGE_JAR`/`CARDTABLE_FORGE_RES`),
`CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w33-Q18/work`.

- **Reverted** (mutated `Board.tsx:2112` back to
  `interaction !== undefined && sourceId !== null && interaction.selectable.has(sourceId)`,
  i.e. `&& !item.isAbility` removed), rebuilt, `--repeat-each=3`:
  **0 passed / 3 failed** — all three failed on the BEHAVIOUR assertion
  (`e2e/w33.spec.ts:485`, `.not.toHaveAttribute('data-selectable')`), never on
  either precondition:

  ```
  Error: the ability entry is not selectable by its source permanent's card id
  expect(locator).not.toHaveAttribute() failed
  Received: have attribute  — <li … data-selectable="true">
  ```

- **Restored** (`Board.tsx` byte-identical to the committed fix — confirmed
  with `git diff --stat apps/ui/src/play/Board.tsx` returning nothing both
  before mutating and after restoring), rebuilt, `--repeat-each=10`:
  **10 passed / 10 failed: 0** (10/10 green, ~6.6–7.0 s each).

- `apps/server/src/play/scenario-targets.jvm.test.ts` (uses `glint-hawk`,
  broken by the scenario swap, fixed in the same change): re-run once,
  jar env, `CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w33-Q18/jvm-work`,
  `--pool=forks --poolOptions.forks.singleFork=true`: **2 passed / 2 passed**
  (both tests in the file — the auto-target wire test, untouched, and the
  Q18 evidence test, updated for Shivan Dragon).

No java process was left behind under `/tmp/claude-1000/w33-Q18/work` or
`/tmp/claude-1000/w33-Q18/jvm-work` after any run (checked by `/proc/<pid>/cwd`
after each).
