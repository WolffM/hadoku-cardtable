# The Forge jar — build, install, rebuild

`POST /api/play/matches` needs a Forge build. The server reads two paths at boot
(`apps/server/src/play/host.ts`, `jvmHostConfig`):

| env var | value | set by |
| --- | --- | --- |
| `CARDTABLE_FORGE_RES` | `<repos>/hadoku-cardtable/forge/forge-gui/res` | hadoku_site's wrapper, from `scripts/child-apps.json` `tunnel.pathEnv` |
| `CARDTABLE_FORGE_JAR` | `~/.local/share/cardtable/forge.jar` | same |

Neither is a secret and neither goes through the vault broker. If the jar is
missing the server still boots, logs one warning to stderr, and answers 503 from
that one route — nothing else changes.

## Why the jar lives outside the clone

`~/.local/share/cardtable/forge.jar` is outside every checkout on purpose, so no
deploy's `git reset --hard` or stash can touch it, and the name carries no
version so the path never changes. hadoku_site chose it; don't move it without
telling them, because their wrapper hardcodes it.

The jar is **not** in git and never will be: 38 MB, and it is a build output of
the pinned submodule.

## Per-pin jars (wave 53, ledger Y26)

**The jar is shared by CI and production, and that used to be a problem.**
w52's install at 21:58:56Z put a new engine under `d28788c`'s in-flight CI run,
which made its reds meaningless (memory `jar-install-invalidates-older-ci`): a
run can be mid-flight against one `forge` build and have the file underneath it
swapped out before it finishes.

So every installed jar now keeps its own file, named for the **full 40-char**
`forge` submodule sha it was built from, under `~/.local/share/cardtable/jars/`:

```
~/.local/share/cardtable/jars/<forge-pin>.jar
```

(Not the short form — a short sha is ambiguous across enough history, and the
rename cost is one `install -m 0644` either way.)

**CI resolves its own jar from the commit it is testing**, not from whatever is
currently installed: `git ls-tree HEAD forge | awk '{print $3}'` gives that
commit's pin. This is the pre-CI runners description of how it did that — `ci.yml`
had a "Resolve the Forge jar for this commit's pin" step (in both
`forge-e2e` and `forge-jvm`) that built `~/.local/share/cardtable/jars/<that
pin>.jar`, printed the resolved path as a `::notice::`, and failed the job
loudly with `::error::` if that file was missing. Since wave `forge-runners`
those two jobs live in `forge.yml`, run on the CI runners, and resolve the jar
through `scripts/forge-bundle.sh` instead — see "CI on the CI runners" below.
The `::notice::`/`::error::` behaviour (proving which jar a run used, and
reddening loudly on a pin nobody has built) is unchanged; only where the jar
and `res/` come from is new.

**Production's `~/.local/share/cardtable/forge.jar` becomes a symlink** to
whichever pin's jar is current, because hadoku_site's wrapper hardcodes that
one path (`jvmHostConfig` above) and does not know about pins. Switching that
symlink and restarting production is a **deploy** — see "Switching production
to a new pin" below; `build-jar.sh --switch` does it, not a routine jar
rebuild.

## CI on the CI runners (wave `forge-runners`)

The CI runners (the fleet's self-hosted runners that `forge.yml`'s two jobs now run
on, since this wave) have no `~/.local/share/cardtable`: that path, and
everything under it, exists only on the host, the production PM2 host. A CI runner also
starts with no checkout of `forge/` at all — CI's own checkout fetches no
submodule content for a gitlink. So CI cannot resolve its jar the way
"Per-pin jars" above describes; it has nothing to resolve from.

`scripts/forge-bundle.sh` is the replacement, and it runs on every CI runner (and
on the host, for the local proof below — it does not care which host it is on).
No arguments; it reads the pin straight from the checkout it runs in
(`git ls-tree HEAD forge`), and ensures a bundle for that pin exists under
`${CARDTABLE_FORGE_CACHE:-$HOME/.cache/cardtable-forge}/<pin>/`:

```
<pin>/forge.jar
<pin>/res/                    (forge-gui/res from that pin's checkout)
<pin>/.forge-bundle-marker    (written by this script; see "prune" below)
```

It prints exactly two lines on stdout and nothing else there:

```
CARDTABLE_FORGE_JAR=<abs path to forge.jar>
CARDTABLE_FORGE_RES=<abs path to res/>
```

`forge.yml`'s jobs append those two lines straight to `$GITHUB_ENV`, in place
of the old "Resolve the Forge jar" step. Everything else the script has to say
— whether this run was a cache **HIT** or a **BUILD**, how long a build took,
and the resulting bundle size — goes to stderr, where it shows up in the job
log without disturbing the two lines a workflow step is parsing.

**HIT vs. BUILD.** A HIT means `<pin>/forge.jar` and `<pin>/res/cardsfolder`
already exist on that CI runner's cache from an earlier run; the script does
nothing but print the two lines (and touch the bundle's recency marker — see
"prune"). A BUILD means they do not, so the script clones `WolffM/forge` at
that pin into scratch, runs the same `mvn -pl forge-gui-desktop -am clean
package -DskipTests -Dmaven.test.skip=true` `scripts/lanes/build-jar.sh`
runs ("Rebuilding" below), verifies the jar as "The jar check is not optional" requires (`forge`
present, `sentry` absent), and only then moves the result into place —
atomically, under a per-pin `flock`, so two jobs racing on one CI runner for the
same pin build at most once and never see a half-written bundle. Pin churn is
roughly 5 moves in 30 days across the pool, so most runs on most CI runners are
a HIT; a BUILD is the exception, not the common case. The CI runners have no
`unzip` on PATH (and almost certainly no `strings`), so verification reads
the jar's `forge/view/Main.class` with whichever of `unzip`, the JDK's own
`jar` tool (guaranteed by the `jdk21` runner label), or `python3` is actually
present, in that order.

**Where a cold build's time goes.** The first build on a CI runner starts with an
empty `~/.m2`, so Maven's own dependency download is most of a cold build's
wall clock (the host's primed `~/.m2` is 264 MB) — expected, not a regression,
and the script's stderr log separates total build time from nothing else
being hidden inside it.

**Prune.** The cache keeps the newest 3 pins' bundles (by when each was last
built or served) and removes older ones — but only a directory carrying the
`.forge-bundle-marker` this script writes, and never the pin the current run
is serving, even if that pin's marker is the oldest of the lot. One `res/`
tree is 462 MB and 55k files, so this keeps a CI runner's cache bounded without
hand-pruning.

**the host's production jar is untouched.** `~/.local/share/cardtable/forge.jar`
and `jars/` keep serving the pm2 `cardtable` warm spare exactly as before;
this script's cache lives entirely under `CARDTABLE_FORGE_CACHE` (or its
`~/.cache/cardtable-forge` default), a different path than anything
production reads.

## Rebuilding (every time the `forge` pin moves)

**`scripts/lanes/build-jar.sh <pin>` is the way**, run by the wave manager on
hokon (never by a lane). It does the steps below in order; `--dry-run` reads the
gate once and prints every step without running one.

1. **Waits for CI to be off hokon.** A build there reddens whatever CI job
   shares the host (memory `no-builds-on-hokon-under-ci`), so it waits while any
   in-progress job of this repo runs on a runner whose name has no `claw` in it
   (hokon's overflow runner is `jit-hokon-*`). The claws are never idle and
   are not counted.
2. **Checks out the pin in the scratch clone** `~/.cache/w7b-forge`
   (`git fetch fork`, then a detached checkout; `origin` there is upstream
   Card-Forge). Never build inside the vendored `forge/` tree — it must stay
   pristine (D2), and a build there leaves `target/` dirs that make the
   submodule dirty.
3. **Builds with the off-`PATH` toolchain** (`~/.local/opt`: JDK 21, Maven
   3.9.16): `mvn -q -pl forge-gui-desktop -am clean package -DskipTests
   -Dmaven.test.skip=true`. `clean` is not optional across a pin move: an
   incremental build can re-package stale classes from the previous checkout.
4. **Verifies the jar** ("The jar check is not optional" below): `forge/view/Main.class`
   must contain `server` and must not contain `sentry`, read with Python's
   `zipfile` (no `unzip`/`strings` needed).
5. **Installs it under its own pin**, `jars/<pin>.jar` — never over `forge.jar`
   directly — and prints its sha256 for the install record.

Installing under `jars/$PIN.jar` leaves production untouched. CI does not read it:
every `forge.yml` job resolves its bundle through `scripts/forge-bundle.sh`
("CI on the CI runners" above), and the claws build a pin they lack themselves.
hokon cannot: its runner (which takes `forge.yml` jobs when the claws are full)
has no `mvn` on `PATH`, so a pin missing from hokon's cache dies with
`forge-bundle: required tool not on PATH: mvn` (2026-10-14, pin `f6f65d7`). So
seed hokon's cache in the same quiet window as the build:

```sh
# hokon's CI cache for this pin (from the deploy tree, which carries the new pin).
cd ~/repos/hadoku-cardtable && \
  PATH="$HOME/.local/opt/jdk-21.0.12.1+1/bin:$HOME/.local/opt/apache-maven-3.9.16/bin:$PATH" \
  bash scripts/forge-bundle.sh
```

## Switching production to a new pin

`scripts/lanes/build-jar.sh <pin> --switch` builds and installs as above, then
switches production. **The wave manager does this itself** — the operator
approved it on 2026-10-20 — once the pin's lane has landed and CI is green. It
does not wait for a quiet table: a live match never holds a switch (the
operator; memory `never-hold-devops-for-a-live-game`).

1. **Atomic symlink switch**: `ln -sfn jars/<pin>.jar forge.jar` — never `rm`
   then `ln`, which leaves a gap with no `forge.jar` on disk at all.
2. **Restart through mgmt-api**, never raw pm2 (`services/mgmt-api/CLAUDE.md`):
   `POST http://127.0.0.1:4000/api/cardtable/restart`.
3. **Confirms** `curl -s localhost:9008/health` says `"status":"healthy"` within
   two minutes, and fails loudly naming the symlink's target if it does not.

Rolling back is the same command with the previous pin (`ls -t
~/.local/share/cardtable/jars/`): its jar is still installed.

### What a good restart looks like

`~/.pm2/logs/cardtable-out.log` gains a spare JVM, and the warning in
`cardtable-error.log` is **absent**:

```
{"svc":"cardtable-play","evt":"jvm-spawned","id":"spare-…","pid":…,"spare":true}
{"svc":"cardtable-play","evt":"spare-warm","id":"spare-…","bootMs":4074}
```

A bad one keeps saying, on stderr:

```
[cardtable] play: no Forge (CARDTABLE_FORGE_JAR does not exist: …) — POST /api/play/matches answers 503
```

Those two messages distinguish the two failures: `is not set` means the wrapper
did not pass the var (hadoku_site's side), `does not exist` means the jar is not
where we put it (ours).

## The jar check is not optional

The fork carries exactly two commits on top of upstream, and a jar built from
the wrong tree fails in ways that are quiet rather than loud:

- `1f19a230` strips the Sentry DSN. Built without it, **our crashes are reported
  to the upstream Forge project**, which is someone else's error budget and our
  stack traces.
- `2ad70eb4` implements `forge server`. Built without it, the jar takes the
  argument and runs the desktop path, which on a headless host fails somewhere
  less obvious than "unknown command".

Neither shows up as a build error, which is why the check greps the compiled
class rather than trusting the checkout.
