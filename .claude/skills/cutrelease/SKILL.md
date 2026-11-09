---
name: cutrelease
description: Cut a cardtable release — combine every pending release-note file in docs/releases/pending/ into docs/releases/vX.Y.Z.md, ask the operator who each bug fix or feature credits, show them the notes and the credits post to edit, land them (removing the pending files), run release.yml and confirm prod replaced the credits post under the new notes. Use when the operator says /cutrelease, "cut a release", "ship to prod", "release vX.Y.Z", or asks what the next release would contain.
---

# Cut a release

The operator invokes this. Prod (`hadoku.me/cardtable/`) moves only through it; `main` already
deploys to PPE (`hadoku.me/cardtable-ppe/`) by itself. `docs/RELEASE.md` is the process this
follows, step for step; read it if anything here is unclear.

Every release does the same five things in Discord's #announcements (the operator, 2026-11-09):

1. delete the previous **Credits & attribution** post,
2. write the new release notes,
3. ask the operator who each bug fix or feature is attributed to,
4. post the new release notes,
5. post the new **Credits & attribution** post under them.

You do 2 and 3 here, with the operator. Prod does 1, 4 and 5 by itself, in that order, when it
boots on the release (`docs/RELEASE.md` § "Attribution"), and step 8 confirms it did.

## 1. Gather

```sh
git fetch -q origin --tags
LAST=$(git tag -l 'release/*' --sort=-v:refname | head -1)        # e.g. release/v0.33.0
git ls-tree --name-only origin/main docs/releases/pending/ | grep -v README.md
node scripts/release/collect.ts > "$SCRATCH/release-content.md"    # ledger rows + commits since $LAST
```

Read every pending file (`git show origin/main:<path>`), then **every commit since `$LAST`**, not
only the ones a pending file names — a land may have shipped with no file:

```sh
git log --reverse --format='%h %s' "$LAST"..origin/main
```

**Every commit gets a mention** (the operator, 2026-10-23). `collect.ts`'s "Commits to cover"
is the list: every commit since `$LAST` except version bumps and notes commits. Each one ends up
in exactly one bullet. When a subject does not say enough, read the commit (`git show --stat
<sha>`, its body, the files it touched). A player-visible commit is covered by a pending file, or
it is a **gap**: write its bullet yourself, from the commit and its ledger row's "check it by"
column if it has one. A commit no player sees goes under **Fixes**.

If "Commits to cover" is empty, say there is nothing to release and stop.

## 2. Combine

Write `docs/releases/vX.Y.Z.md` in a worktree off `origin/main`, in the shape and wording rules
of `docs/RELEASE.md` § "Notes style" (read it every time): New, Changed, Fixed, Fixes;
a plain lead sentence per bullet, bold only on a big feature's lead, which alone gets extra
words; a fix is one short plain line.

- **Version:** `$LAST` plus a minor bump if any bullet is under New or Changed, else a patch
  bump. `v0.33.0` → `v0.34.0` or `v0.33.1`.
- **Every pending bullet**, under its own heading, in the order the files sort (they are dated).
  Fold two bullets about the same thing into one, and cut a pending bullet down to the style's
  length when it is a small fix written long.
- **Every `(@name)` stays.** A pending bullet's credits ride into the notes unchanged, and a
  folded bullet keeps every name from both (`docs/RELEASE.md` § "Attribution"). The post shows
  each as ***__name__*** and pings nobody. Never write a Discord mention (`<@id>`).
- **Fixes** groups the commits no player sees by kind ("Faster checks before an update
  ships.", "Dependency updates."), one plain sentence each.

## 3. Ask who is credited

Every bullet under New, Changed and Fixed may credit whoever reported the bug or asked for the
feature. Fixes bullets credit nobody. Ask on every release, even when the pending files carried
names already: the operator knows who asked, and the files often don't.

1. List the names used so far, with their counts, to pick from:
   ```sh
   node scripts/release/credits.ts
   ```
2. Show the operator every New, Changed and Fixed bullet, numbered, each with the `(@name)` it
   already carries. Then ask, in chat (not a multiple-choice question, since names are free text):
   *who is attributed to which?* They answer like `2 ohmusama, 5 bob ohmusama, rest none`.
3. Write each answer onto its bullet as `(@name)` at the end, `(@a, @b)` for two, keeping the
   names already there. A hadoku name, as the operator spells it. Ask again if a name is new and
   looks like a typo of a known one.

## 4. The operator edits

Show the operator the full notes text in chat, then the **coverage**: every commit from "Commits
to cover", each with the bullet it went into, so a missing one shows. Mark the bullets you wrote
for a gap. Then the **credits post** as it will read under these notes:

```sh
node scripts/release/credits.ts docs/releases/vX.Y.Z.md
```

Ask them to edit or approve. Apply their edits verbatim. Do not land or release until they say
the notes are right.

## 5. Land the notes

One commit on the worktree: the notes file added, every `docs/releases/pending/*.md` it combined
removed (never the README). Message `release: vX.Y.Z notes`, no AI attribution. Rebase on
`origin/main` and push with an explicit refspec (`git push origin HEAD:main`). Re-read the
pending folder after the rebase: a file another lane landed meanwhile is not in these notes,
so leave it for the next release and tell the operator.

## 6. Check PPE and the jar

The sha to release is the notes commit, or main's head once it contains it. PPE normally runs
the code already (`curl -s localhost:9011/health`). Its Forge pin's jar must be installed:

```sh
ls ~/.local/share/cardtable/jars/$(git rev-parse <sha>:forge).jar
```

## 7. Release

`release.yml` refuses a sha whose `check` is not green or that lacks the notes file. Wait for
`check` on the notes commit with ONE background `scripts/lanes/watch-run.sh <run-id>`; if a newer
push cancelled it, use the newest main sha whose `check` is green and that contains the notes.

```sh
gh workflow run release.yml -f sha=<sha>
```

With no `version` it releases as the newest notes file on that sha, the one you just landed;
the run's log says which (`version vX.Y.Z: the newest notes on <sha>`). Pass `-f version=` only to
release under a different name, as a rollback does.

Then wait for that run the same way.

## 8. Confirm prod

- `curl -s localhost:9008/health` reports the released bundle;
  `git -C /home/hadoku/srv/hadoku-cardtable merge-base --is-ancestor <sha> HEAD` succeeds.
- `pm2 logs cardtable --lines 200 --nostream | grep cardtable-release` shows, in this order:
  `release-credits` `deleted` for the previous release's credits post (absent only on the first
  release that has one), `release-announce` `posted` (or `already-posted` after a restart) for the
  notes, any `release-edit` `edited` lines for older notes whose text changed, and
  `release-credits` `posted` for the new credits post. A `failed` line says why; the next boot
  retries.

Tell the operator: the version, the sha, that prod runs it, that the notes were posted, and that
the credits post was replaced under them.
