# Pending release notes

Notes for the **next** release accumulate here, one file per change, until the operator cuts a
release with `/cutrelease` (`.claude/skills/cutrelease/SKILL.md`). The skill combines every file
in this folder into `docs/releases/vX.Y.Z.md`, the operator edits that, and the files here are
deleted in the same commit that lands it.

## When to write one

Whenever a land changes something a player can see or feel: a feature, a fix, a change in how
something looks or plays, a speed-up they would notice. Not for tests, CI, refactors, docs or
anything admin-only (testing rooms, the sound builder), unless it fixed something a player hit.

Write it in the same commit as the change, so a reverted change takes its note with it.

## The file

`docs/releases/pending/<YYYY-MM-DD>-<short-slug>.md`, e.g. `2026-10-23-smoother-big-turns.md`.
The date keeps the folder in the order things landed; the slug says what it is. One file may
hold several bullets when they are one piece of work.

Use only these three headings, each optional, and bullets under them:

```markdown
## New
- **What a player can now do.** One or two sentences in their words.

## Changed
- **What works differently now.** What they'll notice.

## Fixed
- **What was wrong, now right.** What they hit, and that it no longer happens.
```

Write for the players, not for us: no file names, commit ids, ticket numbers or internals.
Lead each bullet with a bold sentence that stands on its own; the release's Discord embed
shows them as they are.
