# Releasing cardtable

`main` deploys to **PPE** (`hadoku.me/cardtable-ppe/`) on every green `check`. **Prod**
(`hadoku.me/cardtable/`) moves only when a release is cut. Why and how it was decided:
`docs/planning/release-process.md`.

## Cutting a release

1. **Pick the version.** `vX.Y.Z`, one product version per release. Bump the minor for a
   normal release and the patch for a fix-only release. The per-package versions `land.sh`
   bumps are build numbers and don't change here.
2. **Collect what's in it:**
   ```sh
   node scripts/release/collect.ts > "$SCRATCH/release-content.md"
   ```
   This lists the playtest-ledger rows added or changed since the last `release/*` tag, then the
   commit subjects.
3. **Write the notes** in `docs/releases/vX.Y.Z.md` (shape below), from the ledger rows. Write in
   the player's words, using each row's "check it by" column, never the commit subjects. Leave out
   anything a player can't see (tests, CI, refactors), unless it fixed something they hit. A row
   that's built but whose feature isn't reachable yet stays out.
4. **The operator reads and edits them.** Then land the file on `main` like any doc. A docs-only
   change doesn't redeploy PPE.
5. **Check PPE.** The sha being released is (normally) what PPE already runs (`hadoku.me/cardtable-ppe/`,
   `curl -s localhost:9011/health`). Play it there. Its Forge pin's jar must be installed
   (`ls ~/.local/share/cardtable/jars/$(git rev-parse <sha>:forge).jar`): prod loads it on boot
   (`docs/FORGE_JAR.md`).
6. **Run the release:**
   ```sh
   gh workflow run release.yml -f version=vX.Y.Z            # main's head
   gh workflow run release.yml -f version=vX.Y.Z -f sha=<sha>
   ```
   It refuses unless `check` is green on that sha, the notes file is on it, and the tag is
   new. Then it dispatches the prod redeploy for that exact sha and tags `release/vX.Y.Z`.
7. **Confirm prod.** `/health` on 9008 reports the deployed bundle (see the memory note
   "Confirm a deploy from /health"). Prod posts the notes to Discord's `#announcements` when it
   boots on the release: look for `"svc":"cardtable-release"` with `outcome: posted` (or
   `already-posted` on a restart) in `pm2 logs cardtable`. A `failed` line says why; the next boot
   retries.

## Notes file shape

```markdown
# vX.Y.Z — <one-line headline>

<one or two sentences: what this release is about>

## New
- <what a player can now do, in their words>

## Changed
- ...

## Fixed
- ...
```

Keep it short. It's posted as a Discord embed (description up to 4096 characters), and anything
longer is cut there.

## Fixing prod

A fix for prod takes the same path: land it on main, let PPE take it, and release a patch version.
To ship a fix without the rest of main, release a sha from a branch cut off the last `release/*`
tag. The fix still lands on main too.

## Rolling back

Re-run the release workflow with the previous release's sha and a new patch version, and notes that
say what was rolled back. Prod never runs a sha that has no release tag.
