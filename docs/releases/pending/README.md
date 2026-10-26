# Pending release notes

Notes for the **next** release accumulate here, one file per change, until the operator cuts a
release with `/cutrelease` (`.claude/skills/cutrelease/SKILL.md`). The skill combines every file
in this folder into `docs/releases/vX.Y.Z.md`, the operator edits that, and the files here are
deleted in the same commit that lands it.

## When to write one

Whenever a land changes something a player can see or feel: a feature, a fix, a change in how
something looks or plays, a speed-up they would notice. A land no player sees (tests, CI,
refactors, docs, admin-only tools) needs no file: `/cutrelease` still gives it an
**Fixes** line, because every commit gets a mention in the notes.

Write it in the same commit as the change, so a reverted change takes its note with it.

## The file

`docs/releases/pending/<YYYY-MM-DD>-<short-slug>.md`, e.g. `2026-10-23-smoother-big-turns.md`.
The date keeps the folder in the order things landed; the slug says what it is. One file may
hold several bullets when they are one piece of work.

Use the headings and bullet shape in `docs/RELEASE.md` § "Notes style" (New, Changed, Fixed;
Fixes is `/cutrelease`'s): a lead sentence per bullet, plain, alone on one line for a fix
or a small change; a big feature bolds its lead and adds up to two short sentences.
