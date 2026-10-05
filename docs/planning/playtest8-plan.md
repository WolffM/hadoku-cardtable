# Playtest 8 — working plan (tracker session, 2026-10-05)

Written so the work survives an interrupted session. Worktree:
`.claude/worktrees/next` (branch `next`, base `origin/main` 6744c3c). Ledger rows
X1–X3 are in commit `7e50113` (not pushed yet; push it with the code).
node_modules in this worktree were linked with the tracker's scratch
`link-nm.sh` (root/package dirs → main checkout, `@hadoku/*` → this worktree).

## X1 / W14 — attack a planeswalker by arrow; arrows that stay

**Root cause (verified in code):** during `COMBAT_DECLARE_ATTACKERS` nothing
offered the defenders, so `targetUnder` found no target on a planeswalker and
`commitDrag` fell back to `selectCard(attacker)`, which attacks Forge's current
defender (the player). Forge's `InputAttack`: a click on a defender
(player or card in `combat.getDefenders()`) sets `currentDefender`; the next
click on a creature declares it against that defender; re-clicking an attacker
already attacking the current defender undeclares it (toggle).

**Done (WIP commit, typechecks, untested):**
- `apps/ui/src/play/adapter.ts`: `BoardView.combat?: CombatBand[]` read from
  GameView `CombatView` (`atk`/`def` [0=card,1=player]/`blk`).
- `apps/ui/src/play/live/match.ts`:
  - `attackDefenders()`: opponents' planeswalkers + every battle, offered while declaring attackers;
  - opponent players offered in `boardInteraction` at the same time;
  - `noteAttackIntent` only for the seat's own cards;
  - `attackAssignment(match, attacker, target)` → `'assign' | 'already' | null`.
- `apps/ui/src/play/live/gestures/commit.ts`: an attack drop sends the
  defender first, then the attacker; `'already'` sends nothing (it would toggle off).

**Still to do:**
1. Unit tests: `gestures.test.ts` (drop on a PW sends `selectCard(pw)`, then
   `selectCard(attacker)`; already attacking it sends nothing; drop on the face
   sends `selectPlayer`, then `selectCard`) and an `adapter` test for `readCombat`.
   Check that existing tests still pass, since players are now offered during attacks.
2. Persistent arrows: after declaration, draw attacker → defender (face or PW
   card) from `view.combat` for the rest of combat. Reuse
   `gestures/auto-targets.ts` `autoTargetArrows` (it builds `{key, from, to, kind}`;
   `arrow.ts` `drawAutoTargetArrows`, wired at `install.ts` ≈:386, cleared ≈:888)
   with `cardBox`/`faceBox`.
3. Real-Forge proof with scenario `apps/server/src/play/scenarios/w41-planeswalker.state`
   (Memnite vs AI Jace Beleren): drag Memnite onto Jace, and Forge's combat
   shows def = [0, jaceId]. Either a jvm test or an e2e spec.
4. `pnpm --filter @hadoku/ui build`, one local integration e2e run (node 24
   PATH, jar env from `docs/WAVE_WORKTREE.md`, check for skips), then push with
   `git push origin HEAD:main`.

## X2 — two clicks to declare blockers

Bridge log (match `m-234c5f46dd94`): OK 1311 was the defender's priority in the
declare-attackers step, and OK 1320 confirmed the blocks. Probably the defender's
empty priority window after attacks is not auto-passed (T3 only covers the
attacker's). **Next:** reproduce with a scenario before changing any auto-pass
policy. It may be correct Magic (instants before blocks); if so, say so to the operator.

## X3 — the stack as a carousel, with the card itself below it

Demo (v1 approved with changes on 2026-10-05; v2 has them and awaits a look): https://claude.ai/artifact/7gHwzveqpi4EiZKdVTJ6EX. Operator's rules:
- **Order:** the leftmost thumbnail is the top of the stack and resolves first; resolution reads left to right. Thumbnails are numbered 1..n from the left, with an owner strip (blue = mine, amber = theirs).
- **Large view = the card image alone,** upright, with no side panel reading out the text: the card already carries its text. Not horizontal.
- **Never cover the board.** The card is pinned under the carousel only while it fits in clear space, meaning its bottom is above the viewer's battlefield. Otherwise it is hidden, and hovering or focusing a thumbnail shows it as a peek next to the thumbnail. This matters because a stack card is often what you are targeting with.
- In pinned mode a click on a thumbnail pins that item; in hover mode the peek follows the pointer.
- Re-check fit on resize and whenever the board changes (permanents entering).

## Carried from playtest 7 (not started)

- W2: selected vs selectable (`match.ts` highlighted → `Board.tsx`
  `data-selected` → `card.css`).
- W13: tap animation without the mid-turn table-fit overflow.
- Sanctum/Worldbreaker browser e2e carryover.
- V6: untap one land. Needs a fork change, so it goes in an engine wave.

## Process items

- A release-train integration script and updated wave templates (one integration
  branch, one test run, one push).
- Fix the `WAVE_WORKTREE.md` jar command (run it from the repo root).
- The hadoku_site request to deploy the exact sha CI approved is still unanswered.
- `scripts/link-worktree-node-modules.sh <worktree>` links node_modules (committed in the WIP).
